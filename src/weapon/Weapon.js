import * as THREE from 'three';
import config from '../config.js';
import { principalAxis } from '../util/math3d.js';

/**
 * What each category needs tagged, in the order it is asked for.
 *
 * Grip comes first in both flows: it is the one anchor that always exists, it
 * is the easiest to point at, and everything else is oriented relative to it.
 */
export const ANCHOR_SPECS = {
  gun: [
    {
      key: 'grip',
      label: 'GRIP',
      prompt: 'Point at the GRIP',
      detail: 'Where your hand wraps around it',
    },
    {
      key: 'trigger',
      label: 'TRIGGER',
      prompt: 'Point at the TRIGGER',
      detail: 'Curl your index finger here to fire',
    },
    {
      key: 'muzzle',
      label: 'MUZZLE',
      prompt: 'Point at the MUZZLE',
      detail: 'Where the shots come out',
    },
  ],
  melee: [
    {
      key: 'grip',
      label: 'GRIP',
      prompt: 'Point at the GRIP',
      detail: 'Where your hand wraps around it',
    },
    {
      key: 'strike',
      label: 'STRIKE ZONE',
      prompt: 'Point at the STRIKING EDGE',
      detail: 'The part that does the damage',
    },
  ],
};

export const CATEGORIES = Object.keys(ANCHOR_SPECS);

/**
 * A drawn sketch plus the semantics the player assigned to it.
 *
 * Before `finalize()` the sketch floats where it was drawn and anchors are
 * world-space points. `finalize()` re-expresses everything in a weapon-local
 * frame — grip at the origin, business end down -Z — after which the weapon
 * can be parented to a hand and simply follow it.
 */
export class Weapon {
  /** @param {import('../draw/DrawingSession.js').DrawingSession} drawing */
  constructor(drawing) {
    this.drawing = drawing;
    /** @type {'gun'|'melee'|null} */
    this.category = null;
    /** @type {Map<string, THREE.Vector3>} World-space while tagging. */
    this.anchors = new Map();
    /** @type {Map<string, THREE.Vector3>} Weapon-local, after finalize. */
    this.localAnchors = new Map();

    /** Root the rig drives. */
    this.root = new THREE.Group();
    this.root.name = 'weapon';
    /** Carries the inverse of the finalize-time pose, so art lines up. */
    this.pivot = new THREE.Group();
    this.pivot.matrixAutoUpdate = false;
    this.root.add(this.pivot);

    this.markers = new THREE.Group();
    this.markers.name = 'anchor-markers';

    this.finalized = false;
    /** Barrel bore / blade line, weapon-local. */
    this.localForward = new THREE.Vector3(0, 0, -1);
    /** Distance from grip to the working end, metres. */
    this.reach = 0.2;
  }

  get spec() {
    return this.category ? ANCHOR_SPECS[this.category] : [];
  }

  /** The anchor currently being asked for, or null when tagging is done. */
  get nextAnchor() {
    return this.spec.find((s) => !this.anchors.has(s.key)) || null;
  }

  get taggingComplete() {
    return this.category !== null && this.nextAnchor === null;
  }

  setCategory(category) {
    if (!ANCHOR_SPECS[category]) throw new Error(`Unknown category: ${category}`);
    this.category = category;
    this.anchors.clear();
    this._rebuildMarkers();
    return this;
  }

  /** @param {string} key @param {THREE.Vector3} worldPoint */
  setAnchor(key, worldPoint) {
    this.anchors.set(key, worldPoint.clone());
    this._rebuildMarkers();
    return this;
  }

  /** Drop the most recently placed anchor. */
  undoAnchor() {
    const placed = this.spec.filter((s) => this.anchors.has(s.key));
    const last = placed[placed.length - 1];
    if (!last) return false;
    this.anchors.delete(last.key);
    this._rebuildMarkers();
    return true;
  }

  /** Remove every tagged anchor, keeping the category and the sketch. */
  clearAnchors() {
    this.anchors.clear();
    this._rebuildMarkers();
    return this;
  }

