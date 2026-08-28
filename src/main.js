import * as THREE from 'three';
import config from './config.js';

import { CameraFeed } from './core/CameraFeed.js';
import { VideoFrameMap } from './core/VideoFrameMap.js';
import { HeadTracker } from './core/HeadTracker.js';
import { StereoRenderer } from './core/StereoRenderer.js';

import { HandTracker } from './hands/HandTracker.js';
import { HandSet } from './hands/HandSet.js';
import { PointerHand } from './hands/PointerHand.js';

import { WorldUI } from './ui/WorldUI.js';
import { Reticle } from './ui/Reticle.js';
import { Sound } from './fx/Sound.js';

import { StyleDirector, PresetSource } from './style/StyleDirector.js';
import { ClaudeStylist } from './style/ClaudeStylist.js';
import { STYLES } from './style/StyleLibrary.js';

const RELAY_KEY = 'ar-reskin-relay';
const APIKEY_KEY = 'ar-reskin-key';

/**
 * Read the Claude connection settings from the URL, remembering them.
 *
 * A phone in a headset shell is a miserable place to type a URL twice, so
 * whatever is passed once is kept for next time. The key path is deliberately
 * more awkward than the relay path — see `ClaudeStylist` for why a key in a
 * shared page is a key given away.
 */
function readAiSettings() {
  let params;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    params = new URLSearchParams('');
  }
  const store = (k, v) => {
    try {
      if (v) localStorage.setItem(k, v);
      return v || localStorage.getItem(k) || '';
    } catch {
      return v || '';
    }
  };
  return {
    endpoint: store(RELAY_KEY, params.get('relay')),
    directKey: store(APIKEY_KEY, params.get('key')),
  };
}

class ARReskin {
  constructor() {
    this.dom = {
      video: document.getElementById('camera-feed'),
      canvas: document.getElementById('view'),
      gate: document.getElementById('gate'),
      gateStart: document.getElementById('gate-start'),
      gateStereo: document.getElementById('gate-stereo'),
      gateError: document.getElementById('gate-error'),
      gateAi: document.getElementById('gate-ai'),
      loading: document.getElementById('loading'),
      loadingText: document.getElementById('loading-text'),
      rotateGate: document.getElementById('rotate-gate'),
      controls: document.getElementById('controls'),
      status: document.getElementById('status'),
      btnStereo: document.getElementById('btn-stereo'),
      btnRecenter: document.getElementById('btn-recenter'),
      btnFlipVideo: document.getElementById('btn-fliprot'),
      btnMirror: document.getElementById('btn-mirror'),
      btnTransform: document.getElementById('btn-transform'),
      debugOrientation: document.getElementById('debug-orientation'),
    };

    this.frameMap = new VideoFrameMap();
    this.cameraFeed = new CameraFeed(this.dom.video);
    this.head = new HeadTracker(this.dom.canvas);
    this.renderer = new StereoRenderer(this.dom.canvas, this.frameMap);

    // The scene holds only UI. The world itself is the camera image, repainted
    // in the background shader — there is no 3D stand-in for the room, which
    // is exactly why what you see stays lined up with what you can touch.
    this.scene = new THREE.Scene();

    this.handTracker = new HandTracker();
    this.handSet = new HandSet();
    this.pointerHand = new PointerHand(this.dom.canvas, this.frameMap);
    this.hands = this.handSet;

    this.ui = new WorldUI();
    this.scene.add(this.ui.group);

    this.reticle = new Reticle(config.ui.panelDistance);
    this.scene.add(this.reticle.group);

    this.sound = new Sound();

    this.ai = readAiSettings();
    this.claude = new ClaudeStylist({
      video: this.dom.video,
      endpoint: this.ai.endpoint,
      directKey: this.ai.directKey,
      maxWidth: config.reskin.frameMaxWidth,
    });
    this.presets = new PresetSource(STYLES);
    this.director = new StyleDirector({
      source: this.claude.configured ? this.claude : this.presets,
      storage: config.reskin.persist ? tryLocalStorage() : null,
      fadeSeconds: config.reskin.fadeSeconds,
    });

    this.running = false;
    this._lastFrameMs = 0;

    /** Quarter turns clockwise applied to the raw camera frame; see _setVideoRotation. */
    this.videoRotation = 0;
    /** Once true, stops the auto-heuristic from overriding the user's own choice. */
    this._videoRotationManual = false;

    /** True when stereo calibration mode is active. */
    this._stereoCalibrating = false;

    this._bindUI();
    this._updateFlipButton();
    this._updateMirrorButton();
    this._updateGateAiNote();
  }

