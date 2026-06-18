// Tests for the pure executor.
// Run with: npm run test:sync-executor
//
// The executor takes an injected `SyncFs<U>` so we can stand up a fake fs
// keyed by string URIs and inspect what happened after each run. Manifest
// mutations are visible by inspecting the passed-in Manifest object.

import { strict as assert } from 'node:assert';
import { executePlan, type SyncFs } from '../src/sync/executor';
import { emptyManifest, manifestKey } from '../src/sync/manifest-types';
import type { PlanItem } from '../src/sync/plan';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void): void => {
  tests.push([name, fn]);
};

const SOURCE_NAME = 'src-folder';
const SOURCE_ROOT = 'src://';
const DEST_ROOT = 'dst://';

// ───── fake fs ───────────────────────────────────────────────────────────
//
// URIs are strings; "join" is path concatenation with a single slash.
// `files` is the on-disk map; `readErrors` and `writeErrors` let a test
// inject failures keyed by URI.

interface FakeFs extends SyncFs<string> {
  files: Map<string, Uint8Array>;
  readErrors: Map<string, Error>;
  writeErrors: Map<string, Error>;
  renameErrors: Map<string, Error>;
  deleteErrors: Map<string, Error>;
  ops: string[]; // ordered log of "verb uri"
}

function makeFakeFs(): FakeFs {
  const files = new Map<string, Uint8Array>();
  const readErrors = new Map<string, Error>();
  const writeErrors = new Map<string, Error>();
  const renameErrors = new Map<string, Error>();
  const deleteErrors = new Map<string, Error>();
  const ops: string[] = [];

  return {
    files,
    readErrors,
    writeErrors,
    renameErrors,
    deleteErrors,
    ops,
    joinPath(root, relPath) {
      const base = root.endsWith('/') ? root.slice(0, -1) : root;
      const sep = relPath.startsWith('/') ? '' : '/';
      return `${base}${sep}${relPath}`;
    },
    async stat(uri) {
      ops.push(`stat ${uri}`);
      const bytes = files.get(uri);
      if (!bytes) {
        const e = new Error(`fake: file not found at ${uri}`);
        (e as { code?: string }).code = 'FileNotFound';
        throw e;
      }
      return { size: bytes.byteLength, mtime: 0 };
    },
    async readDirectory() {
      // The executor never walks directories; satisfy the SyncFs contract.
      return [];
    },
    async readFile(uri) {
      ops.push(`read ${uri}`);
      const err = readErrors.get(uri);
      if (err) throw err;
      const bytes = files.get(uri);
      if (!bytes) {
        const e = new Error(`fake: file not found at ${uri}`);
        (e as { code?: string }).code = 'FileNotFound';
        throw e;
      }
      return bytes;
    },
    async writeFile(uri, bytes) {
      ops.push(`write ${uri}`);
      const err = writeErrors.get(uri);
      if (err) throw err;
      files.set(uri, bytes);
    },
    async rename(src, dst) {
      ops.push(`rename ${src} ${dst}`);
      const err = renameErrors.get(src) ?? renameErrors.get(dst);
      if (err) throw err;
      const bytes = files.get(src);
      if (!bytes) {
        const e = new Error(`fake: rename source missing ${src}`);
        (e as { code?: string }).code = 'FileNotFound';
        throw e;
      }
      files.delete(src);
      files.set(dst, bytes);
    },
    async delete(uri) {
      ops.push(`delete ${uri}`);
      const err = deleteErrors.get(uri);
      if (err) throw err;
      if (!files.has(uri)) {
        const e = new Error(`fake: nothing to delete at ${uri}`);
        (e as { code?: string }).code = 'FileNotFound';
        throw e;
      }
      files.delete(uri);
    },
  };
}

// Deterministic hash for tests: tag the bytes with a predictable string.
// The plan classifier doesn't compute hashes; tests supply them via PlanItem
// so the executor's hash check has something to compare against.
async function tagHash(bytes: Uint8Array): Promise<string> {
  // Cheap stable identifier: byte length + first/last bytes. Sufficient for
  // tests where we set hashes manually on PlanItems.
  const len = bytes.byteLength;
  const first = len > 0 ? bytes[0] : 0;
  const last = len > 0 ? bytes[len - 1] : 0;
  return `len${len}-f${first}-l${last}`;
}

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Synchronous tag-hash mirror so tests can pre-compute the hash a PlanItem
// would carry without awaiting. Must stay in lockstep with `tagHash` above.
function tagHashOf(s: string): string {
  const b = bytesOf(s);
  const len = b.byteLength;
  const first = len > 0 ? b[0] : 0;
  const last = len > 0 ? b[len - 1] : 0;
  return `len${len}-f${first}-l${last}`;
}

