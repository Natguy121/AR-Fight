import * as THREE from 'three';

const PPM = 700;
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif';

/**
 * Head-locked health readout for a versus match.
 *
 * Like the rest of the in-session UI, this has to be a textured quad in the
 * 3D scene rather than DOM — a stereo headset renders each eye separately,
 * so a DOM overlay would only ever be visible to one of them. Head-locked
 * (see `Reticle`) rather than gaze-following like the message panel: a
 * health bar that drifts off to the side while you're tracking a moving
 * opponent would be worse than useless mid-duel.
 */
export class HealthHUD {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'health-hud';
    this.group.renderOrder = 1200;
    this.group.visible = false;

    const w = 0.62;
    const h = 0.1;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(w * PPM);
    this.canvas.height = Math.round(h * PPM);
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    /** Distance in front of the viewer, and height above the resting gaze —
     * out of the way of aiming, still glanceable. */
    this.distance = 0.9;
    this.offsetY = 0.34;

    this._myHealth = -1;
    this._oppHealth = -1;
  }

  setVisible(v) {
    this.group.visible = v;
  }

  /** @param {THREE.Vector3} headPos @param {THREE.Quaternion} headQuat */
  updateTransform(headPos, headQuat) {
    _fwd.set(0, 0, -1).applyQuaternion(headQuat);
    _up.set(0, 1, 0).applyQuaternion(headQuat);
    this.group.position
      .copy(headPos)
      .addScaledVector(_fwd, this.distance)
      .addScaledVector(_up, this.offsetY);
    this.group.quaternion.copy(headQuat);
  }

  render(myHealth, opponentHealth, maxHealth) {
    const my = Math.round(myHealth);
    const opp = Math.round(opponentHealth);
    if (my === this._myHealth && opp === this._oppHealth) return;
    this._myHealth = my;
    this._oppHealth = opp;

    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const barW = w * 0.46;
    this._drawBar(0, 0, barW, h, 'YOU', my, maxHealth, '#5ac8fa');
    this._drawBar(w - barW, 0, barW, h, 'THEM', opp, maxHealth, '#ff6b6b');

    this.texture.needsUpdate = true;
  }

  _drawBar(x, y, w, h, label, value, max, color) {
    const { ctx } = this;
    const pad = h * 0.1;
    const trackY = h * 0.42;
    const trackH = h * 0.4;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `700 ${h * 0.3}px ${FONT}`;
    ctx.fillStyle = 'rgba(233,238,247,0.92)';
    ctx.fillText(label, x, y + pad * 0.2);

    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    roundRect(ctx, x, y + trackY, w, trackH, trackH * 0.4);
    ctx.fill();

    const frac = Math.max(0, Math.min(1, value / max));
    if (frac > 0) {
      ctx.fillStyle = color;
      roundRect(ctx, x, y + trackY, Math.max(trackH, w * frac), trackH, trackH * 0.4);
      ctx.fill();
    }

    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${trackH * 0.62}px ${FONT}`;
    ctx.fillText(String(Math.max(0, value)), x + w, y + trackY + trackH * 0.19);
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

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();

export default HealthHUD;
