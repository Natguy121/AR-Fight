import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('../public', import.meta.url)));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/** A room code in the URL, so an invite can be a link as well as four letters. */
const ROOM_PATH = /^\/[A-Za-z]{4}\/?$/;

export function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);

  // Deep links: /ABCD is the same page, with the code filled in by the client.
  if (pathname === '/' || ROOM_PATH.test(pathname)) pathname = '/index.html';

  // Resolve first, then check the result is still inside public/. Checking the
  // raw string for ".." is not enough — encodings and symlinks get past it.
  const target = path.resolve(PUBLIC_DIR, `.${path.posix.normalize(pathname)}`);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(target, (err, body) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      // The game is small and changes when it is redeployed; never serve a
      // stale client against a newer protocol.
      'cache-control': 'no-cache',
    }).end(body);
  });
}

export default serveStatic;