const FIXED_NOW = (): string => '2026-05-18T12:00:00Z';

// ───── happy paths ───────────────────────────────────────────────────────

test('create: writes via tmp+rename, adds manifest entry, lastSync stamped', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://a.txt', bytesOf('hello'));
  const manifest = emptyManifest();
  const helloHash = await tagHash(bytesOf('hello'));

  const items: PlanItem[] = [
    { kind: 'create', relPath: 'a.txt', sourceSize: 5, sourceHash: helloHash },
  ];

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: 'projects/alpha',
    items,
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, 'ok');
  assert.equal(result.counts.create.ok, 1);

  // Final file on disk; tmp gone.
  assert.deepEqual(fs.files.get('dst://a.txt'), bytesOf('hello'));
  assert.equal(fs.files.has('dst://a.txt.tmp'), false);

  // Op order: stat → read → write tmp → rename tmp → final.
  // (The stat call was added in M5.2.5: every write path now goes through
  // hashFileAtUri so the URI hash cache can short-circuit on cache hit.
  // No cache is supplied in tests; stat just happens then we read+hash.)
  assert.deepEqual(fs.ops, [
    'stat src://a.txt',
    'read src://a.txt',
    'write dst://a.txt.tmp',
    'rename dst://a.txt.tmp dst://a.txt',
  ]);

  // Manifest entry shape.
  const key = manifestKey(SOURCE_NAME, 'a.txt');
  assert.ok(manifest.entries[key], 'manifest entry missing');
  assert.equal(manifest.entries[key].destPath, 'projects/alpha/a.txt');
  assert.equal(manifest.entries[key].sha256, helloHash);
  assert.equal(manifest.entries[key].size, 5);
  assert.equal(manifest.entries[key].syncedAt, '2026-05-18T12:00:00Z');
  assert.equal(manifest.lastSync, '2026-05-18T12:00:00Z');
});

test('update-tracked: overwrites destination atomically, updates manifest entry', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://a.txt', bytesOf('NEW'));
  fs.files.set('dst://a.txt', bytesOf('OLD'));
  const manifest = emptyManifest();
  const oldHash = await tagHash(bytesOf('OLD'));
  const newHash = await tagHash(bytesOf('NEW'));
  manifest.entries[manifestKey(SOURCE_NAME, 'a.txt')] = {
    destPath: 'a.txt',
    size: 3,
    sha256: oldHash,
    syncedAt: '2026-01-01T00:00:00Z',
  };

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [
      { kind: 'update-tracked', relPath: 'a.txt', sourceSize: 3, sourceHash: newHash, destHash: oldHash, manifestHash: oldHash },
    ],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
  });

  assert.equal(result.results[0].status, 'ok');
  assert.equal(result.counts.updateTracked.ok, 1);
  assert.deepEqual(fs.files.get('dst://a.txt'), bytesOf('NEW'));

  const entry = manifest.entries[manifestKey(SOURCE_NAME, 'a.txt')];
  assert.equal(entry.sha256, newHash);
  assert.equal(entry.syncedAt, '2026-05-18T12:00:00Z');
  // Empty subpath: destPath is just the rel path with no leading slash.
  assert.equal(entry.destPath, 'a.txt');
});

test('delete-tracked: removes file, prunes manifest entry', async () => {
  const fs = makeFakeFs();
  fs.files.set('dst://gone.txt', bytesOf('zzz'));
  const manifest = emptyManifest();
  const zHash = await tagHash(bytesOf('zzz'));
  manifest.entries[manifestKey(SOURCE_NAME, 'gone.txt')] = {
    destPath: 'gone.txt',
    size: 3,
    sha256: zHash,
    syncedAt: '2026-01-01T00:00:00Z',
  };

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [{ kind: 'delete-tracked', relPath: 'gone.txt', manifestHash: zHash, destHash: zHash, destSize: 3 }],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
  });

  assert.equal(result.results[0].status, 'ok');
  assert.equal(result.counts.deleteTracked.ok, 1);
  assert.equal(fs.files.has('dst://gone.txt'), false);
  assert.equal(manifest.entries[manifestKey(SOURCE_NAME, 'gone.txt')], undefined);
});

