// Snapshot-style tests for the PDF import config modal HTML renderer.
//
// We assert structural properties of the emitted string rather than full
// byte-for-byte snapshots — the latter become noisy maintenance churn the
// moment a class name or whitespace is tweaked. Each test pins one observable
// behaviour: which radio gets `checked`, where the status text lands,
// presence/absence of the device-resolution row, etc.
//
// Run via:  npm run test:pdf-import-config-html

import {
  renderPdfImportConfigHtml,
  pdfImportConfigCss,
  DEFAULT_PDF_IMPORT_CONFIG,
  RESOLUTION_PRESETS,
  type PdfImportConfig,
} from '../src/pdfImportConfigHtml';

const tests: Array<[string, () => void | Promise<void>]> = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push([name, fn]);
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// ─── helpers ────────────────────────────────────────────────────────────

/**
 * Returns `true` when the radio input with given name+value carries the
 * `checked` attribute. The renderer always emits radios as
 *   <input type="radio" name="X" value="Y" checked>
 * with `checked` immediately after the value, so a tight regex catches it
 * without re-parsing the HTML.
 */
function radioChecked(html: string, name: string, value: string): boolean {
  // Strict pattern: capture only when checked attribute is present on the
  // same tag. Backslash + quotes to match the emitted value.
  const pattern = new RegExp(
    `<input[^>]*type="radio"[^>]*name="${name}"[^>]*value="${value}"[^>]*checked`,
  );
  return pattern.test(html);
}

function hasRadio(html: string, name: string, value: string): boolean {
  const pattern = new RegExp(
    `<input[^>]*type="radio"[^>]*name="${name}"[^>]*value="${value}"`,
  );
  return pattern.test(html);
}

// ─── tests ──────────────────────────────────────────────────────────────

test('renderPdfImportConfigHtml: default config selects 16:9 / 1920 / letterbox / JPEG', () => {
  const html = renderPdfImportConfigHtml({ fileName: 'sample.pdf', pageCount: 3 });
  assert(radioChecked(html, 'pdfimport-aspect', '16:9'), '16:9 not checked');
  assert(!radioChecked(html, 'pdfimport-aspect', '4:3'), '4:3 should NOT be checked');
  assert(radioChecked(html, 'pdfimport-resolution', '1920'), '1920 not checked');
  assert(radioChecked(html, 'pdfimport-fit', 'letterbox'), 'letterbox not checked');
  assert(radioChecked(html, 'pdfimport-format', 'jpeg'), 'jpeg not checked');
});

test('renderPdfImportConfigHtml: aspect=4:3 flips the aspect radio', () => {
  const cfg: PdfImportConfig = { ...DEFAULT_PDF_IMPORT_CONFIG, aspect: '4:3' };
  const html = renderPdfImportConfigHtml({ fileName: 's.pdf', pageCount: 1, config: cfg });
  assert(radioChecked(html, 'pdfimport-aspect', '4:3'), '4:3 should be checked');
  assert(!radioChecked(html, 'pdfimport-aspect', '16:9'), '16:9 should NOT be checked');
});

test('renderPdfImportConfigHtml: format=png hides the quality slider via class', () => {
  const cfg: PdfImportConfig = { ...DEFAULT_PDF_IMPORT_CONFIG, format: 'png' };
  const html = renderPdfImportConfigHtml({ fileName: 's.pdf', pageCount: 1, config: cfg });
  assert(radioChecked(html, 'pdfimport-format', 'png'), 'png not checked');
  assert(
    /pdf-import-quality pdf-import-quality-hidden/.test(html),
    'quality block should carry pdf-import-quality-hidden when format=png',
  );
});

test('renderPdfImportConfigHtml: format=jpeg leaves the quality slider visible', () => {
  const html = renderPdfImportConfigHtml({ fileName: 's.pdf', pageCount: 1 });
  assert(
    !/pdf-import-quality-hidden/.test(html),
    'quality block should NOT carry pdf-import-quality-hidden when format=jpeg',
  );
});

test('renderPdfImportConfigHtml: quality reflected in slider value + readout', () => {
  const cfg: PdfImportConfig = { ...DEFAULT_PDF_IMPORT_CONFIG, quality: 0.6 };
  const html = renderPdfImportConfigHtml({ fileName: 's.pdf', pageCount: 1, config: cfg });
  assert(/id="pdfimport-quality"[^>]*value="0.6"/.test(html), 'slider value=0.6');
  assert(/id="pdfimport-quality-value">60%/.test(html), 'readout = 60%');
});

test('renderPdfImportConfigHtml: all RESOLUTION_PRESETS appear as radios', () => {
  const html = renderPdfImportConfigHtml({ fileName: 's.pdf', pageCount: 1 });
  for (const px of RESOLUTION_PRESETS) {
    assert(hasRadio(html, 'pdfimport-resolution', String(px)), `missing radio for ${px}`);
  }
});

test('renderPdfImportConfigHtml: device row appears when devicePxW is novel', () => {
  const html = renderPdfImportConfigHtml({
    fileName: 's.pdf',
    pageCount: 1,
    devicePxW: 3008, // not in RESOLUTION_PRESETS
  });
  assert(hasRadio(html, 'pdfimport-resolution', '3008'), 'device radio missing');
  assert(/Device \(3008px\)/.test(html), 'device label missing');
});

