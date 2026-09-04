# 3D Mode Implementation

An exhaustive walkthrough of how the flat-screen ("3D mode") client works: every subsystem, every formula, and why it's built the way it is. This covers `public/vr/main.js`, `public/vr/paint.js`, `public/vr/keyboard.js`, `public/vr/seats.js`, `public/vr/villa.js`, and `public/vr/net.js` — everything that runs when someone opens the game on a phone, tablet, or desktop without a headset.

---

## 1. The Core Idea: One Scene, Two Presentations

There is exactly one Three.js scene, one set of meshes, one game-state pipeline. VR and 3D mode are not two clients that happen to look similar — they are the *same* renderer with a single boolean, `renderer.xr.isPresenting`, deciding how the camera is driven and how big/opaque the UI is. Nothing about the scene graph changes between the two; only camera control and a few cosmetic values do.

This matters because it means:
- A player can start in 3D mode, put on a headset mid-session, and re-enter VR without reloading or resetting any state.
- Every panel, button, and avatar defined once serves both presentations.
- There is no separate "3D renderer" to keep in sync with a "VR renderer."

```javascript
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
```

`renderer.xr.enabled = true` is set unconditionally, even though most sessions never enter VR — enabling it costs nothing when no XR session is active, and it means the entire `renderer.xr.*` API (session events, `isPresenting`, controller access) is available from the first frame.

---

## 2. Scene Bootstrap

### 2.1 Scene, Fog, Background

```javascript
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x140e09);
scene.fog = new THREE.Fog(0x2a1d12, 10, 30);
```

