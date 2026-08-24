import * as THREE from 'three';
import config from '../config.js';

/**
 * Practice targets orbiting the player.
 *
 * Head tracking is 3DoF, so the player turns but does not walk — targets are
 * therefore placed on a ring at head height and given a slow drift, which
 * makes the whole 360 degrees worth using and keeps the passthrough view
 * feeling like a space rather than a screen.
 */

class Target {
  constructor(index) {
    this.index = index;
    this.position = new THREE.Vector3();
    this.radius = config.targets.radius;
    this.alive = true;
    this.respawnIn = 0;
    /** Per-target melee cooldown, so one swing cannot multi-hit. */
    this.hitCooldown = 0;

    this._phase = Math.random() * Math.PI * 2;
    this._bobSpeed = 0.5 + Math.random() * 0.7;
    this._bobAmount = 0.06 + Math.random() * 0.1;
    this._baseY = 0;
    this._angle = 0;
    this._ringRadius = config.targets.ringRadius;
    this._angularSpeed = 0;

    const geometry = new THREE.IcosahedronGeometry(config.targets.radius, 1);
    this.material = new THREE.MeshStandardMaterial({
      color: 0xff6b6b,
      emissive: 0x4a0f16,
      roughness: 0.4,
      metalness: 0.1,
      flatShading: true,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);

    // A faint shell makes a target readable against a busy camera image.
    this.shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(config.targets.radius * 1.22, 1),
      new THREE.MeshBasicMaterial({
        color: 0xff9d9d,
        transparent: true,
        opacity: 0.16,
        wireframe: true,
        depthWrite: false,
      }),
    );
    this.mesh.add(this.shell);

    this.respawn();
  }

  respawn() {
    const c = config.targets;
    this._angle = Math.random() * Math.PI * 2;
    this._ringRadius = c.ringRadius + (Math.random() - 0.5) * 2 * c.ringRadiusJitter;
    this._baseY = c.minHeight + Math.random() * (c.maxHeight - c.minHeight);
    this._angularSpeed = (Math.random() - 0.5) * 2 * (c.driftSpeed / this._ringRadius);
    this._phase = Math.random() * Math.PI * 2;

    this.alive = true;
    this.respawnIn = 0;
    this.hitCooldown = 0;
    this.mesh.visible = true;
    this.mesh.scale.setScalar(0.01); // pop in rather than blink in
    this.material.emissive.setHex(0x4a0f16);
  }

  kill() {
    this.alive = false;
    this.respawnIn = config.targets.respawnDelayMs / 1000;
  }

  update(dt, time) {
    if (this.hitCooldown > 0) this.hitCooldown -= dt;

    if (!this.alive) {
      // Shrink out, then wait before coming back.
      const s = Math.max(0, this.mesh.scale.x - dt * 6);
      this.mesh.scale.setScalar(s);
      if (s <= 0) this.mesh.visible = false;

      this.respawnIn -= dt;
      if (this.respawnIn <= 0) this.respawn();
      return;
    }

    if (this.mesh.scale.x < 1) {
      this.mesh.scale.setScalar(Math.min(1, this.mesh.scale.x + dt * 4));
    }

    this._angle += this._angularSpeed * dt;
    const y = this._baseY + Math.sin(time * this._bobSpeed + this._phase) * this._bobAmount;
    this.position.set(
      Math.cos(this._angle) * this._ringRadius,
      y,
      Math.sin(this._angle) * this._ringRadius,
    );
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y += dt * 0.55;
    this.mesh.rotation.x += dt * 0.25;

    // Ease the hit flash back down.
    const e = this.material.emissive;
    e.r += (0.29 - e.r) * Math.min(1, dt * 6);
    e.g += (0.06 - e.g) * Math.min(1, dt * 6);
    e.b += (0.09 - e.b) * Math.min(1, dt * 6);
  }

  flash() {
    this.material.emissive.setRGB(1, 0.85, 0.5);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.shell.geometry.dispose();
    this.shell.material.dispose();
  }
}

export class TargetField {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'targets';
    /** @type {Target[]} */
    this.targets = [];
    this.score = 0;
    this._time = 0;

    for (let i = 0; i < config.targets.count; i++) {
      const t = new Target(i);
      this.targets.push(t);
      this.group.add(t.mesh);
    }
  }

  update(dt) {
    this._time += dt;
    for (const t of this.targets) t.update(dt, this._time);
  }

  /**
   * Register a hit. Returns false when the target was already dead or is still
   * inside its cooldown, so callers can skip the score and the effects.
   */
  hit(target) {
    if (!target?.alive || target.hitCooldown > 0) return false;
    target.flash();
    target.kill();
    this.score++;
    return true;
  }

  /** Nearest live target within `radius` of `point`. */
  findNear(point, radius) {
    let best = null;
    let bestDist = radius;
    for (const t of this.targets) {
      if (!t.alive || t.hitCooldown > 0) continue;
      const d = t.position.distanceTo(point) - t.radius;
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    return best;
  }

  reset() {
    this.score = 0;
    for (const t of this.targets) t.respawn();
  }

  dispose() {
    for (const t of this.targets) t.dispose();
    this.targets = [];
  }
}

export default TargetField;
