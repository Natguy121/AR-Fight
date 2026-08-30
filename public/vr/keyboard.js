import * as THREE from '../vendor/three.module.js';
import { Panel, roundRect, fitText } from './paint.js';

/**
 * The keyboard you type on in mid air.
 *
 * The whole face — every key, its label, the highlight under your pointer —
 * is a single canvas on a single quad, and hit-testing is done by reading the
 * UV coordinate where the pointer ray crosses that quad and looking up which
 * key rectangle contains it. The obvious alternative, a mesh per key, means
 * thirty-odd objects to raycast against and thirty-odd materials to keep in
 * step; this way the keyboard costs one draw call, restyling is a canvas
 * edit, and "which key is under the ray" is two multiplications.
 *
 * There is no space bar, and that is a rule rather than an omission: a hint
 * is exactly one word (`isOneWord` in the shared rules rejects anything with
 * a space in it), so a space key could only ever produce input the server
 * would refuse. Apostrophe and hyphen are here because they appear inside
 * real words.
 */

const ROWS = [
  [..."QWERTYUIOP"].map((k) => ({ label: k, value: k.toLowerCase() })),
  [..."ASDFGHJKL"].map((k) => ({ label: k, value: k.toLowerCase() })),
  [..."ZXCVBNM"].map((k) => ({ label: k, value: k.toLowerCase() }))
    .concat([{ label: '-', value: '-' }, { label: '’', value: '’' }]),
  [
    { label: '⌫', action: 'back', span: 2, tone: 'muted' },
    { label: 'Say it', action: 'submit', span: 3, tone: 'accent' },
  ],
];

const WIDTH = 0.94;
const HEIGHT = 0.46;
const PPM = 1100;

export class Keyboard {
  constructor() {
    this.group = new THREE.Group();
    this.group.visible = false;

    this.text = '';
    this.title = '';
    this.error = '';
    this.maxLength = 20;
    this.onSubmit = null;
    this.hovered = null;
    this.keys = [];

    // A solid plate behind the glass, so the keyboard reads as an object in
    // the room rather than a decal floating on top of whatever is behind it.
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(WIDTH + 0.04, HEIGHT + 0.04, 0.018),
      new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.6, metalness: 0.1 }),
    );
    plate.position.z = -0.013;
    plate.castShadow = true;
    this.group.add(plate);

    this.face = new Panel({ width: WIDTH, height: HEIGHT, ppm: PPM });
    this.face.mesh.userData.keyboard = this;
    this.group.add(this.face.mesh);

    this.display = new Panel({ width: WIDTH, height: 0.19, ppm: PPM });
    this.display.mesh.position.set(0, HEIGHT / 2 + 0.115, 0.004);
    this.group.add(this.display.mesh);

    this._layout();
    this._paintFace();
    this._paintDisplay();
  }

  /** Work out every key's rectangle once, in canvas pixels. */
  _layout() {
    const w = this.face.canvas.width;
    const h = this.face.canvas.height;
    const pad = w * 0.014;
    const gap = w * 0.009;
    const rowH = (h - pad * 2 - gap * (ROWS.length - 1)) / ROWS.length;

    this.keys = [];
    ROWS.forEach((row, r) => {
      const spans = row.reduce((sum, k) => sum + (k.span ?? 1), 0);
      const usable = w - pad * 2 - gap * (row.length - 1);
      let x = pad;
      const y = pad + r * (rowH + gap);
      for (const key of row) {
        const kw = (usable * (key.span ?? 1)) / spans;
        this.keys.push({ ...key, x, y, w: kw, h: rowH });
        x += kw + gap;
      }
    });
  }

  _paintFace() {
    this.face.redraw((ctx, w, h) => {
      roundRect(ctx, 0, 0, w, h, w * 0.022);
      ctx.fillStyle = 'rgba(20,14,10,0.9)';
      ctx.fill();

      for (const key of this.keys) {
        const isHover = this.hovered === key;
        const accent = key.tone === 'accent';
        const muted = key.tone === 'muted';

        roundRect(ctx, key.x, key.y, key.w, key.h, key.h * 0.22);
        if (isHover) ctx.fillStyle = accent ? '#ffc247' : 'rgba(255,194,71,0.42)';
        else if (accent) ctx.fillStyle = 'rgba(255,194,71,0.82)';
        else if (muted) ctx.fillStyle = 'rgba(255,255,255,0.10)';
        else ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fill();
        ctx.lineWidth = isHover ? 4 : 2;
        ctx.strokeStyle = isHover ? '#ffe6b0' : 'rgba(255,255,255,0.16)';
        ctx.stroke();

        const label = key.label;
        const size = fitText(ctx, label, key.w * 0.78, key.h * 0.5, 650);
        ctx.font = `650 ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
        ctx.fillStyle = accent ? '#2a1e00' : (isHover ? '#fff6e2' : '#e8dcc8');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, key.x + key.w / 2, key.y + key.h / 2 + size * 0.03);
      }
    });
  }

  _paintDisplay() {
    this.display.redraw((ctx, w, h) => {
      roundRect(ctx, 0, 0, w, h, h * 0.2);
      ctx.fillStyle = 'rgba(20,14,10,0.9)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,194,71,0.35)';
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `600 ${h * 0.2}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.fillStyle = this.error ? '#ff9a9a' : 'rgba(232,220,200,0.65)';
      ctx.fillText(this.error || this.title, h * 0.22, h * 0.33);

      const shown = this.text || '…';
      const size = fitText(ctx, shown, w - h * 0.5, h * 0.44, 700);
      ctx.font = `700 ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.fillStyle = this.text ? '#ffffff' : 'rgba(232,220,200,0.3)';
      ctx.fillText(shown, h * 0.22, h * 0.85);
    });
  }

  /**
   * Open the keyboard.
   * @param {object} opts
   * @param {string} opts.title      the prompt above the typed text
   * @param {Function} opts.onSubmit called with the typed string
   */
  show({ title = '', maxLength = 20, onSubmit = null } = {}) {
    this.title = title;
    this.maxLength = maxLength;
    this.onSubmit = onSubmit;
    this.text = '';
    this.error = '';
    this.hovered = null;
    this.group.visible = true;
    this._paintFace();
    this._paintDisplay();
  }

  hide() {
    this.group.visible = false;
    this.hovered = null;
    this.onSubmit = null;
  }

  get visible() {
    return this.group.visible;
  }

  /** Show a rejection from the server without closing the keyboard — what you
   *  typed stays put so you can fix it rather than retype it. */
  reject(message) {
    this.error = message;
    this._paintDisplay();
  }

  /** Which key, if any, a ray hit. Pass the three.js intersection. */
  keyAt(intersection) {
    if (!intersection?.uv || intersection.object !== this.face.mesh) return null;
    const x = intersection.uv.x * this.face.canvas.width;
    // Canvas y runs down the image; UV v runs up the quad.
    const y = (1 - intersection.uv.y) * this.face.canvas.height;
    return this.keys.find((k) => x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h) ?? null;
  }

  setHover(key) {
    if (this.hovered === key) return;
    this.hovered = key;
    this._paintFace();
  }

  /** Act on a key. Returns true if it was the submit key. */
  press(key) {
    if (!key) return false;
    this.error = '';
    if (key.action === 'back') {
      this.text = this.text.slice(0, -1);
    } else if (key.action === 'submit') {
      const value = this.text.trim();
      this._paintDisplay();
      if (value && this.onSubmit) this.onSubmit(value);
      return true;
    } else if (this.text.length < this.maxLength) {
      this.text += key.value;
    }
    this._paintDisplay();
    return false;
  }
}

export default Keyboard;
