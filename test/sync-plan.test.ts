// Tests for the state-comparison engine.
// Run with: npm run test:sync-plan
//
// The classifier is a pure function — these tests build small in-memory
// source/destination/manifest fixtures and assert the resulting category
// for each file. No VS Code dependency.

import { strict as assert } from 'node:assert';
import { classifyFiles, summarisePlan, type FileInfo, type PlanItem } from '../src/sync/plan';
import { emptyManifest, manifestKey, type Manifest, type ManifestEntry } from '../src/sync/manifest-types';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

const SOURCE = 'src-folder';

function file(relPath: string, sha256: string, size = 100): FileInfo {
  return { relPath, sha256, size };
}

function entry(sha256: string, destPath: string): ManifestEntry {
  return { destPath, size: 100, sha256, syncedAt: '2026-05-18T00:00:00Z' };
}

function manifestOf(records: Array<{ relPath: string; entry: ManifestEntry }>): Manifest {
  const m = emptyManifest();
  for (const r of records) {
    m.entries[manifestKey(SOURCE, r.relPath)] = r.entry;
  }
  return m;
}

function find(items: PlanItem[], relPath: string): PlanItem | undefined {
  return items.find((i) => i.relPath === relPath);
}

// ───── six categories, one at a time ─────────────────────────────────────

test('create: source has it, destination empty', () => {
  const items = classifyFiles(SOURCE, [file('a.txt', 'h1')], [], emptyManifest());
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'create');
  assert.equal(items[0].relPath, 'a.txt');
});

test('skip: same hash on both sides', () => {
  const items = classifyFiles(
    SOURCE,
    [file('a.txt', 'h1')],
    [file('a.txt', 'h1')],
    emptyManifest(),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'skip');
});

test('update-tracked: hashes differ, manifest matches current destination', () => {
  const items = classifyFiles(
    SOURCE,
    [file('a.txt', 'newHash')],
    [file('a.txt', 'oldHash')],
    manifestOf([{ relPath: 'a.txt', entry: entry('oldHash', 'a.txt') }]),
  );
  const item = find(items, 'a.txt');
  assert.equal(item?.kind, 'update-tracked');
  assert.equal(item?.sourceHash, 'newHash');
  assert.equal(item?.destHash, 'oldHash');
  assert.equal(item?.manifestHash, 'oldHash');
});

test('update-collision: hashes differ, manifest does NOT match destination', () => {
  const items = classifyFiles(
    SOURCE,
    [file('a.txt', 'newHash')],
    [file('a.txt', 'destEditedByHumanHash')],
    manifestOf([{ relPath: 'a.txt', entry: entry('oldSyncedHash', 'a.txt') }]),
  );
  const item = find(items, 'a.txt');
  assert.equal(item?.kind, 'update-collision');
  // Manifest hash is included for diagnostic display.
  assert.equal(item?.manifestHash, 'oldSyncedHash');
});

test('update-collision: hashes differ, no manifest entry at all', () => {
  const items = classifyFiles(
    SOURCE,
    [file('a.txt', 'newHash')],
    [file('a.txt', 'someExistingHash')],
    emptyManifest(),
  );
  const item = find(items, 'a.txt');
  assert.equal(item?.kind, 'update-collision');
  assert.equal(item?.manifestHash, undefined);
});

test('delete-tracked: manifest knows about it, source removed it', () => {
  const items = classifyFiles(
    SOURCE,
    [],
    [file('gone.txt', 'h1')],
    manifestOf([{ relPath: 'gone.txt', entry: entry('h1', 'gone.txt') }]),
  );
  const item = find(items, 'gone.txt');
  assert.equal(item?.kind, 'delete-tracked');
  assert.equal(item?.destHash, 'h1');
  assert.equal(item?.manifestHash, 'h1');
});

test('delete-tracked: manifest entry but destination already lost the file', () => {
  // Still surfaces — the manifest knew about it, sync needs to clean up.
  const items = classifyFiles(
    SOURCE,
    [],
    [],
    manifestOf([{ relPath: 'phantom.txt', entry: entry('h1', 'phantom.txt') }]),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'delete-tracked');
  assert.equal(items[0].destSize, undefined);
});

test('destination-only: destination has it, source does not, manifest doesn\'t know', () => {
  const items = classifyFiles(
    SOURCE,
    [],
    [file('user-added.txt', 'h1')],
    emptyManifest(),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'destination-only');
});

// ───── interactions ──────────────────────────────────────────────────────

test('manifest entries from OTHER sources are ignored', () => {
  // A different source previously placed something at the same destination.
  // From our source's perspective, that file is destination-only.
  const m = emptyManifest();
  m.entries[`other-source:foo.txt`] = entry('h1', 'foo.txt');
  const items = classifyFiles(SOURCE, [], [file('foo.txt', 'h1')], m);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'destination-only');
});

test('mixed plan: every category at once', () => {
  const items = classifyFiles(
    SOURCE,
    [
      file('keep.txt', 'h-keep'),     // skip
      file('updated.txt', 'h-new'),    // update-tracked
      file('clash.txt', 'h-source'),   // update-collision
      file('new.txt', 'h-new2'),       // create
    ],
    [
      file('keep.txt', 'h-keep'),
      file('updated.txt', 'h-old'),
      file('clash.txt', 'h-dest-different'),
      file('user.txt', 'h-user'),      // destination-only
      file('gone.txt', 'h-gone'),      // delete-tracked (still in dest)
    ],
    manifestOf([
      { relPath: 'updated.txt', entry: entry('h-old', 'updated.txt') },
      { relPath: 'clash.txt', entry: entry('h-different-yet-again', 'clash.txt') },
      { relPath: 'gone.txt', entry: entry('h-gone', 'gone.txt') },
    ]),
  );

  const summary = summarisePlan(items);
  assert.equal(summary.create.length, 1);
  assert.equal(summary.create[0].relPath, 'new.txt');
  assert.equal(summary.updateTracked.length, 1);
  assert.equal(summary.updateTracked[0].relPath, 'updated.txt');
  assert.equal(summary.updateCollision.length, 1);
  assert.equal(summary.updateCollision[0].relPath, 'clash.txt');
  assert.equal(summary.skip.length, 1);
  assert.equal(summary.skip[0].relPath, 'keep.txt');
  assert.equal(summary.deleteTracked.length, 1);
  assert.equal(summary.deleteTracked[0].relPath, 'gone.txt');
  assert.equal(summary.destinationOnly.length, 1);
  assert.equal(summary.destinationOnly[0].relPath, 'user.txt');
});

test('summarisePlan sorts each category by path', () => {
  const items = classifyFiles(
    SOURCE,
    [file('z.txt', 'h1'), file('a.txt', 'h2'), file('m.txt', 'h3')],
    [],
    emptyManifest(),
  );
  const summary = summarisePlan(items);
  assert.deepEqual(
    summary.create.map((i) => i.relPath),
    ['a.txt', 'm.txt', 'z.txt'],
  );
});

// ───── run ────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
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
