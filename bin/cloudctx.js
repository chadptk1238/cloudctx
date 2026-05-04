#!/usr/bin/env node
// Node-compatible shim. Detects Bun, prints clear install instructions if
// missing, otherwise re-execs the real entry under Bun. The compiled binary
// (bun build --compile) bypasses this shim entirely.

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const BUN_MIN = '1.1.0';

function compareVersion(a, b) {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function detectBun() {
  try {
    const r = spawnSync('bun', ['--version'], { encoding: 'utf-8' });
    if (r.status === 0) return r.stdout.trim();
  } catch {}
  return null;
}

const installed = detectBun();

if (!installed) {
  process.stderr.write(`
cloudctx now requires Bun (>=${BUN_MIN}).
You're running it under Node, which no longer ships the SQLite layer
cloudctx uses.

Install Bun (one-liner):
  curl -fsSL https://bun.sh/install | bash

Then run cloudctx again. Your existing data in ~/.cloudctx is preserved.

Why the change: bun:sqlite is built into the Bun runtime — no native
compile, no node-gyp, no breakage when Node releases a new major version.
See: https://github.com/chadptk1238/cloudctx#bun

`);
  process.exit(1);
}

if (compareVersion(installed, BUN_MIN) < 0) {
  process.stderr.write(`cloudctx requires Bun >=${BUN_MIN} (you have ${installed}).
Update: curl -fsSL https://bun.sh/install | bash
`);
  process.exit(1);
}

const main = join(dirname(fileURLToPath(import.meta.url)), 'cloudctx-main.js');
const result = spawnSync('bun', ['run', main, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
