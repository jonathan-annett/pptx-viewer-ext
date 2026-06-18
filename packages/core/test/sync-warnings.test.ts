// Tests for the per-file validator hook used by the planner.
// Run with: npm run test:sync-warnings
//
// validatePptxBytes builds on parsePptx (already covered by parse.test.ts) —
// these tests only assert that the parser's flag output is correctly
// translated into a PlanWarning[] payload, with the right codes and a
// message string for each failing flag. We rebuild minimal synthetic
// fixtures rather than depending on real-world pptx files.

import { strict as assert } from 'node:assert';
import { zipSync, strToU8 } from 'fflate';
import { webcrypto } from 'node:crypto';
import { isPptxPath, validatePptxBytes } from '../src/sync/validators';
import { InMemoryParseCache } from '../src/sync/parseCache';
import { sha256Hex } from '../src/sync/hash';

if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto?: unknown }).crypto = webcrypto;
}

type ZipMap = Record<string, Uint8Array>;

function makePptx(files: Record<string, string | Uint8Array>): Uint8Array {
  const zip: ZipMap = {};
  for (const [name, content] of Object.entries(files)) {
    zip[name] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(zip);
}

function slide(): string {
  return `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>`;
}

function presentation(): string {
  return `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`;
}

function presProps(showPr: string): string {
  return `<?xml version="1.0"?><p:presentationPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${showPr}</p:presentationPr>`;
}

function core(): string {
  return `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>A</dc:creator></cp:coreProperties>`;
}

function rels(entries: string): string {
  return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
}

// p14 showMediaCtrls extension, the form PowerPoint actually writes.
function mediaCtrls(val: '0' | '1'): string {
  return `<p:extLst><p:ext uri="{2FDB2607-1784-4EEB-B798-7EB5836EED8A}"><p14:showMediaCtrls xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="${val}"/></p:ext></p:extLst>`;
}

const TYPES_EMPTY = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;
const TYPES_VIDEO = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="mp4" ContentType="video/mp4"/></Types>`;

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void): void => {
  tests.push([name, fn]);
};

// ───── path filter ───────────────────────────────────────────────────────

test('isPptxPath: trailing extension match, case-insensitive', () => {
  assert.equal(isPptxPath('a.pptx'), true);
  assert.equal(isPptxPath('deep/path/file.PPTX'), true);
  assert.equal(isPptxPath('a.ppt'), false);
  assert.equal(isPptxPath('a.pptx.bak'), false);
  assert.equal(isPptxPath('pptx'), false);
});

// ───── clean pptx → empty warnings ───────────────────────────────────────

test('clean pptx (presenter, controls off, no linked media) → no warnings', async () => {
  const bytes = makePptx({
    '[Content_Types].xml': TYPES_EMPTY,
    'docProps/core.xml': core(),
    'ppt/presentation.xml': presentation(),
    'ppt/presProps.xml': presProps(`<p:showPr><p:present/>${mediaCtrls('0')}</p:showPr>`),
    'ppt/slides/slide1.xml': slide(),
  });
  const warnings = await validatePptxBytes('clean.pptx', bytes);
  assert.deepEqual(warnings, []);
});

// ───── one warning at a time ─────────────────────────────────────────────

test('kiosk mode → show-type warning', async () => {
  const bytes = makePptx({
    '[Content_Types].xml': TYPES_EMPTY,
    'docProps/core.xml': core(),
    'ppt/presentation.xml': presentation(),
    'ppt/presProps.xml': presProps(`<p:showPr><p:kiosk/>${mediaCtrls('0')}</p:showPr>`),
    'ppt/slides/slide1.xml': slide(),
  });
  const warnings = await validatePptxBytes('kiosk.pptx', bytes);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'show-type');
  assert.equal(warnings[0].severity, 'block');
  assert.match(warnings[0].message, /[Kk]iosk/);
});

test('window/browse mode → show-type warning', async () => {
  const bytes = makePptx({
    '[Content_Types].xml': TYPES_EMPTY,
    'docProps/core.xml': core(),
    'ppt/presentation.xml': presentation(),
    'ppt/presProps.xml': presProps(`<p:showPr><p:browse/>${mediaCtrls('0')}</p:showPr>`),
    'ppt/slides/slide1.xml': slide(),
  });
  const warnings = await validatePptxBytes('browse.pptx', bytes);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'show-type');
  assert.equal(warnings[0].severity, 'block');
  assert.match(warnings[0].message, /[Bb]rowse|[Ww]indow/);
});

test('linked external video → linked-media warning', async () => {
  const bytes = makePptx({
    '[Content_Types].xml': TYPES_EMPTY,
    'docProps/core.xml': core(),
    'ppt/presentation.xml': presentation(),
    'ppt/presProps.xml': presProps(`<p:showPr><p:present/>${mediaCtrls('0')}</p:showPr>`),
    'ppt/slides/slide1.xml': slide(),
    'ppt/slides/_rels/slide1.xml.rels': rels(
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="https://example.com/clip.mp4" TargetMode="External"/>`,
    ),
  });
  const warnings = await validatePptxBytes('linked.pptx', bytes);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'linked-media');
  assert.equal(warnings[0].severity, 'block');
  assert.match(warnings[0].message, /external/i);
});

