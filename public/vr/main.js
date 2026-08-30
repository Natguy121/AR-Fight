import * as THREE from '../vendor/three.module.js';
import { buildVilla, TABLE } from './villa.js';
import { Seating } from './seats.js';
import { Keyboard } from './keyboard.js';
import { Panel, roundRect, fitText, wrapLines } from './paint.js';
import { Cardboard } from './cardboard.js';
import { createNet, session } from './net.js';

/**
 * Mr. White, at a table in a villa.
 *
 * This is an *alternative client*, not a second game: it speaks the same
 * WebSocket protocol as `app.js`, so a headset and four phones can sit at the
 * same table, and every rule — including the one that matters, that the word
 * is never sent to Mr. White's device — is enforced in exactly the same place
 * it always was, on the server. Nothing here can weaken it, because nothing
 * here is ever told anything `viewFor` did not choose to send.
 *
 * The room is world-locked, not head-locked. Panels stay where you left them
 * and you turn your head to read them, which is what makes a table feel like
 * a table; UI welded to your face would be easier to build and would feel
 * like a heads-up display in a room, rather than a room.
 */

// The table sits a comfortable forearm's reach in front of where you are
// sitting, so leaning in to read the surface works the way it would in life.
const TABLE_Z = -(TABLE.radius + 0.42);

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ scene

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x140e09);
scene.fog = new THREE.Fog(0x2a1d12, 10, 30);

const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 60);
camera.position.set(0, 1.15, 0); // seated eye height, used outside VR only
// The gaze reticle hangs off the camera, so the camera has to be in the scene
// graph for it to be drawn at all.
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
$('scene').appendChild(renderer.domElement);

const cardboard = new Cardboard(renderer, camera);

/**
 * A cardboard viewer's two lenses want a landscape-shaped picture, wider
 * than tall. Most phones get there by the OS rotating its layout when you
 * turn the phone — which is what innerWidth/innerHeight normally reflect
 * below, with nothing special required. But that rotation is the OS's
 * choice, not the page's: rotation lock in Control Center stops it outright,
 * and iOS Safari has never honoured screen.orientation.lock() to force it
 * either. Rather than leave the phone showing two lens circles each squeezed
 * into a tall sliver — not a stereo pair any more, just one shape covering
 * the screen — the two eyes are drawn stacked one above the other instead
 * whenever the real screen is still portrait. The camera's own aspect stays
 * landscape-shaped regardless of that choice: that's what a lens wants to
 * see, and it has nothing to do with how the final image gets laid out.
 */
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const stacked = cardboard.active && w < h;
  cardboard.setStacked(stacked);
  document.body.classList.toggle('cardboard-stacked', stacked);
  camera.aspect = stacked ? h / w : w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', resize);
resize();

const villa = buildVilla(6);
villa.group.position.z = TABLE_Z;
scene.add(villa.group);

const seating = new Seating(villa.group);

// --------------------------------------------------------------- world UI

const ui = new THREE.Group();
scene.add(ui);

class Button {
  constructor({ width, height, onSelect, tone = 'accent' }) {
    this.panel = new Panel({ width, height, ppm: 1000 });
    this.panel.mesh.userData.button = this;
    this.panel.mesh.visible = false;
    this.onSelect = onSelect;
    this.tone = tone;
    this.hovered = false;
    this.label = '';
    this.paint();
  }

  get mesh() { return this.panel.mesh; }

  set(label, { visible = true } = {}) {
    if (label !== this.label) {
      this.label = label;
      this.paint();
    }
    this.panel.mesh.visible = visible;
    return this;
  }

  setHover(hovered) {
    if (this.hovered === hovered) return;
    this.hovered = hovered;
    this.paint();
  }

