#!/usr/bin/env node
/**
 * Zero-dependency static server for AR-Fight.
 *
 * Phones only grant `getUserMedia` on a secure origin, and `localhost` does not
 * help when the phone is a different machine. So this serves HTTPS with a
 * self-signed certificate by default (generated on first run via `openssl`),
 * and prints the LAN URL to open on the phone.
 *
 *   node tools/serve.js              # https on :8443
 *   node tools/serve.js --http       # plain http (localhost testing only)
 *   node tools/serve.js --port 9000
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CERT_DIR = path.join(__dirname, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'dev-key.pem');
const CRT_FILE = path.join(CERT_DIR, 'dev-cert.pem');

const args = process.argv.slice(2);
const useHttp = args.includes('--http');
const portIndex = args.indexOf('--port');
const PORT = portIndex !== -1 ? Number(args[portIndex + 1]) : useHttp ? 8080 : 8443;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function ensureCert() {
  if (fs.existsSync(KEY_FILE) && fs.existsSync(CRT_FILE)) return true;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', KEY_FILE, '-out', CRT_FILE,
      '-days', '365', '-subj', '/CN=ar-fight.local',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    console.log('Generated a self-signed certificate in tools/certs/.');
    return true;
  } catch {
    console.error(
      'Could not generate a certificate (is `openssl` installed?).\n' +
      'Falling back to plain HTTP — the camera will only work on localhost.\n',
    );
    return false;
  }
}

function lanAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const e of entries || []) {
      if (e.family === 'IPv4' && !e.internal) out.push(e.address);
    }
  }
  return out;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    // Cross-origin isolation lets MediaPipe use SharedArrayBuffer + threads.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function handler(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);
  // Reject anything that escapes the project root.
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    return send(res, 403, 'Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, `Not found: ${urlPath}`);

    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

let server;
let scheme = 'http';

if (!useHttp && ensureCert()) {
  server = https.createServer(
    { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CRT_FILE) },
    handler,
  );
  scheme = 'https';
} else {
  server = http.createServer(handler);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nAR-Fight served from ${ROOT}\n`);
  console.log(`  local:   ${scheme}://localhost:${PORT}/`);
  for (const ip of lanAddresses()) {
    console.log(`  network: ${scheme}://${ip}:${PORT}/   <- open this on the phone`);
  }
  if (scheme === 'https') {
    console.log(
      '\nThe certificate is self-signed, so the phone will warn once.\n' +
      'Tap Advanced -> Proceed. The camera prompt appears after that.',
    );
  } else {
    console.log('\nPlain HTTP: the camera will be blocked anywhere but localhost.');
  }
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: node tools/serve.js --port ${PORT + 1}`);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});
