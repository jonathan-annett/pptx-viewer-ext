// Smoke tests for the pure source-config-filename helpers — the glob,
// the parent-path extractor, and the conflict-partitioner.
//
// Pure module so we can drive it with bare `{ path: string }` literals —
// no vscode shim needed. Run with: npm run test:sync-config-filenames

import { strict as assert } from 'node:assert';
import {
  SYNC_CONFIG_FILENAMES,
  SYNC_CONFIG_GLOB,
  configFilenameFromUri,
  isNamedRoomSyncFilename,
  isSyncConfigFilename,
  isWorkspaceRootNamedConfig,
  parentPathOf,
  partitionConfigUris,
  roomSyncHandle,
} from '../src/sync/configFilenames';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

// ───── filename helpers ────────────────────────────────────────────────

test('SYNC_CONFIG_FILENAMES lists both honoured names', () => {
  // Order matters here: legacy first, then the forward alias. The
  // partitioner doesn't depend on order, but stability helps when this
  // constant ends up in user-facing copy.
  assert.deepEqual(Array.from(SYNC_CONFIG_FILENAMES), ['.sync.jsonc', '.roomSync']);
});

test('SYNC_CONFIG_GLOB matches every honoured filename via brace expansion', () => {
  // Lock the literal — schema registration, watcher, findFiles, and the
  // source-intent probes all share this glob. A regression that drops
  // one alternative would silently hide configs from discovery. The
  // M3-named `*.roomSync` files are matched here too; the workspace-root
  // requirement is enforced post-discovery in the manager.
  assert.equal(SYNC_CONFIG_GLOB, '**/{.sync.jsonc,.roomSync,*.roomSync}');
});

test('isSyncConfigFilename recognises both names, rejects others', () => {
  assert.ok(isSyncConfigFilename('.sync.jsonc'));
  assert.ok(isSyncConfigFilename('.roomSync'));
  assert.ok(!isSyncConfigFilename('.roomsync'));
  assert.ok(!isSyncConfigFilename('sync.jsonc'));
  assert.ok(!isSyncConfigFilename('.foldersync-manifest.json'));
});

test('configFilenameFromUri strips the path prefix', () => {
  assert.equal(configFilenameFromUri({ path: '/a/b/.sync.jsonc' }), '.sync.jsonc');
  assert.equal(configFilenameFromUri({ path: '/a/b/.roomSync' }), '.roomSync');
  assert.equal(configFilenameFromUri({ path: '.roomSync' }), '.roomSync');
});

test('parentPathOf returns the folder portion of a URI path', () => {
  assert.equal(parentPathOf({ path: '/work/room1/.sync.jsonc' }), '/work/room1');
  assert.equal(parentPathOf({ path: '/.sync.jsonc' }), '/');
  assert.equal(parentPathOf({ path: '.sync.jsonc' }), '.sync.jsonc');
});

// ───── partitionConfigUris ────────────────────────────────────────────

test('single config per folder → kept, no conflicts', () => {
  const input = [
    { path: '/a/.sync.jsonc' },
    { path: '/b/.roomSync' },
  ];
  const { keep, conflicts } = partitionConfigUris(input);
  assert.equal(conflicts.length, 0);
  assert.equal(keep.length, 2);
});

test('same folder with both names → .roomSync kept, conflict recorded', () => {
  // The deterministic-winner choice (`.roomSync`) is part of the M1
  // contract — it means the topology still loads in a useful state when
  // a conflict is detected, and the user has zero "broken sync" downtime
  // while they decide which file to keep.
  const legacy = { path: '/work/room1/.sync.jsonc' };
  const roomSync = { path: '/work/room1/.roomSync' };
  const { keep, conflicts } = partitionConfigUris([legacy, roomSync]);
  assert.equal(keep.length, 1);
  assert.equal(keep[0], roomSync, '.roomSync wins');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].parentPath, '/work/room1');
  assert.equal(conflicts[0].legacy, legacy);
  assert.equal(conflicts[0].roomSync, roomSync);
});

test('input order doesn’t affect conflict identification', () => {
  // legacy listed after roomSync should still pair correctly — findFiles
  // doesn't promise any particular order.
  const legacy = { path: '/work/room1/.sync.jsonc' };
  const roomSync = { path: '/work/room1/.roomSync' };
  const { keep, conflicts } = partitionConfigUris([roomSync, legacy]);
  assert.equal(keep.length, 1);
  assert.equal(keep[0], roomSync);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].legacy, legacy);
});

test('multiple folders with conflicts each get their own record', () => {
  const input = [
    { path: '/work/room1/.sync.jsonc' },
    { path: '/work/room1/.roomSync' },
    { path: '/work/room2/.sync.jsonc' },
    { path: '/work/room2/.roomSync' },
    { path: '/work/room3/.roomSync' },
  ];
  const { keep, conflicts } = partitionConfigUris(input);
  assert.equal(conflicts.length, 2);
  assert.equal(keep.length, 3); // 2 winners + 1 standalone
  const parents = conflicts.map((c) => c.parentPath).sort();
  assert.deepEqual(parents, ['/work/room1', '/work/room2']);
});

test('grouping is by parent folder, not by name prefix', () => {
  // /work/room1 and /work/room10 must be distinct groups — naive
  // prefix-string comparison would lump them together.
  const input = [
    { path: '/work/room1/.sync.jsonc' },
    { path: '/work/room10/.roomSync' },
  ];
  const { keep, conflicts } = partitionConfigUris(input);
  assert.equal(conflicts.length, 0);
  assert.equal(keep.length, 2);
});