test('renderPdfImportConfigHtml: device row hidden when devicePxW matches a preset', () => {
  const html = renderPdfImportConfigHtml({
    fileName: 's.pdf',
    pageCount: 1,
    devicePxW: 1920,
  });
  // Still exactly one 1920 radio — no duplicate "Device (1920)".
  const matches = html.match(/name="pdfimport-resolution"[^>]*value="1920"/g) ?? [];
  assert(matches.length === 1, `expected 1 1920 radio, found ${matches.length}`);
  assert(!/Device \(/.test(html), 'no Device label when devicePxW matches preset');
});

test('renderPdfImportConfigHtml: device row hidden when devicePxW is undefined', () => {
  const html = renderPdfImportConfigHtml({ fileName: 's.pdf', pageCount: 1 });
  assert(!/Device \(/.test(html), 'no Device label by default');
});

test('renderPdfImportConfigHtml: status text lands in the status row', () => {
  const html = renderPdfImportConfigHtml({
    fileName: 's.pdf',
    pageCount: 5,
    status: 'Rendering page 3 of 5…',
  });
  assert(
    /id="pdfimport-status">Rendering page 3 of 5…</.test(html),
    'status text missing from status div',
  );
});

test('renderPdfImportConfigHtml: status row is HTML-escaped', () => {
  const html = renderPdfImportConfigHtml({
    fileName: 'a&b<c>.pdf',
    pageCount: 1,
    status: '<script>x()</script>',
  });
  assert(html.includes('a&amp;b&lt;c&gt;.pdf'), 'filename should be HTML-escaped');
  assert(html.includes('&lt;script&gt;x()&lt;/script&gt;'), 'status should be HTML-escaped');
  // Sanity: no raw <script> from injected status survives.
  assert(!/<script>x\(\)<\/script>/.test(html), 'raw injected script should not appear');
});

test('renderPdfImportConfigHtml: page-count line is singular vs plural', () => {
  const oneHtml = renderPdfImportConfigHtml({ fileName: 's.pdf', pageCount: 1 });
  const manyHtml = renderPdfImportConfigHtml({ fileName: 's.pdf', pageCount: 12 });
  assert(/1 page from/.test(oneHtml), 'singular "page"');
  assert(/12 pages from/.test(manyHtml), 'plural "pages"');
});

test('renderPdfImportConfigHtml: pageCount undefined shows "Reading…" line', () => {
  const html = renderPdfImportConfigHtml({ fileName: 's.pdf' });
  assert(/Reading <code>s\.pdf<\/code>/.test(html), 'should show Reading… when no pageCount');
});

test('renderPdfImportConfigHtml: rerenderDisabled adds disabled to Re-render only', () => {
  const html = renderPdfImportConfigHtml({
    fileName: 's.pdf',
    pageCount: 1,
    rerenderDisabled: true,
  });
  assert(/id="pdfimport-rerender-btn"[^>]*disabled/.test(html), 'rerender should be disabled');
  assert(
    !/id="pdfimport-import-btn"[^>]*disabled/.test(html),
    'import should not be disabled when only rerenderDisabled set',
  );
  assert(
    !/id="pdfimport-cancel-btn"[^>]*disabled/.test(html),
    'cancel should never be disabled',
  );
});

test('renderPdfImportConfigHtml: importDisabled adds disabled to Import only', () => {
  const html = renderPdfImportConfigHtml({
    fileName: 's.pdf',
    pageCount: 1,
    importDisabled: true,
  });
  assert(/id="pdfimport-import-btn"[^>]*disabled/.test(html), 'import should be disabled');
  assert(
    !/id="pdfimport-rerender-btn"[^>]*disabled/.test(html),
    'rerender should not be disabled',
  );
});

test('renderPdfImportConfigHtml: structural ids present for Phase D wiring', () => {
  const html = renderPdfImportConfigHtml({ fileName: 's.pdf', pageCount: 1 });
  for (const id of [
    'pdf-import-title',
    'pdfimport-status',
    'pdfimport-cancel-btn',
    'pdfimport-rerender-btn',
    'pdfimport-import-btn',
    'pdfimport-quality',
    'pdfimport-quality-value',
  ]) {
    assert(html.includes(`id="${id}"`), `missing id="${id}"`);
  }
});

test('pdfImportConfigCss: returns a non-empty string of CSS rules', () => {
  const css = pdfImportConfigCss();
  assert(typeof css === 'string', 'CSS should be a string');
  assert(css.length > 200, 'CSS suspiciously short');
  assert(css.includes('.pdf-import-modal'), 'expected .pdf-import-modal rule');
  assert(css.includes('.pdf-import-quality-hidden'), 'expected quality-hidden rule');
});

// ─── runner ─────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok: ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL: ${name}`);
      console.log(`    ${(e as Error).message}`);
    }
  }
  if (failed) {
    console.log(`\n${failed} test(s) failed`);
    process.exit(1);
  } else {
    console.log('all tests passed');
  }
}

run();
