import http from 'node:http';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { Rooms, send } from './Rooms.js';
import { serveStatic } from './static.js';
import * as bot from './game/bot.js';

/**
 * The server.
 *
 * ## The protocol, in full
 *
 * Client sends:
 *   {t:'create', name}              make a new table and sit at it
 *   {t:'join',   code, name}        sit at an existing one
 *   {t:'rejoin', code, token}       take back a seat after a dropped socket
 *   {t:'start'}                     host only: deal a round
 *   {t:'settings', mrWhiteCount}    host only
 *   {t:'addBot'}                    host only: seat an AI player
 *   {t:'removeBot', playerId}       host only
 *   {t:'hint',  text}               on your turn
 *   {t:'vote',  targetId}
 *   {t:'guess', text}               the caught Mr. White, once
 *   {t:'leave'}
 *
 * Server sends:
 *   {t:'joined', room, playerId, token}
 *   {t:'state',  room, ...the view for *this* player}
 *   {t:'error',  message, fatal?}
 *   {t:'left'}
 *
 * Note what is not in that list: there is no message carrying the whole game
 * for the client to filter. Every `state` is built by `Game.viewFor` for one
 * named player, so Mr. White's phone is never sent the word in the first
 * place. Hiding it in the interface would be theatre.
 */

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

/** A phone that sleeps leaves a socket that looks open but answers nothing.
 *  Left alone, the table would sit forever waiting on a vote from a player
 *  who is not there — so dead sockets are found and closed on a timer. */
const HEARTBEAT_MS = 20000;
const SWEEP_MS = 5 * 60 * 1000;

const rooms = new Rooms();
const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

function fail(ws, message, fatal = false) {
  send(ws, { t: 'error', message, fatal });
}

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.roomCode = null;
  ws.playerId = null;

  ws.on('pong', () => { ws.alive = true; });
  ws.on('error', () => { /* handled by 'close' */ });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return fail(ws, 'Unreadable message.');
    }
    if (!msg || typeof msg.t !== 'string') return fail(ws, 'Unreadable message.');
    try {
      route(ws, msg);
    } catch (err) {
      console.error('[mr-white] handler error:', err);
      fail(ws, 'Something went wrong at our end.');
    }
    return undefined;
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room || !ws.playerId) return;
    room.unseat(ws.playerId, ws);
    afterChange(room);
  });
});

function route(ws, msg) {
  switch (msg.t) {
    case 'create': return onCreate(ws, msg);
    case 'join': return onJoin(ws, msg);
    case 'rejoin': return onRejoin(ws, msg);
    default: return onAction(ws, msg);
  }
}

function attach(ws, room, playerId, token) {
  ws.roomCode = room.code;
  ws.playerId = playerId;
  room.seat(playerId, ws);
  send(ws, { t: 'joined', room: room.code, playerId, token });
  afterChange(room);
}

function onCreate(ws, { name }) {
  const room = rooms.create();
  if (!room) return fail(ws, 'The server is full right now — try again in a minute.');
  const res = room.join(name);
  if (!res.ok) {
    rooms.sweep(); // the room is empty and should not linger
    return fail(ws, res.error);
  }
  return attach(ws, room, res.playerId, res.token);
}

function onJoin(ws, { code, name }) {
  const room = rooms.get(code);
  if (!room) return fail(ws, 'No table with that code.');
  const res = room.join(name);
  if (!res.ok) return fail(ws, res.error);
  return attach(ws, room, res.playerId, res.token);
}

function onRejoin(ws, { code, token }) {
  const room = rooms.get(code);
  if (!room) return fail(ws, 'That table is gone.', true);
  const res = room.rejoin(token);
  if (!res.ok) return fail(ws, res.error, true);
  return attach(ws, room, res.playerId, token);
}

