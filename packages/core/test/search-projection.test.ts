// Tests for src/search/projection.ts.
// Run with: npm run test:search-projection

import { strict as assert } from 'node:assert';
import type { CachedParseResult } from '../src/sync/parseCache';
import type { ParseResult } from '../src/pptx';
import {
  SEARCH_PROJECTION_SCHEMA_VERSION,
  type SearchProjection,
} from '../src/search/index-types';
import {
  basenameOf,
  decodeUriDisplay,
  projectFromCached,
  projectFromParseResult,
} from '../src/search/projection';

const PASS_FLAGS = {
  linkedMedia: { ok: true, label: '', detail: '' },
  showType: { ok: true, label: '', detail: '' },
  showMediaControls: { ok: true, label: '', detail: '' },
};

function fakeParseResult(overrides: Partial<ParseResult> = {}): ParseResult {
  const base: ParseResult = {
    fileName: 'Deck.pptx',
    size: 4096,
    sizeHuman: '4 KB',
    mtime: 1700000000000,
    mtimeHuman: '2023-…',
    sha256: 'a'.repeat(64),
    slideCount: 1,
    hiddenSlideCount: 0,
    author: 'Alice Author',
    lastModifiedBy: 'Bob',
    embeddedMedia: [],
    mediaFiles: [],
    firstVisibleSlideText: 'Welcome to the quarterly plan',
    flags: PASS_FLAGS,
  };
  return { ...base, ...overrides };
}

function fakeCached(overrides: Partial<CachedParseResult> = {}): CachedParseResult {
  return {
    sha256: 'b'.repeat(64),
    slideCount: 1,
    hiddenSlideCount: 0,
    author: 'Cached Author',
    lastModifiedBy: '',
    embeddedMedia: [],
    mediaFiles: [],
    firstVisibleSlideText: 'cached slide text',
    flags: PASS_FLAGS,
    ...overrides,
  };
}

function assertProjectionShape(p: SearchProjection): void {
  assert.equal(p.schemaVersion, SEARCH_PROJECTION_SCHEMA_VERSION);
  assert.equal(typeof p.sha256, 'string');
  assert.equal(typeof p.filename, 'string');
  assert.equal(typeof p.displayFilename, 'string');
  assert.equal(typeof p.author, 'string');
  assert.equal(typeof p.displayAuthor, 'string');
  assert.equal(typeof p.slideText, 'string');
  assert.ok(Array.isArray(p.filenameTokens));
  assert.ok(Array.isArray(p.authorTokens));
  assert.ok(Array.isArray(p.slideTextTokens));
}

// ───── basenameOf ───────────────────────────────────────────────────────

function test_basename_plain_name(): void {
  assert.equal(basenameOf('deck.pptx'), 'deck.pptx');
  console.log('  ok: basename — plain filename');
}

function test_basename_path(): void {
  assert.equal(basenameOf('/some/path/to/My Deck.pptx'), 'My Deck.pptx');
  console.log('  ok: basename — POSIX path');
}

function test_basename_vscode_uri(): void {
  assert.equal(
    basenameOf('vscode-vfs://github/owner/repo/path/Quarterly.pptx'),
    'Quarterly.pptx',
  );
  console.log('  ok: basename — vscode-vfs:// URI');
}

function test_basename_trailing_slash(): void {
  assert.equal(basenameOf('/some/dir/'), 'dir');
  console.log('  ok: basename — trailing slash trimmed');
}

function test_basename_query_fragment(): void {
  assert.equal(basenameOf('file:///x/y/deck.pptx?ref=main'), 'deck.pptx');
  assert.equal(basenameOf('file:///x/y/deck.pptx#frag'), 'deck.pptx');
  console.log('  ok: basename — query + fragment dropped');
}

function test_basename_empty(): void {
  assert.equal(basenameOf(''), '');
  console.log('  ok: basename — empty input');
}

// ───── projectFromParseResult ───────────────────────────────────────────

function test_project_from_parseresult_basic(): void {
  const p = projectFromParseResult(fakeParseResult());
  assertProjectionShape(p);
  assert.equal(p.sha256, 'a'.repeat(64));
  assert.equal(p.filename, 'deck.pptx'); // folded
  assert.equal(p.author, 'alice author'); // folded
  assert.equal(p.slideText, 'welcome to the quarterly plan'); // folded
  assert.deepEqual(p.filenameTokens, ['deck', 'pptx']);
  assert.deepEqual(p.authorTokens, ['alice', 'author']);
  assert.deepEqual(
    p.slideTextTokens,
    ['welcome', 'to', 'the', 'quarterly', 'plan'],
  );
  assert.equal(p.sizeBytes, 4096);
  assert.equal(p.mtime, 1700000000000);
  console.log('  ok: project from ParseResult folds + tokenises every field');
}

function test_project_filename_override(): void {
  // When the URI basename differs from result.fileName, the override wins.
  const p = projectFromParseResult(fakeParseResult(), 'OtherName.pptx');
  assert.equal(p.filename, 'othername.pptx');
  assert.deepEqual(p.filenameTokens, ['other', 'name', 'pptx']);
  console.log('  ok: filename override applied');
}

function test_unknown_author_collapses(): void {
  // The 'unknown' sentinel is treated as "no author" for search.
  const p = projectFromParseResult(fakeParseResult({ author: 'unknown' }));
  assert.equal(p.author, '');
  assert.deepEqual(p.authorTokens, []);
  console.log('  ok: author "unknown" → empty (not indexed)');
}

function test_empty_slidetext(): void {
  const p = projectFromParseResult(fakeParseResult({ firstVisibleSlideText: '' }));
  assert.equal(p.slideText, '');
  assert.deepEqual(p.slideTextTokens, []);
  console.log('  ok: empty firstVisibleSlideText → empty tokens');
}

