import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A headset and three phones, at one table.
 *
 * The point of this test is the claim the VR mode is built on: that it is
 * *another client for the same game*, not a second game. So it seats a VR
 * player and three phone players at one table, deals, and plays a round
 * through to the reveal — with every VR action driven the way a real one is,
 * by pointing at a thing in the room and clicking it. The mid-air keyboard is
 * typed on key by key, at the screen position each key actually projects to.
 *
 * It runs without a headset on purpose. WebXR cannot be driven headlessly,
 * but the room, the layout, the raycasting, the keyboard and every line of
 * game wiring are the same objects in both modes — so what a headset adds on
 * top is stereo rendering and a tracked pointer, and what this covers is
 * everything underneath. It is the difference between "the VR mode is
 * untested" and "the parts a browser can reach are tested".
 */

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = path.join(ROOT, 'tools', 'shots');
const PORT = 3500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

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

/** Hints have to be one word and unique within a round — and typeable on a
 *  keyboard that deliberately has no digits on it, so no "clue1". A tie sends
 *  the table round for another pass, so this has to keep producing fresh
 *  words indefinitely rather than running off the end of a list. */
const WORDS = ['alpha', 'bravo', 'delta', 'echo', 'gamma', 'kilo', 'lima', 'mike',
  'nova', 'oscar', 'papa', 'romeo', 'sierra', 'tango', 'union', 'victor'];
let wordIndex = 0;
function nextWord() {
  const base = WORDS[wordIndex % WORDS.length];
  const cycle = Math.floor(wordIndex / WORDS.length);
  wordIndex += 1;
  return cycle === 0 ? base : base + 'abcdefghij'[(cycle - 1) % 10];
}

