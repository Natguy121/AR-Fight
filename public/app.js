/**
 * The client.
 *
 * It renders whatever the server sends and nothing else. There is no game
 * state here, no copy of the word, no "hidden" field waiting in memory for
 * someone to open the console — if you are Mr. White, the word is not on your
 * device at any point. That is a property of the protocol, not of this file,
 * and this file is careful not to undermine it.
 */

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'mrwhite.session';

// --------------------------------------------------------------- session

const session = {
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

let me = session.read();          // { room, token, name }
let state = null;                 // the latest view from the server
let socket = null;
let pending = null;               // message to send the moment we are connected
let retryMs = 400;
let shownRound = null;            // which round's role card has been seen
let wordCovered = false;

// ------------------------------------------------------------ connection

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${scheme}//${location.host}`);

  socket.onopen = () => {
    retryMs = 400;
    $('conn').classList.remove('down');
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
    receive(msg);
  };

  socket.onclose = () => {
    $('conn').classList.add('down');
    // Backed off, but capped: someone whose train went into a tunnel should
    // be back in the game a few seconds after coming out of it, not a minute.
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 1.8, 5000);
  };

  socket.onerror = () => { /* close will follow and handle it */ };
}

function send(msg) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  else pending = msg;
}

function receive(msg) {
  switch (msg.t) {
    case 'joined':
      me = { room: msg.room, token: msg.token, name: me.name, playerId: msg.playerId };
      session.write(me);
      history.replaceState(null, '', `/${msg.room}`);
      show('game');
      break;

    case 'state':
      state = msg;
      render();
      break;

    case 'left':
      leaveLocally();
      break;

    case 'error':
      if (msg.fatal) {
        session.clear();
        me = { name: me.name };
        state = null;
        show('entry');
        $('entry-error').textContent = msg.message;
        $('entry-error').hidden = false;
      } else {
        showError(msg.message);
      }
      break;

    default:
      break;
  }
}

// ------------------------------------------------------------- screens

function show(which) {
  $('screen-entry').hidden = which !== 'entry';
  $('screen-game').hidden = which !== 'game';
}