test('delete-tracked: already-missing file counts as success, manifest pruned', async () => {
  const fs = makeFakeFs();
  // No file in fs.files — user removed it manually before this run.
  const manifest = emptyManifest();
  manifest.entries[manifestKey(SOURCE_NAME, 'gone.txt')] = {
    destPath: 'gone.txt',
    size: 3,
    sha256: 'h',
    syncedAt: '2026-01-01T00:00:00Z',
  };

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [{ kind: 'delete-tracked', relPath: 'gone.txt' }],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
  });

  assert.equal(result.results[0].status, 'ok');
  assert.equal(manifest.entries[manifestKey(SOURCE_NAME, 'gone.txt')], undefined);
});

// ───── failure isolation ─────────────────────────────────────────────────

test('hash mismatch (source changed between plan and execute) → per-file failure, no write', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://a.txt', bytesOf('actual'));
  const manifest = emptyManifest();
  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [{ kind: 'create', relPath: 'a.txt', sourceSize: 6, sourceHash: 'stale-hash-from-plan' }],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
  });

  assert.equal(result.results[0].status, 'failed');
  assert.match(result.results[0].error ?? '', /source changed between plan and execute/);
  assert.equal(fs.files.has('dst://a.txt'), false);
  assert.equal(fs.files.has('dst://a.txt.tmp'), false);
  // No manifest entry on failure.
  assert.equal(manifest.entries[manifestKey(SOURCE_NAME, 'a.txt')], undefined);
});

test('write failure leaves no tmp; reports per-file failure; following ops still run', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://bad.txt', bytesOf('x'));
  fs.files.set('src://good.txt', bytesOf('y'));
  const xHash = await tagHash(bytesOf('x'));
  const yHash = await tagHash(bytesOf('y'));
  // Write of the tmp will throw; the executor should still attempt good.txt.
  fs.writeErrors.set('dst://bad.txt.tmp', new Error('disk full'));

  const manifest = emptyManifest();
  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [
      { kind: 'create', relPath: 'bad.txt', sourceSize: 1, sourceHash: xHash },
      { kind: 'create', relPath: 'good.txt', sourceSize: 1, sourceHash: yHash },
    ],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
  });

  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].status, 'failed');
  assert.match(result.results[0].error ?? '', /disk full/);
  assert.equal(result.results[1].status, 'ok');
  assert.equal(fs.files.has('dst://bad.txt'), false);
  assert.deepEqual(fs.files.get('dst://good.txt'), bytesOf('y'));
});

test('rename failure cleans up tmp; failure reported with rename error', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://a.txt', bytesOf('hi'));
  const hash = await tagHash(bytesOf('hi'));
  fs.renameErrors.set('dst://a.txt.tmp', new Error('rename forbidden'));

  const manifest = emptyManifest();
  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [{ kind: 'create', relPath: 'a.txt', sourceSize: 2, sourceHash: hash }],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
  });

  assert.equal(result.results[0].status, 'failed');
  assert.match(result.results[0].error ?? '', /rename forbidden/);
  // tmp was cleaned up after the rename failed.
  assert.equal(fs.files.has('dst://a.txt.tmp'), false);
  assert.equal(fs.files.has('dst://a.txt'), false);
});

test('skip items are no-ops — no FS calls, no manifest mutation', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://a.txt', bytesOf('same'));
  fs.files.set('dst://a.txt', bytesOf('same'));
  const hash = await tagHash(bytesOf('same'));
  const manifest = emptyManifest();

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [{ kind: 'skip', relPath: 'a.txt', sourceHash: hash, destHash: hash }],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
  });

  assert.equal(result.results.length, 0);
  assert.equal(fs.ops.length, 0);
  assert.equal(manifest.lastSync, null);
});

test('update-collision and destination-only items are ignored without explicit decisions', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://a.txt', bytesOf('x'));
  fs.files.set('dst://a.txt', bytesOf('y'));
  fs.files.set('dst://orphan.txt', bytesOf('z'));
  const manifest = emptyManifest();

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [
      { kind: 'update-collision', relPath: 'a.txt', sourceHash: tagHashOf('x') },
      { kind: 'destination-only', relPath: 'orphan.txt' },
    ],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
  });

  // Neither op kind is handled; both files remain untouched.
  assert.equal(result.results.length, 0);
  assert.deepEqual(fs.files.get('dst://a.txt'), bytesOf('y'));
  assert.deepEqual(fs.files.get('dst://orphan.txt'), bytesOf('z'));
});

