import { randomUUID } from 'node:crypto';
import { Game } from '../public/shared/game/Game.js';
import { drawWord } from '../public/shared/game/words.js';
import * as bot from './game/bot.js';

/**
 * Tables, and the people sitting at them.
 *
 * A room owns a `Game` and the sockets attached to it, and its single real
 * responsibility is this: **every player is sent their own view of the state,
 * never a shared one.** There is no message on the wire containing the whole
 * game that a client is trusted to filter down — Mr. White's device is never
 * sent the word at all, so no amount of poking at the page can reveal it.
 * `Game.viewFor` decides what each person may know; this file just addresses
 * the envelopes.
 */

/** No I or O: these get read aloud and typed in by someone across the room. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 4;

const MAX_ROOMS = 500;
/** How long a table with nobody connected is held before it is forgotten. */
const IDLE_MS = 30 * 60 * 1000;

/** Bots never open a tab, so they never collide with a human's name choice
 *  as long as this list does not repeat within one table. */
const BOT_NAMES = ['Ada', 'Watson', 'Nova', 'Echo', 'Turing', 'Vega', 'Byte', 'Pixel', 'Juno', 'Orin'];

export class Room {
  constructor(code) {
    this.code = code;
    this.game = new Game();
    /** playerId -> WebSocket */
    this.sockets = new Map();
    /** A private token per player, so a locked phone can come back to its seat. */
    this.tokens = new Map();
    /** Words this table has already had, so a night of play does not repeat. */
    this.usedWords = new Set();
    /** Which seated players are AI-controlled. */
    this.bots = new Set();
    /** Bot ids with a decision already scheduled, so a re-broadcast before it
     *  fires cannot queue the same move twice. */
    this.botPending = new Set();
    this.touched = Date.now();
  }

  get empty() {
    return this.game.players.length === 0;
  }

  get idle() {
    return this.sockets.size === 0 && Date.now() - this.touched > IDLE_MS;
  }

  /** Hand every attached socket the state as that player is allowed to see it. */
  broadcast() {
    this.touched = Date.now();
    for (const [playerId, ws] of this.sockets) {
      const view = this.game.viewFor(playerId);
      view.players = view.players.map((p) => ({ ...p, isBot: this.bots.has(p.id) }));
      send(ws, { t: 'state', room: this.code, aiConfigured: bot.isConfigured(), ...view });
    }
  }

  seat(playerId, ws) {
    const existing = this.sockets.get(playerId);
    // A second tab for the same seat takes it over; the old one is told why
    // rather than being left showing a game it is no longer part of.
    if (existing && existing !== ws) {
      send(existing, { t: 'error', message: 'You opened this game somewhere else.', fatal: true });
      existing.close();
    }
    this.sockets.set(playerId, ws);
    this.game.setConnected(playerId, true);
    this.touched = Date.now();
  }

  unseat(playerId, ws) {
    // Only if this socket is still the one holding the seat: a stale close
    // event from a replaced tab must not knock the live one offline.
    if (this.sockets.get(playerId) !== ws) return;
    this.sockets.delete(playerId);
    this.game.setConnected(playerId, false);
    this.touched = Date.now();
  }

  /** @returns {{ok: boolean, error?: string, playerId?: string, token?: string}} */
  join(name) {
    const playerId = randomUUID();
    const res = this.game.addPlayer({ id: playerId, name });
    if (!res.ok) return res;
    const token = randomUUID();
    this.tokens.set(token, playerId);
    return { ok: true, playerId, token };
  }

  rejoin(token) {
    const playerId = this.tokens.get(token);
    if (!playerId || !this.game.playerById(playerId)) {
      return { ok: false, error: 'That seat is gone.' };
    }
    return { ok: true, playerId };
  }

  leave(playerId) {
    this.sockets.delete(playerId);
    for (const [token, id] of this.tokens) if (id === playerId) this.tokens.delete(token);
    this.game.removePlayer(playerId);
    this.touched = Date.now();
  }

  /** Deal a round with a word this table has not had. */
  startRound() {
    const word = drawWord(this.usedWords);
    const res = this.game.startRound(word);
    if (res.ok) this.usedWords.add(word);
    return res;
  }

  /** Seat an AI player. It never gets a socket — its moves are driven by
   *  the server itself, reading the exact view a human at that seat would
   *  get, so it has no more information than anyone else at the table. */
  addBot() {
    const label = this.nextBotName();
    const playerId = `bot-${randomUUID()}`;
    const res = this.game.addPlayer({ id: playerId, name: label });
    if (!res.ok) return res;
    this.bots.add(playerId);
    return { ok: true, playerId };
  }

  removeBot(playerId) {
    if (!this.bots.has(playerId)) return { ok: false, error: 'That is not an AI player.' };
    this.bots.delete(playerId);
    this.botPending.delete(playerId);
    return this.game.removePlayer(playerId);
  }

  nextBotName() {
    const taken = new Set(this.game.players.map((p) => p.name));
    for (const n of BOT_NAMES) {
      const label = `${n} (AI)`;
      if (!taken.has(label)) return label;
    }
    return `Bot ${Math.floor(Math.random() * 1000)} (AI)`;
  }
}

export class Rooms {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  get(code) {
    return this.rooms.get(String(code ?? '').trim().toUpperCase()) ?? null;
  }

  create() {
    this.sweep();
    if (this.rooms.size >= MAX_ROOMS) return null;

    let code;
    do {
      code = Array.from(
        { length: CODE_LENGTH },
        () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
      ).join('');
    } while (this.rooms.has(code));

    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }

  /** Drop tables nobody came back to. */
  sweep() {
    for (const [code, room] of this.rooms) {
      if (room.empty || room.idle) this.rooms.delete(code);
    }
  }
}

/** Send JSON, tolerating a socket that closed between the check and the write. */
export function send(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* the socket went away mid-write; the close handler will tidy up */
  }
}

export default Rooms;
