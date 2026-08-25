#!/usr/bin/env node
/**
 * Headless checks for the parts of AR-Fight that are hard to eyeball.
 *
 * Everything here runs without a GPU or a camera: the geometry, the depth
 * solver, the anchor maths, collision, and the state machine. These are
 * exactly the pieces whose bugs would otherwise only show up as "the weapon
 * sits slightly wrong" while wearing a headset, which is a miserable way to
 * debug.
 *
 *   npm test
 */

import * as THREE from 'three';
import assert from 'node:assert/strict';

import config from '../src/config.js';
import { VideoFrameMap } from '../src/core/VideoFrameMap.js';
import { HeadTracker } from '../src/core/HeadTracker.js';
import { State, StateMachine } from '../src/core/AppState.js';
import { principalAxis, distanceToSegment, raySphere, angleAt } from '../src/util/math3d.js';
import { OneEuroFilter } from '../src/util/OneEuroFilter.js';
import { HandPose } from '../src/hands/HandPose.js';
import { LM } from '../src/hands/HandTracker.js';
import { DrawingSession } from '../src/draw/DrawingSession.js';
import { Weapon } from '../src/weapon/Weapon.js';
import { WeaponRig } from '../src/weapon/WeaponRig.js';
import { Projectiles } from '../src/fx/Projectiles.js';
import { TargetField } from '../src/fx/Targets.js';
import { MeleeBehavior } from '../src/weapon/MeleeBehavior.js';
import { GunBehavior } from '../src/weapon/GunBehavior.js';

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

function group(name) {
  console.log(`\n${name}`);
}

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);

// ---------------------------------------------------------------------------
group('math3d');

test('principalAxis recovers the long axis of an elongated cloud', () => {
  const axis = new THREE.Vector3(0.6, 0.8, 0).normalize();
  const points = [];
  for (let i = 0; i < 40; i++) {
    const t = (i / 39 - 0.5) * 2;
    points.push(
      new THREE.Vector3()
        .copy(axis).multiplyScalar(t)
        .add(new THREE.Vector3((Math.random() - 0.5) * 0.02, 0, (Math.random() - 0.5) * 0.02)),
    );
  }
  const found = principalAxis(points);
  assert.ok(found, 'expected an axis');
  // Sign is arbitrary for a principal axis, so compare absolute alignment.
  near(Math.abs(found.dot(axis)), 1, 0.02, 'axis alignment');
});

test('principalAxis returns null for degenerate input', () => {
  assert.equal(principalAxis([new THREE.Vector3(), new THREE.Vector3()]), null);
  const identical = Array.from({ length: 5 }, () => new THREE.Vector3(1, 1, 1));
  assert.equal(principalAxis(identical), null);
});

test('distanceToSegment clamps to the endpoints', () => {
  const a = new THREE.Vector3(0, 0, 0);
  const b = new THREE.Vector3(1, 0, 0);
  near(distanceToSegment(new THREE.Vector3(0.5, 2, 0), a, b), 2, 1e-6, 'perpendicular');
  near(distanceToSegment(new THREE.Vector3(-3, 0, 0), a, b), 3, 1e-6, 'before start');
  near(distanceToSegment(new THREE.Vector3(4, 0, 0), a, b), 3, 1e-6, 'past end');
});

test('raySphere reports a near hit and misses cleanly', () => {
  const origin = new THREE.Vector3(0, 0, 0);
  const dir = new THREE.Vector3(0, 0, -1);
  const centre = new THREE.Vector3(0, 0, -5);
  near(raySphere(origin, dir, centre, 1), 4, 1e-6, 'near hit distance');
  assert.equal(raySphere(origin, dir, new THREE.Vector3(0, 3, -5), 1), -1, 'miss');
  assert.equal(raySphere(origin, dir, new THREE.Vector3(0, 0, 5), 1), -1, 'behind');
});

test('angleAt measures a straight line as 180 degrees', () => {
  near(
    angleAt(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)),
    180, 1e-6,
  );
  near(
    angleAt(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)),
    90, 1e-6,
  );
});

