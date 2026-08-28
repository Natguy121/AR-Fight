import * as THREE from 'three';
import { TEXTURES } from '../style/Style.js';
import { CLASS_COUNT } from '../style/Theme.js';
import { RAMP_WIDTH, PARAM_TEXELS } from './ClassAtlas.js';

/**
 * Repaint each thing in the camera image as what the theme says it should be.
 *
 * Two ideas stacked on each other.
 *
 * **Structure survives.** Almost all of your sense of an object's
 * three-dimensional form comes from *shading* — how brightness varies across
 * it — and almost none of it from hue. So the frame is split into structure
 * (luminance and its gradients) and appearance (hue, texture, gloss).
 * Structure passes through untouched; only appearance is replaced. Nothing
 * here moves a pixel, which is what keeps the chair the same size, in the same
 * place, with the same curvature — your hand goes where your eyes say it will.
 *
 * **Each object gets its own answer.** A segmentation mask (`SceneSegmenter`)
 * labels every pixel with what it belongs to, and that label selects which
 * material to apply. Without it this could only ever be a colour filter,
 * because it would have no idea a TV is a TV. With it, the TV can become a
 * whiteboard while the sofa becomes something else and the wall behind them
 * becomes a third thing.
 *
 * Per-class materials arrive as two lookup textures rather than uniforms —
 * see `ClassAtlas` for why that matters on real phones.
 *
 * The pipeline, per pixel:
 *   class lookup -> luminance -> contrast -> that class's ramp -> hue
 *   retention -> surface texture -> sheen -> edges
 *
 * A property worth preserving: with the passthrough theme, this reduces to
 * the exact identity — out == in, not merely close — which is what makes
 * "off" genuinely free. `tools/test.js` pins it against a JS mirror.
 */

