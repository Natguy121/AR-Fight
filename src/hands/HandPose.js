import * as THREE from 'three';
import config from '../config.js';
import { LM } from './HandTracker.js';
import { OneEuroFilter } from '../util/OneEuroFilter.js';
import { angleAt, clamp } from '../util/math3d.js';

/**
 * Turns one MediaPipe hand detection into a metric, world-space hand.
 *
 * The hard part is depth: a single camera gives none. The usual trick —
 * compare one bone's pixel length against its known real length — collapses
 * whenever the hand tilts, because a foreshortened bone reads as "far away".
 *
 * Instead we fit the whole hand at once. MediaPipe hands us a metrically
 * correct 3D model of the current pose (`worldLandmarks`, in metres) and its
 * exact 2D projection (`landmarks`). Solving for the rotation and scale that
 * best map one onto the other is a small weak-perspective problem with a
 * closed form. Rotation absorbs the tilt, so the scale left over is honest
 * distance — and we get a full 3D hand orientation as a by-product, which is
 * what the weapon grip needs anyway.
 *
 * Each landmark is then placed along the ray through the pixel it actually
 * occupied, at its own depth. So the hand always reprojects exactly where you
 * saw it, while still having true 3D structure.
 */

/** Palm landmarks: rigid relative to each other, so they anchor the fit. */
const FIT_INDICES = [
  LM.WRIST, LM.THUMB_CMC, LM.THUMB_MCP, LM.INDEX_MCP,
  LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP,
  LM.INDEX_PIP, LM.MIDDLE_PIP, LM.RING_PIP, LM.PINKY_PIP,
];

export class HandPose {
  constructor() {
    /** 21 world-space landmark positions. */
    this.landmarks = Array.from({ length: 21 }, () => new THREE.Vector3());
    /** 21 view-space landmark positions (head-relative). */
    this.viewLandmarks = Array.from({ length: 21 }, () => new THREE.Vector3());

    this.visible = false;
    /** Frames since this hand was last seen; used to expire stale poses. */
    this.missingFrames = 0;
    this.handedness = 'unknown';
    this.score = 0;

    /** Distance from the viewer to the hand centroid, metres. */
    this.depth = 0.45;
    /** Wrist-to-middle-knuckle length in metres — the hand's own scale. */
    this.handScale = 0.09;

    // Grip frame, world space.
    this.gripPoint = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.right = new THREE.Vector3(1, 0, 0);
    this.palmNormal = new THREE.Vector3(0, 0, 1);
    this.orientation = new THREE.Quaternion();

    // Cursors.
    this.pinchPoint = new THREE.Vector3();
    this.indexTip = new THREE.Vector3();

    // Gesture state.
    this.pinchRatio = 1;
    this.pinching = false;
    this.indexCurlDeg = 180;
    this.triggerPulled = false;
    this.pointing = false;

    // Velocity of the pinch point, world space, m/s.
    this.velocity = new THREE.Vector3();
    this._prevPinch = new THREE.Vector3();
    this._hasPrev = false;

    /** Last wrist pixel, used by HandSet to re-match detections to this slot. */
    this._lastU = 0.5;
    this._lastV = 0.5;

    this._initFilters();
    this._pinchHold = 0;
    this._triggerHold = 0;
  }

  _initFilters() {
    const { filterMinCutoff, filterBeta, filterDCutoff } = config.hands;
    const opts = { minCutoff: filterMinCutoff, beta: filterBeta, dCutoff: filterDCutoff };
    /** Two filters per landmark, applied to the 2D observation before lifting. */
    this._uFilters = Array.from({ length: 21 }, () => new OneEuroFilter(opts));
    this._vFilters = Array.from({ length: 21 }, () => new OneEuroFilter(opts));
    /** Depth is the noisy channel and gets its own, much heavier, filter. */
    this._depthFilter = new OneEuroFilter({
      minCutoff: config.hands.depthFilterMinCutoff,
      beta: config.hands.depthFilterBeta,
      dCutoff: 1.0,
    });
  }