test('OneEuroFilter converges on a constant signal', () => {
  const f = new OneEuroFilter({ minCutoff: 1, beta: 0 });
  let out = 0;
  for (let i = 0; i < 120; i++) out = f.filter(5, i / 60);
  near(out, 5, 1e-3, 'converged value');
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

/**
 * Bend a finger by rotating its distal joints about the PIP.
 *
 * The model is centred on the hand, so writing absolute coordinates into it
 * would silently be off by the centroid; rotating about an existing joint is
 * both centring-independent and anatomically what a finger does.
 */
function curlFinger(model, pipIdx, dipIdx, tipIdx, degrees) {
  const pivot = model[pipIdx];
  const axis = new THREE.Vector3(1, 0, 0);
  const q = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees));
  for (const idx of [dipIdx, tipIdx]) {
    model[idx].sub(pivot).applyQuaternion(q).add(pivot);
  }
  return model;
}

test('pinch and trigger gestures fire from the metric model', () => {
  const map = makeFrameMap();
  const model = buildHandModel();

  const open = synthesiseDetection(model, new THREE.Quaternion(), 0.45, map);
  const openPose = settle(new HandPose(), open, map);
  assert.equal(openPose.pinching, false, 'open hand should not read as a pinch');
  assert.equal(openPose.triggerPulled, false, 'straight index should not pull');

  // Close thumb and index tips onto each other.
  const pinched = buildHandModel();
  pinched[LM.THUMB_TIP].copy(pinched[LM.INDEX_TIP]).add(new THREE.Vector3(0.004, 0, 0));
  const pinchDet = synthesiseDetection(pinched, new THREE.Quaternion(), 0.45, map);
  const pinchPose = settle(new HandPose(), pinchDet, map);
  assert.equal(pinchPose.pinching, true, 'closed tips should read as a pinch');

  // Curl the index finger back toward the palm, as pulling a trigger does.
  const curled = curlFinger(
    buildHandModel(), LM.INDEX_PIP, LM.INDEX_DIP, LM.INDEX_TIP, 100,
  );
  const curlDet = synthesiseDetection(curled, new THREE.Quaternion(), 0.45, map);
  const curlPose = settle(new HandPose(), curlDet, map);
  assert.ok(
    curlPose.indexCurlDeg < config.gestures.triggerPullDeg,
    `curl angle ${curlPose.indexCurlDeg.toFixed(1)} should be under the pull threshold`,
  );
  assert.equal(curlPose.triggerPulled, true, 'curled index should pull the trigger');
});

// ---------------------------------------------------------------------------
group('DrawingSession');

function drawLine(session, from, to, samples = 20) {
  session.beginStroke();
  for (let i = 0; i <= samples; i++) {
    session.addPoint(new THREE.Vector3().lerpVectors(from, to, i / samples));
  }
  return session.endStroke();
}

test('samples closer than the threshold are rejected', () => {
  const s = new DrawingSession();
  s.beginStroke();
  assert.equal(s.addPoint(new THREE.Vector3(0, 0, 0)), true);
  assert.equal(s.addPoint(new THREE.Vector3(0.0001, 0, 0)), false, 'too close');
  assert.equal(s.addPoint(new THREE.Vector3(0.05, 0, 0)), true, 'far enough');
  s.endStroke();
});

test('a stroke of one point is discarded as noise', () => {
  const s = new DrawingSession();
  s.beginStroke();
  s.addPoint(new THREE.Vector3(0, 0, 0));
  assert.equal(s.endStroke(), null);
  assert.equal(s.strokes.length, 0);
});

test('undo and clear remove strokes and their meshes', () => {
  const s = new DrawingSession();
  drawLine(s, new THREE.Vector3(0, 0, -1), new THREE.Vector3(0.3, 0, -1));
  drawLine(s, new THREE.Vector3(0, 0.1, -1), new THREE.Vector3(0.3, 0.1, -1));
  assert.equal(s.strokes.length, 2);
  assert.equal(s.group.children.length, 2);
  s.undo();
  assert.equal(s.strokes.length, 1);
  assert.equal(s.group.children.length, 1);
  s.clear();
  assert.equal(s.strokes.length, 0);
  assert.equal(s.group.children.length, 0);
});