export const RESTYLE_GLSL = /* glsl */ `
uniform sampler2D uClassRamp;    // ramp per class: x = luminance, y = class
uniform sampler2D uClassParams;  // packed scalars per class; see ClassAtlas
uniform sampler2D uMask;         // class index per pixel, from SceneSegmenter
uniform float uHasMask;
uniform vec2 uTexel;             // one source pixel, in uv units, for the edge taps

const float CLASS_COUNT = ${CLASS_COUNT}.0;
const float PARAM_TEXELS = ${PARAM_TEXELS}.0;
const float RAMP_WIDTH = ${RAMP_WIDTH}.0;

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

/**
 * Which class this pixel belongs to, as a row coordinate into the lookup
 * textures. With no mask everything resolves to class 0, whose row holds the
 * theme's base material — so losing segmentation degrades to a uniform
 * repaint rather than to nothing.
 */
float classRow(vec2 uv) {
  float idx = 0.0;
  if (uHasMask > 0.5) {
    idx = floor(texture2D(uMask, uv).r * 255.0 + 0.5);
    if (idx >= CLASS_COUNT) idx = 0.0;
  }
  // Exactly the row centre: the ramp atlas is linearly filtered, and this is
  // what makes the vertical filter weight of the neighbouring class zero.
  return (idx + 0.5) / CLASS_COUNT;
}

vec4 classParam(float row, float texel) {
  return texture2D(uClassParams, vec2((texel + 0.5) / PARAM_TEXELS, row));
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
float surfaceTexture(vec2 uv, int kind, float scale) {
  vec2 p = uv * scale;

  if (kind == ${TEXTURES.grain}) {
    // Two octaves: the fine one alone reads as video noise rather than stone.
    return (valueNoise(p) * 0.7 + valueNoise(p * 2.7) * 0.3) * 2.0 - 1.0;
  }
  if (kind == ${TEXTURES.veins}) {
    // Ridged noise: the fold at zero turns smooth blobs into sharp seams.
    float n = valueNoise(p * 0.5) * 0.6 + valueNoise(p * 1.7) * 0.4;
    float ridge = 1.0 - abs(n * 2.0 - 1.0);
    return pow(clamp(ridge, 0.0, 1.0), 3.0) * 2.0 - 1.0;
  }
  if (kind == ${TEXTURES.brushed}) {
    // Squashed on one axis, so the noise smears into directional streaks.
    return valueNoise(vec2(p.x, p.y * 0.04)) * 2.0 - 1.0;
  }
  if (kind == ${TEXTURES.hammered}) {
    // Offset noise beaten against itself gives rounded dents with rims.
    float n = valueNoise(p * 0.6);
    float m = valueNoise(p * 0.6 + vec2(3.7, 1.3));
    return (abs(n - m) * 3.0 - 1.0);
  }
  if (kind == ${TEXTURES.weave}) {
    return sin(p.x * 6.2831) * sin(p.y * 6.2831);
  }
  return 0.0;
}

/**
 * Sobel magnitude on luminance.
 *
 * Run on the raw video texture: an edge is an edge whichever way the frame is
 * rotated or mirrored, so this needs none of that correction and skipping it
 * saves eight coordinate transforms per pixel. This is also what turns a TV's
 * own picture into marker strokes when the theme paints it as a whiteboard.
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
  float row = classRow(uv);
  vec4 p0 = classParam(row, 0.0);   // chroma, contrast/3, textureStrength, edgeStrength
  vec4 p1 = classParam(row, 1.0);   // textureType, textureScale/400, sheen/1.5
  vec3 edgeColor = classParam(row, 2.0).rgb;
  vec3 sheenColor = classParam(row, 3.0).rgb;

  float chroma = p0.r;
  float contrast = p0.g * 3.0;
  float textureStrength = p0.b;
  float edgeStrength = p0.a;
  int textureKind = int(floor(p1.r * 255.0 + 0.5));
  float textureScale = p1.g * 400.0;
  float sheen = p1.b * 1.5;

  float l = luma(rgb);
  float lc = clamp((l - 0.5) * contrast + 0.5, 0.0, 1.0);

  // Inset half a texel so the ends of the ramp are not softened against the
  // clamped edge of the atlas, which would wash out pure black and white.
  float rampX = mix(0.5 / RAMP_WIDTH, 1.0 - 0.5 / RAMP_WIDTH, lc);
  vec3 color = texture2D(uClassRamp, vec2(rampX, row)).rgb;

  // Hue retention. The original chroma is what is left after luminance is
  // removed; adding it back scaled lets a material keep some of the real
  // world's colour instead of flattening everything into one palette.
  color += (rgb - vec3(l)) * chroma;

  // Multiplicative, so texture reads as the surface catching light unevenly
  // rather than as a pattern painted on top of it.
  if (textureStrength > 0.0) {
    color *= 1.0 + surfaceTexture(uv, textureKind, textureScale) * textureStrength;
  }

  // A cheap specular stand-in: let the already-bright parts bloom toward the
  // sheen colour. Because brightness is the real object's own shading, the
  // highlight lands where a highlight belongs on that shape.
  if (sheen > 0.0) {
    color += sheenColor * smoothstep(0.55, 1.0, lc) * sheen;
  }

  if (edgeStrength > 0.0) {
    color = mix(color, edgeColor, edgeAmount(tex, uv) * edgeStrength);
  }

  return clamp(color, 0.0, 1.0);
}
`;

/** Uniform block for the restyle stage, merged into the background material. */
export function createStyleUniforms() {
  return {
    uClassRamp: { value: null },
    uClassParams: { value: null },
    uMask: { value: null },
    uHasMask: { value: 0 },
    uTexel: { value: new THREE.Vector2(1 / 640, 1 / 480) },
  };
}

/**
 * The shader's colour maths, mirrored in JS so it can be tested without a GPU.
 *
 * Must stay in step with `restyle()` above. Takes a single style (i.e. one
 * class's row) rather than a whole theme, since the class lookup is a texture
 * fetch with no meaning for a lone colour. Texture and edges are excluded for
 * the same reason: both need neighbourhood sampling.
 */
export function restyleColorCPU(rgb, style) {
  const l = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  const lc = Math.min(1, Math.max(0, (l - 0.5) * style.contrast + 0.5));

  const x = Math.min(1, Math.max(0, lc)) * (style.ramp.length - 1);
  const i = Math.min(style.ramp.length - 2, Math.floor(x));
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

export default { RESTYLE_GLSL, createStyleUniforms, restyleColorCPU };
