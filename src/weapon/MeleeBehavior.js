import * as THREE from 'three';
import config from '../config.js';
import { distanceToSegment } from '../util/math3d.js';

/**
 * Makes a melee-category weapon hit things.
 *
 * The tagged anchors define the weapon's working edge: **grip** to **strike**
 * is a line segment, not a point, so a swing connects anywhere along the blade
 * or head rather than only at the very tip.
 *
 * A hit needs speed as well as contact — resting the blade against a target
 * should do nothing. Speed is measured at the strike point itself, tracked
 * across frames, which means a flick of the wrist counts even when the hand
 * barely moves.
 */
export class MeleeBehavior {
  /**
   * @param {import('./WeaponRig.js').WeaponRig} rig
   * @param {import('../fx/Effects.js').SwingTrail} trail
   */
  constructor(rig, trail) {
    this.rig = rig;
    this.trail = trail;

    /** Current strike-point speed, m/s. */
    this.speed = 0;
    this.hits = 0;

    this._prevTip = new THREE.Vector3();
    this._hasPrev = false;
    this._velocity = new THREE.Vector3();
    this._wasPinching = false;
    this._lastThrowMs = -Infinity;
  }

  reset() {
    this._hasPrev = false;
    this.speed = 0;
    this.hits = 0;
    this._wasPinching = false;
    this.trail?.clear();
  }

  /**
   * @param {object|null} hand HandPose-like; only `pinching` is read here,
   *   everything positional still comes from the rig (the tip is the
   *   weapon's tagged strike anchor, not the hand itself, and the two are
   *   not the same point once grip offsets are applied).
   * @param {number} nowMs
   * @param {number} dt
   * @param {import('../fx/Targets.js').TargetField} targets
   * @param {(target, point) => void} onHit
   * @returns {{origin: THREE.Vector3, direction: THREE.Vector3}|null} a
   *   throw released this frame, or null.
   */
  update(hand, nowMs, dt, targets, onHit) {
    if (!this.rig.attached || this.rig.weapon?.category !== 'melee') return null;

    this.rig.getTipPosition(_tip);
    this.rig.getGripPosition(_grip);

    if (this._hasPrev && dt > 0) {
      _delta.subVectors(_tip, this._prevTip).multiplyScalar(1 / dt);
      // Smooth a little: raw frame-to-frame speed spikes on tracking jitter
      // and would fire off phantom hits.
      this._velocity.lerp(_delta, 0.4);
      this.speed = this._velocity.length();
    } else {
      this.speed = 0;
    }

    this.trail?.push(_tip);
    this.trail?.update(dt, THREE.MathUtils.clamp(this.speed / config.melee.minSwingSpeed, 0, 1.4));

    // Throw: pinch through the windup, release at speed — the same motion
    // as actually letting go of something mid-swing. A held weapon never
    // otherwise leaves the hand (see WeaponRig), so this is the only way a
    // melee weapon reaches anything outside swing range, which in versus
    // mode is the only range there is.
    let thrown = null;
    const pinching = !!hand?.visible && hand.pinching;
    const released = this._wasPinching && !pinching;
    this._wasPinching = pinching;
    if (
      released
      && this.speed >= config.melee.throwSpeed
      && nowMs - this._lastThrowMs >= config.melee.throwCooldownMs
      && this._velocity.lengthSq() > 1e-6
    ) {
      this._lastThrowMs = nowMs;
      thrown = { origin: _tip.clone(), direction: this._velocity.clone().normalize() };
    }

    if (this.speed >= config.melee.minSwingSpeed) {
      this._testHits(targets, onHit);
    }

    this._prevTip.copy(_tip);
    this._hasPrev = true;
    return thrown;
  }

  /**
   * Sweep the edge against every live target.
   *
   * The test uses the segment the edge occupies *now* plus where the strike
   * point was last frame, so a fast swing cannot pass through a target between
   * two samples.
   */
  _testHits(targets, onHit) {
    const reach = config.melee.hitRadius;

    for (const target of targets.targets) {
      if (!target.alive || target.hitCooldown > 0) continue;

      // 1. Against the blade itself, grip -> strike point.
      let distance = distanceToSegment(target.position, _grip, _tip, _closest);

      // 2. Against the path the strike point swept this frame.
      if (this._hasPrev) {
        const swept = distanceToSegment(target.position, this._prevTip, _tip, _sweptClosest);
        if (swept < distance) {
          distance = swept;
          _closest.copy(_sweptClosest);
        }
      }

      // Score first, then start the cooldown — TargetField.hit() rejects a
      // target that is already cooling down, so setting it early would make
      // every swing a no-op.
      if (distance <= target.radius + reach && targets.hit(target)) {
        target.hitCooldown = config.melee.hitCooldownMs / 1000;
        this.hits++;
        onHit?.(target, _closest);
      }
    }
  }

  /** True when the current swing is fast enough to connect. */
  get isSwinging() {
    return this.speed >= config.melee.minSwingSpeed;
  }
}

const _tip = new THREE.Vector3();
const _grip = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _sweptClosest = new THREE.Vector3();

export default MeleeBehavior;
