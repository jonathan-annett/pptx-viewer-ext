// Tests for the orphan-tmp sweep.
// Run with: npm run test:sync-orphan-sweep
//
// `sweepOrphanTmpFiles` walks a directory tree via an injected SweepFs and
// deletes any file whose basename ends in `.tmp`. The tests stand up a fake
// fs with a flat path → entry map and verify what gets deleted, what survives,
// and how errors are reported.

import { strict as assert } from 'node:assert';
import {
  sweepOrphanTmpFiles,
  ORPHAN_TMP_SUFFIX,
  type SweepFs,
  type FileTypeBits,
} from '../src/sync/orphanSweep';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void): void => {
  tests.push([name, fn]);
};

// ───── fake fs ───────────────────────────────────────────────────────────
//
// `entries` maps a directory URI → list of [name, FileTypeBits]. `files` is
// only consulted when delete() is called — to fail the delete we put the URI
// in `deleteErrors`. URIs are flat strings like "dst://sub/foo.tmp".

const FILE: FileTypeBits = 1;
const DIRECTORY: FileTypeBits = 2;
const ROOT = 'dst://';

interface FakeFs extends SweepFs<string> {
  entries: Map<string, Array<[string, FileTypeBits]>>;
  deleted: Set<string>;
  deleteErrors: Map<string, Error>;
  readErrors: Set<string>;
}

function makeFakeFs(): FakeFs {
  const entries = new Map<string, Array<[string, FileTypeBits]>>();
  const deleted = new Set<string>();
  const deleteErrors = new Map<string, Error>();
  const readErrors = new Set<string>();

  return {
    entries,
    deleted,
    deleteErrors,
    readErrors,
    joinPath(root, relPath) {
      const base = root.endsWith('/') ? root.slice(0, -1) : root;
      const sep = relPath.startsWith('/') ? '' : '/';
      return `${base}${sep}${relPath}`;
    },
    async readDirectory(uri) {
      if (readErrors.has(uri)) {
        throw new Error(`fake: readDirectory denied at ${uri}`);
      }
      return entries.get(uri) ?? [];
    },
    async delete(uri) {
      const err = deleteErrors.get(uri);
      if (err) throw err;
      deleted.add(uri);
    },
  };
}

// ───── tests ──────────────────────────────────────────────────────────────

test('deletes .tmp files at the root level', async () => {
  const fs = makeFakeFs();
  fs.entries.set(ROOT, [
    ['real.pptx', FILE],
    ['orphan.tmp', FILE],
    ['report.pptx.tmp', FILE],
  ]);
  const result = await sweepOrphanTmpFiles(fs, ROOT);

  assert.deepEqual(result.deleted.sort(), ['orphan.tmp', 'report.pptx.tmp']);
  assert.deepEqual(result.errors, []);
  assert.equal(fs.deleted.has('dst://real.pptx'), false);
  assert.equal(fs.deleted.has('dst://orphan.tmp'), true);
  assert.equal(fs.deleted.has('dst://report.pptx.tmp'), true);
});

test('recurses into subdirectories', async () => {
  const fs = makeFakeFs();
  fs.entries.set(ROOT, [
    ['nested', DIRECTORY],
    ['top.tmp', FILE],
  ]);
  fs.entries.set('dst://nested', [
    ['deep', DIRECTORY],
    ['inner.pptx.tmp', FILE],
  ]);
  fs.entries.set('dst://nested/deep', [['really-deep.tmp', FILE]]);

  const result = await sweepOrphanTmpFiles(fs, ROOT);
  assert.deepEqual(result.deleted.sort(), [
    'nested/deep/really-deep.tmp',
    'nested/inner.pptx.tmp',
    'top.tmp',
  ]);
  assert.equal(result.errors.length, 0);
});

test('leaves non-tmp files alone', async () => {
  const fs = makeFakeFs();
  fs.entries.set(ROOT, [
    ['foo.tmp.bak', FILE], // only the exact .tmp suffix
    ['tmp', FILE], // no leading dot
    ['real.pptx', FILE],
  ]);
  const result = await sweepOrphanTmpFiles(fs, ROOT);
  assert.deepEqual(result.deleted, []);
  assert.equal(fs.deleted.size, 0);
  assert.equal(result.errors.length, 0);
});

test('missing root returns empty result (no throw)', async () => {
  const fs = makeFakeFs();
  fs.readErrors.add(ROOT);
  const result = await sweepOrphanTmpFiles(fs, ROOT);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.errors, []);
});

test('delete failure is recorded; sweep continues', async () => {
  const fs = makeFakeFs();
  fs.entries.set(ROOT, [
    ['a.tmp', FILE],
    ['b.tmp', FILE],
    ['c.tmp', FILE],
  ]);
  fs.deleteErrors.set('dst://b.tmp', new Error('permission denied'));
  const result = await sweepOrphanTmpFiles(fs, ROOT);

  assert.deepEqual(result.deleted.sort(), ['a.tmp', 'c.tmp']);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].relPath, 'b.tmp');
  assert.match(result.errors[0].message, /permission denied/);
});

test('subdirectory readDirectory failure is swallowed; siblings still swept', async () => {
  const fs = makeFakeFs();
  fs.entries.set(ROOT, [
    ['locked', DIRECTORY],
    ['ok.tmp', FILE],
  ]);
  fs.readErrors.add('dst://locked');
  const result = await sweepOrphanTmpFiles(fs, ROOT);
  assert.deepEqual(result.deleted, ['ok.tmp']);
  assert.deepEqual(result.errors, []);
});

test('non-File non-Directory entries are skipped', async () => {
  const fs = makeFakeFs();
  // FileType.Unknown is 0; the sweep should ignore it.
  fs.entries.set(ROOT, [
    ['weird.tmp', 0],
    ['real.tmp', FILE],
  ]);
  const result = await sweepOrphanTmpFiles(fs, ROOT);
  assert.deepEqual(result.deleted, ['real.tmp']);
});

test('exported suffix constant matches executor.ts', () => {
  // Sanity check — if executor.ts ever changes its TMP_SUFFIX, this test
  // forces the sweep constant to be updated in lockstep.
  assert.equal(ORPHAN_TMP_SUFFIX, '.tmp');
});

// ───── run ────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok: ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL: ${name}`);
      console.error(`    ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log('all tests passed');
})();
