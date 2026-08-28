import * as THREE from 'three';
import config from '../config.js';
import { RESTYLE_GLSL, createStyleUniforms, applyStyleToUniforms } from '../render/Restyle.js';
import { passthroughStyle } from '../style/Style.js';

/**
 * Renders the world twice — once per eye — over a camera passthrough
 * background, then pre-distorts the result so a Cardboard-class lens
 * straightens it back out.
 *
 * Pipeline per frame:
 *   1. scene + background -> offscreen target, left half then right half
 *   2. that target -> canvas through the barrel-distortion pass
 *
 * Mono mode keeps the same path with the distortion branch switched off, so
 * there is one code path to reason about rather than two.
 */

const BACKGROUND_VERT = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BACKGROUND_FRAG = /* glsl */ `
uniform sampler2D uVideo;
uniform vec2 uScale;        // cover-fit factors from VideoFrameMap
uniform float uMirror;      // 1.0 when sampling a user-facing camera
uniform float uHasVideo;
uniform int uVideoRotation; // quarter turns CW to undo, from VideoFrameMap.rotation
varying vec2 vNdc;

${RESTYLE_GLSL}

// Exact inverse of VideoFrameMap._rotateToEffective — must be kept in sync
// with it, or a rotated stream drifts out of alignment with the landmarks
// reconstructed from the same frame.
vec2 rotateToRaw(vec2 e, int k) {
  if (k == 1) return vec2(e.y, 1.0 - e.x);
  if (k == 2) return vec2(1.0 - e.x, 1.0 - e.y);
  if (k == 3) return vec2(1.0 - e.y, e.x);
  return e;
}

void main() {
  vec2 effective = vec2(
    0.5 + vNdc.x / (2.0 * uScale.x),
    0.5 - vNdc.y / (2.0 * uScale.y)
  );
  vec2 uv = rotateToRaw(effective, uVideoRotation);
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;

  vec3 rgb = vec3(0.02, 0.03, 0.05);
  if (uHasVideo > 0.5) {
    // Restyle only where there is a real frame: the fallback above is chrome,
    // not world, and repainting it as ice would just look like a bug.
    rgb = restyle(texture2D(uVideo, uv).rgb, uv, uVideo);
  }
  gl_FragColor = vec4(rgb, 1.0);
}
`;

const DISTORT_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * For each screen pixel we sample the rendered image at a *larger* radius from
 * the lens centre (r * (1 + k1 r^2 + k2 r^4)). That squeezes the image inward
 * at the edges — barrel — which is the inverse of the pincushion a simple
 * magnifier introduces. The eye cameras render wider than the lens shows so
 * there is real image to sample out there rather than black.
 *
 * The polynomial must stay exactly 1 at r = 0: screen centre has to sample
 * source centre with no scaling, or the whole image magnifies uniformly. An
 * earlier version divided the curve by its value at r = 1 to make the corners
 * sample inside the frame instead of going black there — but that division
 * applies at every radius, including zero, so it also pulled the *centre*
 * in to about 77% of its true radius: a ~1.3x zoom across the entire view,
 * worst exactly where you're looking. Some black in the extreme corners at a
 * strong `uK` is the correct trade-off instead — a round vignette outside the
 * lens's clear aperture, which is normal for a Cardboard-style viewer, not a
 * bug to warp the image to hide.
 */
const DISTORT_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform float uStereo;
uniform vec2 uK;
uniform float uLensShift;
uniform float uAspect;
uniform float uGutter;
varying vec2 vUv;

