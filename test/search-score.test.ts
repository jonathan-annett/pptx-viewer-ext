// Tests for src/search/score.ts.
// Run with: npm run test:search-score
//
// The scorer's contract is ordinal — only the *relative* ordering of
// scores matters, not their absolute values. Tests assert ordering and
// matchedFields rather than fixed numbers, so a future weight-tuning
// pass doesn't break the suite without changing observable behaviour.

import { strict as assert } from 'node:assert';
import {
  SEARCH_PROJECTION_SCHEMA_VERSION,
  type SearchProjection,
  type SearchQuery,
} from '../src/search/index-types';
import { scoreProjection } from '../src/search/score';
import { tokenize } from '../src/search/tokenize';

function projection(opts: {
  filename: string;
  author?: string;
  slideText?: string;
}): SearchProjection {
  const author = opts.author ?? '';
  const slideText = opts.slideText ?? '';
  return {
    sha256: 'a'.repeat(64),
    filename: opts.filename.toLowerCase(),
    displayFilename: opts.filename,
    author: author.toLowerCase(),
    displayAuthor: author,
    slideText: slideText.toLowerCase(),
    filenameTokens: tokenize(opts.filename),
    authorTokens: tokenize(author),
    slideTextTokens: tokenize(slideText),
    sizeBytes: 1234,
    mtime: 1700000000000,
    schemaVersion: SEARCH_PROJECTION_SCHEMA_VERSION,
  };
}

function query(raw: string, op: 'and' | 'or' = 'and'): SearchQuery {
  return { raw, terms: tokenize(raw), op };
}

function test_empty_query_zero(): void {
  const p = projection({ filename: 'Foo.pptx' });
  const r = scoreProjection(p, query(''));
  assert.equal(r.score, 0);
  assert.deepEqual(r.matchedFields, []);
  console.log('  ok: empty query → score 0');
}

function test_no_match_zero(): void {
  const p = projection({ filename: 'Foo.pptx' });
  const r = scoreProjection(p, query('xyzzy'));
  assert.equal(r.score, 0);
  assert.deepEqual(r.matchedFields, []);
  console.log('  ok: no match → score 0');
}

function test_filename_match(): void {
  const p = projection({ filename: 'Quarterly-Plan.pptx' });
  const r = scoreProjection(p, query('plan'));
  assert.ok(r.score > 0);
  assert.deepEqual(r.matchedFields, ['filename']);
  console.log('  ok: filename match scores + reports filename');
}

function test_author_match(): void {
  const p = projection({ filename: 'Deck.pptx', author: 'Alice Author' });
  const r = scoreProjection(p, query('alice'));
  assert.ok(r.score > 0);
  assert.deepEqual(r.matchedFields, ['author']);
  console.log('  ok: author match reports author');
}

function test_slidetext_match(): void {
  const p = projection({
    filename: 'Deck.pptx',
    slideText: 'Welcome to the planning session',
  });
  const r = scoreProjection(p, query('planning'));
  assert.ok(r.score > 0);
  assert.deepEqual(r.matchedFields, ['slideText']);
  console.log('  ok: slideText match reports slideText');
}

function test_and_across_terms(): void {
  const p = projection({ filename: 'Quarterly Plan.pptx', author: 'Alice' });
  // "alice plan" — both must match somewhere. Both do.
  const r1 = scoreProjection(p, query('alice plan'));
  assert.ok(r1.score > 0);
  assert.deepEqual(r1.matchedFields.sort(), ['author', 'filename']);
  // "alice xyzzy" — alice hits, xyzzy doesn't → whole thing zeroed.
  const r2 = scoreProjection(p, query('alice xyzzy'));
  assert.equal(r2.score, 0);
  console.log('  ok: AND across terms (all must match)');
}

function test_or_across_fields(): void {
  // Same term, two projections — one matches via filename, the other
  // via slideText. Both score > 0.
  const pFile = projection({ filename: 'Strategy.pptx' });
  const pSlide = projection({ filename: 'Deck.pptx', slideText: 'strategy and execution' });
  assert.ok(scoreProjection(pFile, query('strategy')).score > 0);
  assert.ok(scoreProjection(pSlide, query('strategy')).score > 0);
  console.log('  ok: OR across fields (term hits anywhere)');
}

function test_prefix_beats_substring(): void {
  const pPrefix = projection({ filename: 'Plan.pptx' });            // "plan" prefix
  const pSubstr = projection({ filename: 'Misplanned.pptx' });      // "plan" substring (not prefix)
  const sPrefix = scoreProjection(pPrefix, query('plan')).score;
  const sSubstr = scoreProjection(pSubstr, query('plan')).score;
  assert.ok(sPrefix > sSubstr, `prefix (${sPrefix}) should beat substring (${sSubstr})`);
  console.log('  ok: prefix > substring');
}

