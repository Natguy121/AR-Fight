import * as THREE from 'three';
import { TEXTURES, RAMP_STOPS } from '../style/Style.js';

/**
 * Repaint the camera image as a different material, without disturbing shape.
 *
 * The premise: almost all of your sense of an object's three-dimensional form
 * comes from *shading* — how brightness varies across it — and almost none of
 * it from hue. So the frame is split into structure (luminance and its
 * gradients) and appearance (hue, texture, gloss). Structure passes through
 * untouched; only appearance is replaced.
 *
 * That is what makes the result reachable. The mug keeps its exact silhouette,
 * its exact shading, its exact position in your view — so your hand goes where
 * your eyes say it will — while looking like it was cast in bronze. Anything
 * that warped or displaced pixels would break that, which is why nothing here
 * moves a pixel: every operation is a per-pixel recolour.
 *
 * The pipeline, in order:
 *   luminance -> contrast -> colour ramp -> hue retention -> surface texture
 *   -> sheen -> edges
 *
 * Ordering is deliberate. Texture and sheen come after the ramp so they read
 * as properties of the *new* material rather than tinted remnants of the old
 * one, and edges come last so an outline is never washed out by a highlight
 * drawn over it.
 *
 * A property worth preserving: with a linear grey ramp, `chroma` at 1, unit
 * contrast and every effect at zero, this pipeline is the exact identity —
 * out == in, not merely close. That is what `passthroughStyle()` is, it makes
 * "off" genuinely free rather than a subtly-degraded copy, and `tools/test.js`
 * pins it against a JS mirror of the maths below.
 */

/**
 * GLSL injected into StereoRenderer's background shader, which has already
 * done the camera sampling (rotation, mirroring, cover-fit) by the time
 * `restyle()` is called. Kept here rather than inline there so the passthrough
 * sampling maths and the appearance maths stay independently readable.
 */
export const RESTYLE_GLSL = /* glsl */ `
uniform vec3 uRamp[${RAMP_STOPS}];
uniform float uChroma;
uniform float uContrast;
uniform int uTexture;
uniform float uTextureScale;
uniform float uTextureStrength;
uniform float uEdgeStrength;
uniform vec3 uEdgeColor;
uniform float uSheen;
uniform vec3 uSheenColor;
uniform vec2 uTexel;      // one source pixel, in uv units, for the edge taps

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

/**
 * Piecewise-linear lookup across the ramp stops.
 *
 * Indexed with an explicit comparison chain rather than uRamp[int(i)]:
 * dynamic indexing of a uniform array is not universally supported on the
 * GLSL ES 1.0 targets this has to run on, and a shader that fails to compile
 * on one phone is a black screen with no message.
 */
vec3 sampleRamp(float t) {
  float x = clamp(t, 0.0, 1.0) * float(${RAMP_STOPS - 1});
  float i = floor(x);
  float f = x - i;
  vec3 a = uRamp[0];
  vec3 b = uRamp[1];
  if (i >= 2.5)      { a = uRamp[3]; b = uRamp[3]; }
  else if (i >= 1.5) { a = uRamp[2]; b = uRamp[3]; }
  else if (i >= 0.5) { a = uRamp[1]; b = uRamp[2]; }
  return mix(a, b, f);
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);      // smoothstep, so cells do not show as squares
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/** Surface pattern in roughly -1..1, to be applied multiplicatively. */
float surfaceTexture(vec2 uv) {
  vec2 p = uv * uTextureScale;

  if (uTexture == ${TEXTURES.grain}) {
    // Two octaves: the fine one alone reads as video noise rather than stone.
    return (valueNoise(p) * 0.7 + valueNoise(p * 2.7) * 0.3) * 2.0 - 1.0;
  }
  if (uTexture == ${TEXTURES.veins}) {
    // Ridged noise: the fold at zero turns smooth blobs into sharp seams.
    float n = valueNoise(p * 0.5) * 0.6 + valueNoise(p * 1.7) * 0.4;
    float ridge = 1.0 - abs(n * 2.0 - 1.0);
    return pow(clamp(ridge, 0.0, 1.0), 3.0) * 2.0 - 1.0;
  }
  if (uTexture == ${TEXTURES.brushed}) {
    // Squashed on one axis, so the noise smears into directional streaks.
    return valueNoise(vec2(p.x, p.y * 0.04)) * 2.0 - 1.0;
  }
  if (uTexture == ${TEXTURES.hammered}) {
    // Offset noise beaten against itself gives rounded dents with rims.
    float n = valueNoise(p * 0.6);
    float m = valueNoise(p * 0.6 + vec2(3.7, 1.3));
    return (abs(n - m) * 3.0 - 1.0);
  }
  if (uTexture == ${TEXTURES.weave}) {
    return sin(p.x * 6.2831) * sin(p.y * 6.2831);
  }
  return 0.0;
}

/**
 * Sobel magnitude on luminance.
 *
 * Run on the raw video texture rather than the corrected image: an edge is an
 * edge whichever way the frame is rotated or mirrored, so this needs none of
 * that correction and skipping it saves eight coordinate transforms per pixel.
 */
float edgeAmount(sampler2D tex, vec2 uv) {
  vec2 t = uTexel;
  float tl = luma(texture2D(tex, uv + vec2(-t.x, -t.y)).rgb);
  float tm = luma(texture2D(tex, uv + vec2( 0.0, -t.y)).rgb);
  float tr = luma(texture2D(tex, uv + vec2( t.x, -t.y)).rgb);
  float ml = luma(texture2D(tex, uv + vec2(-t.x,  0.0)).rgb);
  float mr = luma(texture2D(tex, uv + vec2( t.x,  0.0)).rgb);
  float bl = luma(texture2D(tex, uv + vec2(-t.x,  t.y)).rgb);
  float bm = luma(texture2D(tex, uv + vec2( 0.0,  t.y)).rgb);
  float br = luma(texture2D(tex, uv + vec2( t.x,  t.y)).rgb);

  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (bl + 2.0 * bm + br) - (tl + 2.0 * tm + tr);
  return clamp(sqrt(gx * gx + gy * gy), 0.0, 1.0);
}

vec3 restyle(vec3 rgb, vec2 uv, sampler2D tex) {
  float l = luma(rgb);
  float lc = clamp((l - 0.5) * uContrast + 0.5, 0.0, 1.0);

  vec3 color = sampleRamp(lc);

  // Hue retention. The original chroma is what is left after luminance is
  // removed; adding it back scaled lets a style keep some of the real world's
  // colour instead of flattening everything into one palette.
  color += (rgb - vec3(l)) * uChroma;

  // Multiplicative, so texture reads as the surface catching light unevenly
  // rather than as a pattern painted on top of it.
  if (uTextureStrength > 0.0) {
    color *= 1.0 + surfaceTexture(uv) * uTextureStrength;
  }

  // A cheap specular stand-in: let the already-bright parts bloom toward the
  // sheen colour. Because brightness is the real object's own shading, the
  // highlight lands where a highlight belongs on that shape.
  if (uSheen > 0.0) {
    color += uSheenColor * smoothstep(0.55, 1.0, lc) * uSheen;
  }

  if (uEdgeStrength > 0.0) {
    color = mix(color, uEdgeColor, edgeAmount(tex, uv) * uEdgeStrength);
  }

  return clamp(color, 0.0, 1.0);
}
`;