function onAction(ws, msg) {
  const room = rooms.get(ws.roomCode);
  if (!room || !ws.playerId || !room.game.playerById(ws.playerId)) {
    return fail(ws, 'You are not at a table.', true);
  }
  const { game } = room;
  const mayDeal = game.canDeal(ws.playerId);

  let res;
  switch (msg.t) {
    case 'start':
      if (!mayDeal) return fail(ws, 'Only the host deals.');
      res = room.startRound();
      break;
    case 'settings':
      if (!mayDeal) return fail(ws, 'Only the host can change that.');
      res = game.setMrWhiteCount(msg.mrWhiteCount);
      break;
    case 'addBot':
      if (!mayDeal) return fail(ws, 'Only the host can add an AI player.');
      res = room.addBot();
      break;
    case 'removeBot':
      if (!mayDeal) return fail(ws, 'Only the host can remove an AI player.');
      res = room.removeBot(msg.playerId);
      break;
    case 'hint':
      res = game.submitHint(ws.playerId, msg.text);
      break;
    case 'vote':
      res = game.submitVote(ws.playerId, msg.targetId);
      break;
    case 'guess':
      res = game.submitGuess(ws.playerId, msg.text);
      break;
    case 'leave': {
      const { playerId } = ws;
      ws.roomCode = null;
      ws.playerId = null;
      room.leave(playerId);
      send(ws, { t: 'left' });
      afterChange(room);
      rooms.sweep();
      return undefined;
    }
    default:
      return fail(ws, 'Unknown action.');
  }

  if (res.ok) {
    afterChange(room);
  } else {
    // Nothing changed, so only the player who tried needs telling — but they
    // also get a fresh view, since a rejected action usually means their
    // screen had drifted from the table.
    fail(ws, res.error);
    send(ws, { t: 'state', room: room.code, ...game.viewFor(ws.playerId) });
  }
  return undefined;
}

// ------------------------------------------------------------------- bots

/** Broadcast the new state, then let any AI players react to it. */
function afterChange(room) {
  room.broadcast();
  driveBots(room);
}

const BOT_MIN_DELAY_MS = 1100;
const BOT_MAX_DELAY_MS = 3200;

/** Real hands take a moment; an instant reply reads as obviously fake. */
function botThinkingTime() {
  return BOT_MIN_DELAY_MS + Math.random() * (BOT_MAX_DELAY_MS - BOT_MIN_DELAY_MS);
}

/** Whichever bots owe the table a move right now, each gets one scheduled. */
function driveBots(room) {
  const { game } = room;
  if (game.phase === 'hint') {
    const id = game.currentTurnId();
    if (id && room.bots.has(id)) scheduleBotMove(room, id, () => runBotHint(room, id));
  } else if (game.phase === 'vote') {
    for (const p of game.players) {
      if (room.bots.has(p.id) && p.playing && p.alive && !game.votes.has(p.id)) {
        scheduleBotMove(room, p.id, () => runBotVote(room, p.id));
      }
    }
  } else if (game.phase === 'guess') {
    if (room.bots.has(game.guesserId)) scheduleBotMove(room, game.guesserId, () => runBotGuess(room, game.guesserId));
  }
}

function scheduleBotMove(room, playerId, run) {
  if (room.botPending.has(playerId)) return; // already on its way
  room.botPending.add(playerId);
  setTimeout(async () => {
    room.botPending.delete(playerId);
    try {
      await run();
    } catch (err) {
      console.error('[mr-white] bot error:', err);
    }
  }, botThinkingTime());
}

async function runBotHint(room, playerId) {
  const { game } = room;
  if (game.phase !== 'hint' || game.currentTurnId() !== playerId) return;
  const text = await bot.chooseHint(game.viewFor(playerId));
  // The table may have moved on while the bot (or the API call) was thinking.
  if (game.phase !== 'hint' || game.currentTurnId() !== playerId) return;
  if (game.submitHint(playerId, text).ok) afterChange(room);
}

async function runBotVote(room, playerId) {
  const { game } = room;
  if (game.phase !== 'vote' || game.votes.has(playerId)) return;
  const targetId = await bot.chooseVote(game.viewFor(playerId));
  if (!targetId || game.phase !== 'vote' || game.votes.has(playerId)) return;
  if (game.submitVote(playerId, targetId).ok) afterChange(room);
}

async function runBotGuess(room, playerId) {
  const { game } = room;
  if (game.phase !== 'guess' || game.guesserId !== playerId) return;
  const text = await bot.chooseGuess(game.viewFor(playerId));
  if (game.phase !== 'guess' || game.guesserId !== playerId) return;
  if (game.submitGuess(playerId, text).ok) afterChange(room);
}

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

const sweeper = setInterval(() => rooms.sweep(), SWEEP_MS);

server.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
  console.log('\n  Mr. White\n');
  console.log(`  On this machine   http://localhost:${PORT}`);
  if (lan) console.log(`  Same wifi         http://${lan}:${PORT}`);
  console.log('\n  Share either link, or just the four-letter table code.\n');
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(sweeper);
  for (const ws of wss.clients) ws.close();
  server.close(() => process.exit(0));
  // Do not let a lingering socket hold the port hostage.
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server, rooms };
