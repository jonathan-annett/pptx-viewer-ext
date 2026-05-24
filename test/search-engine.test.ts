// Tests for src/search/searchEngine.ts.
// Run with: npm run test:search-engine

import { strict as assert } from 'node:assert';
import {
  SEARCH_PROJECTION_SCHEMA_VERSION,
  type SearchProjection,
} from '../src/search/index-types';
import {
  createSearchEngine,
  parseQuery,
} from '../src/search/searchEngine';

// Build a projection with sensible defaults. The fields are already
// "folded" because the engine doesn't fold — that happens at projection
// build time. Tests deal in already-lowercased strings.
function proj(overrides: Partial<SearchProjection> & { sha256: string }): SearchProjection {
  return {
    sha256: overrides.sha256,
    filename: overrides.filename ?? 'deck.pptx',
    displayFilename: overrides.displayFilename ?? overrides.filename ?? 'deck.pptx',
    author: overrides.author ?? 'alice',
    displayAuthor: overrides.displayAuthor ?? overrides.author ?? 'alice',
    slideText: overrides.slideText ?? '',
    filenameTokens: overrides.filenameTokens ?? ['deck', 'pptx'],
    authorTokens: overrides.authorTokens ?? ['alice'],
    slideTextTokens: overrides.slideTextTokens ?? [],
    sizeBytes: overrides.sizeBytes ?? 1024,
    mtime: overrides.mtime ?? 1700000000000,
    schemaVersion: SEARCH_PROJECTION_SCHEMA_VERSION,
  };
}

// ───── parseQuery ────────────────────────────────────────────────────────

function test_parse_query_empty(): void {
  const q = parseQuery('');
  assert.equal(q.raw, '');
  assert.deepEqual(q.terms, []);
  const q2 = parseQuery('   ');
  assert.deepEqual(q2.terms, []);
  console.log('  ok: empty / whitespace query → no terms');
}

function test_parse_query_folds_and_splits(): void {
  // Punctuation + camelCase + diacritics — all the things the tokeniser
  // handles for projection fields should work the same on the query side.
  const q = parseQuery('WeeklyPlan, Café-Sören');
  // tokenize lowercases + folds + splits on punctuation + camelCase
  // boundaries. Exact set depends on tokenize() rules — assert
  // membership rather than exact array to stay decoupled from tokeniser
  // internals.
  for (const t of ['weekly', 'plan', 'cafe', 'soren']) {
    assert.ok(q.terms.includes(t), `expected term "${t}" in ${JSON.stringify(q.terms)}`);
  }
  console.log('  ok: parseQuery folds + splits the input');
}

// ───── load ──────────────────────────────────────────────────────────────

function test_load_seeds_projections(): void {
  const engine = createSearchEngine();
  engine.load([
    proj({ sha256: 'a'.repeat(64), filename: 'one.pptx', filenameTokens: ['one', 'pptx'] }),
    proj({ sha256: 'b'.repeat(64), filename: 'two.pptx', filenameTokens: ['two', 'pptx'] }),
  ]);
  // After load with no URIs the projections are present but their URI
  // sets are unknown — getUrisForSha returns undefined until the
  // indexer hands URIs in.
  assert.equal(engine.stats().projections, 2);
  assert.equal(engine.stats().uris, 0);
  assert.ok(engine.getProjection('a'.repeat(64)));
  assert.equal(engine.getUrisForSha('a'.repeat(64)), undefined);
  console.log('  ok: load seeds projections, leaves URIs to addOrUpdate');
}

function test_load_replaces_state(): void {
  const engine = createSearchEngine();
  engine.load([proj({ sha256: 'a'.repeat(64) })]);
  engine.addOrUpdate('uri-a', proj({ sha256: 'a'.repeat(64) }));
  engine.load([proj({ sha256: 'c'.repeat(64) })]);
  assert.equal(engine.getProjection('a'.repeat(64)), undefined);
  assert.equal(engine.stats().uris, 0, 'URIs cleared on re-load');
  assert.ok(engine.getProjection('c'.repeat(64)));
  console.log('  ok: load() replaces prior state including URIs');
}