/** Uniform block for the restyle stage, merged into the background material. */
export function createStyleUniforms() {
  return {
    uRamp: { value: Array.from({ length: RAMP_STOPS }, () => new THREE.Color(0, 0, 0)) },
    uChroma: { value: 1 },
    uContrast: { value: 1 },
    uTexture: { value: 0 },
    uTextureScale: { value: 60 },
    uTextureStrength: { value: 0 },
    uEdgeStrength: { value: 0 },
    uEdgeColor: { value: new THREE.Color(0, 0, 0) },
    uSheen: { value: 0 },
    uSheenColor: { value: new THREE.Color(1, 1, 1) },
    uTexel: { value: new THREE.Vector2(1 / 640, 1 / 480) },
  };
}

/** Push a style into an existing uniform block, in place. */
export function applyStyleToUniforms(uniforms, style) {
  for (let i = 0; i < RAMP_STOPS; i++) {
    const stop = style.ramp[i];
    uniforms.uRamp.value[i].setRGB(stop[0], stop[1], stop[2]);
  }
  uniforms.uChroma.value = style.chroma;
  uniforms.uContrast.value = style.contrast;
  uniforms.uTexture.value = TEXTURES[style.texture] ?? 0;
  uniforms.uTextureScale.value = style.textureScale;
  uniforms.uTextureStrength.value = style.textureStrength;
  uniforms.uEdgeStrength.value = style.edgeStrength;
  uniforms.uEdgeColor.value.setRGB(...style.edgeColor);
  uniforms.uSheen.value = style.sheen;
  uniforms.uSheenColor.value.setRGB(...style.sheenColor);
  return uniforms;
}

/**
 * The shader's colour maths, mirrored in JS so it can be tested without a GPU.
 *
 * Must stay in step with `restyle()` above. Texture and edges are excluded:
 * both need neighbourhood sampling that has no meaning for a single colour,
 * and both are strictly additive on top of what this covers.
 */
export function restyleColorCPU(rgb, style) {
  const l = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  const lc = Math.min(1, Math.max(0, (l - 0.5) * style.contrast + 0.5));

  const x = Math.min(1, Math.max(0, lc)) * (RAMP_STOPS - 1);
  const i = Math.min(RAMP_STOPS - 2, Math.floor(x));
  const f = x - i;
  const a = style.ramp[i];
  const b = style.ramp[i + 1];

  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let v = a[c] + (b[c] - a[c]) * f;
    v += (rgb[c] - l) * style.chroma;
    if (style.sheen > 0) {
      const t = Math.min(1, Math.max(0, (lc - 0.55) / 0.45));
      v += style.sheenColor[c] * (t * t * (3 - 2 * t)) * style.sheen;
    }
    out[c] = Math.min(1, Math.max(0, v));
  }
  return out;
}

export default { RESTYLE_GLSL, createStyleUniforms, applyStyleToUniforms, restyleColorCPU };
