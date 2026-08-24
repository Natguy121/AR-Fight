/**
 * The session's flow, as an explicit machine.
 *
 * Each screen has a different idea of what a pinch means — draw a stroke,
 * place an anchor, press a button — so the states are named and the
 * transitions are enumerated rather than inferred from scattered flags.
 */

export const State = {
  /** Loading camera, tracker and model. */
  BOOT: 'boot',
  /** Confirm hands are being tracked, and calibrate reach. */
  CHECK: 'check',
  /** Pinch and move to draw the weapon. */
  DRAW: 'draw',
  /** Choose gun or melee. */
  CATEGORIZE: 'categorize',
  /** Point-and-pinch each required anchor in turn. */
  TAG: 'tag',
  /** Weapon is in hand and live. */
  EQUIP: 'equip',
};

/** Which states may follow which. Guards against illegal jumps. */
const TRANSITIONS = {
  [State.BOOT]: [State.CHECK, State.DRAW],
  [State.CHECK]: [State.DRAW],
  [State.DRAW]: [State.CATEGORIZE, State.CHECK],
  [State.CATEGORIZE]: [State.TAG, State.DRAW],
  [State.TAG]: [State.EQUIP, State.CATEGORIZE, State.DRAW],
  [State.EQUIP]: [State.DRAW, State.TAG],
};

export class StateMachine {
  /** @param {(from: string, to: string) => void} [onChange] */
  constructor(onChange) {
    this.current = State.BOOT;
    this.previous = null;
    /** Seconds spent in the current state. */
    this.elapsed = 0;
    this.onChange = onChange;
  }

  canGo(to) {
    return TRANSITIONS[this.current]?.includes(to) ?? false;
  }

  /**
   * @param {string} to
   * @param {boolean} [force] Bypass the transition table (used by hard resets).
   */
  go(to, force = false) {
    if (to === this.current) return false;
    if (!force && !this.canGo(to)) {
      console.warn(`[AR-Fight] Illegal transition ${this.current} -> ${to}`);
      return false;
    }
    this.previous = this.current;
    this.current = to;
    this.elapsed = 0;
    this.onChange?.(this.previous, to);
    return true;
  }

  tick(dt) {
    this.elapsed += dt;
  }

  is(...states) {
    return states.includes(this.current);
  }
}

export default StateMachine;
