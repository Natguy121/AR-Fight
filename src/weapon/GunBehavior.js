import * as THREE from 'three';
import config from '../config.js';

/**
 * Makes a gun-category weapon shoot.
 *
 * This is where the three tagged anchors pay off:
 *   - **trigger** decides *when* — the index finger's curl is measured, and a
 *     shot fires on the transition, so holding it down does not spray.
 *   - **muzzle** decides *where from* — rounds spawn at that exact point.
 *   - **grip** decides *along what* — with the muzzle, it fixes the bore line
 *     the weapon aims down.
 */
export class GunBehavior {
  /**
   * @param {import('./WeaponRig.js').WeaponRig} rig
   * @param {import('../fx/Projectiles.js').Projectiles} projectiles
   * @param {import('../fx/Effects.js').MuzzleFlash} flash
   */
  constructor(rig, projectiles, flash) {
    this.rig = rig;
    this.projectiles = projectiles;
    this.flash = flash;

    this.shotsFired = 0;
    this._lastShotMs = -Infinity;
    this._triggerWasPulled = false;
    /** Pool index of the most recent shot — versus mode tags it in
     * `main.js`'s hit callback, to tell a gun shot from a thrown melee. */
    this.lastProjectileIndex = -1;

    /** Set true to keep firing while the trigger is held. */
    this.automatic = false;
  }

  reset() {
    this.shotsFired = 0;
    this._lastShotMs = -Infinity;
    this._triggerWasPulled = false;
    this.lastProjectileIndex = -1;
  }

  /**
   * @param {object|null} hand HandPose-like.
   * @param {number} nowMs
   * @param {THREE.Quaternion} headQuat For billboarding the flash.
   * @returns {boolean} whether a shot went off this frame.
   */
  update(hand, nowMs, headQuat) {
    if (!this.rig.attached || this.rig.weapon?.category !== 'gun') return false;

    const pulled = !!hand?.visible && hand.triggerPulled;
    // Fire on the pull edge: a held finger is one shot, not a stream.
    const edge = pulled && !this._triggerWasPulled;
    this._triggerWasPulled = pulled;

    const wantsShot = this.automatic ? pulled : edge;
    if (!wantsShot) return false;
    if (nowMs - this._lastShotMs < config.gun.fireIntervalMs) return false;

    this._lastShotMs = nowMs;
    this.fire(headQuat);
    return true;
  }

  /** Fire one round from the tagged muzzle, along the tagged bore. */
  fire(headQuat) {
    this.rig.getTipPosition(_muzzle);
    this.rig.getForward(_forward);

    this.lastProjectileIndex = this.projectiles.fire(_muzzle, _forward);
    this.flash?.trigger(_muzzle, headQuat);
    this.rig.kick(1);
    this.shotsFired++;
  }

  /** Aim ray, for a laser sight or debug line. */
  getAimRay(originOut, directionOut) {
    this.rig.getTipPosition(originOut);
    this.rig.getForward(directionOut);
    return { origin: originOut, direction: directionOut };
  }
}

const _muzzle = new THREE.Vector3();
const _forward = new THREE.Vector3();

export default GunBehavior;
