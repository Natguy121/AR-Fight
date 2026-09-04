# 3D Mode Implementation

## Architecture Overview

3D mode is an alternative client to the WebXR/VR renderer. Both share the same scene, game state, networking protocol, and most UI panels — the difference is in how input is handled and how the camera behaves.

**Shared:**
- Three.js scene, villa, seating, panels, buttons
- WebSocket protocol and server-side game state
- World-locked UI panels (status, word card, log)
- Gamepad calibration and controller input

**Different:**
- **Camera:** Fixed at seated eye height (1.15m), no head tracking
- **Input:** Mouse drag (look) + pointer tap (select), gamepad triggers
- **UI overlay:** HTML menu visible; world-space small "⋮" button for VR
- **View mode:** Switches based on `renderer.xr.isPresenting`

---

## Scene and Camera Setup

### Fixed Eye Position

```javascript
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 60);
camera.position.set(0, 1.15, 0); // seated eye height, used outside VR only
```

- **70° FOV** balances immersion with performance
- **1.15m height** is seated eye level (not standing, not lying down)
- **Used only when `!renderer.xr.isPresenting`** — VR mode ignores this and uses the headset's head pose

### Aspect Ratio and Resize

```javascript
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', resize);
```

Handles landscape/portrait, full-screen/windowed, any device size.

### Table Positioning

```javascript
const TABLE_Z = -(TABLE.radius + 0.42); // ~0.92m away
villa.group.position.z = TABLE_Z;
```

The table sits at arm's reach in front of the seated player, so leaning in to read works naturally. This distance matches the physical ergonomics of a seated player.

---

## World-Space UI System

