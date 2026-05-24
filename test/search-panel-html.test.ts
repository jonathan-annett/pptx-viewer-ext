// Tests for src/search/searchPanelHtml.ts.
// Run with: npm run test:search-panel-html

import { strict as assert } from 'node:assert';
import { renderSearchPanelHtml } from '../src/search/searchPanelHtml';

const NONCE = 'TEST_NONCE_abc123';

// ───── shell + CSP ──────────────────────────────────────────────────────

function test_doctype_and_lang(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  assert.ok(html.startsWith('<!DOCTYPE html>'), 'starts with doctype');
  assert.match(html, /<html lang="en">/);
  console.log('  ok: doctype + html lang');
}

function test_csp_meta_present(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  // Match the exact CSP shape the project convention uses. Splitting these
  // assertions per-directive makes a partial-regression easier to read.
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /style-src 'unsafe-inline'/);
  assert.match(html, /img-src data:/);
  assert.match(html, new RegExp(`script-src 'nonce-${NONCE}'`));
  console.log('  ok: CSP meta has default-src none + nonce-tagged script-src');
}

function test_nonce_on_inline_script(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  // The inline driver script must carry the nonce so the strict CSP allows it.
  assert.match(html, new RegExp(`<script nonce="${NONCE}">`));
  console.log('  ok: inline <script> carries the nonce');
}

function test_nonce_appears_only_where_expected(): void {
  // The nonce should appear exactly twice: once in the CSP meta, once on
  // the <script> tag. Anything else would suggest the nonce leaked into
  // user-controlled content.
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  const matches = html.match(new RegExp(NONCE, 'g')) ?? [];
  assert.equal(matches.length, 2, `expected 2 nonce occurrences, got ${matches.length}`);
  console.log('  ok: nonce occurs exactly twice (CSP + script tag)');
}

// ───── shell elements ────────────────────────────────────────────────────

function test_shell_elements_present(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /id="q"/, 'search input id="q"');
  assert.match(html, /id="reindex"/, 'reindex button');
  assert.match(html, /id="results"/, 'results container');
  assert.match(html, /id="footer-text"/, 'footer text span');
  assert.match(html, /aria-live="polite"/, 'results region is aria-live polite');
  assert.match(html, /aria-label="Search query"/, 'search input has aria-label');
  console.log('  ok: shell elements (q, reindex, results, footer) all present');
}

function test_h1_present(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /<h1>Presentation Search<\/h1>/);
  console.log('  ok: h1 with panel title');
}

// ───── footer text variants ──────────────────────────────────────────────

function test_footer_empty_scope(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 0 },
    NONCE,
  );
  assert.match(html, /No source folders in scope/);
  console.log('  ok: footer says "no source folders" when scope is empty');
}

function test_footer_scanning_state(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 2 },
    NONCE,
  );
  // total=0 with scopeFolderCount>0 → still walking
  assert.match(html, /Scanning 2 folders…/);
  console.log('  ok: footer says "Scanning N folders…" before first walk completes');
}

function test_footer_scanning_singular(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /Scanning 1 folder…/);
  // Plural-s should NOT appear for the singular case.
  assert.doesNotMatch(html, /Scanning 1 folders/);
  console.log('  ok: footer pluralisation handles singular folder');
}

function test_footer_indexed_count(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 5, indexedTotal: 12, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /5 of 12 presentations indexed/);
  console.log('  ok: footer shows "N of M presentations indexed"');
}

function test_footer_indexed_singular(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 1, indexedTotal: 1, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /1 of 1 presentation indexed/);
  assert.doesNotMatch(html, /1 of 1 presentations indexed/);
  console.log('  ok: footer pluralisation handles singular presentation');
}

// ───── empty state ───────────────────────────────────────────────────────

function test_empty_state_with_scope(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 2 },
    NONCE,
  );
  assert.match(html, /Type to search across the source-folder presentations/);
  console.log('  ok: empty state prompts user to type when scope is healthy');
}

function test_empty_state_no_scope(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 0 },
    NONCE,
  );
  assert.match(html, /No source folders to search/);
  assert.match(html, /\.sync\.jsonc/);
  console.log('  ok: empty state explains the no-scope case (mentions .sync.jsonc)');
}

// ───── escape safety ─────────────────────────────────────────────────────

function test_nonce_is_not_html_escaped(): void {
  // Nonces are random base64ish strings; if a nonce included &, <, etc.
  // the renderer would need to escape only inside the meta attribute. We
  // generate nonces from crypto bytes (alphanumeric), so we explicitly want
  // them passed through as-is — assert that an alphanumeric nonce is not
  // mutated.
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    'AbC123xyz',
  );
  assert.match(html, /content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-AbC123xyz';"/);
  console.log('  ok: alphanumeric nonce passes through unmodified');
}

// ───── script presence ───────────────────────────────────────────────────

function test_script_drives_panel(): void {
  // We can't execute the inline script in tsx, but we can sanity-check that
  // the message handlers and the IIFE wrapper landed. If any of these go
  // missing it almost certainly means the panel is broken at runtime.
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /acquireVsCodeApi/, 'script obtains the vscode webview api');
  assert.match(html, /addEventListener\('input'/, 'wires the input event');
  assert.match(html, /'reindex'/, 'reindex message handler present');
  assert.match(html, /'search'/, 'search message present');
  assert.match(html, /'open'/, 'open message present');
  assert.match(html, /'results'/, 'results message handler present');
  assert.match(html, /'indexProgress'/, 'indexProgress message handler present');
  assert.match(html, /'indexComplete'/, 'indexComplete message handler present');
  console.log('  ok: panel script contains the expected wiring + message names');
}

// ───── runner ────────────────────────────────────────────────────────────

const tests: Array<[string, () => void]> = [
  ['doctype + html lang', test_doctype_and_lang],
  ['CSP meta with default-src none', test_csp_meta_present],
  ['inline script carries nonce', test_nonce_on_inline_script],
  ['nonce occurs exactly twice', test_nonce_appears_only_where_expected],
  ['shell elements present', test_shell_elements_present],
  ['h1 title present', test_h1_present],
  ['footer: empty scope', test_footer_empty_scope],
  ['footer: scanning state', test_footer_scanning_state],
  ['footer: scanning singular', test_footer_scanning_singular],
  ['footer: indexed count', test_footer_indexed_count],
  ['footer: indexed singular', test_footer_indexed_singular],
  ['empty state with scope', test_empty_state_with_scope],
  ['empty state no scope', test_empty_state_no_scope],
  ['nonce passes through unmodified', test_nonce_is_not_html_escaped],
  ['script wiring sanity', test_script_drives_panel],
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
