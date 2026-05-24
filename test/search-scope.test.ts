// Tests for src/search/scope.ts.
// Run with: npm run test:search-scope

import { strict as assert } from 'node:assert';
import type { SearchHit } from '../src/search/index-types';
import {
  computeSearchScope,
  groupHitsByFolder,
  isUnderFirstScopeFolder,
  isUnderScope,
  urisLeavingScope,
} from '../src/search/scope';

function makeHit(overrides: Partial<SearchHit> & { sha256: string; uris: string[] }): SearchHit {
  return {
    sha256: overrides.sha256,
    uris: overrides.uris,
    filename: overrides.filename ?? 'deck.pptx',
    displayFilename: overrides.displayFilename ?? overrides.filename ?? 'deck.pptx',
    author: overrides.author ?? '',
    displayAuthor: overrides.displayAuthor ?? overrides.author ?? '',
    score: overrides.score ?? 1,
    matchedFields: overrides.matchedFields ?? ['filename'],
  };
}

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

// ───── isUnderFirstScopeFolder ───────────────────────────────────────────

function test_under_first_basic(): void {
  const scope = {
    folderUris: ['file:///work/canonical', 'file:///work/staging'],
  };
  assert.equal(
    isUnderFirstScopeFolder(scope, 'file:///work/canonical/deck.pdf'),
    true,
  );
  assert.equal(
    isUnderFirstScopeFolder(scope, 'file:///work/staging/deck.pdf'),
    false,
  );
  console.log('  ok: classifies URIs relative to the first scope folder');
}

function test_under_first_empty_scope(): void {
  assert.equal(
    isUnderFirstScopeFolder({ folderUris: [] }, 'file:///work/canonical/deck.pdf'),
    false,
  );
  console.log('  ok: empty scope → never "under first folder"');
}

function test_under_first_trailing_slash_guard(): void {
  // Same trailing-slash guard as isUnderScope — /work/foo must not match
  // a URI living under /work/foobar.
  const scope = { folderUris: ['file:///work/foo', 'file:///work/bar'] };
  assert.equal(
    isUnderFirstScopeFolder(scope, 'file:///work/foobar/deck.pdf'),
    false,
  );
  assert.equal(
    isUnderFirstScopeFolder(scope, 'file:///work/foo/deck.pdf'),
    true,
  );
  console.log('  ok: trailing-slash guard prevents prefix-name collisions');
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

// ───── groupHitsByFolder ─────────────────────────────────────────────────

function test_group_preserves_scope_order(): void {
  // Hits supplied B-folder-first, but scope order is A then B.
  // Groups must come out in scope order regardless of hit order.
  const scope = {
    folderUris: ['file:///work/A', 'file:///work/B'],
  };
  const hits = [
    makeHit({ sha256: 'b'.repeat(64), uris: ['file:///work/B/x.pptx'] }),
    makeHit({ sha256: 'a'.repeat(64), uris: ['file:///work/A/y.pptx'] }),
  ];
  const groups = groupHitsByFolder(hits, scope);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].folderUri, 'file:///work/A');
  assert.equal(groups[0].hits.length, 1);
  assert.equal(groups[0].hits[0].sha256, 'a'.repeat(64));
  assert.equal(groups[1].folderUri, 'file:///work/B');
  console.log('  ok: groups returned in scope folder order, not hit order');
}

function test_group_label_decodes_basename(): void {
  const scope = { folderUris: ['file:///Speakers%20Prep'] };
  const hits = [makeHit({ sha256: 'a'.repeat(64), uris: ['file:///Speakers%20Prep/x.pptx'] })];
  const groups = groupHitsByFolder(hits, scope);
  assert.equal(groups[0].folderLabel, 'Speakers Prep');
  console.log('  ok: folder label is decoded basename of the URI');
}

function test_group_empty_buckets_dropped(): void {
  // A and C in scope, but every hit is in C. A produces no header.
  const scope = {
    folderUris: ['file:///work/A', 'file:///work/C'],
  };
  const hits = [
    makeHit({ sha256: 'c'.repeat(64), uris: ['file:///work/C/x.pptx'] }),
  ];
  const groups = groupHitsByFolder(hits, scope);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].folderUri, 'file:///work/C');
  console.log('  ok: empty buckets dropped from output');
}

function test_group_no_hits(): void {
  const groups = groupHitsByFolder([], { folderUris: ['file:///work/A'] });
  assert.deepEqual(groups, []);
  console.log('  ok: empty hits → empty groups');
}

