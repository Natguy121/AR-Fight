import * as THREE from 'three';
import config from './config.js';

import { CameraFeed } from './core/CameraFeed.js';
import { VideoFrameMap } from './core/VideoFrameMap.js';
import { HeadTracker } from './core/HeadTracker.js';
import { StereoRenderer } from './core/StereoRenderer.js';
import { State, StateMachine } from './core/AppState.js';

import { HandTracker } from './hands/HandTracker.js';
import { HandSet } from './hands/HandSet.js';
import { PointerHand } from './hands/PointerHand.js';

import { DrawingSession } from './draw/DrawingSession.js';
import { Weapon } from './weapon/Weapon.js';
import { WeaponRig } from './weapon/WeaponRig.js';
import { GunBehavior } from './weapon/GunBehavior.js';
import { MeleeBehavior } from './weapon/MeleeBehavior.js';

import { WorldUI } from './ui/WorldUI.js';
import { Reticle } from './ui/Reticle.js';
import { HandCursor } from './ui/HandCursor.js';

import { Environment } from './scene/Environment.js';
import { TargetField } from './fx/Targets.js';
import { Projectiles } from './fx/Projectiles.js';
import { MuzzleFlash, ImpactBursts, SwingTrail } from './fx/Effects.js';
import { Sound } from './fx/Sound.js';

/** Distance we assume a comfortably outstretched hand sits at, for calibration. */
const CALIBRATION_DISTANCE = 0.45;

