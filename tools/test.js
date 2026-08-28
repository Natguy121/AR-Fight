#!/usr/bin/env node
/**
 * Headless checks for the parts of Remade that are hard to eyeball.
 *
 * Everything here runs without a GPU or a camera: the camera-to-world
 * mapping, the head-orientation filtering, the hand depth solver, and the
 * style pipeline. These are the pieces whose bugs would otherwise only show
 * up as "the room looks subtly wrong" while wearing a headset, which is a
 * miserable way to debug.
 *
 *   npm test
 */

import * as THREE from 'three';
import assert from 'node:assert/strict';

import config from '../src/config.js';
import { VideoFrameMap } from '../src/core/VideoFrameMap.js';
import { HeadTracker } from '../src/core/HeadTracker.js';
import { angleAt } from '../src/util/math3d.js';
import { OneEuroFilter } from '../src/util/OneEuroFilter.js';
import { HandPose } from '../src/hands/HandPose.js';
import { LM } from '../src/hands/HandTracker.js';

import {
  makeStyle, lerpStyle, passthroughStyle, parseColor, normaliseRamp, TEXTURES,
} from '../src/style/Style.js';
import { restyleColorCPU } from '../src/render/Restyle.js';
import { StyleDirector, PresetSource } from '../src/style/StyleDirector.js';
import { STYLES } from '../src/style/StyleLibrary.js';
import { extractStyle } from '../src/style/ClaudeStylist.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}`);
  }
}

