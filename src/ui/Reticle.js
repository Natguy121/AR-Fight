import * as THREE from 'three';

/**
 * Gaze crosshair with a dwell ring.
 *
 * Head-locked at a fixed distance, so it sits at a comfortable convergence in
 * stereo instead of fighting the eyes. The ring fills as a gaze selection
 * charges, which is the only feedback telling you a look is being counted.
 */
export class Reticle {
  constructor(distance = 1.1) {
    this.distance = distance;
    this.group = new THREE.Group();
    this.group.name = 'reticle';
    this.group.renderOrder = 1100;

    const dotGeo = new THREE.CircleGeometry(0.006, 20);
    this.dotMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.65,
      depthTest: false,
      depthWrite: false,
    });
    this.dot = new THREE.Mesh(dotGeo, this.dotMat);
    this.dot.renderOrder = 1101;
    this.group.add(this.dot);

    this.ringSegments = 48;
    const ringGeo = new THREE.RingGeometry(0.018, 0.024, this.ringSegments, 1, 0, Math.PI * 2);
    /** Indices per theta segment, for the draw-range sweep below. */
    this.indicesPerSegment = ringGeo.index.count / this.ringSegments;
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0x5ac8fa,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(ringGeo, this.ringMat);
    this.ring.renderOrder = 1102;
    this.ring.visible = false;
    this.group.add(this.ring);

    this._progress = -1;
  }

  /**
   * @param {THREE.Vector3} headPos
   * @param {THREE.Quaternion} headQuat
   * @param {number} progress Dwell fraction 0..1; 0 hides the ring.
   */
  update(headPos, headQuat, progress = 0) {
    _forward.set(0, 0, -1).applyQuaternion(headQuat);
    this.group.position.copy(headPos).addScaledVector(_forward, this.distance);
    this.group.quaternion.copy(headQuat);

    const p = THREE.MathUtils.clamp(progress, 0, 1);
    if (Math.abs(p - this._progress) < 0.005) return;
    this._progress = p;

    if (p <= 0.001) {
      this.ring.visible = false;
      this.dotMat.opacity = 0.65;
      return;
    }

    this.ring.visible = true;
    this.dotMat.opacity = 0.95;
    // Sweep the arc by drawing only the first N segments of the ring. Cheaper
    // and steadier than rebuilding the geometry every frame of a dwell.
    const segments = Math.max(1, Math.round(this.ringSegments * p));
    this.ring.geometry.setDrawRange(0, segments * this.indicesPerSegment);
  }

  setVisible(v) {
    this.group.visible = v;
  }

  dispose() {
    this.dot.geometry.dispose();
    this.ring.geometry.dispose();
    this.dotMat.dispose();
    this.ringMat.dispose();
  }
}

const _forward = new THREE.Vector3();

export default Reticle;
