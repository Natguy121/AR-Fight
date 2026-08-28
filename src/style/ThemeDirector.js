import { makeTheme, lerpTheme, passthroughTheme } from './Theme.js';

const STORAGE_KEY = 'ar-reskin-theme';

/**
 * Owns which world the room is currently wearing.
 *
 * The design constraint this exists to satisfy: **the look is chosen once and
 * then held.** Turn your head away and back and the room is exactly as you
 * left it. That is not something you get for free — the tempting
 * implementation, re-deciding per frame or whenever the view changes, would
 * make the world churn continuously and feel like a screensaver rather than a
 * place. So selection is driven only by explicit calls (`transform`, `next`,
 * `off`); nothing about looking around reaches this class at all, and
 * `update()` advances a cross-fade but can never choose anything.
 *
 * The choice also outlives the page. It is written to storage and restored on
 * boot, so reloading — or coming back tomorrow — leaves your room looking the
 * way you last saw it, rather than resetting to a stranger's idea of it.
 *
 * Where the theme *comes from* is pluggable (`source`). Today that is the
 * built-in library; with an API key it becomes Claude, choosing based on what
 * it can actually see in the room and authoring a treatment per object. The
 * stability guarantee is unaffected either way, because it is a property of
 * this class rather than of the source.
 */
export class ThemeDirector {
  /**
   * @param {object} opts
   * @param {{name: string, pick: (ctx: object) => Promise<object>}} opts.source
   * @param {Storage} [opts.storage] Injectable for tests; falsy disables persistence.
   * @param {number} [opts.fadeSeconds]
   */
  constructor({ source, storage, fadeSeconds = 0.7 } = {}) {
    this.source = source;
    this.storage = storage;
    this.fadeSeconds = fadeSeconds;

    this._off = passthroughTheme();
    /** What is actually on screen this frame. */
    this.current = this._off;
    /** What `current` is settling toward; equal to `current` when at rest. */
    this.target = this._off;

    this._from = this._off;
    this._fadeT = 1;

    /** True once a theme has been chosen — i.e. the world is transformed. */
    this.active = false;
    /** True while `source.pick` is in flight. Only the UI cares. */
    this.pending = false;
    /** Set when the last pick failed, for the UI to surface. */
    this.lastError = null;

    this._restore();
  }

  get isFading() {
    return this._fadeT < 1;
  }

  /** The name shown to the player, accounting for the off state. */
  get displayName() {
    return this.active ? this.target.name : 'Off';
  }

  /**
   * Choose a look and settle into it. Safe to call while one is in flight —
   * the second call is ignored rather than queued, so a double-tap cannot
   * leave two picks racing to be the one that sticks.
   */
  async transform() {
    if (this.pending) return this.target;
    return this._pick({ exclude: null });
  }

  /** Deliberately move to a different look. The only other way it can change. */
  async next() {
    if (this.pending) return this.target;
    return this._pick({ exclude: this.active ? this.target.id : null });
  }

  async _pick({ exclude }) {
    this.pending = true;
    this.lastError = null;
    try {
      const theme = makeTheme(await this.source.pick({ exclude }));
      this._settleTo(theme);
      this.active = true;
      this._persist(theme);
      return theme;
    } catch (err) {
      this.lastError = err;
      throw err;
    } finally {
      this.pending = false;
    }
  }

  /** Back to the untouched camera view. */
  off() {
    this._settleTo(this._off);
    this.active = false;
    this._persist(null);
  }

  /** Adopt a theme directly, bypassing the source. Used by restore and tests. */
  set(raw, { fade = true, persist = true } = {}) {
    const theme = makeTheme(raw);
    this._settleTo(theme, { fade });
    this.active = theme.id !== this._off.id;
    if (persist) this._persist(this.active ? theme : null);
    return theme;
  }

  _settleTo(theme, { fade = true } = {}) {
    this._from = this.current;
    this.target = theme;
    if (fade && this.fadeSeconds > 0) {
      this._fadeT = 0;
    } else {
      this._fadeT = 1;
      this.current = theme;
    }
  }

  /**
   * Advance the cross-fade. Call once per frame.
   *
   * Note what this deliberately cannot do: it has no access to the source and
   * never consults the head pose, so no amount of looking around — or of time
   * simply passing — can change which theme is being shown.
   */
  update(dt) {
    if (this._fadeT >= 1) return this.current;
    this._fadeT = Math.min(1, this._fadeT + dt / this.fadeSeconds);
    this.current = this._fadeT >= 1
      ? this.target
      : lerpTheme(this._from, this.target, this._fadeT);
    return this.current;
  }

  _persist(theme) {
    if (!this.storage) return;
    try {
      if (theme) this.storage.setItem(STORAGE_KEY, JSON.stringify(theme));
      else this.storage.removeItem(STORAGE_KEY);
    } catch {
      // Private browsing, or storage full. Losing the memory across reloads is
      // a real cost but not one worth failing a session over.
    }
  }

  _restore() {
    if (!this.storage) return;
    let saved = null;
    try {
      saved = this.storage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (!saved) return;
    try {
      // Restored without a fade: fading up from grey on every reload would
      // advertise the reload rather than hide it.
      this.set(JSON.parse(saved), { fade: false, persist: false });
    } catch {
      this._persist(null); // Corrupt entry; clear it rather than retry forever.
    }
  }
}

/**
 * The offline source: pick from the hand-authored library.
 *
 * Deliberately shaped like the Claude source — one async `pick` that returns
 * something `makeTheme` accepts — so swapping them is a constructor argument
 * rather than a rewrite.
 */
export class ThemeSource {
  /** @param {object[]} themes @param {() => number} [random] Injectable for tests. */
  constructor(themes, random = Math.random) {
    this.name = 'Built-in';
    this.themes = themes;
    this.random = random;
  }

  async pick({ exclude } = {}) {
    const pool = this.themes.filter((t) => t.id !== exclude);
    const from = pool.length ? pool : this.themes;
    return from[Math.floor(this.random() * from.length) % from.length];
  }
}

export default ThemeDirector;
