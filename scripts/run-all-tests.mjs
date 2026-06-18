#!/usr/bin/env node
// Aggregate regression gate: runs every test/*.test.ts under Node via tsx,
// one child process per file, and reports pass/fail counts. Exit code is
// non-zero if any file fails, so `npm run test:all` is a single CI-able gate.
// Plain Node, no test framework — mirrors how each test:* script is invoked.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(repoRoot, 'test');

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

if (files.length === 0) {
  console.error('No test/*.test.ts files found.');
  process.exit(1);
}

console.log(`Running ${files.length} test file(s) via tsx\n`);

const failed = [];
const start = Date.now();

for (const file of files) {
  const rel = join('test', file);
  process.stdout.write(`• ${rel} ... `);
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(testDir, file)],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  );
  if (res.status === 0) {
    console.log('PASS');
  } else {
    console.log('FAIL');
    failed.push({ rel, code: res.status, stdout: res.stdout, stderr: res.stderr });
  }
}

const secs = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\n${files.length - failed.length}/${files.length} passed in ${secs}s`);

if (failed.length > 0) {
  console.log(`\n${failed.length} FAILED:`);
  for (const f of failed) {
    console.log(`\n=== ${f.rel} (exit ${f.code}) ===`);
    if (f.stdout?.trim()) console.log(f.stdout.trimEnd());
    if (f.stderr?.trim()) console.log(f.stderr.trimEnd());
  }
  process.exit(1);
}