- **Background** (`0x140e09`) is a near-black warm brown — it's what you see through windows/doorways and at the fog's far edge, so it has to match the fog color family or the horizon looks like a seam.
- **Fog** is linear (`THREE.Fog`, not exponential): fully clear from 0–10m, then fading linearly to the fog color by 30m. This hides the edge of the built geometry (there's no skybox or distant terrain) without a hard clipping plane, and keeps the far walls of the villa from popping in as sharp silhouettes.

### 2.2 Camera

```javascript
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 60);
camera.position.set(0, 1.15, 0); // seated eye height, used outside VR only
```

Four constructor arguments, each a deliberate choice:

| Param | Value | Reasoning |
|---|---|---|
| FOV | 70° | Wide enough to feel immersive on a phone held close to the face, narrow enough that UI panels (sized for a ~40° angular footprint) don't feel cramped |
| Aspect | 1 (placeholder) | Immediately overwritten by `resize()` on load; never trusted as authoritative |
| Near plane | 0.05m | Must be closer than the keyboard, which sits ~0.3m from a leaning-in face |
| Far plane | 60m | Beyond the fog's 30m cutoff, so nothing between the fog limit and 60m needs to be drawn — but the plane itself is placed well past fog-out for margin |

`camera.position.set(0, 1.15, 0)` places the eye at seated height. This position (and any rotation set by mouse drag, see §4) is **only consulted when `!renderer.xr.isPresenting`**. Once an XR session starts, `renderer.xr` takes over the camera's matrix every frame from the headset's tracked pose, and any manual `camera.position`/`camera.rotation` writes are simply ignored by the renderer for that frame (though the properties themselves are still stored, which is why `updateViewMode()` doesn't need to save/restore them — see §7).

### 2.3 Renderer

```javascript
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
```

- **`antialias: true`** — MSAA on the canvas; the room is low-poly enough that this is affordable even on mid-range phones.
- **`powerPreference: 'high-performance'`** — requests the discrete GPU where available (laptops with switchable graphics); on phones this is advisory and usually ignored by the OS.
- **`devicePixelRatio` capped at 2** — a phone reporting a DPR of 3 (many do) would otherwise render at 3× linear resolution per axis, i.e. 9× the pixel-shading cost, for a sharpness improvement invisible at arm's length. Capping at 2 is the standard practical ceiling for real-time 3D on the web.
- **`PCFSoftShadowMap`** — percentage-closer soft shadows; costs more than the hard-edged `BasicShadowMap` but the villa's warm, sun-through-a-window lighting reads as fake with hard shadow edges.
- **ACES Filmic tone mapping at 1.05 exposure** — maps the wide dynamic range of the lit interior (bright terracotta floor near the "window," dark corners) into displayable range without blowing out highlights or crushing shadows. 1.05 (slightly above the neutral 1.0) was tuned to keep the wood tones from reading as muddy.

### 2.4 Resize Handling

```javascript
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', resize);
resize();
```

Called once immediately (so the very first frame is correctly sized, not whatever the default canvas size was) and again on every `resize` event — covering device rotation (portrait ↔ landscape), browser window resizing, and any dynamic viewport changes (address bar show/hide on mobile Safari, which fires `resize`). `camera.updateProjectionMatrix()` must be called any time `aspect` (or `fov`/`near`/`far`) changes — Three.js caches the projection matrix and won't recompute it automatically.

### 2.5 Table Placement

```javascript
const TABLE_Z = -(TABLE.radius + 0.42);
villa.group.position.z = TABLE_Z;
```

`TABLE.radius` comes from `villa.js`; adding a flat 0.42m puts the *near edge* of the table roughly at arm's length from the seated eye position at the origin. Everything downstream — UI panel placement, keyboard position, avatar seat radius — is expressed relative to `TABLE_Z` or `TABLE.radius`, so moving the table only requires changing this one constant.

---

## 3. The Panel System (`paint.js`)

Every piece of readable UI in the game — status text, word card, activity log, nameplates, speech bubbles, vote buttons, the keyboard face — is a `Panel`: a flat `THREE.PlaneGeometry` textured with a `THREE.CanvasTexture` that's repainted by drawing directly into a 2D canvas context.

### 3.1 Why Canvas Textures Instead of a Text-Rendering Library

There is no `TextGeometry`, no loaded font glyphs, no `troika-three-text` or similar. Every character on every panel is drawn with the browser's native `CanvasRenderingContext2D.fillText`, using system font stacks (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`). This means:

- **Zero asset loading.** No `.woff` files to fetch, no FOUT/FOIT to handle, no font-loading race conditions before first paint.
- **Native text shaping and kerning** for every language the browser itself supports, for free — including RTL and CJK if a player's name uses them, since `fillText` goes through the OS text stack.
- **A single draw call per panel.** The panel is one plane, one texture, one material; the browser does the layout work once, at paint time, not once per frame.

The cost is that panels are **flat billboards with baked-in text**, not 3D typography, and they must be explicitly repainted (`redraw()`) whenever their content changes — there's no automatic re-layout.

### 3.2 The `Panel` Class

```javascript
export class Panel {
  constructor({ width, height, ppm = 900, depthTest = true, opacity = 1 }) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.max(2, Math.round(width * ppm));
    this.canvas.height = Math.max(2, Math.round(height * ppm));
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity,
      depthTest,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), this.material);
    this.mesh.userData.panel = this;
  }
  // ...
}
```

Line by line:

- **`width`/`height` in metres, `ppm` (pixels per metre) sets the canvas resolution.** A 0.62m × 0.19m status panel at `ppm: 1100` produces a 682×209px canvas — enough resolution to read cleanly from a seated distance in a headset, without wasting texture memory on a panel that's a small fraction of the view.
- **`generateMipmaps = false` + `minFilter = LinearFilter`.** Mipmaps assume a texture will be viewed at many distances and pre-shrink it for each; UI panels here are always viewed roughly head-on at a fixed range of distances, and skipping mipmap generation saves both the generation cost (paid on every `needsUpdate`) and the memory (mipmap chains are ~33% more texture memory). Plain bilinear filtering (`LinearFilter`) is sufficient at these text sizes.
- **`MeshBasicMaterial`, not `MeshStandardMaterial`.** Basic materials are unlit — they show the texture's colors exactly as painted, unaffected by scene lighting. A panel that dims because it drifted into a shadow is a panel you can't read; since every panel here carries information the player needs, none of them may be subject to lighting.
- **`transparent: true`** so canvas alpha (rounded corners, semi-transparent card backgrounds) composites correctly against whatever is behind the panel.
- **`side: THREE.DoubleSide`** — panels can be approached from either side (e.g., walking around the table in theory, or a panel rotated to face a specific seat), and a single-sided plane would vanish from the back.
- **`toneMapped: false`** — UI text and panel colors are chosen directly for correct on-screen appearance; running them through the scene's ACES tone-mapping curve (tuned for the *lit environment*, not flat UI colors) would shift their hue and contrast unpredictably.
- **`this.mesh.userData.panel = this`** — a back-reference from the Three.js mesh to the owning `Panel` instance, so raycast hit results (which only carry the mesh) can look up which panel/button was hit.

### 3.3 Repainting

```javascript
redraw(fn) {
  const { ctx, canvas } = this;
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  fn(ctx, canvas.width, canvas.height);
  ctx.restore();
  this.texture.needsUpdate = true;
  return this;
}
```

`redraw()` takes a callback, clears the canvas, lets the callback draw whatever it wants using the full 2D canvas API, then sets `texture.needsUpdate = true`. That flag is what tells Three.js to re-upload the canvas's pixel data to the GPU on the *next* frame it's rendered — it is not re-uploaded every frame regardless of whether `redraw` was called, which is the key performance property: a panel that hasn't changed since last frame costs nothing beyond the draw call.

Every panel in the codebase follows the same call pattern: mutate some piece of state, then explicitly call the panel's own paint method (`paintStatus()`, `paintWordCard()`, `_paintNameplate()`, etc.), which internally calls `redraw()`. There is no framework-level "dirty" tracking — each call site is responsible for knowing when its panel's *displayed* content differs from its state and re-invoking paint only then.

### 3.4 Shared Drawing Helpers

```javascript
export function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
```

Canvas's native `roundRect()` method isn't universally available across every headset/mobile browser this needs to run in, so it's hand-rolled with four `arcTo()` calls forming the path, clamped so the radius never exceeds half the shorter side (which would otherwise self-intersect on very small or very thin panels).

```javascript
export function fitText(ctx, text, maxWidth, startPx, weight = 600, minPx = 10) {
  let size = startPx;
  for (;;) {
    ctx.font = `${weight} ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth || size <= minPx) return size;
    size -= Math.max(1, Math.round(size * 0.06));
  }
}
```

A binary-search-free shrink loop: start at the desired size, measure, and if it overflows, reduce by 6% (rounded to at least 1px) and try again, stopping once it fits or hits a 10px floor. This is what keeps a long player name or an unusually long word from overrunning its card — instead of truncating with an ellipsis (losing information the player needs, like the full text of a hint), the text shrinks to fit. The 6%-per-step geometric shrink converges in a handful of iterations even for very long strings, and each iteration is a cheap `measureText` call, not a full layout pass.

```javascript
export function wrapLines(ctx, text, maxWidth) { /* greedy word wrap */ }
```

A standard greedy word-wrap: accumulate words onto the current line until adding the next one would overflow `maxWidth`, then start a new line. Used for multi-line body text (the word card's description, log panel event text) where shrinking a whole paragraph to fit one line would make it unreadably small.

### 3.5 Procedural Textures

Beyond UI panels, two large-area surfaces are also canvas-generated rather than loaded as image assets:

```javascript
export function tileTexture({ tiles = 4, px = 512 } = {}) { /* ... */ }
export function plasterTexture({ px = 512 } = {}) { /* ... */ }
```

- **`tileTexture`** paints a 4×4 grid of terracotta tiles into a 512×512 canvas, with each tile's fill color randomly varied (`warm = 0.86 + Math.random() * 0.28`) to simulate uneven kiln firing, plus scattered light speckles for texture. The result is set to `RepeatWrapping` on both axes so it tiles seamlessly across the actual floor geometry, which is much larger than 4×4 tiles — the sampler repeats the pattern rather than one giant texture being stretched (which would blur badly, especially looking straight down at the floor, the most scrutinized viewing angle for a floor texture).
- **`plasterTexture`** scatters ~900 low-opacity light/dark blobs of varying radius across a solid base color to fake hand-troweled plaster variation, also `RepeatWrapping`.

Both exist so the entire villa — floor, walls, every UI surface — ships as a few kilobytes of *generation code* rather than megabytes of downloaded image assets, which matters because this client is served from the same free-tier host as the phone game.

---

## 4. World-Space UI Layout

All interactive elements are positioned as `THREE.Group`/`THREE.Mesh` objects added to a single `ui` group under the scene, at hand-placed world coordinates:

```javascript
const statusPanel = new Panel({ width: 0.62, height: 0.19, ppm: 1100 });
statusPanel.mesh.position.set(0, 1.62, TABLE_Z + 0.25);
ui.add(statusPanel.mesh);

const wordCard = new Panel({ width: 0.44, height: 0.29, ppm: 1100 });
wordCard.mesh.position.set(-0.62, 1.32, -0.98);
wordCard.mesh.rotation.set(-0.1, 0.55, 0);
ui.add(wordCard.mesh);