test('update-collision in decidedOverwrites → overwrites destination via tmp+rename', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://a.txt', bytesOf('x'));
  fs.files.set('dst://a.txt', bytesOf('y'));
  const manifest = emptyManifest();

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [
      { kind: 'update-collision', relPath: 'a.txt', sourceHash: tagHashOf('x') },
    ],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
    decidedOverwrites: new Set(['a.txt']),
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].kind, 'update-collision');
  assert.equal(result.results[0].status, 'ok');
  assert.equal(result.counts.updateCollision.ok, 1);
  assert.deepEqual(fs.files.get('dst://a.txt'), bytesOf('x'));
  // Atomic write path used; manifest entry added.
  assert.ok(fs.ops.some((o) => o.startsWith('write dst://a.txt.tmp')));
  assert.ok(fs.ops.some((o) => o.startsWith('rename dst://a.txt.tmp dst://a.txt')));
  assert.ok(manifest.entries[manifestKey(SOURCE_NAME, 'a.txt')]);
});

test('destination-only in decidedDeletes → deletes file, leaves no manifest entry', async () => {
  const fs = makeFakeFs();
  fs.files.set('dst://orphan.txt', bytesOf('z'));
  const manifest = emptyManifest();

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [{ kind: 'destination-only', relPath: 'orphan.txt' }],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
    decidedDeletes: new Set(['orphan.txt']),
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].kind, 'destination-only');
  assert.equal(result.results[0].status, 'ok');
  assert.equal(result.counts.destinationOnly.ok, 1);
  assert.equal(fs.files.has('dst://orphan.txt'), false);
  assert.equal(manifest.entries[manifestKey(SOURCE_NAME, 'orphan.txt')], undefined);
});

test('decidedOverwrites only acts on the listed relPaths', async () => {
  // Two collision items; only one is in the decided set. The other stays put.
  const fs = makeFakeFs();
  fs.files.set('src://a.txt', bytesOf('xa'));
  fs.files.set('dst://a.txt', bytesOf('ya'));
  fs.files.set('src://b.txt', bytesOf('xb'));
  fs.files.set('dst://b.txt', bytesOf('yb'));
  const manifest = emptyManifest();

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [
      { kind: 'update-collision', relPath: 'a.txt', sourceHash: tagHashOf('xa') },
      { kind: 'update-collision', relPath: 'b.txt', sourceHash: tagHashOf('xb') },
    ],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
    decidedOverwrites: new Set(['a.txt']),
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].relPath, 'a.txt');
  assert.deepEqual(fs.files.get('dst://a.txt'), bytesOf('xa'));
  assert.deepEqual(fs.files.get('dst://b.txt'), bytesOf('yb'));
});

// ───── warnings block execution (M5 Phase D) ────────────────────────────
//
// Phase D wires validator warnings into the orange "Proceed with safe items
// only" path. The renderer flips the footer to orange + red when warnings
// are present; the executor enforces "safe items only" by skipping any item
// that carries warnings, regardless of its kind or any armed decision.

const WARN: import('../src/sync/plan').PlanWarning = {
  severity: 'block',
  code: 'show-type',
  message: 'Show type is kiosk',
};
const WARN_OVERRIDABLE: import('../src/sync/plan').PlanWarning = {
  severity: 'override',
  code: 'media-controls',
  message: 'Media controls visible over embedded video',
};

test('Phase D: create item with warnings is skipped', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://kiosk.pptx', bytesOf('K'));
  fs.files.set('src://clean.txt', bytesOf('C'));
  const manifest = emptyManifest();

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [
      { kind: 'create', relPath: 'kiosk.pptx', sourceSize: 1, sourceHash: tagHashOf('K'), warnings: [WARN] },
      { kind: 'create', relPath: 'clean.txt', sourceSize: 1, sourceHash: tagHashOf('C') },
    ],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
  });

  // Only the clean item executed; the warned item is silently skipped.
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].relPath, 'clean.txt');
  assert.equal(result.counts.create.ok, 1);

  // No bytes placed for the warned item; no manifest entry either.
  assert.equal(fs.files.has('dst://kiosk.pptx'), false);
  assert.equal(manifest.entries[manifestKey(SOURCE_NAME, 'kiosk.pptx')], undefined);
  // The warned file's source was never even read — the dispatch filter runs
  // before any FS work.
  assert.ok(!fs.ops.some((o) => o.includes('kiosk.pptx')), 'warned file should not have been touched');
});

