import assert from 'node:assert/strict';
import { Game, defaultMrWhiteCount } from '../public/shared/game/Game.js';
import { normalize, isOneWord, sameWord } from '../public/shared/game/text.js';
import { WORDS, drawWord } from '../public/shared/game/words.js';
import * as bot from '../server/game/bot.js';
import { Room } from '../server/Rooms.js';

// --------------------------------------------------------------- tiny runner

let passed = 0;
let failed = 0;

function group(name) {
  console.log(`\n${name}`);
}

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message.split('\n').join('\n        ')}`);
  }
}

/** Same as `test`, for a bot decision — those are async even on the no-API-key
 *  path, since `chooseHint` etc. are `async function`s regardless of which
 *  branch they take inside. Callers `await` this so console output and the
 *  final tally stay in the same order the tests were written in. */
async function atest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message.split('\n').join('\n        ')}`);
  }
}

/** Bot tests want the fallback path deterministically, regardless of what is
 *  actually in the environment this happens to run in. */
async function withoutApiKey(fn) {
  const had = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await fn();
  } finally {
    if (had !== undefined) process.env.ANTHROPIC_API_KEY = had;
  }
}

// ------------------------------------------------------------- test helpers

/** mulberry32: a seeded RNG, so a failing game can be replayed exactly. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORD = 'zzqword'; // distinctive, so a leak check cannot false-positive

function table(n, opts = {}) {
  const game = new Game({ rng: seeded(7), ...opts });
  for (let i = 0; i < n; i++) game.addPlayer({ id: `p${i}`, name: `Player${i}` });
  return game;
}

const whitesIn = (g) => g.players.filter((p) => p.playing && p.role === 'mrwhite');
const civiliansIn = (g) => g.players.filter((p) => p.playing && p.role === 'civilian');
const aliveIn = (g) => g.players.filter((p) => p.playing && p.alive);

/**
 * Play out the hint phase with throwaway words.
 *
 * The counter is module-level on purpose: hints must be unique for the whole
 * round, not just the current pass, so a per-call counter would start
 * colliding with itself the moment a tie sent the table round again.
 */
let hintCounter = 0;
function playHints(g) {
  let guard = 0;
  while (g.phase === 'hint') {
    if (guard++ > 200) throw new Error('hint phase never ended');
    const id = g.currentTurnId();
    const res = g.submitHint(id, `hint${hintCounter++}`);
    assert.ok(res.ok, `hint rejected: ${res.error}`);
  }
}

/**
 * Everyone still in it votes for `victim` — except the victim, who has to
 * put their ballot somewhere else, since nobody may vote for themselves.
 */
function allVoteFor(g, victimId) {
  for (const p of g.players.filter((x) => x.playing && x.alive && x.connected)) {
    if (g.phase !== 'vote') break;
    const target = p.id === victimId
      ? aliveIn(g).find((x) => x.id !== p.id).id
      : victimId;
    const res = g.submitVote(p.id, target);
    assert.ok(res.ok, `vote rejected: ${res.error}`);
  }
}

/** Everyone votes according to `pick(voter) -> targetId`. */
function allVote(g, pick) {
  for (const p of g.players.filter((x) => x.playing && x.alive && x.connected)) {
    if (g.phase !== 'vote') break;
    const res = g.submitVote(p.id, pick(p));
    assert.ok(res.ok, `vote rejected: ${res.error}`);
  }
}

/** The property the whole game rests on. */
function assertNoLeak(g, where) {
  if (g.phase === 'reveal') return;
  for (const p of g.players) {
    if (p.role !== 'mrwhite') continue;
    const json = JSON.stringify(g.viewFor(p.id)).toLowerCase();
    assert.ok(
      !json.includes(WORD),
      `${where}: the word reached Mr. White (${p.name}) during phase "${g.phase}"`,
    );
  }
}

// ---------------------------------------------------------------------------
group('Words');

