import * as THREE from 'three';
import config from '../config.js';

/**
 * One continuous mid-air mark: the samples between a pinch closing and opening.
 *
 * The mesh is a tube swept along the sampled path. Rebuilding it every frame
 * while drawing is wasteful, so the geometry is regenerated on a short cadence
 * and only while the stroke is live; once committed it never changes again.
 */
export class Stroke {
  /**
   * @param {number} color
   * @param {number} [radius]
   */
  constructor(color, radius = config.draw.strokeRadius) {
    /** @type {THREE.Vector3[]} World-space samples. */
    this.points = [];
    this.color = color;
    this.radius = radius;
    this.live = true;

    this.material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.35,
      metalness: 0.25,
      emissive: new THREE.Color(color).multiplyScalar(0.22),
    });

    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;

    this._framesSinceRebuild = 0;
    this._builtCount = 0;
  }

  /**
   * Record a sample if it is far enough from the last one.
   * @returns {boolean} whether the point was accepted.
   */
  addPoint(p) {
    if (this.points.length >= config.draw.maxSamplesPerStroke) return false;
    const last = this.points[this.points.length - 1];
    if (last && last.distanceToSquared(p) < config.draw.minSampleDistance ** 2) return false;
    this.points.push(p.clone());
    return true;
  }

  /** Rebuild the tube if enough has changed. Call once per frame while live. */
  update() {
    if (!this.live) return;
    this._framesSinceRebuild++;
    const grew = this.points.length !== this._builtCount;
    if (grew && this._framesSinceRebuild >= config.draw.rebuildEveryNFrames) {
      this.rebuild();
    }
  }

  rebuild() {
    this._framesSinceRebuild = 0;
    this._builtCount = this.points.length;

    const geometry = this._buildGeometry();
    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
  }

  _buildGeometry() {
    const n = this.points.length;
    if (n === 0) return new THREE.BufferGeometry();

    // A single sample is a dot, not a path — give it a bead so a tap still
    // leaves something visible.
    if (n === 1) {
      const g = new THREE.SphereGeometry(this.radius, 8, 6);
      g.translate(this.points[0].x, this.points[0].y, this.points[0].z);
      return g;
    }

    // CatmullRomCurve3 needs distinct points; identical neighbours produce NaN
    // tangents and a geometry full of holes.
    const curve = new THREE.CatmullRomCurve3(this.points, false, 'centripetal', 0.5);
    const segments = Math.min(Math.max(n * 2, 4), 600);
    return new THREE.TubeGeometry(
      curve,
      segments,
      this.radius,
      config.draw.radialSegments,
      false,
    );
  }

  /** Freeze the stroke: final rebuild, no further updates. */
  commit() {
    this.live = false;
    this.rebuild();
    return this;
  }

  /** Total path length in metres. */
  get length() {
    let total = 0;
    for (let i = 1; i < this.points.length; i++) {
      total += this.points[i].distanceTo(this.points[i - 1]);
    }
    return total;
  }

  get isEmpty() {
    return this.points.length === 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

export default Stroke;