test('three+ files in one folder is pathological — all kept, no conflict', () => {
  // The honoured glob only matches two filenames so this branch is
  // effectively dead. Still: lock the defensive behaviour so a future
  // glob extension doesn't silently change semantics.
  const a = { path: '/x/.sync.jsonc' };
  const b = { path: '/x/.roomSync' };
  const c = { path: '/x/.future' };
  const { keep, conflicts } = partitionConfigUris([a, b, c]);
  assert.equal(conflicts.length, 0);
  assert.equal(keep.length, 3);
});

test('empty input → empty output', () => {
  const { keep, conflicts } = partitionConfigUris([]);
  assert.equal(keep.length, 0);
  assert.equal(conflicts.length, 0);
});

// ───── workspace-root named configs (M3) ──────────────────────────────

test('isNamedRoomSyncFilename identifies the named variant only', () => {
  assert.ok(isNamedRoomSyncFilename('Room1.roomSync'));
  assert.ok(isNamedRoomSyncFilename('Stage Left.roomSync'));
  // Bare `.roomSync` is the folder-level variant — not "named".
  assert.ok(!isNamedRoomSyncFilename('.roomSync'));
  // Legacy and unrelated names must not match.
  assert.ok(!isNamedRoomSyncFilename('.sync.jsonc'));
  assert.ok(!isNamedRoomSyncFilename('roomSync'));
  assert.ok(!isNamedRoomSyncFilename('Room1.roomsync')); // case-sensitive
  // Suffix-only-but-not-extension shouldn't match — defensive.
  assert.ok(!isNamedRoomSyncFilename('something.roomSync.bak'));
});

test('isWorkspaceRootNamedConfig accepts a named config directly under the ws folder', () => {
  // Trailing-slash and no-trailing-slash workspace folder paths should
  // both resolve correctly — vscode.Uri may carry either shape depending
  // on the source URI scheme.
  assert.ok(isWorkspaceRootNamedConfig('/ws/Room1.roomSync', '/ws'));
  assert.ok(isWorkspaceRootNamedConfig('/ws/Room1.roomSync', '/ws/'));
});

test('isWorkspaceRootNamedConfig rejects the bare .roomSync at ws root', () => {
  // The bare .roomSync at workspace root is the legacy "this folder is the
  // source" semantics — path-aliases is optional there, so the M3
  // mandatory-aliases validation must NOT fire on it.
  assert.ok(!isWorkspaceRootNamedConfig('/ws/.roomSync', '/ws'));
});

test('isWorkspaceRootNamedConfig rejects a named .roomSync in a sub-folder', () => {
  // Nested below the workspace root → legacy folder-level semantics, even
  // though the filename looks named. The mandatory-aliases rule only
  // applies at the workspace folder root.
  assert.ok(!isWorkspaceRootNamedConfig('/ws/sub/Room1.roomSync', '/ws'));
});

test('isWorkspaceRootNamedConfig rejects .sync.jsonc at ws root', () => {
  // The named-variant rule only applies to .roomSync — the legacy
  // .sync.jsonc filename never carries M3 semantics.
  assert.ok(!isWorkspaceRootNamedConfig('/ws/.sync.jsonc', '/ws'));
});

// ───── roomSyncHandle (v1 follow-up: ${roomSync} template variable) ──────

test('roomSyncHandle: workspace-root named .roomSync → filename prefix', () => {
  // The M3 logical-destination case: the prefix is the handle that the
  // generator embeds into the template, so the resolved handle exactly
  // matches the prefix used to name the file.
  assert.equal(roomSyncHandle('/ws/breakout-1.roomSync', '/ws'), 'breakout-1');
  assert.equal(roomSyncHandle('/ws/Room 1.roomSync', '/ws'), 'Room 1');
});

test('roomSyncHandle: handles trailing slash on workspace folder path', () => {
  // vscode.Uri.path may or may not carry a trailing slash depending on the
  // URI scheme — the helper must normalise.
  assert.equal(roomSyncHandle('/ws/breakout-1.roomSync', '/ws/'), 'breakout-1');
});

test('roomSyncHandle: folder-level .sync.jsonc → enclosing folder basename', () => {
  // The most common authoring case: the folder *is* the source, named
  // after the room. The variable resolves to the room name.
  assert.equal(
    roomSyncHandle('/ws/Events/Room 1/.sync.jsonc', '/ws'),
    'Room 1',
  );
});

test('roomSyncHandle: folder-level .roomSync → enclosing folder basename', () => {
  // Same as above but with the forward alias filename.
  assert.equal(
    roomSyncHandle('/ws/Mon-Stage/.roomSync', '/ws'),
    'Mon-Stage',
  );
});

test('roomSyncHandle: bare .sync.jsonc at workspace root → workspace folder name', () => {
  // Edge case: workspace folder *is* the source. The handle is the
  // workspace folder's basename — predictable, even if rarely used.
  assert.equal(roomSyncHandle('/ws/.sync.jsonc', '/ws'), 'ws');
});

test('roomSyncHandle: bare .roomSync at workspace root → workspace folder name', () => {
  assert.equal(roomSyncHandle('/work/projects/.roomSync', '/work/projects'), 'projects');
});

test('roomSyncHandle: deeply nested folder-level config', () => {
  // Doesn't matter how deep — the enclosing folder's basename is the handle.
  assert.equal(
    roomSyncHandle('/ws/a/b/c/Room-7/.sync.jsonc', '/ws'),
    'Room-7',
  );
});

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
