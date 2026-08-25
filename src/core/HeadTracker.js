import * as THREE from 'three';
import config from '../config.js';

const _zee = new THREE.Vector3(0, 0, 1);
const _euler = new THREE.Euler();
const _q0 = new THREE.Quaternion();
// Rotate -90deg about X: device orientation frames have the screen in the XY
// plane looking along +Z, three.js cameras look along -Z.
const _screenTransform = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

function _alphaFor(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/**
 * One-Euro-style adaptive smoothing for a rotation. This app's OneEuroVec3
 * (util/OneEuroFilter.js) filters a vector's x/y/z components independently,
 * which is exactly wrong for a quaternion: q and -q represent the same
 * rotation, so a raw sample can flip sign frame to frame, and averaging
 * components independently across that flip pulls toward neither endpoint
 * rather than either one. Slerping toward the raw sample sidesteps this —
 * THREE.Quaternion.slerp() already takes the shorter path regardless of
 * sign — so this mirrors OneEuroFilter's *cutoff adaptation* (heavy damping
 * at rest, almost none once actually moving) but drives a slerp blend
 * instead of a per-component lerp.
 */
class RotationSmoother {
  constructor({ minCutoff, beta, dCutoff }) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this._speed = 0;
    this._speedInitialised = false;
    this._value = null;
    this._prevRaw = new THREE.Quaternion();
    this._lastTime = null;
  }

  /**
   * @param {THREE.Quaternion} raw Not mutated.
   * @param {number} t Monotonic time in seconds.
   * @param {THREE.Quaternion} out Destination; also becomes the filter's new state.
   */
  filter(raw, t, out) {
    if (this._value === null) {
      this._value = raw.clone();
      this._prevRaw.copy(raw);
      this._lastTime = t;
      return out.copy(raw);
    }

    let dt = 1 / 60;
    if (this._lastTime !== null) {
      const delta = t - this._lastTime;
      // Guard against stalls (tab backgrounded) and duplicate timestamps.
      if (delta > 1e-5 && delta < 0.5) dt = delta;
    }
    this._lastTime = t;

    const rawSpeed = this._prevRaw.angleTo(raw) / dt;
    this._prevRaw.copy(raw);
    const speedAlpha = _alphaFor(this.dCutoff, dt);
    this._speed = this._speedInitialised
      ? speedAlpha * rawSpeed + (1 - speedAlpha) * this._speed
      : rawSpeed;
    this._speedInitialised = true;

    const cutoff = this.minCutoff + this.beta * this._speed;
    this._value.slerp(raw, _alphaFor(cutoff, dt));
    return out.copy(this._value);
  }

  reset() {
    this._speed = 0;
    this._speedInitialised = false;
    this._value = null;
    this._lastTime = null;
  }
}

/**
 * 3DoF head tracking from `deviceorientation`.
 *
 * The head stays at the origin — there is no positional tracking, which is
 * both what a Cardboard-class headset offers and all this app needs, since the
 * weapon lives in your hand and targets orbit around you.
 *
 * Falls back to pointer-drag look on anything without motion sensors, so the
 * whole app is still exercisable on a desktop browser.
 */
export class HeadTracker {
  constructor(domElement) {
    this.domElement = domElement;
    /** Current head orientation in world space. */
    this.quaternion = new THREE.Quaternion();
    /** Head position — fixed, but kept explicit so callers read intent. */
    this.position = new THREE.Vector3(0, 0, 0);

    this.enabled = false;
    /** True once a real sensor event has arrived. */
    this.hasSensor = false;
    this.usingPointerFallback = false;

    this._raw = { alpha: 0, beta: 0, gamma: 0 };
    this._screenAngle = 0;
    this._yawOffset = new THREE.Quaternion();
    this._deviceQuat = new THREE.Quaternion();
    this._rawQuat = new THREE.Quaternion();
    this._smoother = new RotationSmoother(config.head.smoothing);

    // Pointer-drag fallback state.
    this._drag = { active: false, x: 0, y: 0, yaw: 0, pitch: 0 };

    this._onOrientation = this._onOrientation.bind(this);
    this._onScreenChange = this._onScreenChange.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
  }