test('nearestPoint honours the snap radius', () => {
  const s = new DrawingSession();
  drawLine(s, new THREE.Vector3(0, 0, -1), new THREE.Vector3(0.4, 0, -1));
  const hit = s.nearestPoint(new THREE.Vector3(0.2, 0.01, -1), 0.1);
  assert.ok(hit, 'expected a snap');
  assert.ok(hit.distance < 0.05, `distance ${hit.distance}`);
  assert.equal(s.nearestPoint(new THREE.Vector3(0.2, 5, -1), 0.1), null, 'far point misses');
});

test('applyTransform keeps samples and rendered geometry together', () => {
  const s = new DrawingSession();
  drawLine(s, new THREE.Vector3(0, 0, -1), new THREE.Vector3(0.4, 0, -1));

  const matrix = new THREE.Matrix4().makeRotationY(Math.PI / 3);
  matrix.setPosition(new THREE.Vector3(0.5, 0.2, -0.3));

  const sample = s.strokes[0].points[5].clone();
  const expected = sample.clone().applyMatrix4(matrix);

  s.applyTransform(matrix);

  assert.ok(s.strokes[0].points[5].distanceTo(expected) < 1e-9, 'sample moved with the matrix');
  // The group must be back at identity, or snapping and rendering disagree.
  assert.ok(s.group.position.length() < 1e-9, 'group position reset');
  assert.ok(Math.abs(s.group.quaternion.w - 1) < 1e-9, 'group rotation reset');

  const found = s.nearestPoint(expected, 0.01);
  assert.ok(found, 'transformed point is still snappable at its new location');
});

// ---------------------------------------------------------------------------
group('Weapon');

/** A pistol-ish sketch: a grip bar and a barrel running forward from its top. */
function buildGunSketch() {
  const s = new DrawingSession();
  drawLine(s, new THREE.Vector3(0, -0.10, -0.5), new THREE.Vector3(0, 0, -0.5), 12); // grip
  drawLine(s, new THREE.Vector3(0, 0, -0.5), new THREE.Vector3(0, 0, -0.72), 24);    // barrel
  return s;
}

test('finalize puts the grip at the origin of the weapon frame', () => {
  const s = buildGunSketch();
  const w = new Weapon(s).setCategory('gun');
  const grip = new THREE.Vector3(0, -0.09, -0.5);
  w.setAnchor('grip', s.nearestPoint(grip, 0.1).point);
  w.setAnchor('trigger', s.nearestPoint(new THREE.Vector3(0, -0.03, -0.5), 0.1).point);
  w.setAnchor('muzzle', s.nearestPoint(new THREE.Vector3(0, 0, -0.72), 0.1).point);
  w.finalize();

  const local = w.getLocalAnchor('grip');
  near(local.length(), 0, 1e-6, 'grip is the local origin');
  assert.ok(w.getLocalAnchor('muzzle').z < 0, 'muzzle lies down -Z');
});

test('barrel axis follows the drawn barrel, not the grip-to-muzzle line', () => {
  const s = buildGunSketch();
  const w = new Weapon(s).setCategory('gun');
  // Grip low and behind, so grip->muzzle points diagonally up-and-forward
  // while the barrel itself runs straight along -Z.
  w.setAnchor('grip', s.nearestPoint(new THREE.Vector3(0, -0.10, -0.5), 0.1).point);
  w.setAnchor('trigger', s.nearestPoint(new THREE.Vector3(0, -0.04, -0.5), 0.1).point);
  w.setAnchor('muzzle', s.nearestPoint(new THREE.Vector3(0, 0, -0.72), 0.1).point);

  const forward = w.computeForward(new THREE.Vector3());
  const naive = new THREE.Vector3()
    .subVectors(w.anchors.get('muzzle'), w.anchors.get('grip')).normalize();

  assert.ok(forward.dot(new THREE.Vector3(0, 0, -1)) > 0.98, `bore should run -Z, got ${forward.toArray()}`);
  assert.ok(naive.dot(new THREE.Vector3(0, 0, -1)) < 0.95, 'naive line really is worse here');
});

