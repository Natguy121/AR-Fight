# AR-Fight

Draw a weapon in mid-air with your hands, tell the app what kind of weapon it
is, mark the parts that matter — then hold it and use it.

Runs in a mobile browser. Slot the phone into a Cardboard-style shell and it
becomes a passthrough headset: the rear camera is rendered side-by-side in
stereo with lens distortion correction, and the same camera feed drives hand
tracking, so your bare hands are the only controller.

No app store, no build step, no accounts. Serve the folder and open it.

---

## The flow

| Step | What you do |
| --- | --- |
| **1. Check** | Hold a hand up. When the cursor lands on your fingertips, pinch once — that also calibrates your reach. |
| **2. Draw** | Pinch thumb and index together and move your hand. Each pinch-and-release is one stroke. Draw a pistol, a sword, a hammer, whatever you like. |
| **3. Classify** | Look at **GUN** or **MELEE** and hold your gaze, or reach out and poke the button. |
| **4. Tag** | Point at your own drawing and pinch to mark each part. Gun: **grip → trigger → muzzle**. Melee: **grip → striking edge**. |
| **5. Fight** | The weapon snaps into your hand. Guns fire from the muzzle you marked when you curl your index finger. Melee weapons hit with the edge you marked, if you swing hard enough. Targets orbit around you. |

At any point: **New** starts another weapon, **Re-tag** keeps the sketch but
lets you move the points, **Targets** resets the score.

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

```
  local:   https://localhost:8443/
  network: https://192.168.1.42:8443/   <- open this on the phone
```

Then put the phone in the headset, in **landscape**.

**Optional — run fully offline.** MediaPipe's runtime and hand model stream
from public CDNs by default (~26 MB, once, then browser-cached).
`npm run fetch-deps` downloads them into `vendor/mediapipe/` and `models/`;
the app detects them at boot with no config change, and then needs no network
at all.

### Without a headset

Everything works holding the phone like a window — press the `◉◉` button to
leave stereo mode. It also runs on a desktop browser: drag to look around,
drag to move the cursor, scroll or two-finger drag to change its depth, and
press space as the trigger. That fallback engages automatically wherever hand
tracking cannot load, so the app never dead-ends.

---

## How it works

Five problems had to be solved to make this feel like handling an object
rather than poking at a screen.

### Depth from a single camera

A phone camera gives no depth, but drawing in the air is meaningless without
it. The usual trick — measure a bone in pixels, compare to its known real
length — falls apart the moment your hand tilts, because a foreshortened bone
reads as "far away".

So the whole hand is fit at once. MediaPipe returns both a metrically correct
3D model of the current hand pose (`worldLandmarks`, in metres) and its exact
2D projection. Recovering the rotation and scale that map one onto the other is
a small **weak-perspective** problem with a closed form: `M = (Σ m Pᵀ)(Σ P Pᵀ)⁻¹`,
whose rows are `scale · R.row0` and `scale · R.row1`. Rotation absorbs the tilt,
so the leftover scale is honest distance — and a full 3D hand orientation falls
out for free, which is exactly what mounting a weapon on a palm needs.

