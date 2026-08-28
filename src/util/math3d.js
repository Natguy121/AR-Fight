import * as THREE from 'three';

/** Clamp helper (THREE.MathUtils.clamp exists; kept local for readability). */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Interior angle at `b`, in degrees, for the path a -> b -> c.
 *
 * Used for finger-joint angles, which is why a degenerate span returns 180
 * (straight) rather than throwing: a landmark occasionally lands exactly on
 * its neighbour, and reading that as "not bent" is both the safer default and
 * the more accurate one.
 */
export function angleAt(a, b, c) {
  _ba.subVectors(a, b);
  _bc.subVectors(c, b);
  const denom = _ba.length() * _bc.length();
  if (denom < 1e-9) return 180;
  return THREE.MathUtils.radToDeg(Math.acos(clamp(_ba.dot(_bc) / denom, -1, 1)));
}

const _ba = new THREE.Vector3();
const _bc = new THREE.Vector3();

export default { clamp, angleAt };
