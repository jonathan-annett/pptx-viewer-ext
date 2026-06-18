#!/usr/bin/env node
// Aggregate regression gate for the monorepo: runs every
// packages/*/test/*.test.ts under Node via tsx, one child process per file,
// and reports pass/fail counts. Exit code is non-zero if any file fails, so
// `npm run test:all` (from the repo root) is a single CI-able gate spanning
// both the core package and the extension package.
//
// Plain Node, no test framework — mirrors how each test:* script is invoked.
// Phase 2 moved tests from a single top-level test/ into per-package test
// dirs; this runner globs packages/*/test rather than ./test.

import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');

// Discover every packages/<pkg>/test/*.test.ts, sorted for stable output.
const files = [];
for (const pkg of readdirSync(packagesDir).sort()) {
  const testDir = join(packagesDir, pkg, 'test');
  if (!existsSync(testDir)) continue;
  for (const f of readdirSync(testDir).sort()) {
    if (f.endsWith('.test.ts')) {
      files.push({ rel: join('packages', pkg, 'test', f), abs: join(testDir, f) });
    }
  }
}

if (files.length === 0) {
  console.error('No packages/*/test/*.test.ts files found.');
  process.exit(1);
}

console.log(`Running ${files.length} test file(s) via tsx\n`);

const failed = [];
const start = Date.now();

for (const { rel, abs } of files) {
  process.stdout.write(`• ${rel} ... `);
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', abs],
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
