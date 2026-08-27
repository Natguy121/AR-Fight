import * as THREE from 'three';
import { Stroke } from '../draw/Stroke.js';

/**
 * The opponent's weapon, rebuilt from `WeaponSync.serializeWeapon`'s output.
 *
 * Deliberately not a `Weapon` — that class exists to be *built* through the
 * draw/categorize/tag flow, with a lot of state (anchors mid-tagging,
 * markers, `finalize()`) this has no use for. All a received weapon needs is
 * to look right and expose where its anchors are, so `OpponentAvatar` can
 * point it the same way `WeaponRig` points a local one.
 */
export class RemoteWeapon {
  /** @param {ReturnType<import('./WeaponSync.js').serializeWeapon>} data */
  constructor(data) {
    this.category = data.category;
    this.reach = data.reach ?? 0.2;

    this.root = new THREE.Group();
    this.root.name = 'remote-weapon';

    for (const strokeData of data.strokes || []) {
      const stroke = new Stroke(strokeData.color, strokeData.radius);
      for (const p of strokeData.points) stroke.addPoint(_v.set(p.x, p.y, p.z));
      stroke.commit();
      this.root.add(stroke.mesh);
    }

    /** @type {Map<string, THREE.Vector3>} */
    this.localAnchors = new Map(
      Object.entries(data.anchors || {}).map(([key, p]) => [key, new THREE.Vector3(p.x, p.y, p.z)]),
    );
  }

  getWorldAnchor(key, out = new THREE.Vector3()) {
    const local = this.localAnchors.get(key);
    if (!local) return out.set(0, 0, 0);
    return out.copy(local).applyMatrix4(this.root.matrixWorld);
  }

  getWorldForward(out = new THREE.Vector3()) {
    return out.set(0, 0, -1).applyQuaternion(this.root.getWorldQuaternion(_q));
  }

  dispose() {
    for (const child of [...this.root.children]) {
      child.geometry?.dispose();
      child.material?.dispose();
    }
  }
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

export default RemoteWeapon;
