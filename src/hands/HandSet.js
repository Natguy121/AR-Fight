import config from '../config.js';
import { HandPose } from './HandPose.js';

/**
 * Keeps a stable set of `HandPose` objects across frames.
 *
 * MediaPipe returns an unordered array whose indices can swap between frames.
 * Letting that reach the drawing code would tear a stroke in half whenever the
 * order flipped, so detections are matched to persistent slots — by handedness
 * where it is reliable, by nearest previous position otherwise.
 */
export class HandSet {
  constructor() {
    this.hands = Array.from({ length: config.hands.numHands }, () => new HandPose());
    /** The hand currently driving drawing / holding the weapon. */
    this.primary = null;
    this._primaryIndex = -1;
  }

  /**
   * @param {object|null} result Raw MediaPipe output.
   * @param {import('../core/VideoFrameMap.js').VideoFrameMap} frameMap
   * @param {import('three').Quaternion} headQuat
   * @param {import('three').Vector3} headPos
   * @param {number} timeSec
   * @param {number} dt
   */
  update(result, frameMap, headQuat, headPos, timeSec, dt) {
    const detections = HandSet._normalise(result);
    const assigned = new Array(this.hands.length).fill(null);
    const taken = new Set();

    // Pass 1: keep a slot if its handedness label still appears.
    for (let s = 0; s < this.hands.length; s++) {
      const slot = this.hands[s];
      if (!slot.visible || slot.handedness === 'unknown') continue;
      const match = detections.findIndex(
        (d, i) => !taken.has(i) && d.handedness === slot.handedness,
      );
      if (match !== -1) {
        assigned[s] = detections[match];
        taken.add(match);
      }
    }

    // Pass 2: match what is left by proximity to the slot's last wrist pixel.
    for (let s = 0; s < this.hands.length; s++) {
      if (assigned[s]) continue;
      const slot = this.hands[s];
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < detections.length; i++) {
        if (taken.has(i)) continue;
        if (!slot.visible) { best = i; break; }
        const d = detections[i];
        const dist = Math.hypot(d.landmarks[0].x - slot._lastU, d.landmarks[0].y - slot._lastV);
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      if (best !== -1) {
        assigned[s] = detections[best];
        taken.add(best);
      }
    }

    for (let s = 0; s < this.hands.length; s++) {
      const slot = this.hands[s];
      const det = assigned[s];
      if (det) {
        slot._lastU = det.landmarks[0].x;
        slot._lastV = det.landmarks[0].y;
        slot.update(det, frameMap, headQuat, headPos, timeSec, dt);
      } else {
        slot.markMissing();
      }
    }

    this._selectPrimary();
    return this;
  }

  /**
   * Pick the working hand, with a bias toward whichever one is already doing
   * something — swapping mid-stroke would be worse than picking "wrong".
   */
  _selectPrimary() {
    const visible = this.hands.filter((h) => h.visible);
    if (!visible.length) {
      this.primary = null;
      this._primaryIndex = -1;
      return;
    }

    const current = this.hands[this._primaryIndex];
    if (current?.visible && (current.pinching || current.triggerPulled)) return;

    // A pinching hand always wins: that is an explicit intent to act.
    const pinching = visible.find((h) => h.pinching);
    const chosen = pinching || (current?.visible ? current : visible[0]);

    this.primary = chosen;
    this._primaryIndex = this.hands.indexOf(chosen);
  }

  /** The hand that is not primary, if it is visible. */
  get secondary() {
    return this.hands.find((h) => h !== this.primary && h.visible) || null;
  }

  reset() {
    for (const h of this.hands) h.reset();
    this.primary = null;
    this._primaryIndex = -1;
  }

  /**
   * Flatten MediaPipe's parallel arrays into one object per hand.
   *
   * Handedness is reported as if the image were mirrored (the selfie-camera
   * assumption). We feed it an unmirrored rear-camera frame, so the labels are
   * swapped back here.
   */
  static _normalise(result) {
    if (!result?.landmarks?.length) return [];
    const out = [];
    for (let i = 0; i < result.landmarks.length; i++) {
      const category = result.handedness?.[i]?.[0];
      const reported = category?.categoryName || 'unknown';
      const handedness =
        reported === 'Left' ? 'Right' : reported === 'Right' ? 'Left' : 'unknown';
      out.push({
        landmarks: result.landmarks[i],
        worldLandmarks: result.worldLandmarks?.[i],
        handedness,
        score: category?.score ?? 1,
      });
    }
    return out;
  }
}

export default HandSet;