const logPanel = new Panel({ width: 0.5, height: 0.58, ppm: 1000 });
logPanel.mesh.position.set(0.62, 1.36, -0.98);
logPanel.mesh.rotation.set(-0.07, -0.55, 0);
ui.add(logPanel.mesh);
```

Every position/rotation here is an **angular-size decision, not a screen-layout decision**. Because these are meshes in 3D space rather than 2D screen-anchored HUD elements, what matters is how large an angle of the field of view each panel subtends from the seated eye position, not its pixel dimensions. A panel a metre wide at arm's length fills roughly 40° of view — in a headset, that's a wall you have to turn your head to read fully, not a label you glance at. Every panel size/distance pair here was chosen so the panel occupies a comfortable glance-sized angular footprint:

- **Status panel** sits centered above the table, close and small (0.62×0.19m) — read at a glance without turning the head.
- **Word card** and **log panel** are pushed out to the far side of the table (`TABLE_Z + 0.25` region is near; these are at `z: -0.98`, past the table) and angled inward (`rotation.y = ±0.55`) toward the seated position — set out over the table rather than close beside the player, and scaled up correspondingly, so their *angular* size stays readable despite being physically farther away, while avoiding occluding the faces of players seated across the table (which a near, large panel positioned to the side would do).

```javascript
const actionButton = new Button({ width: 0.3, height: 0.085, onSelect: /* ... */ });
actionButton.mesh.position.set(0, 1.14, -0.74);
actionButton.mesh.rotation.x = -0.25;

const leaveButton = new Button({ width: 0.22, height: 0.062, tone: 'quiet', onSelect: () => net.leave() });
leaveButton.mesh.position.set(0.44, 0.84, -0.64);
leaveButton.mesh.rotation.set(-0.35, -0.45, 0);
```

The **leave button** is deliberately placed low, small, and off to one side — nowhere near the vote buttons that float over players' heads on the far side of the table. This is a *safety-through-distance* decision: a "leave the table" control sharing screen space with "vote to eliminate this player" is one mis-aimed tap or ray away from accidentally walking out of a game the player meant to stay in.

### 4.1 The `Button` Class

```javascript
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
```

`Button` wraps a `Panel` and adds three pieces of state:

1. **`label`** — the button's text. `set()` only calls `paint()` (which triggers a canvas redraw) when the label actually changes, avoiding redundant repaints when `renderWorld()` is called every state update but the button text hasn't changed.
2. **`visible`** — a plain mesh visibility toggle, checked separately every call to `set()` so a button can be re-labeled and shown/hidden independently.
3. **`hovered`** — set by the raycasting system (§5.4) when a ray currently intersects this button; changes the fill/stroke colors and line weight to give visual feedback before a press is committed. `setHover()` early-returns if the hover state is unchanged, again avoiding redundant paints on every frame a ray happens to still be over the same button.

Two `tone` presets exist: `'accent'` (warm amber, used for primary actions like dealing a round) and anything else, treated as `'quiet'` (dark, low-contrast, used for secondary actions like leaving).

---

## 5. Interaction Pipeline

### 5.1 Look: Mouse/Touch Drag

```javascript
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
  look.y -= dx * 0.004;
  look.x = Math.max(-1.2, Math.min(0.9, look.x - dy * 0.004));
  if (!renderer.xr.isPresenting) camera.rotation.copy(look);
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
  if (!dragged && !renderer.xr.isPresenting) select(rayFromPointer());
});
```

This uses the unified **Pointer Events API** (`pointerdown`/`pointermove`/`pointerup`), which the browser fires identically for mouse, touch, and pen input — one code path handles a phone finger drag and a desktop mouse drag with no branching.

- **`setPointerCapture(e.pointerId)`** — once a drag starts on the canvas, all subsequent `pointermove`/`pointerup` events for that pointer are routed to the canvas even if the finger/cursor moves outside its bounds (e.g., a fast swipe that momentarily exits the viewport edge). Without capture, a drag that crosses the element boundary mid-gesture would silently stop receiving move events.
- **`look` is a `THREE.Euler` with explicit `'YXZ'` order.** Euler angle order matters: with `'YXZ'`, yaw (Y, left-right look) is applied before pitch (X, up-down look), which is the standard "look around" composition that prevents gimbal-lock artifacts from a first-person-style camera — rotating the yaw doesn't distort the pitch axis's meaning the way `'XYZ'` order would for this use case.
- **Sensitivity: `0.004` radians per pixel of drag.** This is a tuned constant — small enough that a full-screen swipe (a few hundred pixels) doesn't spin past ~90°, but responsive enough for quick glances not to feel laggy.
- **Pitch clamp: `[-1.2, 0.9]` radians** (≈ −69° to +52°). Asymmetric because a seated player looking *down* at the table needs less range than looking *up* at, say, a tall doorway or the ceiling beams — and the clamp prevents the camera from flipping past vertical, which would invert left/right controls disorientingly.
- **The 3-pixel drag threshold** (`Math.abs(dx) + Math.abs(dy) > 3`) distinguishes an intentional drag-to-look gesture from a stationary tap whose pointer coordinates jitter by a pixel or two between `pointerdown` and `pointerup` (common on touchscreens due to capacitive sensing noise, and on mice due to sub-pixel rounding). Using Manhattan distance (`|dx| + |dy|`) rather than Euclidean distance avoids a `sqrt()` call for a threshold check that doesn't need geometric precision.
- **The `!renderer.xr.isPresenting` guard on both the rotation write and the tap-select** means this entire interaction system goes fully inert the instant a VR session starts — no drag-to-look fighting with head tracking, no accidental double-selection from a stale pointer position.

### 5.2 Select: Tap-to-Press

A tap is defined as a `pointerdown` → `pointerup` pair where `dragged` never became `true`. On such a tap (and only outside VR), `select(rayFromPointer())` fires.

```javascript
function rayFromPointer() {
  raycaster.setFromCamera(pointer, camera);
  return raycaster;
}
```

`pointer` is a normalized device coordinate `THREE.Vector2` in `[-1, 1]` on both axes, updated continuously during `pointermove` (not just at tap time) — see the `pointer.set(...)` call inside the `pointermove` handler in §5.1. `raycaster.setFromCamera` builds a ray from the camera through that screen point into world space, using the camera's current projection and view matrices — this is the standard Three.js technique for converting a 2D pointer position into a 3D pick ray.

### 5.3 Hover Feedback

```javascript
canvas.addEventListener('pointermove', (e) => {
  // ... (drag handling above)
});
```

Hover state is updated as part of the render loop rather than the pointer handler directly — every animation frame (see §8), the current `pointer` position is re-cast (when not dragging and not in VR) and the resulting hit, if any, is passed to `applyHover()`:

```javascript
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
```

This does two independent things with one hit result:
1. **Keyboard key hover** — every frame, regardless of whether the hovered key changed, `keyboard.setHover(key)` is called; the `Keyboard` class itself early-returns internally if the key is unchanged (see §6.5), so this is cheap.
2. **Button hover** — tracked via `hoverButton`, a single module-level variable holding the currently-hovered `Button` instance (or `null`). When the hit's underlying button differs from the tracked one, the old button is un-hovered and the new one hovered, each triggering exactly one repaint via `setHover()`'s internal early-return guard (§4.1).

Because `hit.object.userData.button` is read directly off the raycast intersection's mesh, and `userData.button` was set at construction time (`this.panel.mesh.userData.button = this;`), there's no separate lookup table mapping meshes to buttons — the mesh *is* the key, carrying its owning object as a property.

### 5.4 Raycast Targets

```javascript
function targets() {
  const list = [];
  if (keyboard.visible) list.push(keyboard.face.mesh);
  if (actionButton.mesh.visible) list.push(actionButton.mesh);
  if (leaveButton.mesh.visible) list.push(leaveButton.mesh);
  if (worldCalibrateDot.mesh.visible) list.push(worldCalibrateDot.mesh);
  list.push(...seating.voteTargets);
  return list;
}