  // ---------------------------------------------------------------- start-up

  _bindUI() {
    this.dom.gateStart.addEventListener('click', () => this.start());

    this.dom.btnStereo.addEventListener('click', () => {
      this._setStereo(!this.renderer.stereo);
    });

    this.dom.btnRecenter.addEventListener('click', () => {
      this.head.recenter();
      this.head.update();
      this.ui.recenter(this.head.position, this.head.quaternion);
    });

    this.dom.btnTransform.addEventListener('click', () => {
      this._onButton(this.director.active ? 'change' : 'transform');
    });

    this.dom.btnFlipVideo.addEventListener('click', () => {
      // A tap always takes over from the auto-guess: on the phones where the
      // guess lands on the wrong one of the two 90° directions, this is the
      // only way to actually fix it, and it should stick once chosen.
      this._videoRotationManual = true;
      this._setVideoRotation(this.videoRotation + 1);
    });

    this.dom.btnMirror.addEventListener('click', () => {
      // Rotation alone is a proper-rotation-only fix: no combination of 90°
      // turns can undo a reflection, so a camera feed that comes in mirrored
      // (seen as e.g. left/right swapped even once the rotation is right)
      // needs its own toggle rather than another tap of btn-fliprot.
      this.frameMap.mirrorX = !this.frameMap.mirrorX;
      this.renderer.syncFrameMap();
      this._updateMirrorButton();
    });

    window.addEventListener('resize', () => this._onResize());
    screen.orientation?.addEventListener?.('change', () => {
      // Give the browser a beat to settle the new viewport size.
      setTimeout(() => this._onResize(), 120);
    });
    // Entering/exiting fullscreen changes the canvas's available size too, and
    // doesn't reliably pair with a plain 'resize' event on every browser —
    // Android in particular can settle its system bars a beat after the
    // fullscreenchange event itself fires.
    document.addEventListener('fullscreenchange', () => {
      setTimeout(() => this._onResize(), 120);
    });

    document.addEventListener('visibilitychange', () => {
      // Coming back from background leaves a huge dt; treat it as a fresh start.
      if (!document.hidden) this._lastFrameMs = performance.now();
    });
  }

  /** Tell the player on the gate screen whether Claude is actually wired up. */
  _updateGateAiNote() {
    const el = this.dom.gateAi;
    if (!el) return;
    if (this.claude.configured) {
      el.textContent = this.ai.endpoint
        ? 'Claude will choose, via your relay.'
        : 'Claude will choose, using the key stored on this device.';
    } else {
      el.textContent = 'Choosing from built-in materials. Add a Claude relay to have it pick for your actual room.';
    }
  }

  /**
   * Opt-in (config.debug.showOrientationInfo, or `?debug=1`) readout of raw
   * device-orientation sensor values and the derived screen-angle
   * compensation. Plain DOM, so — unlike the 3D scene a head-tracking bug
   * would tilt — this stays level and legible in a screenshot regardless of
   * whether that math is currently right or wrong, which is the point: it
   * turns "still looks tilted" into actual numbers to diagnose from.
   */
  _updateOrientationDebug(nowMs) {
    const el = this.dom.debugOrientation;
    if (!config.debug.showOrientationInfo) {
      if (!el.hidden) el.hidden = true;
      return;
    }
    if (el.hidden) el.hidden = false;
    // Text nodes are cheap but not free; a human reads this, not a frame budget.
    if (nowMs - (this._lastDebugUpdateMs || 0) < 150) return;
    this._lastDebugUpdateMs = nowMs;

    const d = this.head.getDebugInfo();
    const fmt = (n) => (Number.isFinite(n) ? n.toFixed(1) : 'n/a');
    const r = this.renderer;
    const bufW = Math.round(r.size.x);
    const bufH = Math.round(r.size.y);
    const eyeW = r.stereo ? Math.round(bufW / 2) : bufW;
    el.textContent =
      `sensor: ${d.hasSensor ? 'yes' : 'no'}  pointerFallback: ${d.usingPointerFallback}\n` +
      `alpha ${fmt(d.alphaDeg)}  beta ${fmt(d.betaDeg)}  gamma ${fmt(d.gammaDeg)}\n` +
      `orientation.angle: ${fmt(d.reportedAngleDeg)}  type: ${d.orientationType}\n` +
      `screenAngle (used): ${fmt(d.screenAngleDeg)}\n` +
      `innerWidth x innerHeight: ${window.innerWidth} x ${window.innerHeight}\n` +
      `stereo: ${r.stereo}   drawBuffer: ${bufW}x${bufH}\n` +
      `per-eye viewport: ${eyeW}x${bufH}   eyeAspect: ${fmt(r.eyeAspect)}\n` +
      `style: ${this.director.displayName}  source: ${this.director.source.name}`;
  }

