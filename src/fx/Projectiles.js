import * as THREE from 'three';
import config from '../config.js';
import { raySphere } from '../util/math3d.js';

/**
 * Fixed-size pool of shots.
 *
 * Drawn with one `InstancedMesh` so any number of live rounds costs a single
 * draw call — worth doing on a phone that is already spending its budget on
 * neural inference and two render passes.
 *
 * Collision is swept rather than point-in-sphere: at 22 m/s a round covers
 * ~37 cm per frame, so a naive per-frame position test would tunnel straight
 * through a 22 cm target.
 */
export class Projectiles {
  constructor() {
    this.max = config.gun.maxProjectiles;

    const geometry = new THREE.SphereGeometry(config.gun.projectileRadius, 10, 8);
    const material = new THREE.MeshBasicMaterial({ color: 0xffe9a8 });
    this.mesh = new THREE.InstancedMesh(geometry, material, this.max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = this.max;
    this.mesh.name = 'projectiles';

    this.positions = Array.from({ length: this.max }, () => new THREE.Vector3());
    this.velocities = Array.from({ length: this.max }, () => new THREE.Vector3());
    this.lives = new Float32Array(this.max);
    this._next = 0;

    // Park every instance out of sight until it is fired.
    _matrix.makeScale(0, 0, 0);
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, _matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} direction Unit vector.
   * @param {number} [speed]
   */
  fire(origin, direction, speed = config.gun.projectileSpeed) {
    // Round-robin: the oldest shot is the one that gets recycled.
    const i = this._next;
    this._next = (this._next + 1) % this.max;

    this.positions[i].copy(origin);
    this.velocities[i].copy(direction).normalize().multiplyScalar(speed);
    this.lives[i] = config.gun.projectileLifetime;
    return i;
  }

  /**
   * Advance every live round and report hits.
   *
   * @param {number} dt
   * @param {{position: THREE.Vector3, radius: number, alive: boolean}[]} targets
   * @param {(target, point, index) => void} onHit
   */
  update(dt, targets, onHit) {
    let dirty = false;

    for (let i = 0; i < this.max; i++) {
      if (this.lives[i] <= 0) continue;

      this.lives[i] -= dt;
      if (this.lives[i] <= 0) {
        _matrix.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _matrix);
        dirty = true;
        continue;
      }

      const pos = this.positions[i];
      const vel = this.velocities[i];

      _step.copy(vel).multiplyScalar(dt);
      const distance = _step.length();

      if (distance > 1e-6 && targets?.length) {
        _dir.copy(_step).multiplyScalar(1 / distance);
        let bestT = Infinity;
        let bestTarget = null;

        for (const target of targets) {
          if (!target.alive) continue;
          const t = raySphere(pos, _dir, target.position, target.radius);
          if (t >= 0 && t <= distance && t < bestT) {
            bestT = t;
            bestTarget = target;
          }
        }

        if (bestTarget) {
          _hitPoint.copy(pos).addScaledVector(_dir, bestT);
          onHit?.(bestTarget, _hitPoint, i);
          this.lives[i] = 0;
          _matrix.makeScale(0, 0, 0);
          this.mesh.setMatrixAt(i, _matrix);
          dirty = true;
          continue;
        }
      }

      pos.add(_step);
      _matrix.makeTranslation(pos.x, pos.y, pos.z);
      this.mesh.setMatrixAt(i, _matrix);
      dirty = true;
    }

    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.lives.fill(0);
    _matrix.makeScale(0, 0, 0);
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, _matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}

const _matrix = new THREE.Matrix4();
const _step = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();

export default Projectiles;