class ARFight {
  constructor() {
    this.dom = {
      video: document.getElementById('camera-feed'),
      canvas: document.getElementById('view'),
      gate: document.getElementById('gate'),
      gateStart: document.getElementById('gate-start'),
      gateStereo: document.getElementById('gate-stereo'),
      gateError: document.getElementById('gate-error'),
      loading: document.getElementById('loading'),
      loadingText: document.getElementById('loading-text'),
      rotateGate: document.getElementById('rotate-gate'),
      controls: document.getElementById('controls'),
      status: document.getElementById('status'),
      btnStereo: document.getElementById('btn-stereo'),
      btnRecenter: document.getElementById('btn-recenter'),
      btnFlipVideo: document.getElementById('btn-fliprot'),
      btnRestart: document.getElementById('btn-restart'),
      debugOrientation: document.getElementById('debug-orientation'),
    };

    this.frameMap = new VideoFrameMap();
    this.cameraFeed = new CameraFeed(this.dom.video);
    this.head = new HeadTracker(this.dom.canvas);
    this.renderer = new StereoRenderer(this.dom.canvas, this.frameMap);

    this.scene = new THREE.Scene();
    this.environment = new Environment();
    this.scene.add(this.environment.group);

    this.handTracker = new HandTracker();
    this.handSet = new HandSet();
    this.pointerHand = new PointerHand(this.dom.canvas, this.frameMap);
    /** Whichever of the two is actually supplying hands. */
    this.hands = this.handSet;

    this.drawing = new DrawingSession();
    this.scene.add(this.drawing.group);

    /** @type {Weapon|null} */
    this.weapon = null;
    this.rig = new WeaponRig();

    this.targets = new TargetField();
    this.scene.add(this.targets.group);

    this.projectiles = new Projectiles();
    this.scene.add(this.projectiles.mesh);

    this.muzzleFlash = new MuzzleFlash();
    this.scene.add(this.muzzleFlash.mesh);

    this.impacts = new ImpactBursts();
    this.scene.add(this.impacts.group);

    this.swingTrail = new SwingTrail();
    this.scene.add(this.swingTrail.line);

    this.sound = new Sound();

    this.gun = new GunBehavior(this.rig, this.projectiles, this.muzzleFlash);
    this.melee = new MeleeBehavior(this.rig, this.swingTrail);

    this.ui = new WorldUI();
    this.scene.add(this.ui.group);

    this.reticle = new Reticle(config.ui.panelDistance);
    this.scene.add(this.reticle.group);

    this.handCursor = new HandCursor();
    this.scene.add(this.handCursor.group);

    this.fsm = new StateMachine((from, to) => this._onStateChange(from, to));

    this.running = false;
    this._lastFrameMs = 0;
    this._prevPinch = false;
    this._statusText = '';

    /** Quarter turns clockwise applied to the raw camera frame; see setVideoRotation. */
    this.videoRotation = 0;
    /** Once true, stops the auto-heuristic from overriding the user's own choice. */
    this._videoRotationManual = false;

    /** True when stereo calibration mode is active. */
    this._stereoCalibrating = false;
    /** Saved stereo cal before entering calibration mode, for undo. */
    this._stereoCalBackup = null;

    this._bindUI();
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

    this.dom.btnRestart.addEventListener('click', () => this._startNewWeapon());

    this.dom.btnFlipVideo.addEventListener('click', () => {
      // A tap always takes over from the auto-guess: on the phones where the
      // guess lands on the wrong one of the two 90° directions, this is the
      // only way to actually fix it, and it should stick once chosen.
      this._videoRotationManual = true;
      this._setVideoRotation(this.videoRotation + 1);
    });

    window.addEventListener('resize', () => this._onResize());
    screen.orientation?.addEventListener?.('change', () => {
      // Give the browser a beat to settle the new viewport size.
      setTimeout(() => this._onResize(), 120);
    });
    // Entering/exiting fullscreen (part of _tryForceLandscape) changes the
    // canvas's available size too, and doesn't reliably pair with a plain
    // 'resize' event on every browser — Android in particular can settle its
    // system bars a beat after the fullscreenchange event itself fires.
    document.addEventListener('fullscreenchange', () => {
      setTimeout(() => this._onResize(), 120);
    });

    document.addEventListener('visibilitychange', () => {
      // Coming back from background leaves a huge dt; treat it as a fresh start.
      if (!document.hidden) this._lastFrameMs = performance.now();
    });
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
    el.textContent =
      `sensor: ${d.hasSensor ? 'yes' : 'no'}  pointerFallback: ${d.usingPointerFallback}\n` +
      `alpha ${fmt(d.alphaDeg)}  beta ${fmt(d.betaDeg)}  gamma ${fmt(d.gammaDeg)}\n` +
      `orientation.angle: ${fmt(d.reportedAngleDeg)}  type: ${d.orientationType}\n` +
      `screenAngle (used): ${fmt(d.screenAngleDeg)}\n` +
      `innerWidth x innerHeight: ${window.innerWidth} x ${window.innerHeight}`;
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
   * frame look identically "sideways" from the aspect ratio alone. It
   * defaults to a clockwise turn; `btn-fliprot` is the guaranteed fix on the
   * devices where that guess is backwards, and once tapped this stops
   * overriding the player's own choice.
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
      // Expected almost everywhere: iOS Safari has no orientation lock at
      // all, and a browser can reject fullscreen for its own reasons (e.g.
      // already denied once this session). Either way, gameplay does not
      // depend on this succeeding.
      console.info('[AR-Fight] Could not force landscape (falling back to manual rotation):', err?.message || err);
    } finally {
      // Either branch can leave stale layout behind: a successful lock does
      // not reliably fire `screen.orientation`'s 'change' event on every
      // browser, and a rejected one can still have partially resized the
      // viewport (fullscreen toggling before the lock call failed). This is
      // called from `start()` before the camera/tracker/UI are even up, so
      // there is nothing yet to resize — the resize this actually needs to
      // trigger is the one `start()` already runs once boot finishes; this
      // just re-runs it once more, after this async work has fully settled,
      // in case that earlier one landed mid-transition.
      if (this.running) this._onResize();
    }
  }

  async start() {
    this.dom.gateStart.disabled = true;
    this.dom.gateError.hidden = true;

    // Fired first and not awaited: Fullscreen + Orientation Lock both need a
    // fresh user gesture, which this click is, and every await below spends a
    // little of that window. This is also the one thing in this whole app
    // that can make the page ignore the phone's rotation-lock toggle — most
    // "I have to physically fight the screen to see it right" reports turn
    // out to be exactly that toggle, and unlike our own code there is no way
    // to detect it from the page, only to route around it. Best-effort:
    // unsupported on iOS Safari entirely, and requires user permission on
    // some Android builds, so this silently no-ops rather than blocking.
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
      // A user-facing camera reads mirrored; keep the mapping honest so hands
      // and strokes still line up.
      this.frameMap.mirrorX = facing === 'user';

      this.renderer.setVideoTexture(this.cameraFeed.texture, {
        mirrored: this.frameMap.mirrorX,
      });
      this._setStereo(this.dom.gateStereo.checked);
      this._onResize();

      await motionPromise;
      this.head.start();

      this._setLoading('Loading hand tracking…');
      const ok = await this.handTracker.load((msg) => this._setLoading(msg));

      if (!ok) {
        this.hands = this.pointerHand;
        this.pointerHand.setStereo(this.renderer.stereo);
        console.warn('[AR-Fight] Falling back to pointer input.');
      }

      this.dom.loading.hidden = true;
      this.dom.controls.hidden = false;

      this.running = true;
      this._lastFrameMs = performance.now();
      this.head.update();
      this.ui.recenter(this.head.position, this.head.quaternion);
      this._updateOrientationGate();

      // Load saved stereo calibration if available.
      this._loadStereoCalibration();

      // `go` fires the state-change callback, which builds the first screen.
      this.fsm.go(ok ? State.CHECK : State.DRAW, true);

      requestAnimationFrame((t) => this._loop(t));
    } catch (err) {
      console.error('[AR-Fight] Startup failed:', err);
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

    // Clamp dt: a stall must not teleport projectiles or spike swing speed.
    const dt = Math.min(0.1, Math.max(1e-4, (nowMs - this._lastFrameMs) / 1000));
    this._lastFrameMs = nowMs;
    const timeSec = nowMs / 1000;

    this.head.update();
    this._updateOrientationDebug(nowMs);
    this.fsm.tick(dt);

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

    const hand = this.hands.primary;

    // The UI gets first look at the hands. A pinch aimed at a button has to be
    // claimed here, before the drawing and tagging code would read the same
    // pinch as a stroke or an anchor.
    const activated = this.ui.update(
      dt, this.head.position, this.head.quaternion, this.hands.hands,
    );
    if (activated) this._onButton(activated);

    this._updateState(dt, nowMs, hand);

    this.renderer.updateCameras(this.head.position, this.head.quaternion);
    this.reticle.update(this.head.position, this.head.quaternion, this.ui.dwellProgress);
    this.reticle.setVisible(this.ui.visible && this.ui.buttons.length > 0);

    this.drawing.update();
    this.targets.update(dt);
    this.projectiles.update(dt, this.targets.targets, (target, point) => {
      if (this.targets.hit(target)) {
        this.impacts.spawn(point, this.head.quaternion, 0xffe9a8);
        this.sound.hit();
        this._refreshEquipPrompt();
      }
    });
    this.muzzleFlash.update(dt);
    this.impacts.update(dt);

    this.renderer.render(this.scene);
  }

  // ------------------------------------------------------------- state logic

  _onStateChange(from, to) {
    if (config.debug.logStates) console.info(`[AR-Fight] ${from} -> ${to}`);

    this.ui.visible = true;
    this.handCursor.setSkeletonVisible(config.debug.showHandSkeleton && to !== State.EQUIP);

    switch (to) {
      case State.CHECK:
        this.ui.setPrompt(
          'Hold up your hand',
          'Open palm toward the camera. Pinch your thumb and index finger together when you see the dot on your fingertips.',
        );
        this.ui.setButtons([
          { id: 'skip-check', label: 'Skip', hint: 'use defaults', width: 0.3 },
        ]);
        break;

      case State.DRAW:
        // Sets both the prompt and the buttons, based on what has been drawn.
        this._refreshDrawButtons();
        break;

      case State.CATEGORIZE:
        this.ui.setPrompt('What did you make?', 'This decides how it works in your hand.');
        this.ui.setButtons([
          { id: 'cat-gun', label: 'GUN', hint: 'shoots', accent: 0xff8c42, width: 0.34 },
          { id: 'cat-melee', label: 'MELEE', hint: 'swings', accent: 0xffe74c, width: 0.34 },
          { id: 'back-draw', label: 'Back', hint: 'keep drawing', width: 0.28 },
        ]);
        break;

      case State.TAG:
        this._refreshTagPrompt();
        break;

      case State.EQUIP:
        this.targets.reset();
        this.gun.reset();
        this.melee.reset();
        this.projectiles.clear();
        this.swingTrail.clear();
        this._stereoCalibrating = false;
        this._refreshEquipPrompt();
        this.ui.setButtons([
          { id: 'new-weapon', label: 'New', hint: 'draw another', width: 0.25 },
          { id: 'retag', label: 'Re-tag', hint: 'move the points', width: 0.28 },
          { id: 'reset-targets', label: 'Targets', hint: 'reset', width: 0.25 },
          { id: 'calibrate-stereo', label: 'Stereo', hint: 'tune', width: 0.25 },
        ]);
        break;

      default:
        break;
    }

    this._syncStatusFromUI();
  }

  _updateState(dt, nowMs, hand) {
    switch (this.fsm.current) {
      case State.CHECK:
        this._updateCheck(hand);
        break;
      case State.DRAW:
        this._updateDraw(hand);
        break;
      case State.CATEGORIZE:
        break;
      case State.TAG:
        this._updateTag(hand, dt);
        break;
      case State.EQUIP:
        this._updateEquip(dt, nowMs, hand);
        break;
      default:
        break;
    }

    // TAG draws its own snapped cursor; EQUIP hides it entirely.
    if (!this.fsm.is(State.TAG, State.EQUIP)) {
      const mode = this.fsm.is(State.DRAW) ? 'pinch' : 'point';
      this.handCursor.update(hand, this.head.quaternion, dt, { mode });
    }
  }

  /**
   * Tracking check doubles as depth calibration: the first confident pinch
   * tells us how far the player's outstretched hand actually reads, and we
   * scale future depth estimates so it lands at a natural arm's length.
   */
  _updateCheck(hand) {
    const pinching = !!hand?.visible && hand.pinching;
    // A pinch spent on the Skip button is not a calibration sample.
    const edge = pinching && !this._prevPinch && !this.ui.pinchConsumed;
    this._prevPinch = pinching;

    if (hand?.visible) {
      this.ui.setPrompt(
        'Hand detected',
        'Now pinch your thumb and index finger together to set your reach.',
        'success',
      );
      this._syncStatusFromUI();
    }

    if (!edge || !hand?.visible) return;

    // `depth` already has the old scale baked in; divide it back out so the
    // calibration is absolute rather than compounding across attempts.
    const rawDepth = hand.depth / (config.hands.depthScale || 1);
    if (rawDepth > 0.05) {
      config.hands.depthScale = THREE.MathUtils.clamp(
        CALIBRATION_DISTANCE / rawDepth,
        0.4,
        2.5,
      );
    }

    this.sound.confirm();
    this.fsm.go(State.DRAW);
  }

  _updateDraw(hand) {
    const pinching = !!hand?.visible && hand.pinching;
    // A pinch the UI has already claimed as a button press must not also lay
    // down a stroke — otherwise pressing DONE scribbles on the way out.
    const drawing = pinching && !this.ui.pinchConsumed;

    if (drawing && !this.drawing.active) {
      this.drawing.beginStroke();
      this.sound.tick();
    }

    if (drawing) {
      this.drawing.addPoint(hand.pinchPoint);
    } else if (this.drawing.active) {
      this.drawing.endStroke();
      this._refreshDrawButtons();
    }

    // Hide the panel only while a stroke is actually live, so it cannot sit
    // between you and the mark you are making. Hiding it on any pinch would
    // also stop the UI seeing the pinch meant to press a button.
    this.ui.visible = !this.drawing.active;
    this._prevPinch = pinching;
  }

  _refreshDrawButtons() {
    const has = !this.drawing.isEmpty;
    const buttons = [];
    if (has) {
      buttons.push({ id: 'undo', label: 'Undo', hint: 'last stroke', width: 0.28 });
      buttons.push({ id: 'clear', label: 'Clear', hint: 'start over', width: 0.28 });
      buttons.push({
        id: 'done-draw', label: 'DONE', hint: 'classify it', accent: 0x8bf5a0, width: 0.32,
      });
    }
    this.ui.setButtons(buttons);
    this.ui.setPrompt(
      has ? 'Keep drawing, or finish' : 'Draw your weapon',
      has
        ? `${this.drawing.strokes.length} stroke${this.drawing.strokes.length === 1 ? '' : 's'}. Pinch to add more, or press DONE.`
        : 'Pinch and move your hand to draw in the air. Release to end a stroke.',
    );
    this._syncStatusFromUI();
  }

  /**
   * Tagging: the fingertip snaps to the nearest point of the drawing, so you
   * mark a place *on the weapon* rather than a point floating near it.
   */
  _updateTag(hand, dt) {
    const spec = this.weapon?.nextAnchor;
    if (!spec) return;

    const pinching = !!hand?.visible && hand.pinching;
    // Ignore a pinch the UI claimed, so pressing Undo cannot also drop an
    // anchor wherever the other hand happened to be pointing.
    const edge = pinching && !this._prevPinch && !this.ui.pinchConsumed;
    this._prevPinch = pinching;

    let snapped = null;
    if (hand?.visible) {
      const near = this.drawing.nearestPoint(hand.indexTip, config.tagging.snapRadius);
      snapped = near?.point || null;
    }

    // Show the cursor at the point that would actually be tagged, not at the
    // fingertip — the gap between them is the whole reason snapping exists.
    const color = config.tagging.colors[spec.key] ?? 0xffffff;
    this.handCursor.update(hand, this.head.quaternion, dt, {
      mode: 'point',
      color,
      override: snapped,
    });

    if (!edge) return;

    if (!snapped) {
      this.sound.cancel();
      this.ui.setPrompt(
        `${spec.prompt} — move closer`,
        'Put your fingertip on the drawing itself, then pinch.',
      );
      this._syncStatusFromUI();
      return;
    }

    this.weapon.setAnchor(spec.key, snapped);
    this.sound.tick();

    if (this.weapon.taggingComplete) {
      this._equipWeapon();
    } else {
      this._refreshTagPrompt();
    }
  }

  _refreshTagPrompt() {
    const spec = this.weapon?.nextAnchor;
    if (!spec) return;
    const total = this.weapon.spec.length;
    const done = this.weapon.anchors.size;

    this.ui.setPrompt(`${spec.prompt}  (${done + 1}/${total})`, spec.detail);
    const buttons = [];
    if (this.weapon.anchors.size > 0) {
      buttons.push({ id: 'undo-anchor', label: 'Undo', hint: 'last point', width: 0.28 });
    }
    buttons.push({ id: 'back-categorize', label: 'Back', hint: 'change type', width: 0.3 });
    this.ui.setButtons(buttons);
    this._syncStatusFromUI();
  }

  _updateEquip(dt, nowMs, hand) {
    if (this._stereoCalibrating) {
      return; // Skip weapon update during calibration
    }

    this.rig.update(hand, dt);

    if (this.weapon?.category === 'gun') {
      if (this.gun.update(hand, nowMs, this.head.quaternion)) {
        this.sound.shot();
      }
    } else if (this.weapon?.category === 'melee') {
      const wasSwinging = this.melee.isSwinging;
      this.melee.update(dt, this.targets, (target, point) => {
        this.impacts.spawn(point, this.head.quaternion, 0xffe74c);
        this.sound.hit();
        this._refreshEquipPrompt();
      });
      if (this.melee.isSwinging && !wasSwinging) this.sound.swing();
    }

    // The weapon is in your hand now; a cursor on top of it is just clutter.
    this.handCursor.group.visible = false;
  }

  _refreshEquipPrompt() {
    if (!this.weapon) return;
    const isGun = this.weapon.category === 'gun';
    this.ui.setPrompt(
      `${isGun ? 'Gun' : 'Melee'} ready  —  ${this.targets.score} hit${this.targets.score === 1 ? '' : 's'}`,
      isGun
        ? 'Aim with your hand and curl your index finger to fire.'
        : 'Swing through a target. Slow taps will not connect.',
      'success',
    );
    this._syncStatusFromUI();
  }

  _loadStereoCalibration() {
    try {
      const saved = localStorage.getItem('ar-fight-stereo-cal');
      if (saved) {
        const cal = JSON.parse(saved);
        this.renderer.setIPD(cal.ipd);
        this.renderer.setLensCenterOffset(cal.lensCenterOffset);
      }
    } catch (e) {
      console.warn('Could not load stereo calibration:', e);
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
      'Stereo Calibration',
      `IPD: ${ipdMm}mm · Offset: ${offsetPct}%\nAdjust until the two eye-circles fuse into one`,
    );
    this.ui.setButtons([
      { id: 'stereo-ipd-minus', label: '−', hint: 'IPD', width: 0.15 },
      { id: 'stereo-ipd-plus', label: '+', hint: 'IPD', width: 0.15 },
      { id: 'stereo-offset-minus', label: '−', hint: 'Offset', width: 0.15 },
      { id: 'stereo-offset-plus', label: '+', hint: 'Offset', width: 0.15 },
      { id: 'stereo-cal-save', label: 'Save', width: 0.22 },
      { id: 'stereo-cal-cancel', label: 'Cancel', width: 0.22 },
    ]);
  }

  _saveStereoCalibration() {
    const cal = this.renderer.getStereoCal();
    try {
      localStorage.setItem('ar-fight-stereo-cal', JSON.stringify(cal));
    } catch (e) {
      console.warn('Could not save stereo calibration:', e);
    }
    this._exitStereoCalibration();
  }

  _exitStereoCalibration() {
    this._stereoCalibrating = false;
    if (this._stereoCalBackup) {
      // If exiting via cancel, could restore: but we'll just leave the current values
    }
    this._stereoCalBackup = null;
    this._refreshEquipPrompt();
    this.ui.setButtons([
      { id: 'new-weapon', label: 'New', hint: 'draw another', width: 0.28 },
      { id: 'retag', label: 'Re-tag', hint: 'move the points', width: 0.32 },
      { id: 'reset-targets', label: 'Targets', hint: 'reset', width: 0.3 },
    ]);
  }

  // -------------------------------------------------------------- transitions

  _onButton(id) {
    switch (id) {
      case 'skip-check':
        this.sound.tick();
        this.fsm.go(State.DRAW);
        break;

      case 'undo':
        this.drawing.undo();
        this.sound.cancel();
        this._refreshDrawButtons();
        break;

      case 'clear':
        this.drawing.clear();
        this.sound.cancel();
        this._refreshDrawButtons();
        break;

      case 'done-draw':
        if (this.drawing.isEmpty) return;
        this.sound.confirm();
        this.weapon = new Weapon(this.drawing);
        this.scene.add(this.weapon.markers);
        this.fsm.go(State.CATEGORIZE);
        break;

      case 'cat-gun':
      case 'cat-melee':
        this.weapon.setCategory(id === 'cat-gun' ? 'gun' : 'melee');
        this.sound.confirm();
        this.fsm.go(State.TAG);
        break;

      case 'back-draw':
        this._discardWeapon();
        this.sound.cancel();
        this.fsm.go(State.DRAW);
        break;

      case 'undo-anchor':
        this.weapon.undoAnchor();
        this.sound.cancel();
        this._refreshTagPrompt();
        break;

      case 'back-categorize':
        this.weapon.clearAnchors();
        this.sound.cancel();
        this.fsm.go(State.CATEGORIZE);
        break;

      case 'new-weapon':
        this._startNewWeapon();
        break;

      case 'retag':
        this._retagWeapon();
        break;

      case 'reset-targets':
        this.targets.reset();
        this.sound.confirm();
        this._refreshEquipPrompt();
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

  _equipWeapon() {
    try {
      this.weapon.finalize();
    } catch (err) {
      console.error('[AR-Fight] Could not finalize weapon:', err);
      this.sound.cancel();
      this.fsm.go(State.CATEGORIZE);
      return;
    }

    this.scene.add(this.weapon.root);
    this.weapon.setMarkersVisible(false);
    this.rig.attach(this.weapon);
    this.swingTrail.setColor(
      config.tagging.colors[this.weapon.category === 'gun' ? 'muzzle' : 'strike'],
    );
    this.sound.confirm();
    this.fsm.go(State.EQUIP);
  }

  /** Tear the current weapon down and go back to a blank canvas. */
  _startNewWeapon() {
    if (!this.running) return;
    this.sound.cancel();
    this._discardWeapon();

    this.scene.remove(this.drawing.group);
    this.drawing = new DrawingSession();
    this.scene.add(this.drawing.group);

    this.projectiles.clear();
    this.swingTrail.clear();
    this.melee.reset();
    this.gun.reset();
    this._prevPinch = false;

    this.fsm.go(State.DRAW, true);
  }

  /**
   * Return to tagging with the same sketch, keeping it wherever it currently
   * hangs in the air.
   *
   * Finalizing parented the art under the weapon's pivot, so it now carries a
   * transform. Snapping compares fingertips against raw sample coordinates, so
   * that transform has to be baked into the samples rather than left on the
   * group — otherwise the points you can touch and the shape you can see are
   * in different places.
   */
  _retagWeapon() {
    if (!this.weapon) return;
    this.sound.cancel();

    const group = this.drawing.group;
    group.updateMatrixWorld(true);
    _matrix.copy(group.matrixWorld);

    // `add` detaches from the pivot; the transform then goes into the samples.
    this.scene.add(group);
    this.drawing.applyTransform(_matrix);

    const category = this.weapon.category;
    this.rig.detach();
    this.scene.remove(this.weapon.root);
    this.scene.remove(this.weapon.markers);
    // Drop only the markers: `dispose()` would take the sketch with it.
    this.weapon.disposeMarkers();

    this.weapon = new Weapon(this.drawing);
    this.weapon.setCategory(category);
    this.scene.add(this.weapon.markers);

    this.projectiles.clear();
    this.swingTrail.clear();
    this._prevPinch = false;
    this.fsm.go(State.TAG, true);
  }

  _discardWeapon() {
    if (!this.weapon) {
      this.drawing.clear();
      return;
    }
    this.rig.detach();
    this.scene.remove(this.weapon.root);
    this.scene.remove(this.weapon.markers);
    this.weapon.dispose();
    this.weapon = null;
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

const _matrix = new THREE.Matrix4();

// Surface module-level failures on the gate rather than leaving a black screen.
try {
  const app = new ARFight();
  window.ARFIGHT = app;
} catch (err) {
  console.error('[AR-Fight] Failed to initialise:', err);
  const gateError = document.getElementById('gate-error');
  if (gateError) {
    gateError.textContent = `Could not start: ${err?.message || err}`;
    gateError.hidden = false;
  }
}