test('melee forward is simply grip to strike', () => {
  const s = new DrawingSession();
  drawLine(s, new THREE.Vector3(0, -0.15, -0.6), new THREE.Vector3(0, 0.25, -0.6), 40);
  const w = new Weapon(s).setCategory('melee');
  w.setAnchor('grip', s.nearestPoint(new THREE.Vector3(0, -0.14, -0.6), 0.1).point);
  w.setAnchor('strike', s.nearestPoint(new THREE.Vector3(0, 0.24, -0.6), 0.1).point);

  const forward = w.computeForward(new THREE.Vector3());
  assert.ok(forward.dot(new THREE.Vector3(0, 1, 0)) > 0.99, 'points up the blade');
  w.finalize();
  assert.ok(w.reach > 0.3, `reach should span the blade, got ${w.reach}`);
});

test('anchors and art stay locked together when the weapon moves', () => {
  const s = buildGunSketch();
  const w = new Weapon(s).setCategory('gun');
  w.setAnchor('grip', s.nearestPoint(new THREE.Vector3(0, -0.10, -0.5), 0.1).point);
  w.setAnchor('trigger', s.nearestPoint(new THREE.Vector3(0, -0.04, -0.5), 0.1).point);
  const muzzleWorld = s.nearestPoint(new THREE.Vector3(0, 0, -0.72), 0.1).point.clone();
  w.setAnchor('muzzle', muzzleWorld);
  w.finalize();

  // Straight after finalize, nothing should have visibly moved.
  const atRest = w.getWorldAnchor('muzzle', new THREE.Vector3());
  assert.ok(atRest.distanceTo(muzzleWorld) < 1e-6, 'muzzle unchanged by finalize');

  // Now carry the weapon somewhere else and check the muzzle came along.
  w.root.position.set(1, 0.5, -2);
  w.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  w.root.updateMatrixWorld(true);

  const moved = w.getWorldAnchor('muzzle', new THREE.Vector3());
  const gripMoved = w.getWorldAnchor('grip', new THREE.Vector3());
  near(gripMoved.distanceTo(w.root.position), 0, 1e-6, 'grip tracks the root');
  near(
    moved.distanceTo(gripMoved),
    muzzleWorld.distanceTo(w.anchors.get('grip')),
    1e-6,
    'grip-to-muzzle distance is rigid',
  );

  const forward = w.getWorldForward(new THREE.Vector3());
  near(forward.length(), 1, 1e-6, 'forward stays unit length');
  assert.ok(forward.x < -0.98, `forward should have rotated to -X, got ${forward.toArray()}`);
});

test('finalize refuses to run without a grip', () => {
  const w = new Weapon(buildGunSketch()).setCategory('gun');
  assert.throws(() => w.finalize(), /grip/);
});

test('undoAnchor removes the most recent anchor only', () => {
  const s = buildGunSketch();
  const w = new Weapon(s).setCategory('gun');
  w.setAnchor('grip', new THREE.Vector3(0, -0.1, -0.5));
  w.setAnchor('trigger', new THREE.Vector3(0, -0.04, -0.5));
  assert.equal(w.nextAnchor.key, 'muzzle');
  w.undoAnchor();
  assert.equal(w.nextAnchor.key, 'trigger');
  assert.equal(w.anchors.size, 1);
});

// ---------------------------------------------------------------------------
group('Combat');

test('projectiles sweep instead of tunnelling through targets', () => {
  const p = new Projectiles();
  const target = { position: new THREE.Vector3(0, 0, -5), radius: 0.22, alive: true };

  p.fire(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1));

  // One fat step carries the round well past the target: a naive position
  // test would report nothing at all.
  let hit = null;
  p.update(0.5, [target], (t, point) => { hit = point.clone(); });

  assert.ok(hit, 'expected a swept hit');
  near(hit.z, -4.78, 0.02, 'impact on the near surface');
});