  _rebuildMarkers() {
    for (const child of [...this.markers.children]) {
      this.markers.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }
    for (const spec of this.spec) {
      const p = this.anchors.get(spec.key);
      if (!p) continue;
      const color = config.tagging.colors[spec.key] ?? 0xffffff;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(config.tagging.markerRadius, 14, 10),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 }),
      );
      mesh.position.copy(p);
      mesh.userData.anchorKey = spec.key;
      this.markers.add(mesh);
    }
  }

  /**
   * Direction the weapon acts along, in world space, from the tagged anchors.
   *
   * For a melee weapon the grip-to-edge line *is* the axis. For a gun that
   * line is often wrong — barrels sit above and forward of the grip, so
   * grip-to-muzzle points diagonally up through the body of the gun. Fitting
   * the principal axis of the samples around the muzzle recovers the actual
   * bore line, which is what a player expects to aim along.
   */
  computeForward(out = new THREE.Vector3()) {
    const grip = this.anchors.get('grip');
    if (!grip) return out.set(0, 0, -1);

    if (this.category === 'melee') {
      const strike = this.anchors.get('strike');
      if (!strike) return out.set(0, 0, -1);
      out.subVectors(strike, grip);
      return out.lengthSq() > 1e-8 ? out.normalize() : out.set(0, 0, -1);
    }

    const muzzle = this.anchors.get('muzzle');
    if (!muzzle) return out.set(0, 0, -1);

    _gripToMuzzle.subVectors(muzzle, grip);
    const fallbackValid = _gripToMuzzle.lengthSq() > 1e-8;
    if (fallbackValid) _gripToMuzzle.normalize();
    else _gripToMuzzle.set(0, 0, -1);

    const near = this.drawing.pointsNear(muzzle, config.tagging.barrelAxisRadius, _nearBuffer);
    if (near.length >= 6) {
      const axis = principalAxis(near, _axis);
      if (axis) {
        // The axis is sign-free; point it away from the grip.
        if (axis.dot(_gripToMuzzle) < 0) axis.negate();
        // Reject a fit that disagrees wildly — usually a blobby muzzle where
        // the "long axis" is meaningless.
        if (axis.dot(_gripToMuzzle) > 0.26) return out.copy(axis);
      }
    }
    return out.copy(_gripToMuzzle);
  }

  /**
   * Freeze the weapon into a local frame: grip at the origin, working end
   * along -Z, and "up" inherited from how it was drawn relative to gravity —
   * so a gun you sketched upright stays upright in your hand.
   */
  finalize() {
    if (this.finalized) return this;
    const grip = this.anchors.get('grip');
    if (!grip || !this.category) {
      throw new Error('finalize() needs a category and a grip anchor');
    }

    const forward = this.computeForward(_forward);

    let up = _up.set(0, 1, 0);
    up.addScaledVector(forward, -up.dot(forward));
    if (up.lengthSq() < 1e-6) {
      // The weapon was drawn pointing straight up or down; any perpendicular
      // will do, so borrow the world Z axis.
      up.set(0, 0, -1);
      up.addScaledVector(forward, -up.dot(forward));
    }
    up.normalize();

    const right = _right.crossVectors(forward, up).normalize();
    _back.copy(forward).negate();

    // World pose of the weapon at the moment of finalizing.
    _poseMatrix.makeBasis(right, up, _back);
    _poseMatrix.setPosition(grip);

    // The art currently sits in world space; parking its inverse on the pivot
    // keeps it exactly where it was drawn while the root sits at the grip.
    _inverse.copy(_poseMatrix).invert();
    this.pivot.matrix.copy(_inverse);
    this.pivot.matrixWorldNeedsUpdate = true;

    this.pivot.add(this.drawing.group);
    this.pivot.add(this.markers);

    this.root.position.copy(grip);
    this.root.quaternion.setFromRotationMatrix(_poseMatrix);
    this.root.updateMatrixWorld(true);

    for (const [key, world] of this.anchors) {
      this.localAnchors.set(key, world.clone().applyMatrix4(_inverse));
    }

    const tip = this.localAnchors.get(this.category === 'gun' ? 'muzzle' : 'strike');
    this.reach = tip ? Math.max(0.04, tip.length()) : 0.2;
    this.localForward.set(0, 0, -1);

    this.finalized = true;
    return this;
  }

  /** Local anchor position, or null if it was never tagged. */
  getLocalAnchor(key) {
    return this.localAnchors.get(key) || null;
  }

  /** World-space position of an anchor, following the root's current pose. */
  getWorldAnchor(key, out = new THREE.Vector3()) {
    const local = this.localAnchors.get(key);
    if (!local) return out.set(0, 0, 0);
    return out.copy(local).applyMatrix4(this.root.matrixWorld);
  }

  /** World-space firing / striking direction. */
  getWorldForward(out = new THREE.Vector3()) {
    return out.set(0, 0, -1).applyQuaternion(this.root.getWorldQuaternion(_quat));
  }

  setMarkersVisible(visible) {
    this.markers.visible = visible;
  }

  /** Free the anchor markers only, leaving the sketch intact. */
  disposeMarkers() {
    for (const child of [...this.markers.children]) {
      child.geometry?.dispose();
      child.material?.dispose();
    }
    this.markers.clear();
  }

  /** Free everything, including the sketch this weapon was built from. */
  dispose() {
    this.disposeMarkers();
    this.drawing.dispose();
  }
}

const _gripToMuzzle = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _back = new THREE.Vector3();
const _poseMatrix = new THREE.Matrix4();
const _inverse = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _nearBuffer = [];

export default Weapon;
