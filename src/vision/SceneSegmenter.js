import * as THREE from 'three';
import config from '../config.js';
import { CLASSES } from '../style/Theme.js';
import { assetUrl } from '../util/assetUrl.js';

/**
 * Works out what each pixel of the camera view actually *is*.
 *
 * This is what separates repainting a room from applying a filter. DeepLab-v3
 * labels every pixel with one of 21 classes, and the ones that matter here are
 * the furniture: chair, sofa, tv, dining table, potted plant, person. The
 * result is uploaded as a mask texture the shader reads alongside the video,
 * so each object can be painted as something different.
 *
 * Two deliberate choices about cost:
 *
 * Segmentation runs on a throttle, not every frame. It is by far the most
 * expensive thing in the app, and rooms hold still — re-labelling at 60Hz
 * would spend most of the frame budget confirming the sofa is still a sofa.
 *
 * The mask is uploaded at the model's own output resolution rather than the
 * camera's. It is a low-frequency thing (large blobs, no fine detail), so a
 * larger upload would cost bandwidth for no visible gain, and the GPU's
 * bilinear filter softens the class boundaries slightly on the way out —
 * which happens to look better than hard stair-stepped edges anyway.
 *
 * Failure is never fatal: if the model cannot load, `available` stays false
 * and the app falls back to painting the whole view with the theme's base
 * material — exactly what it did before object awareness existed.
 */
export class SceneSegmenter {
  constructor() {
    this.segmenter = null;
    this.available = false;
    this.lastError = null;
    /** Class index per mask pixel, as a texture the shader samples. */
    this.maskTexture = null;
    this.maskWidth = 0;
    this.maskHeight = 0;
    /** Set of class names seen in the most recent mask, for the UI to report. */
    this.detected = new Set();

    this._loading = null;
    this._lastRunMs = -Infinity;
    this._lastTimestamp = -1;
    this._data = null;
  }

  /** @param {(msg: string) => void} [onProgress] @returns {Promise<boolean>} */
  async load(onProgress) {
    if (this._loading) return this._loading;
    this._loading = this._load(onProgress);
    return this._loading;
  }

  async _load(onProgress) {
    const { source, cdnBase, cdnSegmenterUrl } = config.hands;
    // Pinned to the page up front, so the HEAD probe below and the dynamic
    // import further down are talking about the same file. See assetUrl.js.
    const localBase = assetUrl(config.hands.localBase);
    const localSegmenterUrl = assetUrl(config.hands.localSegmenterUrl);
    const probe = async (url) => {
      try {
        return (await fetch(url, { method: 'HEAD' })).ok;
      } catch {
        return false;
      }
    };

    let base = cdnBase;
    let model = cdnSegmenterUrl;
    if (source !== 'cdn') {
      const [hasRuntime, hasModel] = await Promise.all([
        probe(`${localBase}/vision_bundle.mjs`),
        probe(localSegmenterUrl),
      ]);
      if (hasRuntime && hasModel) {
        base = localBase;
        model = localSegmenterUrl;
      } else if (source === 'local') {
        this.lastError = new Error('Local segmentation model not found (run `npm run fetch-deps`).');
        return false;
      }
    }

    for (const delegate of ['GPU', 'CPU']) {
      try {
        onProgress?.(delegate === 'GPU' ? 'Loading scene understanding…' : 'Retrying scene understanding on CPU…');
        const vision = await import(/* @vite-ignore */ `${base}/vision_bundle.mjs`);
        const fileset = await vision.FilesetResolver.forVisionTasks(`${base}/wasm`);
        this.segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: model, delegate },
          runningMode: 'VIDEO',
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        });

        // The class list is baked into the model, and `Theme.CLASSES` has to
        // agree with it or every object would be painted as the wrong thing.
        // Cheap to verify once, and silent corruption is the alternative.
        const labels = this.segmenter.getLabels?.() || [];
        if (labels.length && labels.length !== CLASSES.length) {
          console.warn(
            `[Remade] Segmentation model has ${labels.length} classes but Theme.CLASSES has `
            + `${CLASSES.length}. Object styling will be misaligned.`, labels,
          );
        }

        this.available = true;
        return true;
      } catch (err) {
        this.lastError = err;
        if (delegate === 'CPU') {
          console.warn('[Remade] Scene understanding unavailable:', err);
          this.available = false;
          return false;
        }
      }
    }
    return false;
  }

  /**
   * Re-label the frame if the throttle allows.
   * @returns {boolean} whether the mask was refreshed this call.
   */
  update(video, nowMs, hasNewFrame) {
    if (!this.available || !this.segmenter || !hasNewFrame) return false;
    if (nowMs - this._lastRunMs < config.segmentation.intervalMs) return false;

    // MediaPipe requires strictly increasing timestamps in VIDEO mode.
    const timestamp = Math.max(this._lastTimestamp + 1, Math.floor(nowMs));
    this._lastTimestamp = timestamp;
    this._lastRunMs = nowMs;

    try {
      const result = this.segmenter.segmentForVideo(video, timestamp);
      const mask = result?.categoryMask;
      if (mask) {
        this._ingest(mask);
        // MPMask holds a GPU/WASM resource; without this the app leaks a
        // buffer per segmentation, which at a few Hz is minutes to a crash.
        mask.close();
      }
      result?.close?.();
      return Boolean(mask);
    } catch (err) {
      console.warn('[Remade] Segmentation failed:', err);
      return false;
    }
  }

  _ingest(mask) {
    const w = mask.width;
    const h = mask.height;
    const src = mask.getAsUint8Array();

    if (!this.maskTexture || this.maskWidth !== w || this.maskHeight !== h) {
      this.maskTexture?.dispose();
      this._data = new Uint8Array(w * h);
      this.maskTexture = new THREE.DataTexture(this._data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
      // Linear across the class *index* would interpolate class 9 and 11 into
      // a nonexistent class 10, so this must stay nearest. The softening the
      // class-id lookup needs is done in the shader instead.
      this.maskTexture.minFilter = THREE.NearestFilter;
      this.maskTexture.magFilter = THREE.NearestFilter;
      this.maskTexture.wrapS = THREE.ClampToEdgeWrapping;
      this.maskTexture.wrapT = THREE.ClampToEdgeWrapping;
      this.maskTexture.generateMipmaps = false;
      this.maskWidth = w;
      this.maskHeight = h;
    }

    this._data.set(src.subarray(0, this._data.length));
    this.maskTexture.needsUpdate = true;

    this.detected.clear();
    for (let i = 0; i < this._data.length; i += 7) {   // sparse scan: this is only for the UI label
      const c = this._data[i];
      if (c > 0 && c < CLASSES.length) this.detected.add(CLASSES[c]);
    }
  }

  close() {
    try {
      this.segmenter?.close();
    } catch {
      /* already torn down */
    }
    this.segmenter = null;
    this.available = false;
    this.maskTexture?.dispose();
    this.maskTexture = null;
  }
}

export default SceneSegmenter;
