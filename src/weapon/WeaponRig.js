import * as THREE from 'three';
import config from '../config.js';
import { damp } from '../util/math3d.js';

/**
 * Mounts a finalized weapon onto a tracked hand.
 *
 * The weapon's local frame already puts the grip at the origin with the
 * business end down -Z, and `HandPose` exposes a matching frame, so holding it
 * is just: copy the hand's grip point and orientation, then apply the drawn
 * pitch/roll offsets that make a grip feel natural rather than skewered.
 *
 * Pose is smoothed and recoil is applied as a separate offset, so kick never
 * accumulates into the tracked pose.
 */
export class WeaponRig {
  constructor() {
    /** @type {import('./Weapon.js').Weapon|null} */
    this.weapon = null;
    this.attached = false;

    /** Recoil displacement along -forward, metres. Decays to zero. */
    this.recoil = 0;

    this._targetPos = new THREE.Vector3();
    this._targetQuat = new THREE.Quaternion();
    this._gripOffset = new THREE.Quaternion();
    this._initialised = false;

    this._rebuildGripOffset();
  }

  _rebuildGripOffset() {
    // Pitch about the weapon's local X, then roll about its local Z. Applied
    // in the weapon's own frame so the offsets read the way they are named.
    _pitch.setFromAxisAngle(
      _axisX,
      THREE.MathUtils.degToRad(config.weapon.gripPitchOffsetDeg),
    );
    _roll.setFromAxisAngle(
      _axisZ,
      THREE.MathUtils.degToRad(config.weapon.gripRollOffsetDeg),
    );
    this._gripOffset.copy(_pitch).multiply(_roll);
  }

  /** @param {import('./Weapon.js').Weapon} weapon */
  attach(weapon) {
    this.weapon = weapon;
    this.attached = true;
    this._initialised = false;
    this.recoil = 0;
    this._rebuildGripOffset();
    return this;
  }

  detach() {
    this.attached = false;
    this.weapon = null;
  }

  /** Add a recoil impulse; `strength` scales the configured kick. */
  kick(strength = 1) {
    this.recoil = Math.min(
      config.gun.recoilDistance * 2,
      this.recoil + config.gun.recoilDistance * strength,
    );
  }

  /**
   * @param {object|null} hand HandPose-like, or null when tracking is lost.
   * @param {number} dt
   */
  update(hand, dt) {
    if (!this.attached || !this.weapon) return;

    // Tracking dropped: leave the weapon where it was rather than snapping it
    // to the origin, and let recoil keep recovering.
    if (hand?.visible) {
      this._targetPos.copy(hand.gripPoint);
      this._targetQuat.copy(hand.orientation).multiply(this._gripOffset);

      if (!this._initialised) {
        this.weapon.root.position.copy(this._targetPos);
        this.weapon.root.quaternion.copy(this._targetQuat);
        this._initialised = true;
      } else {
        const t = damp(config.weapon.poseLerp * 60, dt);
        this.weapon.root.position.lerp(this._targetPos, t);
        this.weapon.root.quaternion.slerp(this._targetQuat, t);
      }
    }

    if (this.recoil > 1e-5) {
      this.recoil *= Math.exp(-config.gun.recoilRecovery * dt);
      if (this.recoil < 1e-5) this.recoil = 0;
      _back.set(0, 0, 1).applyQuaternion(this.weapon.root.quaternion);
      this.weapon.root.position.addScaledVector(_back, this.recoil);
    }

    this.weapon.root.updateMatrixWorld(true);
  }

  /** World-space muzzle (gun) or strike point (melee). */
  getTipPosition(out = new THREE.Vector3()) {
    if (!this.weapon) return out.set(0, 0, 0);
    const key = this.weapon.category === 'gun' ? 'muzzle' : 'strike';
    return this.weapon.getWorldAnchor(key, out);
  }

  getForward(out = new THREE.Vector3()) {
    if (!this.weapon) return out.set(0, 0, -1);
    return this.weapon.getWorldForward(out);
  }

  getGripPosition(out = new THREE.Vector3()) {
    if (!this.weapon) return out.set(0, 0, 0);
    return this.weapon.getWorldAnchor('grip', out);
  }
}

const _pitch = new THREE.Quaternion();
const _roll = new THREE.Quaternion();
const _back = new THREE.Vector3();
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisZ = new THREE.Vector3(0, 0, 1);

export default WeaponRig;