  _onResize() {
    // Re-read video dimensions defensively: some browsers renegotiate the
    // stream's reported orientation as the device rotates, and a stale
    // videoAspect here is exactly what turns cover-fit into an extreme,
    // disorienting crop.
    if (this.cameraFeed.ready) {
      this.frameMap.setVideoAspect(this.cameraFeed.aspect);
    }
    this.renderer.resize();
    this._autoDetectVideoRotation();
    this.renderer.syncFrameMap();
    this.pointerHand.setStereo(this.renderer.stereo);
    this._updateOrientationGate();
    // Re-validate the head-tracking screen-angle compensation against
    // whatever the CSS layout actually is right now. `screen.orientation`'s
    // own 'change' event is the primary trigger for this, but it does not
    // fire reliably after every route into landscape (fullscreen + lock in
    // particular) — this is the second, resize-driven path that catches it
    // whenever the layout itself changes for any reason.
    this.head.refreshScreenAngle?.();
  }

  /**
   * Best-effort guess at whether the raw camera frame needs a 90° correction.
   *
   * Some browsers capture a stream once, while the phone is still held
   * however it was when the camera permission was granted (normally,
   * portrait), and keep delivering frames in that orientation even after the
   * phone is physically turned on its side for the headset — the video
   * itself never rotates, only the screen does. There is no API that reports
   * this directly, so the heuristic is: once the screen is confirmed
   * landscape (past the rotate gate), a raw video frame that is still
   * portrait-shaped is almost certainly one of these frozen streams.
   *
   * This can only pick a shape match, not a direction — a 90° and a -90°
   * frame look identically "sideways" from the aspect ratio alone, and a
   * frame that is landscape-shaped but upside down (180° off) is
   * indistinguishable from a correct one by shape at all, so that case is
   * never auto-corrected either way. It defaults to a clockwise turn;
   * `btn-fliprot` is the guaranteed fix on whichever of these the guess gets
   * wrong — tap it repeatedly to step through 0/90/180/270° — and once
   * tapped this stops overriding the player's own choice.
   */
  _autoDetectVideoRotation() {
    if (this._videoRotationManual || !this.cameraFeed.ready) return;
    const screenLandscape = window.innerWidth > window.innerHeight;
    if (!screenLandscape) return; // no reliable signal until past the rotate gate
    const videoLandscape = this.cameraFeed.aspect >= 1;
    this._setVideoRotation(videoLandscape ? 0 : 1);
  }

  _setVideoRotation(quarterTurnsClockwise) {
    this.videoRotation = ((Math.round(quarterTurnsClockwise) % 4) + 4) % 4;
    this.frameMap.setRotation(this.videoRotation);
    this.renderer.syncFrameMap();
    this._updateFlipButton();
  }

  /**
   * Keep the flip button's label/title in sync with the actual correction
   * applied. The auto-guess can only tell "sideways" from "already
   * landscape-shaped" — a landscape stream that is upside down (180°) looks
   * identically landscape-shaped and is indistinguishable from correct by
   * aspect ratio alone, so it is never auto-corrected. A static "90°" label
   * only advertises a single 90° nudge, which does nothing useful from that
   * state — showing the degrees actually applied, and inviting further taps,
   * is what makes "keep tapping" discoverable for the 180° case too.
   */
  _updateFlipButton() {
    const deg = this.videoRotation * 90;
    this.dom.btnFlipVideo.textContent = `${deg}°`;
    this.dom.btnFlipVideo.title =
      `Camera view sideways or upside down? Tap to rotate it another 90° ` +
      `(currently ${deg}° — keep tapping until it looks right).`;
  }

  /** Keep the mirror button's on/off indication in sync with `frameMap.mirrorX`. */
  _updateMirrorButton() {
    const on = this.frameMap.mirrorX;
    this.dom.btnMirror.classList.toggle('on', on);
    this.dom.btnMirror.title = on
      ? 'Camera view mirrored to fix left/right. Tap to undo.'
      : 'Left and right still swapped after rotating? Tap to mirror the camera view.';
  }