function test_group_fans_out_across_folders(): void {
  // A deck copied byte-for-byte into two source folders comes back as one
  // hit (deduped by sha) with two URIs. The user expects to see the file
  // under BOTH folder headers — so the helper fans the hit out, with each
  // per-folder copy showing only the URI that lives in that folder.
  const scope = {
    folderUris: ['file:///work/A', 'file:///work/B'],
  };
  const hits = [
    makeHit({
      sha256: 'a'.repeat(64),
      uris: ['file:///work/A/deck.pptx', 'file:///work/B/deck.pptx'],
    }),
  ];
  const groups = groupHitsByFolder(hits, scope);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].folderUri, 'file:///work/A');
  assert.deepEqual(groups[0].hits[0].uris, ['file:///work/A/deck.pptx']);
  assert.equal(groups[1].folderUri, 'file:///work/B');
  assert.deepEqual(groups[1].hits[0].uris, ['file:///work/B/deck.pptx']);
  // Both copies share the same sha — same underlying file, just shown
  // twice because it lives in two folders.
  assert.equal(groups[0].hits[0].sha256, groups[1].hits[0].sha256);
  console.log('  ok: duplicate-content hit fans out into both folder buckets');
}

function test_group_single_uri_does_not_fan_out(): void {
  // Most hits have one URI — they should land in exactly one bucket, not
  // duplicated anywhere.
  const scope = {
    folderUris: ['file:///work/A', 'file:///work/B'],
  };
  const hits = [
    makeHit({ sha256: 'a'.repeat(64), uris: ['file:///work/A/x.pptx'] }),
  ];
  const groups = groupHitsByFolder(hits, scope);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].folderUri, 'file:///work/A');
  console.log('  ok: single-URI hit stays in one bucket');
}

function test_group_longest_prefix_wins(): void {
  // Nested scope folders (rare). The longer prefix should win so files
  // inside the nested folder bucket there, not in the outer one.
  const scope = {
    folderUris: ['file:///work', 'file:///work/inner'],
  };
  const hits = [
    makeHit({ sha256: 'n'.repeat(64), uris: ['file:///work/inner/x.pptx'] }),
    makeHit({ sha256: 'o'.repeat(64), uris: ['file:///work/outer.pptx'] }),
  ];
  const groups = groupHitsByFolder(hits, scope);
  // Two non-empty groups, in scope order.
  assert.equal(groups.length, 2);
  assert.equal(groups[0].folderUri, 'file:///work');
  assert.equal(groups[0].hits[0].sha256, 'o'.repeat(64));
  assert.equal(groups[1].folderUri, 'file:///work/inner');
  assert.equal(groups[1].hits[0].sha256, 'n'.repeat(64));
  console.log('  ok: longest matching prefix wins for nested scope folders');
}

function test_group_uri_outside_scope_goes_to_other(): void {
  // Defensive: a hit whose URI doesn't match any scope folder lands in
  // a synthetic "(other)" group at the end so we never silently drop rows.
  const scope = { folderUris: ['file:///work/A'] };
  const hits = [
    makeHit({ sha256: 'a'.repeat(64), uris: ['file:///work/A/x.pptx'] }),
    makeHit({ sha256: 'o'.repeat(64), uris: ['file:///elsewhere/y.pptx'] }),
  ];
  const groups = groupHitsByFolder(hits, scope);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].folderUri, 'file:///work/A');
  assert.equal(groups[1].folderUri, '');
  assert.equal(groups[1].folderLabel, '(other)');
  assert.equal(groups[1].hits[0].sha256, 'o'.repeat(64));
  console.log('  ok: unmatched URI goes to synthetic (other) group');
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
  ['isUnderFirstScopeFolder: basic', test_under_first_basic],
  ['isUnderFirstScopeFolder: empty scope', test_under_first_empty_scope],
  ['isUnderFirstScopeFolder: trailing-slash guard', test_under_first_trailing_slash_guard],
  ['urisLeavingScope: dest promotion evicts', test_evictions_after_dest_promotion],
  ['urisLeavingScope: empty when unchanged', test_evictions_empty_when_unchanged],
  ['groupHitsByFolder: scope order preserved', test_group_preserves_scope_order],
  ['groupHitsByFolder: label decodes URI', test_group_label_decodes_basename],
  ['groupHitsByFolder: empty buckets dropped', test_group_empty_buckets_dropped],
  ['groupHitsByFolder: empty hits → no groups', test_group_no_hits],
  ['groupHitsByFolder: duplicate content fans out', test_group_fans_out_across_folders],
  ['groupHitsByFolder: single URI stays in one bucket', test_group_single_uri_does_not_fan_out],
  ['groupHitsByFolder: longest prefix wins', test_group_longest_prefix_wins],
  ['groupHitsByFolder: orphan → (other)', test_group_uri_outside_scope_goes_to_other],
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
