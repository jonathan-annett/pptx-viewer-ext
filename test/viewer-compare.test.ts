// Smoke tests for the compare-modal renderer.
// Run with: npm run test:viewer-compare

import { strict as assert } from 'node:assert';
import {
  renderCompareModalHtml,
  renderIdenticalModalHtml,
} from '../src/sync/compareModalHtml';
import type { ParseResult } from '../src/pptx';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

function parseResult(overrides: Partial<ParseResult> = {}): ParseResult {
  const base: ParseResult = {
    fileName: 'deck.pptx',
    size: 1024,
    sizeHuman: '1.00 KB',
    mtime: 0,
    mtimeHuman: '2026-01-01T00:00:00.000Z',
    sha256: 'a'.repeat(64),
    slideCount: 5,
    hiddenSlideCount: 0,
    author: 'Jonathan',
    lastModifiedBy: 'Claude',
    embeddedMedia: [],
    mediaFiles: [],
    firstVisibleSlideText: '',
    flags: {
      linkedMedia: { ok: true, label: 'Linked media', detail: '' },
      showType: { ok: true, label: 'Show type', detail: '' },
      showMediaControls: { ok: true, label: 'Show media controls', detail: '' },
    },
  };
  return { ...base, ...overrides };
}

// ───── renderCompareModalHtml ───────────────────────────────────────────

test('compare modal includes both file names', () => {
  const html = renderCompareModalHtml(
    parseResult({ fileName: 'current.pptx' }),
    parseResult({ fileName: 'dropped.pptx' }),
  );
  assert.ok(html.includes('current.pptx'), 'current filename present');
  assert.ok(html.includes('dropped.pptx'), 'dropped filename present');
});

test('compare modal has Current and Dropped column headings', () => {
  const html = renderCompareModalHtml(parseResult(), parseResult());
  assert.ok(html.includes('>Current<'), 'Current column heading');
  assert.ok(html.includes('>Dropped<'), 'Dropped column heading');
});

test('compare modal exposes the IDs the viewer script binds to', () => {
  const html = renderCompareModalHtml(parseResult(), parseResult());
  assert.ok(html.includes('id="compare-update-btn"'), 'update button id');
  assert.ok(html.includes('id="compare-cancel-btn"'), 'cancel button id');
  assert.ok(/Update file/.test(html), 'update button label');
  assert.ok(/Cancel/.test(html), 'cancel button label');
});

test('compare modal includes both thumbnails when present', () => {
  const current = parseResult({
    thumbnail: { mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' },
  });
  const candidate = parseResult({
    thumbnail: { mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,BBBB' },
  });
  const html = renderCompareModalHtml(current, candidate);
  assert.ok(html.includes('data:image/png;base64,AAAA'), 'current thumbnail data url');
  assert.ok(html.includes('data:image/jpeg;base64,BBBB'), 'dropped thumbnail data url');
});

test('compare modal renders a "No thumbnail" placeholder when one column lacks a thumb', () => {
  const html = renderCompareModalHtml(
    parseResult({ thumbnail: { mime: 'image/png', dataUrl: 'data:image/png;base64,XX' } }),
    parseResult(),
  );
  assert.ok(html.includes('No thumbnail'), 'placeholder present');
  assert.ok(html.includes('data:image/png;base64,XX'), 'other thumbnail still present');
});

test('compare modal includes both sha256 values so the user can confirm the diff', () => {
  const html = renderCompareModalHtml(
    parseResult({ sha256: 'a'.repeat(64) }),
    parseResult({ sha256: 'b'.repeat(64) }),
  );
  assert.ok(html.includes('a'.repeat(64)));
  assert.ok(html.includes('b'.repeat(64)));
});

test('compare modal escapes HTML in untrusted fields (filename, author)', () => {
  const html = renderCompareModalHtml(
    parseResult({ fileName: '<script>x</script>.pptx' }),
    parseResult({ author: '<img src=x>' }),
  );
  assert.ok(!html.includes('<script>x</script>'), 'script tag is escaped');
  assert.ok(!html.includes('<img src=x>'), 'img tag is escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped form present');
});

// ───── renderIdenticalModalHtml ─────────────────────────────────────────

test('identical modal has a single OK button with the expected ID', () => {
  const html = renderIdenticalModalHtml('dropped.pptx');
  assert.ok(html.includes('id="compare-ok-btn"'), 'OK button id');
  assert.ok(!html.includes('compare-update-btn'), 'no Update button');
  assert.ok(!html.includes('compare-cancel-btn'), 'no Cancel button');
});

test('identical modal mentions the dropped file name and "matches"', () => {
  const html = renderIdenticalModalHtml('dropped.pptx');
  assert.ok(html.includes('dropped.pptx'));
  assert.ok(/matches/.test(html));
});

test('identical modal escapes the file name', () => {
  const html = renderIdenticalModalHtml('<x>.pptx');
  assert.ok(!html.includes('<x>'));
  assert.ok(html.includes('&lt;x&gt;'));
});

// ───── run ──────────────────────────────────────────────────────────────

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
