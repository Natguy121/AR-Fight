# Test fixtures

`cat-on-sofa.jpg` — a real photograph, used by the smoke test to prove the
scene segmenter actually recognises things rather than merely running. It
contains a cat sitting on a sofa, and DeepLab-v3 labels both, so it exercises
the furniture path (`sofa`) that the whole object-aware repaint depends on.

From Google's public MediaPipe asset bucket:
https://storage.googleapis.com/mediapipe-assets/cat.jpg
