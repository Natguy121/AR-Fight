import * as THREE from 'three';
import config from '../config.js';
import { Stroke } from './Stroke.js';

/**
 * The sketch you are building: a set of strokes plus the operations the UI
 * exposes over them (undo, clear) and the queries the tagging step needs
 * (nearest sample to a fingertip, bounds, centre of mass).
 */
export class DrawingSession {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'drawing';
    /** @type {Stroke[]} */
    this.strokes = [];
    /** @type {Stroke|null} */
    this.active = null;
    this._colorIndex = 0;
  }

  get isEmpty() {
    return this.strokes.every((s) => s.isEmpty);
  }

  get pointCount() {
    return this.strokes.reduce((sum, s) => sum + s.points.length, 0);
  }

  /** Begin a stroke. No-op if one is already open. */
  beginStroke() {
    if (this.active) return this.active;
    if (this.strokes.length >= config.draw.maxStrokes) return null;

    const palette = config.draw.palette;
    const color = palette[this._colorIndex % palette.length];
    this._colorIndex++;

    const stroke = new Stroke(color);
    this.strokes.push(stroke);
    this.group.add(stroke.mesh);
    this.active = stroke;
    return stroke;
  }

  /** Extend the open stroke. */
  addPoint(p) {
    if (!this.active) return false;
    return this.active.addPoint(p);
  }

  /** Close the open stroke, discarding it if the user barely moved. */
  endStroke() {
    const stroke = this.active;
    this.active = null;
    if (!stroke) return null;

    if (stroke.points.length < 2) {
      // A stray single-frame pinch is noise, not a mark.
      this._remove(stroke);
      return null;
    }
    return stroke.commit();
  }

  update() {
    this.active?.update();
  }

  undo() {
    const stroke = this.strokes[this.strokes.length - 1];
    if (!stroke) return false;
    if (stroke === this.active) this.active = null;
    this._remove(stroke);
    return true;
  }

  clear() {
    for (const s of [...this.strokes]) this._remove(s);
    this.active = null;
    this._colorIndex = 0;
  }

  _remove(stroke) {
    const i = this.strokes.indexOf(stroke);
    if (i !== -1) this.strokes.splice(i, 1);
    this.group.remove(stroke.mesh);
    stroke.dispose();
  }

  /**
   * Bake a world transform into the stored samples and rebuild the meshes.
   *
   * Stroke geometry is generated straight from world-space samples with the
   * group left at identity, so anchor snapping compares fingertips against
   * `points` directly. If the group ever picks up a transform — as it does
   * when a weapon is finalized and then re-opened — those two drift apart and
   * snapping targets empty air. Folding the transform into the samples keeps
   * the sketch visually put while restoring that invariant.
   *
   * @param {THREE.Matrix4} matrix
   */
  applyTransform(matrix) {
    for (const stroke of this.strokes) {
      for (const p of stroke.points) p.applyMatrix4(matrix);
      stroke.rebuild();
    }
    this.group.position.set(0, 0, 0);
    this.group.quaternion.identity();
    this.group.scale.set(1, 1, 1);
    this.group.updateMatrixWorld(true);
    return this;
  }

  /** Every committed sample, flattened. Used for anchor snapping and PCA. */
  allPoints(out = []) {
    out.length = 0;
    for (const s of this.strokes) {
      for (const p of s.points) out.push(p);
    }
    return out;
  }

  /**
   * Closest recorded sample to `target`.
   * @returns {{point: THREE.Vector3, distance: number}|null}
   */
  nearestPoint(target, maxDistance = Infinity) {
    let best = null;
    let bestSq = maxDistance * maxDistance;
    for (const s of this.strokes) {
      for (const p of s.points) {
        const d = p.distanceToSquared(target);
        if (d < bestSq) {
          bestSq = d;
          best = p;
        }
      }
    }
    return best ? { point: best, distance: Math.sqrt(bestSq) } : null;
  }

  /** Samples within `radius` of `centre`. */
  pointsNear(centre, radius, out = []) {
    out.length = 0;
    const r2 = radius * radius;
    for (const s of this.strokes) {
      for (const p of s.points) {
        if (p.distanceToSquared(centre) <= r2) out.push(p);
      }
    }
    return out;
  }

  getBounds(out = new THREE.Box3()) {
    out.makeEmpty();
    for (const s of this.strokes) {
      for (const p of s.points) out.expandByPoint(p);
    }
    return out;
  }

  getCentroid(out = new THREE.Vector3()) {
    out.set(0, 0, 0);
    let n = 0;
    for (const s of this.strokes) {
      for (const p of s.points) {
        out.add(p);
        n++;
      }
    }
    return n ? out.multiplyScalar(1 / n) : out;
  }

  /** Longest dimension of the sketch, in metres. */
  get extent() {
    const box = this.getBounds(_box);
    if (box.isEmpty()) return 0;
    box.getSize(_size);
    return Math.max(_size.x, _size.y, _size.z);
  }

  dispose() {
    this.clear();
  }
}

const _box = new THREE.Box3();
const _size = new THREE.Vector3();

export default DrawingSession;
