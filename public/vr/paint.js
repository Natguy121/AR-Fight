import * as THREE from '../vendor/three.module.js';

/**
 * The villa's palette, and everything in the world that is drawn rather than
 * modelled.
 *
 * There is no asset pipeline here and deliberately so: the whole VR mode has
 * to load over the same free-tier server as the phone client, so every
 * texture in the room — the terracotta floor, the plaster on the walls, every
 * word of readable text — is painted into a 2D canvas at runtime and handed
 * to three.js. Nothing is fetched, nothing is baked, and the entire room
 * costs a few kilobytes of code rather than a few megabytes of downloads.
 *
 * `Panel` is the one abstraction that matters. Text in 3D is otherwise a
 * font-loading problem; a canvas sidesteps it entirely, and gives us the same
 * drawing API the phone client's CSS is doing anyway.
 */

/** Warm, late-afternoon, terracotta-and-plaster. Chosen to read as "someone's
 *  holiday house" rather than "a grey room with a table in it". */
export const PALETTE = {
  plaster: 0xe9d8bd,
  plasterShade: 0xd8c3a2,
  terracotta: 0xb2603a,
  terracottaDark: 0x8c4529,
  grout: 0xd9c3a8,
  wood: 0x6f4a31,
  woodLight: 0xa2734d,
  beam: 0x4f3220,
  rug: 0x8d4b4b,
  rugTrim: 0xd9b382,
  leaf: 0x4f7a43,
  leafDark: 0x355430,
  pot: 0xa9603c,
  brass: 0xc8a05a,
  glow: 0xffd9a0,
  sky: 0xf4b678,
  skyHigh: 0x8fb6d6,
  ink: '#2a1d12',
  inkDim: '#6a5340',
  paper: '#f6ecdc',
  accent: '#c8762f',
  white: '#f3ece2',
};

/** A rounded rectangle path. Canvas has `roundRect` now, but not in every
 *  headset browser, so this stays hand-rolled rather than feature-detected. */
export function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Shrink the font until the text fits, so a long name or a long word never
 *  runs off the side of a card. Returns the size actually used. */
export function fitText(ctx, text, maxWidth, startPx, weight = 600, minPx = 10) {
  let size = startPx;
  for (;;) {
    ctx.font = `${weight} ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth || size <= minPx) return size;
    size -= Math.max(1, Math.round(size * 0.06));
  }
}

/** Word-wrap into lines that fit `maxWidth` at the ctx's current font. */
export function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * A flat plane in the world with a canvas painted on it.
 *
 * Deliberately unlit (`MeshBasicMaterial`): a UI panel that dims when it
 * drifts away from the lamp is a panel you cannot read, and every one of
 * these carries something the player needs — their word, whose turn it is,
 * what has been said.
 */
export class Panel {
  /**
   * @param {object} opts
   * @param {number} opts.width  metres
   * @param {number} opts.height metres
   * @param {number} [opts.ppm]  canvas pixels per metre; the readability dial
   */
  constructor({ width, height, ppm = 900, depthTest = true, opacity = 1 }) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.max(2, Math.round(width * ppm));
    this.canvas.height = Math.max(2, Math.round(height * ppm));
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity,
      depthTest,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), this.material);
    this.mesh.userData.panel = this;
  }

  /** Repaint from scratch. The callback gets the context and pixel size. */
  redraw(fn) {
    const { ctx, canvas } = this;
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    fn(ctx, canvas.width, canvas.height);
    ctx.restore();
    this.texture.needsUpdate = true;
    return this;
  }

  /**
   * The common case: a card with a heading and some body lines.
   *
   * Nearly opaque, and that is the point — these hang in front of the people
   * sitting opposite, and at 0.85 the nameplates and speech bubbles behind
   * them bleed through and turn the text into a jumble.
   */
  card(ctx, w, h, { fill = 'rgba(26,18,12,0.97)', stroke = 'rgba(246,236,220,0.24)', radius = 34 } = {}) {
    roundRect(ctx, 6, 6, w - 12, h - 12, radius);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }

  dispose() {
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

/**
 * Terracotta floor tiles, grout lines and all.
 *
 * Repeated across the floor rather than drawn once at floor size — a 4x4 tile
 * patch tiled by the sampler stays sharp underfoot, where a single stretched
 * texture would be a blurry smear exactly where the player is looking down.
 */
export function tileTexture({ tiles = 4, px = 512 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  const size = px / tiles;

  ctx.fillStyle = '#cbb59a'; // grout
  ctx.fillRect(0, 0, px, px);

  for (let y = 0; y < tiles; y++) {
    for (let x = 0; x < tiles; x++) {
      // Each tile is fired slightly differently. Without this the floor reads
      // as wallpaper; with it, as a floor.
      const warm = 0.86 + Math.random() * 0.28;
      const r = Math.round(178 * warm);
      const g = Math.round(96 * warm);
      const b = Math.round(58 * warm);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      const inset = size * 0.035;
      roundRect(ctx, x * size + inset, y * size + inset, size - inset * 2, size - inset * 2, size * 0.06);
      ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      for (let i = 0; i < 12; i++) {
        const sx = x * size + Math.random() * size;
        const sy = y * size + Math.random() * size;
        ctx.fillRect(sx, sy, size * 0.06, size * 0.02);
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** Hand-troweled plaster: mottled warm off-white, no hard edges. */
export function plasterTexture({ px = 512 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#e9d8bd';
  ctx.fillRect(0, 0, px, px);
  for (let i = 0; i < 900; i++) {
    const shade = Math.random() < 0.5 ? '0,0,0' : '255,255,255';
    ctx.fillStyle = `rgba(${shade},${0.015 + Math.random() * 0.03})`;
    const r = 6 + Math.random() * 34;
    ctx.beginPath();
    ctx.arc(Math.random() * px, Math.random() * px, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

export default { PALETTE, Panel, roundRect, fitText, wrapLines, tileTexture, plasterTexture };