  reset() {
    this.visible = false;
    this._hasPrev = false;
    this._pinchHold = 0;
    this._triggerHold = 0;
    this.pinching = false;
    this.triggerPulled = false;
    for (let i = 0; i < 21; i++) {
      this._uFilters[i].reset();
      this._vFilters[i].reset();
    }
    this._depthFilter.reset();
  }

  /** Mark this hand as not detected on the current frame. */
  markMissing() {
    this.missingFrames++;
    if (this.missingFrames > 4) {
      this.visible = false;
      this._hasPrev = false;
    }
  }

  /**
   * @param {object} detection `{landmarks, worldLandmarks, handedness, score}`.
   * @param {import('../core/VideoFrameMap.js').VideoFrameMap} frameMap
   * @param {THREE.Quaternion} headQuat
   * @param {THREE.Vector3} headPos
   * @param {number} timeSec
   * @param {number} dt
   */
  update(detection, frameMap, headQuat, headPos, timeSec, dt) {
    const { landmarks, worldLandmarks } = detection;
    if (!landmarks || landmarks.length < 21 || !worldLandmarks || worldLandmarks.length < 21) {
      this.markMissing();
      return this;
    }

    this.missingFrames = 0;
    this.handedness = detection.handedness || 'unknown';
    this.score = detection.score ?? 1;

    // --- 1. Smooth the 2D observations. These are the high-quality channel.
    for (let i = 0; i < 21; i++) {
      _u[i] = this._uFilters[i].filter(landmarks[i].x, timeSec);
      _v[i] = this._vFilters[i].filter(landmarks[i].y, timeSec);
    }

    // --- 2. Hand scale, straight from the metric model.
    this.handScale = Math.max(
      0.03,
      distance3(worldLandmarks[LM.WRIST], worldLandmarks[LM.MIDDLE_MCP]),
    );

    // --- 3. Fit rotation + distance.
    const fit = this._solvePose(worldLandmarks, frameMap);
    const rawDepth = fit ? fit.depth : this._fallbackDepth(worldLandmarks, frameMap);
    const smoothedDepth = this._depthFilter.filter(rawDepth, timeSec);
    this.depth = clamp(
      smoothedDepth * config.hands.depthScale,
      config.hands.minDepth,
      config.hands.maxDepth,
    );

    // --- 4. Lift every landmark onto its own pixel ray at its own depth.
    for (let i = 0; i < 21; i++) {
      const relative = fit ? fit.relativeZ[i] : 0;
      const d = clamp(this.depth - relative, 0.05, config.hands.maxDepth * 1.5);
      frameMap.unproject(_u[i], _v[i], d, this.viewLandmarks[i]);
      this.landmarks[i].copy(this.viewLandmarks[i]).applyQuaternion(headQuat).add(headPos);
    }

    this._updateFrame();
    this._updateGestures(worldLandmarks, dt);
    this._updateVelocity(dt);

    this.visible = true;
    return this;
  }

  /**
   * Pose from orthography and scaling with iterations (POSIT).
   *
   * The inner solve is a weak-perspective fit: find the 2x3 matrix `M` with
   * `m_i ~= M * P_i`, where `P_i` are centred metric model points and `m_i`
   * are centred image tangents. Least squares gives
   * `M = (sum m P^T)(sum P P^T)^-1`, whose rows are `scale * R.row0` and
   * `scale * R.row1` — so distance and rotation both fall out of one 3x3
   * inverse.
   *
   * Weak perspective alone pretends every point sits at the hand's centre
   * depth, which underestimates distance once the hand has real depth extent —
   * a hand tilted 55 degrees reads about 10% too close. The fix is to iterate:
   * the exact relation is `a_i * (1 - qz_i/depth) = (centroid + q_i)/depth`,
   * so scaling each observation by its own `1 - qz_i/depth` makes the system
   * linear again. Two or three passes converge.
   *
   * `B` depends only on the model, so it is built and inverted once and reused
   * across iterations.
   */
  _solvePose(world, frameMap) {
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(config.camera.verticalFovDeg) * 0.5);
    // `effectiveAspect`, not the raw decoded `videoAspect`: a 90/270 rotation
    // swaps which physical sensor axis ends up wide, and this fit needs the
    // *physical* geometry, not the raw decode.
    const effectiveAspect = frameMap.effectiveAspect;
    const n = FIT_INDICES.length;