function test_shorter_token_beats_longer(): void {
  const pExact = projection({ author: 'Soren', filename: 'a.pptx' });
  const pLong = projection({ author: 'Sorenson', filename: 'a.pptx' });
  const sExact = scoreProjection(pExact, query('soren')).score;
  const sLong = scoreProjection(pLong, query('soren')).score;
  assert.ok(sExact > sLong, `exact (${sExact}) should beat longer (${sLong})`);
  console.log('  ok: shorter matching token > longer');
}

function test_filename_beats_slidetext(): void {
  // Same term in filename for one projection, in slideText for another.
  // Filename should rank higher.
  const pFile = projection({ filename: 'Roadmap.pptx' });
  const pSlide = projection({
    filename: 'Deck.pptx',
    slideText: 'see roadmap',
  });
  const sFile = scoreProjection(pFile, query('roadmap')).score;
  const sSlide = scoreProjection(pSlide, query('roadmap')).score;
  assert.ok(sFile > sSlide, `filename (${sFile}) should beat slideText (${sSlide})`);
  console.log('  ok: filename > slideText field weight');
}

function test_diacritic_query(): void {
  // Searching "soren" matches projection of "Sören" via fold; the
  // search query path also folds.
  const p = projection({ filename: 'Deck.pptx', author: 'Sören' });
  const r = scoreProjection(p, query('soren'));
  assert.ok(r.score > 0);
  assert.deepEqual(r.matchedFields, ['author']);
  console.log('  ok: diacritic-folded query matches diacritic-folded field');
}

function test_camelcase_query(): void {
  // Projection has filename "MyPlanDeck.pptx" → tokens [my, plan, deck].
  // Query "plan" hits.
  const p = projection({ filename: 'MyPlanDeck.pptx' });
  assert.ok(scoreProjection(p, query('plan')).score > 0);
  console.log('  ok: camelCase tokens searchable by component word');
}

function test_or_mode_one_term_matches(): void {
  // In AND mode (default), "alice xyzzy" zeroes because xyzzy doesn't hit.
  // In OR mode, "alice" matching alone is enough to score > 0.
  const p = projection({ filename: 'Deck.pptx', author: 'Alice' });
  const rAnd = scoreProjection(p, query('alice xyzzy', 'and'));
  assert.equal(rAnd.score, 0);
  const rOr = scoreProjection(p, query('alice xyzzy', 'or'));
  assert.ok(rOr.score > 0, `OR-mode score should be > 0, got ${rOr.score}`);
  assert.deepEqual(rOr.matchedFields, ['author']);
  console.log('  ok: OR mode lets a single hitting term qualify');
}

function test_or_mode_multi_term_outranks_single(): void {
  // OR mode still accumulates per-term scores, so a projection where
  // both terms hit ranks above a projection where only one does.
  const pBoth = projection({ filename: 'Alice-Plan.pptx', author: 'Alice' });
  const pOne = projection({ filename: 'Deck.pptx', author: 'Alice' });
  const sBoth = scoreProjection(pBoth, query('alice plan', 'or')).score;
  const sOne = scoreProjection(pOne, query('alice plan', 'or')).score;
  assert.ok(sBoth > sOne, `both-hit (${sBoth}) should outrank single-hit (${sOne})`);
  console.log('  ok: OR mode — more matching terms still ranks higher');
}

function test_or_mode_no_terms_match(): void {
  // Even in OR mode, if no term hits anywhere, score stays 0.
  const p = projection({ filename: 'Deck.pptx', author: 'Alice' });
  const r = scoreProjection(p, query('xyzzy nopezone', 'or'));
  assert.equal(r.score, 0);
  assert.deepEqual(r.matchedFields, []);
  console.log('  ok: OR mode — no hits anywhere → score 0');
}

function test_multiple_fields_boost(): void {
  // Same term hits BOTH filename and author → both fields listed in
  // matchedFields. Score is higher than a single-field hit.
  const pBoth = projection({ filename: 'Alice.pptx', author: 'Alice Author' });
  const pOne = projection({ filename: 'Deck.pptx', author: 'Alice Author' });
  const rBoth = scoreProjection(pBoth, query('alice'));
  const rOne = scoreProjection(pOne, query('alice'));
  assert.ok(rBoth.score > rOne.score);
  assert.deepEqual(rBoth.matchedFields.sort(), ['author', 'filename']);
  console.log('  ok: hits on multiple fields stack');
}

async function main(): Promise<void> {
  console.log('search-score:');
  test_empty_query_zero();
  test_no_match_zero();
  test_filename_match();
  test_author_match();
  test_slidetext_match();
  test_and_across_terms();
  test_or_across_fields();
  test_prefix_beats_substring();
  test_shorter_token_beats_longer();
  test_filename_beats_slidetext();
  test_diacritic_query();
  test_camelcase_query();
  test_or_mode_one_term_matches();
  test_or_mode_multi_term_outranks_single();
  test_or_mode_no_terms_match();
  test_multiple_fields_boost();
  console.log('all search-score tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