function pick(ray) {
  const hits = ray.intersectObjects(targets(), false);
  return hits.length ? hits[0] : null;
}
```

The pickable set is rebuilt on every raycast call (every frame, for hover, plus once per tap/select) rather than maintained as a persistent list with add/remove calls — this is a deliberate simplicity trade-off: `targets()` is a handful of conditional pushes plus a spread of the (typically ≤5) current vote targets, cheap enough to recompute every frame without a dirty-tracking mechanism, and it guarantees the pickable set can never drift out of sync with actual mesh visibility (since it's derived fresh from `.visible` flags every time, there's no separate "registered but hidden" state to accidentally leave stale).

`intersectObjects(targets(), false)` — the `false` disables recursive descent into children, since every target here is a single flat mesh, not a group; skipping recursion avoids Three.js walking child hierarchies that don't exist, a minor but free optimization.

### 5.5 Dispatching a Selection

```javascript
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
```

A single hit is resolved into an action by checking, in order: is it a keyboard key, is it a button, is it a vote target. This ordering is safe because the three categories of pickable mesh are mutually exclusive by construction (the keyboard face, buttons, and vote panels are always distinct meshes), so there's no ambiguity about which branch a given hit should take — each `userData` field is only ever set on the corresponding mesh type.

### 5.6 Physical Keyboard Fallback

```javascript
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
```

On desktop, typing on a real keyboard bypasses the raycast pipeline entirely and calls `keyboard.press()` directly with a synthesized key object matching the shape the world-space keyboard would produce (`{ action }` or `{ value }`). The regex `^[a-zA-Z'’-]$` allow-lists exactly the characters the in-world keyboard itself supports (letters, apostrophe, hyphen — see §6.1 for why there's no space key), so a physical keyboard can't type characters the world-space one would reject; both input paths converge on the identical `press()` call, meaning validation/behavior never needs to be duplicated between them.

The modifier-key guard (`e.metaKey || e.ctrlKey || e.altKey`) prevents intercepting OS/browser shortcuts (Cmd+R to reload, Ctrl+Shift+I for devtools, etc.) that happen to share a base key with a game key.

---

## 6. The Mid-Air Keyboard (`keyboard.js`)

### 6.1 Layout Definition

```javascript
const ROWS = [
  [..."QWERTYUIOP"].map((k) => ({ label: k, value: k.toLowerCase() })),
  [..."ASDFGHJKL"].map((k) => ({ label: k, value: k.toLowerCase() })),
  [..."ZXCVBNM"].map((k) => ({ label: k, value: k.toLowerCase() }))
    .concat([{ label: '-', value: '-' }, { label: '’', value: '’' }]),
  [
    { label: '⌫', action: 'back', span: 2, tone: 'muted' },
    { label: 'Say it', action: 'submit', span: 3, tone: 'accent' },
  ],
];
```

A standard QWERTY layout across three rows, plus a fourth row with only two functional keys: backspace and submit. **There is no space bar** — this is a deliberate rule, not an oversight: the shared game-rules module validates that a hint is exactly one word (rejecting anything containing whitespace), so a space key on this keyboard could only ever produce input the server refuses. Removing it from the keyboard removes an entire class of user error before it happens, rather than catching it after submission with an error message.

Apostrophe and hyphen are included because they're the only non-letter characters that appear inside real English words the game's word list might contain or a player might want to type as a hint.

The `span` field (used only on the bottom row) lets a key occupy a multiple of the base key width — backspace is 2 units wide, submit is 3 — sized roughly to their expected tap frequency and to make the primary action (submit) the largest, easiest target on the keyboard.

### 6.2 Single-Mesh Hit Testing

```javascript
this.face = new Panel({ width: WIDTH, height: HEIGHT, ppm: PPM });
```

The entire keyboard face — all ~30 keys — is one `Panel`, i.e. one plane, one texture, one draw call. This is a deliberate alternative to the more obvious approach of one small mesh per key:

- **One draw call instead of ~30.** Even though modern GPUs handle dozens of draw calls trivially, this keyboard needs to redraw (see §6.4) every time the hovered key changes — with per-key meshes that's still one draw call each, but with a single panel it's always exactly one, regardless of layout complexity.
- **One raycast target instead of ~30.** The raycaster only needs to test intersection against a single plane; which *key* was hit is then resolved by a 2D point-in-rectangle lookup against the UV coordinate of that single intersection (§6.3), which is far cheaper than raycasting 30 separate small meshes.
- **Restyling the whole keyboard is a canvas edit,** not thirty materials to keep visually consistent.

### 6.3 Layout Computation

