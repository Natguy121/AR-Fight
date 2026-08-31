import * as THREE from '../vendor/three.module.js';

/**
 * Phone-in-a-headset mode: the cheap plastic viewer with two lenses.
 *
 * This is a genuinely different thing from the WebXR path next door. There is
 * no headset runtime, no controllers and no tracking system — there is a phone
 * strapped to your face, and everything has to be built from what a phone
 * actually has: its gyroscope for where you are looking, its screen split in
 * two for stereo, and your gaze for a pointer.
 *
 * Three things have to be right or it is unwearable:
 *
 * 1. **Barrel distortion.** The viewer's lenses magnify, and magnifying
 *    lenses pincushion — straight lines bow inward, and the effect gets
 *    worse toward the edges. So the image is pre-distorted the opposite way
 *    (barrel) and the two cancel. Skipping this is the single biggest thing
 *    that makes a home-made viewer feel wrong.
 * 2. **A yaw offset.** `deviceorientation` reports a compass heading, so
 *    without this you would face whichever way the room happened to be built
 *    relative to magnetic north. The first reading is taken as "straight
 *    ahead" instead, which is also what makes re-centring possible.
 * 3. **Something to click with.** There are no controllers, so the pointer is
 *    your head: a reticle in the middle of your view, and either a tap (most
 *    viewers have a button that pokes the screen) or a dwell — hold your gaze
 *    and a ring fills. Both, because plenty of viewers have no button at all.
 * 4. **Landscape, whether or not the OS agrees.** This class only ever renders
 *    into whatever size it's given — it has no idea if that size came from a
 *    real landscape viewport or from main.js rotating a still-portrait one to
 *    fake it. `forceTwist` (set via `setRotated`) exists purely so the head
 *    tracking's idea of "up" agrees with whichever of those happened, since
 *    the device's raw motion sensors keep reporting true physical tilt either
 *    way and don't know the canvas got turned out from under them.
 */

const DEFAULT_DISTORTION = { k1: 0.18, k2: 0.16 };

/**
 * Much wider than the flat-screen view, for two compounding reasons: each eye
 * only gets half the screen, and the barrel pass samples progressively
 * further out toward the edges, so a good third of what is rendered ends up
 * outside the lens disc. Render at the FOV you want to see and the result is
 * a tunnel; this is the over-render that makes the displayed view come out
 * roughly life-sized.
 *
 * 150 is near the practical ceiling, not a round number picked for looks:
 * this is a true rectilinear projection, not a fisheye one, and rectilinear
 * projections inherently stretch geometry near the edges of a wide frame —
 * the barrel pass corrects for the *lens*, not for that. 158 already shows
 * it (streaking on the floor and ceiling toward the sides); by 170 the table
 * has shrunk to a speck and the room is barely recognisable. Checked by eye
 * with `npm run smoke:vr --shots`, not by a number that happens to compile.
 */
const CARDBOARD_FOV = 150;

const WARP_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * For each pixel on the screen, work out where in the rendered image it
 * should come from. Sampling progressively further out toward the edges
 * squeezes the image inward — barrel — which is exactly what cancels the
 * lens. Anything that would sample from beyond the rendered frame is black,
 * and a soft circular falloff gives the two lens discs their edge.
 */
const WARP_FRAGMENT = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tEyes;
  uniform float uEyeOffset;  // 0.0 for the left half of the target, 0.5 for the right
  uniform float k1;
  uniform float k2;

  void main() {
    vec2 centred = vUv - 0.5;
    float r2 = dot(centred, centred) * 4.0;
    float scale = 1.0 + k1 * r2 + k2 * r2 * r2;
    vec2 source = 0.5 + centred * scale;

    vec3 rgb = vec3(0.0);
    if (source.x >= 0.0 && source.x <= 1.0 && source.y >= 0.0 && source.y <= 1.0) {
      rgb = texture2D(tEyes, vec2(source.x * 0.5 + uEyeOffset, source.y)).rgb;
      float r = length(centred) * 2.0;
      rgb *= smoothstep(1.0, 0.80, r);
    }
    gl_FragColor = vec4(rgb, 1.0);

    // The eye texture is sampled as linear light, so this pass owes the
    // canvas the one sRGB encode. Leave it out and every colour in the room
    // comes out scorched — which is subtle enough to look like a "style"
    // until you put the two modes side by side.
    #include <colorspace_fragment>
  }
