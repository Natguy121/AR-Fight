/**
 * The VR client's end of the wire.
 *
 * Deliberately the *same* protocol as the phone client — the whole point of
 * this mode being an option rather than a separate game is that a headset and
 * four phones can sit at one table. There is no VR-specific message: the
 * server has no idea which of its players is wearing a headset, and does not
 * need to.
 *
 * It also reuses the phone client's session key, so putting a headset on
 * mid-game drops you back into the seat you already had rather than seating
 * a second copy of you.
 */

const SESSION_KEY = 'mrwhite.session';

export const session = {
  read() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || {}; } catch { return {}; }
  },
  write(value) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(value)); } catch { /* private mode */ }
  },
  clear() {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
  },
};

export function createNet({
  onState = () => {},
  onJoined = () => {},
  onError = () => {},
  onLeft = () => {},
  onConnection = () => {},
} = {}) {
  let socket = null;
  let pending = null;
  let retryMs = 400;
  let closed = false;
  let me = session.read();

  function send(msg) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    else pending = msg;
  }

  function connect() {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${scheme}//${location.host}`);

    socket.onopen = () => {
      retryMs = 400;
      onConnection(true);
      if (pending) {
        socket.send(JSON.stringify(pending));
        pending = null;
      } else if (me.room && me.token) {
        socket.send(JSON.stringify({ t: 'rejoin', code: me.room, token: me.token }));
      }
    };

    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.t) {
        case 'joined':
          me = { room: msg.room, token: msg.token, name: me.name, playerId: msg.playerId };
          session.write(me);
          onJoined(me);
          break;
        case 'state':
          onState(msg);
          break;
        case 'left':
          session.clear();
          me = {};
          onLeft();
          break;
        case 'error':
          onError(msg.message, Boolean(msg.fatal));
          if (msg.fatal) {
            session.clear();
            me = {};
          }
          break;
        default:
          break;
      }
    };

    socket.onclose = () => {
      onConnection(false);
      if (closed) return;
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 1.8, 5000);
    };

    socket.onerror = () => { /* close follows and handles it */ };
  }

  return {
    connect,
    send,
    get me() { return me; },
    create(name) {
      me = { ...me, name };
      send({ t: 'create', name });
    },
    join(code, name) {
      me = { ...me, name };
      send({ t: 'join', code, name });
    },
    leave() {
      send({ t: 'leave' });
    },
    stop() {
      closed = true;
      socket?.close();
    },
  };
}

export default createNet;