```javascript
_layout() {
  const w = this.face.canvas.width;
  const h = this.face.canvas.height;
  const pad = w * 0.014;
  const gap = w * 0.009;
  const rowH = (h - pad * 2 - gap * (ROWS.length - 1)) / ROWS.length;

  this.keys = [];
  ROWS.forEach((row, r) => {
    const spans = row.reduce((sum, k) => sum + (k.span ?? 1), 0);
    const usable = w - pad * 2 - gap * (row.length - 1);
    let x = pad;
    const y = pad + r * (rowH + gap);
    for (const key of row) {
      const kw = (usable * (key.span ?? 1)) / spans;
      this.keys.push({ ...key, x, y, w: kw, h: rowH });
      x += kw + gap;
    }
  });
}
```

Computed once at construction (not per-frame): every key's pixel rectangle (`x, y, w, h` in canvas pixel space) is derived from the row/column layout and stored flat in `this.keys`, alongside a copy of that key's original `label`/`value`/`action`/`span`/`tone` fields (`{ ...key, x, y, w, h }`). Row height is uniform across all four rows (`rowH`); each row's individual key widths are proportional to their `span` relative to the row's total span count, so a span-3 key in a row summing to spans of `[2, 3]` gets 3/5 of that row's usable width.

### 6.4 Painting the Face

```javascript
_paintFace() {
  this.face.redraw((ctx, w, h) => {
    roundRect(ctx, 0, 0, w, h, w * 0.022);
    ctx.fillStyle = 'rgba(20,14,10,0.9)';
    ctx.fill();

    for (const key of this.keys) {
      const isHover = this.hovered === key;
      const accent = key.tone === 'accent';
      const muted = key.tone === 'muted';

      roundRect(ctx, key.x, key.y, key.w, key.h, key.h * 0.22);
      if (isHover) ctx.fillStyle = accent ? '#ffc247' : 'rgba(255,194,71,0.42)';
      else if (accent) ctx.fillStyle = 'rgba(255,194,71,0.82)';
      else if (muted) ctx.fillStyle = 'rgba(255,255,255,0.10)';
      else ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fill();
      // ... stroke + label
    }
  });
}
```