test('the list is big enough that a night of play does not repeat', () => {
  assert.ok(WORDS.length >= 150, `only ${WORDS.length} words`);
});

test('every word is a single lowercase word with no stray whitespace', () => {
  for (const w of WORDS) {
    assert.equal(w, w.trim(), `"${w}" has stray whitespace`);
    assert.ok(!/\s/.test(w), `"${w}" is more than one word`);
    assert.equal(w, w.toLowerCase(), `"${w}" is not lowercase`);
  }
});

test('there are no duplicates', () => {
  assert.equal(new Set(WORDS).size, WORDS.length);
});

test('drawWord avoids what has already been played', () => {
  const used = new Set(WORDS.slice(0, WORDS.length - 1));
  const w = drawWord(used, seeded(3));
  assert.equal(w, WORDS[WORDS.length - 1], 'should pick the only unused word');
});

test('drawWord starts over rather than failing once every word is used', () => {
  const w = drawWord(new Set(WORDS), seeded(3));
  assert.ok(WORDS.includes(w));
});

// ---------------------------------------------------------------------------
group('Text rules');

test('a hint is one word', () => {
  assert.ok(isOneWord('kitchen'));
  assert.ok(isOneWord("O'Brien"));
  assert.ok(isOneWord('twenty-one'));
  assert.ok(!isOneWord('a thing you sit on'));
  assert.ok(!isOneWord('two words'));
  assert.ok(!isOneWord(''));
  assert.ok(!isOneWord('   '));
});

test('normalize is case- and whitespace-insensitive', () => {
  assert.equal(normalize('  Kitchen  '), 'kitchen');
  assert.equal(normalize('two   words'), 'two words');
});

test('a guess survives case, punctuation and a plural', () => {
  assert.ok(sameWord('Piano', 'piano'));
  assert.ok(sameWord(' piano! ', 'piano'));
  assert.ok(sameWord('glasses', 'glass'), 'plural in the guess');
  assert.ok(sameWord('glass', 'glasses'), 'plural in the word');
  assert.ok(sameWord('cats', 'cat'));
});

test('a guess is not fuzzy beyond that — a synonym is still a miss', () => {
  assert.ok(!sameWord('sofa', 'couch'));
  assert.ok(!sameWord('pian', 'piano'));
  assert.ok(!sameWord('', 'piano'));
});

// ---------------------------------------------------------------------------
group('Dealing a round');

test('a table needs three players', () => {
  const g = table(2);
  const res = g.startRound(WORD);
  assert.ok(!res.ok);
  assert.match(res.error, /3 players/);
});

test('names must be unique, and blank names are refused', () => {
  const g = table(0);
  assert.ok(g.addPlayer({ id: 'a', name: 'Sam' }).ok);
  assert.ok(!g.addPlayer({ id: 'b', name: ' sam ' }).ok, 'same name in different case');
  assert.ok(!g.addPlayer({ id: 'c', name: '   ' }).ok, 'blank name');
});

test('the first player to arrive is the host, and hosting passes on when they go', () => {
  const g = table(3);
  assert.equal(g.hostId, 'p0');
  g.removePlayer('p0');
  assert.equal(g.hostId, 'p1');
});

test('a host whose phone sleeps is still the host when it wakes', () => {
  // The reveal is exactly when everyone looks up from their screen, so a host
  // demoted for locking their phone would lose the buttons at the worst
  // possible moment — and get them back never.
  const g = table(4);
  g.setConnected('p0', false);
  assert.equal(g.hostId, 'p0', 'hosting should not move on a dropped connection');
  g.setConnected('p0', true);
  assert.ok(g.canDeal('p0'));
});

test('but the table can still deal while the host is away', () => {
  const g = table(4);
  assert.ok(!g.canDeal('p1'), 'not while the host is here');
  g.setConnected('p0', false);
  assert.ok(g.canDeal('p1'), 'the table must not be stuck behind an absent host');
  g.setConnected('p0', true);
  assert.ok(!g.canDeal('p1'), 'and it goes back to the host once they return');
});

