import * as THREE from 'three';

const _zee = new THREE.Vector3(0, 0, 1);
const _euler = new THREE.Euler();
const _q0 = new THREE.Quaternion();
// Rotate -90deg about X: device orientation frames have the screen in the XY
// plane looking along +Z, three.js cameras look along -Z.
const _screenTransform = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

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

    // `deviceorientationabsolute` is compass-referenced where available, which
    // keeps world yaw stable; plain `deviceorientation` drifts but is universal.
    window.addEventListener('deviceorientationabsolute', this._onOrientation, true);
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
    const angle = screen.orientation?.angle ?? window.orientation ?? 0;
    this._screenAngle = THREE.MathUtils.degToRad(Number(angle) || 0);
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
    const yaw = Math.atan2(forward.x, -forward.z);
    this._yawOffset.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
  }

  _composeDeviceQuaternion(out) {
    const { alpha, beta, gamma } = this._raw;
    _euler.set(beta, alpha, -gamma, 'YXZ');
    out.setFromEuler(_euler);
    out.multiply(_screenTransform);
    out.multiply(_q0.setFromAxisAngle(_zee, -this._screenAngle));
    return out;
  }

  /** Refresh `quaternion`. Call once per frame before rendering. */
  update() {
    if (this.hasSensor) {
      this._composeDeviceQuaternion(this._deviceQuat);
      this.quaternion.copy(this._yawOffset).multiply(this._deviceQuat);
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