  /**
   * iOS 13+ gates motion sensors behind an explicit permission that must be
   * requested from a user gesture. Resolves to whether sensors are usable;
   * a false result is not fatal — the pointer fallback takes over.
   */
  static async requestPermission() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return false;
    if (typeof DOE.requestPermission !== 'function') return true;
    try {
      return (await DOE.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  start() {
    if (this.enabled) return this;
    this.enabled = true;

    this._onScreenChange();
    window.addEventListener('orientationchange', this._onScreenChange);
    screen.orientation?.addEventListener?.('change', this._onScreenChange);

    // `deviceorientationabsolute` is compass-referenced, which keeps world
    // yaw from drifting — but on Android Chrome it specifically requests the
    // magnetometer-fused "rotation vector" sensor, which is exactly as
    // reliable as the local magnetic field, i.e. not very, anywhere near
    // motors, speakers, or other electronics (a routine environment for a
    // demo, not a rare edge case) — readings can swing tens of degrees in a
    // couple of frames while the phone itself sits dead still, which reads
    // as violent, erratic shaking in anything world-locked. Plain
    // `deviceorientation` uses the gyroscope+accelerometer-only "game
    // rotation vector" instead: no compass, so yaw drifts slowly over a
    // session, but immune to this. Recentre (the UI button) already exists
    // specifically to correct drift, which is a far smaller cost than
    // unpredictable interference — so this is opt-in, off by default.
    if (config.head.useCompass) {
      window.addEventListener('deviceorientationabsolute', this._onOrientation, true);
    }
    window.addEventListener('deviceorientation', this._onOrientation, true);

    // If no sensor event lands shortly, assume there is none.
    this._fallbackTimer = setTimeout(() => {
      if (!this.hasSensor) this._enablePointerFallback();
    }, 900);

    return this;
  }

  _enablePointerFallback() {
    if (this.usingPointerFallback) return;
    this.usingPointerFallback = true;
    const el = this.domElement || window;
    el.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
  }

  _onScreenChange() {
    let angle = ((Number(screen.orientation?.angle ?? window.orientation ?? 0) || 0) % 360 + 360) % 360;

    // `deviceorientation`'s alpha/beta/gamma are defined relative to the
    // device's *natural* orientation, not however the page currently lays
    // out — this angle is what re-references them to the page. It has to
    // agree with the page's own CSS shape or every 3D object (world-space
    // UI, the weapon) comes out rolled relative to the screen-locked video
    // background, which does not go through this compensation at all and so
    // stays put — exactly the mismatch that makes a panel look tilted.
    //
    // On some browsers `screen.orientation.lock()` resolves without ever
    // firing the 'change' event this value is refreshed from, so it can be
    // caught stuck at a portrait angle (0/180) after the page has already
    // gone landscape (confirmed elsewhere by innerWidth > innerHeight, the
    // same check the rotate-gate uses). When the two disagree, the CSS shape
    // wins — trust what is actually on screen over a stale event.
    const cssLandscape = window.innerWidth > window.innerHeight;
    const angleIsLandscape = angle === 90 || angle === 270;
    if (cssLandscape && !angleIsLandscape) {
      angle = 90;
    } else if (!cssLandscape && angleIsLandscape) {
      angle = 0;
    }

    this._screenAngle = THREE.MathUtils.degToRad(angle);
  }

  /**
   * Re-derive the screen-angle compensation right now rather than waiting on
   * an orientation event. Safe to call whenever the caller already knows the
   * CSS layout just settled — e.g. after its own resize handling — since the
   * correction above depends on reading a fresh `window.innerWidth/Height`.
   */
  refreshScreenAngle() {
    this._onScreenChange();
  }

  _onOrientation(event) {
    if (event.alpha === null && event.beta === null && event.gamma === null) return;
    if (!this.hasSensor) {
      this.hasSensor = true;
      clearTimeout(this._fallbackTimer);
    }
    this._raw.alpha = THREE.MathUtils.degToRad(event.alpha || 0);
    this._raw.beta = THREE.MathUtils.degToRad(event.beta || 0);
    this._raw.gamma = THREE.MathUtils.degToRad(event.gamma || 0);
  }

  _onPointerDown(e) {
    // Leave UI chrome alone; only drag on the canvas itself.
    if (e.target !== this.domElement) return;
    this._drag.active = true;
    this._drag.x = e.clientX;
    this._drag.y = e.clientY;
  }

  _onPointerMove(e) {
    if (!this._drag.active) return;
    const dx = e.clientX - this._drag.x;
    const dy = e.clientY - this._drag.y;
    this._drag.x = e.clientX;
    this._drag.y = e.clientY;
    this._drag.yaw -= dx * 0.004;
    this._drag.pitch = THREE.MathUtils.clamp(
      this._drag.pitch - dy * 0.004,
      -Math.PI / 2 + 0.05,
      Math.PI / 2 - 0.05,
    );
  }

  _onPointerUp() {
    this._drag.active = false;
  }

  /** Treat the current facing direction as "straight ahead". */
  recenter() {
    if (this.usingPointerFallback && !this.hasSensor) {
      this._drag.yaw = 0;
      this._drag.pitch = 0;
      return;
    }
    // Cancel only yaw; pitch and roll are gravity-referenced and correct.
    this._composeDeviceQuaternion(this._deviceQuat);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this._deviceQuat);
    // atan2(x, -z) reads the *negative* of the rotation that produced this
    // forward vector (e.g. a genuine +37deg turn reads back as yaw=-37deg —
    // verified numerically, not just by inspection). The offset needed to
    // cancel a +37deg turn is another +37deg, i.e. +yaw, not -yaw: negating
    // it a second time here compounded the turn instead of undoing it, so
    // recentring after turning 90 degrees pointed "forward" 180 degrees
    // from the way you were actually facing.
    const yaw = Math.atan2(forward.x, -forward.z);
    this._yawOffset.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

    // The yaw offset just jumped, so the smoother's own state (built up
    // relative to the old one) is stale — without this it would slerp
    // smoothly from the old "forward" to the new one over the next several
    // frames, i.e. recentre would visibly glide instead of snapping.
    this._smoother.reset();
  }

  _composeDeviceQuaternion(out) {
    const { alpha, beta, gamma } = this._raw;
    _euler.set(beta, alpha, -gamma, 'YXZ');
    out.setFromEuler(_euler);
    out.multiply(_screenTransform);
    out.multiply(_q0.setFromAxisAngle(_zee, -this._screenAngle));
    return out;
  }

  /**
   * Refresh `quaternion`. Call once per frame before rendering.
   * @param {number} [t] Monotonic time in seconds, for the smoothing filter's
   *   speed estimate. Falls back to wall-clock time for the rare caller that
   *   does not have a frame timestamp handy (startup, the recentre button) —
   *   only the continuous per-frame path in the main loop needs this to line
   *   up with the rest of that frame's timing.
   */
  update(t = performance.now() / 1000) {
    if (this.hasSensor) {
      this._composeDeviceQuaternion(this._deviceQuat);
      this._rawQuat.copy(this._yawOffset).multiply(this._deviceQuat);
      this._smoother.filter(this._rawQuat, t, this.quaternion);
    } else if (this.usingPointerFallback) {
      _euler.set(this._drag.pitch, this._drag.yaw, 0, 'YXZ');
      this.quaternion.setFromEuler(_euler);
    }
    return this.quaternion;
  }

  /** Unit vector the head is looking along, in world space. */
  getForward(out = new THREE.Vector3()) {
    return out.set(0, 0, -1).applyQuaternion(this.quaternion);
  }

  /** Raw sensor + derived state, for the on-screen orientation debug readout. */
  getDebugInfo() {
    return {
      hasSensor: this.hasSensor,
      usingPointerFallback: this.usingPointerFallback,
      alphaDeg: THREE.MathUtils.radToDeg(this._raw.alpha),
      betaDeg: THREE.MathUtils.radToDeg(this._raw.beta),
      gammaDeg: THREE.MathUtils.radToDeg(this._raw.gamma),
      reportedAngleDeg: Number(screen.orientation?.angle ?? window.orientation ?? 0) || 0,
      screenAngleDeg: THREE.MathUtils.radToDeg(this._screenAngle),
      orientationType: screen.orientation?.type ?? '(unavailable)',
    };
  }

  dispose() {
    clearTimeout(this._fallbackTimer);
    window.removeEventListener('deviceorientationabsolute', this._onOrientation, true);
    window.removeEventListener('deviceorientation', this._onOrientation, true);
    window.removeEventListener('orientationchange', this._onScreenChange);
    screen.orientation?.removeEventListener?.('change', this._onScreenChange);
    if (this.usingPointerFallback) {
      const el = this.domElement || window;
      el.removeEventListener('pointerdown', this._onPointerDown);
      window.removeEventListener('pointermove', this._onPointerMove);
      window.removeEventListener('pointerup', this._onPointerUp);
      window.removeEventListener('pointercancel', this._onPointerUp);
    }
    this.enabled = false;
  }
}

export default HeadTracker;