test('whether you may deal is stated in your own view, not left to be guessed', () => {
  const g = table(4);
  assert.equal(g.viewFor('p0').youCanDeal, true);
  assert.equal(g.viewFor('p1').youCanDeal, false);
  g.setConnected('p0', false);
  assert.equal(g.viewFor('p1').youCanDeal, true);
  assert.equal(g.viewFor('nobody').youCanDeal, false, 'a stranger may not deal');
});

test('exactly one Mr. White at a small table, two at a large one', () => {
  assert.equal(defaultMrWhiteCount(3), 1);
  assert.equal(defaultMrWhiteCount(7), 1);
  assert.equal(defaultMrWhiteCount(8), 2);

  const small = table(5);
  small.startRound(WORD);
  assert.equal(whitesIn(small).length, 1);

  const big = table(9);
  big.startRound(WORD);
  assert.equal(whitesIn(big).length, 2);
});

test('Mr. Whites can never be dealt in numbers that win the round immediately', () => {
  const g = table(3, { mrWhiteCount: 3 });
  g.startRound(WORD);
  // Three of three would mean the round is over before a word is said.
  assert.equal(whitesIn(g).length, 1);
  assert.ok(civiliansIn(g).length > whitesIn(g).length);
});

test('everyone who is not Mr. White gets the word', () => {
  const g = table(6);
  g.startRound(WORD);
  for (const p of g.players) {
    const view = g.viewFor(p.id);
    if (p.role === 'civilian') assert.equal(view.word, WORD);
    else assert.equal(view.word, null);
  }
});

test('the first speaker is never Mr. White', () => {
  // Over many deals, since it is the shuffle being constrained.
  for (let seed = 0; seed < 60; seed++) {
    const g = new Game({ rng: seeded(seed) });
    for (let i = 0; i < 5; i++) g.addPlayer({ id: `p${i}`, name: `Player${i}` });
    g.startRound(WORD);
    assert.equal(
      g.playerById(g.order[0]).role, 'civilian',
      `seed ${seed} put Mr. White first, with nothing to go on`,
    );
  }
});

test('someone who arrives mid-round sits out until the next one', () => {
  const g = table(4);
  g.startRound(WORD);
  g.addPlayer({ id: 'late', name: 'Late' });
  const late = g.playerById('late');
  assert.equal(late.playing, false);
  assert.equal(late.role, null);
  assert.equal(g.viewFor('late').word, null, 'and certainly does not get the word');
  assert.ok(!g.order.includes('late'));
});

// ---------------------------------------------------------------------------
group('Giving hints');

test('turns are taken in order, and only in order', () => {
  const g = table(4);
  g.startRound(WORD);
  const [first, second] = g.order;
  assert.ok(!g.submitHint(second, 'early').ok, 'out-of-turn hint accepted');
  assert.ok(g.submitHint(first, 'ok').ok);
  assert.equal(g.currentTurnId(), second);
});

test('a hint must be one word, and cannot repeat one already said', () => {
  const g = table(4);
  g.startRound(WORD);
  const id = g.currentTurnId();
  assert.ok(!g.submitHint(id, 'two words').ok);
  assert.ok(g.submitHint(id, 'kettle').ok);
  const next = g.currentTurnId();
  const dup = g.submitHint(next, 'KETTLE');
  assert.ok(!dup.ok, 'a repeat in different case was allowed');
  assert.match(dup.error, /already been said/);
});

test('a civilian may not say the word itself', () => {
  const g = table(4);
  g.startRound(WORD);
  const id = g.currentTurnId(); // guaranteed civilian
  const res = g.submitHint(id, WORD);
  assert.ok(!res.ok);
  assert.match(res.error, /cannot say the word/);
});

