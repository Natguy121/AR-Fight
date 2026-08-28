# Remade

Look at your room through your phone and watch it become somewhere else. Not
tinted — *remade*. The app works out what each thing in front of you actually
is, and gives each one its own answer: the TV becomes a whiteboard, the sofa
a gaming couch, the chair charred wood, the walls bare plaster. Nothing moves.
Every object keeps its own shape, its own shading and its own place, so you can
still reach out and pick it up. It just isn't made of what it was.

Runs in a mobile browser. Slot the phone into a Cardboard-style shell and it
becomes a passthrough headset: the rear camera is rendered side-by-side in
stereo with lens distortion correction.

No app store, no build step, no accounts. Serve the folder and open it.

---

## The idea

Almost everything you know about an object's three-dimensional form comes from
**shading** — how brightness falls across it — and almost none of it from
colour. A white mug and a black mug are equally easy to pick up.

So the camera frame is split into two parts:

| | | |
| --- | --- | --- |
| **Structure** | luminance, gradients, edges | kept exactly |
| **Appearance** | hue, texture, gloss | replaced entirely |

That split is the whole trick. Because no pixel ever moves and every shading
gradient survives, the mug stays the same size, in the same place, with the
same curvature — your hand goes where your eyes say it will. Only its
substance changes.

### Why it needs to know what things are

Apply one material to the whole view and you have made a colour filter. The
room goes green; nothing has become anything. What makes it a *place* is that
different things get different answers — and that needs the app to know which
pixels are the sofa.

So a segmentation model (DeepLab-v3) labels each pixel as one of 21 things:
chair, sofa, tv, dining table, potted plant, person, and so on. Each theme
then carries a material per object on top of a base material for everything
unrecognised, and the shader picks per pixel.

The clearest example of what this buys is the whiteboard. A TV is a dark
rectangle full of detail. Give it a near-white ramp with a very strong dark
edge pass and its own picture is redrawn as marker strokes on a white board.
Nothing is pasted over it — the screen's actual content *becomes* the
scribble, so it lines up perfectly and changes when the picture does.

Two things keep this affordable. Segmentation runs on a throttle (~5Hz), not
per frame: rooms hold still, and re-labelling at 60Hz would spend the frame
budget confirming the sofa is still a sofa. And the repaint itself is still a
single per-pixel pass — the mask is just one more texture it reads. If the
model cannot load, every object falls back to the base material and you get
the whole-room version of the effect, which is exactly what this was before.

## Using it

| Control | What it does |
| --- | --- |
| **Transform** | The room is remade, each recognised thing as its own material. |
| **Change** | Somewhere else. |
| **Off** | Back to the untouched camera view. |
| **Lenses** | Nudge IPD and lens offset until the two eye images fuse. Saved. |

Press buttons by looking at one and pinching, by holding your gaze on it, or —
if you're holding the phone rather than wearing it — with the ✦ button in the
corner.

**It only changes when you ask it to.** Look away, turn all the way around,
come back tomorrow: the room is exactly as you left it. That is deliberate and
load-bearing — a world that re-rolled its appearance as you looked around
would read as a screensaver rather than a place, and would be unusable in a
headset. Selection happens on an explicit press and nowhere else, and the
choice is written to storage so it survives a reload.

## Letting Claude choose

Out of the box the app picks from five hand-authored worlds. Connect a Claude
API key and it instead **looks at your actual room** through the camera and
invents one for it — deciding both the world and what each thing it can see
becomes in that world, rather than choosing from a list.

A theme is just a small bundle of numbers: per object, a four-stop colour
ramp, how much real colour to keep, a surface texture, edge and sheen
treatment. That is what makes this work — the renderer cannot tell a
Claude-authored theme from a built-in one, and both go through exactly the
same validation, so an invented world is as safe to render as a shipped one.

```sh
npm install @anthropic-ai/sdk zod   # not installed by default
export ANTHROPIC_API_KEY=sk-ant-... # or use `ant auth login`
npm run relay
```

Then open the app with `?relay=https://<your-host>:8788/style`. The setting is
remembered, so you only type it once.

**Why a relay and not just a key in the app?** An API key is a bearer
credential — anything shipped to the browser is readable by anyone who opens
the page. On static hosting there is nowhere to hide a secret, so a key
embedded in the app is a key given away, and the bill is yours. The relay
holds it server-side and is the only setup safe to share a link to.

There is a `?key=` option that stores a key in your own device's localStorage
and calls Anthropic directly. It's there for trying this out on your own phone
before standing up a server. Don't hand that link to anyone.

Two things that will waste an evening if you hit them cold:

- **Serve the relay over HTTPS if the page is on HTTPS.** A browser refuses to
  let an HTTPS page call a plain HTTP endpoint, and the request dies as mixed
  content before it leaves the phone. `npm run relay` reuses the dev server's
  certificate automatically — run `npm start` once to generate it.
- **Nothing leaves your device unless you connect Claude yourself.** With no
  relay and no key, no frame is ever uploaded.

