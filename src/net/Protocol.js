/**
 * Wire format for versus mode: plain JSON objects with a `type` tag, one per
 * WebRTC data-channel message. Kept separate from `NetSession` (which owns
 * the actual PeerJS transport) so the encode/decode/dispatch logic is
 * testable with no real network at all.
 *
 * Message types:
 *   ready     { weapon }              Sent once, when this player equips.
 *                                      `weapon` is WeaponSync's plain form.
 *   pose      { pos, quat }           Throttled live update of the weapon's
 *                                      position/orientation relative to this
 *                                      player's own head (see WeaponSync).
 *   fire      { origin, dir }         Visual only: "I just took a gun shot
 *                                      from here, in this direction" — the
 *                                      sender already decided locally
 *                                      whether it connects (see `hit`).
 *   throw     { origin, dir }         Visual only, same idea, for a thrown
 *                                      melee weapon.
 *   hit       { damage, kind }        Sender's shot/throw connected; the
 *                                      receiver applies this to their own
 *                                      health. `kind` is 'gun' | 'melee', for
 *                                      the hit-reaction effect.
 *   defeated  {}                      Sender's health reached zero.
 *   rematch   {}                      Sender wants to play again.
 */

export function encode(type, payload = {}) {
  return JSON.stringify({ type, ...payload });
}

/** @returns {{type: string, [key: string]: any}} */
export function decode(raw) {
  const msg = JSON.parse(raw);
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    throw new Error('malformed message: missing type');
  }
  return msg;
}

/** Characters a person can read aloud and type back without ambiguity. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

export function randomRoomCode(length = 5) {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

/** Normalise user-typed input the same way a generated code is shaped. */
export function normaliseRoomCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The PeerJS peer ID a room code maps to — namespaced off the shared public broker. */
export function roomCodeToPeerId(code) {
  return `arfight-${normaliseRoomCode(code)}`;
}
