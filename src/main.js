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
import * as PaperTrace from './draw/PaperTrace.js';
import { Weapon } from './weapon/Weapon.js';
import { WeaponRig } from './weapon/WeaponRig.js';
import { GunBehavior } from './weapon/GunBehavior.js';
import { MeleeBehavior } from './weapon/MeleeBehavior.js';

import { WorldUI } from './ui/WorldUI.js';
import { Reticle } from './ui/Reticle.js';
import { HandCursor } from './ui/HandCursor.js';
import { Lobby } from './ui/Lobby.js';
import { HealthHUD } from './ui/HealthHUD.js';

import { Environment } from './scene/Environment.js';
import { TargetField } from './fx/Targets.js';
import { Projectiles } from './fx/Projectiles.js';
import { MuzzleFlash, ImpactBursts, SwingTrail } from './fx/Effects.js';
import { Sound } from './fx/Sound.js';

import { OpponentAvatar } from './net/OpponentAvatar.js';
import { serializeWeapon } from './net/WeaponSync.js';

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
      btnMirror: document.getElementById('btn-mirror'),
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

    // A second, separate pool for the opponent's incoming shots/throws: pure
    // decoration (their client already decided whether it hit — see the
    // `hit` message), spawned right at their avatar's own hitbox, so running
    // them through the same collision-tested pool would just self-hit on
    // the spawn frame. Given empty targets every update, this one never
    // collides with anything.
    this.opponentProjectiles = new Projectiles();
    this.scene.add(this.opponentProjectiles.mesh);

    this.opponent = new OpponentAvatar();
    this.scene.add(this.opponent.group);

    this.healthHud = new HealthHUD();
    this.scene.add(this.healthHud.group);

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

    /** Continuous thumbs-up hold time this frame streak, ms; see _updatePaperCapture. */
    this._paperHoldMs = 0;
    /** Cooldown after a capture attempt, ms, so the same held gesture cannot refire instantly. */
    this._paperCooldownMs = 0;
    this._paperStatusTimer = null;

    /** @type {import('./net/NetSession.js').NetSession|null} */
    this.net = null;
    /** Chosen in the lobby, before the camera gate; never changes mid-session. */
    this.versusMode = false;
    this.versus = ARFight._freshVersusState();
    this._poseSendAccum = 0;
    /** projectiles pool index -> 'gun' | 'melee', so the hit callback knows
     * which damage/effect applies; see fire()/_throwMelee(). */
    this._projectileKind = new Map();

    this._bindUI();
    this._updateFlipButton();
    this._updateMirrorButton();

    // The very first screen. Nothing else here has touched the camera or
    // asked for any permission yet, so it is safe to sit and wait — a
    // versus connection is worth establishing before spending a permission
    // prompt on a match that might not even connect.
    this.lobby = new Lobby((result) => this._onLobbyDone(result));
  }

  static _freshVersusState() {
    return {
      /** Both sides have equipped and the fight is actually live. */
      active: false,
      myReady: false,
      opponentReady: false,
      myHealth: config.versus.maxHealth,
      ended: false,
      iWon: false,
      wantRematch: false,
      opponentWantsRematch: false,
    };
  }

  _onLobbyDone(result) {
    this.versusMode = result.mode === 'versus';
    if (this.versusMode) {
      this.net = result.net;
      this._bindNet();
    }
    this.dom.gate.hidden = false;
  }

  _bindNet() {
    const net = this.net;
    net.onDisconnected = () => this._onOpponentDisconnected();
    net.on('ready', (msg) => this._onOpponentReady(msg));
    net.on('pose', (msg) => this._onOpponentPose(msg));
    net.on('fire', () => this._onOpponentFire());
    net.on('throw', () => this._onOpponentThrow());
    net.on('hit', (msg) => this._onOpponentHit(msg));
    net.on('defeated', () => this._onOpponentDefeated());
    net.on('rematch', () => this._onOpponentRematch());
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
      `per-eye viewport: ${eyeW}x${bufH}   eyeAspect: ${fmt(r.eyeAspect)}`;
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
   * landscape-shaped" — a landscape stream that is upside down (180°, e.g.
   * the phone's camera is mounted rotated relative to its "up") looks
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
      `Camera background sideways or upside down? Tap to rotate it another 90° ` +
      `(currently ${deg}° — keep tapping until it looks right).`;
  }

  /** Keep the mirror button's on/off indication in sync with `frameMap.mirrorX`. */
  _updateMirrorButton() {
    const on = this.frameMap.mirrorX;
    this.dom.btnMirror.classList.toggle('on', on);
    this.dom.btnMirror.title = on
      ? 'Camera background mirrored to fix left/right. Tap to undo.'
      : 'Left and right still swapped after rotating? Tap to mirror the camera background.';
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
      this._updateMirrorButton();

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

    this.head.update(timeSec);
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

    const versusLive = this.versusMode && this.versus.active && !this.versus.ended;
    const projectileTargets = versusLive
      ? [...this.targets.targets, this.opponent.hitbox]
      : this.targets.targets;
    this.projectiles.update(dt, projectileTargets, (target, point, index) => {
      if (target === this.opponent.hitbox) {
        this._onLocalHitOpponent(point, index);
        return;
      }
      if (this.targets.hit(target)) {
        this.impacts.spawn(point, this.head.quaternion, 0xffe9a8);
        this.sound.hit();
        this._refreshEquipPrompt();
      }
    });
    // Decorative only (see the constructor) — no targets, so nothing to hit.
    this.opponentProjectiles.update(dt, null, null);
    this.muzzleFlash.update(dt);
    this.impacts.update(dt);

    if (this.versusMode) this._updateVersus(dt);

    this.renderer.render(this.scene);
  }

  // ------------------------------------------------------------- versus mode

  _updateVersus(dt) {
    this.opponent.update(dt);

    if (this.versus.active && !this.versus.ended) {
      this.healthHud.setVisible(true);
      this.healthHud.updateTransform(this.head.position, this.head.quaternion);
      this.healthHud.render(this.versus.myHealth, this.opponent.health, config.versus.maxHealth);
    }

    if (!this.versus.active || this.versus.ended || !this.rig.attached) return;
    this._poseSendAccum += dt;
    const interval = 1 / config.versus.poseSendHz;
    if (this._poseSendAccum >= interval) {
      this._poseSendAccum = 0;
      this._sendPose();
    }
  }

  _sendPose() {
    if (!this.net?.connected || !this.rig.weapon) return;
    this.rig.weapon.root.getWorldPosition(_worldPos);
    this.rig.weapon.root.getWorldQuaternion(_worldQuat);
    // Relative to my own head, not world space — see WeaponSync's doc
    // comment: there is no shared coordinate system between two separate
    // rooms, only each player's own sense of where their head is facing.
    _invHeadQuat.copy(this.head.quaternion).invert();
    _relPos.subVectors(_worldPos, this.head.position).applyQuaternion(_invHeadQuat);
    _relQuat.copy(_invHeadQuat).multiply(_worldQuat);
    this.net.send('pose', {
      pos: round3Vec(_relPos),
      quat: round3Quat(_relQuat),
    });
  }

  _onOpponentReady(msg) {
    this.opponent.setWeapon(msg.weapon);
    this.versus.opponentReady = true;
    this._tryStartVersusMatch();
  }

  _tryStartVersusMatch() {
    if (this.versus.active || !this.versus.myReady || !this.versus.opponentReady) return;
    this.versus.active = true;
    this.versus.myHealth = config.versus.maxHealth;
    this.opponent.resetHealth();
    this.opponent.place(this.head.position, this.head.quaternion);
    this._refreshEquipPrompt();
  }

  _onOpponentPose(msg) {
    if (!this.versus.active) return;
    this.opponent.applyPose(msg.pos, msg.quat);
  }

  _onOpponentFire() {
    if (!this.versus.active || !this.opponent.weapon) return;
    this.opponent.getTipPosition(_oppTip);
    this.opponent.weapon.getWorldForward(_oppFwd);
    this.opponentProjectiles.fire(_oppTip, _oppFwd, config.gun.projectileSpeed);
    this.muzzleFlash?.trigger(_oppTip, this.head.quaternion);
  }

  _onOpponentThrow() {
    if (!this.versus.active || !this.opponent.weapon) return;
    this.opponent.getTipPosition(_oppTip);
    this.opponent.weapon.getWorldForward(_oppFwd);
    this.opponentProjectiles.fire(_oppTip, _oppFwd, config.melee.throwProjectileSpeed);
  }

  /** My own shot/throw connected with their avatar in my scene — see Projectiles.update above. */
  _onLocalHitOpponent(point, projectileIndex) {
    const kind = this._projectileKind.get(projectileIndex) || 'gun';
    this._projectileKind.delete(projectileIndex);
    const damage = kind === 'melee' ? config.melee.throwDamage : config.versus.gunDamage;

    this.impacts.spawn(point, this.head.quaternion, kind === 'melee' ? 0xffe74c : 0xffe9a8);
    this.sound.hit();
    this.net?.send('hit', { damage, kind });

    // Optimistic local mirror, purely for my own health-bar display — their
    // own client is authoritative for their own actual health.
    this.opponent.takeDamage(damage);
    if (!this.opponent.alive) this._endVersusMatch(true);
  }

  _onOpponentHit(msg) {
    if (this.versus.ended) return;
    this.versus.myHealth = Math.max(0, this.versus.myHealth - msg.damage);
    this.impacts.spawn(this.head.position, this.head.quaternion, msg.kind === 'melee' ? 0xffe74c : 0xff6b6b);
    this.sound.hit();
    if (this.versus.myHealth <= 0) {
      this.net?.send('defeated', {});
      this._endVersusMatch(false);
    }
  }

  _onOpponentDefeated() {
    this._endVersusMatch(true);
  }

  _endVersusMatch(iWon) {
    if (this.versus.ended) return;
    this.versus.ended = true;
    this.versus.iWon = iWon;
    (iWon ? this.sound.confirm : this.sound.cancel)?.call(this.sound);
    this.ui.setPrompt(
      iWon ? 'Victory!' : 'Defeated',
      iWon ? 'You beat them. Go again?' : 'They got you. Go again?',
      iWon ? 'success' : 'error',
    );
    this.ui.setButtons([
      { id: 'versus-rematch', label: 'Rematch', hint: 'draw again', accent: 0x8bf5a0, width: 0.34 },
    ]);
    this._syncStatusFromUI();
  }

  _onOpponentRematch() {
    this.versus.opponentWantsRematch = true;
    this._tryRestartVersusMatch();
  }

  _tryRestartVersusMatch() {
    if (!this.versus.wantRematch || !this.versus.opponentWantsRematch) return;
    this.versus = ARFight._freshVersusState();
    this.opponent.reset();
    this.healthHud.setVisible(false);
    this._startNewWeapon();
  }

  _onOpponentDisconnected() {
    if (this.versus.ended) return;
    this.ui.setPrompt(
      'Your friend disconnected',
      'You can keep playing solo from here, or reload to start a fresh match.',
      'error',
    );
    this.ui.setButtons([]);
    this._syncStatusFromUI();
    this.versus.active = false;
    this.opponent.group.visible = false;
    this.healthHud.setVisible(false);
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
        this.opponentProjectiles.clear();
        this.swingTrail.clear();
        this._stereoCalibrating = false;
        if (this.versusMode) {
          this.net?.send('ready', { weapon: serializeWeapon(this.weapon) });
          this.versus.myReady = true;
          this._tryStartVersusMatch();
        }
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
        this._updateDraw(hand, dt);
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

  _updateDraw(hand, dt) {
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

    this._updatePaperCapture(dt);
  }

  /**
   * Alternative to pinch-drawing: hold a pen-and-paper outline up to the
   * camera and give a thumbs up. A hold (not just an instant flag check) so
   * the gesture has to be deliberate — this replaces whatever was drawn and
   * jumps straight to categorize, unlike a stray one-frame misread of a
   * pinch, which just does nothing.
   *
   * Checks both tracked hands, not just `this.hands.primary` — the realistic
   * shape of this gesture is one hand holding the paper (visible, but not
   * pinching or otherwise "primary") while the other thumbs-up, and
   * `HandSet` has no reason to promote a non-pinching thumbs-up hand to
   * primary over whichever hand it already favours.
   */
  _updatePaperCapture(dt) {
    if (this._paperCooldownMs > 0) {
      this._paperCooldownMs -= dt * 1000;
      return;
    }
    // Don't fight a live mid-air stroke for the same hand's gesture state.
    const thumbsHand = !this.drawing.active
      && [this.hands.primary, this.hands.secondary].find((h) => h?.visible && h.thumbsUp);
    if (!thumbsHand) {
      this._paperHoldMs = 0;
      return;
    }
    this._paperHoldMs += dt * 1000;
    if (this._paperHoldMs < config.paperTrace.holdMs) return;

    this._paperHoldMs = 0;
    this._paperCooldownMs = config.paperTrace.cooldownMs;
    this._capturePaperDrawing();
  }

  /** Lift a captured-frame pixel (video-normalised u,v) into world space, at
   * the assumed paper distance — same construction HandPose uses for
   * landmarks, so a traced shape sits consistently with everything else. */
  _paperPointTo3D(u, v, out) {
    this.frameMap.unproject(u, v, config.paperTrace.depth, out);
    return out.applyQuaternion(this.head.quaternion).add(this.head.position);
  }

  _capturePaperDrawing() {
    const imageData = PaperTrace.captureFrame(this.cameraFeed.video, config.paperTrace.captureMaxWidth);
    if (!imageData) return;

    const { shapes, reason } = PaperTrace.extractShapes(imageData, config.paperTrace);
    if (!shapes.length) {
      this.sound.cancel();
      this._flashDrawStatus(
        "Couldn't find a drawing",
        reason === 'low-contrast'
          ? 'Hold it closer, or find better light.'
          : "Make sure it's dark ink on plain paper, filling most of the frame.",
      );
      return;
    }

    this.drawing.clear();
    for (const shape of shapes) {
      this.drawing.beginStroke();
      for (const p of shape.points) {
        this.drawing.addPoint(this._paperPointTo3D(p.u, p.v, _paperPoint));
      }
      // Re-visit the first point so the traced outline reads as one closed
      // shape rather than a tube with its two ends left hanging open.
      if (shape.points.length > 1) {
        const first = shape.points[0];
        this.drawing.addPoint(this._paperPointTo3D(first.u, first.v, _paperPoint));
      }
      this.drawing.endStroke();
    }

    if (this.drawing.isEmpty) {
      this._flashDrawStatus('Too small to use', 'Try drawing it bigger on the page.');
      return;
    }

    this.sound.confirm();
    this._finishDrawing();
  }

  /** Temporary prompt message, restored to the normal draw prompt after a beat. */
  _flashDrawStatus(title, detail) {
    this.ui.setPrompt(title, detail, 'error');
    this._syncStatusFromUI();
    clearTimeout(this._paperStatusTimer);
    this._paperStatusTimer = setTimeout(() => {
      if (this.fsm.is(State.DRAW)) this._refreshDrawButtons();
    }, 2200);
  }

  /** Drawing -> categorize, however the sketch was produced (pinch or paper). */
  _finishDrawing() {
    if (this.drawing.isEmpty) return;
    this.weapon = new Weapon(this.drawing);
    this.scene.add(this.weapon.markers);
    this.fsm.go(State.CATEGORIZE);
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
        : 'Pinch and move your hand to draw in the air — or hold up a paper drawing and give a thumbs up.',
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
        if (this.versusMode && this.versus.active) {
          this._projectileKind.set(this.gun.lastProjectileIndex, 'gun');
          this.net?.send('fire', {});
        }
      }
    } else if (this.weapon?.category === 'melee') {
      const wasSwinging = this.melee.isSwinging;
      const thrown = this.melee.update(hand, nowMs, dt, this.targets, (target, point) => {
        this.impacts.spawn(point, this.head.quaternion, 0xffe74c);
        this.sound.hit();
        this._refreshEquipPrompt();
      });
      if (this.melee.isSwinging && !wasSwinging) this.sound.swing();
      if (thrown) {
        const idx = this.projectiles.fire(thrown.origin, thrown.direction, config.melee.throwProjectileSpeed);
        this.sound.swing();
        if (this.versusMode && this.versus.active) {
          this._projectileKind.set(idx, 'melee');
          this.net?.send('throw', {});
        }
      }
    }

    // The weapon is in your hand now; a cursor on top of it is just clutter.
    this.handCursor.group.visible = false;
  }

  _refreshEquipPrompt() {
    if (!this.weapon) return;
    if (this.versusMode && !this.versus.ended) {
      this._refreshVersusEquipPrompt();
      return;
    }
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

  /** Prompt text only — the button row is set once, on entering EQUIP, and
   * left alone here so this can be called freely (e.g. after a hit) without
   * fighting over it. */
  _refreshVersusEquipPrompt() {
    if (!this.versus.active) {
      this.ui.setPrompt(
        'Waiting for your opponent…',
        "They're still drawing or tagging their weapon.",
      );
      this._syncStatusFromUI();
      return;
    }
    const isGun = this.weapon.category === 'gun';
    this.ui.setPrompt(
      `${isGun ? 'Gun' : 'Melee'} ready — fight!`,
      isGun
        ? 'Aim and curl your index finger to fire.'
        : 'Pinch through a fast swing and let go to throw it at them.',
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
        this._finishDrawing();
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

      case 'versus-rematch':
        this.versus.wantRematch = true;
        this.net?.send('rematch', {});
        this.ui.setPrompt('Waiting for them to rematch…', '');
        this.ui.setButtons([]);
        this._syncStatusFromUI();
        this._tryRestartVersusMatch();
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
const _paperPoint = new THREE.Vector3();
const _worldPos = new THREE.Vector3();
const _worldQuat = new THREE.Quaternion();
const _invHeadQuat = new THREE.Quaternion();
const _relPos = new THREE.Vector3();
const _relQuat = new THREE.Quaternion();
const _oppTip = new THREE.Vector3();
const _oppFwd = new THREE.Vector3();

/** Millimetre-ish precision is plenty for a synced pose and keeps messages small. */
function round3(n) {
  return Math.round(n * 1000) / 1000;
}
function round3Vec(v) {
  return { x: round3(v.x), y: round3(v.y), z: round3(v.z) };
}
function round3Quat(q) {
  return { x: round3(q.x), y: round3(q.y), z: round3(q.z), w: round3(q.w) };
}

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
