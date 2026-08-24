/**
 * Synthesised sound effects — no audio files, no extra downloads.
 *
 * Everything is a short oscillator or noise burst shaped by an envelope, built
 * on demand. In a headset your hands are out of view of the screen, so the
 * click that confirms a shot or a hit is doing real work: it is often the only
 * immediate confirmation that a gesture registered.
 */
export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this._noiseBuffer = null;
  }

  /** Must be called from a user gesture, or the context starts suspended. */
  init() {
    if (this.ctx) return this;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      this.enabled = false;
      return this;
    }
    try {
      this.ctx = new AudioCtx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
    } catch {
      this.enabled = false;
    }
    return this;
  }

  resume() {
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  setEnabled(v) {
    this.enabled = v;
    if (this.master) this.master.gain.value = v ? 0.32 : 0;
  }

  _now() {
    return this.ctx.currentTime;
  }

  /** Cached one-second buffer of white noise, for percussive layers. */
  _noise() {
    if (this._noiseBuffer) return this._noiseBuffer;
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, rate, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuffer = buffer;
    return buffer;
  }

  _tone({ freq, endFreq, duration, type = 'sine', gain = 0.5, delay = 0 }) {
    const t0 = this._now() + delay;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t0 + duration);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(env).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  _burst({ duration = 0.12, gain = 0.5, filterFreq = 1800, delay = 0 }) {
    const t0 = this._now() + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(filterFreq, t0);
    filter.Q.value = 0.9;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, t0);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter).connect(env).connect(this.master);
    src.start(t0);
    src.stop(t0 + duration + 0.02);
  }

  _guard() {
    if (!this.enabled || !this.ctx) return false;
    this.resume();
    return true;
  }

  shot() {
    if (!this._guard()) return;
    this._burst({ duration: 0.09, gain: 0.55, filterFreq: 1400 });
    this._tone({ freq: 190, endFreq: 55, duration: 0.11, type: 'square', gain: 0.28 });
  }

  swing() {
    if (!this._guard()) return;
    this._burst({ duration: 0.18, gain: 0.16, filterFreq: 900 });
  }

  hit() {
    if (!this._guard()) return;
    this._tone({ freq: 880, endFreq: 300, duration: 0.16, type: 'triangle', gain: 0.4 });
    this._burst({ duration: 0.07, gain: 0.3, filterFreq: 2600 });
  }

  /** Rising two-note confirm, for completing a step. */
  confirm() {
    if (!this._guard()) return;
    this._tone({ freq: 620, duration: 0.09, type: 'sine', gain: 0.3 });
    this._tone({ freq: 930, duration: 0.13, type: 'sine', gain: 0.3, delay: 0.07 });
  }

  /** Soft tick, for placing an anchor or starting a stroke. */
  tick() {
    if (!this._guard()) return;
    this._tone({ freq: 1250, duration: 0.045, type: 'sine', gain: 0.2 });
  }

  /** Descending note, for undo or a rejected action. */
  cancel() {
    if (!this._guard()) return;
    this._tone({ freq: 420, endFreq: 240, duration: 0.12, type: 'sine', gain: 0.25 });
  }
}

export default Sound;
