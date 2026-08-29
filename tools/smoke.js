import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Four browsers, one table, a whole game.
 *
 * The unit tests prove the rules; this proves the parts fit together — that a
 * hint typed on one phone appears on the other three, that a vote resolves,
 * that the reveal says what it should.
 *
 * And it proves the one thing that cannot be proved anywhere else: it records
 * every WebSocket frame each browser actually receives, and checks that the
 * secret word never appears in any frame sent to Mr. White. Not hidden in the
 * page — never delivered. A DOM check would only show that the interface does
 * not display it, which is a very different and much weaker claim.
 */

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = path.join(ROOT, 'tools', 'shots');
const PORT = 3400 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const NAMES = ['Ana', 'Ben', 'Cleo', 'Dev'];

let failures = 0;
function check(ok, label, detail = '') {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
  }
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  return false;
}

/** Poll a predicate rather than sleeping a guessed amount. */
async function until(fn, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const visible = (page, sel) => page.locator(sel).isVisible();

/**
 * Click something, and say what it was if it does not work.
 *
 * Playwright's own failure is `page.click: Timeout 30000ms exceeded` with the
 * selector but no idea whose screen or what point in the game — which is
 * exactly the report you cannot act on when it happens once in twenty runs.
 *
 * The overlay check is the substantive part. The role card is a full-screen
 * layer, and while it is up every click beneath it waits for an element that
 * is never going to become clickable. Asserting it is down first turns that
 * from a silent thirty-second hang into a sentence naming the cause.
 */
async function click(player, selector, label) {
  const blocked = await visible(player.page, '#reveal-card');
  if (blocked && !selector.startsWith('#role')) {
    throw new Error(`${label}: ${player.name}'s role card is still covering the screen`);
  }
  try {
    await player.page.click(selector, { timeout: 8000 });
  } catch (err) {
    throw new Error(`${label}: could not click ${selector} on ${player.name}'s screen `
      + `(phase panels: ${await phasesOf(player.page)}) — ${err.message.split('\n')[0]}`);
  }
}

/**
 * Dismiss the role card, and make sure it actually went.
 *
 * Clicking and hoping is what makes this test flaky under load: the card is a
 * full-screen overlay, so if the dismissal does not take, every later click on
 * that page waits on an element that will never be reachable, and the test
 * fails thirty seconds later somewhere entirely unrelated.
 */
async function putCardAway(player) {
  await click(player, '#role-ok', 'putting the role card away');
  await until(
    async () => !await visible(player.page, '#reveal-card'),
    `${player.name}'s role card to close`,
    5000,
  );
}

/** Which panels a page is showing, for a failure message worth reading. */
async function phasesOf(page) {
  const names = ['lobby', 'hint', 'vote', 'guess', 'reveal'];
  const shown = [];
  for (const n of names) if (await visible(page, `#panel-${n}`)) shown.push(n);
  if (await visible(page, '#reveal-card')) shown.push('role-card');
  return shown.join('+') || 'none';
}

/**
 * Launch the browser Playwright downloaded, or whatever browser is already on
 * the machine.
 *
 * Playwright pins an exact Chromium build per release and refuses anything
 * else, which is right for it and unhelpful here: plenty of environments ship
 * a perfectly good Chromium at a fixed path and no way to download another
 * one. So: try the normal way first, and only if that fails fall back to a
 * browser already present. Nothing about this test depends on the exact
 * build.
 */
async function launchChromium(chromium) {
  try {
    return await chromium.launch();
  } catch (err) {
    const candidates = [
      process.env.CHROMIUM_PATH,
      '/opt/pw-browsers/chromium',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
    ].filter(Boolean);
    for (const executablePath of candidates) {
      if (!fs.existsSync(executablePath)) continue;
      console.log(`  note  using the browser already installed at ${executablePath}`);
      return chromium.launch({ executablePath });
    }
    throw err;
  }
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.log('\nplaywright is not installed — skipping the browser smoke test.');
    console.log('install it with:  npm install\n');
    return;
  }

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverErrors = [];
  server.stderr.on('data', (b) => serverErrors.push(b.toString()));

  if (!await waitForServer()) {
    server.kill();
    throw new Error(`server never came up on ${PORT}`);
  }

  const browser = await launchChromium(chromium);
  const players = [];

  try {
    // ------------------------------------------------------------ joining
    console.log('\nSitting down');

    for (const name of NAMES) {
      // A separate context per player: separate storage, separate session,
      // as unlike each other as four different phones.
      const context = await browser.newContext({ viewport: { width: 420, height: 860 } });
      const page = await context.newPage();
      const frames = [];
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      // Attached before navigation, so the very first frame is captured.
      page.on('websocket', (ws) => {
        ws.on('framereceived', ({ payload }) => frames.push(String(payload)));
      });
      await page.goto(BASE, { waitUntil: 'load' });
      players.push({ name, context, page, frames, errors });
    }

    const [host, ...guests] = players;

    await host.page.fill('#entry-name', host.name);
    await click(host, '#entry-create', 'starting a table');
    await until(() => visible(host.page, '#panel-lobby'), 'the host to get a table');

    const code = (await host.page.textContent('#lobby-code')).trim();
    check(/^[A-Z]{4}$/.test(code), 'starting a table gives a four-letter code', code);

    for (const guest of guests) {
      await guest.page.fill('#entry-name', guest.name);
      await guest.page.fill('#entry-code', code.toLowerCase()); // typed however
      await click(guest, '#entry-join', `${guest.name} joining`);
      await until(() => visible(guest.page, '#panel-lobby'), `${guest.name} to sit down`);
    }

    const seen = await host.page.locator('#player-list .pname').allTextContents();
    check(seen.length === 4 && NAMES.every((n) => seen.includes(n)),
      'everyone appears at the table, on everyone else\'s screen', seen.join(', '));
    check(await visible(host.page, '#lobby-host'), 'the host gets the deal button');
    check(!await visible(guests[0].page, '#lobby-host'), 'and nobody else does');

    if (SHOTS) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await host.page.screenshot({ path: path.join(SHOT_DIR, '1-lobby.png') });
    }

    // -------------------------------------------------------- the deal
    console.log('\nThe deal');
    await click(host, '#btn-start', 'dealing the first round');
    for (const p of players) {
      await until(() => visible(p.page, '#reveal-card'), `${p.name}'s role card`);
    }
    check(true, 'everyone is dealt a role card, face down');

    if (SHOTS) await host.page.screenshot({ path: path.join(SHOT_DIR, '2-role-facedown.png') });

    // Turn each card over and read it.
    for (const p of players) {
      await click(p, '#role-card', 'turning the role card over');
      await until(() => visible(p.page, '#role-shown'), `${p.name}'s role`);
      p.role = (await p.page.textContent('#role-word')).trim();
    }
    if (SHOTS) await host.page.screenshot({ path: path.join(SHOT_DIR, '3-role-shown.png') });
    for (const p of players) await putCardAway(p);

    const whites = players.filter((p) => p.role === 'Mr. White');
    const civilians = players.filter((p) => p.role !== 'Mr. White');
    check(whites.length === 1, 'exactly one player is Mr. White', `got ${whites.length}`);

    const word = civilians[0].role;
    check(civilians.every((p) => p.role === word),
      'every civilian was dealt the same word', civilians.map((p) => p.role).join(' / '));
    check(/^[a-z-]+$/.test(word), 'and it is a real word from the list', word);

    const white = whites[0];

    // ------------------------------------------- the property that matters
    console.log('\nWhat Mr. White is told');

    const whiteTraffic = white.frames.join('\n').toLowerCase();
    check(!whiteTraffic.includes(word.toLowerCase()),
      'the word is never sent to Mr. White — not in any frame, on any message',
      `"${word}" found in ${white.name}'s traffic`);
    check(whiteTraffic.length > 0, 'and the check is looking at real traffic',
      `${white.frames.length} frames captured`);
    check(civilians.every((p) => p.frames.join('').toLowerCase().includes(word.toLowerCase())),
      'while the civilians were sent it, so the check can tell the difference');

    const whitePage = await white.page.content();
    check(!whitePage.toLowerCase().includes(word.toLowerCase()),
      'and it is nowhere in their page either');

    // ------------------------------------------------------------- hints
    console.log('\nGiving hints');

    const firstSpeaker = players.find(async (p) => visible(p.page, '#hint-turn'));
    check(Boolean(firstSpeaker), 'someone is on the clock');

    // The first speaker is guaranteed to be a civilian, so their rejections
    // are the ones worth checking: a refused hint has to come back as
    // something visible they can act on, not vanish into a dead button.
    const first = await until(
      async () => {
        for (const p of players) if (await visible(p.page, '#hint-turn')) return p;
        return null;
      },
      'the first speaker',
    );
    check(first.role !== 'Mr. White',
      'the first speaker is never Mr. White — that seat has nothing to go on');

    if (SHOTS) await first.page.screenshot({ path: path.join(SHOT_DIR, '4-hints.png') });

    await first.page.fill('#hint-input', 'two words');
    await click(first, '#hint-send', 'sending a two-word hint');
    await until(() => visible(first.page, '#hint-error'), 'the two-word rejection');
    check(/one word/i.test(await first.page.textContent('#hint-error')),
      'a hint of two words is refused, and says why');

    await first.page.fill('#hint-input', word);
    await click(first, '#hint-send', 'sending the secret word as a hint');
    await until(
      async () => /cannot say the word/i.test(await first.page.textContent('#hint-error')),
      'the secret-word rejection',
    );
    check(true, 'and a civilian cannot simply say the secret word');
    check(await visible(first.page, '#hint-turn'),
      'a refused hint leaves it still their turn, not skipped');

    let spoken = 0;
    await until(async () => {
      for (const p of players) {
        if (!await visible(p.page, '#hint-turn')) continue;
        if (p === white) {
          check(true, 'Mr. White has to say something too, with nothing to go on');
        }
        await p.page.fill('#hint-input', `clue${spoken++}`);
        await click(p, '#hint-send', `${p.name} giving a hint`);
        await sleep(120);
      }
      return visible(players[0].page, '#panel-vote');
    }, 'the hints to go round', 20000);

    check(spoken === 4, 'each of the four said one word', `${spoken} hints`);
    const logged = await guests[0].page.locator('#hint-log .hint-row .what').allTextContents();
    check(logged.length === 4, 'and all four are on everyone\'s screen', logged.join(', '));
    check(!logged.includes(word), 'and the word itself never made it into the log');

    // -------------------------------------------------------------- vote
    console.log('\nThe vote');

    // Every screen, not just one: the hint loop ends as soon as the *first*
    // page shows the ballot, and clicking a vote on a page still catching up
    // is the sort of race that only shows up on a loaded machine.
    for (const p of players) {
      await until(() => visible(p.page, '#panel-vote'), `${p.name}'s ballot`);
    }
    check(true, 'the vote opens for everyone');

    // Everyone votes for Mr. White; Mr. White has to put theirs elsewhere.
    for (const p of players) {
      const target = p === white ? civilians[0].name : white.name;
      await click(p, `.vote-option:has-text("${target}")`, `${p.name} voting for ${target}`);
      await sleep(100);
    }

    await until(() => visible(white.page, '#guess-mine'), 'Mr. White to be caught', 8000);
    check(true, 'the most-voted player is caught, and it is Mr. White');
    check(await visible(civilians[0].page, '#guess-theirs'),
      'everyone else is told they are guessing');

    const stillHidden = white.frames.join('\n').toLowerCase();
    check(!stillHidden.includes(word.toLowerCase()),
      'being caught still does not tell them the word — that is the whole point');

    if (SHOTS) await white.page.screenshot({ path: path.join(SHOT_DIR, '6-caught.png') });

    // ------------------------------------------------------------- guess
    console.log('\nThe guess');

    await white.page.fill('#guess-input', 'definitely-not-it');
    await click(white, '#guess-send', 'Mr. White sending their guess');
    for (const p of players) {
      await until(() => visible(p.page, '#panel-reveal'), `${p.name}'s reveal`, 8000);
    }

    const verdict = await host.page.textContent('#reveal-verdict');
    check(/table wins/i.test(verdict), 'a wrong guess hands it to the table', verdict.trim());
    check((await host.page.textContent('#reveal-word')).trim() === word,
      'the word is shown at last');
    const whiteSees = (await white.page.textContent('#reveal-word')).trim();
    check(whiteSees === word,
      'to Mr. White as well, now that it is over', `they see "${whiteSees}", word was "${word}"`);

    const scores = await host.page.locator('#reveal-roles .pscore').allTextContents();
    check(scores.filter((s) => s === '2').length === 3,
      'three civilians score two apiece', scores.join(','));
    check(scores.filter((s) => s === '0').length === 1, 'and Mr. White scores nothing');

    if (SHOTS) await host.page.screenshot({ path: path.join(SHOT_DIR, '7-reveal.png') });

    // --------------------------------------------------------- reconnect
    console.log('\nComing back');

    await white.page.reload({ waitUntil: 'load' });
    await until(() => visible(white.page, '#panel-reveal'), 'the reloaded page to find its seat');
    check(true, 'a reload drops back into the same seat, mid-game');
    const backAs = await white.page.locator('#player-list .player-row.is-you .pname').textContent();
    check(backAs.trim() === white.name, 'as the same player', backAs);

    // The reload dropped a connection. If that player was the host, they must
    // still have the buttons afterwards — losing them for locking a phone is
    // the bug this asserts is gone.
    await until(() => visible(host.page, '#btn-next'), 'the host to keep the deal button');
    check(true, 'and the host still has the controls after a dropped connection');

    // ------------------------------------------------------ another round
    console.log('\nRound two');

    await click(host, '#btn-next', 'dealing the second round');
    for (const p of players) {
      await until(() => visible(p.page, '#reveal-card'), `${p.name}'s second role card`);
      await click(p, '#role-card', `${p.name} turning their second card over`);
      await until(() => visible(p.page, '#role-shown'), `${p.name}'s second role`);
      p.role2 = (await p.page.textContent('#role-word')).trim();
      await putCardAway(p);
    }
    const word2 = players.find((p) => p.role2 !== 'Mr. White').role2;
    check(word2 !== word, 'a new round brings a word the table has not had', `${word} then ${word2}`);
    check(players.filter((p) => p.role2 === 'Mr. White').length === 1,
      'and Mr. White is dealt again');

    const white2 = players.find((p) => p.role2 === 'Mr. White');
    const freshTraffic = white2.frames.join('\n').toLowerCase();
    // The second word must be absent from *all* of their traffic. The first
    // word legitimately appears, from the reveal at the end of round one.
    check(!freshTraffic.includes(word2.toLowerCase()),
      'and the new word is kept from whoever it is this time',
      `"${word2}" leaked to ${white2.name}`);

    // ------------------------------------------------------------ console
    console.log('\nConsole');
    const pageErrors = players.flatMap((p) => p.errors);
    check(pageErrors.length === 0, 'no client-side errors', pageErrors.join('\n        '));
    check(serverErrors.length === 0, 'no server-side errors', serverErrors.join('').slice(0, 500));
  } finally {
    for (const p of players) await p.context.close().catch(() => {});
    await browser.close().catch(() => {});
    server.kill('SIGTERM');
  }

  console.log(failures === 0 ? '\nsmoke test passed' : `\nsmoke test FAILED (${failures})`);
  if (SHOTS) console.log(`screenshots in ${path.relative(ROOT, SHOT_DIR)}/`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error('\nsmoke test errored:', err.message);
  process.exit(1);
});