  /**
   * The camera feed is landscape and the app only makes sense held the same
   * way the headset shell holds it — landscape. Cover-fitting a landscape
   * video onto a portrait screen crops it down to a sliver, which reads as
   * "the camera is broken" rather than "turn the phone". Block on that
   * explicitly instead of rendering the crop.
   */
  _updateOrientationGate() {
    if (!this.running) return;
    const portrait = window.innerHeight > window.innerWidth;
    this.dom.rotateGate.hidden = !portrait;
  }

  _setStereo(on) {
    this.renderer.setStereo(on);
    this.renderer.syncFrameMap();
    this.pointerHand.setStereo(on);
    this.dom.status.hidden = on || !this._statusText;
  }

  /**
   * Best-effort: go fullscreen and lock the screen to landscape.
   *
   * The Orientation Lock API only works inside a fullscreen element on
   * browsers that implement it at all (mainly Chromium-based Android
   * browsers) — Fullscreen has to be requested and settled first, or the
   * lock call rejects outright. iOS Safari does not implement orientation
   * locking for web content under any circumstances (an Apple platform
   * policy, not a bug here), so on iPhone this silently does nothing and the
   * rotate-gate plus the phone's own rotation-lock toggle are the only path.
   */
  async _tryForceLandscape() {
    try {
      const el = document.documentElement;
      if (el.requestFullscreen && !document.fullscreenElement) {
        await el.requestFullscreen({ navigationUI: 'hide' });
      }
      await screen.orientation?.lock?.('landscape');
    } catch (err) {
      console.info('[AR-Reskin] Could not force landscape (falling back to manual rotation):', err?.message || err);
    }
  }

  async start() {
    this.dom.gateStart.disabled = true;
    this.dom.gateError.hidden = true;

    // Fired first and not awaited: Fullscreen + Orientation Lock both need a
    // fresh user gesture, which this click is, and every await below spends a
    // little of that window.
    this._tryForceLandscape();

    try {
      this.sound.init();

      // Both permissions must be asked for inside this user gesture's window.
      const motionPromise = HeadTracker.requestPermission();

      this._setLoading('Starting camera…');
      this.dom.gate.hidden = true;
      this.dom.loading.hidden = false;

      await this.cameraFeed.start();

      this.frameMap.setVideoAspect(this.cameraFeed.aspect);
      const track = this.cameraFeed.stream.getVideoTracks()[0];
      const facing = track?.getSettings?.().facingMode;
      // A user-facing camera reads mirrored; keep the mapping honest.
      this.frameMap.mirrorX = facing === 'user';
      this._updateMirrorButton();

      this.renderer.setVideoTexture(this.cameraFeed.texture, {
        mirrored: this.frameMap.mirrorX,
        width: this.cameraFeed.width,
        height: this.cameraFeed.height,
      });
      this._setStereo(this.dom.gateStereo.checked);
      this._onResize();

      await motionPromise;
      this.head.start();

      this._setLoading('Loading hand tracking…');
      const ok = await this.handTracker.load((msg) => this._setLoading(msg));
      if (!ok) {
        // Hands are only ever an input device here, never the subject — so
        // losing them costs a nicer way to press buttons, not the app.
        this.hands = this.pointerHand;
        this.pointerHand.setStereo(this.renderer.stereo);
        console.warn('[AR-Reskin] Hand tracking unavailable; using pointer/gaze input.');
      }

      this.dom.loading.hidden = true;
      this.dom.controls.hidden = false;

      this.running = true;
      this._lastFrameMs = performance.now();
      this.head.update();
      this.ui.recenter(this.head.position, this.head.quaternion);
      this._updateOrientationGate();
      this._loadStereoCalibration();

      // A style restored from a previous session is already in the director;
      // reflect it in the UI rather than claiming the world is untouched.
      this._refreshUI();

      requestAnimationFrame((t) => this._loop(t));
    } catch (err) {
      console.error('[AR-Reskin] Startup failed:', err);
      this.dom.loading.hidden = true;
      this.dom.gate.hidden = false;
      this.dom.gateStart.disabled = false;
      this.dom.gateError.textContent = err?.message || String(err);
      this.dom.gateError.hidden = false;
    }
  }

  _setLoading(text) {
    this.dom.loadingText.textContent = text;
  }

  // -------------------------------------------------------------- main loop