async function until(fn, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

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

/** Click a point in the 3D view the way a mouse would: move, then press. */
async function clickAt(page, pos, label) {
  if (!pos) throw new Error(`nothing to click for ${label}`);
  await page.mouse.move(pos.x, pos.y);
  await sleep(60); // let the hover raycast land before the press
  await page.mouse.down();
  await page.mouse.up();
  await sleep(90);
}

async function clickKey(page, label) {
  const pos = await page.evaluate((l) => window.__vr.keyScreenPosition(l), label);
  await clickAt(page, pos, `key "${label}"`);
}

/** Type a word on the mid-air keyboard, then press the submit key. */
async function typeInMidAir(page, word) {
  for (const ch of word.toUpperCase()) await clickKey(page, ch);
  await clickKey(page, 'Say it');
}

async function launchChromium(chromium) {
  const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  try {
    return await chromium.launch({ args });
  } catch (err) {
    for (const executablePath of [
      process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    ].filter(Boolean)) {
      if (!fs.existsSync(executablePath)) continue;
      console.log(`  note  using the browser already installed at ${executablePath}`);
      return chromium.launch({ executablePath, args });
    }
    throw err;
  }
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.log('\nplaywright is not installed — skipping the VR smoke test.');
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
  const contexts = [];
  const errors = [];

  try {
    // ------------------------------------------------------- the headset
    console.log('\nPutting the headset on');

    const vrContext = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    contexts.push(vrContext);
    const vr = await vrContext.newPage();
    vr.on('pageerror', (e) => errors.push(`vr: ${e.message}`));
    vr.on('console', (m) => { if (m.type() === 'error') errors.push(`vr console: ${m.text()}`); });
    await vr.goto(`${BASE}/vr.html`, { waitUntil: 'load' });

    const gl = await vr.evaluate(() => {
      const canvas = document.querySelector('#scene canvas');
      if (!canvas) return null;
      return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    });
    check(gl === true, 'the villa gets a WebGL context and renders');

    await vr.fill('#entry-name', 'Headset');
    await vr.click('#entry-create');
    await until(() => vr.locator('#overlay').isHidden(), 'the headset to sit down');
    const code = await vr.evaluate(() => JSON.parse(localStorage.getItem('mrwhite.session')).room);
    check(/^[A-Z]{4}$/.test(code), 'starting a table from VR gives a normal table code', code);

    // --------------------------------------------------------- the phones
    console.log('\nThree phones join the same table');

    const phones = [];
    for (const name of ['Ana', 'Ben', 'Cleo']) {
      const context = await browser.newContext({ viewport: { width: 420, height: 860 } });
      contexts.push(context);
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      await page.goto(BASE, { waitUntil: 'load' });
      await page.fill('#entry-name', name);
      await page.fill('#entry-code', code);
      await page.click('#entry-join');
      await until(() => page.locator('#panel-lobby').isVisible(), `${name} to sit down`);
      phones.push({ name, page });
    }

    const seen = await phones[0].page.locator('#player-list .pname').allTextContents();
    check(seen.includes('Headset') && seen.length === 4,
      'the phones see the headset as an ordinary player at the table', seen.join(', '));

    const seatCount = await vr.evaluate(() => window.__vr.seating.seats.size);
    check(seatCount === 4, 'and the headset has everyone seated around the round table', `${seatCount} seats`);

    if (SHOTS) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await vr.screenshot({ path: path.join(SHOT_DIR, 'vr-1-lobby.png') });
    }

    // ------------------------------------------------------------- deal
    console.log('\nDealing, from inside the room');

    const dealPos = await vr.evaluate(() => window.__vr.meshScreenPosition(window.__vr.actionButton.mesh));
    await clickAt(vr, dealPos, 'the deal button');
    await until(async () => (await vr.evaluate(() => window.__vr.state?.phase)) !== 'lobby',
      'the round to be dealt by pointing at the table');
    check(true, 'the round is dealt by pointing at a button in the room');

    for (const p of phones) {
      await until(() => p.page.locator('#reveal-card').isVisible(), `${p.name}'s role card`);
      await p.page.click('#role-card');
      await until(() => p.page.locator('#role-shown').isVisible(), `${p.name}'s role`);
      p.role = (await p.page.textContent('#role-word')).trim();
      await p.page.click('#role-ok');
      await until(async () => !await p.page.locator('#reveal-card').isVisible(), `${p.name}'s card to close`);
    }

    const vrView = await vr.evaluate(() => {
      const s = window.__vr.state;
      return { role: s.you.role, word: s.word, phase: s.phase };
    });
    check(vrView.role === 'mrwhite' || vrView.role === 'civilian',
      'the headset is dealt a role like anybody else', vrView.role);

    // ------------------------------------ the property that still matters
    console.log('\nWhat the headset is told');

    if (vrView.role === 'mrwhite') {
      check(vrView.word === null,
        'a Mr. White in VR is not sent the word — the redaction is the server\'s, not the renderer\'s');
    } else {
      check(typeof vrView.word === 'string' && vrView.word.length > 0,
        'a civilian in VR is sent the word, so the check above can tell the difference');
    }

    if (SHOTS) await vr.screenshot({ path: path.join(SHOT_DIR, 'vr-2-dealt.png') });

    // ------------------------------------------------------------ hints
    console.log('\nTyping in mid air');

    let typedInVR = false;
    let spoken = 0;
    await until(async () => {
      const phase = await vr.evaluate(() => window.__vr.state?.phase);
      if (phase !== 'hint') return true;

      const myTurn = await vr.evaluate(() => {
        const s = window.__vr.state;
        return s.turnPlayerId === s.you.id;
      });

      if (myTurn) {
        if (!typedInVR) {
          check(await vr.evaluate(() => window.__vr.keyboard.visible),
            'the mid-air keyboard comes up when the table is waiting on you');
          if (SHOTS) await vr.screenshot({ path: path.join(SHOT_DIR, 'vr-3-keyboard.png') });
        }
        await typeInMidAir(vr, nextWord());
        typedInVR = true;
        spoken += 1;
        await sleep(200);
        return false;
      }

      for (const p of phones) {
        if (await p.page.locator('#hint-turn').isVisible()) {
          await p.page.fill('#hint-input', nextWord());
          await p.page.click('#hint-send');
          spoken += 1;
          await sleep(140);
        }
      }
      return false;
    }, 'the hints to go round', 45000);

    check(typedInVR, 'the headset took its turn on the mid-air keyboard');
    const typedHint = await vr.evaluate(() => {
      const s = window.__vr.state;
      return s.hints.find((h) => h.playerId === s.you.id)?.text ?? null;
    });
    check(typedHint !== null, 'and the word it typed reached the table', String(typedHint));
    const onPhone = await phones[0].page.locator('#hint-log .hint-row .what').allTextContents();
    check(onPhone.includes(typedHint),
      'and shows up on the phones, in the same log as everyone else\'s', onPhone.join(', '));

    // ------------------------------------------------------------- vote
    console.log('\nVoting by pointing at someone');

    await until(() => vr.evaluate(() => window.__vr.state?.phase === 'vote'), 'the vote to open');
    const targets = await vr.evaluate(() => window.__vr.voteTargets().length);
    check(targets === 3, 'a vote button floats over everyone still in', `${targets} targets`);

    if (SHOTS) await vr.screenshot({ path: path.join(SHOT_DIR, 'vr-4-vote.png') });

    const votePos = await vr.evaluate(() => {
      const target = window.__vr.voteTargets()[0];
      return { pos: window.__vr.meshScreenPosition(target), id: target.userData.voteTargetId };
    });
    await clickAt(vr, votePos.pos, 'a vote button');
    await until(() => vr.evaluate(() => window.__vr.state?.yourVote !== null), 'the vote to register');
    const cast = await vr.evaluate(() => window.__vr.state.yourVote);
    check(cast === votePos.id, 'pointing at someone and clicking casts your vote for them');

    // ---------------------------------------------------------- the end
    console.log('\nThrough to the reveal');

    // From here on, just keep the table moving through whatever phase it is
    // in. A tie sends everyone back for another pass of hints, so this cannot
    // be a fixed sequence of steps — it has to be a loop that handles every
    // phase, exactly as the four people playing would.
    await until(async () => {
      const phase = await vr.evaluate(() => window.__vr.state?.phase);
      // A null state means the headset is no longer at the table. Nothing in
      // this loop asks to leave, so if it happens, a ray aimed at a game
      // control landed on the "leave the table" button instead — which is a
      // real bug, and one worth naming rather than dying of a null deref on.
      if (!phase) throw new Error('the headset left the table mid-round — a UI control is overlapping another');
      if (phase === 'reveal') return true;

      if (phase === 'hint') {
        const myTurn = await vr.evaluate(() => {
          const s = window.__vr.state;
          return s.turnPlayerId === s.you.id;
        });
        if (myTurn) {
          await typeInMidAir(vr, nextWord());
        } else {
          for (const p of phones) {
            if (await p.page.locator('#hint-turn').isVisible()) {
              await p.page.fill('#hint-input', nextWord());
              await p.page.click('#hint-send');
              await sleep(120);
            }
          }
        }
      } else if (phase === 'vote') {
        const needsVote = await vr.evaluate(() => window.__vr.state.yourVote === null
          && window.__vr.state.you.alive && window.__vr.voteTargets().length > 0);
        if (needsVote) {
          const pos = await vr.evaluate(() => window.__vr.meshScreenPosition(window.__vr.voteTargets()[0]));
          await clickAt(vr, pos, 'a vote button');
        }
        for (const p of phones) {
          if (!await p.page.locator('#panel-vote').isVisible()) continue;
          if (await p.page.locator('.vote-option.chosen').count()) continue;
          const options = p.page.locator('.vote-option');
          if (await options.count()) {
            await options.first().click();
            await sleep(110);
          }
        }
      } else if (phase === 'guess') {
        const mine = await vr.evaluate(() => {
          const s = window.__vr.state;
          return s.guesserId === s.you.id;
        });
        if (mine) {
          check(await vr.evaluate(() => window.__vr.keyboard.visible),
            'a caught Mr. White in VR gets the keyboard back for their guess');
          await typeInMidAir(vr, 'nope');
        } else {
          for (const p of phones) {
            if (await p.page.locator('#guess-mine').isVisible()) {
              await p.page.fill('#guess-input', 'nope');
              await p.page.click('#guess-send');
            }
          }
        }
      }
      await sleep(200);
      return false;
    }, 'the round to finish', 90000);

    const outcome = await vr.evaluate(() => window.__vr.state.outcome);
    check(Boolean(outcome?.word), 'the round reaches a reveal, with the word on the table', JSON.stringify(outcome));
    const revealedWord = await vr.evaluate(() => window.__vr.state.word);
    check(revealedWord === outcome.word, 'and the headset is shown it too, now that it is over');

    if (SHOTS) await vr.screenshot({ path: path.join(SHOT_DIR, 'vr-5-reveal.png') });

    // ---------------------------------------------------------- console
    console.log('\nConsole');
    check(errors.length === 0, 'no client-side errors', errors.join('\n        '));
    check(serverErrors.length === 0, 'no server-side errors', serverErrors.join('').slice(0, 500));
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await browser.close().catch(() => {});
    server.kill('SIGTERM');
  }

  console.log(failures === 0 ? '\nVR smoke test passed' : `\nVR smoke test FAILED (${failures})`);
  if (SHOTS) console.log(`screenshots in ${path.relative(ROOT, SHOT_DIR)}/`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error('\nVR smoke test errored:', err.message);
  process.exit(1);
});