test('projectiles expire and stop colliding', () => {
  const p = new Projectiles();
  // Well beyond speed * lifetime, so the round must die in flight.
  const range = config.gun.projectileSpeed * config.gun.projectileLifetime;
  const target = { position: new THREE.Vector3(0, 0, -(range * 2)), radius: 0.22, alive: true };
  p.fire(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1));
  let hits = 0;
  for (let i = 0; i < 600; i++) p.update(1 / 60, [target], () => { hits++; });
  assert.equal(hits, 0, 'round should expire before reaching a target out of range');
});

test('a dead target cannot be scored twice', () => {
  const field = new TargetField();
  const target = field.targets[0];
  assert.equal(field.hit(target), true);
  assert.equal(field.hit(target), false, 'second hit rejected');
  assert.equal(field.score, 1);
});

test('melee connects on a fast swing and ignores a slow one', () => {
  const rig = new WeaponRig();
  const s = new DrawingSession();
  drawLine(s, new THREE.Vector3(0, -0.15, -0.6), new THREE.Vector3(0, 0.25, -0.6), 40);
  const w = new Weapon(s).setCategory('melee');
  w.setAnchor('grip', s.nearestPoint(new THREE.Vector3(0, -0.14, -0.6), 0.1).point);
  w.setAnchor('strike', s.nearestPoint(new THREE.Vector3(0, 0.24, -0.6), 0.1).point);
  w.finalize();
  rig.attach(w);

  const field = new TargetField();
  for (const t of field.targets) t.alive = false;
  const target = field.targets[0];
  target.alive = true;

  const melee = new MeleeBehavior(rig, null);
  target.position.set(0, 0, -2);

  /**
   * Move the weapon so its strike anchor lands exactly on `tipWorld`.
   * finalize() leaves the root rotated (this blade points +Y), so the local
   * offset has to be rotated before it can be subtracted.
   */
  const place = (tipWorld) => {
    const offset = w.getLocalAnchor('strike').clone().applyQuaternion(w.root.quaternion);
    w.root.position.copy(tipWorld).sub(offset);
    w.root.updateMatrixWorld(true);
  };

  place(target.position.clone());
  // Sanity-check the harness itself before trusting the assertions below.
  assert.ok(
    rig.getTipPosition(new THREE.Vector3()).distanceTo(target.position) < 1e-6,
    'test setup: strike point should sit on the target',
  );
  melee.update(1 / 60, field, () => {});   // seeds the previous position
  melee.update(1 / 60, field, () => {});   // stationary: no hit
  assert.equal(field.score, 0, 'resting on a target should not score');

  // Now sweep through it fast.
  let scored = 0;
  place(new THREE.Vector3(-0.6, 0, -2));
  melee.update(1 / 60, field, () => { scored++; });
  place(new THREE.Vector3(0.6, 0, -2));
  melee.update(1 / 60, field, () => { scored++; });

  assert.equal(scored, 1, 'a fast swing through the target should score once');
});

test('gun fires on the trigger edge, not while held', () => {
  const rig = new WeaponRig();
  const s = buildGunSketch();
  const w = new Weapon(s).setCategory('gun');
  w.setAnchor('grip', s.nearestPoint(new THREE.Vector3(0, -0.10, -0.5), 0.1).point);
  w.setAnchor('trigger', s.nearestPoint(new THREE.Vector3(0, -0.04, -0.5), 0.1).point);
  w.setAnchor('muzzle', s.nearestPoint(new THREE.Vector3(0, 0, -0.72), 0.1).point);
  w.finalize();
  rig.attach(w);

  const gun = new GunBehavior(rig, new Projectiles(), null);
  const headQuat = new THREE.Quaternion();
  const hand = { visible: true, triggerPulled: false };

  let now = 1000;
  assert.equal(gun.update(hand, now, headQuat), false, 'idle');

  hand.triggerPulled = true;
  assert.equal(gun.update(hand, (now += 16), headQuat), true, 'fires on pull');
  assert.equal(gun.update(hand, (now += 16), headQuat), false, 'held: no repeat');
  assert.equal(gun.update(hand, (now += 500), headQuat), false, 'still held, still silent');

  hand.triggerPulled = false;
  gun.update(hand, (now += 16), headQuat);
  hand.triggerPulled = true;
  assert.equal(gun.update(hand, (now += 300), headQuat), true, 'fires again after release');
  assert.equal(gun.shotsFired, 2);
});

