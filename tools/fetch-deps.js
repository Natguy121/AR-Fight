#!/usr/bin/env node
/**
 * Downloads the runtime dependencies that are too large to commit:
 *
 *   vendor/mediapipe/   the tasks-vision runtime (JS + ~19 MB of wasm)
 *   models/             the hand landmark model (~7.5 MB)
 *
 * Optional. Without them the app streams both from public CDNs. With them it
 * runs fully offline and starts noticeably faster.
 *
 *   npm run fetch-deps
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MP_VERSION = '0.10.14';
const MP_DEST = path.join(ROOT, 'vendor', 'mediapipe');
const MODELS = [
  {
    dest: path.join(ROOT, 'models', 'hand_landmarker.task'),
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  },
  {
    // DeepLab-v3, Pascal VOC classes — this is what lets the app tell a chair
    // from a sofa from a TV, and give each one its own treatment. Without it
    // the app can only repaint the whole view uniformly.
    dest: path.join(ROOT, 'models', 'deeplab_v3.tflite'),
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite',
  },
];

/** Files the browser actually loads from the tasks-vision package. */
const MP_FILES = [
  'vision_bundle.mjs',
  'wasm/vision_wasm_internal.js',
  'wasm/vision_wasm_internal.wasm',
  'wasm/vision_wasm_nosimd_internal.js',
  'wasm/vision_wasm_nosimd_internal.wasm',
];

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function download(url, dest) {
  process.stdout.write(`  ${path.relative(ROOT, dest)} ... `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log(human(buf.length));
}

/**
 * Pull tasks-vision through `npm pack`, which is far more reliable than
 * guessing per-file CDN paths and gets us a version-pinned tarball.
 */
function fetchMediaPipe() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arfight-'));
  try {
    console.log(`\nFetching @mediapipe/tasks-vision@${MP_VERSION} via npm ...`);
    execFileSync('npm', ['pack', `@mediapipe/tasks-vision@${MP_VERSION}`, '--silent'], {
      cwd: tmp,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error('npm pack produced no tarball');

    execFileSync('tar', ['xzf', tgz], { cwd: tmp, stdio: 'inherit' });

    fs.mkdirSync(path.join(MP_DEST, 'wasm'), { recursive: true });
    for (const rel of MP_FILES) {
      const from = path.join(tmp, 'package', rel);
      const to = path.join(MP_DEST, rel);
      if (!fs.existsSync(from)) {
        console.warn(`  ! missing from package: ${rel}`);
        continue;
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      console.log(`  vendor/mediapipe/${rel} ... ${human(fs.statSync(to).size)}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  fetchMediaPipe();

  console.log('\nFetching models ...');
  for (const m of MODELS) await download(m.url, m.dest);

  console.log(
    '\nDone. The app detects these automatically at boot and will now run\n' +
    'without any network access.\n',
  );
}

main().catch((err) => {
  console.error(`\nfetch-deps failed: ${err.message}`);
  console.error('The app still works — it will fall back to the CDNs.\n');
  process.exit(1);
});
