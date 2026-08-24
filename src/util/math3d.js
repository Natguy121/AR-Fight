import * as THREE from 'three';

/** Clamp helper (THREE.MathUtils.clamp exists; kept local for readability). */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Frame-rate independent lerp factor: `rate` is the fraction closed per second. */
export function damp(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}

/**
 * Dominant principal axis of a point cloud, via power iteration on the
 * covariance matrix.
 *
 * Used to recover the direction a drawn barrel actually points: the samples
 * near the muzzle form an elongated cloud whose long axis *is* the bore line.
 * That is far more faithful than assuming the bore runs grip-to-muzzle, which
 * is wrong for anything with an angled or offset barrel.
 *
 * @param {THREE.Vector3[]} points
 * @param {THREE.Vector3} [out]
 * @returns {THREE.Vector3|null} Unit axis, or null if the cloud is degenerate.
 */
export function principalAxis(points, out = new THREE.Vector3()) {
  const n = points.length;
  if (n < 3) return null;

  const mean = new THREE.Vector3();
  for (const p of points) mean.add(p);
  mean.multiplyScalar(1 / n);

  // Symmetric 3x3 covariance, upper triangle mirrored.
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const dx = p.x - mean.x;
    const dy = p.y - mean.y;
    const dz = p.z - mean.z;
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  const inv = 1 / n;
  xx *= inv; xy *= inv; xz *= inv; yy *= inv; yz *= inv; zz *= inv;

  const trace = xx + yy + zz;
  if (trace < 1e-9) return null;

  // Seed along the widest coordinate spread so we do not start orthogonal to
  // the true dominant eigenvector.
  let v = new THREE.Vector3(1, 1, 1);
  if (xx >= yy && xx >= zz) v.set(1, 0.1, 0.1);
  else if (yy >= zz) v.set(0.1, 1, 0.1);
  else v.set(0.1, 0.1, 1);
  v.normalize();

  const next = new THREE.Vector3();
  for (let i = 0; i < 32; i++) {
    next.set(
      xx * v.x + xy * v.y + xz * v.z,
      xy * v.x + yy * v.y + yz * v.z,
      xz * v.x + yz * v.y + zz * v.z,
    );
    const len = next.length();
    if (len < 1e-12) return null;
    next.multiplyScalar(1 / len);
    const converged = Math.abs(next.dot(v)) > 1 - 1e-9;
    v.copy(next);
    if (converged) break;
  }

  return out.copy(v);
}

/**
 * Build an orthonormal basis from a forward vector and a rough up hint.
 * Falls back to a different hint when forward and up are near-parallel.
 *
 * @returns {{x:THREE.Vector3, y:THREE.Vector3, z:THREE.Vector3}} Right/up/back,
 *   matching three.js convention where -z is forward.
 */
export function basisFromForward(forward, upHint = new THREE.Vector3(0, 1, 0)) {
  const z = forward.clone().normalize().negate(); // three.js: -z is forward
  let up = upHint.clone().normalize();
  if (Math.abs(up.dot(z)) > 0.98) up.set(1, 0, 0);
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return { x, y, z };
}

/** Quaternion whose -Z maps to `forward` and whose +Y is closest to `upHint`. */
export function quaternionFromForward(forward, upHint, out = new THREE.Quaternion()) {
  const { x, y, z } = basisFromForward(forward, upHint);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  return out.setFromRotationMatrix(m);
}

/**
 * Shortest distance from point `p` to segment `a`-`b`, plus the closest point.
 * Used for melee edge/target overlap without allocating per test.
 */
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();
export function distanceToSegment(p, a, b, closest = new THREE.Vector3()) {
  _ab.subVectors(b, a);
  _ap.subVectors(p, a);
  const denom = _ab.lengthSq();
  const t = denom < 1e-12 ? 0 : clamp(_ap.dot(_ab) / denom, 0, 1);
  closest.copy(a).addScaledVector(_ab, t);
  return closest.distanceTo(p);
}

/**
 * Ray/sphere intersection returning the near hit distance, or -1 for a miss.
 * `dir` must be normalised.
 */
const _oc = new THREE.Vector3();
export function raySphere(origin, dir, center, radius) {
  _oc.subVectors(origin, center);
  const b = _oc.dot(dir);
  const c = _oc.lengthSq() - radius * radius;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? 0 : t;
}

/** Angle in degrees at vertex `b` of the polyline a-b-c. */
const _ba = new THREE.Vector3();
const _bc = new THREE.Vector3();
export function angleAt(a, b, c) {
  _ba.subVectors(a, b);
  _bc.subVectors(c, b);
  const denom = _ba.length() * _bc.length();
  if (denom < 1e-9) return 180;
  return THREE.MathUtils.radToDeg(Math.acos(clamp(_ba.dot(_bc) / denom, -1, 1)));
}
