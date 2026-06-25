// Tests for placeholder-aware indexing in src/search/searchEngine.ts.
// Run with: npm run test:search-placeholder-index
//
// Regression: zero-byte / registered-placeholder stubs are byte-identical,
// so a content-sha-keyed index collapsed them into ONE entry and only the
// last-indexed filename survived. With `setPlaceholderShas`, placeholders
// are keyed per-URI so each keeps its own filename and is independently
// findable; real (non-placeholder) content still dedupes by sha.

import { strict as assert } from 'node:assert';
import {
  SEARCH_PROJECTION_SCHEMA_VERSION,
  type SearchProjection,
} from '../src/search/index-types';
import { createSearchEngine } from '../src/search/searchEngine';

// The empty-file sha (the always-present placeholder member). Any sha works
// for the test — what matters is that it's in the injected placeholder set.
const STUB_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const REAL_SHA = 'a'.repeat(64);

function proj(overrides: Partial<SearchProjection> & { sha256: string }): SearchProjection {
  const filename = overrides.filename ?? 'deck.pptx';
  return {
    sha256: overrides.sha256,
    filename,
    displayFilename: overrides.displayFilename ?? filename,
    author: overrides.author ?? '',
    displayAuthor: overrides.displayAuthor ?? '',
    slideText: overrides.slideText ?? '',
    filenameTokens: overrides.filenameTokens ?? filename.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
    authorTokens: overrides.authorTokens ?? [],
    slideTextTokens: overrides.slideTextTokens ?? [],
    sizeBytes: overrides.sizeBytes ?? 0,
    mtime: overrides.mtime ?? 1700000000000,
    schemaVersion: SEARCH_PROJECTION_SCHEMA_VERSION,
  };
}

// ── Two placeholders with the same sha + different filenames stay distinct ──
function test_placeholders_indexed_per_uri(): void {
  const e = createSearchEngine();
  e.setPlaceholderShas(new Set([STUB_SHA]));
  e.addOrUpdate('file:///mon/room1/0900-alice.pptx', proj({ sha256: STUB_SHA, filename: 'mon room1 0900 alice.pptx' }));
  e.addOrUpdate('file:///tue/room2/1000-bob.pptx', proj({ sha256: STUB_SHA, filename: 'tue room2 1000 bob.pptx' }));

  // Each is findable by its OWN distinct filename token.
  const alice = e.search('alice');
  assert.equal(alice.length, 1, 'exactly one hit for "alice"');
  assert.equal(alice[0].displayFilename, 'mon room1 0900 alice.pptx');
  assert.equal(alice[0].isPlaceholder, true, 'alice hit marked placeholder');
  assert.deepEqual(alice[0].uris, ['file:///mon/room1/0900-alice.pptx'], 'single uri, not fanned to bob');

  const bob = e.search('bob');
  assert.equal(bob.length, 1, 'exactly one hit for "bob"');
  assert.equal(bob[0].displayFilename, 'tue room2 1000 bob.pptx');
  assert.equal(bob[0].isPlaceholder, true);

  // A token unique to one placeholder returns only that one.
  assert.equal(e.search('mon').length, 1, '"mon" unique to alice');
  assert.equal(e.search('tue').length, 1, '"tue" unique to bob');
  // A shared token surfaces BOTH as separate hits (not one merged entry).
  const both = e.search('pptx');
  assert.equal(both.length, 2, 'shared token returns both placeholders as distinct hits');
}

// ── Without registering the sha, same-sha files collapse (the old bug) ──
function test_unregistered_same_sha_dedupes(): void {
  const e = createSearchEngine();
  // placeholder set NOT set → STUB_SHA treated as ordinary content.
  e.addOrUpdate('file:///a/alice.pptx', proj({ sha256: STUB_SHA, filename: 'alice.pptx' }));
  e.addOrUpdate('file:///b/bob.pptx', proj({ sha256: STUB_SHA, filename: 'bob.pptx' }));
  // Last write wins the single projection; first filename is lost.
  assert.equal(e.search('alice').length, 0, 'first filename not findable (content-deduped)');
  const bob = e.search('bob');
  assert.equal(bob.length, 1);
  assert.equal(bob[0].uris.length, 2, 'one hit fanned across both uris');
  assert.ok(!bob[0].isPlaceholder, 'not marked placeholder when sha unregistered');
}

// ── Real (non-placeholder) content still dedupes by sha ──
function test_real_content_still_dedupes(): void {
  const e = createSearchEngine();
  e.setPlaceholderShas(new Set([STUB_SHA])); // STUB registered, REAL is not
  e.addOrUpdate('file:///x/report.pptx', proj({ sha256: REAL_SHA, filename: 'report.pptx' }));
  e.addOrUpdate('file:///y/report-copy.pptx', proj({ sha256: REAL_SHA, filename: 'report.pptx' }));
  const hits = e.search('report');
  assert.equal(hits.length, 1, 'identical real content → one hit');
  assert.equal(hits[0].uris.length, 2, 'with both locations');
  assert.ok(!hits[0].isPlaceholder);
}

// ── removeUri drops only the one placeholder; IDB-retention sha check holds ──
function test_remove_one_placeholder_keeps_others(): void {
  const e = createSearchEngine();
  e.setPlaceholderShas(new Set([STUB_SHA]));
  e.addOrUpdate('file:///a.pptx', proj({ sha256: STUB_SHA, filename: 'a alpha.pptx' }));
  e.addOrUpdate('file:///b.pptx', proj({ sha256: STUB_SHA, filename: 'b bravo.pptx' }));
  e.removeUri('file:///a.pptx');
  assert.equal(e.search('alpha').length, 0, 'removed placeholder gone');
  assert.equal(e.search('bravo').length, 1, 'sibling placeholder retained');
  // getProjection(sha) is "does ANY projection with this sha exist?" — still
  // true while a sibling placeholder remains (so the shared IDB record stays).
  assert.ok(e.getProjection(STUB_SHA), 'sha still present while a sibling remains');
  e.removeUri('file:///b.pptx');
  assert.equal(e.getProjection(STUB_SHA), undefined, 'sha gone after the last placeholder');
}

// ── load() skips placeholder seeds so no stale empty-uris hit appears ──
function test_load_skips_placeholder_seed(): void {
  const e = createSearchEngine();
  e.setPlaceholderShas(new Set([STUB_SHA]));
  // A warm-load from IDB carries one sha-keyed placeholder projection.
  e.load([proj({ sha256: STUB_SHA, filename: 'stale.pptx' })]);
  assert.equal(e.search('stale').length, 0, 'placeholder seed not surfaced as an empty-uris hit');
  // After the walk re-asserts per-URI, the real filename is findable.
  e.addOrUpdate('file:///live.pptx', proj({ sha256: STUB_SHA, filename: 'live now.pptx' }));
  const hits = e.search('live');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].uris, ['file:///live.pptx']);
}

function main(): void {
  console.log('placeholder indexing:');
  test_placeholders_indexed_per_uri();
  test_unregistered_same_sha_dedupes();
  test_real_content_still_dedupes();
  test_remove_one_placeholder_keeps_others();
  test_load_skips_placeholder_seed();
  console.log('all search-placeholder-index tests passed');
}

main();