Every call to `_paintFace()` redraws all ~30 keys in one pass (there's no per-key incremental redraw — the whole canvas is cleared and repainted). This happens only when the hovered key changes (`setHover()`, see below) or when the keyboard is first shown — not every frame — so the cost of iterating and redrawing all 30 keys is paid only on actual hover-state transitions, typically a handful of times per second at most during active use, not 60 times per second.

Four visual states per key, chosen by simple boolean flags: hovered+accent, hovered+plain, accent (unhovered), muted, and default — each mapped to a distinct fill color, giving the submit key its own visual weight even when unhovered (translucent amber) versus the plain letter keys (near-transparent white overlay on the dark base).

### 6.5 UV-Based Hit Testing

```javascript
keyAt(intersection) {
  if (!intersection?.uv || intersection.object !== this.face.mesh) return null;
  const x = intersection.uv.x * this.face.canvas.width;
  const y = (1 - intersection.uv.y) * this.face.canvas.height;
  return this.keys.find((k) => x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h) ?? null;
}
```

This is the payoff of the single-mesh design: a Three.js raycast intersection against a `PlaneGeometry` includes a `uv` property — the texture coordinate, in `[0,1]×[0,1]`, of exactly where on the plane's surface the ray struck. Multiplying `uv.x` by the canvas's pixel width gives the horizontal pixel position directly; the vertical axis needs a flip (`1 - uv.y`) because canvas pixel `y` increases downward while UV `v` increases upward (the standard Three.js/OpenGL texture-coordinate convention) — without the flip, the top and bottom rows of keys would swap.

Once converted to canvas-pixel coordinates, finding the key is a linear scan through `this.keys` checking simple rectangle containment — no spatial index needed given ~30 keys and this being called at most once per frame (during hover) or once per select event.

```javascript
setHover(key) {
  if (this.hovered === key) return;
  this.hovered = key;
  this._paintFace();
}
```

Note `key` here is a reference to one of the objects stored in `this.keys` (returned by `keyAt`), not a re-derived value — so `this.hovered === key` is a straightforward reference-equality check, and it's what makes the "only repaint if the hovered key actually changed" guard correct and cheap.

### 6.6 Press Handling and the Display Panel

```javascript
press(key) {
  if (!key) return false;
  this.error = '';
  if (key.action === 'back') {
    this.text = this.text.slice(0, -1);
  } else if (key.action === 'submit') {
    const value = this.text.trim();
    this._paintDisplay();
    if (value && this.onSubmit) this.onSubmit(value);
    return true;
  } else if (this.text.length < this.maxLength) {
    this.text += key.value;
  }
  this._paintDisplay();
  return false;
}
```

`press()` mutates `this.text` and always ends by repainting the small display panel above the keyboard (a separate `Panel` from the key face — `this.display`), which shows the current typed text and a title/error line. The face itself is *not* repainted on every keypress — typing doesn't change which key is visually highlighted, so only the smaller display panel needs updating, keeping the more expensive 30-key face redraw reserved for hover-state changes only.

Submitting trims whitespace and, if non-empty, calls the `onSubmit` callback supplied when the keyboard was opened (see §7 — this is where `net.send({ t: 'hint', text })` or `net.send({ t: 'guess', text })` actually gets invoked). Submitting an empty string is silently ignored rather than sent to the server, avoiding a round-trip just to get a validation error back.

```javascript
reject(message) {
  this.error = message;
  this._paintDisplay();
}
```

If the server rejects a submitted hint/guess (e.g., it wasn't actually this player's turn anymore, or a stale duplicate), `reject()` displays the server's error message in place of the title, **without clearing `this.text`** — what the player typed stays in the buffer so they can see what was rejected and correct it, rather than having to retype from scratch.

### 6.7 Physical Plate

```javascript
const plate = new THREE.Mesh(
  new THREE.BoxGeometry(WIDTH + 0.04, HEIGHT + 0.04, 0.018),
  new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.6, metalness: 0.1 }),
);
plate.position.z = -0.013;
plate.castShadow = true;
```

Behind the flat canvas-textured face sits a slightly larger, slightly recessed solid box, lit normally (unlike the unlit UI panels) and shadow-casting. This is purely a visual grounding device: without it, the keyboard face would read as a decal floating in empty space; the plate gives it a few millimeters of physical thickness and a shadow, so it reads as an object sitting in the room rather than a flat sticker.

---

## 7. Game State and the Central Render Function

### 7.1 Networking Hookup

```javascript
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
```

`createNet` (in `net.js`) owns the WebSocket connection and protocol framing; `main.js` supplies callbacks reacting to the four events that can happen: joining succeeded, a new state snapshot arrived, an error occurred, or the player left. This is a one-way data flow: the server is the sole source of truth for game state, and every `onState` call **fully replaces** `state` with the server's latest snapshot (`state = next`) rather than patching it — there is no client-side prediction or optimistic local mutation of game state, only of ephemeral UI-only state like the keyboard's in-progress text buffer.

`onError` branches on whether the keyboard is currently open and the error is non-fatal: if so, the error is shown *inside the keyboard's display panel* (via `keyboard.reject`, §6.6) since that's contextually where the player is looking; otherwise it goes to the flat overlay error text (for errors that happen before/outside active play, like a bad room code).

### 7.2 `renderWorld()`: The Single Repaint Entrypoint

```javascript
function renderWorld() {
  if (!state) return;
  paintStatus();
  paintWordCard();
  paintLog();

  const canDeal = state.youCanDeal && (state.phase === 'lobby' || state.phase === 'reveal');
  actionButton.set(state.phase === 'reveal' ? 'Next round' : 'Deal the round', {
    visible: canDeal && !keyboard.visible,
  });
  leaveButton.set('Leave the table');

  const context = myTurnContext(state);
  if (context !== keyboardContext) {
    keyboardContext = context;
    if (!context) {
      keyboard.hide();
    } else if (context.startsWith('hint')) {
      keyboard.show({ title: 'Your turn — one word', maxLength: 20, onSubmit: (text) => net.send({ t: 'hint', text }) });
    } else {
      keyboard.show({ title: 'Caught. One guess at the word', maxLength: 30, onSubmit: (text) => net.send({ t: 'guess', text }) });
    }
  }
}
```

`renderWorld()` is the single function that translates "the server's latest state" into "everything drawn in the room," and it's called unconditionally on every `onState` event (i.e., every server push) — there's no separate reconciliation or diffing step; it always runs the full repaint sequence (`paintStatus`, `paintWordCard`, `paintLog`), relying on each panel's own paint function and each button's `set()` to internally skip the actual canvas work when their specific content hasn't changed (per §3.3 and §4.1).

**Keyboard open/close logic uses a derived context string, not raw state, to decide whether to re-show:**

```javascript
function myTurnContext(s) {
  const myId = net.me.playerId;
  if (s.phase === 'hint' && s.turnPlayerId === myId) return `hint:${s.round}:${s.hintPass}`;
  if (s.phase === 'guess' && s.guesserId === myId) return `guess:${s.round}`;
  return null;
}
```

This returns a string uniquely identifying "why the keyboard should be open right now" — encoding the round number and hint-pass count so that two different hint turns (even consecutive ones in the same round, e.g. after a tie forces a re-hint) produce different context strings. `renderWorld()` compares this against the *previously stored* `keyboardContext` and only calls `keyboard.show()` again if it's genuinely a new reason. This matters because `onState` fires on *every* server broadcast — including messages triggered by other players' actions that don't concern this player's turn at all — and naively calling `keyboard.show()` on every one of those would **wipe whatever the player had half-typed** each time anyone else did anything. The context-string comparison is what makes the keyboard "sticky" across irrelevant state churn while still correctly reopening for a genuinely new turn.

### 7.3 Painting the Status Panel

```javascript
function paintStatus() {
  const s = state;
  statusPanel.redraw((ctx, w, h) => {
    statusPanel.card(ctx, w, h);
    // ... branch on s.phase to build `kicker` (small label) and `line` (main text)
  });
}
```

`paintStatus` is called every `renderWorld()` invocation and always redraws unconditionally — unlike buttons/keyboard, there's no "did this actually change" guard here, because the status panel's content is a small, cheap-to-redraw text composition and the phase/turn/round information it displays changes on nearly every server push anyway, so the guard would rarely save work.

The function branches on `s.phase` (`lobby`, `hint`, `vote`, `guess`, `reveal`) to compose a short "kicker" label (e.g. `TABLE ABC1`, `ROUND 3`) and a longer status line (e.g. `Alice is thinking…`), with the line's color (`tint`) shifting to green/amber/neutral depending on outcome during the reveal phase — a quick-glance color cue on top of the text itself.

### 7.4 Word Card and the Server-Enforced Secret

```javascript
function paintWordCard() {
  const s = state;
  const playing = s.you?.playing;
  const isWhite = s.you?.role === 'mrwhite';
  wordCard.mesh.visible = Boolean(playing) || s.phase === 'reveal';
  if (!wordCard.mesh.visible) return;

  wordCard.redraw((ctx, w, h) => {
    // ...
    const text = isWhite ? 'Mr. White' : (s.word ?? '—');
    // ...
  });
}
```

The critical line is `s.word ?? '—'`: if this client's player is Mr. White, `s.word` is simply `null` — the server never includes the actual secret word in the state payload sent to Mr. White's client at all. This isn't a client-side redaction (`if (isWhite) hide the word`) that could theoretically be bypassed by reading network traffic or memory; the word is structurally absent from the data this client ever receives while playing Mr. White, so there's nothing here to leak. The `??` fallback to an em-dash is just a defensive display default, not a security boundary — the actual boundary is enforced entirely server-side, in the `viewFor`-style per-player view construction that decides what each connected client's state payload contains.

### 7.5 Activity Log

```javascript
function paintLog() {
  const s = state;
  const entries = [];
  for (const entry of s.log ?? []) {
    // map each log entry type (hint, skip, tie, eliminated, guess) to a display row
  }
  logPanel.redraw((ctx, w, h) => {
    // ...
    const rows = entries.slice(-11);
    // ...
  });
}
```

The server sends a full running log of game events (`s.log`); the client only ever displays the most recent 11 (`entries.slice(-11)`), matching the fixed number of text rows the panel's fixed pixel height was designed to fit (`step = (h * 0.8) / 11`). This is purely a display-time truncation — the full log still exists in `state.log` for as long as the server keeps sending it — chosen because a scrolling or paginated log panel would add real interaction complexity (another raycast target, another gesture) for a feature (seeing turn 1's hint during turn 9) that rarely matters to actively playing the current round.

---

## 8. The Per-Frame Loop

```javascript
renderer.setAnimationLoop(() => {
  let hit = null;
  if (renderer.xr.isPresenting) {
    for (const controller of controllers) {
      const controllerHit = pick(rayFromController(controller));
      if (controllerHit) hit = controllerHit;
    }
  } else if (!dragging && pointerActive) {
    hit = pick(rayFromPointer());
  }
  applyHover(hit);

  seating.faceCamera(camera);
  renderer.render(scene, camera);
});
```

