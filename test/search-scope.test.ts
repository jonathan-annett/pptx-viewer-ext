// Tests for src/search/scope.ts.
// Run with: npm run test:search-scope

import { strict as assert } from 'node:assert';
import {
  computeSearchScope,
  isUnderScope,
  urisLeavingScope,
} from '../src/search/scope';

// ───── computeSearchScope ────────────────────────────────────────────────

function test_compute_excludes_destinations(): void {
  const scope = computeSearchScope({
    workspaceFolderUris: [
      'file:///work/source',
      'file:///work/mirror',
      'file:///work/notes',
    ],
    destinationWorkspaceFolderUris: ['file:///work/mirror'],
  });
  assert.deepEqual(scope.folderUris, ['file:///work/source', 'file:///work/notes']);
  console.log('  ok: destination folder excluded from scope');
}

function test_compute_no_destinations(): void {
  const scope = computeSearchScope({
    workspaceFolderUris: ['file:///work/a', 'file:///work/b'],
    destinationWorkspaceFolderUris: [],
  });
  assert.deepEqual(scope.folderUris, ['file:///work/a', 'file:///work/b']);
  console.log('  ok: empty destinations → every folder in scope');
}

function test_compute_folder_is_both(): void {
  // Per plan: "if a folder is *anywhere* a destination, it's excluded".
  // Even when the same folder is also a source elsewhere.
  const scope = computeSearchScope({
    workspaceFolderUris: ['file:///work/dual', 'file:///work/other'],
    destinationWorkspaceFolderUris: ['file:///work/dual'],
  });
  assert.deepEqual(scope.folderUris, ['file:///work/other']);
  console.log('  ok: folder that is both source + destination → excluded');
}

function test_compute_preserves_order(): void {
  // Stable iteration matters for the indexer's deterministic walks.
  const scope = computeSearchScope({
    workspaceFolderUris: ['file:///b', 'file:///a', 'file:///c'],
    destinationWorkspaceFolderUris: [],
  });
  assert.deepEqual(scope.folderUris, ['file:///b', 'file:///a', 'file:///c']);
  console.log('  ok: folder order from workspaceFolders preserved');
}

// ───── isUnderScope ──────────────────────────────────────────────────────

function test_under_scope_basic(): void {
  const scope = { folderUris: ['file:///work/source'] };
  assert.equal(isUnderScope(scope, 'file:///work/source/deck.pptx'), true);
  assert.equal(isUnderScope(scope, 'file:///work/source/sub/deck.pptx'), true);
  assert.equal(isUnderScope(scope, 'file:///work/other/deck.pptx'), false);
  console.log('  ok: under-scope detects child files, rejects siblings');
}

function test_under_scope_trailing_slash_guard(): void {
  // Without the trailing-slash guard, /work/foo would match /work/foobar.
  const scope = { folderUris: ['file:///work/foo'] };
  assert.equal(isUnderScope(scope, 'file:///work/foobar/deck.pptx'), false);
  assert.equal(isUnderScope(scope, 'file:///work/foo/deck.pptx'), true);
  console.log('  ok: prefix match requires path separator');
}

function test_under_scope_handles_folder_with_trailing_slash(): void {
  const scope = { folderUris: ['file:///work/source/'] };
  assert.equal(isUnderScope(scope, 'file:///work/source/deck.pptx'), true);
  console.log('  ok: folder URI with trailing slash still matches children');
}

function test_under_scope_empty(): void {
  const scope = { folderUris: [] };
  assert.equal(isUnderScope(scope, 'file:///work/source/deck.pptx'), false);
  console.log('  ok: empty scope → nothing in scope');
}

// ───── urisLeavingScope ──────────────────────────────────────────────────

function test_evictions_after_dest_promotion(): void {
  // Workspace had /work/a in scope; now /work/a became a destination, so
  // its files need to be evicted from the engine. /work/b stays.
  const evict = urisLeavingScope(
    { folderUris: ['file:///work/b'] },
    [
      'file:///work/a/deck1.pptx',
      'file:///work/a/sub/deck2.pptx',
      'file:///work/b/deck3.pptx',
    ],
  );
  assert.deepEqual(evict, [
    'file:///work/a/deck1.pptx',
    'file:///work/a/sub/deck2.pptx',
  ]);
  console.log('  ok: files in newly-excluded folder are returned for eviction');
}

function test_evictions_empty_when_unchanged(): void {
  const evict = urisLeavingScope(
    { folderUris: ['file:///work/a'] },
    ['file:///work/a/deck.pptx'],
  );
  assert.deepEqual(evict, []);
  console.log('  ok: no evictions when scope still covers all URIs');
}

// ───── runner ────────────────────────────────────────────────────────────

const tests: Array<[string, () => void]> = [
  ['computeSearchScope: excludes destinations', test_compute_excludes_destinations],
  ['computeSearchScope: no destinations', test_compute_no_destinations],
  ['computeSearchScope: dual-role folder excluded', test_compute_folder_is_both],
  ['computeSearchScope: preserves folder order', test_compute_preserves_order],
  ['isUnderScope: basic', test_under_scope_basic],
  ['isUnderScope: trailing-slash guard', test_under_scope_trailing_slash_guard],
  ['isUnderScope: folder with trailing slash', test_under_scope_handles_folder_with_trailing_slash],
  ['isUnderScope: empty scope', test_under_scope_empty],
  ['urisLeavingScope: dest promotion evicts', test_evictions_after_dest_promotion],
  ['urisLeavingScope: empty when unchanged', test_evictions_empty_when_unchanged],
];

let failed = 0;
for (const [name, fn] of tests) {
  console.log(`▶ ${name}`);
  try {
    fn();
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log(`\nAll ${tests.length} test(s) passed`);
}