// ───── addOrUpdate ───────────────────────────────────────────────────────

function test_add_records_uri_and_projection(): void {
  const engine = createSearchEngine();
  engine.addOrUpdate('uri-a', proj({ sha256: 'a'.repeat(64) }));
  assert.equal(engine.stats().projections, 1);
  assert.equal(engine.stats().uris, 1);
  assert.deepEqual(engine.getUrisForSha('a'.repeat(64)), ['uri-a']);
  console.log('  ok: addOrUpdate records both projection and URI');
}

function test_dedup_by_sha(): void {
  // DoD: same projection at two URIs → one hit with both URIs.
  const engine = createSearchEngine();
  const p = proj({
    sha256: 'a'.repeat(64),
    filename: 'shared.pptx',
    filenameTokens: ['shared', 'pptx'],
  });
  engine.addOrUpdate('uri-a', p);
  engine.addOrUpdate('uri-b', p);
  assert.equal(engine.stats().projections, 1, 'one content entry');
  assert.equal(engine.stats().uris, 2, 'two URIs');
  const uris = engine.getUrisForSha('a'.repeat(64));
  assert.deepEqual(uris?.sort(), ['uri-a', 'uri-b']);
  const hits = engine.search('shared');
  assert.equal(hits.length, 1, 'one hit despite two URIs');
  assert.deepEqual(hits[0].uris, ['uri-a', 'uri-b']);
  console.log('  ok: same sha at two URIs → one hit with both URIs');
}

function test_uri_re_sha_drops_old(): void {
  // A URI's content changed: old sha becomes orphaned and its
  // projection is dropped (assuming no other URI referenced it).
  const engine = createSearchEngine();
  engine.addOrUpdate('uri-a', proj({ sha256: 'a'.repeat(64) }));
  engine.addOrUpdate('uri-a', proj({ sha256: 'b'.repeat(64) }));
  assert.equal(engine.getProjection('a'.repeat(64)), undefined, 'old sha dropped');
  assert.ok(engine.getProjection('b'.repeat(64)), 'new sha present');
  assert.equal(engine.stats().projections, 1);
  assert.equal(engine.stats().uris, 1);
  console.log('  ok: URI re-sha drops orphaned old projection');
}

function test_uri_re_sha_keeps_old_when_shared(): void {
  // Two URIs share sha-A; one of them switches to sha-B. The shared
  // projection sha-A stays — uri-other still references it.
  const engine = createSearchEngine();
  engine.addOrUpdate('uri-a', proj({ sha256: 'a'.repeat(64) }));
  engine.addOrUpdate('uri-other', proj({ sha256: 'a'.repeat(64) }));
  engine.addOrUpdate('uri-a', proj({ sha256: 'b'.repeat(64) }));
  assert.ok(engine.getProjection('a'.repeat(64)), 'sha-a kept (uri-other still there)');
  assert.deepEqual(engine.getUrisForSha('a'.repeat(64)), ['uri-other']);
  assert.ok(engine.getProjection('b'.repeat(64)));
  console.log('  ok: URI re-sha keeps old projection when other URIs still reference it');
}

// ───── removeUri ─────────────────────────────────────────────────────────

function test_remove_unknown_uri_is_noop(): void {
  const engine = createSearchEngine();
  engine.addOrUpdate('uri-a', proj({ sha256: 'a'.repeat(64) }));
  engine.removeUri('uri-nonexistent');
  assert.equal(engine.stats().projections, 1);
  assert.equal(engine.stats().uris, 1);
  console.log('  ok: removeUri on unknown URI is a no-op');
}

