/**
 * Central tuning surface for Remade.
 *
 * Everything a phone/headset combination might need to be adjusted for lives
 * here. Values are also exposed at runtime as `window.REMADE_CONFIG`, so they
 * can be poked from a remote debugger while wearing the headset.
 */

export const config = {
  /** Passthrough camera capture request. */
  camera: {
    facingMode: 'environment',
    idealWidth: 1280,
    idealHeight: 720,
    idealFrameRate: 30,
    /**
     * Vertical field of view of the physical camera, in degrees. Browsers do
     * not expose this, so it is an estimate; ~59deg matches the main rear
     * camera of most phones (a ~26mm equivalent lens).
     *
     * Only used by the hand depth solver, and only to scale how far away a
     * hand is judged to be — the repaint itself never consults it, since it
     * works on camera pixels directly rather than on reconstructed geometry.
     */
    verticalFovDeg: 59,
  },

  /** 3DoF head orientation, from `deviceorientation`. */
  head: {
    /**
     * Adaptive smoothing on the raw sensor quaternion, One-Euro style: heavy
     * at rest, nearly none while actually turning. Unfiltered orientation
     * sensors read as a visible shake/vibration in anything world-locked
     * that sits still relative to your view — a text panel most of all,
     * since sharp edges make small jitter obvious in a way a moving 3D
     * scene mostly hides.
     *
     * `minCutoff` (Hz) sets the smoothing floor at zero angular speed — lower
     * damps more but adds more lag turning your head. `beta` is how fast
     * that floor gets abandoned as speed increases; higher reaches full
     * responsiveness sooner. Comfort in a headset depends on latency far
     * more than on precision here, so beta is deliberately generous.
     */
    smoothing: {
      minCutoff: 0.4,
      beta: 0.6,
      dCutoff: 1.0,
    },
    /**
     * Also listen for `deviceorientationabsolute` (compass-referenced yaw,
     * via the magnetometer) alongside plain `deviceorientation`. Off by
     * default: on Android Chrome this specifically requests the
     * magnetometer-fused rotation-vector sensor, which near motors, wiring,
     * or other electronics can swing by tens of degrees within a couple of
     * frames while the phone sits physically still — reading as violent
     * shaking in anything world-locked, confirmed by comparing against the
     * (unaffected, since it does not touch this sensor) passthrough video
     * in the same recording. Gyroscope-only orientation trades that for
     * slow yaw drift over a session, which the recentre button already
     * exists to correct — turn this back on for a session that will run
     * long enough for drift to matter more than that risk.
     */
    useCompass: false,
  },

  /** Stereo output: the phone in a Cardboard-style shell. */
  stereo: {
    /** Start in side-by-side headset mode. Toggleable at runtime. */
    enabledByDefault: true,
    /** Interpupillary distance in metres. */
    ipd: 0.063,
    /**
     * Horizontal offset of each lens centre from its half-screen centre, in
     * normalised half-screen units. Positive pushes the image outward.
     */
    lensCenterOffset: 0.06,
    /** Brown-Conrady barrel coefficients that pre-cancel the lens pincushion. */
    distortionK1: 0.22,
    distortionK2: 0.08,
    /** Render scale multiplier; < 1 trades sharpness for frame rate. */
    renderScale: 1.0,
    /** MSAA samples on the offscreen target. Drop to 0 if fill-rate bound. */
    msaaSamples: 4,
    /** Vertical FOV of each eye camera in degrees. */
    eyeFovDeg: 72,
    /**
     * Forced-black margin at the boundary between the two eyes, in
     * normalised half-screen units (0.03 = 3% of one eye's own width).
     * The barrel-distortion vignette is normally what keeps the two eyes
     * visually apart on its own, by going black wherever it samples outside
     * the rendered frame — but exactly how close that gets to the shared
     * boundary depends on the resolution and GPU driver, and at some
     * combinations it reaches (or nearly reaches) the boundary itself,
     * letting the two eyes bleed into what reads as one fused image. This
     * guarantees the separation regardless, at the cost of a sliver of
     * image right at the centre — already the least useful part of the
     * frame, being nearest each lens's own inner edge. 0 disables it.
     */
    eyeGutter: 0.03,
  },

  /** Hand tracking. */
  hands: {
    /**
     * Where to load MediaPipe from. `auto` prefers the locally vendored copy
     * (see `npm run fetch-deps`) and falls back to the CDN.
     */
    source: 'auto', // 'auto' | 'local' | 'cdn'
    cdnBase: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14',
    localBase: './vendor/mediapipe',
    cdnModelUrl:
      'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    localModelUrl: './models/hand_landmarker.task',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    /** Run detection at most this often (ms). Hand motion is slow vs. render. */
    detectionIntervalMs: 33,

    /** One-Euro smoothing for landmark positions. */
    filterMinCutoff: 1.6,
    filterBeta: 0.03,
    filterDCutoff: 1.0,
    /** Heavier smoothing for the noisier depth estimate. */
    depthFilterMinCutoff: 0.6,
    depthFilterBeta: 0.02,

    /** Clamp on the monocular depth estimate, in metres. */
    minDepth: 0.15,
    maxDepth: 1.2,
    /**
     * Scalar applied to the depth estimate, to account for hand size and the
     * camera FOV estimate above. Only affects how far away a pinch is judged
     * to be, which in turn only affects reaching out to touch a UI button.
     */
    depthScale: 1.0,
  },

  /** Gesture thresholds. All distances are relative to the hand's own scale. */
  gestures: {
    /** Pinch closes below `pinchOn`, opens above `pinchOff` (hysteresis). */
    pinchOn: 0.38,
    pinchOff: 0.55,
    /** A gesture must hold this long (ms) before it counts, to reject noise. */
    debounceMs: 60,
  },

  /** Repainting the world as a different material. */
  reskin: {
    /**
     * Seconds to cross-fade between two materials.
     *
     * Long enough to read as a transformation rather than a cut, short enough
     * not to feel like waiting. Only ever runs on a deliberate change — see
     * `StyleDirector`, which exists to guarantee nothing else can trigger one.
     */
    fadeSeconds: 0.7,
    /**
     * Remember the current material across reloads, so a room you have
     * already transformed looks the way you left it when you come back.
     * Turn off to start from untouched passthrough every time.
     */
    persist: true,
    /**
     * Longest edge, in pixels, of the frame sent to Claude when it is the one
     * choosing. Small on purpose: this is a material judgement, which needs
     * the room's overall colour and clutter rather than its fine detail, and
     * every pixel is latency the wearer stands and waits through.
     */
    frameMaxWidth: 512,
  },

  /** World-space UI. */
  ui: {
    /** Distance (m) in front of the viewer that panels float. */
    panelDistance: 1.1,
    /** Panel re-anchors when the viewer's gaze strays past this angle (deg). */
    followAngleDeg: 34,
    followLerp: 0.08,
    /** Height of the message panel relative to the gaze centre, metres. */
    promptOffsetY: 0.22,
    /**
     * Height of the button row, metres below the gaze centre.
     *
     * Buttons must not sit where the eyes rest. At the panel distance this is
     * roughly 15 degrees down, so activating one takes a deliberate glance and
     * simply looking ahead never charges a dwell.
     */
    buttonsOffsetY: -0.30,
    /** Gaze must dwell this long (ms) on a button to activate it. */
    gazeDwellMs: 1100,
    /** Pixels per metre when rasterising panel text to a canvas texture. */
    pixelsPerMeter: 900,
  },

  debug: {
    /** Log state transitions to the console. */
    logStates: true,
    /**
     * Show a small fixed-position (not 3D — stays level no matter what the
     * scene is doing) readout of raw device-orientation sensor values and
     * the derived screen-angle compensation. Off by default; also forced on
     * by a `?debug=1` URL parameter, since editing this file and redeploying
     * is a much longer loop than adding a query string on a phone.
     */
    showOrientationInfo: false,
  },
};

if (typeof window !== 'undefined' && typeof location !== 'undefined') {
  try {
    if (new URLSearchParams(location.search).get('debug') === '1') {
      config.debug.showOrientationInfo = true;
    }
  } catch {
    /* URLSearchParams unavailable or location inaccessible; not fatal. */
  }
}

if (typeof window !== 'undefined') {
  window.REMADE_CONFIG = config;
}

export default config;
