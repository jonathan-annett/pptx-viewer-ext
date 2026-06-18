// Tests for the state-comparison engine.
// Run with: npm run test:sync-plan
//
// The classifier is a pure function — these tests build small in-memory
// source/destination/manifest fixtures and assert the resulting category
// for each file. No VS Code dependency.

import { strict as assert } from 'node:assert';
import {
  classifyFiles,
  summarisePlan,
  type FileInfo,
  type PlanItem,
  type PlanWarning,
} from '../src/sync/plan';
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

// ───── warning propagation (M5 Phase A) ──────────────────────────────────
//
// Warnings attach to source-side FileInfos at walk time and ride along onto
// every source-side PlanItem (create, skip, update-tracked, update-collision).
// They never appear on delete-tracked or destination-only — those rows have
// no source bytes to validate.

const WARN_KIOSK: PlanWarning = {
  severity: 'block',
  code: 'show-type',
  message: 'Show type is kiosk',
};
const WARN_LINKED: PlanWarning = {
  severity: 'block',
  code: 'linked-media',
  message: 'External media link present',
};

function withWarnings(f: FileInfo, ...warnings: PlanWarning[]): FileInfo {
  return { ...f, warnings };
}

test('warnings flow through create', () => {
  const items = classifyFiles(
    SOURCE,
    [withWarnings(file('a.pptx', 'h1'), WARN_KIOSK)],
    [],
    emptyManifest(),
  );
  const item = find(items, 'a.pptx');
  assert.equal(item?.kind, 'create');
  assert.deepEqual(item?.warnings, [WARN_KIOSK]);
});

test('warnings flow through skip', () => {
  const items = classifyFiles(
    SOURCE,
    [withWarnings(file('a.pptx', 'h1'), WARN_KIOSK)],
    [file('a.pptx', 'h1')],
    emptyManifest(),
  );
  const item = find(items, 'a.pptx');
  assert.equal(item?.kind, 'skip');
  assert.deepEqual(item?.warnings, [WARN_KIOSK]);
});

test('warnings flow through update-tracked', () => {
  const items = classifyFiles(
    SOURCE,
    [withWarnings(file('a.pptx', 'newHash'), WARN_KIOSK, WARN_LINKED)],
    [file('a.pptx', 'oldHash')],
    manifestOf([{ relPath: 'a.pptx', entry: entry('oldHash', 'a.pptx') }]),
  );
  const item = find(items, 'a.pptx');
  assert.equal(item?.kind, 'update-tracked');
  assert.deepEqual(item?.warnings, [WARN_KIOSK, WARN_LINKED]);
});

test('warnings flow through update-collision', () => {
  const items = classifyFiles(
    SOURCE,
    [withWarnings(file('a.pptx', 'newHash'), WARN_LINKED)],
    [file('a.pptx', 'destHash')],
    emptyManifest(),
  );
  const item = find(items, 'a.pptx');
  assert.equal(item?.kind, 'update-collision');
  assert.deepEqual(item?.warnings, [WARN_LINKED]);
});

test('delete-tracked never carries warnings (no source bytes)', () => {
  // Even if a previous walk had warnings, when the source is gone there's
  // no FileInfo to attach them to — the manifest holds no warning data.
  const items = classifyFiles(
    SOURCE,
    [],
    [file('gone.pptx', 'h1')],
    manifestOf([{ relPath: 'gone.pptx', entry: entry('h1', 'gone.pptx') }]),
  );
  const item = find(items, 'gone.pptx');
  assert.equal(item?.kind, 'delete-tracked');
  assert.equal(item?.warnings, undefined);
});

test('destination-only never carries warnings (not a source file)', () => {
  const items = classifyFiles(
    SOURCE,
    [],
    [file('user.pptx', 'h1')],
    emptyManifest(),
  );
  const item = find(items, 'user.pptx');
  assert.equal(item?.kind, 'destination-only');
  assert.equal(item?.warnings, undefined);
});