  _loop(nowMs) {
    if (!this.running) return;
    requestAnimationFrame((t) => this._loop(t));

    const dt = Math.min(0.1, Math.max(1e-4, (nowMs - this._lastFrameMs) / 1000));
    this._lastFrameMs = nowMs;
    const timeSec = nowMs / 1000;

    this.head.update(timeSec);
    this._updateOrientationDebug(nowMs);

    const hasNewFrame = this.cameraFeed.poll();
    if (this.handTracker.available) {
      const result = this.handTracker.detect(this.cameraFeed.video, nowMs, hasNewFrame);
      this.handSet.update(
        result, this.frameMap, this.head.quaternion, this.head.position, timeSec, dt,
      );
    } else {
      this.pointerHand.update(
        null, this.frameMap, this.head.quaternion, this.head.position, timeSec, dt,
      );
    }

    const activated = this.ui.update(
      dt, this.head.position, this.head.quaternion, this.hands.hands,
    );
    if (activated) this._onButton(activated);

    // The only thing that advances the look — and it can only ever advance a
    // cross-fade that an explicit button press started. Nothing about where
    // the head is pointing reaches the director, which is what makes a room
    // stay put when you look away and back.
    this.renderer.setStyle(this.director.update(dt));

    this.renderer.updateCameras(this.head.position, this.head.quaternion);
    this.reticle.update(this.head.position, this.head.quaternion, this.ui.dwellProgress);
    this.reticle.setVisible(this.ui.visible && this.ui.buttons.length > 0);

    this.renderer.render(this.scene);
  }

  // ------------------------------------------------------------------- UI

  /** Prompt + button row, derived entirely from the director's state. */
  _refreshUI() {
    const d = this.director;

    if (this._stereoCalibrating) return this._refreshStereoCalibration();

    if (d.pending) {
      this.ui.setPrompt('Looking at your room…', 'Deciding what everything should be made of.');
      this.ui.setButtons([]);
      this._syncStatusFromUI();
      this._syncTransformButton();
      return;
    }

    if (d.lastError) {
      this.ui.setPrompt('Could not reach Claude', `${d.lastError.message} Using a built-in material instead.`, 'error');
    } else if (d.active) {
      this.ui.setPrompt(d.target.name, d.target.blurb, 'success');
    } else {
      this.ui.setPrompt(
        'Your room, as it is',
        'Transform it and everything you can see becomes another material — but stays exactly where it is, so you can still reach out and touch it.',
      );
    }

    this.ui.setButtons(d.active
      ? [
        { id: 'change', label: 'Change', hint: 'something else', accent: 0x8bf5a0, width: 0.32 },
        { id: 'off', label: 'Off', hint: 'back to real', width: 0.26 },
        { id: 'calibrate-stereo', label: 'Lenses', hint: 'tune', width: 0.28 },
      ]
      : [
        { id: 'transform', label: 'Transform', hint: 'change everything', accent: 0x8bf5a0, width: 0.38 },
        { id: 'calibrate-stereo', label: 'Lenses', hint: 'tune', width: 0.28 },
      ]);

    this._syncStatusFromUI();
    this._syncTransformButton();
  }

  /** The DOM shortcut, for when you are holding the phone rather than wearing it. */
  _syncTransformButton() {
    const btn = this.dom.btnTransform;
    if (!btn) return;
    btn.disabled = this.director.pending;
    btn.textContent = this.director.pending ? '…' : (this.director.active ? '⟳' : '✦');
    btn.title = this.director.active
      ? 'Change to a different material'
      : 'Transform everything you can see';
  }

  async _transform({ change }) {
    this._refreshUI();
    this._syncTransformButton();
    try {
      await (change ? this.director.next() : this.director.transform());
      this.sound.confirm();
    } catch {
      // Claude was configured but unreachable. Falling back keeps the app
      // usable offline rather than leaving the room stuck as it was, and
      // `lastError` is what surfaces the reason in the prompt.
      const err = this.director.lastError;
      this.director.source = this.presets;
      try {
        await (change ? this.director.next() : this.director.transform());
      } catch {
        // Presets cannot realistically fail; if they somehow do there is
        // nothing further to try.
      }
      this.director.source = this.claude.configured ? this.claude : this.presets;
      this.director.lastError = err;
      this.sound.cancel();
    }
    this._refreshUI();
  }