  paint() {
    const accent = this.tone === 'accent';
    this.panel.redraw((ctx, w, h) => {
      roundRect(ctx, 3, 3, w - 6, h - 6, h * 0.3);
      if (accent) ctx.fillStyle = this.hovered ? '#ffd76e' : 'rgba(255,194,71,0.9)';
      else ctx.fillStyle = this.hovered ? 'rgba(255,255,255,0.2)' : 'rgba(20,14,10,0.85)';
      ctx.fill();
      ctx.lineWidth = this.hovered ? 6 : 3;
      ctx.strokeStyle = accent ? '#ffe6b0' : 'rgba(246,236,220,0.35)';
      ctx.stroke();

      const size = fitText(ctx, this.label, w * 0.84, h * 0.4, 650);
      ctx.font = `650 ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.fillStyle = accent ? '#2a1e00' : '#f3ece2';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.label, w / 2, h / 2);
    });
  }
}

// Panel sizes are angular-size decisions, not layout ones: a panel a metre
// wide at arm's length fills forty-odd degrees of view, which in a headset is
// a wall you have to look *around* rather than a label you read. Everything
// here is sized to sit comfortably inside a glance, and placed just past the
// far edge of the table so it never occludes a face.
const statusPanel = new Panel({ width: 0.62, height: 0.19, ppm: 1100 });
statusPanel.mesh.position.set(0, 1.62, TABLE_Z + 0.25);
ui.add(statusPanel.mesh);

// Set out over the table rather than close beside you, and scaled up to
// match. Angular size is what the eye reads, so a bigger panel further away
// is the same panel — but a near one has to sit far out to the side to clear
// the keyboard, which drags it to the edge of vision where it clips out of
// frame and, in a headset, needs a head turn rather than a glance.
const wordCard = new Panel({ width: 0.44, height: 0.29, ppm: 1100 });
wordCard.mesh.position.set(-0.62, 1.32, -0.98);
wordCard.mesh.rotation.set(-0.1, 0.55, 0);
ui.add(wordCard.mesh);

const logPanel = new Panel({ width: 0.5, height: 0.58, ppm: 1000 });
logPanel.mesh.position.set(0.62, 1.36, -0.98);
logPanel.mesh.rotation.set(-0.07, -0.55, 0);
ui.add(logPanel.mesh);

const actionButton = new Button({
  width: 0.3,
  height: 0.085,
  onSelect: () => {
    if (!state) return;
    if (state.phase === 'lobby' || state.phase === 'reveal') net.send({ t: 'start' });
  },
});
actionButton.mesh.position.set(0, 1.14, -0.74);
actionButton.mesh.rotation.x = -0.25;
ui.add(actionButton.mesh);

// Kept near, low and off to one side — deliberately nowhere near the far
// side of the table, where the vote buttons live. A "leave the table" control
// sharing screen space with "vote for this player" is one mis-aimed ray away
// from walking out of a game you meant to stay in.
const leaveButton = new Button({
  width: 0.22,
  height: 0.062,
  tone: 'quiet',
  onSelect: () => net.leave(),
});
leaveButton.mesh.position.set(0.44, 0.84, -0.64);
leaveButton.mesh.rotation.set(-0.35, -0.45, 0);
ui.add(leaveButton.mesh);

// The keyboard is the one thing that stays big: it is sized to be *typed on*,
// so its width is set by where your hands comfortably reach. It sits low and
// tilted back, in the space over the near edge of the table where a real one
// would be — high enough to reach without stooping, low enough that it is not
// parked over the faces you are trying to read.
const keyboard = new Keyboard();
keyboard.group.position.set(0, 0.9, -0.6);
keyboard.group.rotation.x = -0.5;
keyboard.group.scale.setScalar(0.62);
ui.add(keyboard.group);

// ------------------------------------------------------------ interaction

const raycaster = new THREE.Raycaster();
const controllers = [];
const pointer = new THREE.Vector2(0, 0);
let pointerActive = false;
let hoverButton = null;

function rayLine() {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1),
  ]);
  const line = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color: 0xffc247, transparent: true, opacity: 0.6 }),
  );
  line.scale.z = 1.6;
  return line;
}

for (const index of [0, 1]) {
  const controller = renderer.xr.getController(index);
  controller.add(rayLine());
  controller.userData.isController = true;
  controller.addEventListener('selectstart', () => select(rayFromController(controller)));
  scene.add(controller);
  controllers.push(controller);
}

function rayFromController(controller) {
  const matrix = new THREE.Matrix4().identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(matrix);
  return raycaster;
}

function rayFromPointer() {
  raycaster.setFromCamera(pointer, camera);
  return raycaster;
}

/** Everything a ray can currently land on. */
function targets() {
  const list = [];
  if (keyboard.visible) list.push(keyboard.face.mesh);
  if (actionButton.mesh.visible) list.push(actionButton.mesh);
  if (leaveButton.mesh.visible) list.push(leaveButton.mesh);
  list.push(...seating.voteTargets);
  return list;
}

function pick(ray) {
  const hits = ray.intersectObjects(targets(), false);
  return hits.length ? hits[0] : null;
}

/**
 * A stable name for whatever a ray is resting on.
 *
 * Gaze-dwell needs to know when you have moved on to a *different* thing, and
 * the mesh alone is not enough: the whole keyboard is one quad, so looking
 * from Q to W is the same object and would otherwise let one long stare type
 * the whole alphabet.
 */
function targetIdOf(hit) {
  if (!hit) return null;
  const key = keyboard.keyAt(hit);
  if (key) return `key:${key.label}`;
  if (hit.object.userData.button) return `button:${hit.object.uuid}`;
  if (hit.object.userData.voteTargetId) return `vote:${hit.object.userData.voteTargetId}`;
  return null;
}

function applyHover(hit) {
  const key = hit ? keyboard.keyAt(hit) : null;
  keyboard.setHover(key);

  const button = hit?.object.userData.button ?? null;
  if (hoverButton !== button) {
    hoverButton?.setHover(false);
    button?.setHover(true);
    hoverButton = button;
  }
}

function select(ray) {
  const hit = pick(ray);
  if (!hit) return;

  const key = keyboard.keyAt(hit);
  if (key) {
    keyboard.press(key);
    return;
  }
  const button = hit.object.userData.button;
  if (button) {
    button.onSelect?.();
    return;
  }
  const voteId = hit.object.userData.voteTargetId;
  if (voteId) net.send({ t: 'vote', targetId: voteId });
}

// Outside a headset: drag to look, click to press. Enough to set a table up,
// show someone the room, and — not incidentally — enough for the smoke test
// to drive the whole thing without a headset attached.
let dragging = false;
let dragged = false;
let lastX = 0;
let lastY = 0;
const look = new THREE.Euler(0, 0, 0, 'YXZ');

const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  dragged = false;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  pointerActive = true;
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  if (Math.abs(dx) + Math.abs(dy) > 3) dragged = true;
  lastX = e.clientX;
  lastY = e.clientY;
  // In a viewer the phone's gyroscope owns the camera; dragging as well would
  // fight it, and you cannot see your finger anyway.
  if (cardboard.active) return;
  look.y -= dx * 0.004;
  look.x = Math.max(-1.2, Math.min(0.9, look.x - dy * 0.004));
  if (!renderer.xr.isPresenting) camera.rotation.copy(look);
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
  if (dragged || renderer.xr.isPresenting) return;
  // Most viewers have a lever or button that pokes the screen, so a tap is
  // the fast path; aim comes from your head either way.
  if (cardboard.active) select(cardboard.gazeRay(raycaster));
  else select(rayFromPointer());
});

// Two fingers re-centres the view, for when the compass has drifted or you
// sat down facing a different way than you started.
canvas.addEventListener('touchstart', (e) => {
  if (cardboard.active && e.touches.length === 2) {
    cardboard.recentre();
    e.preventDefault();
  }
}, { passive: false });

// A physical keyboard, when there is one, beats a mid-air one every time.
window.addEventListener('keydown', (e) => {
  if (!keyboard.visible || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Backspace') {
    keyboard.press({ action: 'back' });
    e.preventDefault();
  } else if (e.key === 'Enter') {
    keyboard.press({ action: 'submit' });
    e.preventDefault();
  } else if (/^[a-zA-Z'’-]$/.test(e.key)) {
    keyboard.press({ value: e.key.toLowerCase() });
  }
});

// -------------------------------------------------------------- game state

let state = null;
let seatCount = 6;
let keyboardContext = null;

const net = createNet({
  onJoined: () => {
    $('overlay').hidden = true;
    $('hud').hidden = false;
  },
  onState: (next) => {
    state = next;
    seating.update(next, net.me.playerId);
    if (next.players.length !== seatCount) {
      seatCount = next.players.length;
      villa.setSeatCount(seatCount);
    }
    renderWorld();
  },
  onError: (message, fatal) => {
    if (keyboard.visible && !fatal) keyboard.reject(message);
    else showOverlayError(message);
    if (fatal) leaveLocally();
  },
  onLeft: leaveLocally,
  onConnection: (up) => { $('conn').classList.toggle('down', !up); },
});

function leaveLocally() {
  state = null;
  keyboard.hide();
  keyboardContext = null;
  $('overlay').hidden = false;
  $('hud').hidden = true;
}

function myTurnContext(s) {
  const myId = net.me.playerId;
  if (s.phase === 'hint' && s.turnPlayerId === myId) return `hint:${s.round}:${s.hintPass}`;
  if (s.phase === 'guess' && s.guesserId === myId) return `guess:${s.round}`;
  return null;
}

function renderWorld() {
  if (!state) return;
  paintStatus();
  paintWordCard();
  paintLog();

  // Settle the keyboard first. The buttons share the space in front of you
  // and hide themselves while it is up, so deciding that before it has opened
  // or closed leaves them wrong until the next state message — which, after
  // the last player has acted, may never come. That is how the host ends up
  // staring at a finished round with no way to deal the next one.
  //
  // Open it only when the *reason* changes, too: re-showing on every state
  // message would wipe what you had half-typed each time somebody else moved.
  const context = myTurnContext(state);
  if (context !== keyboardContext) {
    keyboardContext = context;
    if (!context) {
      keyboard.hide();
    } else if (context.startsWith('hint')) {
      keyboard.show({
        title: 'Your turn — one word',
        maxLength: 20,
        onSubmit: (text) => net.send({ t: 'hint', text }),
      });
    } else {
      keyboard.show({
        title: 'Caught. One guess at the word',
        maxLength: 30,
        onSubmit: (text) => net.send({ t: 'guess', text }),
      });
    }
  }

  const canDeal = state.youCanDeal && (state.phase === 'lobby' || state.phase === 'reveal');
  actionButton.set(state.phase === 'reveal' ? 'Next round' : 'Deal the round', {
    visible: canDeal && !keyboard.visible,
  });
  leaveButton.set('Leave the table');
}

function paintStatus() {
  const s = state;
  statusPanel.redraw((ctx, w, h) => {
    statusPanel.card(ctx, w, h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    let kicker = '';
    let line = '';
    let tint = '#f3ece2';

    if (s.phase === 'lobby') {
      kicker = `TABLE ${s.room ?? ''}`;
      const short = s.minPlayers - s.players.length;
      line = short > 0
        ? `${short} more ${short === 1 ? 'player' : 'players'} needed`
        : (s.youCanDeal ? 'Ready when you are' : 'Waiting for the host');
    } else if (s.phase === 'hint') {
      const who = s.players.find((p) => p.id === s.turnPlayerId);
      kicker = s.hintPass > 1 ? `ROUND ${s.round} · PASS ${s.hintPass}` : `ROUND ${s.round}`;
      line = who ? (who.id === s.you?.id ? 'Your turn — say one word' : `${who.name} is thinking…`) : 'Waiting…';
    } else if (s.phase === 'vote') {
      kicker = `ROUND ${s.round}`;
      line = s.yourVote ? 'Waiting for the rest of the table' : 'Who is Mr. White?';
    } else if (s.phase === 'guess') {
      kicker = 'CAUGHT';
      const who = s.players.find((p) => p.id === s.guesserId);
      line = s.guesserId === s.you?.id ? 'One guess at the word' : `${who?.name ?? 'They'} are guessing…`;
    } else if (s.phase === 'reveal') {
      const o = s.outcome ?? {};
      kicker = `THE WORD WAS “${o.word ?? '—'}”`;
      if (o.winner === 'civilians') { line = 'Caught. The table wins.'; tint = '#8ee6a6'; }
      else if (o.winner === 'mrwhite') {
        line = o.reason === 'guessed' ? 'Named it. Mr. White wins.' : 'Mr. White got away with it.';
        tint = '#ffd9a0';
      } else { line = 'Round abandoned.'; tint = '#c9bba8'; }
    }

    ctx.font = `700 ${h * 0.16}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = 'rgba(232,220,200,0.6)';
    ctx.fillText(kicker, w / 2, h * 0.31);

    const size = fitText(ctx, line, w * 0.88, h * 0.3, 700);
    ctx.font = `700 ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = tint;
    ctx.fillText(line, w / 2, h * 0.63);
  });
}

function paintWordCard() {
  const s = state;
  const playing = s.you?.playing;
  const isWhite = s.you?.role === 'mrwhite';
  wordCard.mesh.visible = Boolean(playing) || s.phase === 'reveal';
  if (!wordCard.mesh.visible) return;

  wordCard.redraw((ctx, w, h) => {
    wordCard.card(ctx, w, h, {
      fill: isWhite ? 'rgba(46,40,34,0.98)' : 'rgba(22,15,10,0.98)',
      stroke: isWhite ? 'rgba(214,219,230,0.6)' : 'rgba(255,194,71,0.45)',
    });
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.font = `600 ${h * 0.1}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = 'rgba(232,220,200,0.55)';
    ctx.fillText(isWhite ? 'YOU ARE' : 'YOUR WORD', w / 2, h * 0.26);

    // `s.word` is null for Mr. White because the server never sent it. This
    // branch is a label, not a redaction — there is nothing here to hide.
    const text = isWhite ? 'Mr. White' : (s.word ?? '—');
    const size = fitText(ctx, text, w * 0.84, h * 0.3, 700);
    ctx.font = `700 ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = isWhite ? '#d6dbe6' : '#ffc247';
    ctx.fillText(text, w / 2, h * 0.53);

    ctx.font = `500 ${h * 0.088}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = 'rgba(232,220,200,0.5)';
    const note = isWhite
      ? 'Work out what they are all talking about.'
      : 'Hint at it. Never say it.';
    for (const [i, l] of wrapLines(ctx, note, w * 0.84).entries()) {
      ctx.fillText(l, w / 2, h * 0.76 + i * h * 0.11);
    }
  });
}

function paintLog() {
  const s = state;
  const entries = [];
  for (const entry of s.log ?? []) {
    const name = s.players.find((p) => p.id === entry.playerId)?.name ?? 'Someone';
    if (entry.t === 'hint') entries.push({ who: name, what: entry.text });
    else if (entry.t === 'skip') entries.push({ who: name, what: 'said nothing', dim: true });
    else if (entry.t === 'tie') entries.push({ event: 'Votes tied — round again.' });
    else if (entry.t === 'eliminated') {
      entries.push({ event: `${name} was voted out — ${entry.role === 'mrwhite' ? 'Mr. White.' : 'a civilian.'}` });
    } else if (entry.t === 'guess') {
      entries.push({ event: entry.text === null ? `${name} never answered.` : `${name} guessed “${entry.text}” — ${entry.correct ? 'right.' : 'wrong.'}` });
    }
  }

  logPanel.redraw((ctx, w, h) => {
    logPanel.card(ctx, w, h);
    ctx.textBaseline = 'middle';

    ctx.font = `700 ${h * 0.038}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = 'rgba(232,220,200,0.55)';
    ctx.textAlign = 'left';
    ctx.fillText('WHAT HAS BEEN SAID', w * 0.09, h * 0.075);

    const rows = entries.slice(-11);
    const top = h * 0.145;
    const step = (h * 0.8) / 11;
    rows.forEach((row, i) => {
      const y = top + i * step + step / 2;
      if (row.event) {
        ctx.textAlign = 'left';
        ctx.font = `italic 500 ${step * 0.34}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
        ctx.fillStyle = 'rgba(232,220,200,0.62)';
        const line = wrapLines(ctx, row.event, w * 0.84)[0];
        ctx.fillText(line, w * 0.09, y);
        return;
      }
      ctx.textAlign = 'left';
      ctx.font = `500 ${step * 0.34}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.fillStyle = 'rgba(232,220,200,0.6)';
      ctx.fillText(row.who, w * 0.09, y);
      ctx.textAlign = 'right';
      ctx.font = `700 ${step * 0.4}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.fillStyle = row.dim ? 'rgba(232,220,200,0.45)' : '#f3ece2';
      ctx.fillText(row.what, w * 0.91, y);
    });