    let px = 0, py = 0, pz = 0;
    for (const i of FIT_INDICES) {
      px += world[i].x; py += world[i].y; pz += world[i].z;
    }
    px /= n; py /= n; pz /= n;

    // Cache centred model points, physical-corrected image tangents, and unit
    // weights. Raw `_u/_v` alone would be exactly wrong the moment `rotation`
    // or `mirrorX` is anything but the identity: POSIT solves for a 3D
    // rotation from 2D *directions*, so unlike the position lift (which only
    // needs each landmark to land back on its own pixel, rotation or not),
    // this fit needs those directions expressed in the camera's true,
    // corrected orientation — and a mirrored raw frame is a reflection, which
    // no rotation this fit could solve for will ever explain correctly.
    let bxx = 0, bxy = 0, bxz = 0, byy = 0, byz = 0, bzz = 0;
    for (let k = 0; k < n; k++) {
      const i = FIT_INDICES[k];
      const qx = world[i].x - px;
      const qy = world[i].y - py;
      const qz = world[i].z - pz;
      _fitPx[k] = qx; _fitPy[k] = qy; _fitPz[k] = qz;
      frameMap.toEffectiveUV(_u[i], _v[i], _effUV);
      _fitAx[k] = (2 * _effUV.x - 1) * tanHalf * effectiveAspect;
      _fitAy[k] = (1 - 2 * _effUV.y) * tanHalf;
      _fitW[k] = 1;

      bxx += qx * qx; bxy += qx * qy; bxz += qx * qz;
      byy += qy * qy; byz += qy * qz; bzz += qz * qz;
    }

    const det =
      bxx * (byy * bzz - byz * byz) -
      bxy * (bxy * bzz - byz * bxz) +
      bxz * (bxy * byz - byy * bxz);

    // A near-singular B means the palm degenerated to a line in view; the fit
    // would amplify noise wildly, so bail to the crude estimate.
    const norm = bxx + byy + bzz;
    if (!Number.isFinite(det) || norm < 1e-9 || Math.abs(det) < 1e-12 * norm * norm * norm) {
      return null;
    }

    _matB.set(bxx, bxy, bxz, bxy, byy, byz, bxz, byz, bzz).invert();

    let depth = 0;
    let solved = false;

    for (let iter = 0; iter < POSIT_ITERATIONS; iter++) {
      let mx = 0, my = 0;
      for (let k = 0; k < n; k++) {
        mx += _fitAx[k] * _fitW[k];
        my += _fitAy[k] * _fitW[k];
      }
      mx /= n; my /= n;

      // A = sum m_i P_i^T, as two 3-vectors (one per image axis).
      let a1x = 0, a1y = 0, a1z = 0, a2x = 0, a2y = 0, a2z = 0;
      for (let k = 0; k < n; k++) {
        const bx = _fitAx[k] * _fitW[k] - mx;
        const by = _fitAy[k] * _fitW[k] - my;
        a1x += bx * _fitPx[k]; a1y += bx * _fitPy[k]; a1z += bx * _fitPz[k];
        a2x += by * _fitPx[k]; a2y += by * _fitPy[k]; a2z += by * _fitPz[k];
      }

      _row1.set(a1x, a1y, a1z).applyMatrix3(_matB);
      _row2.set(a2x, a2y, a2z).applyMatrix3(_matB);

      const scale = (_row1.length() + _row2.length()) * 0.5;
      if (!Number.isFinite(scale) || scale < 1e-6) break;

      // Re-orthonormalise into a proper rotation: Gram-Schmidt row2 against
      // row1, then the third row is forced. There is no sign to choose here —
      // negating it would make the matrix a reflection, mirroring the hand
      // rather than rotating it.
      _r1.copy(_row1).normalize();
      _r2.copy(_row2);
      _r2.addScaledVector(_r1, -_r2.dot(_r1));
      if (_r2.lengthSq() < 1e-8) break;
      _r2.normalize();
      _r3.crossVectors(_r1, _r2);

      depth = 1 / scale;
      solved = true;

      // Re-weight by each point's own depth for the next pass.
      for (let k = 0; k < n; k++) {
        const qz = _fitPx[k] * _r3.x + _fitPy[k] * _r3.y + _fitPz[k] * _r3.z;
        _fitW[k] = 1 - qz / depth;
      }
    }