`renderer.setAnimationLoop` is the WebXR-compatible replacement for `requestAnimationFrame` — Three.js's recommended pattern specifically because it transparently switches to being driven by the XR device's own frame-presentation timing once a session starts, rather than the browser's regular display refresh, without any code change here.

Each frame:
1. **Hover raycasting** — branches on presentation mode: in VR, every controller's forward ray is tested (last non-null hit wins, so with two controllers the second one tested takes priority if both are hovering something, which in practice rarely happens since they point in different directions); outside VR, only the pointer ray is tested, and only when not actively dragging (`!dragging`) and once the pointer has moved at least once (`pointerActive`, set on first `pointermove`) — this avoids raycasting from a phantom (0,0) pointer position before the user has ever touched the screen.
2. **Billboard orientation** — `seating.faceCamera(camera)` (§9) rotates every nameplate/hint-bubble/vote-panel to face the current camera position, every single frame, since the camera (and therefore what "facing the viewer" means) can change every frame via drag or head movement.
3. **Render** — the actual draw call.

Note this loop is deliberately thin: game-state-driven repainting happens in `renderWorld()`, triggered by network events, not here. The animation loop only handles per-frame *presentation* concerns (hover, billboarding, the draw call itself) — it never touches `state` or calls `net.send`.

---

## 9. Seating and Avatars (`seats.js`)

### 9.1 You Are Always at Angle Zero

```javascript
update(state, myId) {
  const players = state.players ?? [];
  const mine = Math.max(0, players.findIndex((p) => p.id === myId));
  const n = Math.max(players.length, 1);
  // ...
  players.forEach((player, i) => {
    const angle = ((i - mine + n) % n) / n * Math.PI * 2;
    // ...
    seat.group.position.set(
      Math.sin(angle) * (TABLE.radius + 0.3),
      0,
      Math.cos(angle) * (TABLE.radius + 0.3),
    );
    seat.group.rotation.y = angle + Math.PI; // face the middle
  });
}
```

The server's `players` array has a fixed, server-assigned order shared identically across every connected client — but each client renders that same order **rotated so its own player index maps to angle zero** (the near edge of the table, directly in front of the seated camera): `angle = ((i - mine + n) % n) / n * 2π`. This is purely a client-side presentation choice; the server has no concept of "seating position" at all, only turn order. The effect: two players physically in the same room, both looking at their own screens, each perceive themselves as sitting at the near side of the table with everyone else arranged clockwise around it — the only arrangement that feels correct from inside a first-person view, since no player's client would make sense showing them *their own avatar* front-and-center from a third-person angle.