test('rate limit blocks a second shot fired too soon', () => {
  const rig = new WeaponRig();
  const s = buildGunSketch();
  const w = new Weapon(s).setCategory('gun');
  w.setAnchor('grip', s.nearestPoint(new THREE.Vector3(0, -0.10, -0.5), 0.1).point);
  w.setAnchor('trigger', s.nearestPoint(new THREE.Vector3(0, -0.04, -0.5), 0.1).point);
  w.setAnchor('muzzle', s.nearestPoint(new THREE.Vector3(0, 0, -0.72), 0.1).point);
  w.finalize();
  rig.attach(w);

  const gun = new GunBehavior(rig, new Projectiles(), null);
  const q = new THREE.Quaternion();
  const hand = { visible: true, triggerPulled: false };
  let now = 0;

  hand.triggerPulled = true;
  assert.equal(gun.update(hand, (now += 16), q), true);
  hand.triggerPulled = false;
  gun.update(hand, (now += 16), q);
  hand.triggerPulled = true;
  // Inside fireIntervalMs: the edge is real but the shot must be dropped.
  assert.equal(gun.update(hand, (now += 20), q), false, 'rate limited');
});

test('recoil decays back to zero', () => {
  const rig = new WeaponRig();
  const s = buildGunSketch();
  const w = new Weapon(s).setCategory('gun');
  w.setAnchor('grip', s.nearestPoint(new THREE.Vector3(0, -0.10, -0.5), 0.1).point);
  w.setAnchor('trigger', s.nearestPoint(new THREE.Vector3(0, -0.04, -0.5), 0.1).point);
  w.setAnchor('muzzle', s.nearestPoint(new THREE.Vector3(0, 0, -0.72), 0.1).point);
  w.finalize();
  rig.attach(w);

  rig.kick(1);
  assert.ok(rig.recoil > 0);
  for (let i = 0; i < 200; i++) rig.update(null, 1 / 60);
  assert.equal(rig.recoil, 0, 'recoil fully recovered');
});

// ---------------------------------------------------------------------------
group('StateMachine');

test('follows the intended flow', () => {
  const seen = [];
  const fsm = new StateMachine((from, to) => seen.push(`${from}->${to}`));
  assert.equal(fsm.current, State.BOOT);
  assert.equal(fsm.go(State.CHECK), true);
  assert.equal(fsm.go(State.DRAW), true);
  assert.equal(fsm.go(State.CATEGORIZE), true);
  assert.equal(fsm.go(State.TAG), true);
  assert.equal(fsm.go(State.EQUIP), true);
  assert.equal(fsm.go(State.DRAW), true);
  assert.deepEqual(seen, [
    'boot->check', 'check->draw', 'draw->categorize',
    'categorize->tag', 'tag->equip', 'equip->draw',
  ]);
});

test('rejects illegal jumps unless forced', () => {
  const fsm = new StateMachine();
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(fsm.go(State.EQUIP), false, 'boot -> equip is not allowed');
    assert.equal(fsm.current, State.BOOT);
    assert.equal(fsm.go(State.EQUIP, true), true, 'force overrides');
    assert.equal(fsm.current, State.EQUIP);
  } finally {
    console.warn = warn;
  }
});

test('re-entering the same state is a no-op', () => {
  const fsm = new StateMachine();
  fsm.go(State.CHECK);
  fsm.tick(1.5);
  assert.equal(fsm.go(State.CHECK), false);
  near(fsm.elapsed, 1.5, 1e-9, 'elapsed not reset');
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`\n  ${f.name}\n  ${f.err.stack}`);
  process.exit(1);
}