void main() {
  if (uStereo < 0.5) {
    gl_FragColor = texture2D(tScene, vUv);
    #include <colorspace_fragment>
    return;
  }

  float eye = vUv.x < 0.5 ? 0.0 : 1.0;

  // Coordinates within this eye's half viewport, in [-1, 1].
  vec2 e = vec2(vUv.x * 2.0 - eye, vUv.y);

  // Guaranteed black gutter at the boundary between the two eyes,
  // independent of wherever the barrel-distortion vignette below happens to
  // fall. That vignette's own black-out is normally what keeps the eyes
  // visually separate, but its extent is a function of exactly where the
  // barrel curve pushes a sample out of [-1, 1] — at some combinations of
  // resolution and GPU/driver this reaches (or very nearly reaches) the
  // shared boundary at the widest point of each eye's oval, letting the two
  // eyes' content touch or bleed into each other, which reads as one fused
  // image rather than two. This margin makes the separation exact and does
  // not depend on that computation landing any particular way — the cost is
  // a sliver less image right at the centre, which was already the part
  // nearest each lens's own inner edge.
  if (uGutter > 0.0) {
    bool nearBoundary = (eye < 0.5) ? (e.x > 1.0 - uGutter) : (e.x < uGutter);
    if (nearBoundary) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
  }

  vec2 c = e * 2.0 - 1.0;

  // Positive uLensShift pushes each eye's image outward, under its lens.
  float cx = (eye < 0.5) ? -uLensShift : uLensShift;

  vec2 d = c - vec2(cx, 0.0);
  d.x *= uAspect;                       // isotropic radius
  float r2 = dot(d, d);

  vec2 s = d * (1.0 + uK.x * r2 + uK.y * r2 * r2);

  s.x /= uAspect;
  s += vec2(cx, 0.0);

  vec2 se = s * 0.5 + 0.5;
  if (se.x < 0.0 || se.x > 1.0 || se.y < 0.0 || se.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  gl_FragColor = texture2D(tScene, vec2((se.x + eye) * 0.5, se.y));
  #include <colorspace_fragment>
}
`;

export class StereoRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./VideoFrameMap.js').VideoFrameMap} frameMap
   */
  constructor(canvas, frameMap) {
    this.canvas = canvas;
    this.frameMap = frameMap;
    this.stereo = config.stereo.enabledByDefault;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.autoClear = false;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Cyclopean camera: the reference for gaze rays, UI placement and landmark
    // reconstruction. Never rendered from directly in stereo.
    this.centerCamera = new THREE.PerspectiveCamera(config.stereo.eyeFovDeg, 1, 0.03, 200);
    this.eyeCameras = [
      new THREE.PerspectiveCamera(config.stereo.eyeFovDeg, 1, 0.03, 200),
      new THREE.PerspectiveCamera(config.stereo.eyeFovDeg, 1, 0.03, 200),
    ];

    this._buildBackground();
    this._buildDistortion();

    // MSAA on the offscreen target: the renderer's own `antialias` only
    // applies to the default framebuffer, which the scene never draws into.
    // Tile-based mobile GPUs resolve this in on-chip memory, so it is cheap.
    this.target = new THREE.WebGLRenderTarget(2, 2, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      samples: THREE.MathUtils.clamp(config.stereo.msaaSamples ?? 4, 0, 8),
    });

    this.size = new THREE.Vector2(2, 2);
    this.eyeAspect = 1;
    this.resize();
  }

  _buildBackground() {
    this.bgScene = new THREE.Scene();
    this.bgCamera = new THREE.Camera();
    this.bgUniforms = {
      uVideo: { value: null },
      uScale: { value: new THREE.Vector2(1, 1) },
      uMirror: { value: 0 },
      uHasVideo: { value: 0 },
      uVideoRotation: { value: 0 },
      // The restyle stage shares this material rather than running as a second
      // pass: it is a pure per-pixel recolour of a value already in a register,
      // so a separate pass would cost a full-screen texture round-trip per eye
      // to achieve exactly the same pixels.
      ...createStyleUniforms(),
    };
    applyStyleToUniforms(this.bgUniforms, passthroughStyle());
    const mat = new THREE.ShaderMaterial({
      vertexShader: BACKGROUND_VERT,
      fragmentShader: BACKGROUND_FRAG,
      uniforms: this.bgUniforms,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    this.bgScene.add(quad);
  }

  _buildDistortion() {
    this.postScene = new THREE.Scene();
    this.postCamera = new THREE.Camera();
    this.postUniforms = {
      tScene: { value: null },
      uStereo: { value: this.stereo ? 1 : 0 },
      uK: { value: new THREE.Vector2(config.stereo.distortionK1, config.stereo.distortionK2) },
      uLensShift: { value: config.stereo.lensCenterOffset },
      uAspect: { value: 1 },
      uGutter: { value: config.stereo.eyeGutter },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: DISTORT_VERT,
      fragmentShader: DISTORT_FRAG,
      uniforms: this.postUniforms,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    this.postScene.add(quad);
  }

  setStereo(enabled) {
    this.stereo = !!enabled;
    this.postUniforms.uStereo.value = this.stereo ? 1 : 0;
    this.resize();
  }

  /**
   * @param {THREE.Texture} texture Must have `flipY = false` (see
   *   CameraFeed's video texture setup) — BACKGROUND_FRAG's manual UV math
   *   assumes video-normalised space (v=0 at the top of the decoded frame),
   *   which a flipY=true upload contradicts and samples upside down.
   */
  setVideoTexture(texture, { mirrored = false, width = 0, height = 0 } = {}) {
    this.bgUniforms.uVideo.value = texture;
    this.bgUniforms.uHasVideo.value = texture ? 1 : 0;
    this.bgUniforms.uMirror.value = mirrored ? 1 : 0;
    if (width > 0 && height > 0) {
      // Edge detection taps neighbouring source pixels, so it needs the real
      // capture resolution — guessing here would make outlines either blurry
      // (too large) or vanish into sampling noise (too small).
      this.bgUniforms.uTexel.value.set(1 / width, 1 / height);
    }
  }

  /** Repaint the passthrough as a different material. See `render/Restyle.js`. */
  setStyle(style) {
    applyStyleToUniforms(this.bgUniforms, style);
  }

  /**
   * Adjust IPD and update eye camera positions immediately.
   * @param {number} ipd - Interpupillary distance in metres
   */
  setIPD(ipd) {
    config.stereo.ipd = Math.max(0.04, Math.min(0.1, ipd));
  }

  /**
   * Adjust lens center offset and update shader uniforms immediately.
   * @param {number} offset - Lens shift in normalised half-screen units
   */
  setLensCenterOffset(offset) {
    config.stereo.lensCenterOffset = Math.max(-0.15, Math.min(0.15, offset));
    this.postUniforms.uLensShift.value = config.stereo.lensCenterOffset;
  }

  /**
   * Get current stereo calibration values.
   * @returns {{ipd: number, lensCenterOffset: number}}
   */
  getStereoCal() {
    return {
      ipd: config.stereo.ipd,
      lensCenterOffset: config.stereo.lensCenterOffset,
    };
  }

  resize() {
    const w = Math.max(2, Math.floor(this.canvas.clientWidth || window.innerWidth));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight || window.innerHeight));
    this.renderer.setSize(w, h, false);

    const dpr = this.renderer.getPixelRatio();
    const scale = THREE.MathUtils.clamp(config.stereo.renderScale, 0.5, 1.5);
    const bufW = Math.max(2, Math.floor(w * dpr * scale));
    const bufH = Math.max(2, Math.floor(h * dpr * scale));
    this.target.setSize(bufW, bufH);
    this.size.set(bufW, bufH);

    // THREE's own setViewport/setScissor take *logical* (CSS) pixels and
    // multiply by the renderer's pixel ratio internally — passing them the
    // already-device-pixel values in `this.size` double-applies that ratio,
    // inflating the viewport to `pixelRatio`x too large. At pixelRatio 1
    // that's a no-op, which is exactly why this went unnoticed until tested
    // above the renderer's own dpr clamp: only the fraction 1/pixelRatio of
    // the frame then actually lands inside the real drawing buffer, which
    // is indistinguishable from "the stereo split isn't happening" on
    // screen. Kept alongside `this.size` (device pixels, for buffer/target
    // sizing) rather than replacing it, since render() needs both.
    this._cssW = w;
    this._cssH = h;
    this._renderScale = scale;

    // Stereo in a phone headset is always landscape: eyes side-by-side (left-right).
    // Even if the screen reports portrait dimensions (e.g., rotation locked before
    // launch), the Cardboard layout requires horizontal split. eyeAspect is the
    // aspect of ONE eye's half-width viewport.
    this.eyeAspect = this.stereo ? (w * 0.5) / h : w / h;
    this.postUniforms.uAspect.value = this.eyeAspect;

    this.centerCamera.aspect = this.eyeAspect;
    this.centerCamera.fov = config.stereo.eyeFovDeg;
    this.centerCamera.updateProjectionMatrix();
    for (const cam of this.eyeCameras) {
      cam.aspect = this.eyeAspect;
      cam.fov = config.stereo.eyeFovDeg;
      cam.updateProjectionMatrix();
    }

    // Everything downstream — background cover-fit and landmark
    // reconstruction — keys off this one call.
    this.frameMap.setDisplay(this.eyeAspect, config.stereo.eyeFovDeg);
    this.bgUniforms.uScale.value.set(this.frameMap.scaleX, this.frameMap.scaleY);
  }

  /** Re-read cover-fit factors, e.g. after the video resolution is known. */
  syncFrameMap() {
    this.bgUniforms.uScale.value.set(this.frameMap.scaleX, this.frameMap.scaleY);
    this.bgUniforms.uMirror.value = this.frameMap.mirrorX ? 1 : 0;
    this.bgUniforms.uVideoRotation.value = this.frameMap.rotation;
  }

  /**
   * Place the eye cameras from a head pose.
   * @param {THREE.Vector3} position
   * @param {THREE.Quaternion} quaternion
   */
  updateCameras(position, quaternion) {
    this.centerCamera.position.copy(position);
    this.centerCamera.quaternion.copy(quaternion);
    this.centerCamera.updateMatrixWorld();

    const halfIpd = (this.stereo ? config.stereo.ipd : 0) * 0.5;
    _right.set(1, 0, 0).applyQuaternion(quaternion);

    for (let i = 0; i < 2; i++) {
      const cam = this.eyeCameras[i];
      const sign = i === 0 ? -1 : 1;
      cam.position.copy(position).addScaledVector(_right, sign * halfIpd);
      cam.quaternion.copy(quaternion);
      cam.updateMatrixWorld();
    }
  }

  /** @param {THREE.Scene} scene */
  render(scene) {
    const r = this.renderer;

    // setViewport/setScissor take *logical* pixels (THREE multiplies by the
    // renderer's own pixel ratio internally) — this must be the CSS size
    // scaled by renderScale, matching how the offscreen target's *actual*
    // device-pixel size (this.size, in resize()) was derived, or the two
    // disagree by a factor of the pixel ratio. See the comment in resize().
    const w = this._cssW * this._renderScale;
    const h = this._cssH * this._renderScale;

    r.setRenderTarget(this.target);
    r.setScissorTest(true);

    const eyes = this.stereo ? 2 : 1;
    // Render eyes left-right by default (eyeW = w/2, eyeH = h).
    // This is correct for landscape headsets where w > h.
    // Even in portrait mode, headset use is landscape, so eyes stay horizontal.
    const eyeW = this.stereo ? w * 0.5 : w;
    const eyeH = h;

    for (let i = 0; i < eyes; i++) {
      const x = this.stereo ? i * eyeW : 0;
      const y = 0;
      r.setViewport(x, y, eyeW, eyeH);
      r.setScissor(x, y, eyeW, eyeH);
      r.clear(true, true, true);

      // Passthrough first, depth-disabled, then the world on top of it.
      r.render(this.bgScene, this.bgCamera);
      r.render(scene, this.stereo ? this.eyeCameras[i] : this.centerCamera);
    }

    r.setScissorTest(false);
    r.setRenderTarget(null);

    // The canvas's own drawing buffer doesn't go through renderScale (only
    // the offscreen target does), so this is plain CSS size — again logical
    // pixels, for the same reason as above.
    r.setViewport(0, 0, this._cssW, this._cssH);
    r.clear(true, true, true);

    this.postUniforms.tScene.value = this.target.texture;
    r.render(this.postScene, this.postCamera);
  }

  dispose() {
    this.target.dispose();
    this.renderer.dispose();
  }
}

const _right = new THREE.Vector3();

export default StereoRenderer;
