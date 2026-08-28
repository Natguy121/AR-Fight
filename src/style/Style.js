/**
 * What a "material" is, in this app.
 *
 * A style is a small bundle of numbers describing how to repaint the camera
 * image — never an image, and never a mesh. That matters for two reasons:
 *
 *   1. It renders in one fragment-shader pass, so it runs at frame rate on a
 *      phone that is also decoding video and rendering two eyes.
 *   2. It is small, ordinary JSON, so a vision model can *author* one. The
 *      renderer cannot tell a hand-tuned preset from a Claude-authored style,
 *      which is the whole point of the split — see `StyleDirector`.
 *
 * Because a model will eventually be filling these in, every field is
 * range-checked and every malformed value falls back rather than throwing:
 * a bad style should look wrong, not break the session.
 */

/**
 * Surface patterns, as a shader-side enum. Kept deliberately short — each
 * costs shader instructions on every pixel of both eyes, and a handful of
 * good ones beats a long tail of near-duplicates.
 */
export const TEXTURES = {
  none: 0,
  /** Fine even speckle: stone, concrete, unglazed ceramic. */
  grain: 1,
  /** Wandering high-contrast seams: marble, jade, cracked glaze. */
  veins: 2,
  /** Directional streaks: brushed metal, grain of sawn timber. */
  brushed: 3,
  /** Dented cellular relief: beaten copper, cast iron, hide. */
  hammered: 4,
  /** Crosshatch: woven fabric, canvas, wicker. */
  weave: 5,
};

export const TEXTURE_NAMES = Object.keys(TEXTURES);

/** Every field, with the value used when one is missing or unusable. */
const SCHEMA = {
  contrast: { min: 0.2, max: 3.0, fallback: 1.0 },
  chroma: { min: 0.0, max: 1.0, fallback: 0.15 },
  textureScale: { min: 1, max: 400, fallback: 60 },
  textureStrength: { min: 0.0, max: 1.0, fallback: 0.2 },
  edgeStrength: { min: 0.0, max: 1.0, fallback: 0.25 },
  sheen: { min: 0.0, max: 1.5, fallback: 0.3 },
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function num(value, { min, max, fallback }) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, min, max);
}

/**
 * Accepts `[r,g,b]` in 0..1, or `"#rrggbb"` — a vision model reaches for hex
 * far more naturally than for float triples, and rejecting that would mean
 * throwing away otherwise-good output over notation.
 */
export function parseColor(value, fallback = [0.5, 0.5, 0.5]) {
  if (Array.isArray(value) && value.length >= 3) {
    const out = value.slice(0, 3).map((c) => {
      const n = Number(c);
      if (!Number.isFinite(n)) return null;
      // Tolerate 0-255 as well as 0-1: anything above 1 can only be the
      // former, since 1.0 is already full intensity.
      return clamp(n > 1 ? n / 255 : n, 0, 1);
    });
    if (out.every((c) => c !== null)) return out;
  }
  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/, '');
    const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
    if (/^[0-9a-fA-F]{6}$/.test(full)) {
      return [
        parseInt(full.slice(0, 2), 16) / 255,
        parseInt(full.slice(2, 4), 16) / 255,
        parseInt(full.slice(4, 6), 16) / 255,
      ];
    }
  }
  return fallback.slice();
}

/** The ramp is always exactly this many stops, darkest first. */
export const RAMP_STOPS = 4;

/**
 * Coerce whatever we were handed into a usable ramp.
 *
 * Too few stops are stretched rather than padded with grey, because a grey
 * stop would read as a colourless band across part of the image — much more
 * visibly broken than a slightly compressed gradient.
 */
