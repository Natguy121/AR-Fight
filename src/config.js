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

  /**
   * Paper tracing: draw the weapon outline with a pen instead of mid-air.
   * Hold the drawing up to the camera and give a thumbs up; each dark shape
   * found on it becomes a stroke, same as if it had been pinch-drawn.
   */
  paperTrace: {
    /** How long a steady thumbs-up must hold before it fires, in ms — long
     * enough that it reads as deliberate (this ends the draw step outright,
     * unlike the fast gesture debounces used for pinch/trigger). */
    holdMs: 550,
    /** After a capture attempt (successful or not), ignore thumbs-up for
     * this long — otherwise the same held gesture immediately re-fires. */
    cooldownMs: 1200,
    /** Distance in front of the viewer the drawing is assumed to be held at,
     * metres. Only affects the drawing's initial apparent size (exactly like
     * getting the camera FOV estimate wrong does, per `camera` above) — hold
     * the paper closer or farther to make the traced shape bigger or
     * smaller, the same intuitive control mid-air drawing already has. */
    depth: 0.4,
    /** Longest edge the captured frame is downscaled to before processing.
     * Contour tracing is O(pixels); this is plenty of resolution for a
     * pen outline while keeping it fast on a phone. */
    captureMaxWidth: 360,
    /** At most this many separate ink shapes become strokes, largest first. */
    maxContours: 6,
    /** Reject a shape smaller than this fraction of the frame, as noise. */
    minAreaFraction: 0.002,
    /** Reject a shape covering more than this fraction of the frame — most
     * likely the whole page (or a shadow) got thresholded as one blob. */
    maxAreaFraction: 0.9,
    /** Douglas-Peucker simplification tolerance, in source pixels. */
    simplifyEpsilonPx: 2,
    /** Minimum grey-value standard deviation across the frame. Below this
     * there is no real edge to threshold — blank paper, a lens cap, or bad
     * light — so bail out honestly rather than reporting noise as a shape. */
    minContrast: 12,
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
    /**
     * Throwing a melee weapon: releasing the pinch while the strike point is
     * moving at least this fast (m/s) launches it as a projectile instead of
     * just ending the swing. This is the *only* way a melee weapon can land
     * a hit in versus mode — there is no shared physical space to swing into
     * range of a remote opponent in.
     */
    throwSpeed: 2.2,
    throwProjectileSpeed: 14,
    throwDamage: 34,
    /** Cooldown between throws, ms — otherwise a fast flick-flick-flick spams them. */
    throwCooldownMs: 600,
  },

  /** Remote 1v1: draw your own weapon, then fight whoever you connect to. */
  versus: {
    maxHealth: 100,
    gunDamage: 12,
    /** Distance in front of the local player the opponent avatar is fixed
     * at, metres — see `OpponentAvatar.place`. There is no shared physical
     * space between two remote rooms to place them "truly" at. */
    opponentDistance: 2.2,
    /** Vertical offset from the local player's own head height. */
    opponentHeightOffset: -0.05,
    /** Radius of the opponent's hit-test sphere, metres — generous, since
     * their avatar is a rough stand-in for a whole person. */
    hitRadius: 0.32,
    /** How often outgoing pose updates are sent, per second. Gameplay only
     * needs to look responsive, not be pixel-accurate, so this is well below
     * render rate to keep the data channel light. */
    poseSendHz: 15,
    /** A weapon sketch can have many stroke samples; a receive-only visual
     * doesn't need draw-time density, so each stroke is thinned to at most
     * this many points before it goes over the wire (see `WeaponSync`). */
    maxSyncPointsPerStroke: 60,
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
