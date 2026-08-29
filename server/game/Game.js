import { normalize, isOneWord, sameWord } from './text.js';

/**
 * The rules of Mr. White, with no networking anywhere in them.
 *
 * Everything here is a pure state machine: you call a method, it returns
 * `{ok}` or `{ok: false, error}`, and the state moves. Nothing reaches for a
 * socket or a clock. That is what lets `tools/test.js` play entire games
 * deterministically, including the ones that are almost impossible to
 * reproduce by hand — a three-way tie, everyone disconnecting mid-vote,
 * Mr. White guessing the word correctly on the last breath.
 *
 * ## The one property that matters
 *
 * Mr. White must never learn the word from the app. Not from a field, not
 * from an error message, not from a log entry meant for someone else. Get
 * that wrong and the game is not merely buggy, it is pointless — anyone with
 * the developer console open wins every round.
 *
 * So the redaction lives *here*, in `viewFor`, and not in the client. Each
 * player is handed their own view of the state and there is no other way to
 * see it. The server never broadcasts one blob for the client to filter,
 * because a client-side filter is a decoration, not a rule.
 *
 * One consequence worth spelling out, because it is a real leak and an easy
 * one to write by accident: the "you cannot say the secret word" rule applies
 * to civilians only. If Mr. White submitted the word as a hint and the server
 * answered "you cannot use that word", the rejection itself would confirm
 * they had guessed right. Mr. White's hints are therefore never checked
 * against the word at all — and if they do land on it exactly, it stands as
 * their hint, which is a spectacular and completely legitimate way to blend
 * in with people who are describing that very thing.
 */

/** lobby → hint ⇄ vote → (guess) → reveal → hint … */
export const PHASES = ['lobby', 'hint', 'vote', 'guess', 'reveal'];

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 12;
export const MAX_NAME_LENGTH = 16;

/** Civilians win a round: two points each. */
export const SCORE_CIVILIAN = 2;
/** Mr. White survives, or is caught and names the word anyway: six. */
export const SCORE_MR_WHITE = 6;

/**
 * How many Mr. Whites for a given table size.
 *
 * One is right for almost every game. Past about eight players a lone
 * Mr. White is too easy to corner — there is simply too much testimony — so a
 * second goes in, which also gives them someone to accidentally protect.
 */
export function defaultMrWhiteCount(playerCount) {
  return playerCount >= 8 ? 2 : 1;
}

