import * as THREE from 'three';
import config from '../config.js';

/**
 * Owns the rear-camera `MediaStream` and exposes it two ways at once:
 *   - as a `THREE.VideoTexture` for the passthrough background, and
 *   - as the raw `<video>` element the hand tracker samples.
 *
 * One decode feeds both; there is no second capture.
 */
export class CameraFeed {
  constructor(videoElement) {
    this.video = videoElement;
    this.stream = null;
    this.texture = null;
    this.width = 0;
    this.height = 0;
    this.ready = false;
    /** Advances whenever a genuinely new frame has been decoded. */
    this.frameId = -1;
    this._lastTime = -1;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'This browser has no camera API. Open the page over HTTPS in Chrome or Safari.',
      );
    }

    const { facingMode, idealWidth, idealHeight, idealFrameRate } = config.camera;
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: idealWidth },
        height: { ideal: idealHeight },
        frameRate: { ideal: idealFrameRate },
      },
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // A device with no rear camera (most laptops) rejects the facingMode
      // constraint outright. Retry unconstrained rather than dead-ending.
      if (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError') {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      } else {
        throw CameraFeed.describeError(err);
      }
    }

    this.video.srcObject = this.stream;
    this.video.playsInline = true;
    this.video.muted = true;
    await this.video.play();
    await this._waitForDimensions();

    this.width = this.video.videoWidth;
    this.height = this.video.videoHeight;

    this.texture = new THREE.VideoTexture(this.video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    // Texture.flipY defaults to true (WebGL's texel origin is bottom-left;
    // three.js pre-flips on upload so "normal" top-left-origin UVs read the
    // image right-side up). StereoRenderer's background shader instead does
    // its own manual UV math in raw video-normalised space (v=0 at the top
    // of the decoded frame, matching MediaPipe's landmark convention exactly
    // so a rotated/mirrored stream stays in lockstep with hand tracking) —
    // against a flipY=true upload that convention samples upside down. This
    // is *the* "camera passthrough is upside down" bug: constant, present
    // for every device, and entirely invisible to MediaPipe (which reads the
    // raw <video> element directly and never touches this GPU-upload flag) —
    // which is exactly why hand tracking was never actually broken, only the
    // background was, and why routing the fix through frameMap.rotation
    // instead (a per-device correction meant for a genuinely rotated sensor)
    // dragged hand tracking into the same, unrelated correction.
    this.texture.flipY = false;

    this.ready = true;
    return this;
  }

  /**
   * `play()` can resolve before metadata lands, leaving videoWidth at 0 and
   * producing a zero-size texture. Poll briefly rather than trusting it.
   */
  _waitForDimensions(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const check = () => {
        if (this.video.videoWidth > 0 && this.video.videoHeight > 0) return resolve();
        if (performance.now() - started > timeoutMs) {
          return reject(new Error('The camera stream never reported a frame size.'));
        }
        requestAnimationFrame(check);
      };
      check();
    });
  }

  /**
   * Call once per render frame. Returns true when the decoder has produced a
   * frame we have not seen, so the tracker can skip redundant inference.
   */
  poll() {
    if (!this.ready) return false;
    const t = this.video.currentTime;
    if (t === this._lastTime) return false;
    this._lastTime = t;
    this.frameId++;
    return true;
  }

  /** Aspect ratio of the captured frame (width / height). */
  get aspect() {
    return this.height > 0 ? this.width / this.height : 1;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.texture?.dispose();
    this.stream = null;
    this.texture = null;
    this.ready = false;
  }

  /** Turn a getUserMedia rejection into something a user can act on. */
  static describeError(err) {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return new Error(
        'Camera access was denied.\n\n' +
        'Allow the camera for this site in your browser settings, then reload. ' +
        'On iOS: Settings > Safari > Camera > Allow.',
      );
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return new Error('No camera was found on this device.');
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return new Error(
        'The camera is busy. Close any other app or tab using it, then reload.',
      );
    }
    return new Error(`Could not start the camera: ${err?.message || err}`);
  }
}

export default CameraFeed;