## Running it

The camera only works on a secure origin, and `localhost` does not help when
the phone is a different device — so the dev server speaks HTTPS with a
self-signed certificate.

```sh
git clone https://github.com/Natguy121/AR-Fight
cd AR-Fight
npm start
```

It prints a LAN URL. Open that on the phone, accept the certificate warning
once (Advanced → Proceed), and allow the camera and motion sensors.

### Object recognition needs a model

The segmentation and hand-tracking models are large, so they are not in the
repo. Fetch them once:

```sh
npm run fetch-deps   # ~28 MB, into vendor/ and models/ (both gitignored)
```

The app finds them automatically at boot and then runs with no network access
at all. Skip this and it falls back to public CDN copies; if those are
unreachable too, the room is still remade — just uniformly, since without the
model it cannot tell the sofa from the wall.

### If the camera view looks wrong

Two buttons in the corner fix the two things that actually go wrong, and they
are separate on purpose:

- **`0°`** rotates the camera image 90° per tap. Some browsers capture the
  stream once, in whatever orientation the phone had when permission was
  granted, and keep delivering it that way forever. Keep tapping until it
  looks right — a 180°-off feed looks identical to a correct one by shape
  alone, so it is never auto-detected.
- **`⇆`** mirrors it. No combination of rotations can undo a reflection, which
  is why this cannot be another tap of the first button.

## Development

```sh
npm run check     # every module parses and resolves
npm test          # headless unit tests, no GPU or camera needed
npm run smoke     # boots the real page in headless Chromium
npm run verify    # check + test
```

### Layout

```
src/
  core/      camera feed, video↔world mapping, head tracking, stereo renderer
  vision/    SceneSegmenter.js — what each pixel actually is
  render/    Restyle.js — the shader that keeps structure and replaces appearance
             ClassAtlas.js — packs a theme into textures the shader can index
  style/     Theme (validation), ThemeLibrary (the worlds), ThemeDirector
             (stability), ClaudeStylist (the AI source)
  hands/     MediaPipe hand tracking, and a pointer fallback for desktop
  ui/        world-space panels and buttons, drawn in 3D so both eyes see them
tools/       dev server, style relay, checks, tests, smoke test
```

Two implementation notes that are easy to trip over:

**A theme reaches the shader as textures, not uniforms.** 21 classes × a
four-stop ramp plus its parameters is far past the uniform budget on a mid
phone, and blowing that budget makes the program fail to *link* — which
surfaces as a black headset, not an error. `ClassAtlas` packs the whole theme
into two small textures instead, one row per class, so the cost is fixed no
matter how many objects a theme describes. The ramp rows are sampled with
bilinear filtering, which makes the interpolation between colour stops free.

**The colour maths in `Restyle.js` is mirrored in JS** (`restyleColorCPU`) so
it can be unit-tested without a GPU. One invariant worth knowing about: with
the passthrough theme the pipeline is the **exact** identity — not merely
close — which is what makes "off" genuinely free rather than a subtly degraded
copy. `npm test` pins that, and also pins that every object in every built-in
theme is visually distinct from the room it sits in, since an object that
isn't is indistinguishable from having no object recognition at all.

## Known limits

- **3DoF only.** Head rotation is tracked, position is not — you turn, you do
  not walk.
- **Mono passthrough.** Both eyes see the same camera frame, so the background
  has no stereo depth. Normal for phone-in-shell AR.
- **It knows 21 kinds of thing, and no more.** DeepLab-v3's class list is
  furniture, people, animals and vehicles — chair, sofa, tv, dining table,
  potted plant, bottle, person, cat, dog. A lamp, a bookshelf, a kettle or a
  radiator is not on it, and quietly becomes part of the room. That ceiling is
  the model's, not the renderer's: the shader indexes classes by number, so a
  model with a longer list would need only a longer `CLASSES` array.
- **Object boundaries are soft and a little unstable.** The mask is low
  resolution and re-computed a few times a second, so a material can creep a
  centimetre past its object, and something half in frame may be recognised
  only intermittently. Reads as a slightly loose edge rather than as an error.
- **Very dark rooms flatten out.** The effect is carried by shading, so where
  the camera sees no shading there is nothing to work with.
- **Yaw drifts slowly over a session.** `HeadTracker` deliberately does not use
  the compass (`config.head.useCompass`, off by default) — near motors, wiring,
  or other electronics, compass-referenced orientation can swing tens of
  degrees within a couple of frames while the phone sits physically still,
  which reads as violent shaking in anything world-locked. Gyroscope-only
  orientation avoids that at the cost of slow drift; press `↻` to recentre.
- **iOS cannot be forced into landscape from the page.** The Screen Orientation
  Lock API that does this on Android isn't implemented in Safari — Apple's
  choice, not something fixable here. On iPhone, the phone's own rotation-lock
  toggle being off is a hard requirement, not a suggestion.

## Licence

MIT.