/** Fisher-Yates, with the RNG injected so a test can script the deal. */
function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class Game {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.rng] Injectable for deterministic tests.
   * @param {number|null} [opts.mrWhiteCount] Overrides the table-size default.
   */
  constructor({ rng = Math.random, mrWhiteCount = null } = {}) {
    this.rng = rng;
    this.mrWhiteCountSetting = mrWhiteCount;

    this.phase = 'lobby';
    this.players = [];
    this.hostId = null;
    this.round = 0;

    this._resetRound();
  }

  // ------------------------------------------------------------- the table

  /**
   * @returns {{ok: boolean, error?: string, player?: object}}
   */
  addPlayer({ id, name }) {
    if (this.players.some((p) => p.id === id)) {
      return { ok: false, error: 'Already at this table.' };
    }
    if (this.players.length >= MAX_PLAYERS) {
      return { ok: false, error: `This table is full (${MAX_PLAYERS} players).` };
    }
    const clean = String(name ?? '').trim().slice(0, MAX_NAME_LENGTH);
    if (!clean) return { ok: false, error: 'Pick a name first.' };
    if (this.players.some((p) => normalize(p.name) === normalize(clean))) {
      return { ok: false, error: 'Someone here is already called that.' };
    }

    const player = {
      id,
      name: clean,
      score: 0,
      connected: true,
      // Per-round, reset by `startRound`. A player who joins mid-round sits
      // out until the next one rather than appearing from nowhere holding a
      // word — being dealt in halfway through is not a thing that can happen
      // at a real table either.
      playing: false,
      role: null,
      alive: false,
    };
    this.players.push(player);
    if (!this.hostId) this.hostId = id;
    return { ok: true, player };
  }

  removePlayer(id) {
    const i = this.players.findIndex((p) => p.id === id);
    if (i === -1) return { ok: false, error: 'Not at this table.' };
    const [gone] = this.players.splice(i, 1);
    this.votes.delete(id);

    if (this.hostId === id) this.hostId = this.players[0]?.id ?? null;

    // Leaving mid-round counts as being eliminated — including the reveal of
    // what they were, since the table has to be able to make sense of the
    // empty chair. Marking them disconnected first is what stops everyone
    // being parked in front of a guess prompt belonging to a closed tab.
    if (gone.playing && gone.alive && this.phase !== 'lobby' && this.phase !== 'reveal') {
      gone.connected = false;
      gone.alive = false;
      this.log.push({ t: 'left', playerId: gone.id, name: gone.name, role: gone.role });
      this._afterPlayerLost(gone);
    }
    return { ok: true };
  }

  /**
   * A socket dropped or came back. The round keeps going regardless: a phone
   * that locks itself mid-game must never be able to hang the table.
   */
  setConnected(id, connected) {
    const player = this.players.find((p) => p.id === id);
    if (!player) return { ok: false, error: 'Not at this table.' };
    player.connected = connected;
    if (connected) return { ok: true };


    if (this.phase === 'hint' && this.currentTurnId() === id) {
      this.log.push({ t: 'skip', playerId: id });
      this._advanceTurn();
    } else if (this.phase === 'vote') {
      // They may have been the last vote everyone was waiting on.
      this._maybeResolveVote();
    } else if (this.phase === 'guess' && this.guesserId === id) {
      // Nobody else can answer for them, and the table cannot sit here
      // forever. A vanished Mr. White forfeits the guess.
      this.log.push({ t: 'guess', playerId: id, text: null, correct: false });
      this._afterFailedGuess();
    }
    return { ok: true };
  }

  /**
   * May this player deal a round and change the settings?
   *
   * The host keeps the job across a dropped connection rather than losing it
   * the moment their phone sleeps — and the reveal, where everyone looks up
   * from their screen at once, is exactly when that would happen. So hosting
   * does not migrate on a disconnect; instead the table can deal without the
   * host while they are away, which covers the case that migration was meant
   * to cover (nobody able to start) without the case it caused (the person
   * who gathered everyone quietly demoted for locking their phone).
   *
   * Hosting does move for good if they leave the table outright.
   */
  canDeal(id) {
    if (this.hostId === id) return true;
    const host = this.playerById(this.hostId);
    return !host || !host.connected;
  }

  setMrWhiteCount(n) {
    if (this.phase !== 'lobby' && this.phase !== 'reveal') {
      return { ok: false, error: 'Wait until the round is over.' };
    }
    const v = Number(n);
    if (!Number.isInteger(v) || v < 1 || v > 3) {
      return { ok: false, error: 'Between one and three Mr. Whites.' };
    }
    this.mrWhiteCountSetting = v;
    return { ok: true };
  }

  // -------------------------------------------------------------- a round

  _resetRound() {
    this.word = null;
    this.order = [];
    this.turn = 0;
    this.hintPass = 0;
    this.hints = [];
    this.votes = new Map();
    this.guesserId = null;
    this.outcome = null;
    this.log = [];
  }

  /**
   * Deal a new round.
   * @param {string} word The secret word. Supplied by the caller so the word
   *   list stays out of the rules and tests can pin it.
   */
  startRound(word) {
    if (this.phase !== 'lobby' && this.phase !== 'reveal') {
      return { ok: false, error: 'A round is already running.' };
    }
    const seated = this.players.filter((p) => p.connected);
    if (seated.length < MIN_PLAYERS) {
      return { ok: false, error: `Need ${MIN_PLAYERS} players to start.` };
    }
    if (!String(word ?? '').trim()) return { ok: false, error: 'No word supplied.' };

    this._resetRound();
    this.round += 1;
    this.word = String(word).trim();

    const mrWhites = Math.min(
      this.mrWhiteCountSetting ?? defaultMrWhiteCount(seated.length),
      // Never so many that they start already winning.
      Math.max(1, Math.floor((seated.length - 1) / 2)),
    );

    for (const p of this.players) {
      p.playing = p.connected;
      p.alive = p.connected;
      p.role = p.connected ? 'civilian' : null;
    }
    for (const p of shuffle(seated, this.rng).slice(0, mrWhites)) p.role = 'mrwhite';

    // Speaking order. The first speaker is never Mr. White, which is the
    // standard rule and not a kindness: with no word and no hints yet, going
    // first is not a hard position, it is an impossible one. Everyone knows
    // this rule, so it leaks nothing — it is stated in the app's own rules.
    const order = shuffle(seated.map((p) => p.id), this.rng);
    const firstCivilian = order.findIndex((id) => this.playerById(id).role === 'civilian');
    if (firstCivilian > 0) {
      [order[0], order[firstCivilian]] = [order[firstCivilian], order[0]];
    }
    this.order = order;

    this.phase = 'hint';
    this.turn = 0;
    this.hintPass = 1;
    this.log.push({ t: 'round', number: this.round, mrWhites });
    return { ok: true };
  }

  // --------------------------------------------------------------- hinting

  /** Whose turn it is to give a hint, or null outside the hint phase. */
  currentTurnId() {
    if (this.phase !== 'hint') return null;
    return this.order[this.turn] ?? null;
  }

  submitHint(playerId, text) {
    if (this.phase !== 'hint') return { ok: false, error: 'Not the hint phase.' };
    if (this.currentTurnId() !== playerId) return { ok: false, error: 'Not your turn.' };

    const clean = normalize(text);
    if (!isOneWord(clean)) {
      return { ok: false, error: 'One word only — no spaces.' };
    }
    if (this.hints.some((h) => h.text === clean)) {
      return { ok: false, error: 'That word has already been said.' };
    }

    // Civilians only. Checking Mr. White's hint against the word would tell
    // them, by way of the rejection, that they had just guessed it — see the
    // note at the top of this file.
    const player = this.playerById(playerId);
    if (player.role === 'civilian' && sameWord(clean, this.word)) {
      return { ok: false, error: 'You cannot say the word itself.' };
    }

    this.hints.push({ playerId, text: clean, pass: this.hintPass });
    this.log.push({ t: 'hint', playerId, text: clean, pass: this.hintPass });
    this._advanceTurn();
    return { ok: true };
  }

  /** Step to the next player who can actually speak; open the vote at the end. */
  _advanceTurn() {
    this.turn += 1;
    while (this.turn < this.order.length && !this._canSpeak(this.order[this.turn])) {
      this.log.push({ t: 'skip', playerId: this.order[this.turn], pass: this.hintPass });
      this.turn += 1;
    }
    if (this.turn >= this.order.length) this._beginVote();
  }

  _canSpeak(id) {
    const p = this.playerById(id);
    return Boolean(p && p.alive && p.connected);
  }

  // ---------------------------------------------------------------- voting

  _beginVote() {
    this.phase = 'vote';
    this.votes = new Map();
    this.log.push({ t: 'voteOpen' });
    // Everyone left may have walked away between the last hint and here.
    this._maybeResolveVote();
  }

  submitVote(voterId, targetId) {
    if (this.phase !== 'vote') return { ok: false, error: 'Not the voting phase.' };
    const voter = this.playerById(voterId);
    const target = this.playerById(targetId);
    if (!voter?.playing || !voter.alive) return { ok: false, error: 'You are out of this round.' };
    if (!target?.playing || !target.alive) return { ok: false, error: 'They are already out.' };
    if (voterId === targetId) return { ok: false, error: 'You cannot vote for yourself.' };

    // Changing your mind is allowed right up until the last ballot lands.
    this.votes.set(voterId, targetId);
    this._maybeResolveVote();
    return { ok: true };
  }

  /** Resolve once everyone still here has voted. */
  _maybeResolveVote() {
    if (this.phase !== 'vote') return;
    const voters = this.players.filter((p) => p.playing && p.alive && p.connected);
    if (voters.length < 2) {
      // Not enough people left to hold a vote at all.
      this._endRound({ winner: null, reason: 'abandoned' });
      return;
    }
    if (voters.every((p) => this.votes.has(p.id))) this._resolveVote();
  }

  _resolveVote() {
    const tally = new Map();
    for (const [voterId, targetId] of this.votes) {
      // A vote cast by someone who has since left does not count.
      if (!this._canSpeak(voterId)) continue;
      tally.set(targetId, (tally.get(targetId) ?? 0) + 1);
    }

    let top = 0;
    for (const n of tally.values()) top = Math.max(top, n);
    const leaders = [...tally.entries()].filter(([, n]) => n === top).map(([id]) => id);
    const ballots = [...this.votes].map(([voterId, targetId]) => ({ voterId, targetId }));

    if (leaders.length !== 1) {
      // A tie sends it back for another pass rather than to a re-vote. Every
      // pass adds a hint from everyone still alive, so the table is strictly
      // better informed next time round — which is the point, and is why this
      // cannot spiral: the deadlock is broken with evidence, not with a coin.
      this.log.push({ t: 'tie', ids: leaders, ballots });
      this._nextPass();
      return;
    }

    const out = this.playerById(leaders[0]);
    out.alive = false;
    this.log.push({
      t: 'eliminated', playerId: out.id, role: out.role, votes: top, ballots,
    });
    this._afterPlayerLost(out);
  }

  /** Shared by an elimination and by someone walking out mid-round. */
  _afterPlayerLost(player) {
    if (player.role === 'mrwhite') {
      // Caught — but not finished. Name the word and the round is theirs.
      this.phase = 'guess';
      this.guesserId = player.id;
      this.votes = new Map();
      if (!player.connected) {
        this.log.push({ t: 'guess', playerId: player.id, text: null, correct: false });
        this._afterFailedGuess();
      }
      return;
    }
    this._checkEndOrContinue();
  }

  // ------------------------------------------------------- the final guess

  submitGuess(playerId, text) {
    if (this.phase !== 'guess') return { ok: false, error: 'Nothing to guess right now.' };
    if (this.guesserId !== playerId) return { ok: false, error: 'Not your guess to make.' };
    const clean = String(text ?? '').trim();
    if (!clean) return { ok: false, error: 'Type a word.' };

    const correct = sameWord(clean, this.word);
    this.log.push({ t: 'guess', playerId, text: clean, correct });
    if (correct) {
      this._endRound({ winner: 'mrwhite', reason: 'guessed', byId: playerId });
    } else {
      this._afterFailedGuess();
    }
    return { ok: true };
  }

  _afterFailedGuess() {
    this.guesserId = null;
    this._checkEndOrContinue();
  }

  // ------------------------------------------------------------ the ending

  _checkEndOrContinue() {
    const alive = this.players.filter((p) => p.playing && p.alive);
    const whites = alive.filter((p) => p.role === 'mrwhite').length;
    const civilians = alive.length - whites;

    if (whites === 0) {
      this._endRound({ winner: 'civilians', reason: 'caught' });
    } else if (whites >= civilians) {
      // Once they are level there is no vote that can go against them: the
      // last civilian cannot out-vote a table that is half Mr. White.
      this._endRound({ winner: 'mrwhite', reason: 'survived' });
    } else {
      this._nextPass();
    }
  }

  _nextPass() {
    this.phase = 'hint';
    this.hintPass += 1;
    this.votes = new Map();
    this.turn = -1;
    this._advanceTurn();
  }

  _endRound(outcome) {
    this.phase = 'reveal';
    this.guesserId = null;
    this.outcome = { ...outcome, word: this.word };

    const playing = this.players.filter((p) => p.playing);
    if (outcome.winner === 'civilians') {
      // Everyone who was on the civilian side scores, including the ones who
      // were voted out along the way — being wrongly suspected is not a
      // failure, and a scoring rule that punished it would teach people to
      // say as little as possible, which is the opposite of the game.
      for (const p of playing) if (p.role === 'civilian') p.score += SCORE_CIVILIAN;
    } else if (outcome.winner === 'mrwhite') {
      for (const p of playing) {
        if (p.role !== 'mrwhite') continue;
        if (p.alive || p.id === outcome.byId) p.score += SCORE_MR_WHITE;
      }
    }

    this.log.push({
      t: 'end',
      winner: outcome.winner,
      reason: outcome.reason,
      word: this.word,
      roles: playing.map((p) => ({ playerId: p.id, role: p.role })),
    });
  }

  // ----------------------------------------------------------------- views

  playerById(id) {
    return this.players.find((p) => p.id === id) ?? null;
  }

  /**
   * What one player is allowed to know, and nothing more.
   *
   * This is the only way state leaves the game. Anything not built here is
   * not merely hidden from the interface, it never reaches the device.
   */
  viewFor(id) {
    const me = this.playerById(id);
    const revealed = this.phase === 'reveal';
    const knowsWord = revealed || (me?.playing && me.role === 'civilian');

    return {
      phase: this.phase,
      round: this.round,
      hostId: this.hostId,
      // Whether the controls appear is a rule, not a guess the client makes
      // from hostId — otherwise it has to re-derive "unless they are away",
      // and the two will drift.
      youCanDeal: Boolean(me) && this.canDeal(id),
      mrWhiteCount: this.mrWhiteCountSetting,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,

      you: me && {
        id: me.id,
        name: me.name,
        score: me.score,
        playing: me.playing,
        alive: me.alive,
        // Your own role, always — being Mr. White is the whole experience,
        // and there is nobody to hide it from at your end.
        role: me.playing ? me.role : null,
      },

      word: knowsWord ? this.word : null,

      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
        playing: p.playing,
        alive: p.alive,
        // A role becomes public the moment its owner is out — that reveal is
        // the information the round turns on — and at the end, for everyone.
        role: revealed || (p.playing && !p.alive) ? p.role : null,
        // Who still owes a ballot is public; what is on it is not.
        voted: this.phase === 'vote' ? this.votes.has(p.id) : false,
      })),

      order: this.order,
      turnPlayerId: this.currentTurnId(),
      hintPass: this.hintPass,
      hints: this.hints,

      yourVote: this.phase === 'vote' ? (this.votes.get(id) ?? null) : null,
      guesserId: this.phase === 'guess' ? this.guesserId : null,
      outcome: revealed ? this.outcome : null,

      log: this.log,
    };
  }
}

export default Game;
