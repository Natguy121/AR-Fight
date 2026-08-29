import { Game } from './shared/game/Game.js';
import { drawWord } from './shared/game/words.js';

/**
 * Pass-and-play: one device, physically handed around the table.
 *
 * There is no server here — `Game` is the exact same pure state machine
 * `server/index.js` drives online, just called directly in the browser. The
 * one thing a server gave the online version that this page cannot is a real
 * security boundary: online, the word never reaches Mr. White's device at
 * all. Here everything lives in one page's memory, so the privacy of a role
 * or a vote is procedural, not technical — the same trust a physical card
 * game runs on. That is why every private moment goes through the same
 * "pass the phone, then reveal" screen: it gives whoever is holding the
 * phone a clear beat to look away from the table before anything sensitive
 * is shown, and a clear beat afterwards to close it again before handing the
 * phone on.
 */

const $ = (id) => document.getElementById(id);
const ROSTER_KEY = 'mrwhite.local.roster';

let game = new Game();
let usedWords = new Set();

/** The pass-around queue driving the current private moment. */
let queue = [];
let queueIndex = 0;
let queueMode = null; // 'role' | 'vote' | 'guess' | 'remind'

// ------------------------------------------------------------- persistence

function loadRoster() {
  try {
    const raw = JSON.parse(localStorage.getItem(ROSTER_KEY));
    return Array.isArray(raw) ? raw.filter((n) => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

function saveRoster() {
  try {
    localStorage.setItem(ROSTER_KEY, JSON.stringify(game.players.map((p) => p.name)));
  } catch {
    /* private mode */
  }
}

// ------------------------------------------------------------- utilities

function show(which) {
  $('screen-pass').hidden = which !== 'pass';
  $('screen-table').hidden = which !== 'table';
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function nameOf(view, id) {
  return view.players.find((p) => p.id === id)?.name ?? 'Someone';
}

/**
 * A shared view for the communal screen.
 *
 * `Game.viewFor` redacts differently per viewer only through `word`, `you`,
 * `yourVote` and `guesserId` — everything else (phase, players, roles once
 * public, hints, log, outcome) is identical no matter whose id is passed in.
 * The table screen never touches those four fields, so any id here is fine;
 * `word` in particular is only ever read from the reveal panel, where it is
 * public to everyone regardless.
 */
function publicView() {
  return game.viewFor(game.players[0]?.id ?? null);
}

function tagEl(text, extra = '') {
  const el = document.createElement('span');
  el.className = `tag ${extra}`.trim();
  el.textContent = text;
  return el;
}

function onEnter(el, fn) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      fn();
    }
  });
}

// --------------------------------------------------------------- roster

function freshId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function addPlayer() {
  const input = $('add-name');
  const value = input.value.trim();
  $('add-error').hidden = true;
  if (!value) return;
  const res = game.addPlayer({ id: freshId(), name: value });
  if (!res.ok) {
    $('add-error').textContent = res.error;
    $('add-error').hidden = false;
    return;
  }
  saveRoster();
  input.value = '';
  input.focus();
  renderTable();
}

function removePlayer(id) {
  game.removePlayer(id);
  saveRoster();
  renderTable();
}

// One-time boot: bring back whoever played here last, best-effort.
for (const name of loadRoster()) {
  game.addPlayer({ id: freshId(), name });
}

// ----------------------------------------------------------------- deal

function dealRound() {
  const word = drawWord(usedWords);
  const res = game.startRound(word);
  if (!res.ok) {
    toast(res.error);
    return;
  }
  usedWords.add(word);
  beginRoleQueue();
}

function newGame() {
  const names = game.players.map((p) => p.name);
  game = new Game();
  usedWords = new Set();
  for (const name of names) game.addPlayer({ id: freshId(), name });
  show('table');
  renderTable();
}

// ------------------------------------------------------------ pass queue

function beginRoleQueue() {
  queue = [...game.order];
  queueIndex = 0;
  queueMode = 'role';
  showPassStep();
}

function beginVoteQueue() {
  queue = game.players.filter((p) => p.playing && p.alive).map((p) => p.id);
  queueIndex = 0;
  queueMode = 'vote';
  showPassStep();
}

function beginGuessQueue() {
  queue = [game.guesserId];
  queueIndex = 0;
  queueMode = 'guess';
  showPassStep();
}