/** Same, for a test whose body needs to await something. */
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}`);
  }
}

function group(name) {
  console.log(`\n${name}`);
}

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);

// ---------------------------------------------------------------------------
group('math3d');

test('angleAt measures a straight line as 180 degrees', () => {
  const a = new THREE.Vector3(-1, 0, 0);
  const b = new THREE.Vector3(0, 0, 0);
  const c = new THREE.Vector3(1, 0, 0);
  near(angleAt(a, b, c), 180, 1e-6);
});

test('angleAt measures a right angle', () => {
  const a = new THREE.Vector3(1, 0, 0);
  const b = new THREE.Vector3(0, 0, 0);
  const c = new THREE.Vector3(0, 1, 0);
  near(angleAt(a, b, c), 90, 1e-6);
});

test('angleAt treats a degenerate span as straight rather than throwing', () => {
  const p = new THREE.Vector3(1, 2, 3);
  assert.equal(angleAt(p, p.clone(), new THREE.Vector3(0, 0, 0)), 180);
});

test('OneEuroFilter converges on a constant signal', () => {
  const f = new OneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: 1 });
  let v = 0;
  for (let i = 0; i < 200; i++) v = f.filter(5, i / 60);
  near(v, 5, 1e-3, 'settles to the input');
});
// ---------------------------------------------------------------------------
group('Barrel distortion (StereoRenderer)');

/**
 * Mirrors the radial sample factor computed in DISTORT_FRAG
 * (src/core/StereoRenderer.js): `s = d * (1 + k1 r^2 + k2 r^4)`. GLSL cannot
 * run here, so this pure-JS copy is what actually gets tested — if the two
 * drift apart, re-sync this from the shader source.
 */
function distortionFactor(r, k1, k2) {
  const r2 = r * r;
  return 1 + k1 * r2 + k2 * r2 * r2;
}

test('distortion is the identity at screen centre', () => {
  const { distortionK1: k1, distortionK2: k2 } = config.stereo;
  // This is the whole invariant: r=0 must sample r=0. A shader that scales
  // this away from 1 magnifies (or shrinks) the entire view uniformly, worst
  // exactly where the user is looking — a bug shipped once already, when an
  // edge-fill normalisation divided the whole curve by its r=1 value and
  // dragged the centre down to ~0.77, i.e. a ~1.3x zoom across the screen.
  near(distortionFactor(0, k1, k2), 1, 1e-9, 'factor(0)');
});

test('distortion factor increases monotonically outward', () => {
  const { distortionK1: k1, distortionK2: k2 } = config.stereo;
  let prev = distortionFactor(0, k1, k2);
  for (let r = 0.05; r <= 1.5; r += 0.05) {
    const f = distortionFactor(r, k1, k2);
    assert.ok(f >= prev - 1e-9, `factor should not decrease outward (r=${r})`);
    prev = f;
  }
});

// ---------------------------------------------------------------------------
group('VideoFrameMap');

/** Video wider than the eye viewport, and matched FOVs: reconstruction is exact. */
function makeFrameMap() {
  const map = new VideoFrameMap();
  map.setVideoAspect(16 / 9);
  map.setDisplay(1.0, config.camera.verticalFovDeg);
  return map;
}

test('unproject inverts the camera projection exactly', () => {
  const map = makeFrameMap();
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(config.camera.verticalFovDeg) / 2);
  const depth = 0.5;

  for (const [ax, ay] of [[0, 0], [0.3, 0.2], [-0.45, 0.31], [0.1, -0.4]]) {
    // Project a known camera-space point down to video-normalised coordinates.
    const u = 0.5 + ax / (2 * tanHalf * map.videoAspect);
    const v = 0.5 - ay / (2 * tanHalf);
    const p = map.unproject(u, v, depth);
    near(p.x, ax * depth, 1e-9, 'x');
    near(p.y, ay * depth, 1e-9, 'y');
    near(p.z, -depth, 1e-9, 'z');
  }
});

test('unprojected points land under the same pixel through a real camera', () => {
  const map = makeFrameMap();
  const cam = new THREE.PerspectiveCamera(config.camera.verticalFovDeg, 1.0, 0.01, 100);
  cam.updateMatrixWorld(true);

  const u = 0.62;
  const v = 0.38;
  const expected = map.videoToNdc(u, v, new THREE.Vector2());

  for (const depth of [0.2, 0.5, 1.0]) {
    const world = map.unproject(u, v, depth).clone().project(cam);
    near(world.x, expected.x, 1e-6, `ndc x at depth ${depth}`);
    near(world.y, expected.y, 1e-6, `ndc y at depth ${depth}`);
  }
});

test('cover-fit crops the wider axis', () => {
  const wide = new VideoFrameMap();
  wide.setVideoAspect(2.0);
  wide.setDisplay(1.0, 70);
  near(wide.scaleX, 2.0, 1e-9, 'scaleX');
  near(wide.scaleY, 1.0, 1e-9, 'scaleY');

  const tall = new VideoFrameMap();
  tall.setVideoAspect(0.5);
  tall.setDisplay(1.0, 70);
  near(tall.scaleX, 1.0, 1e-9, 'scaleX');
  near(tall.scaleY, 2.0, 1e-9, 'scaleY');
});

// ---------------------------------------------------------------------------
group('Video rotation (frozen-orientation stream fix)');

/**
 * Mirrors `rotateToRaw` from BACKGROUND_FRAG in src/core/StereoRenderer.js.
 * GLSL cannot run here, so this pure-JS copy is what actually gets tested —
 * it must be the exact inverse of VideoFrameMap's own `_rotateToEffective`,
 * or the shader and the hand-tracking reconstruction (which both consume the
 * same rotated stream, one on the GPU and one on the CPU) drift apart the
 * moment rotation is anything but 0: the background would show correctly
 * rotated video while every drawn stroke landed 90/180/270 degrees off it.
 */
function rotateToRawGLSL(e, k) {
  if (k === 1) return { x: e.y, y: 1 - e.x };
  if (k === 2) return { x: 1 - e.x, y: 1 - e.y };
  if (k === 3) return { x: 1 - e.y, y: e.x };
  return { x: e.x, y: e.y };
}

test('the shader inverse exactly undoes VideoFrameMap for every rotation', () => {
  const map = new VideoFrameMap();
  const samples = [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5], [0.2, 0.8], [0.73, 0.1]];

  for (let k = 0; k < 4; k++) {
    map.setRotation(k);
    for (const [u, v] of samples) {
      const effective = { x: 0, y: 0 };
      map._rotateToEffective(u, v, effective);
      const back = rotateToRawGLSL(effective, k);
      near(back.x, u, 1e-9, `k=${k} u`);
      near(back.y, v, 1e-9, `k=${k} v`);
    }
  }
});

test('a quarter turn swaps which axis the cover fit treats as wide', () => {
  const map = new VideoFrameMap();
  map.setVideoAspect(16 / 9); // landscape source
  map.setDisplay(1.0, 70);    // square-ish display

  map.setRotation(0);
  near(map.effectiveAspect, 16 / 9, 1e-9, 'unrotated stays landscape');

  map.setRotation(1);
  near(map.effectiveAspect, 9 / 16, 1e-9, '90 degrees reads as portrait');

  map.setRotation(2);
  near(map.effectiveAspect, 16 / 9, 1e-9, '180 degrees stays landscape');

  map.setRotation(3);
  near(map.effectiveAspect, 9 / 16, 1e-9, '270 degrees reads as portrait');
});

test('setRotation normalises any integer into 0-3', () => {
  const map = new VideoFrameMap();
  map.setRotation(5);
  assert.equal(map.rotation, 1, '5 -> 1');
  map.setRotation(-1);
  assert.equal(map.rotation, 3, '-1 -> 3');
  map.setRotation(8);
  assert.equal(map.rotation, 0, '8 -> 0');
});

test('a rotated landmark still reprojects onto the pixel it came from', () => {
  // Same invariant as the unrotated reprojection test above, but with a 90
  // degree correction in effect — the whole point of threading rotation
  // through unproject() rather than patching it on separately.
  const map = new VideoFrameMap();
  map.setVideoAspect(16 / 9);
  map.setDisplay(1.0, config.camera.verticalFovDeg);
  map.setRotation(1);

  const cam = new THREE.PerspectiveCamera(config.camera.verticalFovDeg, 1.0, 0.01, 100);
  cam.updateMatrixWorld(true);

  const u = 0.62;
  const v = 0.38;
  const expected = map.videoToNdc(u, v, new THREE.Vector2());

  for (const depth of [0.2, 0.5, 1.0]) {
    const world = map.unproject(u, v, depth).clone().project(cam);
    near(world.x, expected.x, 1e-6, `ndc x at depth ${depth}`);
    near(world.y, expected.y, 1e-6, `ndc y at depth ${depth}`);
  }
});

// ---------------------------------------------------------------------------
group('HeadTracker rotation smoothing');

/** A HeadTracker with the sensor path forced on, bypassing DOM event wiring. */
function fakeHeadTracker() {
  const head = new HeadTracker(null);
  head.hasSensor = true;
  return head;
}

test('a still-but-noisy sensor is damped, not passed straight through', () => {
  const head = fakeHeadTracker();
  head._screenAngle = Math.PI / 2; // landscape, matches real use

  // A deterministic pseudo-random generator so this test is reproducible.
  let seed = 12345;
  const noise = (amplitudeRad) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return ((seed / 0x7fffffff) * 2 - 1) * amplitudeRad;
  };

  const rawDeltas = [];
  const smoothedDeltas = [];
  let prevRaw = null;
  let prevSmoothed = null;

  for (let i = 0; i < 180; i++) {
    // A hand held "still" still reads a couple of degrees of sensor noise.
    head._raw.alpha = noise(THREE.MathUtils.degToRad(2));
    head._raw.beta = noise(THREE.MathUtils.degToRad(2));
    head._raw.gamma = noise(THREE.MathUtils.degToRad(2));

    const raw = head._composeDeviceQuaternion(new THREE.Quaternion());
    const smoothed = head.update(i / 60).clone();

    if (prevRaw) {
      rawDeltas.push(THREE.MathUtils.radToDeg(prevRaw.angleTo(raw)));
      smoothedDeltas.push(THREE.MathUtils.radToDeg(prevSmoothed.angleTo(smoothed)));
    }
    prevRaw = raw;
    prevSmoothed = smoothed;
  }

  // Skip the initial settling window; steady-state behaviour is what matters.
  const steadyRaw = rawDeltas.slice(60);
  const steadySmoothed = smoothedDeltas.slice(60);
  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const avgRawJitter = avg(steadyRaw);
  const avgSmoothedJitter = avg(steadySmoothed);

  assert.ok(avgSmoothedJitter < avgRawJitter * 0.5,
    `expected smoothed frame-to-frame jitter well below raw; raw avg=${avgRawJitter.toFixed(3)}deg, smoothed avg=${avgSmoothedJitter.toFixed(3)}deg`);
});

test('a steady head turn is tracked with bounded lag, not left behind', () => {
  const head = fakeHeadTracker();
  head._screenAngle = Math.PI / 2;

  const degPerSec = 90; // a brisk but ordinary turn
  const dt = 1 / 60;
  let lastYaw = 0;

  for (let i = 0; i < 120; i++) { // 2 seconds — long enough to reach steady state
    const t = i * dt;
    head._raw.alpha = degPerSec * t * (Math.PI / 180);
    lastYaw = head._raw.alpha;
    head.update(t);
  }

  const forward = head.getForward(new THREE.Vector3());
  // alpha feeds yaw (rotation about world Y) via the YXZ Euler composition;
  // recover it the same way HeadTracker.recenter() does.
  const trackedYaw = Math.atan2(forward.x, -forward.z);
  const expectedYaw = ((-lastYaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const trackedYawNorm = ((trackedYaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let lagDeg = THREE.MathUtils.radToDeg(Math.abs(expectedYaw - trackedYawNorm));
  if (lagDeg > 180) lagDeg = 360 - lagDeg;

  // At beta=0.6, minCutoff=0.4 and 90deg/s, steady-state lag should settle
  // to a fraction of a frame's worth of motion, nowhere near a full second
  // behind — this is the "doesn't feel laggy while actually turning" half
  // of the trade-off the jitter test above covers the other half of.
  assert.ok(lagDeg < 15, `expected steady-state lag under 15deg at ${degPerSec}deg/s, got ${lagDeg.toFixed(2)}deg`);
});

test('recentre resets the smoother so the next frame snaps instead of gliding', () => {
  const head = fakeHeadTracker();
  head._screenAngle = Math.PI / 2;
  // beta=0 reads as the phone lying flat, screen up — forward ends up
  // pointing straight down, where yaw is undefined (the north-pole problem).
  // This app only runs held upright, matching a Cardboard shell: beta~90deg.
  head._raw.beta = Math.PI / 2;

  // Build up smoothed state pointing one way.
  for (let i = 0; i < 30; i++) {
    head._raw.alpha = 0;
    head.update(i / 60);
  }

  // Recentre while facing a very different direction.
  head._raw.alpha = Math.PI / 2; // 90deg yaw
  head.recenter();

  // Immediately after, "forward" must already read as straight ahead — not
  // partway through a multi-frame glide from the old orientation.
  head.update(30 / 60);
  const forward = head.getForward(new THREE.Vector3());
  const yaw = Math.atan2(forward.x, -forward.z);
  near(THREE.MathUtils.radToDeg(yaw), 0, 1, 'yaw should read ~0deg (straight ahead) on the very first post-recentre frame');
});

// ---------------------------------------------------------------------------
group('HandPose depth solver');

/**
 * A plausible right hand, palm in the XY plane, fingers along +Y, in metres.
 * Only the relative geometry matters to the solver.
 */
function buildHandModel() {
  const p = (x, y, z) => new THREE.Vector3(x, y, z);
  const lm = new Array(21);
  lm[LM.WRIST] = p(0, -0.045, 0);
  lm[LM.THUMB_CMC] = p(-0.022, -0.028, 0.006);
  lm[LM.THUMB_MCP] = p(-0.038, -0.006, 0.010);
  lm[LM.THUMB_IP] = p(-0.048, 0.014, 0.012);
  lm[LM.THUMB_TIP] = p(-0.054, 0.032, 0.013);
  lm[LM.INDEX_MCP] = p(-0.020, 0.038, 0);
  lm[LM.INDEX_PIP] = p(-0.023, 0.070, -0.002);
  lm[LM.INDEX_DIP] = p(-0.025, 0.091, -0.004);
  lm[LM.INDEX_TIP] = p(-0.026, 0.108, -0.006);
  lm[LM.MIDDLE_MCP] = p(0.001, 0.043, 0);
  lm[LM.MIDDLE_PIP] = p(0.001, 0.077, -0.002);
  lm[LM.MIDDLE_DIP] = p(0.001, 0.100, -0.005);
  lm[LM.MIDDLE_TIP] = p(0.001, 0.119, -0.008);
  lm[LM.RING_MCP] = p(0.021, 0.038, 0);
  lm[LM.RING_PIP] = p(0.023, 0.069, -0.003);
  lm[LM.RING_DIP] = p(0.025, 0.090, -0.006);
  lm[LM.RING_TIP] = p(0.026, 0.107, -0.009);
  lm[LM.PINKY_MCP] = p(0.039, 0.028, 0);
  lm[LM.PINKY_PIP] = p(0.043, 0.052, -0.003);
  lm[LM.PINKY_DIP] = p(0.046, 0.068, -0.006);
  lm[LM.PINKY_TIP] = p(0.048, 0.082, -0.008);

  // MediaPipe centres world landmarks on the hand; mirror that.
  const centre = new THREE.Vector3();
  for (const v of lm) centre.add(v);
  centre.multiplyScalar(1 / lm.length);
  for (const v of lm) v.sub(centre);
  return lm;
}

/**
 * Render the model as MediaPipe would: metric `worldLandmarks` in model space,
 * plus the 2D projection of that model placed at `depth` under rotation `quat`.
 */
function synthesiseDetection(model, quat, depth, map) {
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(config.camera.verticalFovDeg) / 2);
  const landmarks = [];
  const worldLandmarks = model.map((v) => ({ x: v.x, y: v.y, z: v.z }));

  const camPoints = model.map((v) =>
    v.clone().applyQuaternion(quat).add(new THREE.Vector3(0, 0, -depth)),
  );
  const wristDepth = -camPoints[LM.WRIST].z;

  for (const c of camPoints) {
    const d = -c.z;
    const ax = c.x / d;
    const ay = c.y / d;
    landmarks.push({
      x: 0.5 + ax / (2 * tanHalf * map.videoAspect),
      y: 0.5 - ay / (2 * tanHalf),
      // MediaPipe's relative z: larger means farther from the camera.
      z: d - wristDepth,
    });
  }
  return { landmarks, worldLandmarks, handedness: 'Right', score: 1, camPoints };
}

/** Drive a pose to convergence on a static input. */
function settle(pose, detection, map, frames = 90) {
  const headQuat = new THREE.Quaternion();
  const headPos = new THREE.Vector3();
  for (let i = 0; i < frames; i++) {
    pose.update(detection, map, headQuat, headPos, i / 60, 1 / 60);
  }
  return pose;
}

test('recovers distance for a hand facing the camera', () => {
  const map = makeFrameMap();
  const model = buildHandModel();
  const det = synthesiseDetection(model, new THREE.Quaternion(), 0.45, map);
  const pose = settle(new HandPose(), det, map);
  near(pose.depth, 0.45, 0.45 * 0.05, 'depth within 5%');
});

test('distance survives a steep tilt, where bone-length scaling fails', () => {
  const map = makeFrameMap();
  const model = buildHandModel();
  // 55 degrees about X foreshortens every palm bone dramatically.
  const quat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(55),
  );
  const det = synthesiseDetection(model, quat, 0.4, map);
  const pose = settle(new HandPose(), det, map);
  near(pose.depth, 0.4, 0.4 * 0.08, 'depth within 8% despite tilt');
});

test('recovers distance across a range of depths', () => {
  const map = makeFrameMap();
  const model = buildHandModel();
  const quat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(-25),
  );
  for (const depth of [0.25, 0.35, 0.5, 0.7]) {
    const det = synthesiseDetection(model, quat, depth, map);
    const pose = settle(new HandPose(), det, map);
    near(pose.depth, depth, depth * 0.08, `depth ${depth}`);
  }
});

test('reconstructed landmarks match the true camera-space geometry', () => {
  const map = makeFrameMap();
  const model = buildHandModel();
  const quat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0.4, 0).normalize(), THREE.MathUtils.degToRad(30),
  );
  const det = synthesiseDetection(model, quat, 0.42, map);
  const pose = settle(new HandPose(), det, map);

  for (const i of [LM.WRIST, LM.INDEX_TIP, LM.PINKY_MCP, LM.THUMB_TIP]) {
    const error = pose.viewLandmarks[i].distanceTo(det.camPoints[i]);
    assert.ok(error < 0.02, `landmark ${i} off by ${(error * 1000).toFixed(1)} mm`);
  }
});

/**
 * Same idea as `synthesiseDetection`, but for a `map` with a non-identity
 * `rotation`/`mirrorX` — i.e. a device whose raw camera stream needs
 * correcting, exactly like the one that motivated `toEffectiveUV`. MediaPipe
 * runs on the *raw* stream, so its 2D landmarks are raw-sensor-relative; this
 * applies the true inverse of `map`'s own forward transform (rotate then,
 * only if mirrored, flip — the same order the background shader's inverse
 * uses) to turn a "what the physical world really looks like" projection
 * into "what MediaPipe would actually report" for that camera.
 */
function synthesiseRawDetection(model, quat, depth, map) {
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(config.camera.verticalFovDeg) / 2);
  const worldLandmarks = model.map((v) => ({ x: v.x, y: v.y, z: v.z }));
  const camPoints = model.map((v) =>
    v.clone().applyQuaternion(quat).add(new THREE.Vector3(0, 0, -depth)),
  );
  const wristDepth = -camPoints[LM.WRIST].z;

  const landmarks = camPoints.map((c) => {
    const d = -c.z;
    const trueU = 0.5 + (c.x / d) / (2 * tanHalf * map.videoAspect);
    const trueV = 0.5 - (c.y / d) / (2 * tanHalf);
    const rotated = rotateToRawGLSL({ x: trueU, y: trueV }, map.rotation);
    const rawU = map.mirrorX ? 1 - rotated.x : rotated.x;
    return { x: rawU, y: rotated.y, z: d - wristDepth };
  });
  return { landmarks, worldLandmarks, handedness: 'Right', score: 1, camPoints };
}

test('depth and orientation survive a rotated, mirrored camera feed', () => {
  // The exact configuration a player reaches via btn-fliprot (180°) plus the
  // manual mirror toggle to fix an upside-down, reflected feed. Before
  // `toEffectiveUV`, `_solvePose`'s image tangents were computed straight
  // from raw MediaPipe u/v, silently assuming an unrotated, unmirrored
  // camera — a reflection is not something any rotation can explain away, so
  // the POSIT fit solved a systematically wrong depth and orientation the
  // moment mirroring was actually in effect, even though the affected
  // landmark still reprojected onto the right on-screen pixel.
  const map = makeFrameMap();
  map.setRotation(2);
  map.mirrorX = true;
  const model = buildHandModel();
  const quat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0.4, 0).normalize(), THREE.MathUtils.degToRad(30),
  );

  const det = synthesiseRawDetection(model, quat, 0.42, map);
  const pose = settle(new HandPose(), det, map);

  near(pose.depth, 0.42, 0.42 * 0.08, 'depth within 8% despite rotation+mirror');
  for (const i of [LM.WRIST, LM.INDEX_TIP, LM.PINKY_MCP, LM.THUMB_TIP]) {
    const error = pose.viewLandmarks[i].distanceTo(det.camPoints[i]);
    assert.ok(error < 0.02, `landmark ${i} off by ${(error * 1000).toFixed(1)} mm`);
  }
  assert.ok(pose.forward.y > 0.9, `forward should still point up the hand, got ${pose.forward.y}`);
});

test('reconstruction reprojects onto its own pixels despite an FOV mismatch', () => {
  // The headline claim in VideoFrameMap: because landmarks are lifted with the
  // *render* camera's projection, they land under the pixels they came from
  // even when our guess at the phone's lens FOV is wrong. Here the render FOV
  // (72) differs from the capture FOV the frames were synthesised with (59),
  // which is exactly the error the design is meant to absorb.
  assert.notEqual(
    config.stereo.eyeFovDeg, config.camera.verticalFovDeg,
    'this test is only meaningful when the two FOVs differ',
  );

  const map = new VideoFrameMap();
  map.setVideoAspect(16 / 9);
  map.setDisplay(1.0, config.stereo.eyeFovDeg);

  const model = buildHandModel();
  const det = synthesiseDetection(model, new THREE.Quaternion(), 0.5, map);
  const pose = settle(new HandPose(), det, map);

  const cam = new THREE.PerspectiveCamera(config.stereo.eyeFovDeg, 1.0, 0.01, 100);
  cam.updateMatrixWorld(true);

  for (const i of [LM.WRIST, LM.INDEX_TIP, LM.MIDDLE_MCP, LM.PINKY_TIP]) {
    const expected = map.videoToNdc(det.landmarks[i].x, det.landmarks[i].y, new THREE.Vector2());
    const projected = pose.viewLandmarks[i].clone().project(cam);
    near(projected.x, expected.x, 1e-5, `landmark ${i} ndc x`);
    near(projected.y, expected.y, 1e-5, `landmark ${i} ndc y`);
  }
});

test('grip frame is right-handed and points along the hand', () => {
  const map = makeFrameMap();
  const model = buildHandModel();
  const det = synthesiseDetection(model, new THREE.Quaternion(), 0.45, map);
  const pose = settle(new HandPose(), det, map);

  near(pose.forward.length(), 1, 1e-6, 'forward normalised');
  near(pose.up.length(), 1, 1e-6, 'up normalised');
  near(pose.forward.dot(pose.up), 0, 1e-6, 'forward orthogonal to up');

  const cross = new THREE.Vector3().crossVectors(pose.forward, pose.up);
  near(cross.dot(pose.right), 1, 1e-6, 'right-handed basis');

  // Model fingers run along +Y, so wrist -> knuckles must too.
  assert.ok(pose.forward.y > 0.9, `forward should point up the hand, got ${pose.forward.y}`);
});

// ---------------------------------------------------------------------------
group('Style (validation, for model-authored input)');

test('parseColor accepts hex, short hex, 0-1 triples and 0-255 triples', () => {
  assert.deepEqual(parseColor('#ff0000'), [1, 0, 0]);
  assert.deepEqual(parseColor('f00'), [1, 0, 0]);
  assert.deepEqual(parseColor([0, 1, 0]), [0, 1, 0]);
  const bytes = parseColor([255, 128, 0]);
  near(bytes[0], 1, 1e-6);
  near(bytes[1], 128 / 255, 1e-6);
});

test('parseColor falls back rather than throwing on nonsense', () => {
  assert.deepEqual(parseColor('not a colour', [0.2, 0.3, 0.4]), [0.2, 0.3, 0.4]);
  assert.deepEqual(parseColor(null, [0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(parseColor(['a', 'b', 'c'], [1, 1, 1]), [1, 1, 1]);
});

test('makeStyle clamps every out-of-range number into something renderable', () => {
  const s = makeStyle({
    chroma: 50, contrast: -10, textureStrength: 99,
    edgeStrength: -3, sheen: 900, textureScale: 1e9,
  });
  assert.ok(s.chroma >= 0 && s.chroma <= 1, `chroma ${s.chroma}`);
  assert.ok(s.contrast >= 0.2 && s.contrast <= 3, `contrast ${s.contrast}`);
  assert.ok(s.textureStrength >= 0 && s.textureStrength <= 1);
  assert.ok(s.edgeStrength >= 0 && s.edgeStrength <= 1);
  assert.ok(s.sheen >= 0 && s.sheen <= 1.5);
  assert.ok(s.textureScale <= 400);
});

test('makeStyle survives garbage without throwing', () => {
  for (const junk of [null, undefined, 42, 'hello', [], { ramp: 'nope' }]) {
    const s = makeStyle(junk);
    assert.equal(s.ramp.length, 4, `ramp length for ${JSON.stringify(junk)}`);
    assert.ok(Number.isFinite(s.chroma));
  }
});

test('an unknown texture name degrades to none instead of a broken enum', () => {
  assert.equal(makeStyle({ texture: 'obsidian' }).texture, 'none');
  assert.equal(makeStyle({ texture: 'VEINS' }).texture, 'veins');
  assert.ok(Object.hasOwn(TEXTURES, makeStyle({ texture: 42 }).texture));
});

test('normaliseRamp stretches a short ramp instead of padding it with grey', () => {
  const two = normaliseRamp(['#000000', '#ffffff']);
  assert.equal(two.length, 4);
  near(two[0][0], 0, 1e-6, 'first stop preserved');
  near(two[3][0], 1, 1e-6, 'last stop preserved');
  // Strictly increasing: a grey-padded ramp would flatten somewhere.
  for (let i = 1; i < 4; i++) {
    assert.ok(two[i][0] > two[i - 1][0], `stop ${i} brighter than ${i - 1}`);
  }
});

test('every shipped preset round-trips through validation unchanged', () => {
  // If a preset came back altered it would mean the shipped values are out of
  // range and being silently clamped — i.e. what renders is not what is
  // written here. Whether a preset preserves shading is checked further down,
  // measured through the whole pipeline rather than guessed from the ramp.
  for (const preset of STYLES) {
    assert.deepEqual(makeStyle(preset), preset, `${preset.id} is not stable under makeStyle`);
  }
});

test('lerpStyle moves continuously between two styles', () => {
  const a = makeStyle({ chroma: 0, contrast: 1, ramp: ['#000000', '#000000', '#000000', '#000000'] });
  const b = makeStyle({ chroma: 1, contrast: 2, ramp: ['#ffffff', '#ffffff', '#ffffff', '#ffffff'] });
  near(lerpStyle(a, b, 0).chroma, 0, 1e-9);
  near(lerpStyle(a, b, 1).chroma, 1, 1e-9);
  near(lerpStyle(a, b, 0.5).chroma, 0.5, 1e-9);
  near(lerpStyle(a, b, 0.25).ramp[0][0], 0.25, 1e-9);
  // Out-of-range t is clamped, not extrapolated into invalid colours.
  near(lerpStyle(a, b, 5).chroma, 1, 1e-9);
  near(lerpStyle(a, b, -5).chroma, 0, 1e-9);
});

// ---------------------------------------------------------------------------
group('Restyle (the shape-preserving repaint)');

test('the passthrough style is the exact identity, not merely close', () => {
  // This is what makes "off" genuinely free. If it ever drifts, the app is
  // quietly degrading the camera image even when nothing is applied.
  const off = passthroughStyle();
  for (const rgb of [[0, 0, 0], [1, 1, 1], [0.2, 0.6, 0.9], [0.5, 0.5, 0.5], [0.83, 0.11, 0.42]]) {
    const out = restyleColorCPU(rgb, off);
    for (let c = 0; c < 3; c++) near(out[c], rgb[c], 1e-9, `channel ${c} of ${rgb}`);
  }
});

test('luminance still orders the output, so shading survives the repaint', () => {
  // The core claim: a darker patch of a real object stays darker after being
  // repainted, which is what keeps its 3D form readable and reachable.
  for (const style of STYLES) {
    const greys = [0.05, 0.25, 0.5, 0.75, 0.95];
    const brightness = greys.map((g) => {
      const out = restyleColorCPU([g, g, g], style);
      return out[0] + out[1] + out[2];
    });
    for (let i = 1; i < brightness.length; i++) {
      assert.ok(
        brightness[i] >= brightness[i - 1] - 1e-6,
        `${style.id}: ${greys[i]} came out darker than ${greys[i - 1]}`,
      );
    }
    // And it must not collapse to a single flat tone.
    assert.ok(
      brightness[brightness.length - 1] - brightness[0] > 0.25,
      `${style.id}: repaint flattened the shading (spread ${(brightness[4] - brightness[0]).toFixed(3)})`,
    );
  }
});

test('chroma at zero discards the real hue; at one it keeps it', () => {
  const grey = ['#000000', '#555555', '#aaaaaa', '#ffffff'];
  const flat = makeStyle({ ramp: grey, chroma: 0, contrast: 1, sheen: 0 });
  const kept = makeStyle({ ramp: grey, chroma: 1, contrast: 1, sheen: 0 });
  const red = [0.9, 0.1, 0.1];

  const a = restyleColorCPU(red, flat);
  near(a[0], a[1], 0.02, 'chroma 0 leaves no colour cast');
  near(a[1], a[2], 0.02);

  const b = restyleColorCPU(red, kept);
  assert.ok(b[0] - b[2] > 0.5, `chroma 1 should keep the red, got ${b}`);
});

test('output always stays inside the displayable range', () => {
  const extreme = makeStyle({
    ramp: ['#ffffff', '#ffffff', '#ffffff', '#ffffff'],
    chroma: 1, contrast: 3, sheen: 1.5, sheenColor: '#ffffff',
  });
  for (const rgb of [[1, 1, 1], [0, 0, 0], [1, 0, 0.5]]) {
    for (const c of restyleColorCPU(rgb, extreme)) {
      assert.ok(c >= 0 && c <= 1, `${c} out of range for ${rgb}`);
    }
  }
});

// ---------------------------------------------------------------------------
group('StyleDirector (decide once, then hold)');

/** A minimal in-memory Storage, so persistence is testable off-browser. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

/** A source that hands out styles in a fixed order, and counts its calls. */
function countingSource(ids = ['a', 'b', 'c']) {
  let i = 0;
  return {
    name: 'Counting',
    calls: 0,
    async pick() {
      this.calls++;
      const id = ids[i % ids.length];
      i++;
      return { id, name: id, ramp: ['#000000', '#444444', '#999999', '#ffffff'] };
    },
  };
}

await testAsync('nothing but an explicit call can change the style', async () => {
  const source = countingSource();
  const d = new StyleDirector({ source, storage: null, fadeSeconds: 0 });

  await d.transform();
  const chosen = d.target.id;
  assert.equal(source.calls, 1);

  // The whole point: time passing and frames rendering must not re-decide.
  // In the app this is the "look away and back" case — update() is the only
  // thing a frame calls, and it has no path to the source at all.
  for (let i = 0; i < 600; i++) d.update(1 / 60);

  assert.equal(d.target.id, chosen, 'style changed without being asked');
  assert.equal(source.calls, 1, 'source consulted again without being asked');
});

await testAsync('next() is the only way to move on, and avoids repeating', async () => {
  const source = countingSource(['a', 'b']);
  const d = new StyleDirector({ source, storage: null, fadeSeconds: 0 });
  await d.transform();
  assert.equal(d.target.id, 'a');
  await d.next();
  assert.equal(d.target.id, 'b');
  assert.equal(source.calls, 2);
});

await testAsync('a second call while one is in flight is ignored, not queued', async () => {
  // Otherwise a double-tap leaves two picks racing to be the one that sticks.
  let release;
  const gate = new Promise((r) => { release = r; });
  const source = {
    name: 'Slow',
    calls: 0,
    async pick() { this.calls++; await gate; return { id: 'slow' }; },
  };
  const d = new StyleDirector({ source, storage: null, fadeSeconds: 0 });
  const first = d.transform();
  await d.transform();
  release();
  await first;
  assert.equal(source.calls, 1);
});

await testAsync('the choice survives a reload', async () => {
  const storage = fakeStorage();
  const a = new StyleDirector({ source: countingSource(['jade']), storage, fadeSeconds: 0 });
  await a.transform();

  // A fresh director, as if the page had been reloaded, with a source that
  // would hand out something different if it were consulted at all.
  const source = countingSource(['iron']);
  const b = new StyleDirector({ source, storage, fadeSeconds: 0 });
  assert.equal(b.active, true, 'restored as transformed');
  assert.equal(b.target.id, 'jade', 'restored the same material');
  assert.equal(source.calls, 0, 'restoring must not consult the source');
});

await testAsync('off() clears the memory so a reload comes back untouched', async () => {
  const storage = fakeStorage();
  const a = new StyleDirector({ source: countingSource(), storage, fadeSeconds: 0 });
  await a.transform();
  a.off();
  assert.equal(a.active, false);

  const b = new StyleDirector({ source: countingSource(), storage, fadeSeconds: 0 });
  assert.equal(b.active, false, 'reload after off should stay off');
});

test('a corrupt saved style is discarded rather than retried forever', () => {
  const storage = fakeStorage();
  storage.setItem('ar-reskin-style', '{ not json');
  const d = new StyleDirector({ source: countingSource(), storage, fadeSeconds: 0 });
  assert.equal(d.active, false);
  assert.equal(storage.getItem('ar-reskin-style'), null, 'bad entry cleared');
});

await testAsync('a cross-fade runs only on a deliberate change, and settles', async () => {
  const d = new StyleDirector({ source: countingSource(['a', 'b']), storage: null, fadeSeconds: 0.5 });
  await d.transform();
  assert.equal(d.isFading, true, 'the first transform fades in');
  for (let i = 0; i < 60; i++) d.update(1 / 60);
  assert.equal(d.isFading, false, 'settles within the fade duration');
  assert.equal(d.current.id, d.target.id, 'lands exactly on the target');

  // At rest, further frames are inert.
  const before = d.current;
  d.update(1 / 60);
  assert.equal(d.current, before, 'a settled director stops producing new styles');
});

await testAsync('a failing source leaves the previous look untouched', async () => {
  const d = new StyleDirector({
    source: { name: 'Broken', async pick() { throw new Error('offline'); } },
    storage: null,
    fadeSeconds: 0,
  });
  await assert.rejects(() => d.transform());
  assert.equal(d.active, false, 'a failed pick must not claim to have transformed');
  assert.equal(d.lastError.message, 'offline');
});

test('PresetSource never returns the excluded style when alternatives exist', async () => {
  const source = new PresetSource(STYLES, () => 0);
  // With a random() pinned to 0 it would always return the first entry;
  // excluding that one must still yield something valid.
  const picked = await source.pick({ exclude: STYLES[0].id });
  assert.notEqual(picked.id, STYLES[0].id);
});

// ---------------------------------------------------------------------------
group('ClaudeStylist (parsing what a model actually sends back)');

const wrap = (text) => ({ content: [{ type: 'text', text }] });

test('extractStyle reads a bare JSON reply', () => {
  const s = extractStyle(wrap('{"id":"ice","chroma":0.1}'));
  assert.equal(s.id, 'ice');
});

test('extractStyle survives a code fence or surrounding prose', () => {
  assert.equal(extractStyle(wrap('```json\n{"id":"jade"}\n```')).id, 'jade');
  assert.equal(extractStyle(wrap('Here you go:\n{"id":"bone"}\nHope that helps.')).id, 'bone');
});

test('extractStyle reports a reply with no style rather than returning junk', () => {
  assert.throws(() => extractStyle(wrap('I would rather not.')));
  assert.throws(() => extractStyle({ content: [] }));
});

test('a Claude-shaped reply flows through makeStyle into something renderable', () => {
  // The end-to-end contract: whatever comes back is validated by exactly the
  // same path a preset is, so the renderer cannot tell them apart.
  const raw = extractStyle(wrap(JSON.stringify({
    id: 'volcanic', name: 'Cooled Lava', blurb: 'Still warm underfoot.',
    ramp: ['#0a0503', '#3d1e12', '#8a3c1c', '#e8b27a'],
    chroma: 0.09, contrast: 1.3, texture: 'hammered', textureScale: 80,
    textureStrength: 0.25, edgeStrength: 0.3, edgeColor: '#050202',
    sheen: 0.2, sheenColor: '#ffd8a8',
  })));
  const style = makeStyle(raw);
  assert.equal(style.texture, 'hammered');
  assert.equal(style.ramp.length, 4);
  const out = restyleColorCPU([0.5, 0.5, 0.5], style);
  for (const c of out) assert.ok(c >= 0 && c <= 1);
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`\n  ${f.name}\n  ${f.err.stack}`);
  process.exit(1);
}