All interactive panels are Three.js meshes, not HTML overlays. This allows them to:
- Render correctly in both 3D mode and VR stereo
- Stay world-locked (don't move with the head)
- Be raycast-picked by both pointer and controller

### Panel Construction

Each panel is a flat `PlaneGeometry` with a canvas texture:

```javascript
const statusPanel = new Panel({ width: 0.62, height: 0.19, ppm: 1100 });
statusPanel.mesh.position.set(0, 1.62, TABLE_Z + 0.25);
ui.add(statusPanel.mesh);
```

**Key fields:**
- `width`, `height` — metres (physical size in the room)
- `ppm` — pixels per metre (canvas resolution for text sharpness)
- `position` — world coordinates
- `rotation` — angle away from the viewer

Positions are chosen to be readable from seated eye level without requiring the player to crane their neck, and positioned past the far edge of the table so they don't occlude faces.

### Button Rendering

Buttons are a subclass of panels with state (label, hover):

```javascript
class Button {
  constructor({ width, height, onSelect, tone = 'accent' }) {
    this.panel = new Panel({ width, height, ppm: 1000 });
    this.onSelect = onSelect;
    this.label = '';
  }

  paint() {
    this.panel.redraw((ctx, w, h) => {
      // Canvas drawing: rounded rect, fill, stroke, text
      roundRect(ctx, 3, 3, w - 6, h - 6, h * 0.3);
      ctx.fillStyle = this.hovered ? '#ffd76e' : 'rgba(255,194,71,0.9)';
      ctx.fill();
      // ... text rendering
    });
  }
}
```

The button's canvas is redrawn when the label or hover state changes. No DOM, no CSS — all canvas.

---

## Input Handling

### Mouse Look

Drag updates camera rotation in a fixed Euler order:

```javascript
const look = new THREE.Euler(0, 0, 0, 'YXZ'); // Yaw (look left/right), Pitch (look up/down), no Roll

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  if (Math.abs(dx) + Math.abs(dy) > 3) dragged = true;
  look.y -= dx * 0.004;
  look.x = Math.max(-1.2, Math.min(0.9, look.x - dy * 0.004));
  if (!renderer.xr.isPresenting) camera.rotation.copy(look);
});
```

- **Y axis** — horizontal rotation (look side to side)
- **X axis** — vertical rotation (look up and down), clamped to ±~70°
- **Damping:** 0.004 radians per pixel feels natural
- **3-pixel threshold:** Tiny movements don't count as drags, so taps register

### Pointer Selection

Tap (pointerdown + pointerup with minimal drag) triggers a raycast:

```javascript
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  if (!dragged && !renderer.xr.isPresenting) {
    select(rayFromPointer());
  }
});
```

Only processes if:
- `!dragged` — the pointer barely moved (< 3px)
- `!renderer.xr.isPresenting` — not in VR (VR uses controller selectstart)

### Raycasting

Two ray sources: pointer and controller.

**From pointer (3D mode):**

```javascript
function rayFromPointer() {
  raycaster.setFromCamera(pointer, camera);
  return raycaster;
}
```

Takes the 2D screen position and projects it through the camera into world space.

**From controller (VR mode):**

```javascript
function rayFromController(controller) {
  const matrix = new THREE.Matrix4().identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(matrix);
  return raycaster;
}
```

Extracts the controller's position and forward direction, transforms the default ray to match.

### Raycast Targets

Only certain meshes can be picked:

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
```

This controls which elements can be selected, allowing UI to hide/show by toggling `.visible`.

---

## Gamepad Integration

### Polling Loop

Gamepad state is polled every frame (Gamepad API requires polling; there's no event for button changes):

```javascript
function checkGamepadInput() {
  const gamepads = navigator.getGamepads?.() ?? [];
  for (const gamepad of gamepads) {
    if (!gamepad) continue;
    // Check right trigger
    const rightTrigger = rightTriggerValue(gamepad);
    if (rightTrigger > 0.5 && lastRightTrigger <= 0.5) {
      if (renderer.xr.isPresenting && controllers.length > 0) {
        select(rayFromController(controllers[0])); // VR: use controller ray
      } else if (pointerActive) {
        select(rayFromPointer()); // 3D: use center screen
      }
    }
    lastRightTrigger = rightTrigger;

    // Check any button for calibration
    const anyButton = gamepad.buttons.some((b) => b.pressed || b.value > 0.5);
    if (anyButton && !lastAnyGamepadButton) {
      completeCalibration('Calibrated — that button presses in VR');
    }
    lastAnyGamepadButton = anyButton;
  }
}

renderer.setAnimationLoop(() => {
  checkGamepadInput();
  // ... rest of frame
});
```

### Right Trigger Detection

W3C Standard Gamepad maps the right trigger to `buttons[7]` (not `axes[5]`). However, some non-standard-mapped controllers expose it as `axes[5]`. The fallback handles both:

```javascript
function rightTriggerValue(gamepad) {
  const button = gamepad.buttons[7];
  if (button) return button.value ?? (button.pressed ? 1 : 0);
  return gamepad.axes[5] ?? 0;
}
```

Checks the standard location first, falls back to the axis convention.

### Button Detection

Some non-standard controllers leave `.pressed` false while reporting a nonzero `.value`:

```javascript
const anyButton = gamepad.buttons.some((b) => b.pressed || b.value > 0.5);
```

Checks both conditions to catch real presses.

### Behavior

- **Right trigger press** (0.5 threshold):
  - **In VR:** Uses first controller's ray direction to select
  - **In 3D mode:** Uses center screen raycast
- **Any button press:** Triggers calibration confirmation

---

## Calibration System

### Starting Calibration

```javascript
function startGamepadCalibration(gamepad) {
  calibrating = true;
  const name = gamepad ? ` (${gamepad.id}, ${gamepad.mapping || 'non-standard'} mapping)` : '';
  showGamepadToast(`Press the screen, a gamepad button, or a VR trigger to calibrate${name}`);
}

window.addEventListener('gamepadconnected', (e) => {
  startGamepadCalibration(e.gamepad);
});
```

When a gamepad connects, calibration starts automatically and shows the controller's ID and mapping type in the toast.

### Completing Calibration

Any input path can complete calibration:

```javascript
function completeCalibration(message) {
  if (!calibrating) return;
  calibrating = false;
  showGamepadToast(message);
  setTimeout(() => { gamepadToast.hidden = true; }, 2000);
}

// Screen tap
canvas.addEventListener('pointerdown', (e) => {
  completeCalibration('Calibrated — the screen presses in VR');
  // ...
});

// Gamepad button (in checkGamepadInput)
if (anyButton && !lastAnyGamepadButton) {
  completeCalibration('Calibrated — that button presses in VR');
}

// VR controller trigger
controller.addEventListener('selectstart', () => {
  completeCalibration('Calibrated — that trigger presses in VR');
});

// Menu item
$('menu-calibrate').addEventListener('click', (e) => {
  startGamepadCalibration();
});
```

The message varies to tell the player which input completed calibration.

---

## View Mode Switching

The core difference between 3D mode and VR is triggered by `renderer.xr.isPresenting`:

```javascript
function updateViewMode() {
  const inHeadset = renderer.xr.isPresenting;
  modeBadge.hidden = inHeadset;
  const opacity = inHeadset ? 1 : 0.6;
  const scale = inHeadset ? 1 : 1.3;
  for (const button of [actionButton, leaveButton]) {
    button.panel.material.opacity = opacity;
    button.mesh.scale.setScalar(scale);
  }
  if (state) renderWorld();
}

renderer.xr.addEventListener('sessionstart', updateViewMode);
renderer.xr.addEventListener('sessionend', updateViewMode);
```

When entering/exiting VR:
- **Hide the "3D mode" badge** (only visible in 3D)
- **Increase button opacity** (100% in VR, 60% in 3D for visibility)
- **Scale buttons up 30%** in 3D mode (easier to tap with a finger)
- **Redraw the world** to reflect new state

The `worldCalibrateDot` (small "⋮" button) only shows in VR:

```javascript
worldCalibrateDot.set('⋮', { visible: renderer.xr.isPresenting });
```

### Camera Behavior

- **In 3D mode:** Uses `camera` (fixed at seated height) with rotation from mouse drag
- **In VR mode:** `renderer.xr.enabled = true` means the XR session controls the camera; the JavaScript-set position/rotation is ignored

---

## HTML Overlay (HUD Menu)

The three-dot menu is an HTML overlay, not a world-space panel:

```html
<div id="hud" hidden>
  <button id="hud-dots" class="hud-dots" aria-haspopup="true">⋮</button>
  <div id="hud-menu-list" class="hud-menu-list" hidden>
    <button id="menu-calibrate" class="hud-menu-item">Calibrate controller</button>
  </div>
</div>
```

**Why two "⋮" buttons?**

- **HTML overlay (hud-dots):** Flat, 2D, always visible on 3D mode, never in VR stereo presentation
- **World-space (worldCalibrateDot):** 3D mesh, visible in VR, invisible in 3D mode

In VR, HTML overlays don't appear because WebXR only presents the canvas in stereo. So the world-space button is the only way to access calibration without removing the headset.

---

## Network and Game State

### Session Initialization

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

When joined, the overlay hides and the HUD appears. Each state update triggers a re-render of all panels.

### Rendering the World

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
  worldCalibrateDot.set('⋮', { visible: renderer.xr.isPresenting });

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
}
```

This is called on every state update and on enter/exit VR. It repaints panels, updates button labels and visibility, and shows/hides the keyboard.

---

## Performance Considerations

### Canvas Texture Updates

Panels only redraw when their content changes, not every frame:

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

`this.texture.needsUpdate = true` signals that the texture needs to be re-uploaded to the GPU, but only once.

### Raycast Optimization

Only visible meshes are raycast targets:

```javascript
function targets() {
  const list = [];
  if (keyboard.visible) list.push(keyboard.face.mesh);
  if (actionButton.mesh.visible) list.push(actionButton.mesh);
  // ...
}
```

This prevents picking through hidden UI and keeps the raycast cheap.

### Gamepad Polling

Polling happens every frame, but state changes are only processed on transitions:

```javascript
if (rightTrigger > 0.5 && lastRightTrigger <= 0.5) {
  // Only on the frame it crosses 0.5 threshold
}
```

---

## File Structure

```
public/vr/
├── main.js            # Scene, camera, input, gamepad, calibration
├── villa.js           # Room geometry and lighting
├── seats.js           # Player positioning and vote targets
├── keyboard.js        # Mid-air text entry UI
├── paint.js           # Canvas-based panels and styling
├── net.js             # WebSocket and game state protocol
└── index.html         # Entry overlay
public/vr.html         # Wrapper page (stylesheet, no-JS fallback)
public/styles.css      # HUD menu, badges, toasts, entry form
```

---

## Key Design Decisions

1. **World-space UI over HTML overlays:** Panels are Three.js meshes so they render correctly in stereo and can be raycast. Only the HUD menu is HTML.

2. **Canvas textures over DOM:** No text-rendering pipeline, no font loading, no layout engine. Canvas gives direct control and avoids web complexity.

3. **Single camera for both modes:** The same camera is used; VR overrides it. This keeps the code simpler and is standard Three.js + WebXR practice.

4. **Gamepad input triggered calibration, not required it:** Calibration is automatic and optional—players can play with keyboard/mouse alone.

5. **Right trigger uses pointer raycast in 3D mode:** In 3D mode, the trigger can't aim (no hand pose), so it uses center-screen raycasting instead, letting players select without looking at the screen.

6. **Button scaling and opacity for phone usability:** Buttons become 30% larger and 60% opaque in 3D mode so they're easier to tap and don't completely hide the room.

7. **Separate calibration button in both contexts:** HTML menu for 3D mode (always visible), world-space button for VR (no headset removal needed).

---

## Testing

Smoke tests drive the entire flow without a headset:

```javascript
// tools/vr-smoke.js
window.__vr = {
  camera,
  renderer,
  keyboard,
  seating,
  get state() { return state; },
  project(point) { /* world to screen */ },
  keyScreenPosition(label) { /* keyboard key screen position */ },
  meshScreenPosition(mesh) { /* UI mesh screen position */ },
  actionButton,
  voteTargets: () => seating.voteTargets,
};
```

The test harness can get screen coordinates of any world element and drive pointer events, allowing end-to-end testing without a headset.

---

## Future Work

- **Touch gestures:** Pinch to zoom, two-finger drag to rotate vertically faster
- **Mobile VR trigger detection:** Auto-detect Cardboard magnet swipes
- **Performance profiling:** Optimize for slower mobile devices
- **Accessibility:** Keyboard-only navigation, screen reader support