test('but Mr. White may — rejecting it would tell them they had guessed right', () => {
  // The leak this protects against is subtle and total: a "you cannot use
  // that word" reply is a confirmation, and one free confirmation is the
  // whole game.
  const g = table(4);
  g.startRound(WORD);
  const white = whitesIn(g)[0];
  // Walk the order round to them.
  let guard = 0;
  while (g.currentTurnId() !== white.id) {
    if (guard++ > 20) throw new Error('never reached Mr. White');
    assert.ok(g.submitHint(g.currentTurnId(), `filler${guard}`).ok);
  }
  const res = g.submitHint(white.id, WORD);
  assert.ok(res.ok, `Mr. White was blocked from the word: ${res.error}`);
  assert.ok(g.hints.some((h) => h.text === WORD), 'and it stands as their hint');
});

test('the vote opens once everyone has spoken', () => {
  const g = table(4);
  g.startRound(WORD);
  playHints(g);
  assert.equal(g.phase, 'vote');
  assert.equal(g.hints.length, 4);
});

// ---------------------------------------------------------------------------
group('Voting');

test('you cannot vote for yourself, or for someone already out', () => {
  const g = table(4);
  g.startRound(WORD);
  playHints(g);
  const [a, b] = aliveIn(g);
  assert.ok(!g.submitVote(a.id, a.id).ok);
  b.alive = false;
  assert.ok(!g.submitVote(a.id, b.id).ok);
});

test('a vote can be changed until the last ballot lands', () => {
  const g = table(4);
  g.startRound(WORD);
  playHints(g);
  const [a, b, c] = aliveIn(g);
  g.submitVote(a.id, b.id);
  g.submitVote(a.id, c.id);
  assert.equal(g.viewFor(a.id).yourVote, c.id);
  assert.equal(g.phase, 'vote', 'changing a vote must not resolve it');
});

test('who has voted is public; what they voted is not', () => {
  const g = table(4);
  g.startRound(WORD);
  playHints(g);
  const [a, b] = aliveIn(g);
  g.submitVote(a.id, b.id);

  const seenByB = g.viewFor(b.id);
  assert.equal(seenByB.players.find((p) => p.id === a.id).voted, true);
  assert.equal(seenByB.yourVote, null, 'B has not voted, so has no vote of their own');
  assert.ok(
    !JSON.stringify(seenByB).includes(`"targetId"`),
    'ballots must not be visible while the vote is open',
  );
});

test('the most-voted player is eliminated and their role becomes public', () => {
  const g = table(4);
  g.startRound(WORD);
  playHints(g);
  const alive = aliveIn(g);
  const victim = alive[1];
  allVote(g, (p) => (p.id === victim.id ? alive[0].id : victim.id));

  assert.equal(g.playerById(victim.id).alive, false);
  const seenByOthers = g.viewFor(alive[0].id);
  assert.equal(seenByOthers.players.find((p) => p.id === victim.id).role, victim.role);
});

test('a tie eliminates nobody and sends it back for another pass', () => {
  const g = table(4);
  g.startRound(WORD);
  playHints(g);
  const alive = aliveIn(g);
  // Two each way.
  allVote(g, (p) => (p === alive[0] || p === alive[1] ? alive[2].id : alive[0].id));

  assert.equal(g.phase, 'hint', 'a tie should reopen the hints');
  assert.equal(g.hintPass, 2);
  assert.equal(aliveIn(g).length, 4, 'nobody goes out on a tie');
  assert.ok(g.log.some((e) => e.t === 'tie'));
});

test('after a tie the vote is cleared, not carried over', () => {
  const g = table(4);
  g.startRound(WORD);
  playHints(g);
  const alive = aliveIn(g);
  allVote(g, (p) => (p === alive[0] || p === alive[1] ? alive[2].id : alive[0].id));
  assert.equal(g.viewFor(alive[0].id).yourVote, null);
});

// ---------------------------------------------------------------------------
group('Catching Mr. White');

test('being caught is not the end — Mr. White gets one guess at the word', () => {
  const g = table(4);
  g.startRound(WORD);
  playHints(g);
  const white = whitesIn(g)[0];
  allVote(g, (p) => (p.id === white.id ? aliveIn(g)[0].id : white.id));

  assert.equal(g.phase, 'guess');
  assert.equal(g.guesserId, white.id);
});

