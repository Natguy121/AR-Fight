# models

`hand_landmarker.task` (the MediaPipe hand landmark model, ~7.5 MB) is **not**
committed. By default the app streams it from Google's model CDN.

Run `npm run fetch-deps` to download it here, along with the MediaPipe
`tasks-vision` runtime into `vendor/mediapipe/`. With both present the app runs
fully offline — useful on a phone with no signal, or to cut cold-start time.

The app auto-detects the local copies at boot; no config change needed.