function test_diacritic_folded(): void {
  const p = projectFromParseResult(
    fakeParseResult({
      fileName: 'Café Présentation.pptx',
      author: 'Sören',
      firstVisibleSlideText: 'Résumé',
    }),
  );
  assert.equal(p.filename, 'cafe presentation.pptx');
  // ö is composed (U+00F6 → U+006F + U+0308) — NFD + strip-marks
  // decomposes it to 'o'. Contrast with ø (U+00F8) which is atomic and
  // stays as 'ø' under NFD.
  assert.equal(p.author, 'soren');
  assert.equal(p.slideText, 'resume');
  assert.deepEqual(p.filenameTokens, ['cafe', 'presentation', 'pptx']);
  assert.deepEqual(p.authorTokens, ['soren']);
  assert.deepEqual(p.slideTextTokens, ['resume']);
  console.log('  ok: diacritic folding applied during projection');
}

// ───── projectFromCached ────────────────────────────────────────────────

function test_project_from_cached_uses_fileinfo(): void {
  const p = projectFromCached(fakeCached(), {
    fileName: 'Hydrated.pptx',
    size: 8192,
    mtime: 1800000000000,
  });
  assertProjectionShape(p);
  assert.equal(p.sha256, 'b'.repeat(64));
  assert.equal(p.filename, 'hydrated.pptx');
  assert.equal(p.author, 'cached author');
  assert.equal(p.slideText, 'cached slide text');
  assert.equal(p.sizeBytes, 8192);
  assert.equal(p.mtime, 1800000000000);
  console.log('  ok: cached path takes display fields from FileInfo');
}

function test_cached_unknown_author_collapses(): void {
  const p = projectFromCached(fakeCached({ author: 'unknown' }), {
    fileName: 'Anon.pptx',
    size: 1,
    mtime: 1,
  });
  assert.equal(p.author, '');
  console.log('  ok: cached "unknown" author collapses too');
}

// ───── decodeUriDisplay + display fields ────────────────────────────────

function test_decode_uri_display_basic(): void {
  assert.equal(
    decodeUriDisplay('WED%20206%201720%20Mr%20Simon%20Santosha%202.pptx'),
    'WED 206 1720 Mr Simon Santosha 2.pptx',
  );
  console.log('  ok: decodeUriDisplay turns %20 into spaces');
}

function test_decode_uri_display_malformed(): void {
  // A lone % with no two-hex-digit follow-up makes decodeURIComponent throw.
  // We want to fall back to the raw input rather than blow up the projection.
  assert.equal(decodeUriDisplay('100%-finished.pptx'), '100%-finished.pptx');
  console.log('  ok: decodeUriDisplay survives malformed sequences');
}

function test_decode_uri_display_empty(): void {
  assert.equal(decodeUriDisplay(''), '');
  console.log('  ok: decodeUriDisplay handles empty input');
}

function test_display_fields_preserve_case_and_decode(): void {
  const p = projectFromParseResult(
    fakeParseResult({ author: 'Simon Santosha' }),
    'WED%20206%20Mr%20Simon%20Santosha.pptx',
  );
  // Match fields stay folded …
  assert.equal(p.filename, 'wed 206 mr simon santosha.pptx');
  assert.equal(p.author, 'simon santosha');
  // … while display fields preserve case and decode percent-escapes.
  assert.equal(p.displayFilename, 'WED 206 Mr Simon Santosha.pptx');
  assert.equal(p.displayAuthor, 'Simon Santosha');
  // Tokens should derive from the display form too — punctuation/encoding
  // shouldn't bleed into the token list.
  assert.deepEqual(
    p.filenameTokens,
    ['wed', '206', 'mr', 'simon', 'santosha', 'pptx'],
  );
  console.log('  ok: display fields preserve case + decode URI escapes');
}

function test_display_fields_from_cached(): void {
  const p = projectFromCached(
    fakeCached({ author: 'Alice Author' }),
    {
      fileName: 'Q4%20Plan.pptx',
      size: 1,
      mtime: 1,
    },
  );
  assert.equal(p.filename, 'q4 plan.pptx');
  assert.equal(p.displayFilename, 'Q4 Plan.pptx');
  assert.equal(p.displayAuthor, 'Alice Author');
  console.log('  ok: display fields populate via cached path too');
}

function test_display_author_empty_for_unknown(): void {
  // 'unknown' author is collapsed to '' for matching; the display field
  // should also be '' so the panel doesn't render "by unknown".
  const p = projectFromParseResult(fakeParseResult({ author: 'unknown' }));
  assert.equal(p.displayAuthor, '');
  console.log('  ok: displayAuthor empty when author is the unknown sentinel');
}

async function main(): Promise<void> {
  console.log('basenameOf:');
  test_basename_plain_name();
  test_basename_path();
  test_basename_vscode_uri();
  test_basename_trailing_slash();
  test_basename_query_fragment();
  test_basename_empty();
  console.log('projectFromParseResult:');
  test_project_from_parseresult_basic();
  test_project_filename_override();
  test_unknown_author_collapses();
  test_empty_slidetext();
  test_diacritic_folded();
  console.log('projectFromCached:');
  test_project_from_cached_uses_fileinfo();
  test_cached_unknown_author_collapses();
  console.log('decodeUriDisplay + display fields:');
  test_decode_uri_display_basic();
  test_decode_uri_display_malformed();
  test_decode_uri_display_empty();
  test_display_fields_preserve_case_and_decode();
  test_display_fields_from_cached();
  test_display_author_empty_for_unknown();
  console.log('all search-projection tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
