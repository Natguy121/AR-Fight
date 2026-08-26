import * as THREE from 'three';
import config from '../config.js';

/**
 * All in-session UI, drawn in the 3D world rather than the DOM.
 *
 * In stereo each eye gets its own image, so a DOM overlay would only ever be
 * visible to one of them. Panels are textured quads floating in front of the
 * viewer instead, which both eyes render normally.
 *
 * Two ways to press a button, because either hand state might be unavailable:
 * look at it and hold (gaze dwell), or touch it with a fingertip and pinch.
 */

const PPM = config.ui.pixelsPerMeter;
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif';

/** A quad whose texture is drawn by a 2D canvas. */
class CanvasQuad {
  constructor(widthM, heightM) {
    this.widthM = widthM;
    this.heightM = heightM;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.max(2, Math.round(widthM * PPM));
    this.canvas.height = Math.max(2, Math.round(heightM * PPM));
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.anisotropy = 4;

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, heightM), this.material);
    this.mesh.renderOrder = 1000;
    this.mesh.frustumCulled = false;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  commit() {
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/** Greedy word wrap. Returns the lines that fit within `maxWidth`. */
function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** A pressable button quad. */
class UIButton extends CanvasQuad {
  constructor(spec) {
    super(spec.width ?? 0.34, spec.height ?? 0.15);
    this.id = spec.id;
    this.label = spec.label;
    this.hint = spec.hint || '';
    this.accent = spec.accent ?? 0x5ac8fa;
    this.hover = false;
    this.progress = 0;
    this.mesh.userData.button = this;
    this.render();
  }

  setState(hover, progress) {
    const p = Math.max(0, Math.min(1, progress));
    if (hover === this.hover && Math.abs(p - this.progress) < 0.02) return;
    this.hover = hover;
    this.progress = p;
    this.render();
  }

  render() {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    const pad = w * 0.03;
    this.clear();

    const accent = `#${this.accent.toString(16).padStart(6, '0')}`;

    ctx.fillStyle = this.hover ? 'rgba(20,32,48,0.96)' : 'rgba(10,15,24,0.86)';
    roundRect(ctx, pad, pad, w - pad * 2, h - pad * 2, h * 0.16);
    ctx.fill();

    ctx.strokeStyle = this.hover ? accent : 'rgba(255,255,255,0.22)';
    ctx.lineWidth = this.hover ? w * 0.011 : w * 0.006;
    ctx.stroke();

    // Dwell progress sweeps left to right along the bottom edge.
    if (this.progress > 0.001) {
      ctx.save();
      roundRect(ctx, pad, pad, w - pad * 2, h - pad * 2, h * 0.16);
      ctx.clip();
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.28;
      ctx.fillRect(pad, pad, (w - pad * 2) * this.progress, h - pad * 2);
      ctx.globalAlpha = 1;
      ctx.fillRect(pad, h - pad - h * 0.05, (w - pad * 2) * this.progress, h * 0.05);
      ctx.restore();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.hover ? '#ffffff' : '#e9eef7';
    const labelSize = this.hint ? h * 0.3 : h * 0.36;
    ctx.font = `700 ${labelSize}px ${FONT}`;
    ctx.fillText(this.label, w / 2, this.hint ? h * 0.42 : h * 0.5, w - pad * 4);

    if (this.hint) {
      ctx.font = `500 ${h * 0.16}px ${FONT}`;
      ctx.fillStyle = 'rgba(190,205,225,0.85)';
      ctx.fillText(this.hint, w / 2, h * 0.7, w - pad * 4);
    }

    this.commit();
  }
}

/** The message panel above the button row. */
class UIPrompt extends CanvasQuad {
  constructor() {
    super(1.0, 0.34);
    this.title = '';
    this.detail = '';
    this.tone = 'normal';
    this.render();
  }

  set(title, detail, tone = 'normal') {
    if (title === this.title && detail === this.detail && tone === this.tone) return;
    this.title = title || '';
    this.detail = detail || '';
    this.tone = tone;
    this.render();
  }

  render() {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    this.clear();

    if (!this.title && !this.detail) {
      this.commit();
      return;
    }

    ctx.fillStyle = 'rgba(8,12,20,0.78)';
    roundRect(ctx, 0, 0, w, h, h * 0.16);
    ctx.fill();
    ctx.strokeStyle =
      this.tone === 'success' ? 'rgba(139,245,160,0.5)'
      : this.tone === 'error' ? 'rgba(255,107,107,0.5)'
      : 'rgba(255,255,255,0.16)';
    ctx.lineWidth = w * 0.004;
    ctx.stroke();

    const pad = w * 0.05;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    let y = pad;
    if (this.title) {
      ctx.font = `700 ${h * 0.2}px ${FONT}`;
      ctx.fillStyle =
        this.tone === 'success' ? '#8bf5a0' : this.tone === 'error' ? '#ff6b6b' : '#ffffff';
      for (const line of wrapText(ctx, this.title, w - pad * 2)) {
        ctx.fillText(line, w / 2, y);
        y += h * 0.24;
      }
    }
    if (this.detail) {
      y += h * 0.04;
      ctx.font = `500 ${h * 0.132}px ${FONT}`;
      ctx.fillStyle = 'rgba(198,208,224,0.94)';
      for (const line of wrapText(ctx, this.detail, w - pad * 2)) {
        ctx.fillText(line, w / 2, y);
        y += h * 0.17;
      }
    }

    this.commit();
  }
}

export class WorldUI {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'world-ui';
    this.group.renderOrder = 1000;

    this.prompt = new UIPrompt();
    this.prompt.mesh.position.set(0, config.ui.promptOffsetY, 0);
    this.group.add(this.prompt.mesh);

    // Below the resting gaze on purpose — see config.ui.buttonsOffsetY.
    this.buttonRow = new THREE.Group();
    this.buttonRow.position.set(0, config.ui.buttonsOffsetY, 0);
    this.group.add(this.buttonRow);

    /** @type {UIButton[]} */
    this.buttons = [];

    this._raycaster = new THREE.Raycaster();
    this._hoverId = null;
    this._dwellMs = 0;
    this._wasPinching = false;
    /** Progress 0..1 of the current gaze dwell, for the reticle to mirror. */
    this.dwellProgress = 0;
    /**
     * True from the moment a pinch presses a button until that pinch opens
     * again. Callers read it to be sure the same pinch does not also draw a
     * stroke or drop an anchor.
     */
    this.pinchConsumed = false;

    this._anchored = false;
    this._following = false;
    this._targetPos = new THREE.Vector3();
  }

  setPrompt(title, detail, tone) {
    this.prompt.set(title, detail, tone);
  }

  /**
   * Replace the button row.
   * @param {{id:string,label:string,hint?:string,accent?:number,width?:number}[]} specs
   */
  setButtons(specs) {
    for (const b of this.buttons) {
      this.buttonRow.remove(b.mesh);
      b.dispose();
    }
    this.buttons = specs.map((s) => new UIButton(s));

    const gap = 0.045;
    const total = this.buttons.reduce((sum, b) => sum + b.widthM, 0) + gap * (this.buttons.length - 1);
    let x = -total / 2;
    for (const b of this.buttons) {
      b.mesh.position.set(x + b.widthM / 2, 0, 0);
      x += b.widthM + gap;
      this.buttonRow.add(b.mesh);
    }

    this._hoverId = null;
    this._dwellMs = 0;
    this.dwellProgress = 0;
  }

  clearButtons() {
    this.setButtons([]);
  }

  get visible() {
    return this.group.visible;
  }

  set visible(v) {
    if (this.group.visible === v) return;
    this.group.visible = v;
    if (!v) {
      this._hoverId = null;
      this._dwellMs = 0;
      this.dwellProgress = 0;
    }
  }

  /** Snap the panel in front of the viewer immediately. */
  recenter(headPos, headQuat) {
    _forward.set(0, 0, -1).applyQuaternion(headQuat);
    this.group.position.copy(headPos).addScaledVector(_forward, config.ui.panelDistance);
    this.group.quaternion.copy(headQuat);
    this._anchored = true;
    this._following = false;
  }

  /**
   * Three ways to press a button, in priority order:
   *
   *   1. Touch it with a fingertip and pinch. Only reachable if the panel has
   *      been moved within arm's length; at the default distance it is not.
   *   2. Look at it and pinch. The primary path — the panel sits further away
   *      than you can reach, so pointing the head is how you aim.
   *   3. Look at it and hold. The fallback for when hand tracking is unusable,
   *      and the reason the reticle carries a progress ring.
   *
   * Pinch presses require a real open-to-closed transition, so a pinch that
   * began elsewhere (mid-stroke, say) cannot fire a button it passes over.
   *
   * @param {number} dt
   * @param {THREE.Vector3} headPos
   * @param {THREE.Quaternion} headQuat
   * @param {Array} hands Hand-like objects supplying pinch and fingertip state.
   * @returns {string|null} id of a button activated this frame.
   */
  update(dt, headPos, headQuat, hands) {
    // Pinch bookkeeping runs even while hidden, so the latch cannot be left
    // stuck by a panel that disappeared mid-pinch.
    const pinching = this._anyPinching(hands);
    const freshPinch = pinching && !this._wasPinching;
    this._wasPinching = pinching;
    if (!pinching) this.pinchConsumed = false;

    if (!this.group.visible) {
      this._resetDwell();
      return null;
    }

    this._follow(dt, headPos, headQuat);
    this.group.updateMatrixWorld(true);

    if (!this.buttons.length) {
      this.dwellProgress = 0;
      return null;
    }

    // --- 1. Direct touch.
    const poked = this._testHands(hands);
    if (poked) {
      this._hoverId = poked.button.id;
      this._dwellMs = 0;
      this.dwellProgress = 0;
      this._setHover(poked.button.id, 0);
      if (freshPinch) return this._activate(poked.button.id, true);
      return null;
    }

    // --- 2 & 3. Gaze.
    _forward.set(0, 0, -1).applyQuaternion(headQuat);
    this._raycaster.set(headPos, _forward);
    const hits = this._raycaster.intersectObjects(
      this.buttons.map((b) => b.mesh),
      false,
    );
    const hit = hits[0]?.object.userData.button || null;

    if (!hit) {
      this._resetDwell();
      return null;
    }

    if (hit.id !== this._hoverId) {
      this._hoverId = hit.id;
      this._dwellMs = 0;
    }

    // A pinch confirms whatever you are currently looking at, immediately —
    // aiming with your head and confirming with a pinch is already a single
    // deliberate action, the same as touching a button directly (which has
    // no dwell requirement either). Gating this on a minimum dwell first
    // left a window where a pinch that landed before that timer elapsed was
    // never claimed by the UI at all, so it fell through to the draw/tag
    // code as an ordinary pinch instead of pressing the button you were
    // looking at — exactly the "pressing DONE still draws" bug this fixes.
    if (freshPinch) {
      return this._activate(hit.id, true);
    }

    this._dwellMs += dt * 1000;
    this.dwellProgress = Math.min(1, this._dwellMs / config.ui.gazeDwellMs);
    this._setHover(hit.id, this.dwellProgress);

    if (this._dwellMs >= config.ui.gazeDwellMs) {
      return this._activate(hit.id, false);
    }
    return null;
  }

  _activate(id, viaPinch) {
    if (viaPinch) this.pinchConsumed = true;
    this._resetDwell();
    return id;
  }

  _anyPinching(hands) {
    for (const hand of hands) {
      if (hand?.visible && hand.pinching) return true;
    }
    return false;
  }

  /**
   * Is a fingertip — or the point where a pinch closes — inside a button's
   * rect and close to its plane?
   */
  _testHands(hands) {
    for (const hand of hands) {
      if (!hand?.visible) continue;
      for (const button of this.buttons) {
        for (const probe of [hand.indexTip, hand.pinchPoint]) {
          if (!probe) continue;
          _local.copy(probe);
          button.mesh.worldToLocal(_local);
          if (Math.abs(_local.z) > 0.06) continue;
          if (Math.abs(_local.x) > button.widthM * 0.5) continue;
          if (Math.abs(_local.y) > button.heightM * 0.5) continue;
          return { button, pinching: hand.pinching };
        }
      }
    }
    return null;
  }

  _setHover(id, progress) {
    for (const b of this.buttons) {
      b.setState(b.id === id, b.id === id ? progress : 0);
    }
  }

  _resetDwell() {
    this._hoverId = null;
    this._dwellMs = 0;
    this.dwellProgress = 0;
    this._setHover(null, 0);
  }

  /**
   * The panel stays put until you look far enough away, then glides to catch
   * up. Rigid head-locking is nauseating; a panel that never moves gets lost.
   */
  _follow(dt, headPos, headQuat) {
    if (!this._anchored) {
      this.recenter(headPos, headQuat);
      return;
    }

    _forward.set(0, 0, -1).applyQuaternion(headQuat);
    this._targetPos.copy(headPos).addScaledVector(_forward, config.ui.panelDistance);

    _toPanel.subVectors(this.group.position, headPos);
    const angle = _toPanel.lengthSq() > 1e-8
      ? THREE.MathUtils.radToDeg(_toPanel.normalize().angleTo(_forward))
      : 0;

    if (angle > config.ui.followAngleDeg) this._following = true;
    else if (angle < config.ui.followAngleDeg * 0.3) this._following = false;

    if (this._following) {
      const t = 1 - Math.pow(1 - config.ui.followLerp, dt * 60);
      this.group.position.lerp(this._targetPos, t);
    }

    // Always face the viewer, so text never skews even mid-glide. Argument
    // order matches Object3D.lookAt for non-cameras: this points the panel's
    // +Z (its front face) at the head, rather than away from it.
    _lookMatrix.lookAt(headPos, this.group.position, _worldUp);
    this.group.quaternion.setFromRotationMatrix(_lookMatrix);
  }

  dispose() {
    this.prompt.dispose();
    for (const b of this.buttons) b.dispose();
    this.buttons = [];
  }
}

const _forward = new THREE.Vector3();
const _toPanel = new THREE.Vector3();
const _local = new THREE.Vector3();
const _lookMatrix = new THREE.Matrix4();
const _worldUp = new THREE.Vector3(0, 1, 0);

export default WorldUI;