test('Phase D: update-tracked item with warnings is skipped', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://a.pptx', bytesOf('NEW'));
  fs.files.set('dst://a.pptx', bytesOf('OLD'));
  const manifest = emptyManifest();

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [
      { kind: 'update-tracked', relPath: 'a.pptx', sourceHash: tagHashOf('NEW'), warnings: [WARN] },
    ],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
  });

  assert.equal(result.results.length, 0);
  // Destination bytes untouched.
  assert.deepEqual(fs.files.get('dst://a.pptx'), bytesOf('OLD'));
});

test('Phase D: armed overwrite on a warned collision still skips', async () => {
  // The user can't override a warning via the decision checkbox — warnings
  // have no per-row affordance. Even when the matching decidedOverwrites
  // entry is present (e.g. the row carried a remembered decision before the
  // warning surfaced), the warning takes precedence and the item is skipped.
  const fs = makeFakeFs();
  fs.files.set('src://a.pptx', bytesOf('x'));
  fs.files.set('dst://a.pptx', bytesOf('y'));
  const manifest = emptyManifest();

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [
      { kind: 'update-collision', relPath: 'a.pptx', sourceHash: tagHashOf('x'), warnings: [WARN] },
    ],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
    decidedOverwrites: new Set(['a.pptx']),
  });

  assert.equal(result.results.length, 0);
  assert.deepEqual(fs.files.get('dst://a.pptx'), bytesOf('y'));
});

// ───── warning-override severity (M5 Phase D-adj) ──────────────────────
//
// Block-severity warnings have no per-row override; the executor refuses
// regardless of any decidedWarningOverrides arming. Override-severity
// warnings (e.g. pptx media-controls + embedded video) can be armed via
// decidedWarningOverrides — only then do they ship. Collision rows with
// override warnings fold the warning arming into the overwrite arming.

test('Phase D-adj: override-severity warning skipped without arming', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://a.pptx', bytesOf('A'));
  const manifest = emptyManifest();

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [
      { kind: 'create', relPath: 'a.pptx', sourceHash: tagHashOf('A'), warnings: [WARN_OVERRIDABLE] },
    ],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
  });

  assert.equal(result.results.length, 0);
  assert.equal(fs.files.has('dst://a.pptx'), false);
});

test('Phase D-adj: override-severity warning ships with arming', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://a.pptx', bytesOf('A'));
  const manifest = emptyManifest();

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [
      { kind: 'create', relPath: 'a.pptx', sourceHash: tagHashOf('A'), warnings: [WARN_OVERRIDABLE] },
    ],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
    decidedWarningOverrides: new Set(['a.pptx']),
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, 'ok');
  assert.deepEqual(fs.files.get('dst://a.pptx'), bytesOf('A'));
});

test('Phase D-adj: block-severity ignores decidedWarningOverrides', async () => {
  // Block trumps. Even when the path is in decidedWarningOverrides (e.g. a
  // stale arming from before the validator surfaced the block-severity
  // issue), the executor refuses.
  const fs = makeFakeFs();
  fs.files.set('src://a.pptx', bytesOf('A'));
  const manifest = emptyManifest();

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [
      { kind: 'create', relPath: 'a.pptx', sourceHash: tagHashOf('A'), warnings: [WARN] },
    ],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
    decidedWarningOverrides: new Set(['a.pptx']),
  });

  assert.equal(result.results.length, 0);
  assert.equal(fs.files.has('dst://a.pptx'), false);
});

test('Phase D-adj: update-collision + override warning ships with overwrite arming only', async () => {
  // Overwrite arming on a collision row implicitly covers an override-
  // severity warning on the same row — no separate decidedWarningOverrides
  // arming is required.
  const fs = makeFakeFs();
  fs.files.set('src://a.pptx', bytesOf('NEW'));
  fs.files.set('dst://a.pptx', bytesOf('OLD'));
  const manifest = emptyManifest();

  const result = await executePlan({
    sourceWorkspaceFolderName: SOURCE_NAME,
    sourceRootUri: SOURCE_ROOT,
    destRootUri: DEST_ROOT,
    destSubpath: '',
    items: [
      {
        kind: 'update-collision',
        relPath: 'a.pptx',
        sourceHash: tagHashOf('NEW'),
        destHash: tagHashOf('OLD'),
        warnings: [WARN_OVERRIDABLE],
      },
    ],
    manifest,
    fs,
    hash: tagHash,
    now: FIXED_NOW,
    decidedOverwrites: new Set(['a.pptx']),
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, 'ok');
  assert.equal(result.results[0].kind, 'update-collision');
  assert.deepEqual(fs.files.get('dst://a.pptx'), bytesOf('NEW'));
});

// ───── runner ────────────────────────────────────────────────────────────

(async (): Promise<void> => {
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