test('empty warnings array on FileInfo does not attach a warnings list', () => {
  // The carry helper treats an empty list the same as no list — that way
  // PlanItems stay minimal and downstream checks (warnings?.length > 0)
  // never have to special-case an empty array.
  const items = classifyFiles(
    SOURCE,
    [{ ...file('a.txt', 'h1'), warnings: [] }],
    [],
    emptyManifest(),
  );
  const item = find(items, 'a.txt');
  assert.equal(item?.kind, 'create');
  assert.equal(item?.warnings, undefined);
});

test('summarisePlan: warnings list contains every item with a non-empty warnings list', () => {
  const items = classifyFiles(
    SOURCE,
    [
      withWarnings(file('clean.txt', 'h-clean'), /* no warnings */),
      withWarnings(file('one.pptx', 'h-one'), WARN_KIOSK),
      withWarnings(file('two.pptx', 'h-two'), WARN_KIOSK, WARN_LINKED),
    ],
    [],
    emptyManifest(),
  );
  const summary = summarisePlan(items);
  assert.equal(summary.create.length, 3);
  // Only the two pptx items carry warnings; the clean.txt entry is absent.
  assert.deepEqual(
    summary.warnings.map((i) => i.relPath),
    ['one.pptx', 'two.pptx'],
  );
});

test('summarisePlan: warnings list is path-sorted independently of insertion order', () => {
  const items = classifyFiles(
    SOURCE,
    [
      withWarnings(file('z.pptx', 'hz'), WARN_KIOSK),
      withWarnings(file('a.pptx', 'ha'), WARN_KIOSK),
      withWarnings(file('m.pptx', 'hm'), WARN_KIOSK),
    ],
    [],
    emptyManifest(),
  );
  const summary = summarisePlan(items);
  assert.deepEqual(
    summary.warnings.map((i) => i.relPath),
    ['a.pptx', 'm.pptx', 'z.pptx'],
  );
});

// ───── M5 Phase C: remembered decisions ──────────────────────────────────

test('update-collision: manifest.decisions.collisionOverwrite=true → item.remembered.accepted=true', () => {
  const manifest = emptyManifest();
  manifest.decisions[manifestKey(SOURCE, 'a.txt')] = {
    destOnlyDelete: false,
    collisionOverwrite: true,
    warningOverride: false,
    decidedAt: '2026-05-19T00:00:00Z',
  };
  const items = classifyFiles(
    SOURCE,
    [file('a.txt', 'h1')],
    [file('a.txt', 'h2')],
    manifest,
  );
  const it = find(items, 'a.txt');
  assert.equal(it?.kind, 'update-collision');
  assert.deepEqual(it?.remembered, { accepted: true });
});

test('update-collision: no decision entry → no remembered field', () => {
  const items = classifyFiles(
    SOURCE,
    [file('a.txt', 'h1')],
    [file('a.txt', 'h2')],
    emptyManifest(),
  );
  const it = find(items, 'a.txt');
  assert.equal(it?.kind, 'update-collision');
  assert.equal(it?.remembered, undefined);
});

test('destination-only: manifest.decisions.destOnlyDelete=true → item.remembered.accepted=true', () => {
  const manifest = emptyManifest();
  manifest.decisions[manifestKey(SOURCE, 'orphan.txt')] = {
    destOnlyDelete: true,
    collisionOverwrite: false,
    warningOverride: false,
    decidedAt: '2026-05-19T00:00:00Z',
  };
  const items = classifyFiles(SOURCE, [], [file('orphan.txt', 'h')], manifest);
  const it = find(items, 'orphan.txt');
  assert.equal(it?.kind, 'destination-only');
  assert.deepEqual(it?.remembered, { accepted: true });
});