test('media controls on + embedded video → media-controls warning', async () => {
  const bytes = makePptx({
    '[Content_Types].xml': TYPES_VIDEO,
    'docProps/core.xml': core(),
    'ppt/presentation.xml': presentation(),
    // Self-closing <p:showPr/> → no explicit setting → ECMA default ON.
    'ppt/presProps.xml': presProps(`<p:showPr/>`),
    'ppt/slides/slide1.xml': slide(),
    'ppt/media/media1.mp4': new Uint8Array([0, 0, 0, 1]),
  });
  const warnings = await validatePptxBytes('mediactrls.pptx', bytes);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'media-controls');
  // media-controls is the only override-severity warning — files with the
  // progress bar over a video are ugly but ship-able.
  assert.equal(warnings[0].severity, 'override');
  assert.match(warnings[0].message, /embedded video/i);
});

// ───── multiple warnings stack ───────────────────────────────────────────

test('kiosk + linked media + controls-with-video → three warnings, all codes present', async () => {
  const bytes = makePptx({
    '[Content_Types].xml': TYPES_VIDEO,
    'docProps/core.xml': core(),
    'ppt/presentation.xml': presentation(),
    'ppt/presProps.xml': presProps(`<p:showPr><p:kiosk/>${mediaCtrls('1')}</p:showPr>`),
    'ppt/slides/slide1.xml': slide(),
    'ppt/slides/_rels/slide1.xml.rels': rels(
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="https://example.com/clip.mp4" TargetMode="External"/>`,
    ),
    'ppt/media/media1.mp4': new Uint8Array([0, 0, 0, 1]),
  });
  const warnings = await validatePptxBytes('all-bad.pptx', bytes);
  const codes = warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ['linked-media', 'media-controls', 'show-type']);
});

// ───── corrupt zip → empty warnings (no crash) ───────────────────────────

test('corrupt zip → empty warnings (parseError swallowed)', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]); // not a zip
  const warnings = await validatePptxBytes('corrupt.pptx', bytes);
  assert.deepEqual(warnings, []);
});

// ───── M5.3 Phase C — cache fast-path ────────────────────────────────────

test('parse cache: miss records, second call hits without re-parsing', async () => {
  // A kiosk file produces a show-type warning. We're verifying:
  //   (a) the first call (miss) parses, records, and emits the warning;
  //   (b) the second call (hit) emits the same warning without re-parsing.
  // We can't easily intercept parsePptx, so we assert via cache.stats():
  // misses goes 0→1 on the first call, hits goes 0→1 on the second.
  const bytes = makePptx({
    '[Content_Types].xml': TYPES_EMPTY,
    'docProps/core.xml': core(),
    'ppt/presentation.xml': presentation(),
    'ppt/presProps.xml': presProps('<p:showPr><p:kiosk/></p:showPr>'),
    'ppt/slides/slide1.xml': slide(),
  });
  const sha = await sha256Hex(bytes);
  const cache = new InMemoryParseCache();

  const first = await validatePptxBytes('kiosk.pptx', bytes, { sha256: sha, cache });
  assert.equal(first.length, 1);
  assert.equal(first[0].code, 'show-type');
  assert.equal(cache.stats().misses, 1);
  assert.equal(cache.stats().hits, 0);
  assert.equal(cache.stats().entries, 1);

  const second = await validatePptxBytes('kiosk.pptx', bytes, { sha256: sha, cache });
  assert.deepEqual(second.map((w) => w.code), ['show-type']);
  assert.equal(cache.stats().hits, 1, 'second call resolves from cache');
  assert.equal(cache.stats().misses, 1, 'no extra miss on second call');
});

test('parse cache: corrupt bytes cache the parseError — second call also empty', async () => {
  // parseError records into the cache so the same bytes do not re-parse next
  // time. The validator must continue to return [] on the cache hit too.
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const sha = await sha256Hex(bytes);
  const cache = new InMemoryParseCache();

  const first = await validatePptxBytes('corrupt.pptx', bytes, { sha256: sha, cache });
  assert.deepEqual(first, []);
  assert.equal(cache.stats().misses, 1);
  assert.equal(cache.stats().entries, 1);

  const second = await validatePptxBytes('corrupt.pptx', bytes, { sha256: sha, cache });
  assert.deepEqual(second, [], 'cached parseError still produces no warnings');
  assert.equal(cache.stats().hits, 1);
});

test('parse cache: no cache supplied → same behaviour as pre-Phase-C', async () => {
  // Backstop: callers that haven't been updated (or contexts without IDB)
  // continue to get plain parse-every-time semantics. No regression.
  const bytes = makePptx({
    '[Content_Types].xml': TYPES_EMPTY,
    'docProps/core.xml': core(),
    'ppt/presentation.xml': presentation(),
    'ppt/presProps.xml': presProps('<p:showPr/>'),
    'ppt/slides/slide1.xml': slide(),
  });
  const warnings = await validatePptxBytes('clean.pptx', bytes);
  assert.deepEqual(warnings, []);
});

// ───── runner ────────────────────────────────────────────────────────────

(async () => {
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