test('naming the word wins the round outright, even from the gallows', () => {
  const g = table(4);
  g.startRound(WORD);
  playHints(g);
  const white = whitesIn(g)[0];
  allVote(g, (p) => (p.id === white.id ? aliveIn(g)[0].id : white.id));
  g.submitGuess(white.id, WORD.toUpperCase());

  assert.equal(g.phase, 'reveal');
  assert.equal(g.outcome.winner, 'mrwhite');
  assert.equal(g.outcome.reason, 'guessed');
  assert.equal(g.playerById(white.id).score, 6);
  for (const c of civiliansIn(g)) assert.equal(c.score, 0);
});

test('guessing wrong ends it for the civilians', () => {
  const g = table(4);
  g.startRound(WORD);
  playHints(g);
  const white = whitesIn(g)[0];
  allVote(g, (p) => (p.id === white.id ? aliveIn(g)[0].id : white.id));
  g.submitGuess(white.id, 'something-else');

  assert.equal(g.phase, 'reveal');
  assert.equal(g.outcome.winner, 'civilians');
  for (const c of civiliansIn(g)) assert.equal(c.score, 2);
  assert.equal(g.playerById(white.id).score, 0);
});

test('a civilian voted out early still scores when their side wins', () => {
  // Suspicion is not a crime. Docking the wrongly-accused would teach people
  // to give hints so vague they say nothing, which is the opposite of the game.
  const g = table(5);
  g.startRound(WORD);
  const white = whitesIn(g)[0];
  const scapegoat = civiliansIn(g)[0];

  playHints(g);
  allVote(g, (p) => (p.id === scapegoat.id ? white.id : scapegoat.id));
  assert.equal(g.phase, 'hint', 'a civilian went out, so play continues');

  playHints(g);
  allVote(g, (p) => (p.id === white.id ? aliveIn(g)[0].id : white.id));
  g.submitGuess(white.id, 'wrong');

  assert.equal(g.outcome.winner, 'civilians');
  assert.equal(g.playerById(scapegoat.id).score, 2);
});

test('only the caught Mr. White may answer, and only once', () => {
  const g = table(4);
  g.startRound(WORD);
  playHints(g);
  const white = whitesIn(g)[0];
  allVote(g, (p) => (p.id === white.id ? aliveIn(g)[0].id : white.id));

  const other = civiliansIn(g)[0];
  assert.ok(!g.submitGuess(other.id, WORD).ok, 'a civilian answered for them');
  assert.ok(g.submitGuess(white.id, 'nope').ok);
  assert.ok(!g.submitGuess(white.id, WORD).ok, 'a second bite at the guess');
});

test('Mr. White wins by lasting until the table is level', () => {
  const g = table(4);
  g.startRound(WORD);
  const white = whitesIn(g)[0];

  // Vote out civilians until only the standoff is left.
  let guard = 0;
  while (g.phase !== 'reveal') {
    if (guard++ > 10) throw new Error('round never ended');
    playHints(g);
    allVoteFor(g, aliveIn(g).find((p) => p.role === 'civilian').id);
  }

  assert.equal(g.outcome.winner, 'mrwhite');
  assert.equal(g.outcome.reason, 'survived');
  assert.equal(g.playerById(white.id).score, 6);
});

// ---------------------------------------------------------------------------
group('The word never reaches Mr. White');