`;

/**
 * Turn the phone's orientation into a camera rotation.
 *
 * The quaternion assembly is the standard one: device angles are given in a
 * frame with Z out of the screen, so it needs rotating a quarter turn to sit
 * upright in a Y-up world, then rotating again by however the screen itself
 * is turned.
 */
class OrientationTracker {
  constructor() {
    this.enabled = false;
    this.hasReading = false;
    this.alpha = 0;
    this.beta = 0;
    this.gamma = 0;
    this.screenAngle = 0;
    // Extra twist layered on top of screen.orientation.angle. Device motion
    // sensors report true physical tilt no matter what the OS does with the
    // layout, so if the phone is rotation-locked and screen.orientation.angle
    // sits stuck at 0 while the page rotates its own canvas to compensate,
    // "up" would otherwise fight the rotation we just applied — this is what
    // keeps the two in step.
    this.forceTwist = 0;

    this._euler = new THREE.Euler();
    this._q = new THREE.Quaternion();
    this._screenTwist = new THREE.Quaternion();
    this._uprightTwist = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    this._zAxis = new THREE.Vector3(0, 0, 1);
    this._yAxis = new THREE.Vector3(0, 1, 0);
    this._yawOffset = new THREE.Quaternion();
    this._needsRecentre = true;

    this._onOrientation = (event) => {
      if (event.alpha === null && event.beta === null && event.gamma === null) return;
      this.alpha = (event.alpha ?? 0) * THREE.MathUtils.DEG2RAD;
      this.beta = (event.beta ?? 0) * THREE.MathUtils.DEG2RAD;
      this.gamma = (event.gamma ?? 0) * THREE.MathUtils.DEG2RAD;
      this.hasReading = true;
    };
    this._onScreen = () => {
      this.screenAngle = (screen.orientation?.angle ?? window.orientation ?? 0) * THREE.MathUtils.DEG2RAD;
    };
  }

  /** iOS needs a user gesture to even ask. Returns whether we may listen. */
  static async requestPermission() {
    const api = window.DeviceOrientationEvent;
    if (!api) return false;
    if (typeof api.requestPermission !== 'function') return true;
    try {
      return (await api.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this._onScreen();
    window.addEventListener('deviceorientation', this._onOrientation);
    window.addEventListener('orientationchange', this._onScreen);
    screen.orientation?.addEventListener?.('change', this._onScreen);
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    window.removeEventListener('deviceorientation', this._onOrientation);
    window.removeEventListener('orientationchange', this._onScreen);
    screen.orientation?.removeEventListener?.('change', this._onScreen);
    this.hasReading = false;
    this._needsRecentre = true;
  }

  /** Face whichever way you are facing now. */
  recentre() {
    this._needsRecentre = true;
  }

  /** Write the current heading into a camera. */
  apply(camera) {
    if (!this.hasReading) return false;

    this._euler.set(this.beta, this.alpha, -this.gamma, 'YXZ');
    this._q.setFromEuler(this._euler);
    this._q.multiply(this._uprightTwist);
    this._q.multiply(this._screenTwist.setFromAxisAngle(this._zAxis, -(this.screenAngle + this.forceTwist)));

    if (this._needsRecentre) {
      // Cancel whatever compass heading we happen to have started at, so
      // "straight ahead" is the table rather than magnetic north.
      this._euler.setFromQuaternion(this._q, 'YXZ');
      this._yawOffset.setFromAxisAngle(this._yAxis, -this._euler.y);
      this._needsRecentre = false;
    }

    camera.quaternion.copy(this._yawOffset).multiply(this._q);
    return true;
  }
}

export class Cardboard {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(renderer, camera, { dwellMs = 850 } = {}) {
    this.renderer = renderer;
    this.camera = camera;
    this.active = false;
    this.dwellMs = dwellMs;

    this.tracker = new OrientationTracker();
    this.stereo = new THREE.StereoCamera();
    this.stereo.eyeSep = 0.062; // a fairly average interpupillary distance
    // Each eye gets half the screen's width, and the projection has to know
    // it. Left at 1, both eyes are rendered for a full-width frame and then
    // squeezed into half of one, which stretches the room horizontally.
    this.stereo.aspect = 0.5;

    this.target = null;
    this._savedFov = camera.fov;
    this._savedAspect = camera.aspect;
    // Set once the viewport comes up still portrait — the OS declined to
    // rotate its own layout, most often because rotation lock is on, or on
    // iOS because screen.orientation.lock() has no effect at all. 0 when the
    // real viewport is already landscape and nothing needs compensating; +1
    // or -1 once we're rotating the canvas ourselves, one for each direction
    // a phone can physically be turned, since there is no way to tell which
    // one a person actually used from script.
    this.rotated = 0;

    // The screen-space pass that un-does the lenses.
    this.warpScene = new THREE.Scene();
    this.warpCamera = new THREE.Camera();
    this.eyeQuads = [];
    for (const [index, offset] of [[0, 0.0], [1, 0.5]]) {
      const material = new THREE.ShaderMaterial({
        vertexShader: WARP_VERTEX,
        fragmentShader: WARP_FRAGMENT,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          tEyes: { value: null },
          uEyeOffset: { value: offset },
          k1: { value: DEFAULT_DISTORTION.k1 },
          k2: { value: DEFAULT_DISTORTION.k2 },
        },
      });
      // Each quad covers its own half of clip space; the vertex shader passes
      // position straight through, so these are already in NDC.
      const geometry = new THREE.PlaneGeometry(1, 2);
      geometry.translate(index === 0 ? -0.5 : 0.5, 0, 0);
      const quad = new THREE.Mesh(geometry, material);
      quad.frustumCulled = false;
      this.warpScene.add(quad);
      this.eyeQuads.push(quad);
    }

    this.reticle = this._makeReticle();
    this.reticle.visible = false;
    camera.add(this.reticle);

    this._gazeDirection = new THREE.Vector3();
    this._gazeOrigin = new THREE.Vector3();
    this._progress = -1;
  }

  /** A ring in the middle of your view; it fills as you hold your gaze. */
  _makeReticle() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    this._reticleCanvas = canvas;
    this._reticleCtx = canvas.getContext('2d');

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this._reticleTexture = texture;

    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.06, 0.06),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, toneMapped: false }),
    );
    mesh.position.set(0, 0, -1.1);
    mesh.renderOrder = 999;
    this._paintReticle(0);
    return mesh;
  }

  /**
   * @param {number} progress 0 for "resting", up to 1 for "about to fire".
   */
  setReticle(progress) {
    this.reticle.visible = this.active;
    // Repainting a 128px canvas is cheap, but not free at 72fps for no reason.
    if (Math.abs(progress - this._progress) < 0.02) return;
    this._paintReticle(progress);
  }

  _paintReticle(progress) {
    this._progress = progress;
    const ctx = this._reticleCtx;
    const size = this._reticleCanvas.width;
    const centre = size / 2;
    ctx.clearRect(0, 0, size, size);

    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(centre, centre, size * 0.32, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(centre, centre, size * 0.07, 0, Math.PI * 2);
    ctx.fill();

    if (progress > 0) {
      ctx.strokeStyle = '#ffc247';
      ctx.lineWidth = 9;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(centre, centre, size * 0.32, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.stroke();
    }
    this._reticleTexture.needsUpdate = true;
  }

  /** How full the dwell ring is, 0 to 1. Zero when nothing is under your gaze. */
  get reticleProgress() {
    return this._progress;
  }

  /** Point a raycaster straight out of the middle of your view. */
  gazeRay(raycaster) {
    this.camera.getWorldPosition(this._gazeOrigin);
    this.camera.getWorldDirection(this._gazeDirection);
    raycaster.ray.origin.copy(this._gazeOrigin);
    raycaster.ray.direction.copy(this._gazeDirection);
    return raycaster;
  }

  static get supported() {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  /**
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async enter(container) {
    const allowed = await OrientationTracker.requestPermission();
    if (!allowed) {
      return { ok: false, reason: 'This phone would not share its motion sensors.' };
    }

    // Fullscreen first: an orientation lock is only allowed to take effect
    // once the page owns the screen, and the address bar otherwise eats the
    // top of one eye.
    try {
      if (!document.fullscreenElement) await (container ?? document.documentElement).requestFullscreen?.();
    } catch { /* some browsers refuse; the mode still works, just with chrome */ }
    try {
      await screen.orientation?.lock?.('landscape');
    } catch {
      // Not supported on iOS at all, and rotation lock defeats it everywhere
      // else too — main.js's resize() covers for this by rotating the canvas
      // itself instead of trusting the viewport to have actually turned.
    }

    this.tracker.enable();
    this.tracker.recentre();
    this._savedFov = this.camera.fov;
    this._savedAspect = this.camera.aspect;
    this.camera.fov = CARDBOARD_FOV;
    this.camera.aspect = 1.0;
    this.camera.updateProjectionMatrix();

    this.active = true;
    this.reticle.visible = true;
    this._resizeTarget();
    return { ok: true };
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.tracker.disable();
    this.reticle.visible = false;
    this.camera.fov = this._savedFov;
    this.camera.aspect = this._savedAspect;
    this.camera.updateProjectionMatrix();
    this.camera.quaternion.identity();
    this.setRotated(0);
    try { screen.orientation?.unlock?.(); } catch { /* fine */ }
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }

  recentre() {
    this.tracker.recentre();
  }

  /**
   * @param {-1|0|1} sign 0 once the real viewport is landscape and nothing
   *   needs correcting; otherwise which way the canvas is being rotated to
   *   fake it, so the head-tracking twist stays in step with what is drawn.
   */
  setRotated(sign) {
    this.rotated = sign;
    this.tracker.forceTwist = sign * Math.PI / 2;
  }

  /** Wrong way round? Flip without needing the phone to move at all. */
  flipRotation() {
    if (this.rotated === 0) return;
    this.setRotated(-this.rotated);
  }

  _resizeTarget() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const width = Math.max(2, size.x);
    const height = Math.max(2, size.y);
    if (this.target) {
      this.target.setSize(width, height);
      return;
    }
    this.target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.SRGBColorSpace,
    });
    for (const quad of this.eyeQuads) quad.material.uniforms.tEyes.value = this.target.texture;
  }

  /** Track the phone. Call once a frame before rendering. */
  update() {
    if (!this.active) return;
    this.tracker.apply(this.camera);
  }

  /** Render both eyes into one target, then un-distort each half to screen. */
  render(scene) {
    this._resizeTarget();
    const { renderer, target } = this;
    const width = target.width;
    const height = target.height;
    const half = Math.floor(width / 2);

    this.camera.updateWorldMatrix(true, false);
    this.stereo.update(this.camera);

    const previousAutoClear = renderer.autoClear;
    renderer.setRenderTarget(target);
    renderer.autoClear = true;
    renderer.clear();
    renderer.autoClear = false;
    renderer.setScissorTest(true);

    renderer.setViewport(0, 0, half, height);
    renderer.setScissor(0, 0, half, height);
    renderer.render(scene, this.stereo.cameraL);

    renderer.setViewport(half, 0, half, height);
    renderer.setScissor(half, 0, half, height);
    renderer.render(scene, this.stereo.cameraR);

    renderer.setScissorTest(false);
    renderer.setRenderTarget(null);
    renderer.setViewport(0, 0, width, height);
    renderer.autoClear = previousAutoClear;

    renderer.render(this.warpScene, this.warpCamera);
  }
}

export default Cardboard;