Seats are placed on a circle of radius `TABLE.radius + 0.3` (just outside the table's own edge) at `y = 0` (floor level, with individual avatar parts positioned upward from there — see §9.2), and each seat's `rotation.y = angle + Math.PI` turns the avatar to face the table's center (a plain `angle` would face outward, away from the table).

### 9.2 Avatars Without Pose Data

```javascript
function makeAvatar(colour) {
  const group = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.3, 6, 16), cloth);
  torso.position.y = 0.78;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 20, 16), skin);
  head.position.y = 1.09;
  for (const x of [-0.2, 0.2]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.2, 4, 10), cloth);
    arm.position.set(x, 0.8, 0.06);
    arm.rotation.set(-0.5, 0, x > 0 ? -0.25 : 0.25);
  }
  return group;
}
```

Every player is represented by a static, low-poly capsule torso, sphere head, and two fixed-pose stub arms (angled downward and inward as if resting on the table edge) — no skeletal rig, no animation. This directly reflects what data actually exists to render: the game protocol carries no body-tracking or pose information for any player (there's no hand-tracking input from a phone or desktop client the way a VR headset might theoretically provide), so any attempt at a more articulated or animated avatar would just be fabricating motion nobody actually made. A static, clearly-abstract "person shape" reads honestly as a placeholder for a real person, without implying tracked fidelity that isn't there.

**A stable per-player color derived from a hash of their ID:**

```javascript
function colourFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hue = (hash % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.42, 0.52);
}
```

A simple polynomial rolling hash (multiply-by-31, the classic `String.hashCode`-style accumulator) over the player's ID string, reduced mod 360 to a hue angle, with fixed saturation (0.42) and lightness (0.52) so every player's color reads as similarly muted/pastel regardless of which hue they land on — no player's color is more saturated or attention-grabbing than another's purely by chance. Because it's a pure function of the player's stable server-assigned ID (not, say, join order or a random roll at connect time), every client computes the *same* color for the *same* player independently, with no need to transmit color assignments over the network at all.

**You never see your own body:**

```javascript
seat.avatar.visible = !isMe;
```

With no tracked limbs, a first-person view of your own avatar would only ever be a static mannequin floating where your head is — worse than useless, since it would visually intrude on your own view without conveying any real information (you already know where you are). Skipping your own avatar entirely, while still rendering your own *seat position* (so others see you sitting there) and reasoning about your own turn state normally, avoids that.

### 9.3 Per-Player Status Panels

Each seat gets three additional panels, all created once per seat and repainted as needed:

- **`nameplate`** — name, score, and (once the server has made it public) role label. Hidden for the local player (`seat.nameplate.mesh.visible = !isMe`) for the same reason avatars are hidden: at a first-person field of view, your own nameplate positioned over your own head would fill the top of your vision like an obstruction, and you already know your own name.
- **`hint`** — a speech-bubble-styled panel showing the player's most recent hint, or the word "voted" during the vote phase if they've voted but given no hint that round. Only shown once a player has actually said or done something (`if (isMe || (!last && !voted)) { hide; return; }`).
- **`vote`** — a tappable panel over the player's head, shown only during the vote phase, only for players other than the local player, and only if both the target and the local player are still alive and playing:

```javascript
_paintVote(seat, player, state, isMe) {
  const canVote = state.phase === 'vote'
    && !isMe
    && player.playing && player.alive
    && state.you?.playing && state.you?.alive;
  seat.vote.mesh.visible = canVote;
  if (!canVote) return;
  this.voteTargets.push(seat.vote.mesh);
  // ...
}
```

Critically, `this.voteTargets` — the array `main.js`'s `targets()` function spreads into the raycast pickable list (§5.4) — is **rebuilt from scratch inside `update()`, called fresh on every server state push**, not incrementally maintained. This means the set of who can currently be voted for is always exactly derived from the latest server state's eligibility rules, with no possibility of a stale vote target lingering after, say, a player is eliminated or the phase changes.

### 9.4 Presence and Elimination Visuals

```javascript
const out = player.playing && !player.alive;
const away = !player.connected;
seat.avatar.position.y = out ? -0.12 : 0;
seat.avatar.rotation.z = out ? 0.12 : 0;
for (const part of Object.values(seat.avatar.userData.parts)) {
  part.material.opacity = away ? 0.45 : 1;
  part.material.transparent = away;
}
```

Two independent visual states, both purely derived from server-sent booleans:
- **Eliminated** (`out`): the avatar sinks slightly (`y = -0.12`) and tilts (`rotation.z = 0.12`), a small "slumped" pose read at a glance without needing to check the nameplate text.
- **Disconnected** (`away`): the avatar's torso/head materials become 45% opaque, requiring `transparent = true` to be set at the same time (a `MeshStandardMaterial` ignores `opacity` unless `transparent` is explicitly enabled) — a disconnected player fades rather than vanishing outright, so their seat position is still visible (they may reconnect) but visually distinct from an actively present player.

### 9.5 Billboarding

```javascript
faceCamera(camera) {
  for (const mesh of this.billboards) {
    if (mesh.visible) mesh.lookAt(camera.getWorldPosition(_look));
  }
}
```

Called every animation-loop frame (§8), this rotates every registered floating panel (nameplates, hint bubbles, vote buttons — pushed into `this.billboards` at seat-creation time) to face the camera's *current* world position via `Object3D.lookAt`. Only visible meshes are rotated (`if (mesh.visible)`) — a cheap skip for hidden panels, and importantly this correctly re-orients every panel continuously as the camera moves (via mouse-drag look, or head tracking in VR), so a nameplate always reads face-on to the viewer regardless of viewing angle, rather than being a flat plane you'd see edge-on from the side.

---

## 10. Room Geometry (`villa.js`)

While the room's furniture and architecture aren't UI, two aspects directly affect how the 3D-mode client behaves:

- **`TABLE.radius`** is the shared constant that `main.js` (`TABLE_Z`), `seats.js` (seat placement radius), and the room layout all derive their spacing from — a single source of truth for "how big is the table," so changing table size doesn't require touching UI panel positions individually.
- **`villa.setSeatCount(seatCount)`**, called from `onState` whenever the number of connected players changes, presumably regenerates or repositions the physical chairs/table geometry to match — keeping the *physical room* (chair count around the table) consistent with the *logical* player roster, independent of the `Seating` class's own avatar/panel management, which is a separate concern layered on top.

---

## 11. Networking Contract (`net.js`)

`createNet` is treated by `main.js` as a black box exposing:

- **`net.create(name)` / `net.join(code, name)`** — called from the entry-screen buttons to start or join a table.
- **`net.send(message)`** — a generic outbound message (`{ t: 'start' }`, `{ t: 'vote', targetId }`, `{ t: 'hint', text }`, `{ t: 'guess', text }`), where `t` is the message type discriminator the server-side protocol switches on.
- **`net.leave()`** — called from the leave button.
- **`net.me.playerId`** — this client's assigned player ID, used throughout `main.js` and `seats.js` to distinguish "me" from other players (`isMe`, `myTurnContext`, seat-angle-zero calculation).
- **Five callbacks supplied at construction** (`onJoined`, `onState`, `onError`, `onLeft`, `onConnection`) — the entire surface through which server-driven events reach the rendering/UI layer.

`main.js` never touches WebSocket internals, reconnection logic, or message framing directly — that's entirely `net.js`'s responsibility, keeping the rendering code free of transport concerns and making it trivial to reason about the render layer as a pure function of "whatever state `onState` last delivered."

---

## 12. File Map

```
public/vr/
├── main.js       Scene bootstrap, camera, all input handling, render loop,
│                 game-state → UI translation, WebXR session setup
├── villa.js       Room geometry (walls, floor, table, chairs), TABLE constant
├── seats.js       Per-player seating layout, avatars, nameplates,
│                 hint bubbles, vote targets, billboarding
├── keyboard.js    Mid-air text entry: single-mesh keyboard, UV hit-testing,
│                 display panel, physical-keyboard-equivalent press() API
├── paint.js       Panel/Button base classes, canvas drawing helpers
│                 (roundRect, fitText, wrapLines), procedural textures
├── net.js         WebSocket transport and protocol framing
└── index.html     (served via public/vr.html) entry overlay markup
public/vr.html     Page shell: stylesheet link, no-JS fallback, script tag
public/styles.css  Entry-screen form, HUD elements, badges, toasts
```

---

## 13. Key Design Decisions, Summarized

1. **One scene serves both 3D mode and VR.** A single boolean (`renderer.xr.isPresenting`) branches camera control and a couple of cosmetic values; there is no parallel "3D-only" scene graph to keep in sync.

2. **World-space meshes, not HTML, for all game UI.** Every panel is a Three.js mesh with a canvas texture, so the identical code renders correctly whether presented flat on a screen or in WebXR stereo — HTML overlays don't appear inside a stereo XR presentation at all, which is why the interactive game UI can't live in the DOM.

3. **Canvas textures instead of any 3D text/font pipeline.** Zero asset loading, native text shaping for any language, one draw call per panel — at the cost of text being a flat baked bitmap that must be explicitly repainted, not live 3D typography.

4. **Unlit materials for every UI panel.** `MeshBasicMaterial` guarantees a panel's text is exactly as legible in a dim corner of the room as directly under the light — critical because every panel carries information the player actually needs to read.

5. **Explicit dirty-tracking at the call-site level, not a framework.** Every `set()`/`setHover()`/`redraw()` call is individually responsible for skipping redundant canvas work when content hasn't actually changed; there's no reactive/virtual-DOM-style batching layer — appropriate given the total UI surface is small and hand-authored.

6. **A single mesh per composite UI element (the keyboard, each panel) rather than one mesh per sub-element (each key).** Trades a slightly more involved hit-testing step (UV-to-pixel-to-rectangle lookup) for drastically fewer draw calls and raycast targets.

7. **Seating computed relative to the local player, never trusting a server-assigned visual position.** The server only knows turn order; "who sits where, visually, from my point of view" is entirely a client-side derivation, recomputed identically and independently by every connected client from the same shared player-order data.

8. **The word itself is a server-side secret, not a client-side redaction.** Mr. White's client literally never receives the word in its state payload — there's no `if (isMrWhite) hideWord()` branch that could be a first line of defense with a server bug behind it; the boundary is structural, not presentational.
