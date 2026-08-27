import * as THREE from 'three';
import config from '../config.js';
import { RemoteWeapon } from './RemoteWeapon.js';

/**
 * The opponent, as rendered in a remote versus match.
 *
 * There is no shared physical space between two players in different rooms
 * — nothing to anchor a "real" position to — so the avatar is placed once,
 * fixed, a set distance in front of wherever the local player was facing
 * when the match started (see `place`), facing back toward them. What
 * *does* carry real information is their weapon's motion relative to their
 * own head — `pose` messages are already expressed that way (see
 * `WeaponSync`/`main.js`) — so the avatar's weapon swings and aims exactly
 * as theirs does, just anchored to a body that stands still, the same way a
 * practice target would.
 */
export class OpponentAvatar {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'opponent';
    this.group.visible = false;

    this.head = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 16, 12),
      new THREE.MeshStandardMaterial({
        color: 0xff8c8c, roughness: 0.5, metalness: 0.1, emissive: 0x330d0d,
      }),
    );
    this.head.position.y = 0.08;

    this.torso = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.14, 0.32, 4, 10),
      new THREE.MeshStandardMaterial({ color: 0x2c3a52, roughness: 0.75, metalness: 0.05 }),
    );
    this.torso.position.y = -0.26;

    this.group.add(this.head, this.torso);

    /** @type {RemoteWeapon|null} */
    this.weapon = null;
    /** Positioned/oriented from `pose` messages; holds the weapon. */
    this.weaponAnchor = new THREE.Group();
    this.group.add(this.weaponAnchor);

    this.health = config.versus.maxHealth;
    this.alive = true;
    /**
     * Stable object identity matters here: `main.js` compares the target a
     * projectile hit against this exact reference to tell "the opponent"
     * apart from a practice target, so this is built once and mutated in
     * place — never reconstructed — including reusing `group.position`
     * itself rather than a copy, so `place()` moving the group is reflected
     * with no extra bookkeeping.
     */
    this.hitbox = { position: this.group.position, radius: config.versus.hitRadius, alive: true };

    this._targetOffset = new THREE.Vector3(0.2, -0.15, -0.35);
    this._targetQuat = new THREE.Quaternion();
    this.weaponAnchor.position.copy(this._targetOffset);
  }

  /** @param {ReturnType<import('./WeaponSync.js').serializeWeapon>} data */
  setWeapon(data) {
    this.weapon?.dispose();
    this.weapon = new RemoteWeapon(data);
    this.weaponAnchor.clear();
    this.weaponAnchor.add(this.weapon.root);
  }

  /** Fix the avatar in world space, facing the given head position. Called once, at match start. */
  place(headPos, headQuat) {
    _fwd.set(0, 0, -1).applyQuaternion(headQuat);
    this.group.position.copy(headPos).addScaledVector(_fwd, config.versus.opponentDistance);
    this.group.position.y = headPos.y + config.versus.opponentHeightOffset;

    _lookDir.subVectors(headPos, this.group.position);
    _lookDir.y = 0;
    if (_lookDir.lengthSq() > 1e-6) {
      _lookDir.normalize();
      _m.lookAt(_zero, _lookDir, _up);
      this.group.quaternion.setFromRotationMatrix(_m);
    }
    this.group.visible = true;
    this.group.updateMatrixWorld(true);
  }

  /** From a `pose` message: the opponent's weapon, relative to their own head (see `main.js`). */
  applyPose(pos, quat) {
    this._targetOffset.set(pos.x, pos.y, pos.z);
    this._targetQuat.set(quat.x, quat.y, quat.z, quat.w);
  }

  update(dt) {
    if (!this.group.visible) return;
    const t = Math.min(1, dt * 12);
    this.weaponAnchor.position.lerp(this._targetOffset, t);
    this.weaponAnchor.quaternion.slerp(this._targetQuat, t);
    this.weaponAnchor.updateMatrixWorld(true);
  }

  /** World-space muzzle (gun) or strike point (melee), for a hit-reaction effect to spawn at. */
  getTipPosition(out = new THREE.Vector3()) {
    if (!this.weapon) return out.copy(this.group.position);
    const key = this.weapon.category === 'gun' ? 'muzzle' : 'strike';
    return this.weapon.getWorldAnchor(key, out);
  }

  takeDamage(amount) {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) this.alive = false;
    this.hitbox.alive = this.alive;
  }

  /** Between rounds against the *same* opponent — keeps the weapon and position. */
  resetHealth() {
    this.health = config.versus.maxHealth;
    this.alive = true;
    this.hitbox.alive = true;
  }

  /** End of a match for good (disconnect, rematch) — nothing here still applies. */
  reset() {
    this.resetHealth();
    this.group.visible = false;
    this.weapon?.dispose();
    this.weapon = null;
    this.weaponAnchor.clear();
  }

  dispose() {
    this.weapon?.dispose();
    this.weapon = null;
    this.head.geometry.dispose();
    this.head.material.dispose();
    this.torso.geometry.dispose();
    this.torso.material.dispose();
  }
}

const _fwd = new THREE.Vector3();
const _lookDir = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();

export default OpponentAvatar;
