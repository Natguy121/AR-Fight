#!/usr/bin/env node
/**
 * Parse-checks every source module. There is no build step, so a syntax error
 * would otherwise only surface on the phone — where reading a stack trace means
 * taking the headset off.
 *
 *   npm run check
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIRS = ['src', 'tools'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = DIRS
  .map((d) => path.join(ROOT, d))
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => walk(d));

let failed = 0;
const importPattern = /(?:^|[\s;])(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);

  // 1. Syntax.
  try {
    new vm.SourceTextModule(src, { identifier: file });
  } catch (err) {
    console.error(`FAIL  ${rel}\n      ${err.message}`);
    failed++;
    continue;
  }

  // 2. Relative imports resolve to real files. Bare specifiers ('three',
  //    'node:fs') are left to the import map / node.
  let broken = null;
  for (const m of src.matchAll(importPattern)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), spec);
    if (!fs.existsSync(target)) {
      broken = spec;
      break;
    }
  }
  if (broken) {
    console.error(`FAIL  ${rel}\n      unresolved import: ${broken}`);
    failed++;
    continue;
  }

  console.log(`ok    ${rel}`);
}

console.log(`\n${files.length - failed}/${files.length} modules OK`);
if (failed) process.exit(1);