function showError(message) {
  // Put it where the player is actually looking.
  if (!$('screen-entry').hidden) {
    $('entry-error').textContent = message;
    $('entry-error').hidden = false;
    return;
  }
  if (state?.phase === 'hint' && state.turnPlayerId === state.you?.id) {
    $('hint-error').textContent = message;
    $('hint-error').hidden = false;
    return;
  }
  if (state?.phase === 'guess' && state.guesserId === state.you?.id) {
    $('guess-error').textContent = message;
    $('guess-error').hidden = false;
    return;
  }
  toast(message);
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function leaveLocally() {
  session.clear();
  me = { name: me.name };
  state = null;
  shownRound = null;
  history.replaceState(null, '', '/');
  show('entry');
}

// ---------------------------------------------------------------- render

function nameOf(id) {
  return state?.players.find((p) => p.id === id)?.name ?? 'Someone';
}

function render() {
  if (!state) return;

  $('room-code').textContent = state.room;
  $('lobby-code').textContent = state.room;

  // The server decides who may deal — the host, or anyone at all while the
  // host is away. Re-deriving that here would mean two rules to keep in step.
  const mayDeal = state.youCanDeal;

  renderWordChip();
  renderPanels(mayDeal);
  renderPlayers();
  renderLog();
  maybeShowRoleCard();
}

function renderWordChip() {
  const chip = $('word-chip');
  const { you, phase } = state;
  const inPlay = you?.playing && phase !== 'lobby' && phase !== 'reveal';
  chip.hidden = !inPlay;
  if (!inPlay) return;

  const isWhite = you.role === 'mrwhite';
  chip.classList.toggle('is-white', isWhite);
  chip.classList.toggle('covered', wordCovered && !isWhite);
  $('word-label').textContent = isWhite ? 'You are' : 'Your word';
  $('word-value').textContent = isWhite ? 'Mr. White' : (state.word ?? '');
}

function renderPanels(mayDeal) {
  const { phase } = state;
  for (const name of ['lobby', 'hint', 'vote', 'guess', 'reveal']) {
    $(`panel-${name}`).hidden = phase !== name;
  }
  $('hints-so-far').hidden = phase === 'lobby';

  if (phase === 'lobby') renderLobby(mayDeal);
  if (phase === 'hint') renderHint();
  if (phase === 'vote') renderVote();
  if (phase === 'guess') renderGuess();
  if (phase === 'reveal') renderReveal(mayDeal);
}

function renderLobby(mayDeal) {
  const n = state.players.length;
  const short = state.minPlayers - n;
  $('lobby-count').textContent = short > 0
    ? `${n} here. ${short} more ${short === 1 ? 'player' : 'players'} needed.`
    : `${n} here. Ready when you are.`;

  $('lobby-host').hidden = !mayDeal;
  $('lobby-waiting').hidden = mayDeal;
  if (mayDeal) {
    $('btn-start').disabled = short > 0;
    const select = $('lobby-whites');
    // Do not fight the host while the menu is open under their thumb.
    if (document.activeElement !== select) {
      select.value = String(state.mrWhiteCount ?? (n >= 8 ? 2 : 1));
    }
    renderBots();
  }
}

function renderBots() {
  const bots = state.players.filter((p) => p.isBot);
  $('lobby-bots').replaceChildren(...bots.map((p) => {
    const row = document.createElement('div');
    row.className = 'bot-row';
    const name = document.createElement('span');
    name.textContent = p.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'bot-remove';
    remove.setAttribute('aria-label', `Remove ${p.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => send({ t: 'removeBot', playerId: p.id }));
    row.append(name, remove);
    return row;
  }));
  $('bots-note').hidden = state.aiConfigured !== false;
  $('btn-add-bot').disabled = state.players.length >= state.maxPlayers;
}

function renderHint() {
  const yours = state.turnPlayerId === state.you?.id;
  const passLabel = state.hintPass > 1 ? ` (round ${state.hintPass} of hints)` : '';

  $('hint-lede').textContent = yours
    ? `Your turn${passLabel}. One word.`
    : state.turnPlayerId
      ? `${nameOf(state.turnPlayerId)} is thinking${passLabel}…`
      : 'Waiting…';

  $('hint-turn').hidden = !yours;
  $('hint-tip').hidden = !yours;
  if (!yours) {
    $('hint-input').value = '';
    $('hint-error').hidden = true;
  }
}

/** Rebuild the ballot only when the candidates change, so a tap never lands
 *  on a button that moved under the thumb between render and touch. */
let voteSignature = '';
function renderVote() {
  const candidates = state.players.filter(
    (p) => p.playing && p.alive && p.id !== state.you?.id,
  );
  const signature = candidates.map((p) => p.id).join(',');
  const list = $('vote-list');

  if (signature !== voteSignature) {
    voteSignature = signature;
    list.replaceChildren(...candidates.map((p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vote-option';
      btn.dataset.id = p.id;
      const name = document.createElement('span');
      name.textContent = p.name;
      const mark = document.createElement('span');
      mark.className = 'tick';
      btn.append(name, mark);
      btn.addEventListener('click', () => send({ t: 'vote', targetId: p.id }));
      return btn;
    }));
  }

  for (const btn of list.children) {
    const chosen = btn.dataset.id === state.yourVote;
    btn.classList.toggle('chosen', chosen);
    btn.querySelector('.tick').textContent = chosen ? '✓' : '';
  }

  const voters = state.players.filter((p) => p.playing && p.alive && p.connected);
  const done = voters.filter((p) => p.voted).length;
  $('vote-status').textContent = state.you?.alive
    ? `${done} of ${voters.length} have voted.`
    : `You are out this round. ${done} of ${voters.length} have voted.`;
}

function renderGuess() {
  const mine = state.guesserId === state.you?.id;
  $('guess-mine').hidden = !mine;
  $('guess-theirs').hidden = mine;
  if (!mine) {
    $('guess-theirs').textContent =
      `${nameOf(state.guesserId)} was Mr. White — and gets one guess at the word.`;
  }
}

function renderReveal(mayDeal) {
  const { outcome } = state;
  const verdict = $('reveal-verdict');

  if (outcome?.winner === 'civilians') {
    verdict.textContent = 'Caught. The table wins.';
    verdict.className = 'verdict civ';
  } else if (outcome?.winner === 'mrwhite') {
    verdict.textContent = outcome.reason === 'guessed'
      ? 'Named it. Mr. White wins.'
      : 'Mr. White got away with it.';
    verdict.className = 'verdict white';
  } else {
    verdict.textContent = 'Round abandoned — too few players left.';
    verdict.className = 'verdict none';
  }

  $('reveal-word').textContent = outcome?.word ?? '—';

  const rows = state.players.filter((p) => p.playing).map((p) => {
    const row = document.createElement('div');
    row.className = 'player-row';
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name;
    const meta = document.createElement('span');
    meta.className = 'pmeta';
    const tag = document.createElement('span');
    tag.className = `tag ${p.role === 'mrwhite' ? 'white' : 'civ'}`;
    tag.textContent = p.role === 'mrwhite' ? 'Mr. White' : 'civilian';
    const score = document.createElement('span');
    score.className = 'pscore';
    score.textContent = p.score;
    meta.append(tag, score);
    row.append(name, meta);
    return row;
  });
  $('reveal-roles').replaceChildren(...rows);

  $('btn-next').hidden = !mayDeal;
  $('reveal-waiting').hidden = mayDeal;
}

function renderPlayers() {
  const rows = state.players.map((p) => {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.classList.toggle('is-you', p.id === state.you?.id);
    row.classList.toggle('out', p.playing && !p.alive);
    row.classList.toggle('offline', !p.connected);

    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name;

    const meta = document.createElement('span');
    meta.className = 'pmeta';

    if (!p.connected) meta.append(tagEl('away'));
    else if (p.id === state.turnPlayerId) meta.append(tagEl('speaking', 'turn'));
    else if (state.phase === 'vote' && p.playing && p.alive && p.voted) meta.append(tagEl('voted'));
    else if (state.phase === 'lobby' && p.id === state.hostId) meta.append(tagEl('host'));
    else if (state.phase !== 'lobby' && !p.playing) meta.append(tagEl('next round'));

    if (p.isBot) meta.append(tagEl('AI', 'ai'));

    // A role only ever appears here once the server has made it public.
    if (p.role) meta.append(tagEl(p.role === 'mrwhite' ? 'Mr. White' : 'civilian',
      p.role === 'mrwhite' ? 'white' : 'civ'));

    const score = document.createElement('span');
    score.className = 'pscore';
    score.textContent = p.score;
    meta.append(score);

    row.append(name, meta);
    return row;
  });
  $('player-list').replaceChildren(...rows);
}

function tagEl(text, extra = '') {
  const el = document.createElement('span');
  el.className = `tag ${extra}`.trim();
  el.textContent = text;
  return el;
}

const PASS_LABELS = ['', 'First words', 'Second time round', 'Third time round'];

function renderLog() {
  const out = [];
  let pass = 0;

  for (const entry of state.log) {
    if (entry.pass && entry.pass !== pass) {
      pass = entry.pass;
      out.push(labelEl(PASS_LABELS[pass] ?? `Round ${pass} of hints`));
    }

    switch (entry.t) {
      case 'hint':
        out.push(hintEl(nameOf(entry.playerId), entry.text));
        break;
      case 'skip':
        out.push(hintEl(nameOf(entry.playerId), 'said nothing', true));
        break;
      case 'tie':
        out.push(eventEl('Votes tied — nobody out. Round again.'));
        break;
      case 'eliminated':
        out.push(eventEl(
          `${nameOf(entry.playerId)} was voted out with ${entry.votes} `
          + `${entry.votes === 1 ? 'vote' : 'votes'} — `
          + `${entry.role === 'mrwhite' ? 'Mr. White.' : 'a civilian.'}`,
        ));
        break;
      case 'left':
        out.push(eventEl(
          `${entry.name} left — ${entry.role === 'mrwhite' ? 'Mr. White.' : 'a civilian.'}`,
        ));
        break;
      case 'guess':
        out.push(eventEl(entry.text === null
          ? `${nameOf(entry.playerId)} never answered.`
          : `${nameOf(entry.playerId)} guessed "${entry.text}" — ${entry.correct ? 'right.' : 'wrong.'}`));
        break;
      default:
        break;
    }
  }

  $('hint-log').replaceChildren(...out);
  $('hints-so-far').hidden = out.length === 0;
}

function labelEl(text) {
  const el = document.createElement('div');
  el.className = 'pass-label';
  el.textContent = text;
  return el;
}

function hintEl(who, what, skipped = false) {
  const row = document.createElement('div');
  row.className = `hint-row${skipped ? ' skipped' : ''}`;
  const a = document.createElement('span');
  a.className = 'who';
  a.textContent = who;
  const b = document.createElement('span');
  b.className = 'what';
  b.textContent = what;
  row.append(a, b);
  return row;
}

function eventEl(text) {
  const row = document.createElement('div');
  row.className = 'hint-row';
  const span = document.createElement('span');
  span.className = 'event';
  span.textContent = text;
  row.append(span);
  return row;
}

// ------------------------------------------------------------ role card

/**
 * The private moment.
 *
 * Shown face-down first, so you can turn away from whoever is next to you
 * before you look — the same instinct as cupping a hand of cards. It comes
 * back after a reconnect too, which is deliberate: someone whose phone died
 * mid-round needs reminding what they are.
 */
function maybeShowRoleCard() {
  const { you, phase, round } = state;
  const due = you?.playing && phase !== 'lobby' && phase !== 'reveal' && round !== shownRound;
  if (!due) return;

  shownRound = round;
  const isWhite = you.role === 'mrwhite';

  $('role-round').textContent = `Round ${round}`;
  $('role-hidden').hidden = false;
  $('role-shown').hidden = true;
  $('role-kind').textContent = isWhite ? 'You are' : 'The word is';
  $('role-word').textContent = isWhite ? 'Mr. White' : (state.word ?? '');
  $('role-word').classList.toggle('is-white', isWhite);
  $('role-note').textContent = isWhite
    ? 'You have no word. Listen, blend in, and work out what they are all talking about.'
    : 'Hint at it without saying it. One of you has nothing.';
  $('reveal-card').hidden = false;
}

// -------------------------------------------------------------- actions

function joinOrCreate(kind) {
  const name = $('entry-name').value.trim();
  if (!name) {
    $('entry-error').textContent = 'Type a name first.';
    $('entry-error').hidden = false;
    $('entry-name').focus();
    return;
  }
  const code = $('entry-code').value.trim().toUpperCase();
  if (kind === 'join' && code.length !== 4) {
    $('entry-error').textContent = 'A table code is four letters.';
    $('entry-error').hidden = false;
    $('entry-code').focus();
    return;
  }

  $('entry-error').hidden = true;
  me = { ...me, name };
  session.write(me);
  send(kind === 'join' ? { t: 'join', code, name } : { t: 'create', name });
}

function sendHint() {
  const text = $('hint-input').value.trim();
  if (!text) return;
  $('hint-error').hidden = true;
  send({ t: 'hint', text });
}

function sendGuess() {
  const text = $('guess-input').value.trim();
  if (!text) return;
  $('guess-error').hidden = true;
  $('guess-input').value = '';
  send({ t: 'guess', text });
}

function onEnter(el, fn) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      fn();
    }
  });
}

// ----------------------------------------------------------------- wire

$('entry-create').addEventListener('click', () => joinOrCreate('create'));
$('entry-join').addEventListener('click', () => joinOrCreate('join'));
onEnter($('entry-name'), () => joinOrCreate($('entry-code').value.trim() ? 'join' : 'create'));
onEnter($('entry-code'), () => joinOrCreate('join'));

$('btn-start').addEventListener('click', () => send({ t: 'start' }));
$('btn-next').addEventListener('click', () => send({ t: 'start' }));
$('lobby-whites').addEventListener('change', (e) => {
  send({ t: 'settings', mrWhiteCount: Number(e.target.value) });
});
$('btn-add-bot').addEventListener('click', () => send({ t: 'addBot' }));

$('hint-send').addEventListener('click', sendHint);
onEnter($('hint-input'), sendHint);
$('guess-send').addEventListener('click', sendGuess);
onEnter($('guess-input'), sendGuess);

$('word-chip').addEventListener('click', () => {
  wordCovered = !wordCovered;
  renderWordChip();
});

$('reveal-card').addEventListener('click', (e) => {
  if ($('role-hidden').hidden) {
    if (e.target.id === 'role-ok') $('reveal-card').hidden = true;
    return;
  }
  $('role-hidden').hidden = true;
  $('role-shown').hidden = false;
});

$('btn-code').addEventListener('click', async () => {
  const link = `${location.origin}/${state?.room ?? ''}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied');
  } catch {
    toast(link);
  }
});

$('btn-leave').addEventListener('click', () => {
  if (state?.phase !== 'lobby' && state?.phase !== 'reveal'
      && !confirm('Leave mid-round? You will be out of it.')) return;
  send({ t: 'leave' });
  leaveLocally();
});

// A tab that comes back after being backgrounded may be holding a socket the
// operating system quietly killed. Nudge it rather than waiting for a timeout.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && socket?.readyState !== WebSocket.OPEN) {
    connect();
  }
});

// ------------------------------------------------------------------ boot

// An invite can be a link: /ABCD fills the code in for you.
const fromUrl = location.pathname.replace(/\//g, '').toUpperCase();
if (/^[A-Z]{4}$/.test(fromUrl)) $('entry-code').value = fromUrl;
if (me.name) $('entry-name').value = me.name;

// A stored session means a dropped socket, not a fresh visit — unless the
// link points at a different table, in which case the link wins.
if (me.room && fromUrl && fromUrl !== me.room) {
  session.clear();
  me = { name: me.name };
}

show('entry');
connect();