test('destination-only: matching decision belongs to a different source → no remembered', () => {
  // A foreign source's decision must not pre-arm a delete on our side.
  const manifest = emptyManifest();
  manifest.decisions[manifestKey('other-source', 'orphan.txt')] = {
    destOnlyDelete: true,
    collisionOverwrite: false,
    warningOverride: false,
    decidedAt: '2026-05-19T00:00:00Z',
  };
  const items = classifyFiles(SOURCE, [], [file('orphan.txt', 'h')], manifest);
  assert.equal(find(items, 'orphan.txt')?.remembered, undefined);
});

test('update-tracked: ignores manifest.decisions (only collisions consult it)', () => {
  // The classifier shouldn't apply a remembered overwrite to a tracked-update
  // row — those write unconditionally without user opt-in.
  const manifest = emptyManifest();
  manifest.entries[manifestKey(SOURCE, 'a.txt')] = entry('h2', 'a.txt');
  manifest.decisions[manifestKey(SOURCE, 'a.txt')] = {
    destOnlyDelete: false,
    collisionOverwrite: true,
    warningOverride: false,
    decidedAt: '2026-05-19T00:00:00Z',
  };
  const items = classifyFiles(
    SOURCE,
    [file('a.txt', 'h1')],
    [file('a.txt', 'h2')],
    manifest,
  );
  const it = find(items, 'a.txt');
  assert.equal(it?.kind, 'update-tracked');
  assert.equal(it?.remembered, undefined);
});

// ───── M-placeholders: per-item isPlaceholder flag ───────────────────────

test('create item flagged when sourceHash is in the placeholder set', () => {
  const items = classifyFiles(
    SOURCE,
    [file('stub.pptx', 'sha-zero')],
    [],
    emptyManifest(),
    new Set<string>(['sha-zero']),
  );
  assert.equal(find(items, 'stub.pptx')?.isPlaceholder, true);
});

test('update-tracked item flagged via its sourceHash', () => {
  const items = classifyFiles(
    SOURCE,
    [file('stub.pptx', 'sha-zero')],
    [file('stub.pptx', 'sha-old')],
    manifestOf([{ relPath: 'stub.pptx', entry: entry('sha-old', 'stub.pptx') }]),
    new Set<string>(['sha-zero']),
  );
  const it = find(items, 'stub.pptx');
  assert.equal(it?.kind, 'update-tracked');
  assert.equal(it?.isPlaceholder, true);
});

test('destination-only item flagged via its destHash', () => {
  const items = classifyFiles(
    SOURCE,
    [],
    [file('orphan.pptx', 'sha-zero')],
    emptyManifest(),
    new Set<string>(['sha-zero']),
  );
  const it = find(items, 'orphan.pptx');
  assert.equal(it?.kind, 'destination-only');
  assert.equal(it?.isPlaceholder, true);
});

test('delete-tracked item flagged via its manifestHash', () => {
  // Source removed the file; manifest still knows it. The identity-hash for
  // this category is manifestHash, since there's no current source/dest read.
  const items = classifyFiles(
    SOURCE,
    [],
    [],
    manifestOf([{ relPath: 'stub.pptx', entry: entry('sha-zero', 'stub.pptx') }]),
    new Set<string>(['sha-zero']),
  );
  const it = find(items, 'stub.pptx');
  assert.equal(it?.kind, 'delete-tracked');
  assert.equal(it?.isPlaceholder, true);
});

test('item with no matching hash is not flagged', () => {
  const items = classifyFiles(
    SOURCE,
    [file('a.txt', 'unrelated')],
    [],
    emptyManifest(),
    new Set<string>(['sha-zero']),
  );
  assert.equal(find(items, 'a.txt')?.isPlaceholder, undefined);
});

test('empty placeholder set leaves all items unflagged', () => {
  const items = classifyFiles(
    SOURCE,
    [file('a.txt', 'sha-zero'), file('b.txt', 'h2')],
    [],
    emptyManifest(),
  );
  for (const it of items) {
    assert.equal(it.isPlaceholder, undefined, `${it.relPath} should not be flagged`);
  }
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