    if (!rows.length) {
      ctx.textAlign = 'center';
      ctx.font = `500 ${h * 0.042}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.fillStyle = 'rgba(232,220,200,0.35)';
      ctx.fillText('Nothing yet.', w / 2, h * 0.5);
    }
  });
}

// ------------------------------------------------------------------- entry

function showOverlayError(message) {
  const el = $('entry-error');
  el.textContent = message;
  el.hidden = false;
}

$('entry-create').addEventListener('click', () => {
  const name = $('entry-name').value.trim();
  if (!name) return showOverlayError('Pick a name first.');
  $('entry-error').hidden = true;
  net.create(name);
});

$('entry-join').addEventListener('click', () => {
  const name = $('entry-name').value.trim();
  const code = $('entry-code').value.trim().toUpperCase();
  if (!name) return showOverlayError('Pick a name first.');
  if (code.length !== 4) return showOverlayError('A table code is four letters.');
  $('entry-error').hidden = true;
  net.join(code, name);
});

const saved = session.read();
if (saved.name) $('entry-name').value = saved.name;
const codeFromUrl = new URL(location.href).searchParams.get('room');
if (codeFromUrl) $('entry-code').value = codeFromUrl.toUpperCase();

// ---------------------------------------------------------------- WebXR

const enterButton = $('enter-vr');

async function setupXR() {
  if (!navigator.xr) {
    enterButton.textContent = 'No VR in this browser';
    enterButton.disabled = true;
    return;
  }
  let supported = false;
  try {
    supported = await navigator.xr.isSessionSupported('immersive-vr');
  } catch { supported = false; }

  if (!supported) {
    enterButton.textContent = 'No headset detected';
    enterButton.disabled = true;
    return;
  }

  enterButton.disabled = false;
  enterButton.textContent = 'Enter VR';
  enterButton.addEventListener('click', async () => {
    if (renderer.xr.isPresenting) {
      renderer.xr.getSession()?.end();
      return;
    }
    try {
      const xrSession = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
      });
      xrSession.addEventListener('end', () => { enterButton.textContent = 'Enter VR'; });
      await renderer.xr.setSession(xrSession);
      enterButton.textContent = 'Leave VR';
    } catch {
      showOverlayError('The headset refused the session. Try again.');
    }
  });
}
setupXR();

// ------------------------------------------------- phone in a viewer

const cardboardButton = $('enter-cardboard');
const exitCardboardButton = $('exit-cardboard');

function setCardboardChrome(on) {
  // While the phone is in a viewer the page's own controls are behind a lens
  // and cannot be aimed at, so they come off — all but the way out, which
  // sits in the seam between the two eyes where you can find it by feel once
  // the phone is back in your hand.
  $('hud').hidden = on;
  exitCardboardButton.hidden = !on;
  document.body.classList.toggle('in-cardboard', on);
  // Whether the eyes need stacking is only known once the real viewport size
  // is in hand, which resize() reads fresh every time.
  resize();
}

if (!Cardboard.supported) {
  cardboardButton.disabled = true;
  cardboardButton.textContent = 'No motion sensors';
} else {
  cardboardButton.addEventListener('click', async () => {
    // Fullscreen the whole page, not just the canvas: a fullscreen element
    // hides every sibling, and the way out lives outside the canvas.
    const result = await cardboard.enter();
    if (!result.ok) {
      showOverlayError(result.reason);
      return;
    }
    // Whatever you happened to be facing when you put the phone in should not
    // start counting down the moment the lenses come up. Long enough to get
    // the phone into the viewer and the viewer onto your face.
    dwellCooldownUntil = performance.now() + 1500;
    setCardboardChrome(true);
  });
}

exitCardboardButton.addEventListener('click', () => {
  cardboard.exit();
  setCardboardChrome(false);
});

// Leaving fullscreen — the system back gesture, usually — means leaving the
// viewer, or you are left with a split screen and no way to explain it.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && cardboard.active) {
    cardboard.exit();
    setCardboardChrome(false);
  }
});

// ------------------------------------------------------------------- loop

/**
 * A handle for `tools/vr-smoke.js` to aim real pointer events at real keys.
 *
 * The test needs to know where a key *is on screen* to click it, and that is
 * a projection only the page can do. Everything exposed here is state the
 * page already holds and already draws; in particular there is no way to read
 * the word off it that is not simply reading the word the server sent you —
 * and if you are Mr. White, it was never sent.
 */
window.__vr = {
  camera,
  renderer,
  keyboard,
  seating,
  cardboard,
  get state() { return state; },
  /** Which way the camera is facing, for checking the head tracking. */
  forward() {
    const v = new THREE.Vector3();
    camera.getWorldDirection(v);
    return { x: v.x, y: v.y, z: v.z };
  },
  /** World point -> screen pixels, for driving pointer events. */
  project(point) {
    const v = point.clone().project(camera);
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
  },
  /** Screen position of the centre of a keyboard key, by its label. */
  keyScreenPosition(label) {
    const key = keyboard.keys.find((k) => k.label === label);
    if (!key) return null;
    const { canvas } = keyboard.face;
    const local = new THREE.Vector3(
      ((key.x + key.w / 2) / canvas.width - 0.5) * keyboard.face.width,
      (0.5 - (key.y + key.h / 2) / canvas.height) * keyboard.face.height,
      0.001,
    );
    return this.project(keyboard.face.mesh.localToWorld(local));
  },
  /** Screen position of a world-space UI mesh's centre. */
  meshScreenPosition(mesh) {
    return this.project(mesh.getWorldPosition(new THREE.Vector3()));
  },
  actionButton,
  voteTargets: () => seating.voteTargets,
};

// Gaze-and-hold, for viewers with no button at all.
let dwellId = null;
let dwellStart = 0;
let dwellCooldownUntil = 0;

function updateDwell(hit) {
  const id = targetIdOf(hit);
  const now = performance.now();

  if (!id) {
    dwellId = null;
    cardboard.setReticle(0);
    return;
  }
  if (id !== dwellId) {
    dwellId = id;
    dwellStart = now;
    cardboard.setReticle(0);
    return;
  }
  if (now < dwellCooldownUntil) {
    cardboard.setReticle(0);
    return;
  }
  const progress = Math.min(1, (now - dwellStart) / cardboard.dwellMs);
  cardboard.setReticle(progress);
  if (progress >= 1) {
    select(cardboard.gazeRay(raycaster));
    dwellStart = now;
    // Without a pause, holding still on a key would repeat it forever.
    dwellCooldownUntil = now + 320;
  }
}

renderer.setAnimationLoop(() => {
  let hit = null;

  if (renderer.xr.isPresenting) {
    for (const controller of controllers) {
      if (!controller.visible) continue;
      hit = pick(rayFromController(controller));
      if (hit) break;
    }
    applyHover(hit);
  } else if (cardboard.active) {
    cardboard.update();
    hit = pick(cardboard.gazeRay(raycaster));
    applyHover(hit);
    updateDwell(hit);
  } else {
    if (pointerActive) hit = pick(rayFromPointer());
    applyHover(hit);
  }

  seating.faceCamera(camera);

  if (cardboard.active) cardboard.render(scene);
  else renderer.render(scene, camera);
});

net.connect();