test('not in any view, in any phase, across a whole game', () => {
  const g = table(5);
  g.startRound(WORD);
  assertNoLeak(g, 'after the deal');

  let guard = 0;
  while (g.phase !== 'reveal') {
    if (guard++ > 20) throw new Error('round never ended');
    while (g.phase === 'hint') {
      g.submitHint(g.currentTurnId(), `w${guard}x${g.hints.length}`);
      assertNoLeak(g, 'mid-hint');
    }
    if (g.phase !== 'vote') continue;
    const alive = aliveIn(g);
    const victim = alive.find((p) => p.role === 'civilian') ?? alive[0];
    for (const p of alive) {
      if (g.phase !== 'vote') break;
      const target = p.id === victim.id ? alive.find((x) => x !== p).id : victim.id;
      g.submitVote(p.id, target);
      assertNoLeak(g, 'mid-vote');
    }
    if (g.phase === 'guess') {
      assertNoLeak(g, 'while Mr. White is guessing');
      g.submitGuess(g.guesserId, 'wrong');
    }
  }
  assert.equal(g.phase, 'reveal');
  assert.equal(g.viewFor(whitesIn(g)[0].id).word, WORD, 'and is shown at the reveal');
});

test('not through an eliminated Mr. White who is waiting on the reveal', () => {
  // Two Mr. Whites, one caught. Showing the word to the dead one would hand
  // it to the live one across the table in about a second.
  const g = table(8, { mrWhiteCount: 2 });
  g.startRound(WORD);
  playHints(g);
  const [caught] = whitesIn(g);
  allVote(g, (p) => (p.id === caught.id ? aliveIn(g)[0].id : caught.id));
  g.submitGuess(caught.id, 'wrong');

  assert.notEqual(g.phase, 'reveal', 'one Mr. White is still in it');
  assert.equal(g.viewFor(caught.id).word, null);
  assertNoLeak(g, 'after a failed guess');
});

test('not to a spectator who joined mid-round', () => {
  const g = table(4);
  g.startRound(WORD);
  g.addPlayer({ id: 'late', name: 'Late' });
  assert.equal(g.viewFor('late').word, null);
});

// ---------------------------------------------------------------------------
group('Nobody can hang the table');

test('a player who drops on their turn is skipped, not waited for', () => {
  const g = table(4);
  g.startRound(WORD);
  const onTurn = g.currentTurnId();
  g.setConnected(onTurn, false);

  assert.notEqual(g.currentTurnId(), onTurn, 'the game stalled on an empty chair');
  assert.ok(g.log.some((e) => e.t === 'skip' && e.playerId === onTurn));
});

test('a vote resolves on the people still here, not the people who left', () => {
  const g = table(4);
  g.startRound(WORD);
  playHints(g);
  const alive = aliveIn(g);
  const absent = alive[3];
  const victim = alive[1];

  for (const p of [alive[0], alive[1], alive[2]]) {
    g.submitVote(p.id, p.id === victim.id ? alive[0].id : victim.id);
  }
  assert.equal(g.phase, 'vote', 'still waiting on the fourth');
  g.setConnected(absent.id, false);
  assert.notEqual(g.phase, 'vote', 'the vote should resolve once they are gone');
});

test('a Mr. White who vanishes rather than guess forfeits it', () => {
  const g = table(4);
  g.startRound(WORD);
  playHints(g);
  const white = whitesIn(g)[0];
  allVote(g, (p) => (p.id === white.id ? aliveIn(g)[0].id : white.id));
  assert.equal(g.phase, 'guess');

  g.setConnected(white.id, false);
  assert.equal(g.phase, 'reveal');
  assert.equal(g.outcome.winner, 'civilians');
});

test('walking out mid-round counts as being eliminated', () => {
  const g = table(5);
  g.startRound(WORD);
  playHints(g);
  const white = whitesIn(g)[0];
  g.removePlayer(white.id);
  // Losing the only Mr. White ends it, by way of the forfeited guess.
  assert.equal(g.phase, 'reveal');
  assert.equal(g.outcome.winner, 'civilians');
});

test('a round with nobody left to vote ends instead of hanging', () => {
  const g = table(4);
  g.startRound(WORD);
  playHints(g);
  for (const p of aliveIn(g).slice(0, 3)) g.setConnected(p.id, false);
  assert.equal(g.phase, 'reveal');
  assert.equal(g.outcome.winner, null);
  assert.equal(g.outcome.reason, 'abandoned');
});

