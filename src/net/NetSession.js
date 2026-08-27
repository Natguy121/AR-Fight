import { encode, decode, randomRoomCode, roomCodeToPeerId } from './Protocol.js';

/**
 * One peer-to-peer link to an opponent, for versus mode.
 *
 * Uses PeerJS (loaded from a CDN `<script>` tag in index.html, exposing
 * `window.Peer`) purely for its free public signalling broker — establishing
 * a WebRTC connection needs *some* server to exchange session descriptions
 * before the two phones can talk directly, and this avoids needing to run
 * one. Once connected, gameplay messages flow straight over the resulting
 * WebRTC data channel, peer to peer — nothing about a match is relayed
 * through a server this app owns.
 *
 * The message plumbing (`send`/`_handleRaw`/`_dispatch`) is deliberately
 * separable from the PeerJS wiring: `_handleRaw` and `send` are the only
 * points of contact with the transport, so tests can drive this class with a
 * fake `_conn` — or two `NetSession`s wired directly to each other — and
 * never touch a real network or PeerJS at all.
 *
 * `host()` resolves as soon as a room code is claimed, which is *not* the
 * same moment as being connected (nobody may have joined yet) — callers that
 * need to know when a match can actually start should use `onConnected`.
 */
export class NetSession {
  constructor() {
    /** @type {'host'|'join'|null} */
    this.role = null;
    this.connected = false;
    this.roomCode = null;

    /** Fires once the data channel opens — the earliest point either side can send. */
    this.onConnected = null;
    /** Fires if a previously-open connection drops. */
    this.onDisconnected = null;

    this._peer = null;
    this._conn = null;
    this._handlers = new Map();
  }

  /**
   * @param {string} type
   * @param {(msg: object) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(handler);
    return () => this._handlers.get(type)?.delete(handler);
  }

  /** Route one decoded message to every handler registered for its type (plus '*'). */
  _dispatch(msg) {
    for (const fn of this._handlers.get(msg.type) || []) fn(msg);
    for (const fn of this._handlers.get('*') || []) fn(msg);
  }

  /** Decode one incoming wire message and dispatch it. Malformed data is dropped, not thrown. */
  _handleRaw(raw) {
    let msg;
    try {
      msg = decode(raw);
    } catch {
      return;
    }
    this._dispatch(msg);
  }

  send(type, payload) {
    if (!this._conn || !this.connected) return false;
    this._conn.send(encode(type, payload));
    return true;
  }

  /**
   * Claim a room code on the public broker. Resolves with the code as soon
   * as it is claimed — use `onConnected` to know when the other player has
   * actually joined.
   * @param {(status: string) => void} [onStatus] Human-readable progress.
   * @returns {Promise<string>}
   */
  host(onStatus) {
    this.role = 'host';
    return new Promise((resolve, reject) => this._openHostPeer(onStatus, resolve, reject));
  }

  /**
   * @param {string} code The host's room code.
   * @param {(status: string) => void} [onStatus]
   * @returns {Promise<void>} resolves once the data channel is open.
   */
  join(code, onStatus) {
    this.role = 'join';
    this.roomCode = code;
    return new Promise((resolve, reject) => {
      const PeerCtor = globalThis.Peer;
      if (!PeerCtor) {
        reject(new Error('Networking library did not load. Check your connection and reload.'));
        return;
      }
      onStatus?.('Connecting…');
      const peer = new PeerCtor(undefined, { debug: 0 });
      this._peer = peer;

      peer.on('open', () => {
        const conn = peer.connect(roomCodeToPeerId(code), { reliable: true });
        this._wireConnection(conn, onStatus, resolve, reject);
      });
      peer.on('error', (err) => reject(NetSession._describeError(err, 'join')));
    });
  }

  _openHostPeer(onStatus, resolve, reject, attempt = 0) {
    const PeerCtor = globalThis.Peer;
    if (!PeerCtor) {
      reject(new Error('Networking library did not load. Check your connection and reload.'));
      return;
    }
    if (attempt >= 5) {
      reject(new Error('Could not claim a room code. Try again.'));
      return;
    }

    const code = randomRoomCode();
    onStatus?.('Setting up…');
    const peer = new PeerCtor(roomCodeToPeerId(code), { debug: 0 });
    this._peer = peer;

    peer.on('open', () => {
      this.roomCode = code;
      onStatus?.('Waiting for your friend…');
      resolve(code);
    });
    peer.on('connection', (conn) => {
      // Nobody is awaiting a promise for this any more (host() already
      // resolved with the code) — connecting is reported via onConnected.
      this._wireConnection(conn, onStatus, () => {}, () => {});
    });
    peer.on('error', (err) => {
      // Someone else already holds this code (astronomically unlikely with a
      // 5-character namespaced ID, but free and cheap to just retry) — start
      // over with a fresh one rather than failing outright.
      if (err?.type === 'unavailable-id') {
        peer.destroy();
        this._openHostPeer(onStatus, resolve, reject, attempt + 1);
        return;
      }
      reject(NetSession._describeError(err, 'host'));
    });
  }

  _wireConnection(conn, onStatus, resolve, reject) {
    this._conn = conn;
    conn.on('open', () => {
      this.connected = true;
      onStatus?.('Connected!');
      resolve();
      this.onConnected?.();
    });
    conn.on('data', (raw) => this._handleRaw(raw));
    conn.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) this.onDisconnected?.();
    });
    conn.on('error', (err) => {
      if (!this.connected) reject(NetSession._describeError(err, this.role));
    });
  }

  static _describeError(err, role) {
    const type = err?.type || '';
    if (type === 'peer-unavailable') {
      return new Error("That code isn't live right now — check it, or ask for a fresh one.");
    }
    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      return new Error('Lost the connection to the matchmaking service. Check your internet and try again.');
    }
    return new Error(`Could not ${role === 'host' ? 'start hosting' : 'connect'}: ${err?.message || err}`);
  }

  close() {
    try {
      this._conn?.close();
    } catch {
      /* already gone */
    }
    try {
      this._peer?.destroy();
    } catch {
      /* already gone */
    }
    this._conn = null;
    this._peer = null;
    this.connected = false;
  }
}

export default NetSession;
