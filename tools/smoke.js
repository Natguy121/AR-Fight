#!/usr/bin/env node
/**
 * Boots the real page in headless Chromium and drives it with a fake camera.
 *
 * `npm test` covers the maths but cannot touch WebGL, canvas text, or the DOM
 * wiring — and a shader that fails to compile is invisible until the page is
 * black on a phone. This runs the actual application: it compiles the
 * passthrough, restyle and distortion shaders, renders frames, and exercises
 * transform / change / off.
 *
 *   npm run smoke              # headless
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
  const server = spawn(
    process.execPath,
    [path.join(__dirname, 'serve.js'), '--http', '--port', String(PORT)],
    { cwd: ROOT, stdio: 'ignore' },
  );

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

    // ---------------------------------------------------------------- boot
    console.log('\nBoot');
    await page.goto(BASE, { waitUntil: 'load' });
    check(await page.locator('#gate').isVisible(), 'gate screen renders');

    // Hand tracking needs a CDN this sandbox cannot reach; the pointer/gaze
    // fallback is the path under test here anyway.
    await page.click('#gate-start');
    await page.waitForFunction(() => window.ARRESKIN?.running === true, null, { timeout: 45000 });
    check(true, 'session starts with a fake camera');

    const boot = await page.evaluate(() => ({
      stereo: window.ARRESKIN.renderer.stereo,
      videoW: window.ARRESKIN.cameraFeed.width,
      videoH: window.ARRESKIN.cameraFeed.height,
      videoFlipY: window.ARRESKIN.cameraFeed.texture?.flipY,
      texel: window.ARRESKIN.renderer.bgUniforms.uTexel.value.toArray(),
      controlsVisible: !document.getElementById('controls').hidden,
    }));
    check(boot.videoW > 0 && boot.videoH > 0, 'camera reports a frame size',
      `got ${boot.videoW}x${boot.videoH}`);
    // BACKGROUND_FRAG's UV math assumes flipY=false (see CameraFeed) — the
    // default (true) silently renders passthrough upside down for everyone,
    // on every device, regardless of any rotation/mirror setting.
    check(boot.videoFlipY === false, 'video texture has flipY disabled to match the background shader');
    check(boot.stereo === true, 'starts in stereo headset mode');
    check(boot.controlsVisible, 'in-session controls appear');
    // Edge detection taps neighbouring source pixels; a stale default texel
    // would make outlines blurry or invisible without any error.
    check(Math.abs(boot.texel[0] - 1 / boot.videoW) < 1e-9,
      'edge-detection texel size matches the real capture resolution',
      `texel ${boot.texel} for ${boot.videoW}x${boot.videoH}`);

    // ----------------------------------------------------------- rendering
    console.log('\nRendering');
    await page.waitForTimeout(400);
    const gl = await page.evaluate(() => {
      const r = window.ARRESKIN.renderer.renderer;
      return {
        frames: r.info.render.frame,
        calls: r.info.render.calls,
        programs: r.info.programs?.length ?? 0,
        contextLost: r.getContext().isContextLost(),
      };
    });
    check(gl.frames > 0, 'render loop is producing frames', `frames=${gl.frames}`);
    check(gl.calls > 0, 'draw calls are being issued');
    check(!gl.contextLost, 'WebGL context is healthy');
    // Passthrough+restyle and distortion. If the restyle GLSL fails to
    // compile, this is where it shows up rather than as a black headset.
    check(gl.programs >= 2, 'shader programs linked (passthrough+restyle, distortion)',
      `programs=${gl.programs}`);
    const shaderErrors = consoleErrors.filter((e) => /shader|glsl|program|compile/i.test(e));
    check(shaderErrors.length === 0, 'no shader compile errors', shaderErrors.join('\n        '));

    if (SHOTS) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(SHOT_DIR, '1-untouched.png') });
    }

    // -------------------------------------------------------------- reskin
    console.log('\nReskin');
    // The room's own material now lives in row 0 of the class atlas rather
    // than in loose uniforms, so these read it back from there.
    const readBase = () => page.evaluate(() => {
      const app = window.ARRESKIN;
      const atlas = app.renderer.classAtlas;
      const pd = atlas.paramTexture.image.data;
      const rd = atlas.rampTexture.image.data;
      const W = atlas.rampTexture.image.width;
      return {
        active: app.director.active,
        chroma: pd[0] / 255,
        rampDark: [rd[0], rd[1], rd[2]],
        rampBright: [rd[(W - 1) * 4], rd[(W - 1) * 4 + 1], rd[(W - 1) * 4 + 2]],
      };
    });

    const before = await readBase();
    check(before.active === false, 'starts with the room untouched');
    // The passthrough theme is the exact identity; chroma 1 over a linear
    // grey ramp is its signature.
    check(Math.abs(before.chroma - 1) < 0.01, 'untouched really means untouched (chroma 1)');
    check(before.rampDark[0] === 0 && before.rampBright[0] === 255,
      'and its ramp is the full linear grey', JSON.stringify(before));

    const transformed = await page.evaluate(async () => {
      const app = window.ARRESKIN;
      await app._transform({ change: false });
      // Let the cross-fade settle so the atlas holds the final theme.
      for (let i = 0; i < 120; i++) app.renderer.setTheme(app.director.update(1 / 60));
      const atlas = app.renderer.classAtlas;
      const rd = atlas.rampTexture.image.data;
      const W = atlas.rampTexture.image.width;
      return {
        active: app.director.active,
        id: app.director.target.id,
        name: app.director.target.name,
        chroma: atlas.paramTexture.image.data[0] / 255,
        rampDark: [rd[0], rd[1], rd[2]],
        rampBright: [rd[(W - 1) * 4], rd[(W - 1) * 4 + 1], rd[(W - 1) * 4 + 2]],
        objects: Object.keys(app.director.target.objects || {}),
      };
    });
    check(transformed.active === true, 'transform applies a theme', transformed.name);
    check(transformed.chroma < 0.9, 'the shader is actually repainting, not passing through',
      `chroma=${transformed.chroma}`);
    check(transformed.objects.length >= 2,
      'the theme carries a material for individual objects, not just the room',
      transformed.objects.join(', '));
    // The ramp must reach the atlas, or the world stays grey. It also has to
    // keep a real dark-to-bright spread, which is what carries the shading.
    const rampSpread = (transformed.rampBright.reduce((a, b) => a + b, 0)
      - transformed.rampDark.reduce((a, b) => a + b, 0)) / 255;
    check(rampSpread > 0.3, 'the colour ramp reached the shader lookup',
      `spread=${rampSpread.toFixed(2)}`);

    if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, '2-transformed.png') });

    // --- Object awareness. This is what separates a reskinned room from a
    // colour filter, so it is checked against a real photograph rather than
    // the synthetic camera: a cat sitting on a sofa, which DeepLab labels as
    // both. Skipped with a note when the model has not been vendored, since
    // `npm run fetch-deps` is optional and a fresh clone will not have it.
    const segAvailable = await page.evaluate(() => window.ARRESKIN.segmenter.available);
    if (!segAvailable) {
      console.log('  note  segmentation model absent — run `npm run fetch-deps` to cover this path');
    } else {
      const seg = await page.evaluate(async () => {
        const app = window.ARRESKIN;
        const img = new Image();
        img.src = '/tools/fixtures/cat-on-sofa.jpg';
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);

        // Drive the segmenter directly: the fake camera is a flat test
        // pattern with no objects in it, so it can never exercise this.
        app.segmenter._lastRunMs = -Infinity;
        const ran = app.segmenter.update(c, performance.now() + 5000, true);
        app.renderer.setSegmentationMask(app.segmenter.maskTexture);
        return {
          ran,
          detected: [...app.segmenter.detected].sort(),
          maskSize: [app.segmenter.maskWidth, app.segmenter.maskHeight],
          imageSize: [img.naturalWidth, img.naturalHeight],
          hasMask: app.renderer.bgUniforms.uHasMask.value,
        };
      });
      check(seg.ran === true, 'the segmenter labelled a real photograph');
      check(seg.detected.includes('sofa'),
        'it recognised the sofa the cat is sitting on', seg.detected.join(', '));
      check(seg.detected.includes('cat'), 'and the cat', seg.detected.join(', '));
      // The mask is sampled with the same uv as the video, so any mismatch
      // here would slide every object's material off the object it belongs to.
      check(seg.maskSize[0] === seg.imageSize[0] && seg.maskSize[1] === seg.imageSize[1],
        'the mask is the same resolution as the frame, so it lines up',
        `${seg.maskSize} vs ${seg.imageSize}`);
      check(seg.hasMask === 1, 'the mask reached the shader');

      // And the payoff: with that mask in place, two different classes must
      // actually resolve to two different materials in the atlas.
      const distinct = await page.evaluate(() => {
        const app = window.ARRESKIN;
        const atlas = app.renderer.classAtlas;
        const data = atlas.rampTexture.image.data;
        const W = atlas.rampTexture.image.width;
        const mid = (row) => {
          const o = (row * W + (W >> 1)) * 4;
          return [data[o], data[o + 1], data[o + 2]];
        };
        const theme = app.director.target;
        const names = Object.keys(theme.objects || {});
        const classes = window.__CLASSES;
        const base = mid(0);
        const diffs = names.map((n) => {
          const m = mid(classes.indexOf(n));
          return [n, Math.abs(m[0] - base[0]) + Math.abs(m[1] - base[1]) + Math.abs(m[2] - base[2])];
        });
        return { themeName: theme.name, diffs };
      });
      // This is a check on the *plumbing* — that each class ended up with its
      // own row and the rows are not all copies of row 0. Whether the themes
      // are well designed is settled deterministically over every theme by
      // `npm test`; here only one randomly chosen theme is loaded, so the bar
      // is set well below that test's floor to stay honest about what it can
      // actually prove.
      const weakest = distinct.diffs.reduce((lo, d) => (d[1] < lo[1] ? d : lo), ['none', Infinity]);
      check(distinct.diffs.length > 0 && weakest[1] > 20,
        'each recognised object gets its own row in the atlas, not a copy of the room',
        `${distinct.themeName}: weakest is ${weakest[0]} at ${weakest[1]}`);
    }

    // --- The guarantee the whole design is built around: looking around must
    // never re-decide the material. Simulated here by driving the head through
    // a full rotation over hundreds of frames, exactly as turning away and
    // back would, and confirming nothing about the style moved.
    const afterLooking = await page.evaluate(async (expectedId) => {
      const app = window.ARRESKIN;
      const Quat = app.head.quaternion.constructor;
      const Vec3 = app.head.position.constructor;
      const axis = new Vec3(0, 1, 0);
      for (let i = 0; i < 600; i++) {
        // Sweep a full turn and back, the way a wearer would look around.
        app.head.quaternion.copy(new Quat().setFromAxisAngle(axis, (i / 600) * Math.PI * 2));
        app.director.update(1 / 60);
      }
      return { id: app.director.target.id, active: app.director.active, pending: app.director.pending };
    }, transformed.id);
    check(afterLooking.id === transformed.id,
      'looking all the way around does not change the material',
      `${transformed.id} -> ${afterLooking.id}`);
    check(afterLooking.active === true, 'and it is still applied');

    const changed = await page.evaluate(async () => {
      const app = window.ARRESKIN;
      await app._transform({ change: true });
      return { id: app.director.target.id };
    });
    check(changed.id !== transformed.id, 'change picks a different material',
      `${transformed.id} -> ${changed.id}`);

    await page.evaluate(() => {
      const app = window.ARRESKIN;
      app._onButton('off');
      for (let i = 0; i < 120; i++) app.renderer.setTheme(app.director.update(1 / 60));
    });
    const off = await readBase();
    check(off.active === false, 'off returns to the untouched room');
    check(Math.abs(off.chroma - 1) < 0.01, 'and restores exact passthrough', `chroma=${off.chroma}`);

    // --- The choice has to outlive a reload, or every glance at the phone
    // resets the room. Re-apply, reload the page, and check it comes back.
    const remembered = await page.evaluate(async () => {
      const app = window.ARRESKIN;
      await app._transform({ change: false });
      return { id: app.director.target.id };
    });
    await page.reload({ waitUntil: 'load' });
    const restored = await page.evaluate(() => ({
      active: window.ARRESKIN.director.active,
      id: window.ARRESKIN.director.target.id,
    }));
    check(restored.active === true && restored.id === remembered.id,
      'the material survives a reload',
      `${remembered.id} -> ${restored.id} (active=${restored.active})`);

    // Back into a live session for the robustness checks below.
    await page.click('#gate-start');
    await page.waitForFunction(() => window.ARRESKIN?.running === true, null, { timeout: 45000 });

    // ---------------------------------------------------------- robustness
    console.log('\nRobustness');
    await page.click('#btn-stereo');
    check(await page.evaluate(() => window.ARRESKIN.renderer.stereo === false), 'stereo toggles off');
    check(await page.locator('#status').isVisible(), 'status line appears in mono mode');

    await page.setViewportSize({ width: 420, height: 720 });
    await page.waitForTimeout(250);
    check(await page.locator('#rotate-gate').isVisible(), 'rotate gate appears when held upright');
    await page.setViewportSize({ width: 900, height: 450 });
    await page.waitForTimeout(250);
    check(await page.locator('#rotate-gate').isHidden(), 'rotate gate clears once landscape again');

    const afterResize = await page.evaluate(() => ({
      frames: window.ARRESKIN.renderer.renderer.info.render.frame,
      contextLost: window.ARRESKIN.renderer.renderer.getContext().isContextLost(),
    }));
    check(!afterResize.contextLost, 'context survived the resize');

    // --- The manual "camera looks sideways" fix, and the separate mirror
    // toggle: rotation alone is a proper-rotation-only fix, so no number of
    // 90° turns can undo a reflected feed.
    const rotate = await page.evaluate(() => {
      const app = window.ARRESKIN;
      const btn = document.getElementById('btn-fliprot');
      const before = app.videoRotation;
      const labelBefore = btn.textContent;
      btn.click();
      return {
        before,
        after: app.videoRotation,
        manual: app._videoRotationManual,
        frameMapRotation: app.frameMap.rotation,
        shaderUniform: app.renderer.bgUniforms.uVideoRotation.value,
        labelBefore,
        labelAfter: btn.textContent,
      };
    });
    check(rotate.after === (rotate.before + 1) % 4, 'tapping the flip button advances one turn');
    check(rotate.manual === true, 'tapping marks the choice as manual');
    check(rotate.frameMapRotation === rotate.after && rotate.shaderUniform === rotate.after,
      'rotation reaches both the frame map and the shader');
    check(rotate.labelAfter === `${rotate.after * 90}°`, 'flip button label reflects the rotation',
      rotate.labelAfter);

    const mirror = await page.evaluate(() => {
      const app = window.ARRESKIN;
      const btn = document.getElementById('btn-mirror');
      const before = app.frameMap.mirrorX;
      btn.click();
      return {
        before,
        after: app.frameMap.mirrorX,
        uniform: app.renderer.bgUniforms.uMirror.value,
        onClass: btn.classList.contains('on'),
      };
    });
    check(mirror.after === !mirror.before, 'mirror toggles');
    check(mirror.uniform === (mirror.after ? 1 : 0), 'mirror reaches the shader');
    check(mirror.onClass === mirror.after, 'mirror button shows its state');

    // On some browsers `screen.orientation.lock()` resolves without firing the
    // 'change' event HeadTracker's angle compensation refreshes from, leaving
    // it stuck on a portrait angle after the page went landscape — every
    // world-space panel then renders visibly rolled. A resize is the
    // independent, always-fires signal it self-corrects from.
    const screenAngleFix = await page.evaluate(() => {
      const head = window.ARRESKIN.head;
      Object.defineProperty(screen.orientation, 'angle', { value: 0, configurable: true });
      const isLandscape = window.innerWidth > window.innerHeight;
      head.refreshScreenAngle();
      return { angleDeg: (head._screenAngle * 180) / Math.PI, isLandscape };
    });
    check(!screenAngleFix.isLandscape || screenAngleFix.angleDeg === 90,
      'head-tracking angle self-corrects when stuck at a portrait value',
      `landscape=${screenAngleFix.isLandscape}, angle=${screenAngleFix.angleDeg}`);

    // The fullscreen+orientation-lock attempt must never break the session —
    // headless Chromium, and all of iOS Safari, reject it outright.
    const forceLandscape = await page.evaluate(async () => {
      const app = window.ARRESKIN;
      let threw = null;
      try {
        await app._tryForceLandscape();
      } catch (e) {
        threw = String(e);
      }
      return { threw, running: app.running };
    });
    check(forceLandscape.threw === null, 'force-landscape never throws to its caller',
      forceLandscape.threw || '');
    check(forceLandscape.running === true, 'session is unaffected whether or not it succeeded');

    if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, '3-mono.png') });

    // -------------------------------------------------------------- console
    console.log('\nConsole');
    check(pageErrors.length === 0, 'no uncaught exceptions', pageErrors.join('\n        '));

    // Probes for the optional local MediaPipe copy are *meant* to 404 when
    // fetch-deps has not been run; a 404 on anything else is a broken path.
    const expected404 = /^\/(vendor\/mediapipe\/|models\/(hand_landmarker\.task|deeplab_v3\.tflite)|favicon\.ico)/;
    const unexpected404 = [...new Set(notFound)].filter((p) => !expected404.test(p));
    check(unexpected404.length === 0, 'every first-party asset resolves', unexpected404.join(', '));

    const realErrors = consoleErrors.filter(
      (e) => !/mediapipe|jsdelivr|Failed to fetch|net::ERR|hand tracking|404 \(Not Found\)/i.test(e),
    );
    check(realErrors.length === 0, 'no unexpected console errors', realErrors.join('\n        '));

    if (notFound.length) {
      console.log(`  note  optional assets absent (expected): ${[...new Set(notFound)].join(', ')}`);
    }
    // Which MediaPipe path this run actually took. Worth stating plainly: with
    // the vendored copy present these checks cover real inference, and without
    // it they cover the fallbacks instead — two quite different runs.
    const mp = await page.evaluate(() => ({
      hands: window.ARRESKIN.handTracker.available,
      seg: window.ARRESKIN.segmenter.available,
    }));
    console.log(`  note  hand tracking ${mp.hands ? 'loaded' : 'unavailable — pointer/gaze fallback exercised'}`);
    console.log(`  note  segmentation ${mp.seg ? 'loaded — object recognition covered' : 'unavailable — whole-room fallback exercised'}`);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }

  console.log(failures === 0 ? '\nsmoke test passed' : `\nsmoke test FAILED (${failures})`);
  if (SHOTS) console.log(`screenshots in ${path.relative(ROOT, SHOT_DIR)}/`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error('\nsmoke test errored:', err.message);
  process.exit(1);
});