  _onButton(id) {
    switch (id) {
      case 'transform':
        this.sound.tick();
        this._transform({ change: false });
        break;

      case 'change':
        this.sound.tick();
        this._transform({ change: true });
        break;

      case 'off':
        this.sound.cancel();
        this.director.off();
        this._refreshUI();
        break;

      case 'calibrate-stereo':
        this.sound.tick();
        this._enterStereoCalibration();
        break;

      case 'stereo-ipd-minus':
        this.sound.tick();
        this.renderer.setIPD(this.renderer.getStereoCal().ipd - 0.001);
        this._refreshStereoCalibration();
        break;

      case 'stereo-ipd-plus':
        this.sound.tick();
        this.renderer.setIPD(this.renderer.getStereoCal().ipd + 0.001);
        this._refreshStereoCalibration();
        break;

      case 'stereo-offset-minus':
        this.sound.tick();
        this.renderer.setLensCenterOffset(this.renderer.getStereoCal().lensCenterOffset - 0.005);
        this._refreshStereoCalibration();
        break;

      case 'stereo-offset-plus':
        this.sound.tick();
        this.renderer.setLensCenterOffset(this.renderer.getStereoCal().lensCenterOffset + 0.005);
        this._refreshStereoCalibration();
        break;

      case 'stereo-cal-save':
        this.sound.confirm();
        this._saveStereoCalibration();
        break;

      case 'stereo-cal-cancel':
        this.sound.cancel();
        this._exitStereoCalibration();
        break;

      default:
        break;
    }
  }

  // ------------------------------------------------------- lens calibration

  _loadStereoCalibration() {
    try {
      const saved = localStorage.getItem('ar-reskin-stereo-cal');
      if (saved) {
        const cal = JSON.parse(saved);
        this.renderer.setIPD(cal.ipd);
        this.renderer.setLensCenterOffset(cal.lensCenterOffset);
      }
    } catch (e) {
      console.warn('[AR-Reskin] Could not load lens calibration:', e);
    }
  }

  _enterStereoCalibration() {
    this._stereoCalibrating = true;
    this._stereoCalBackup = this.renderer.getStereoCal();
    this._refreshStereoCalibration();
  }

  _refreshStereoCalibration() {
    const cal = this.renderer.getStereoCal();
    const ipdMm = Math.round(cal.ipd * 1000);
    const offsetPct = Math.round(cal.lensCenterOffset * 100);
    this.ui.setPrompt(
      'Lens calibration',
      `IPD ${ipdMm}mm · Offset ${offsetPct}% — adjust until the two images fuse into one.`,
    );
    this.ui.setButtons([
      { id: 'stereo-ipd-minus', label: '−', hint: 'IPD', width: 0.15 },
      { id: 'stereo-ipd-plus', label: '+', hint: 'IPD', width: 0.15 },
      { id: 'stereo-offset-minus', label: '−', hint: 'Offset', width: 0.15 },
      { id: 'stereo-offset-plus', label: '+', hint: 'Offset', width: 0.15 },
      { id: 'stereo-cal-save', label: 'Save', width: 0.22 },
      { id: 'stereo-cal-cancel', label: 'Cancel', width: 0.24 },
    ]);
    this._syncStatusFromUI();
  }

  _saveStereoCalibration() {
    try {
      localStorage.setItem('ar-reskin-stereo-cal', JSON.stringify(this.renderer.getStereoCal()));
    } catch (e) {
      console.warn('[AR-Reskin] Could not save lens calibration:', e);
    }
    this._stereoCalBackup = null;
    this._exitStereoCalibration();
  }

  _exitStereoCalibration() {
    // Cancel restores what was in effect on entry, so experimenting with the
    // sliders can't leave the view worse than it started.
    if (this._stereoCalBackup) {
      this.renderer.setIPD(this._stereoCalBackup.ipd);
      this.renderer.setLensCenterOffset(this._stereoCalBackup.lensCenterOffset);
      this._stereoCalBackup = null;
    }
    this._stereoCalibrating = false;
    this._refreshUI();
  }

  // -------------------------------------------------------------- status line

  _syncStatusFromUI() {
    const title = this.ui.prompt.title;
    const detail = this.ui.prompt.detail;
    this._statusText = detail ? `${title} — ${detail}` : title;
    this.dom.status.textContent = this._statusText;
    this.dom.status.hidden = this.renderer.stereo || !this._statusText;
  }
}

/** localStorage throws outright in some privacy modes; probe once, up front. */
function tryLocalStorage() {
  try {
    const probe = '__ar_reskin_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

// Surface module-level failures on the gate rather than leaving a black screen.
try {
  const app = new ARReskin();
  window.ARRESKIN = app;
} catch (err) {
  console.error('[AR-Reskin] Failed to initialise:', err);
  const gateError = document.getElementById('gate-error');
  if (gateError) {
    gateError.textContent = `Could not start: ${err?.message || err}`;
    gateError.hidden = false;
  }
}