function test_removal_cascade(): void {
  // DoD: last URI removed → projection dropped.
  const engine = createSearchEngine();
  engine.addOrUpdate('uri-a', proj({ sha256: 'a'.repeat(64) }));
  engine.addOrUpdate('uri-b', proj({ sha256: 'a'.repeat(64) }));
  engine.removeUri('uri-a');
  assert.ok(engine.getProjection('a'.repeat(64)), 'projection still there with one URI');
  assert.deepEqual(engine.getUrisForSha('a'.repeat(64)), ['uri-b']);
  engine.removeUri('uri-b');
  assert.equal(engine.getProjection('a'.repeat(64)), undefined, 'last URI gone → projection dropped');
  assert.equal(engine.getUrisForSha('a'.repeat(64)), undefined);
  assert.equal(engine.stats().projections, 0);
  assert.equal(engine.stats().uris, 0);
  console.log('  ok: removal cascade — last URI removed drops projection');
}

// ───── search ────────────────────────────────────────────────────────────

function test_search_empty_returns_empty(): void {
  const engine = createSearchEngine();
  engine.addOrUpdate('uri-a', proj({ sha256: 'a'.repeat(64) }));
  assert.deepEqual(engine.search(''), [], 'empty query → no hits');
  assert.deepEqual(engine.search('   '), [], 'whitespace query → no hits');
  console.log('  ok: empty query never dumps the index');
}

function test_search_basic_filename_match(): void {
  const engine = createSearchEngine();
  engine.addOrUpdate('uri-a', proj({
    sha256: 'a'.repeat(64),
    filename: 'quarterly review.pptx',
    filenameTokens: ['quarterly', 'review', 'pptx'],
  }));
  engine.addOrUpdate('uri-b', proj({
    sha256: 'b'.repeat(64),
    filename: 'snake oil deck.pptx',
    filenameTokens: ['snake', 'oil', 'deck', 'pptx'],
  }));
  const hits = engine.search('quarterly');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sha256, 'a'.repeat(64));
  assert.ok(hits[0].matchedFields.includes('filename'));
  console.log('  ok: filename keyword search returns the matching deck');
}

function test_search_AND_across_terms(): void {
  // Both terms must match somewhere. "quarterly review" matches the
  // first deck but not the second (which only has "review" in its body).
  const engine = createSearchEngine();
  engine.addOrUpdate('uri-a', proj({
    sha256: 'a'.repeat(64),
    filename: 'quarterly review.pptx',
    filenameTokens: ['quarterly', 'review', 'pptx'],
  }));
  engine.addOrUpdate('uri-b', proj({
    sha256: 'b'.repeat(64),
    filename: 'product roadmap.pptx',
    filenameTokens: ['product', 'roadmap', 'pptx'],
    slideText: 'review of progress',
    slideTextTokens: ['review', 'of', 'progress'],
  }));
  const hits = engine.search('quarterly review');
  assert.equal(hits.length, 1, 'AND across terms — second deck misses on "quarterly"');
  assert.equal(hits[0].sha256, 'a'.repeat(64));
  console.log('  ok: AND across query terms drops decks missing any term');
}

function test_search_OR_across_terms(): void {
  // OR mode: a deck matching any single query term qualifies. The first
  // deck matches both terms; the second matches only "review" via its
  // slideText. Both should appear; the multi-term hit ranks first.
  const engine = createSearchEngine();
  engine.addOrUpdate('uri-a', proj({
    sha256: 'a'.repeat(64),
    filename: 'quarterly review.pptx',
    filenameTokens: ['quarterly', 'review', 'pptx'],
  }));
  engine.addOrUpdate('uri-b', proj({
    sha256: 'b'.repeat(64),
    filename: 'product roadmap.pptx',
    filenameTokens: ['product', 'roadmap', 'pptx'],
    slideText: 'review of progress',
    slideTextTokens: ['review', 'of', 'progress'],
  }));
  const hitsAnd = engine.search('quarterly review', 'and');
  assert.equal(hitsAnd.length, 1, 'AND drops the half-match');
  const hitsOr = engine.search('quarterly review', 'or');
  assert.equal(hitsOr.length, 2, 'OR keeps the half-match');
  assert.equal(hitsOr[0].sha256, 'a'.repeat(64), 'both-term hit ranks first');
  console.log('  ok: OR across query terms keeps single-term hits');
}

