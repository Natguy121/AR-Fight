import * as THREE from 'three';

/**
 * The bridge between camera pixels and the 3D scene.
 *
 * The passthrough video is drawn "cover"-fitted: scaled to fill the eye
 * viewport, with the overflowing axis cropped. Hand landmarks arrive in
 * video-normalised coordinates. If those two mappings disagree by even a few
 * percent, strokes land visibly beside your fingers. This class defines the
 * mapping once and hands the identical numbers to both the background shader
 * and the landmark unprojection.
 *
 * Reconstruction deliberately uses the *render* camera's projection rather
 * than the physical camera's. That makes on-screen alignment exact regardless
 * of how wrong our estimate of the phone's lens FOV is — a bad FOV estimate
 * then only affects how far away things feel, which calibration corrects.
 */
export class VideoFrameMap {
  constructor() {
    /** Video aspect (w/h). */
    this.videoAspect = 1;
    /** Aspect of one eye's viewport (w/h). */
    this.displayAspect = 1;
    /** Vertical FOV of the render camera, radians. */
    this.fovY = THREE.MathUtils.degToRad(72);
    /** Cover-fit scale factors, video-normalised -> NDC. */
    this.scaleX = 1;
    this.scaleY = 1;
    /** Set when sampling a user-facing camera, which reads mirrored. */
    this.mirrorX = false;
  }

  setVideoAspect(aspect) {
    this.videoAspect = aspect > 0 ? aspect : 1;
    this._recompute();
    return this;
  }

  /** @param {number} aspect Width/height of a single eye viewport. */
  setDisplay(aspect, fovYDeg) {
    this.displayAspect = aspect > 0 ? aspect : 1;
    this.fovY = THREE.MathUtils.degToRad(fovYDeg);
    this._recompute();
    return this;
  }

  _recompute() {
    // Cover fit: whichever axis is relatively larger gets cropped.
    if (this.videoAspect > this.displayAspect) {
      this.scaleX = this.videoAspect / this.displayAspect;
      this.scaleY = 1;
    } else {
      this.scaleX = 1;
      this.scaleY = this.displayAspect / this.videoAspect;
    }
  }

  /**
   * Video-normalised (u right, v down) -> NDC (x right, y up), both centred.
   * @param {number} u
   * @param {number} v
   * @param {THREE.Vector2} [out]
   */
  videoToNdc(u, v, out = new THREE.Vector2()) {
    const uu = this.mirrorX ? 1 - u : u;
    out.x = (uu - 0.5) * 2 * this.scaleX;
    out.y = -(v - 0.5) * 2 * this.scaleY;
    return out;
  }

  /** True when the landmark falls inside the visible (uncropped) region. */
  isVisible(u, v, margin = 0.02) {
    const n = this.videoToNdc(u, v, _tmpVec2);
    const lim = 1 + margin;
    return Math.abs(n.x) <= lim && Math.abs(n.y) <= lim;
  }

  /**
   * Lift a landmark to a point in view space (three.js convention: the viewer
   * looks down -Z), placed so that it reprojects onto exactly the pixel the
   * landmark occupied.
   *
   * @param {number} u Video-normalised x.
   * @param {number} v Video-normalised y.
   * @param {number} depth Distance in front of the viewer, metres, positive.
   * @param {THREE.Vector3} [out]
   */
  unproject(u, v, depth, out = new THREE.Vector3()) {
    const n = this.videoToNdc(u, v, _tmpVec2);
    const tanHalf = Math.tan(this.fovY * 0.5);
    out.x = n.x * tanHalf * this.displayAspect * depth;
    out.y = n.y * tanHalf * depth;
    out.z = -depth;
    return out;
  }

  /**
   * Focal length of the *physical* camera in pixels, for the monocular depth
   * estimate. Derived from the configured lens FOV and the capture height.
   *
   * @param {number} videoHeightPx
   * @param {number} cameraFovYDeg
   */
  static focalLengthPx(videoHeightPx, cameraFovYDeg) {
    const f = THREE.MathUtils.degToRad(cameraFovYDeg);
    return (videoHeightPx * 0.5) / Math.tan(f * 0.5);
  }
}

const _tmpVec2 = new THREE.Vector2();

export default VideoFrameMap;
