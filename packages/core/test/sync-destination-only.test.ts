// Tests for the destination-only mode detector (M1).
//
// `isDestinationOnlyTopology` is pure — these tests build small in-memory
// inputs and assert the resulting boolean. No VS Code dependency.
//
// Run with: npm run test:sync-destination-only

import { strict as assert } from 'node:assert';
import {
  isDestinationOnlyTopology,
  type WorkspaceFolderLike,
} from '../src/sync/destinationOnly';
import type { ResolvedTopology } from '../src/sync/topology';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

// Build a minimal topology with N synthetic sources. Only the count matters
// for the detector — internal source shape is irrelevant here.
function topologyWithSourceCount(n: number): Pick<ResolvedTopology<string>, 'sources'> {
  // The detector only reads `sources.length`. Empty objects are enough.
  return { sources: Array.from({ length: n }) as ResolvedTopology<string>['sources'] };
}

function folder(uri: string): WorkspaceFolderLike {
  return { uri: { toString: () => uri } };
}

// ───── core cases from the plan ──────────────────────────────────────────

test('no sources + 1 workspace folder with manifest → true', () => {
  const wsf = [folder('vscode-vfs://github/u/repo')];
  const presence = new Map([['vscode-vfs://github/u/repo', true]]);
  assert.equal(
    isDestinationOnlyTopology(topologyWithSourceCount(0), wsf, presence),
    true,
  );
});

test('no sources + 1 workspace folder without manifest → false', () => {
  const wsf = [folder('vscode-vfs://github/u/repo')];
  const presence = new Map([['vscode-vfs://github/u/repo', false]]);
  assert.equal(
    isDestinationOnlyTopology(topologyWithSourceCount(0), wsf, presence),
    false,
  );
});

test('≥1 source + 1 workspace folder with manifest → false', () => {
  // The whole point of operator mode is that no sources are open. If even
  // one source is mounted, the user is in main-user mode regardless of
  // whatever manifests happen to be lying around.
  const wsf = [folder('vscode-vfs://github/u/repo')];
  const presence = new Map([['vscode-vfs://github/u/repo', true]]);
  assert.equal(
    isDestinationOnlyTopology(topologyWithSourceCount(1), wsf, presence),
    false,
  );
});

test('no sources + 0 workspace folders → false', () => {
  // No workspace folders means the user is in a folderless tab — nothing
  // to inspect, no signal either way. False keeps the source-side UI
  // visible (its own `folderSync.hasAnySource=false` gate handles the
  // useless-button case from the other direction).
  assert.equal(
    isDestinationOnlyTopology(topologyWithSourceCount(0), [], new Map()),
    false,
  );
});

test('no sources + 0 manifests → false', () => {
  const wsf = [folder('vscode-vfs://github/u/repo')];
  assert.equal(
    isDestinationOnlyTopology(topologyWithSourceCount(0), wsf, new Map()),
    false,
  );
});

test('multiple workspace folders, manifest in any one → true', () => {
  const wsf = [
    folder('vscode-vfs://github/u/repo-a'),
    folder('vscode-vfs://github/u/repo-b'),
    folder('vscode-vfs://github/u/repo-c'),
  ];
  const presence = new Map([
    ['vscode-vfs://github/u/repo-a', false],
    ['vscode-vfs://github/u/repo-b', true],
    ['vscode-vfs://github/u/repo-c', false],
  ]);
  assert.equal(
    isDestinationOnlyTopology(topologyWithSourceCount(0), wsf, presence),
    true,
  );
});

test('multiple workspace folders, manifest in none → false', () => {
  const wsf = [
    folder('vscode-vfs://github/u/repo-a'),
    folder('vscode-vfs://github/u/repo-b'),
  ];
  const presence = new Map([
    ['vscode-vfs://github/u/repo-a', false],
    ['vscode-vfs://github/u/repo-b', false],
  ]);
  assert.equal(
    isDestinationOnlyTopology(topologyWithSourceCount(0), wsf, presence),
    false,
  );
});

// ───── defensive cases — stale entries, missing entries ──────────────────

test('stale manifest entry for non-workspace folder is ignored', () => {
  // The presence map can briefly hold an entry for a folder that's no
  // longer in the workspace (between a folder-remove event and the next
  // rescan). The detector filters by current workspaceFolders, so the
  // stale entry can't keep operator mode latched on.
  const wsf = [folder('vscode-vfs://github/u/current')];
  const presence = new Map([
    ['vscode-vfs://github/u/removed', true],
    ['vscode-vfs://github/u/current', false],
  ]);
  assert.equal(
    isDestinationOnlyTopology(topologyWithSourceCount(0), wsf, presence),
    false,
  );
});

test('missing presence entry for a workspace folder defaults to absent', () => {
  // If the wired layer hasn't yet stat'd a freshly-added folder, its key
  // isn't in the map. The detector treats that the same as "no manifest"
  // — the recompute that runs after the scan completes will flip true
  // later if the manifest is in fact there.
  const wsf = [folder('vscode-vfs://github/u/repo')];
  assert.equal(
    isDestinationOnlyTopology(topologyWithSourceCount(0), wsf, new Map()),
    false,
  );
});

test('one workspace folder has manifest, others have stale-removed entries → true', () => {
  // Combines the two defensive cases: stale entries are filtered out, but
  // the real entry for a current folder still triggers operator mode.
  const wsf = [folder('vscode-vfs://github/u/current')];
  const presence = new Map([
    ['vscode-vfs://github/u/removed-a', true],
    ['vscode-vfs://github/u/removed-b', true],
    ['vscode-vfs://github/u/current', true],
  ]);
  assert.equal(
    isDestinationOnlyTopology(topologyWithSourceCount(0), wsf, presence),
    true,
  );
});

// ───── runner ────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err);
  }
}
if (failed > 0) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log(`all ${tests.length} tests passed`);
