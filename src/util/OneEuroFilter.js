/**
 * One-Euro filter — Casiez, Roussel & Vogel (CHI 2012).
 *
 * Hand landmarks are jittery at rest but must not lag when you move fast.
 * A fixed low-pass forces a choice between the two; One-Euro adapts its cutoff
 * to the observed speed, so it smooths hard when still and barely at all when
 * moving. That is exactly the trade-off mid-air drawing needs.
 */

class LowPass {
  constructor() {
    this.value = 0;
    this.initialised = false;
  }

  filter(x, alpha) {
    if (!this.initialised) {
      this.value = x;
      this.initialised = true;
      return x;
    }
    this.value = alpha * x + (1 - alpha) * this.value;
    return this.value;
  }

  reset() {
    this.initialised = false;
    this.value = 0;
  }
}

function alphaFor(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.minCutoff] Cutoff (Hz) at zero speed. Lower = smoother at rest.
   * @param {number} [opts.beta] Speed coefficient. Higher = less lag when moving.
   * @param {number} [opts.dCutoff] Cutoff (Hz) for the derivative estimate.
   */
  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.lastTime = null;
  }

  /**
   * @param {number} value Raw sample.
   * @param {number} timestamp Monotonic time in seconds.
   */
  filter(value, timestamp) {
    if (!Number.isFinite(value)) return this.x.value;

    let dt = 1 / 60;
    if (this.lastTime !== null) {
      const delta = timestamp - this.lastTime;
      // Guard against stalls (tab backgrounded) and duplicate timestamps.
      if (delta > 1e-5 && delta < 0.5) dt = delta;
    }
    this.lastTime = timestamp;

    const prev = this.x.initialised ? this.x.value : value;
    const rawDeriv = (value - prev) / dt;
    const deriv = this.dx.filter(rawDeriv, alphaFor(this.dCutoff, dt));

    const cutoff = this.minCutoff + this.beta * Math.abs(deriv);
    return this.x.filter(value, alphaFor(cutoff, dt));
  }

  reset() {
    this.x.reset();
    this.dx.reset();
    this.lastTime = null;
  }
}

/** Three independent One-Euro filters driving a THREE.Vector3-like target. */
export class OneEuroVec3 {
  constructor(opts) {
    this.fx = new OneEuroFilter(opts);
    this.fy = new OneEuroFilter(opts);
    this.fz = new OneEuroFilter(opts);
  }

  /**
   * @param {{x:number,y:number,z:number}} v Raw vector (not mutated).
   * @param {number} t Time in seconds.
   * @param {{x:number,y:number,z:number}} out Destination.
   */
  filter(v, t, out) {
    out.x = this.fx.filter(v.x, t);
    out.y = this.fy.filter(v.y, t);
    out.z = this.fz.filter(v.z, t);
    return out;
  }

  reset() {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }
}
