import config from '../config.js';

/**
 * Turn a finalized `Weapon` into a small, JSON-safe object the opponent can
 * rebuild a visual copy of (see `RemoteWeapon`).
 *
 * Coordinates are converted into the weapon's own local frame — the same one
 * `localAnchors` already lives in — rather than sent in world space, which
 * would be meaningless to the receiver anyway (their world has nothing to do
 * with yours; only the weapon's own shape is shared). `weapon.pivot.matrix`
 * is already exactly the inverse of the finalize-time pose (see
 * `Weapon.finalize`), which is what maps a stroke's stored draw-time world
 * points into that local frame.
 */
export function serializeWeapon(weapon) {
  const strokes = weapon.drawing.strokes.map((stroke) => ({
    color: stroke.color,
    radius: stroke.radius,
    points: decimate(stroke.points, config.versus.maxSyncPointsPerStroke).map((p) => {
      const local = p.clone().applyMatrix4(weapon.pivot.matrix);
      return roundVec(local);
    }),
  }));

  const anchors = {};
  for (const [key, v] of weapon.localAnchors) anchors[key] = roundVec(v);

  return {
    category: weapon.category,
    reach: round(weapon.reach),
    strokes,
    anchors,
  };
}

/** Evenly-spaced downsample — a receive-only visual doesn't need draw-time density. */
function decimate(points, maxCount) {
  if (points.length <= maxCount) return points;
  if (maxCount <= 1) return [points[0]];
  const out = [];
  const step = (points.length - 1) / (maxCount - 1);
  for (let i = 0; i < maxCount; i++) out.push(points[Math.round(i * step)]);
  return out;
}

function round(n) {
  // Millimetre precision is plenty for a weapon a couple of hundred mm
  // across, and keeps the payload well clear of data-channel size limits.
  return Math.round(n * 1000) / 1000;
}

function roundVec(v) {
  return { x: round(v.x), y: round(v.y), z: round(v.z) };
}

export default { serializeWeapon };