function test_parse_query_accepts_op(): void {
  const qOr = parseQuery('alice bob', 'or');
  assert.equal(qOr.op, 'or');
  const qAnd = parseQuery('alice bob');
  assert.equal(qAnd.op, 'and', 'default op is "and"');
  console.log('  ok: parseQuery threads op through, defaults to "and"');
}

function test_search_ranking_filename_beats_slidetext(): void {
  // Same query term hits filename of A but only slideText of B.
  // Filename hit must rank above slideText hit (per the scorer's
  // field weights — substrate convention, not a magic-number test).
  const engine = createSearchEngine();
  engine.addOrUpdate('uri-a', proj({
    sha256: 'a'.repeat(64),
    filename: 'budget.pptx',
    filenameTokens: ['budget', 'pptx'],
  }));
  engine.addOrUpdate('uri-b', proj({
    sha256: 'b'.repeat(64),
    filename: 'mystery.pptx',
    filenameTokens: ['mystery', 'pptx'],
    slideText: 'budget overview for next year',
    slideTextTokens: ['budget', 'overview', 'for', 'next', 'year'],
  }));
  const hits = engine.search('budget');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].sha256, 'a'.repeat(64), 'filename hit ranks first');
  assert.equal(hits[1].sha256, 'b'.repeat(64));
  console.log('  ok: filename match ranks above slideText match');
}

function test_search_ranking_prefix_beats_substring(): void {
  // Both decks contain a token that includes "soren", but A's token
  // starts with it. A should rank first.
  const engine = createSearchEngine();
  engine.addOrUpdate('uri-a', proj({
    sha256: 'a'.repeat(64),
    filename: 'soren.pptx',
    filenameTokens: ['soren', 'pptx'],
  }));
  engine.addOrUpdate('uri-b', proj({
    sha256: 'b'.repeat(64),
    filename: 'jonsorenson.pptx',
    filenameTokens: ['jonsorenson', 'pptx'],
  }));
  const hits = engine.search('soren');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].sha256, 'a'.repeat(64), 'prefix match wins over substring');
  console.log('  ok: prefix match ranks above substring match');
}

function test_search_no_match_returns_empty(): void {
  const engine = createSearchEngine();
  engine.addOrUpdate('uri-a', proj({ sha256: 'a'.repeat(64) }));
  assert.deepEqual(engine.search('zzz-nonexistent'), []);
  console.log('  ok: no-match query returns empty array');
}

function test_search_hits_carry_uris(): void {
  // Two URIs sharing a sha — the hit should surface both, sorted.
  const engine = createSearchEngine();
  const p = proj({
    sha256: 'a'.repeat(64),
    filename: 'shared.pptx',
    filenameTokens: ['shared', 'pptx'],
  });
  engine.addOrUpdate('z-uri', p);
  engine.addOrUpdate('a-uri', p);
  const hits = engine.search('shared');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].uris, ['a-uri', 'z-uri'], 'URIs sorted for determinism');
  console.log('  ok: hit.uris carries every URI mapped to the sha, sorted');
}

async function main(): Promise<void> {
  console.log('parseQuery:');
  test_parse_query_empty();
  test_parse_query_folds_and_splits();
  test_parse_query_accepts_op();

  console.log('load:');
  test_load_seeds_projections();
  test_load_replaces_state();

  console.log('addOrUpdate:');
  test_add_records_uri_and_projection();
  test_dedup_by_sha();
  test_uri_re_sha_drops_old();
  test_uri_re_sha_keeps_old_when_shared();

  console.log('removeUri:');
  test_remove_unknown_uri_is_noop();
  test_removal_cascade();

  console.log('search:');
  test_search_empty_returns_empty();
  test_search_basic_filename_match();
  test_search_AND_across_terms();
  test_search_OR_across_terms();
  test_search_ranking_filename_beats_slidetext();
  test_search_ranking_prefix_beats_substring();
  test_search_no_match_returns_empty();
  test_search_hits_carry_uris();

  console.log('all search-engine tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
