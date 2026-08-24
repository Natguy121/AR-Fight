import * as THREE from 'three';
import config from '../config.js';
import { HAND_BONES } from '../hands/HandTracker.js';

/**
 * Visual feedback for a tracked hand.
 *
 * Without this the depth estimate is invisible until you commit a stroke and
 * find it in the wrong place. The cursor sits exactly where the next sample
 * would land, so you can see where you are drawing before you draw.
 *
 * Also renders an optional bone skeleton — the fastest way to tell "tracking
 * lost" apart from "tracking fine, depth wrong".
 */
export class HandCursor {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'hand-cursor';

    this.cursorMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
    });
    this.cursor = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), this.cursorMat);
    this.cursor.renderOrder = 900;
    this.group.add(this.cursor);

    // A halo that swells on pinch: a clear, glanceable "you are drawing now".
    this.haloMat = new THREE.MeshBasicMaterial({
      color: 0x5ac8fa,
      transparent: true,
      opacity: 0.35,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.halo = new THREE.Mesh(new THREE.RingGeometry(0.02, 0.026, 32), this.haloMat);
    this.halo.renderOrder = 899;
    this.group.add(this.halo);

    this.skeleton = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(HAND_BONES.length * 6), 3),
      ),
      new THREE.LineBasicMaterial({
        color: 0x7fd4ff,
        transparent: true,
        opacity: 0.5,
        depthTest: false,
      }),
    );
    this.skeleton.renderOrder = 898;
    this.skeleton.frustumCulled = false;
    this.skeleton.visible = config.debug.showHandSkeleton;
    this.group.add(this.skeleton);

    this._pulse = 0;
  }

  /**
   * @param {object|null} hand A HandPose-like object, or null when untracked.
   * @param {THREE.Quaternion} headQuat Used to keep the halo facing the viewer.
   * @param {number} dt
   * @param {{color?: number, mode?: 'pinch'|'point'}} [opts]
   */
  update(hand, headQuat, dt, opts = {}) {
    if (!hand?.visible) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    // Pointing uses the fingertip; drawing uses the thumb-index midpoint,
    // which is where the pinch actually closes. `override` lets the tagging
    // step show the snapped point instead, so the cursor sits on the weapon
    // rather than on the finger hovering near it.
    const point = opts.override
      ? opts.override
      : opts.mode === 'point' ? hand.indexTip : hand.pinchPoint;
    this.cursor.position.copy(point);
    this.halo.position.copy(point);
    this.halo.quaternion.copy(headQuat);

    const color = opts.color ?? 0x5ac8fa;
    this.haloMat.color.setHex(color);

    // Ease the halo toward its target size rather than snapping, so a brief
    // tracking glitch does not read as a pinch.
    const target = hand.pinching ? 1.9 : 1;
    this._pulse += (target - this._pulse) * Math.min(1, dt * 14);
    this.halo.scale.setScalar(this._pulse);
    this.haloMat.opacity = hand.pinching ? 0.6 : 0.32;
    this.cursorMat.color.setHex(hand.pinching ? color : 0xffffff);

    if (this.skeleton.visible && hand.landmarks?.length === 21) {
      const positions = this.skeleton.geometry.attributes.position;
      const array = positions.array;
      for (let i = 0; i < HAND_BONES.length; i++) {
        const [a, b] = HAND_BONES[i];
        const pa = hand.landmarks[a];
        const pb = hand.landmarks[b];
        const o = i * 6;
        array[o] = pa.x; array[o + 1] = pa.y; array[o + 2] = pa.z;
        array[o + 3] = pb.x; array[o + 4] = pb.y; array[o + 5] = pb.z;
      }
      positions.needsUpdate = true;
    }
  }

  setSkeletonVisible(v) {
    this.skeleton.visible = v;
  }

  dispose() {
    this.cursor.geometry.dispose();
    this.halo.geometry.dispose();
    this.skeleton.geometry.dispose();
    this.cursorMat.dispose();
    this.haloMat.dispose();
    this.skeleton.material.dispose();
  }
}

export default HandCursor;
