#!/usr/bin/env node
/**
 * Boots the real page in headless Chromium and drives it through the whole
 * flow with a synthetic camera.
 *
 * `npm test` covers the maths but cannot touch WebGL, canvas text, or the
 * DOM wiring — and a shader that fails to compile is invisible until the page
 * is black on a phone. This runs the actual application: it compiles the
 * distortion and passthrough shaders, renders frames, and walks
 * draw -> categorize -> tag -> equip using the pointer fallback.
 *
 *   npm run smoke          # headless
 *   npm run smoke -- --shots   # also write PNGs to tools/shots/
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = path.join(__dirname, 'shots');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
};

/**
 * Locate a Chromium build. Prefers whatever Playwright resolves on its own,
 * falling back to a scan of PLAYWRIGHT_BROWSERS_PATH for environments that
 * ship a pre-installed browser under a versioned directory.
 */
function findChromium() {
  try {
    const resolved = chromium.executablePath();
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {
    /* not installed through playwright's own download */
  }

  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (fs.existsSync(base)) {
    const candidates = fs
      .readdirSync(base)
      // headless_shell has no WebGL, so it cannot verify shaders.
      .filter((d) => d.startsWith('chromium') && !d.includes('headless_shell'))
      .sort()
      .reverse()
      .map((d) => path.join(base, d, 'chrome-linux', 'chrome'));
    for (const c of candidates) if (fs.existsSync(c)) return c;
  }
  throw new Error(`No Chromium found (looked under ${base})`);
}

async function waitForServer(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server never came up at ${url}`);
}

async function main() {
  // Plain HTTP on loopback: a secure context, so getUserMedia is allowed.
  const server = spawn(process.execPath, [path.join(__dirname, 'serve.js'), '--http', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
  });

  let browser;
  try {
    await waitForServer(BASE);

    browser = await chromium.launch({
      // Full Chromium, not headless_shell: the shell has no WebGL.
      executablePath: findChromium(),
      args: [
        // A synthetic moving test pattern stands in for the rear camera.
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        // SwiftShader gives a real GL implementation with no GPU present, so
        // shaders genuinely compile rather than being skipped.
        '--use-gl=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 900, height: 450 },
      permissions: ['camera'],
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    const notFound = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('response', (res) => {
      if (res.status() === 404) notFound.push(new URL(res.url()).pathname);
    });

    console.log('\nBoot');
    await page.goto(BASE, { waitUntil: 'load' });
    check(await page.locator('#lobby').isVisible(), 'lobby screen renders');
    check(await page.locator('#gate').isHidden(), 'gate screen waits behind the lobby');

    // --- Versus lobby: this sandbox's egress policy blocks the PeerJS CDN
    // outright (confirmed via the proxy's own status endpoint — a 403 to
    // unpkg.com, not a generic timeout), so a real host/join connection
    // cannot be exercised here. What *can* be verified for real, and is
    // worth it on its own: hitting Host or Join with no networking library
    // loaded fails visibly rather than hanging or throwing — the one
    // failure mode every real user is guaranteed to never hit (their phone
    // has no such block) but that's worth being sure doesn't wedge the UI.
    console.log('\nLobby (versus mode, offline)');
    const peerLoaded = await page.evaluate(() => typeof window.Peer === 'function');
    check(!peerLoaded, 'PeerJS CDN is unreachable here (expected — see note below)');

    await page.click('#lobby-versus');
    check(await page.locator('#lobby-versus-mode').isVisible(), 'versus sub-menu opens');

    await page.click('#lobby-host');
    await page.waitForTimeout(500);
    let lobbyState = await page.evaluate(() => ({
      errorVisible: !document.getElementById('lobby-error').hidden,
      errorText: document.getElementById('lobby-error').textContent,
      hostingVisible: !document.getElementById('lobby-hosting').hidden,
    }));
    check(!lobbyState.hostingVisible && lobbyState.errorVisible && /networking/i.test(lobbyState.errorText),
      'hosting without PeerJS fails with a visible error, not a hang',
      JSON.stringify(lobbyState));

    await page.click('#lobby-join');
    await page.fill('#lobby-code-input', 'ab-cd!ef12');
    check(await page.inputValue('#lobby-code-input') === 'ABCDE',
      'room code input strips punctuation, uppercases, and caps at 5 chars');
    await page.click('#lobby-connect');
    await page.waitForTimeout(500);
    lobbyState = await page.evaluate(() => ({
      errorVisible: !document.getElementById('lobby-error').hidden,
      errorText: document.getElementById('lobby-error').textContent,
      connectDisabled: document.getElementById('lobby-connect').disabled,
    }));
    check(lobbyState.errorVisible && /networking/i.test(lobbyState.errorText) && !lobbyState.connectDisabled,
      'joining without PeerJS fails with a visible error and re-enables Connect',
      JSON.stringify(lobbyState));

    await page.click('#lobby-cancel-join');
    check(await page.locator('#lobby-versus-mode').isVisible(), 'cancel returns to the versus sub-menu');
    await page.click('#lobby-back-mode');
    check(await page.locator('#lobby-mode').isVisible(), 'back returns to the solo/versus choice');

    await page.click('#lobby-solo');
    check(await page.locator('#gate').isVisible(), 'gate screen renders after choosing solo');

    // Hand tracking needs a CDN this sandbox cannot reach; the pointer
    // fallback is the path under test here anyway.
    await page.click('#gate-start');

    await page.waitForFunction(
      () => window.ARFIGHT?.running === true,
      null,
      { timeout: 45000 },
    );
    check(true, 'session starts with a fake camera');

    const boot = await page.evaluate(() => ({
      state: window.ARFIGHT.fsm.current,
      stereo: window.ARFIGHT.renderer.stereo,
      videoW: window.ARFIGHT.cameraFeed.width,
      videoH: window.ARFIGHT.cameraFeed.height,
      videoFlipY: window.ARFIGHT.cameraFeed.texture?.flipY,
      pointerFallback: window.ARFIGHT.hands === window.ARFIGHT.pointerHand,
    }));
    check(boot.videoW > 0 && boot.videoH > 0, 'camera reports a frame size',
      `got ${boot.videoW}x${boot.videoH}`);
    // BACKGROUND_FRAG's UV math assumes flipY=false (see CameraFeed) — the
    // default (true) silently renders passthrough upside down for everyone,
    // on every device, regardless of any rotation/mirror setting.
    check(boot.videoFlipY === false, 'video texture has flipY disabled to match the background shader');
    check(boot.stereo === true, 'starts in stereo headset mode');
    check(['check', 'draw'].includes(boot.state), 'reaches an interactive state',
      `state=${boot.state}`);

    // --- The fullscreen+orientation-lock attempt from start() must never be
    // able to break the session — headless Chromium, and plenty of real
    // browsers (all of iOS Safari), reject or lack this outright, and that
    // has to be an invisible no-op, not a startup failure.
    const forceLandscape = await page.evaluate(async () => {
      const app = window.ARFIGHT;
      if (typeof app._tryForceLandscape !== 'function') return { error: 'method missing' };
      let threw = null;
      try {
        await app._tryForceLandscape();
      } catch (err) {
        threw = err?.message || String(err);
      }
      return { threw, stillRunning: app.running === true };
    });
    check(forceLandscape.threw === null, 'force-landscape attempt never throws to its caller',
      `threw: ${forceLandscape.threw}`);
    check(forceLandscape.stillRunning, 'session is unaffected whether or not it succeeded');

    // --- Rendering actually happens, and the GL program links.
    console.log('\nRendering');
    await page.waitForTimeout(700);
    const gl = await page.evaluate(() => {
      const r = window.ARFIGHT.renderer.renderer;
      const info = r.info;
      return {
        frames: info.render.frame,
        calls: info.render.calls,
        programs: r.info.programs?.length ?? 0,
        contextLost: r.getContext().isContextLost(),
      };
    });
    check(gl.frames > 5, 'render loop is producing frames', `frames=${gl.frames}`);
    check(gl.calls > 0, 'draw calls are being issued', `calls=${gl.calls}`);
    check(!gl.contextLost, 'WebGL context is healthy');
    check(gl.programs >= 2, 'shader programs linked (passthrough + distortion)',
      `programs=${gl.programs}`);

    // Any shader that failed to compile shows up as a console error from three.
    const shaderErrors = consoleErrors.filter((e) => /shader|glsl|program|compile/i.test(e));
    check(shaderErrors.length === 0, 'no shader compile errors',
      shaderErrors.join('\n        '));

    if (SHOTS) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(SHOT_DIR, '1-stereo.png') });
    }

    // --- Walk the flow using the pointer fallback.
    console.log('\nFlow');
    await page.evaluate(() => {
      const app = window.ARFIGHT;
      // Force the pointer hand so the walk-through does not depend on
      // MediaPipe being reachable.
      app.hands = app.pointerHand;
      app.pointerHand.visible = true;
      if (app.fsm.current === 'check') app.fsm.go('draw');
    });

    // Draw two strokes by driving the drawing session directly. Points must be
    // real Vector3s — the app clones and transforms them downstream.
    const strokeCount = await page.evaluate(async () => {
      const app = window.ARFIGHT;
      const Vec3 = app.head.position.constructor;
      const draw = (from, to, steps) => {
        app.drawing.beginStroke();
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          app.drawing.addPoint(new Vec3(
            from[0] + (to[0] - from[0]) * t,
            from[1] + (to[1] - from[1]) * t,
            from[2] + (to[2] - from[2]) * t,
          ));
        }
        app.drawing.endStroke();
      };
      draw([0, -0.10, -0.5], [0, 0, -0.5], 14);   // grip
      draw([0, 0, -0.5], [0, 0, -0.72], 26);      // barrel
      app._refreshDrawButtons();
      return app.drawing.strokes.length;
    });
    check(strokeCount === 2, 'two strokes recorded', `got ${strokeCount}`);

    // --- Gaze+pinch must fire the instant a pinch lands while looking at a
    // button, not after some minimum dwell first — the panel sits further
    // away than an arm reaches, so this is the primary way to press
    // anything, and a pinch that arrives before a dwell timer elapses used
    // to go unclaimed by the UI entirely, falling through to the draw code
    // as an ordinary stroke-starting pinch instead of pressing the button
    // being looked at.
    const gazePress = await page.evaluate(() => {
      const app = window.ARFIGHT;
      const Vec3 = app.head.position.constructor;
      const Quat = app.head.quaternion.constructor;

      app.ui.update(1 / 60, app.head.position, app.head.quaternion, []);
      const button = app.ui.buttons[0];
      if (!button) return { error: 'no buttons available' };
      const at = button.mesh.getWorldPosition(new Vec3());

      // Aim the head straight at the button; the hand stays far from it, so
      // this can only reach the gaze path, never direct touch.
      const dir = at.clone().sub(app.head.position).normalize();
      const quat = new Quat().setFromUnitVectors(new Vec3(0, 0, -1), dir);
      const farAway = new Vec3(5, 5, 5);
      const hand = { visible: true, indexTip: farAway, pinchPoint: farAway, pinching: false };
      const strokesBefore = app.drawing.strokes.length;

      // Frame 1: gaze lands on the button, not pinching yet — zero dwell so far.
      app.ui.update(1 / 60, app.head.position, quat, [hand]);

      // Frame 2: pinch closes on the very next frame, well before any dwell
      // timer could have elapsed.
      hand.pinching = true;
      const pressed = app.ui.update(1 / 60, app.head.position, quat, [hand]);
      const consumed = app.ui.pinchConsumed;

      app._updateDraw(hand);
      const strokeLeaked = app.drawing.active !== null || app.drawing.strokes.length !== strokesBefore;

      return { pressed, consumed, strokeLeaked, buttonId: button.id };
    });
    check(gazePress.pressed === gazePress.buttonId,
      'gaze+pinch fires the instant the pinch lands, no minimum dwell required',
      `got ${JSON.stringify(gazePress)}`);
    check(gazePress.consumed === true, 'a same-frame gaze+pinch is marked consumed by the UI');
    check(gazePress.strokeLeaked === false, 'a same-frame gaze+pinch does not leak through to drawing');

    // --- Press DONE the way a player actually does: touch the button and
    // pinch, through WorldUI.update() itself, not by calling _onButton
    // directly. This is the path that broke — DONE, Undo and Clear all sat
    // out of arm's reach, so a pinch aimed at them fell through to the
    // drawing code and started a stroke instead of pressing anything.
    const uiPress = await page.evaluate(() => {
      const app = window.ARFIGHT;
      const Vec3 = app.head.position.constructor;

      // Settle the panel in front of the head, then find DONE in world space.
      app.ui.update(1 / 60, app.head.position, app.head.quaternion, []);
      const button = app.ui.buttons.find((b) => b.id === 'done-draw');
      if (!button) return { error: 'done-draw button not found' };
      const at = button.mesh.getWorldPosition(new Vec3());

      const hand = { visible: true, indexTip: at.clone(), pinchPoint: at.clone(), pinching: false };
      const strokesBefore = app.drawing.strokes.length;

      // Frame 1: touching, not yet pinching — hover only.
      const idle = app.ui.update(1 / 60, app.head.position, app.head.quaternion, [hand]);

      // Frame 2: pinch closes on the button.
      hand.pinching = true;
      const pressed = app.ui.update(1 / 60, app.head.position, app.head.quaternion, [hand]);
      const consumedDuringPinch = app.ui.pinchConsumed;

      // Mirror what the real loop does next: state code sees the same pinch.
      // It must be swallowed, not read as the start of a stroke.
      app._updateDraw(hand);
      const strokeLeaked = app.drawing.active !== null || app.drawing.strokes.length !== strokesBefore;

      if (pressed) app._onButton(pressed);
      const state = app.fsm.current;

      // Frame 3: release. The latch must clear so the next real pinch draws.
      hand.pinching = false;
      app.ui.update(1 / 60, app.head.position, app.head.quaternion, [hand]);

      return {
        idle, pressed, consumedDuringPinch, strokeLeaked, state,
        pinchConsumedAfterRelease: app.ui.pinchConsumed,
      };
    });
    check(uiPress.idle === null, 'touching a button without pinching does not press it');
    check(uiPress.pressed === 'done-draw', 'pinching on DONE presses it',
      `got ${JSON.stringify(uiPress.pressed)}`);
    check(uiPress.consumedDuringPinch === true, 'the pinch is marked consumed by the UI');
    check(uiPress.strokeLeaked === false, 'the same pinch does not also start a stroke');
    check(uiPress.state === 'categorize', 'DONE actually advances the flow',
      `state=${uiPress.state}`);
    check(uiPress.pinchConsumedAfterRelease === false, 'the latch clears once the pinch opens');

    // Classify as a gun and tag all three anchors.
    const tagged = await page.evaluate(() => {
      const app = window.ARFIGHT;
      const Vec3 = app.head.position.constructor;
      app._onButton('cat-gun');

      const snap = (x, y, z) => app.drawing.nearestPoint(new Vec3(x, y, z), 0.2)?.point;

      app.weapon.setAnchor('grip', snap(0, -0.10, -0.5));
      app.weapon.setAnchor('trigger', snap(0, -0.04, -0.5));
      app.weapon.setAnchor('muzzle', snap(0, 0, -0.72));
      const complete = app.weapon.taggingComplete;
      app._equipWeapon();

      const forward = app.rig.getForward(new Vec3());
      const muzzle = app.rig.getTipPosition(new Vec3());
      return {
        complete,
        state: app.fsm.current,
        category: app.weapon.category,
        // The barrel runs along -Z, so the bore should too.
        boreAlignment: forward.z,
        muzzle: [muzzle.x, muzzle.y, muzzle.z],
      };
    });
    check(tagged.complete, 'all three gun anchors tagged');
    check(tagged.state === 'equip', 'reaches the equipped state', `state=${tagged.state}`);
    check(tagged.boreAlignment < -0.95, 'bore axis follows the drawn barrel',
      `forward.z=${tagged.boreAlignment?.toFixed(3)}`);

    await page.waitForTimeout(400);

    // Fire, and confirm a round is actually live in the pool.
    const fired = await page.evaluate(() => {
      const app = window.ARFIGHT;
      app.gun.fire(app.head.quaternion);
      const live = Array.from(app.projectiles.lives).filter((l) => l > 0).length;
      return { live, shots: app.gun.shotsFired, recoil: app.rig.recoil };
    });
    check(fired.live === 1, 'firing spawns a projectile', `live=${fired.live}`);
    check(fired.recoil > 0, 'firing applies recoil');

    if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, '2-equipped.png') });

    // --- Mono toggle and resize must not break the render loop.
    console.log('\nRobustness');
    await page.click('#btn-stereo');
    await page.waitForTimeout(250);
    const mono = await page.evaluate(() => ({
      stereo: window.ARFIGHT.renderer.stereo,
      statusVisible: !document.getElementById('status').hidden,
    }));
    check(mono.stereo === false, 'stereo toggles off');
    check(mono.statusVisible, 'status line appears in mono mode');

    await page.setViewportSize({ width: 640, height: 1000 }); // portrait
    await page.waitForTimeout(300);
    const portraitGate = await page.evaluate(() => ({
      rotateGateHidden: document.getElementById('rotate-gate').hidden,
    }));
    check(portraitGate.rotateGateHidden === false, 'rotate gate appears when held upright');
    if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, '4-rotate-gate.png') });

    await page.setViewportSize({ width: 1000, height: 500 }); // back to landscape
    await page.waitForTimeout(300);
    const landscapeGate = await page.evaluate(() => ({
      rotateGateHidden: document.getElementById('rotate-gate').hidden,
    }));
    check(landscapeGate.rotateGateHidden === true, 'rotate gate clears once landscape again');

    const after = await page.evaluate(() => {
      const r = window.ARFIGHT.renderer;
      return {
        frames: r.renderer.info.render.frame,
        contextLost: r.renderer.getContext().isContextLost(),
        eyeAspect: r.eyeAspect,
      };
    });
    check(after.frames > gl.frames, 'still rendering after resize',
      `${gl.frames} -> ${after.frames}`);
    check(!after.contextLost, 'context survived the resize');

    // --- The manual "camera looks sideways" fix: tapping it must actually
    // change what the shader samples, and the render loop must keep running.
    const rotate = await page.evaluate(() => {
      const app = window.ARFIGHT;
      const btn = document.getElementById('btn-fliprot');
      const before = app.videoRotation;
      const wasManual = app._videoRotationManual;
      const labelBefore = btn.textContent;
      btn.click();
      const labelAfter = btn.textContent;
      // A landscape-shaped-but-180°-off stream is indistinguishable from a
      // correct one by aspect ratio alone (see _autoDetectVideoRotation), so
      // it can only ever be fixed by the player tapping through to 180° —
      // the label has to actually show that state, or there is no way to
      // tell the second tap did anything.
      btn.click();
      return {
        before,
        after: app.videoRotation,
        manualAfter: app._videoRotationManual,
        wasManual,
        frameMapRotation: app.frameMap.rotation,
        shaderUniform: app.renderer.bgUniforms.uVideoRotation.value,
        labelBefore,
        labelAfter,
        labelAfterTwoTaps: btn.textContent,
      };
    });
    check(rotate.wasManual === false, 'rotation starts on the auto-guess');
    check(rotate.labelBefore === `${rotate.before * 90}°`, 'flip button label matches the starting rotation',
      `${rotate.labelBefore} for ${rotate.before}`);
    check(rotate.after === (rotate.before + 2) % 4, 'tapping the button twice advances by two turns',
      `${rotate.before} -> ${rotate.after}`);
    check(rotate.manualAfter === true, 'tapping the button marks the choice as manual');
    check(rotate.frameMapRotation === rotate.after, 'VideoFrameMap picks up the new rotation');
    check(rotate.shaderUniform === rotate.after, 'the shader uniform matches it');
    check(rotate.labelAfter === `${((rotate.before + 1) % 4) * 90}°`, 'flip button label updates after the first tap',
      rotate.labelAfter);
    check(rotate.labelAfterTwoTaps === `${rotate.after * 90}°`, 'flip button label reflects the rotation after two taps',
      rotate.labelAfterTwoTaps);

    await page.waitForTimeout(250);
    const afterRotate = await page.evaluate(() => ({
      frames: window.ARFIGHT.renderer.renderer.info.render.frame,
      contextLost: window.ARFIGHT.renderer.renderer.getContext().isContextLost(),
    }));
    check(afterRotate.frames > after.frames, 'still rendering after rotating the video');
    check(!afterRotate.contextLost, 'context survived the rotation change');

    // --- The manual mirror toggle: no combination of 90° rotations can undo
    // a reflection, so a mirrored feed needs this separate control — check it
    // actually flips frameMap.mirrorX, reaches the shader, and shows on/off.
    const mirror = await page.evaluate(() => {
      const app = window.ARFIGHT;
      const btn = document.getElementById('btn-mirror');
      const before = app.frameMap.mirrorX;
      btn.click();
      const afterOne = {
        mirrorX: app.frameMap.mirrorX,
        shaderUniform: app.renderer.bgUniforms.uMirror.value,
        hasOnClass: btn.classList.contains('on'),
      };
      btn.click();
      return {
        before,
        afterOne,
        afterTwo: { mirrorX: app.frameMap.mirrorX, hasOnClass: btn.classList.contains('on') },
      };
    });
    check(mirror.afterOne.mirrorX === !mirror.before, 'tapping mirror flips frameMap.mirrorX',
      `${mirror.before} -> ${mirror.afterOne.mirrorX}`);
    check(mirror.afterOne.shaderUniform === (mirror.afterOne.mirrorX ? 1 : 0),
      'the mirror shader uniform matches it');
    check(mirror.afterOne.hasOnClass === mirror.afterOne.mirrorX, 'mirror button shows on/off state');
    check(mirror.afterTwo.mirrorX === mirror.before, 'tapping mirror again undoes it');
    check(mirror.afterTwo.hasOnClass === mirror.afterTwo.mirrorX, 'mirror button state matches after undo');

    // Resizing again must not silently revert the player's manual choice.
    await page.setViewportSize({ width: 900, height: 450 });
    await page.waitForTimeout(250);
    const stuck = await page.evaluate(() => window.ARFIGHT.videoRotation);
    check(stuck === rotate.after, 'the manual rotation survives a resize',
      `expected ${rotate.after}, got ${stuck}`);

    // On some browsers `screen.orientation.lock()` resolves without firing
    // the 'change' event HeadTracker's angle compensation refreshes from,
    // which can leave it stuck reporting a portrait angle after the page has
    // already gone landscape — the CSS layout and the 3D scene's idea of
    // "up" then disagree, and every world-space panel (the UI, the weapon)
    // renders visibly rolled relative to the screen-locked video background.
    // A resize is the independent, always-fires signal this self-corrects
    // from, so simulate exactly that stuck state and confirm it heals.
    const screenAngleFix = await page.evaluate(() => {
      const head = window.ARFIGHT.head;
      Object.defineProperty(screen.orientation, 'angle', { value: 0, configurable: true });
      const isLandscape = window.innerWidth > window.innerHeight;
      head.refreshScreenAngle();
      return { angleDeg: (head._screenAngle * 180) / Math.PI, isLandscape };
    });
    check(
      !screenAngleFix.isLandscape || screenAngleFix.angleDeg === 90,
      'head-tracking angle self-corrects when stuck at a portrait value on a landscape layout',
      `landscape=${screenAngleFix.isLandscape}, angle=${screenAngleFix.angleDeg}`,
    );

    // Start a fresh weapon: exercises teardown, which is where leaks hide.
    await page.evaluate(() => window.ARFIGHT._startNewWeapon());
    await page.waitForTimeout(250);
    const restarted = await page.evaluate(() => ({
      state: window.ARFIGHT.fsm.current,
      strokes: window.ARFIGHT.drawing.strokes.length,
      weapon: window.ARFIGHT.weapon,
    }));
    check(restarted.state === 'draw', 'restart returns to drawing');
    check(restarted.strokes === 0, 'restart clears the sketch');
    check(restarted.weapon === null, 'restart releases the weapon');

    // --- Paper tracing: the whole gesture-hold -> capture -> convert path,
    // exercised against the real (fake-device) camera frame. The exact
    // shapes Chromium's synthetic test pattern happens to contain are not
    // asserted on — that is what the PaperTrace unit tests pin down with
    // controlled pixel data — only that holding the gesture for less than
    // the required time does nothing, and holding it long enough drives the
    // app to one well-defined outcome or the other without throwing.
    console.log('\nPaper trace');
    const heldTooShort = await page.evaluate(async () => {
      const app = window.ARFIGHT;
      app.pointerHand.thumbsUp = true;
      await new Promise((r) => setTimeout(r, 150));
      app.pointerHand.thumbsUp = false;
      await new Promise((r) => setTimeout(r, 50));
      return { state: app.fsm.current, strokes: app.drawing.strokes.length };
    });
    check(heldTooShort.state === 'draw' && heldTooShort.strokes === 0,
      'a thumbs-up held under the threshold does nothing',
      JSON.stringify(heldTooShort));

    const holdMs = await page.evaluate(() => window.ARFIGHT_CONFIG.paperTrace.holdMs);
    const held = await page.evaluate(async (ms) => {
      const app = window.ARFIGHT;
      app.pointerHand.thumbsUp = true;
      await new Promise((r) => setTimeout(r, ms + 250));
      app.pointerHand.thumbsUp = false;
      return {
        state: app.fsm.current,
        strokes: app.drawing.strokes.length,
        promptTitle: app.ui.prompt.title,
      };
    }, holdMs);
    const capturedWeapon = held.state === 'categorize' && held.strokes > 0;
    const reportedNothingFound = held.state === 'draw' && held.strokes === 0 && !!held.promptTitle;
    check(capturedWeapon || reportedNothingFound,
      'a sustained thumbs-up either captures a weapon or reports nothing found',
      JSON.stringify(held));

    // However that landed, get back to a clean draw state for the shot below.
    await page.evaluate(() => window.ARFIGHT._startNewWeapon());
    await page.waitForTimeout(150);

    if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, '3-mono.png') });

    // --- Nothing should have thrown along the way.
    console.log('\nConsole');
    check(pageErrors.length === 0, 'no uncaught exceptions',
      pageErrors.join('\n        '));

    // Probes for the optional local MediaPipe copy are *meant* to 404 when
    // fetch-deps has not been run; a 404 on anything else is a broken path.
    const expected404 = /^\/(vendor\/mediapipe\/|models\/hand_landmarker\.task|favicon\.ico)/;
    const unexpected404 = [...new Set(notFound)].filter((p) => !expected404.test(p));
    check(unexpected404.length === 0, 'every first-party asset resolves',
      unexpected404.join(', '));

    // A 404 surfaces as a console error too; drop those alongside the CDN
    // failures this sandbox cannot avoid.
    const realErrors = consoleErrors.filter(
      (e) => !/mediapipe|jsdelivr|Failed to fetch|net::ERR|hand tracking|404 \(Not Found\)/i.test(e),
    );
    check(realErrors.length === 0, 'no unexpected console errors',
      realErrors.join('\n        '));

    if (notFound.length) {
      console.log(`  note  optional assets absent (expected): ${[...new Set(notFound)].join(', ')}`);
    }
    console.log('  note  MediaPipe CDN is unreachable here, so the pointer fallback was exercised');
  } finally {
    await browser?.close();
    server.kill();
  }

  console.log(`\n${failures === 0 ? 'smoke test passed' : `${failures} check(s) failed`}`);
  if (SHOTS) console.log(`screenshots in ${path.relative(ROOT, SHOT_DIR)}/`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nsmoke test errored: ${err.message}`);
  process.exit(1);
});