function showPassStep() {
  show('pass');
  const id = queue[queueIndex];
  const player = game.playerById(id);

  $('pass-kicker').textContent = {
    role: `Round ${game.round}`,
    vote: 'Vote — privately',
    guess: 'Caught!',
    remind: 'A reminder',
  }[queueMode];
  $('pass-name').textContent = player.name;
  $('pass-note').textContent = {
    role: 'to see their word — privately',
    vote: 'to vote — nobody else should see this screen',
    guess: 'to make the final guess',
    remind: 'to see their word again — privately',
  }[queueMode];

  $('pass-prompt').hidden = false;
  $('pass-role').hidden = true;
  $('pass-vote').hidden = true;
  $('pass-voted').hidden = true;
  $('pass-guess').hidden = true;
}

function revealPassStep() {
  $('pass-prompt').hidden = true;
  const id = queue[queueIndex];
  if (queueMode === 'role' || queueMode === 'remind') showRoleFace(id);
  else if (queueMode === 'vote') showVoteFace(id);
  else if (queueMode === 'guess') showGuessFace(id);
}

function showRoleFace(id) {
  const view = game.viewFor(id);
  const isWhite = view.you.role === 'mrwhite';
  $('pass-role-kind').textContent = isWhite ? 'You are' : 'The word is';
  $('pass-role-word').textContent = isWhite ? 'Mr. White' : view.word;
  $('pass-role-word').classList.toggle('is-white', isWhite);
  $('pass-role-note').textContent = isWhite
    ? 'You have no word. Listen, blend in, and work out what everyone else is talking about.'
    : 'Hint at it out loud without saying it. One person at this table has nothing.';
  $('pass-role').hidden = false;
}

function showVoteFace(id) {
  const view = game.viewFor(id);
  const candidates = view.players.filter((p) => p.playing && p.alive && p.id !== id);
  $('pass-vote-list').replaceChildren(...candidates.map((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vote-option';
    const name = document.createElement('span');
    name.textContent = p.name;
    btn.append(name);
    btn.addEventListener('click', () => castVote(id, p.id));
    return btn;
  }));
  $('pass-vote').hidden = false;
}

function castVote(voterId, targetId) {
  const res = game.submitVote(voterId, targetId);
  if (!res.ok) {
    toast(res.error);
    return;
  }
  $('pass-vote').hidden = true;
  $('pass-voted').hidden = false;
}

function showGuessFace() {
  $('pass-guess-input').value = '';
  $('pass-guess').hidden = false;
}

function submitGuess() {
  const id = queue[queueIndex];
  const text = $('pass-guess-input').value.trim();
  if (!text) return;
  const res = game.submitGuess(id, text);
  if (!res.ok) {
    toast(res.error);
    return;
  }
  afterPhaseChange();
}

/** Advance a role/remind step, or move to the next voter. */
function advancePassStep() {
  if (queueMode === 'remind') {
    show('table');
    renderTable();
    return;
  }
  if (queueMode === 'role') {
    queueIndex += 1;
    if (queueIndex < queue.length) showPassStep();
    else { show('table'); renderTable(); }
    return;
  }
  if (queueMode === 'vote') {
    if (game.phase !== 'vote') {
      // Resolved already — a tie, an elimination, or too few left to vote.
      afterPhaseChange();
      return;
    }
    queueIndex += 1;
    while (queueIndex < queue.length && game.votes.has(queue[queueIndex])) queueIndex += 1;
    if (queueIndex < queue.length) showPassStep();
    else afterPhaseChange();
  }
}

/** Called whenever an action may have moved the game to a new phase. */
function afterPhaseChange() {
  if (game.phase === 'vote') beginVoteQueue();
  else if (game.phase === 'guess') beginGuessQueue();
  else { show('table'); renderTable(); }
}

// ---------------------------------------------------------------- hints

function sendHint() {
  const id = game.currentTurnId();
  const text = $('hint-input').value.trim();
  if (!text || !id) return;
  const res = game.submitHint(id, text);
  if (!res.ok) {
    $('hint-error').textContent = res.error;
    $('hint-error').hidden = false;
    return;
  }
  afterPhaseChange();
}

function remindCurrentPlayer() {
  const id = game.currentTurnId();
  if (!id) return;
  queue = [id];
  queueIndex = 0;
  queueMode = 'remind';
  showPassStep();
}

// --------------------------------------------------------------- render

function renderTable() {
  const view = publicView();

  for (const name of ['lobby', 'hint', 'reveal']) $(`panel-${name}`).hidden = view.phase !== name;
  $('hints-so-far').hidden = view.hints.length === 0;

  if (view.phase === 'lobby') renderLobby(view);
  if (view.phase === 'hint') renderHint(view);
  if (view.phase === 'reveal') renderReveal(view);

  const editable = view.phase === 'lobby' || view.phase === 'reveal';
  $('roster-add-row').hidden = !editable;

  renderPlayers(view, editable);
  renderLog(view);
}