// ---------------------------------------------------------------------------
group('Playing on');

test('scores carry between rounds and roles are re-dealt', () => {
  const g = table(4);
  g.startRound(WORD);
  playHints(g);
  const white = whitesIn(g)[0];
  allVote(g, (p) => (p.id === white.id ? aliveIn(g)[0].id : white.id));
  g.submitGuess(white.id, 'wrong');
  const scores = g.players.map((p) => p.score);

  assert.ok(g.startRound('second-word').ok);
  assert.equal(g.round, 2);
  assert.deepEqual(g.players.map((p) => p.score), scores, 'scores were reset');
  assert.equal(aliveIn(g).length, 4, 'everyone is back in');
  assert.equal(g.hints.length, 0);
  assert.equal(g.outcome, null);
});

test('a round cannot be dealt on top of one already running', () => {
  const g = table(4);
  g.startRound(WORD);
  assert.ok(!g.startRound('another').ok);
});

test('a player who sat one round out is dealt into the next', () => {
  const g = table(4);
  g.startRound(WORD);
  g.addPlayer({ id: 'late', name: 'Late' });
  playHints(g);
  const white = whitesIn(g)[0];
  allVote(g, (p) => (p.id === white.id ? aliveIn(g)[0].id : white.id));
  g.submitGuess(white.id, 'wrong');

  g.startRound('second-word');
  assert.equal(g.playerById('late').playing, true);
  assert.ok(g.order.includes('late'));
});

group('AI players');

test('bot.isConfigured reflects ANTHROPIC_API_KEY', () => {
  const had = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(bot.isConfigured(), false);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    assert.equal(bot.isConfigured(), true);
  } finally {
    if (had === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = had;
  }
});

await atest('without an API key, chooseHint still returns a legal, unused word', async () => {
  await withoutApiKey(async () => {
    const g = table(3);
    g.startRound(WORD);
    const view = g.viewFor(g.players[0].id);
    const hint = await bot.chooseHint(view);
    assert.ok(isOneWord(hint), `"${hint}" is not one word`);
    assert.ok(!view.hints.some((h) => h.text === normalize(hint)), 'reused an already-said word');
  });
});

await atest('without an API key, chooseVote picks another player, never itself', async () => {
  await withoutApiKey(async () => {
    const g = table(4);
    g.startRound(WORD);
    const me = g.players[0];
    const targetId = await bot.chooseVote(g.viewFor(me.id));
    assert.ok(g.players.some((p) => p.id === targetId), 'voted for someone not at the table');
    assert.notEqual(targetId, me.id, 'voted for itself');
  });
});

await atest('without an API key, chooseGuess names a real word from the list', async () => {
  await withoutApiKey(async () => {
    const g = table(3);
    g.startRound(WORD);
    const guess = await bot.chooseGuess(g.viewFor(g.players[0].id));
    assert.ok(WORDS.includes(guess), `"${guess}" is not in the word list`);
  });
});

test('a Room seats an AI player with a unique, labeled name', () => {
  const room = new Room('TEST');
  const first = room.addBot();
  const second = room.addBot();
  assert.ok(first.ok && second.ok);
  assert.ok(room.bots.has(first.playerId));
  assert.ok(room.bots.has(second.playerId));
  const names = room.game.players.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, 'two bots collided on a name');
  assert.ok(names.every((n) => n.endsWith('(AI)')), 'a bot name does not say so');
});

test('Room.removeBot gives the seat back, and only for an AI seat', () => {
  const room = new Room('TEST2');
  const { playerId } = room.addBot();
  const gone = room.removeBot(playerId);
  assert.ok(gone.ok);
  assert.ok(!room.bots.has(playerId));
  assert.equal(room.game.playerById(playerId), null);

  const human = room.join('Human');
  assert.ok(!room.removeBot(human.playerId).ok, 'removeBot must refuse a human seat');
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
