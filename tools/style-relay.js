#!/usr/bin/env node
/**
 * Keeps your Anthropic API key off the phone.
 *
 * The app is a static page, so it has nowhere to hide a secret — a key
 * embedded in it is readable by anyone who opens it. This tiny server holds
 * the key instead: the phone POSTs a camera frame, this calls Claude, and only
 * the resulting style comes back. It is the only setup safe to share a link to.
 *
 *   npm install @anthropic-ai/sdk zod      # not installed by default
 *   export ANTHROPIC_API_KEY=sk-ant-...    # or use `ant auth login`
 *   npm run relay
 *
 * Then open the app with `?relay=https://<this-host>:8788/style`.
 *
 * **Serve it over HTTPS if the app is on HTTPS.** A page loaded over HTTPS —
 * which includes GitHub Pages, and the local dev server — is forbidden by the
 * browser from calling a plain HTTP endpoint, and the request fails as mixed
 * content before it ever leaves the phone. This reuses the dev server's
 * self-signed certificate when present (run `npm start` once to generate it),
 * so both ends match by default. `--http` opts out for a plain-HTTP setup.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SYSTEM_PROMPT } from '../src/style/ClaudeStylist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.join(__dirname, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'dev-key.pem');
const CRT_FILE = path.join(CERT_DIR, 'dev-cert.pem');

const args = process.argv.slice(2);
const useHttp = args.includes('--http');
const portArg = args.indexOf('--port');
const PORT = portArg !== -1 ? Number(args[portArg + 1]) : 8788;

// Imported lazily so the repo still installs, tests, and runs with no
// Anthropic dependency present — this file is opt-in.
let Anthropic;
let z;
let zodOutputFormat;
try {
  ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  ({ z } = await import('zod'));
  ({ zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod'));
} catch {
  console.error(
    'The style relay needs two packages that are not installed by default:\n\n'
    + '  npm install @anthropic-ai/sdk zod\n',
  );
  process.exit(1);
}

/**
 * Mirrors the fields in `src/style/Style.js`.
 *
 * Structured outputs make malformed replies impossible rather than merely
 * unlikely, so the relay never has to parse prose. The client still re-runs
 * `makeStyle` on whatever arrives — this schema guarantees the *shape*, but
 * only the client's clamping guarantees the values are in renderable range.
 */
const StyleSchema = z.object({
  id: z.string(),
  name: z.string(),
  blurb: z.string(),
  ramp: z.array(z.string()).length(4),
  chroma: z.number(),
  contrast: z.number(),
  texture: z.enum(['none', 'grain', 'veins', 'brushed', 'hammered', 'weave']),
  textureScale: z.number(),
  textureStrength: z.number(),
  edgeStrength: z.number(),
  edgeColor: z.string(),
  sheen: z.number(),
  sheenColor: z.string(),
});

const client = new Anthropic();

async function pickStyle(imageBase64, exclude) {
  const avoid = exclude
    ? `\n\nThe room is currently "${exclude}". Choose something clearly different.`
    : '';

  const response = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    // `effort: low` is for latency, not cost: someone is standing in a headset
    // waiting for the room to change, and picking a palette from a photo is
    // well inside what Opus 5 does easily at low effort.
    output_config: { effort: 'low', format: zodOutputFormat(StyleSchema) },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: `Choose one material for this room.${avoid}` },
      ],
    }],
  });

  if (!response.parsed_output) throw new Error('Claude did not return a usable style.');
  return response.parsed_output;
}

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
}

function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      // A camera frame is well under this; anything larger is a mistake or an
      // attempt to exhaust memory, and neither deserves to be buffered.
      if (size > limitBytes) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'POST a JSON body with an `image` field.' }));
  }

  try {
    const { image, exclude } = JSON.parse(await readBody(req));
    if (typeof image !== 'string' || !image) throw new Error('Missing `image`.');

    const style = await pickStyle(image, typeof exclude === 'string' ? exclude : null);
    console.log(`  picked: ${style.name}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ style }));
  } catch (err) {
    console.error('  failed:', err?.message || err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
}

const secure = !useHttp && fs.existsSync(KEY_FILE) && fs.existsSync(CRT_FILE);
const server = secure
  ? https.createServer({ key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CRT_FILE) }, handler)
  : http.createServer(handler);

server.listen(PORT, () => {
  const scheme = secure ? 'https' : 'http';
  console.log(`\nStyle relay on ${scheme}://0.0.0.0:${PORT}/style`);
  if (!secure && !useHttp) {
    console.log(
      'No dev certificate found, so this is plain HTTP. An HTTPS page cannot\n'
      + 'call it — run `npm start` once to generate one, then restart this.',
    );
  }
  console.log(`Open the app with ?relay=${scheme}://<this-host>:${PORT}/style\n`);
});