export function normaliseRamp(value, fallback) {
  const base = fallback || [
    [0.05, 0.05, 0.06], [0.3, 0.3, 0.32], [0.65, 0.65, 0.68], [0.98, 0.98, 1.0],
  ];
  if (!Array.isArray(value) || value.length === 0) return base.map((c) => c.slice());

  const parsed = value.map((c, i) => parseColor(c, base[Math.min(i, base.length - 1)]));
  if (parsed.length === RAMP_STOPS) return parsed;

  const out = [];
  for (let i = 0; i < RAMP_STOPS; i++) {
    const t = (i / (RAMP_STOPS - 1)) * (parsed.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(parsed.length - 1, lo + 1);
    const f = t - lo;
    out.push([
      parsed[lo][0] + (parsed[hi][0] - parsed[lo][0]) * f,
      parsed[lo][1] + (parsed[hi][1] - parsed[lo][1]) * f,
      parsed[lo][2] + (parsed[hi][2] - parsed[lo][2]) * f,
    ]);
  }
  return out;
}

/**
 * Turn arbitrary input into a style that is safe to render.
 *
 * Never throws and never returns null: unknown fields are ignored, bad values
 * fall back individually. A style that is 80% usable renders 80% right, which
 * is far better feedback than a hard failure when the author is a model.
 */
export function makeStyle(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const textureKey = typeof src.texture === 'string' ? src.texture.toLowerCase() : 'none';

  return {
    id: typeof src.id === 'string' && src.id ? src.id : 'custom',
    name: typeof src.name === 'string' && src.name ? src.name : 'Untitled',
    /** One line, shown to the player. Explains what they are looking at. */
    blurb: typeof src.blurb === 'string' ? src.blurb : '',

    ramp: normaliseRamp(src.ramp),
    chroma: num(src.chroma, SCHEMA.chroma),
    contrast: num(src.contrast, SCHEMA.contrast),

    texture: Object.hasOwn(TEXTURES, textureKey) ? textureKey : 'none',
    textureScale: num(src.textureScale, SCHEMA.textureScale),
    textureStrength: num(src.textureStrength, SCHEMA.textureStrength),

    edgeStrength: num(src.edgeStrength, SCHEMA.edgeStrength),
    edgeColor: parseColor(src.edgeColor, [0, 0, 0]),

    sheen: num(src.sheen, SCHEMA.sheen),
    sheenColor: parseColor(src.sheenColor, [1, 1, 1]),
  };
}

/**
 * Blend two styles, for the cross-fade on a deliberate change.
 *
 * `texture` is an enum and cannot be interpolated, so it snaps at the
 * midpoint. That is not visible in practice: `textureStrength` is being
 * interpolated at the same time, and the two textures are each near their
 * weakest around the crossover.
 */
export function lerpStyle(a, b, t) {
  const k = clamp(t, 0, 1);
  const mix = (x, y) => x + (y - x) * k;
  const mixColor = (x, y) => [mix(x[0], y[0]), mix(x[1], y[1]), mix(x[2], y[2])];

  return {
    id: k < 0.5 ? a.id : b.id,
    name: k < 0.5 ? a.name : b.name,
    blurb: k < 0.5 ? a.blurb : b.blurb,
    ramp: a.ramp.map((stop, i) => mixColor(stop, b.ramp[i])),
    chroma: mix(a.chroma, b.chroma),
    contrast: mix(a.contrast, b.contrast),
    texture: k < 0.5 ? a.texture : b.texture,
    textureScale: mix(a.textureScale, b.textureScale),
    textureStrength: mix(a.textureStrength, b.textureStrength),
    edgeStrength: mix(a.edgeStrength, b.edgeStrength),
    edgeColor: mixColor(a.edgeColor, b.edgeColor),
    sheen: mix(a.sheen, b.sheen),
    sheenColor: mixColor(a.sheenColor, b.sheenColor),
  };
}

/** The identity style: shows the camera through untouched. */
export function passthroughStyle() {
  return makeStyle({
    id: 'off',
    name: 'Off',
    blurb: 'The world as the camera sees it.',
    // Exact thirds, not 0.333/0.667: the ramp has to be perfectly linear for
    // the pipeline to reduce to the identity, and rounded stops leave a real
    // (if small) colour shift on a view that is supposed to be untouched.
    ramp: [[0, 0, 0], [1 / 3, 1 / 3, 1 / 3], [2 / 3, 2 / 3, 2 / 3], [1, 1, 1]],
    chroma: 1,
    contrast: 1,
    texture: 'none',
    textureStrength: 0,
    edgeStrength: 0,
    sheen: 0,
  });
}

export default { makeStyle, lerpStyle, passthroughStyle, parseColor, normaliseRamp, TEXTURES };
