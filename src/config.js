/**
 * Central tuning surface for AR-Fight.
 *
 * Everything a phone/headset combination might need to be adjusted for lives
 * here. Values are also exposed at runtime as `window.ARFIGHT_CONFIG`, so they
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
     * Getting this wrong does NOT break on-screen alignment — strokes are
     * reconstructed so they reproject onto the pixels your hand occupied — it
     * only scales how far away things feel. Calibration refines it.
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
     * Scalar applied to the depth estimate. Calibration overwrites this to
     * account for the user's actual hand size and the camera FOV estimate.
     */
    depthScale: 1.0,
  },

  /** Gesture thresholds. All distances are relative to the hand's own scale. */
  gestures: {
    /** Pinch closes below `pinchOn`, opens above `pinchOff` (hysteresis). */
    pinchOn: 0.38,
    pinchOff: 0.55,
    /** Index PIP joint angle (degrees) for the trigger pull, with hysteresis. */
    triggerPullDeg: 118,
    triggerReleaseDeg: 138,
    /** A gesture must hold this long (ms) before it counts, to reject noise. */
    debounceMs: 60,
  },

  /** Mid-air drawing. */
  draw: {
    /** Minimum travel between recorded stroke samples, in metres. */
    minSampleDistance: 0.006,
    /** Tube radius of a stroke, in metres. */
    strokeRadius: 0.008,
    /** Radial segments of the stroke tube. Low: these get rebuilt often. */
    radialSegments: 6,
    /** Hard cap on samples per stroke, to bound geometry cost. */
    maxSamplesPerStroke: 400,
    maxStrokes: 40,
    /** Rebuild the live stroke's mesh at most every N frames. */
    rebuildEveryNFrames: 2,
    /** Colour cycle for successive strokes. */
    palette: [0x5ac8fa, 0xffd166, 0xff6b6b, 0x8bf5a0, 0xc792ea, 0xffa94d],
  },

  /** Anchor tagging. */
  tagging: {
    /** Fingertip must be within this radius (m) of a stroke sample to snap. */
    snapRadius: 0.09,
    /** Radius (m) around the muzzle used for the PCA barrel-axis fit. */
    barrelAxisRadius: 0.12,
    markerRadius: 0.016,
    colors: {
      muzzle: 0xff8c42,
      trigger: 0xff4d6d,
      grip: 0x4d96ff,
      strike: 0xffe74c,
    },
  },

  /** Holding and using the finished weapon. */
  weapon: {
    /** Pitch (deg) applied to the grip so the weapon sits naturally in-hand. */
    gripPitchOffsetDeg: -18,
    /** Roll (deg) about the forward axis. */
    gripRollOffsetDeg: 0,
    /** Smoothing factor per frame for the held weapon pose (0..1, higher = snappier). */
    poseLerp: 0.45,
  },

  gun: {
    projectileSpeed: 22,
    projectileRadius: 0.02,
    projectileLifetime: 2.5,
    maxProjectiles: 64,
    fireIntervalMs: 180,
    /** Recoil kick in metres along -forward, and its recovery rate. */
    recoilDistance: 0.045,
    recoilRecovery: 8,
    muzzleFlashMs: 60,
  },

  melee: {
    /** Strike point must exceed this speed (m/s) to register a hit. */
    minSwingSpeed: 1.4,
    /** Hit radius around the strike point, in metres. */
    hitRadius: 0.14,
    /** Cooldown between melee hits on the same target, in ms. */
    hitCooldownMs: 350,
    trailSegments: 24,
    trailLifetimeMs: 240,
  },

  /** Practice targets. */
  targets: {
    count: 6,
    /** Ring radius (m) and vertical spread around the player. */
    ringRadius: 3.2,
    ringRadiusJitter: 1.0,
    minHeight: -0.4,
    maxHeight: 1.1,
    radius: 0.22,
    respawnDelayMs: 1400,
    /** Targets drift gently so they are not static. */
    driftSpeed: 0.25,
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
    /** Draw the 21 hand landmarks as points. */
    showHandSkeleton: true,
    /** Show the reference floor grid. */
    showGrid: true,
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
  window.ARFIGHT_CONFIG = config;
}

export default config;