    if (!solved) return null;

    for (let i = 0; i < 21; i++) {
      _relativeZ[i] =
        (world[i].x - px) * _r3.x + (world[i].y - py) * _r3.y + (world[i].z - pz) * _r3.z;
    }

    _fitResult.depth = depth;
    _fitResult.relativeZ = _relativeZ;
    return _fitResult;
  }

  /**
   * Crude backup: compare the palm's projected size against its metric size.
   * Only used when the full fit degenerates.
   */
  _fallbackDepth(world, frameMap) {
    const f = 1 / (2 * Math.tan(THREE.MathUtils.degToRad(config.camera.verticalFovDeg) * 0.5));
    const pairs = [
      [LM.WRIST, LM.MIDDLE_MCP],
      [LM.INDEX_MCP, LM.PINKY_MCP],
      [LM.WRIST, LM.INDEX_MCP],
      [LM.WRIST, LM.PINKY_MCP],
    ];
    const estimates = [];
    for (const [a, b] of pairs) {
      const du = (_u[a] - _u[b]) * frameMap.videoAspect;
      const dv = _v[a] - _v[b];
      const projected = Math.hypot(du, dv);
      if (projected < 1e-4) continue;
      estimates.push((f * distance3(world[a], world[b])) / projected);
    }
    if (!estimates.length) return this.depth;
    // Median: robust to the one or two bones that happen to be edge-on.
    estimates.sort((x, y) => x - y);
    const mid = estimates.length >> 1;
    return estimates.length % 2 ? estimates[mid] : (estimates[mid - 1] + estimates[mid]) * 0.5;
  }

  /** Build the grip frame the weapon will be mounted on. */
  _updateFrame() {
    const lm = this.landmarks;

    // Palm centre: where a handle naturally sits inside a closed fist.
    this.gripPoint
      .copy(lm[LM.WRIST])
      .add(lm[LM.INDEX_MCP])
      .add(lm[LM.MIDDLE_MCP])
      .add(lm[LM.RING_MCP])
      .add(lm[LM.PINKY_MCP])
      .multiplyScalar(0.2);

    // Forward runs wrist -> knuckles: make a fist and this is where a barrel
    // or blade points. True for either hand, so no handedness special case.
    this.forward.subVectors(lm[LM.MIDDLE_MCP], lm[LM.WRIST]).normalize();

    // The knuckle line runs pinky -> index, which is "up" for a normal grip
    // with the index finger above the pinky — again the same for both hands.
    _tmpA.subVectors(lm[LM.INDEX_MCP], lm[LM.PINKY_MCP]).normalize();

    // Orthogonalise against forward so the frame stays rigid.
    this.up.copy(_tmpA).addScaledVector(this.forward, -_tmpA.dot(this.forward));
    if (this.up.lengthSq() < 1e-8) this.up.set(0, 1, 0);
    this.up.normalize();
    this.right.crossVectors(this.forward, this.up).normalize();

    // Palm normal is only used for debug drawing; it is the one vector whose
    // sign genuinely depends on which hand this is.
    this.palmNormal.crossVectors(this.forward, _tmpA);
    if (this.handedness === 'Left') this.palmNormal.negate();
    if (this.palmNormal.lengthSq() > 1e-8) this.palmNormal.normalize();

    // three.js cameras/objects look down -Z, so the basis is (right, up, -fwd).
    _tmpB.copy(this.forward).negate();
    _mat4.makeBasis(this.right, this.up, _tmpB);
    this.orientation.setFromRotationMatrix(_mat4);

    this.pinchPoint.copy(lm[LM.THUMB_TIP]).add(lm[LM.INDEX_TIP]).multiplyScalar(0.5);
    this.indexTip.copy(lm[LM.INDEX_TIP]);
  }

  /**
   * Gestures are measured on the metric model rather than our reconstruction:
   * `worldLandmarks` are orientation-independent and free of our depth noise,
   * which makes thresholds behave the same at any distance or angle.
   */
  _updateGestures(world, dt) {
    const { pinchOn, pinchOff, triggerPullDeg, triggerReleaseDeg, debounceMs } = config.gestures;
    const dtMs = dt * 1000;

    // Pinch: thumb tip to index tip, normalised by the hand's own size.
    this.pinchRatio = distance3(world[LM.THUMB_TIP], world[LM.INDEX_TIP]) / this.handScale;
    const wantPinch = this.pinching
      ? this.pinchRatio < pinchOff   // hysteresis: stay pinched until clearly open
      : this.pinchRatio < pinchOn;
    this._pinchHold = wantPinch === this.pinching ? 0 : this._pinchHold + dtMs;
    if (this._pinchHold >= debounceMs) {
      this.pinching = wantPinch;
      this._pinchHold = 0;
    }

    // Trigger: the index finger's own bend, which is literally the gesture.
    this.indexCurlDeg = angleAt(
      _vecFrom(world[LM.INDEX_MCP], _tmpA),
      _vecFrom(world[LM.INDEX_PIP], _tmpB),
      _vecFrom(world[LM.INDEX_TIP], _tmpC),
    );
    const wantTrigger = this.triggerPulled
      ? this.indexCurlDeg < triggerReleaseDeg
      : this.indexCurlDeg < triggerPullDeg;
    this._triggerHold = wantTrigger === this.triggerPulled ? 0 : this._triggerHold + dtMs;
    if (this._triggerHold >= debounceMs) {
      this.triggerPulled = wantTrigger;
      this._triggerHold = 0;
    }

    // Pointing: index straight while the middle finger is folded away.
    const middleCurl = angleAt(
      _vecFrom(world[LM.MIDDLE_MCP], _tmpA),
      _vecFrom(world[LM.MIDDLE_PIP], _tmpB),
      _vecFrom(world[LM.MIDDLE_TIP], _tmpC),
    );
    this.pointing = this.indexCurlDeg > 150 && middleCurl < 130;
  }

  _updateVelocity(dt) {
    if (!this._hasPrev || dt <= 0) {
      this._prevPinch.copy(this.pinchPoint);
      this._hasPrev = true;
      this.velocity.set(0, 0, 0);
      return;
    }
    _tmpA.subVectors(this.pinchPoint, this._prevPinch).multiplyScalar(1 / dt);
    // Light smoothing: raw per-frame velocity is far too spiky to threshold on.
    this.velocity.lerp(_tmpA, 0.35);
    this._prevPinch.copy(this.pinchPoint);
  }
}

// ------------------------------------------------------------------ scratch

/** POSIT passes. The scale settles within two; a third costs almost nothing. */
const POSIT_ITERATIONS = 4;

const _u = new Float64Array(21);
const _v = new Float64Array(21);
const _effUV = { x: 0, y: 0 };
const _relativeZ = new Float64Array(21);
const _fitResult = { depth: 0, relativeZ: _relativeZ };

// Per-iteration working set, sized to the fit subset.
const _fitPx = new Float64Array(FIT_INDICES.length);
const _fitPy = new Float64Array(FIT_INDICES.length);
const _fitPz = new Float64Array(FIT_INDICES.length);
const _fitAx = new Float64Array(FIT_INDICES.length);
const _fitAy = new Float64Array(FIT_INDICES.length);
const _fitW = new Float64Array(FIT_INDICES.length);

const _matB = new THREE.Matrix3();
const _row1 = new THREE.Vector3();
const _row2 = new THREE.Vector3();
const _r1 = new THREE.Vector3();
const _r2 = new THREE.Vector3();
const _r3 = new THREE.Vector3();
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpC = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();

function distance3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function _vecFrom(p, out) {
  return out.set(p.x, p.y, p.z);
}

export default HandPose;