Weak perspective alone pretends every point sits at one depth, which reads
about 10% too close for a hand tilted 55°. Iterating fixes it
([POSIT](https://www.cs.umd.edu/~daniel/daniel_papersfordownload/Pose25DGeometric.pdf)):
rescaling each observation by its own depth makes the system linear again, and
two or three passes converge. `Σ P Pᵀ` depends only on the model, so it is
inverted once and reused. Measured against synthetic ground truth, this holds
within 5% head-on and 8% at a 55° tilt, where the naive method is off by far
more.

### Strokes that land where you saw your hand

Every landmark is placed along the ray through the pixel it actually occupied,
at its own depth. The reconstruction deliberately uses the **render** camera's
projection rather than the physical camera's, which makes on-screen alignment
exact *regardless* of how wrong the estimate of the phone's lens FOV is. A bad
FOV guess then only changes how far away things feel — and since the weapon is
later re-anchored to the hand using that same scale, even that error largely
cancels. There is a test for precisely this invariant.

### The barrel is not the grip-to-muzzle line

Once the muzzle is tagged, the obvious firing direction is grip → muzzle. That
is wrong for most guns: barrels sit above and forward of the grip, so that line
points diagonally up through the body of the weapon, and shots visibly miss
where you are aiming.

Instead the samples around the muzzle are collected and their **principal axis**
is fit by power iteration on the covariance matrix. For an elongated cloud —
which is what a drawn barrel is — the long axis *is* the bore line. The fit is
rejected and the simple line used as a fallback when the muzzle region is too
blobby for a long axis to mean anything.

Melee weapons need none of this: grip → strike genuinely is the axis, and hits
test against that whole segment, so a swing connects anywhere along the blade
rather than only at the very tip.

### Gestures that do not misfire

Pinch and trigger-pull are measured on the metric hand model rather than the
reconstruction — `worldLandmarks` are orientation-independent and free of depth
noise, so a threshold behaves the same at any distance or angle. Both use
hysteresis plus a debounce so a single frame of bad tracking cannot start a
stroke or fire a shot. Guns fire on the *edge* of a trigger pull, so a held
finger is one shot rather than a stream.

Landmarks are smoothed with a [One-Euro filter](https://gery.casiez.net/1euro/),
which adapts its cutoff to speed: heavy smoothing when your hand is still,
almost none when it moves. Depth, being the noisy channel, gets its own much
heavier filter.

Melee hits require speed as well as contact, measured at the strike point
itself — so a flick of the wrist counts even when the hand barely moves, and
resting a blade against a target does nothing. The test is swept across the
frame, so a fast swing cannot pass through a target between two samples. Bullets
are swept too: at 22 m/s a round covers 37 cm per frame and would otherwise
tunnel straight through a 22 cm target.

### Everything is visible to both eyes

In stereo each eye gets its own image, so a DOM overlay would only ever reach
one of them. All in-session UI is therefore drawn in 3D as textured quads
floating in front of you, selectable two ways — gaze at a button and hold, or
reach out and poke it with a fingertip and pinch. Buttons sit deliberately
below the resting gaze, so simply looking ahead never charges a selection.

The scene renders twice into one offscreen target, then a single pass
pre-distorts it: each screen pixel samples the image at a larger radius from
the lens centre, `r · (1 + k₁r² + k₂r⁴)`, which is the inverse of the pincushion
a magnifying lens introduces. The polynomial is normalised so the lens edge maps
to the image edge — otherwise a third of the display is wasted on black.

---

## Tuning it

Every knob lives in [`src/config.js`](src/config.js), and is exposed at runtime
as `window.ARFIGHT_CONFIG` so it can be adjusted from a remote debugger while
you are still wearing the headset.

The ones most worth touching for a particular phone and shell:

| Setting | Why you would change it |
| --- | --- |
| `stereo.ipd` | Interpupillary distance, metres. The single biggest comfort factor. |
| `stereo.lensCenterOffset` | Shifts each eye's image outward under its lens. Increase if the two images will not fuse. |
| `stereo.distortionK1` / `K2` | Barrel strength. Raise if straight lines still bow inward through the lenses; lower if they bow outward. |
| `stereo.eyeFovDeg` | Must stay wider than what the lens shows, or the periphery has nothing to sample. |
| `camera.verticalFovDeg` | Your phone's rear lens. Affects how far away things feel, not on-screen alignment. |
| `hands.depthScale` | Overwritten by the calibration pinch; set it directly to skip that step. |
| `gestures.pinchOn` / `pinchOff` | Raise both if pinches are missed, lower if strokes start on their own. |
| `weapon.gripPitchOffsetDeg` | Tilts the weapon in your hand. The main "this feels wrong" dial. |
| `stereo.renderScale`, `stereo.msaaSamples` | Drop either if the frame rate suffers. |

## Development

```sh
npm run check    # parse every module and resolve every relative import
npm test         # 37 headless tests: solver, geometry, collision, state
npm run smoke    # boot the real app in Chromium with a synthetic camera
npm run verify   # check + test
```

`npm test` covers the maths that is hard to eyeball — the depth solver against
synthetic ground truth, the anchor and bore geometry, swept collision, the state
machine. `npm run smoke` drives the actual page: it compiles the shaders,
renders frames, and walks draw → classify → tag → equip, which is the only way
to catch a shader that fails to compile before it shows up as a black screen on
a phone. `npm run smoke:shots` also writes screenshots to `tools/shots/`.

Playwright is an optional dependency; the smoke test is the only thing that
needs it. The app itself has **no runtime dependencies** — three.js r169 is
vendored in `vendor/three/`.

### Layout

```
index.html              entry point, permission gate, import map
src/
  config.js             every tunable, in one place
  main.js               wiring and the frame loop
  core/                 camera feed, video↔screen mapping, head tracking,
                        stereo renderer + distortion, state machine
  hands/                MediaPipe wrapper, POSIT depth solver, gestures,
                        multi-hand tracking, pointer fallback
  draw/                 stroke capture and tube geometry
  weapon/               categories, anchors, grip rig, gun and melee behaviour
  ui/                   world-space panels, gaze reticle, hand cursor
  fx/                   projectiles, targets, effects, synthesised audio
  scene/                lighting and floor reference
tools/                  dev server, dep fetcher, checks, tests, smoke test
```

## Requirements

- A phone with a rear camera and motion sensors, on iOS 14.5+ / Android Chrome 90+
- WebGL2 and WASM (any phone from roughly 2019 onward)
- A Cardboard-class headset with a phone slot — optional, but the point
- HTTPS, or `localhost`

Hand tracking runs entirely on-device. No video, no landmarks, and no drawings
leave the phone; there is no backend to send them to.

## Known limits

- **3DoF only.** Head rotation is tracked, position is not — you turn, you do
  not walk. Targets orbit around you for that reason.
- **Mono passthrough.** Both eyes see the same camera frame, so the *background*
  has no stereo depth; drawn objects do. This is normal for phone-in-shell AR.
- **Depth accuracy degrades past ~1 m,** where a hand is small in frame. The
  working range is arm's length, which is where you draw anyway.
- **Bright, even light helps.** Hand tracking struggles in the dark or against
  a background the same colour as your hands.
- `deviceorientation` yaw drifts on devices without a compass. Press `↻` to
  recentre.

## Licence

MIT. three.js is vendored under its own MIT licence; MediaPipe is fetched at
runtime under Apache 2.0.
