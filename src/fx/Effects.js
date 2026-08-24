import * as THREE from 'three';
import config from '../config.js';

/**
 * Short-lived visual feedback: muzzle flash, impact bursts, and the ribbon a
 * melee weapon leaves through the air.
 *
 * Everything here is pooled and additive. Nothing allocates during play.
 */

/** A billboarded flare that pops at the muzzle for a few frames. */
export class MuzzleFlash {
  constructor() {
    this.material = new THREE.MeshBasicMaterial({
      color: 0xffd27f,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.CircleGeometry(0.05, 16), this.material);
    this.mesh.visible = false;
    this.mesh.renderOrder = 950;
    this._remaining = 0;
  }

  trigger(position, headQuat) {
    this.mesh.position.copy(position);
    this.mesh.quaternion.copy(headQuat);
    this.mesh.visible = true;
    this._remaining = config.gun.muzzleFlashMs / 1000;
    // A little scale variation stops repeat fire looking like a strobe.
    this.mesh.scale.setScalar(0.85 + Math.random() * 0.45);
  }

  update(dt) {
    if (this._remaining <= 0) return;
    this._remaining -= dt;
    const t = Math.max(0, this._remaining / (config.gun.muzzleFlashMs / 1000));
    this.material.opacity = t;
    if (this._remaining <= 0) this.mesh.visible = false;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** Pool of expanding impact rings. */
export class ImpactBursts {
  constructor(count = 12) {
    this.group = new THREE.Group();
    this.group.name = 'impacts';
    this.items = [];
    for (let i = 0; i < count; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(0.02, 0.07, 20), material);
      mesh.visible = false;
      mesh.renderOrder = 951;
      this.group.add(mesh);
      this.items.push({ mesh, material, life: 0, duration: 0.32 });
    }
    this._next = 0;
  }

  spawn(position, headQuat, color = 0xffe9a8) {
    const item = this.items[this._next];
    this._next = (this._next + 1) % this.items.length;
    item.mesh.position.copy(position);
    item.mesh.quaternion.copy(headQuat);
    item.mesh.visible = true;
    item.mesh.scale.setScalar(0.5);
    item.material.color.setHex(color);
    item.material.opacity = 1;
    item.life = item.duration;
  }

  update(dt) {
    for (const item of this.items) {
      if (item.life <= 0) continue;
      item.life -= dt;
      const t = Math.max(0, item.life / item.duration);
      item.material.opacity = t;
      item.mesh.scale.setScalar(0.5 + (1 - t) * 2.2);
      if (item.life <= 0) item.mesh.visible = false;
    }
  }

  dispose() {
    for (const item of this.items) {
      item.mesh.geometry.dispose();
      item.material.dispose();
    }
  }
}

/**
 * Fading ribbon along the strike point's recent path.
 *
 * A melee hit is decided by speed, which is otherwise invisible — the trail is
 * what tells you whether that swing was fast enough to count.
 */
export class SwingTrail {
  constructor() {
    this.segments = config.melee.trailSegments;
    this.positions = new Float32Array(this.segments * 3);
    this.alphas = new Float32Array(this.segments);
    this.count = 0;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(0xffe74c) } },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(uColor, vAlpha);
        }
      `,
    });

    this.line = new THREE.Line(geometry, material);
    this.line.frustumCulled = false;
    this.line.renderOrder = 940;
    this.material = material;
    this._ages = new Float32Array(this.segments);
  }

  /** Push the current strike position onto the ribbon. */
  push(position) {
    // Shift the buffer back one slot; at 24 segments this is trivial.
    for (let i = this.segments - 1; i > 0; i--) {
      const dst = i * 3;
      const src = (i - 1) * 3;
      this.positions[dst] = this.positions[src];
      this.positions[dst + 1] = this.positions[src + 1];
      this.positions[dst + 2] = this.positions[src + 2];
      this._ages[i] = this._ages[i - 1];
    }
    this.positions[0] = position.x;
    this.positions[1] = position.y;
    this.positions[2] = position.z;
    this._ages[0] = 0;
    this.count = Math.min(this.count + 1, this.segments);
  }

  update(dt, intensity = 1) {
    const lifetime = config.melee.trailLifetimeMs / 1000;
    for (let i = 0; i < this.segments; i++) {
      this._ages[i] += dt;
      const t = Math.max(0, 1 - this._ages[i] / lifetime);
      // Taper toward the tail as well as over time.
      this.alphas[i] = t * t * intensity * (1 - i / this.segments);
    }
    this.line.geometry.attributes.position.needsUpdate = true;
    this.line.geometry.attributes.aAlpha.needsUpdate = true;
    this.line.geometry.setDrawRange(0, this.count);
  }

  setColor(hex) {
    this.material.uniforms.uColor.value.setHex(hex);
  }

  clear() {
    this.positions.fill(0);
    this.alphas.fill(0);
    this._ages.fill(999);
    this.count = 0;
    this.line.geometry.attributes.position.needsUpdate = true;
    this.line.geometry.attributes.aAlpha.needsUpdate = true;
  }

  dispose() {
    this.line.geometry.dispose();
    this.material.dispose();
  }
}
