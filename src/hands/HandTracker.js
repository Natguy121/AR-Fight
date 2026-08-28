import config from '../config.js';
import { assetUrl } from '../util/assetUrl.js';

/**
 * Thin wrapper over MediaPipe's `HandLandmarker`.
 *
 * Responsibilities kept deliberately narrow: load the runtime (locally
 * vendored if present, CDN otherwise), run inference on a throttle, and hand
 * back raw results. All interpretation lives in HandPose.
 *
 * Failure here is never fatal — `available` goes false and the app falls back
 * to pointer input, so a phone with no WASM support still runs.
 */
export class HandTracker {
  constructor() {
    this.landmarker = null;
    this.available = false;
    this.lastResult = null;
    this.lastError = null;
    this._lastInferenceMs = -Infinity;
    this._lastTimestamp = -1;
    this._loading = null;
  }

  /**
   * Probe for the locally vendored runtime so `npm run fetch-deps` is picked up
   * with no config change. A HEAD request keeps this cheap.
   */
  static async _resolveSource(onProgress) {
    const { source, cdnBase, cdnModelUrl } = config.hands;
    // Pinned to the page, not to this module — the probe below uses `fetch`
    // and the loader uses `import`, which resolve relative paths against
    // different bases. See assetUrl.js.
    const localBase = assetUrl(config.hands.localBase);
    const localModelUrl = assetUrl(config.hands.localModelUrl);

    const probe = async (url) => {
      try {
        const res = await fetch(url, { method: 'HEAD' });
        return res.ok;
      } catch {
        return false;
      }
    };

    if (source === 'cdn') return { base: cdnBase, model: cdnModelUrl, local: false };
    if (source === 'local') return { base: localBase, model: localModelUrl, local: true };

    onProgress?.('Looking for local tracking model…');
    const [hasRuntime, hasModel] = await Promise.all([
      probe(`${localBase}/vision_bundle.mjs`),
      probe(localModelUrl),
    ]);
    if (hasRuntime && hasModel) return { base: localBase, model: localModelUrl, local: true };
    return { base: cdnBase, model: cdnModelUrl, local: false };
  }

  /**
   * @param {(msg: string) => void} [onProgress]
   * @returns {Promise<boolean>} whether tracking is usable.
   */
  async load(onProgress) {
    if (this._loading) return this._loading;
    this._loading = this._load(onProgress);
    return this._loading;
  }

  async _load(onProgress) {
    try {
      const src = await HandTracker._resolveSource(onProgress);

      onProgress?.(
        src.local ? 'Loading hand tracking (local)…' : 'Downloading hand tracking…',
      );

      // Dynamic import so a CDN failure surfaces as a caught error rather than
      // a hard module-resolution failure at page load.
      const vision = await import(/* @vite-ignore */ `${src.base}/vision_bundle.mjs`);
      const { HandLandmarker, FilesetResolver } = vision;

      const fileset = await FilesetResolver.forVisionTasks(`${src.base}/wasm`);

      onProgress?.('Preparing hand tracking…');
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: src.model,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: config.hands.numHands,
        minHandDetectionConfidence: config.hands.minHandDetectionConfidence,
        minHandPresenceConfidence: config.hands.minHandPresenceConfidence,
        minTrackingConfidence: config.hands.minTrackingConfidence,
      });

      this.available = true;
      return true;
    } catch (err) {
      // GPU delegate is unavailable on some older devices; CPU still works.
      if (!this._triedCpu && /delegate|gpu|webgl/i.test(String(err?.message))) {
        this._triedCpu = true;
        return this._loadCpuFallback(onProgress);
      }
      this.lastError = err;
      this.available = false;
      console.warn('[Remade] Hand tracking unavailable:', err);
      return false;
    }
  }

  async _loadCpuFallback(onProgress) {
    try {
      onProgress?.('Retrying hand tracking on CPU…');
      const src = await HandTracker._resolveSource();
      const vision = await import(/* @vite-ignore */ `${src.base}/vision_bundle.mjs`);
      const { HandLandmarker, FilesetResolver } = vision;
      const fileset = await FilesetResolver.forVisionTasks(`${src.base}/wasm`);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: src.model, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: config.hands.numHands,
        minHandDetectionConfidence: config.hands.minHandDetectionConfidence,
        minHandPresenceConfidence: config.hands.minHandPresenceConfidence,
        minTrackingConfidence: config.hands.minTrackingConfidence,
      });
      this.available = true;
      return true;
    } catch (err) {
      this.lastError = err;
      this.available = false;
      console.warn('[Remade] Hand tracking unavailable (CPU fallback failed):', err);
      return false;
    }
  }

  /**
   * Run inference if the throttle allows and a new frame is available.
   *
   * @param {HTMLVideoElement} video
   * @param {number} nowMs
   * @param {boolean} hasNewFrame
   * @returns {object|null} The freshest result, or null if tracking is off.
   */
  detect(video, nowMs, hasNewFrame) {
    if (!this.available || !this.landmarker) return null;
    if (!hasNewFrame) return this.lastResult;
    if (nowMs - this._lastInferenceMs < config.hands.detectionIntervalMs) return this.lastResult;

    // MediaPipe requires strictly increasing timestamps in VIDEO mode.
    const timestamp = Math.max(this._lastTimestamp + 1, Math.floor(nowMs));
    this._lastTimestamp = timestamp;
    this._lastInferenceMs = nowMs;

    try {
      this.lastResult = this.landmarker.detectForVideo(video, timestamp);
    } catch (err) {
      console.warn('[Remade] Hand inference failed:', err);
      this.lastResult = null;
    }
    return this.lastResult;
  }

  close() {
    try {
      this.landmarker?.close();
    } catch {
      /* already torn down */
    }
    this.landmarker = null;
    this.available = false;
  }
}

/** Landmark indices, named. MediaPipe's ordering is fixed and documented. */
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
};

/** Bone pairs, for drawing the debug skeleton. */
export const HAND_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export default HandTracker;
