import * as THREE from 'three';
import config from '../config.js';

/**
 * A synthetic hand driven by touch or mouse.
 *
 * Deliberately duck-types `HandPose`, so the world-space UI works unchanged.
 * It exists for two reasons: the app stays fully usable on a device where
 * MediaPipe cannot load, and the whole flow can be exercised on a desktop
 * browser without a camera in front of your hands.
 *
 * Drag to move the cursor, and it "pinches" for as long as you hold. Depth is
 * fixed at a comfortable arm's length, nudged with two-finger drag or wheel.
 */
export class PointerHand {
  constructor(domElement, frameMap) {
    this.dom = domElement;
    this.frameMap = frameMap;

    this.visible = false;
    this.handedness = 'pointer';
    this.handScale = 0.09;
    this.depth = 0.42;

    this.landmarks = Array.from({ length: 21 }, () => new THREE.Vector3());
    this.viewLandmarks = Array.from({ length: 21 }, () => new THREE.Vector3());

    this.gripPoint = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.right = new THREE.Vector3(1, 0, 0);
    this.palmNormal = new THREE.Vector3(0, 1, 0);
    this.orientation = new THREE.Quaternion();

    this.pinchPoint = new THREE.Vector3();
    this.indexTip = new THREE.Vector3();
    this.velocity = new THREE.Vector3();

    this.pinching = false;
    this.pinchRatio = 1;
    this.missingFrames = 0;

    /** Cursor position in NDC. */
    this._ndc = new THREE.Vector2(0, 0);
    this._prev = new THREE.Vector3();
    this._hasPrev = false;
    this._pointers = new Map();
    this._pinchDown = false;

    this._bind();
  }

  _bind() {
    const el = this.dom;
    el.addEventListener('pointerdown', (e) => {
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._setFromEvent(e);
      // Two fingers means "adjust depth", so it must not also draw.
      this._pinchDown = this._pointers.size === 1;
      this.visible = true;
      el.setPointerCapture?.(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      const prev = this._pointers.get(e.pointerId);
      if (!prev) return;
      if (this._pointers.size >= 2) {
        this.depth = THREE.MathUtils.clamp(
          this.depth + (prev.y - e.clientY) * 0.0016,
          config.hands.minDepth,
          config.hands.maxDepth,
        );
        this._pinchDown = false;
      } else {
        this._setFromEvent(e);
      }
      prev.x = e.clientX;
      prev.y = e.clientY;
    });

    const release = (e) => {
      this._pointers.delete(e.pointerId);
      if (this._pointers.size === 0) this._pinchDown = false;
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);

    el.addEventListener(
      'wheel',
      (e) => {
        this.depth = THREE.MathUtils.clamp(
          this.depth + e.deltaY * 0.0006,
          config.hands.minDepth,
          config.hands.maxDepth,
        );
      },
      { passive: true },
    );
  }

  _setFromEvent(e) {
    const rect = this.dom.getBoundingClientRect();
    // In stereo the canvas holds two eye images; drive from the left one.
    const width = rect.width * (this._stereo ? 0.5 : 1);
    this._ndc.x = ((e.clientX - rect.left) / width) * 2 - 1;
    this._ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this._ndc.x = THREE.MathUtils.clamp(this._ndc.x, -1, 1);
  }

  setStereo(stereo) {
    this._stereo = stereo;
  }

  /** Same signature as `HandSet.update`, so main.js can swap them freely. */
  update(_result, frameMap, headQuat, headPos, _timeSec, dt) {
    this.pinching = this._pinchDown;
    if (!this.visible) return this;

    const tanHalf = Math.tan(frameMap.fovY * 0.5);
    _view.set(
      this._ndc.x * tanHalf * frameMap.displayAspect * this.depth,
      this._ndc.y * tanHalf * this.depth,
      -this.depth,
    );

    this.pinchPoint.copy(_view).applyQuaternion(headQuat).add(headPos);
    this.indexTip.copy(this.pinchPoint);

    // A plausible little hand frame, so anything reading an orientation off a
    // hand gets something coherent rather than an identity quaternion.
    this.forward.set(0, 0, -1).applyQuaternion(headQuat);
    this.up.set(0, 1, 0).applyQuaternion(headQuat);
    this.right.crossVectors(this.forward, this.up).normalize();
    this.palmNormal.copy(this.up);
    _mat4.makeBasis(this.right, this.up, _tmp.copy(this.forward).negate());
    this.orientation.setFromRotationMatrix(_mat4);
    this.gripPoint.copy(this.pinchPoint).addScaledVector(this.forward, -0.04);

    for (let i = 0; i < 21; i++) this.landmarks[i].copy(this.pinchPoint);

    if (this._hasPrev && dt > 0) {
      _tmp.subVectors(this.pinchPoint, this._prev).multiplyScalar(1 / dt);
      this.velocity.lerp(_tmp, 0.35);
    }
    this._prev.copy(this.pinchPoint);
    this._hasPrev = true;

    return this;
  }

  /** HandSet-compatible accessors, so callers need no special case. */
  get primary() {
    return this.visible ? this : null;
  }

  get secondary() {
    return null;
  }

  get hands() {
    return [this];
  }

  reset() {
    this._hasPrev = false;
    this.pinching = false;
    this._pinchDown = false;
  }

  markMissing() {}
}

const _view = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();

export default PointerHand;