function renderLobby(view) {
  const n = view.players.length;
  const short = view.minPlayers - n;
  $('lobby-count').textContent = short > 0
    ? `${n} here. ${short} more ${short === 1 ? 'player' : 'players'} needed.`
    : `${n} here. Ready when you are.`;
  $('btn-start').disabled = short > 0;

  const select = $('lobby-whites');
  if (document.activeElement !== select) {
    select.value = String(view.mrWhiteCount ?? (n >= 8 ? 2 : 1));
  }
}

function renderHint(view) {
  const passLabel = view.hintPass > 1 ? ` (round ${view.hintPass} of hints)` : '';
  const name = nameOf(view, view.turnPlayerId);
  $('hint-lede').textContent = view.turnPlayerId
    ? `${name}'s turn${passLabel}. Say your word out loud, then type it in.`
    : 'Waiting…';
  $('hint-input').value = '';
  $('hint-error').hidden = true;
}

function renderReveal(view) {
  const { outcome } = view;
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

  const rows = view.players.filter((p) => p.playing).map((p) => {
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
}

function renderPlayers(view, editable) {
  const rows = view.players.map((p) => {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.classList.toggle('out', p.playing && !p.alive);

    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name;

    const meta = document.createElement('span');
    meta.className = 'pmeta';

    if (p.id === view.turnPlayerId) meta.append(tagEl('speaking', 'turn'));
    else if (view.phase !== 'lobby' && !p.playing) meta.append(tagEl('next round'));
    if (p.role) meta.append(tagEl(p.role === 'mrwhite' ? 'Mr. White' : 'civilian', p.role === 'mrwhite' ? 'white' : 'civ'));

    const score = document.createElement('span');
    score.className = 'pscore';
    score.textContent = p.score;
    meta.append(score);
    row.append(name, meta);

    if (editable) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'bot-remove';
      remove.setAttribute('aria-label', `Remove ${p.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => removePlayer(p.id));
      row.append(remove);
    }
    return row;
  });
  $('player-list').replaceChildren(...rows);
}

const PASS_LABELS = ['', 'First words', 'Second time round', 'Third time round'];

function renderLog(view) {
  const out = [];
  let pass = 0;

  for (const entry of view.log) {
    if (entry.pass && entry.pass !== pass) {
      pass = entry.pass;
      const el = document.createElement('div');
      el.className = 'pass-label';
      el.textContent = PASS_LABELS[pass] ?? `Round ${pass} of hints`;
      out.push(el);
    }

    switch (entry.t) {
      case 'hint':
        out.push(hintEl(nameOf(view, entry.playerId), entry.text));
        break;
      case 'skip':
        out.push(hintEl(nameOf(view, entry.playerId), 'said nothing', true));
        break;
      case 'tie':
        out.push(eventEl('Votes tied — nobody out. Round again.'));
        break;
      case 'eliminated':
        out.push(eventEl(
          `${nameOf(view, entry.playerId)} was voted out with ${entry.votes} `
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
          ? `${nameOf(view, entry.playerId)} never answered.`
          : `${nameOf(view, entry.playerId)} guessed "${entry.text}" — ${entry.correct ? 'right.' : 'wrong.'}`));
        break;
      default:
        break;
    }
  }

  $('hint-log').replaceChildren(...out);
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

// ----------------------------------------------------------------- wire

$('add-name-btn').addEventListener('click', addPlayer);
onEnter($('add-name'), addPlayer);

$('btn-start').addEventListener('click', dealRound);
$('lobby-whites').addEventListener('change', (e) => {
  const res = game.setMrWhiteCount(Number(e.target.value));
  if (!res.ok) toast(res.error);
});

$('hint-send').addEventListener('click', sendHint);
onEnter($('hint-input'), sendHint);
$('btn-remind').addEventListener('click', remindCurrentPlayer);

$('btn-next').addEventListener('click', dealRound);
$('btn-reset').addEventListener('click', () => {
  if (confirm('Reset everyone’s score and start a new game?')) newGame();
});

$('pass-ready').addEventListener('click', revealPassStep);
$('pass-role-ok').addEventListener('click', advancePassStep);
$('pass-voted-ok').addEventListener('click', advancePassStep);
$('pass-guess-send').addEventListener('click', submitGuess);
onEnter($('pass-guess-input'), submitGuess);

// ------------------------------------------------------------------ boot

show('table');
renderTable();
