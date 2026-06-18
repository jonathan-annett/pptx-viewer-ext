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

// ───── multi-select toolbar + modal host ─────────────────────────────────

function test_multi_toolbar_present_hidden(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /id="multi-toolbar"/, 'multi-toolbar container present');
  assert.match(html, /id="multi-status"/, 'multi-status text element present');
  assert.match(html, /id="multi-clear-btn"/, 'clear-selection button present');
  assert.match(html, /id="multi-update-btn"/, 'update-file button present');
  // The toolbar should ship `hidden` so it's invisible until the inline script
  // flips selection mode on via the first shift-click.
  assert.match(html, /id="multi-toolbar"[^>]*hidden/, 'multi-toolbar initially hidden');
  // The update button should ship disabled until the primed condition holds.
  assert.match(html, /id="multi-update-btn"[^>]*disabled/, 'update button initially disabled');
  console.log('  ok: multi-select toolbar present, initially hidden, update disabled');
}

function test_modal_host_present(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /id="modal-host"/, 'modal-host overlay present');
  assert.match(html, /aria-hidden="true"/, 'modal-host initially aria-hidden=true');
  console.log('  ok: modal-host overlay container present and aria-hidden by default');
}

function test_selection_css_classes_defined(): void {
  // The CSS must define the three selection-state classes that the inline
  // script toggles: .selected (yellow), .selected.primed (lime green),
  // .disabled.updated (dimmed) and .disabled.removed (red-tinged).
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /\.hit\.selected\s*\{/, '.hit.selected rule defined');
  assert.match(html, /\.hit\.selected\.primed\s*\{/, '.hit.selected.primed rule defined');
  assert.match(html, /\.hit\.disabled\.updated\s*\{/, '.hit.disabled.updated rule defined');
  assert.match(html, /\.hit\.disabled\.removed\s*\{/, '.hit.disabled.removed rule defined');
  console.log('  ok: selection / primed / disabled CSS rules defined');
}

function test_compare_modal_css_included(): void {
  // The shared compareModalCss() must be inlined so the side-by-side update
  // modal renders with the correct layout when the extension posts its HTML.
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /\.modal-host\s*\{/, '.modal-host overlay rules from compareModalCss');
  assert.match(html, /\.compare-grid\s*\{/, '.compare-grid rules from compareModalCss');
  assert.match(html, /\.compare-col\s*\{/, '.compare-col rules from compareModalCss');
  console.log('  ok: compareModalCss inlined for the update modal');
}

function test_script_wires_multi_select(): void {
  // Sanity-check that the inline script carries the new wiring: selection
  // state vars, message types both directions, button handlers.
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /selectionMode/, 'selectionMode state var');
  assert.match(html, /selectedKeys/, 'selectedKeys set');
  assert.match(html, /disabledKeys/, 'disabledKeys map');
  assert.match(html, /evaluatePrimedKeys/, 'primed-state evaluator');
  assert.match(html, /'updateFile'/, 'outbound updateFile message type');
  assert.match(html, /'updateConfirm'/, 'outbound updateConfirm message type');
  assert.match(html, /'updateCancel'/, 'outbound updateCancel message type');
  assert.match(html, /'updateModal'/, 'inbound updateModal handler');
  assert.match(html, /'updateResult'/, 'inbound updateResult handler');
  assert.match(html, /'updated-removed'/, 'updateResult handles updated-removed outcome');
  assert.match(html, /shiftKey/, 'click handler inspects shiftKey for selection-mode entry');
  console.log('  ok: panel script wires multi-select + update flow');
}

function test_hash_badge_css_defined(): void {
  // The CSS must define the .hash-badge rule used by the inline script to
  // colour-pair identical-content rows.
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /\.hash-badge\s*\{/, '.hash-badge rule defined');
  console.log('  ok: hash-pairing badge CSS rule defined');
}

function test_script_wires_hash_palette(): void {
  // Sanity-check that the inline script carries the palette + sha-counting
  // wiring. The palette identifier is HASH_PALETTE; the per-render maps are
  // shaCounts and shaColors. The badge element uses the .hash-badge class.
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /HASH_PALETTE/, 'palette constant present');
  assert.match(html, /shaCounts/, 'sha-count map computed');
  assert.match(html, /shaColors/, 'sha-colour map computed');
  assert.match(html, /'hash-badge'/, 'renderHit emits a .hash-badge element');
  console.log('  ok: panel script wires the hash-pairing badge');
}

// ───── OR-mode checkbox ─────────────────────────────────────────────────

function test_or_checkbox_present(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /id="or-mode"/, 'OR-mode checkbox input present');
  assert.match(html, /type="checkbox"/, 'OR control is a checkbox');
  assert.match(html, /Any term \(OR\)/, 'OR control label text present');
  console.log('  ok: OR-mode checkbox + label rendered in header');
}

function test_script_wires_op_field(): void {
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  // The inline script should read the checkbox and post `op` with the search.
  assert.match(html, /currentOp/, 'currentOp() helper present');
  assert.match(html, /op: currentOp\(\)/, 'search message carries op field');
  assert.match(html, /'or-mode'/, 'script references the OR-mode checkbox id');
  console.log('  ok: panel script threads op into the search message');
}

// ───── error-state surface (M6) ─────────────────────────────────────────

function test_script_surfaces_error_count(): void {
  // The inline updateFooter should append "· N error(s)" when the indexer
  // reports a non-zero error count. We can't execute the script in tsx but
  // we can sanity-check that the source carries the wiring.
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /msg\.errors/, 'updateFooter reads the errors field');
  assert.match(html, /Pptx Info/, 'error tooltip points at the Output Channel');
  console.log('  ok: panel script surfaces indexer error count + tooltip');
}

function test_script_reacts_to_scope_change(): void {
  // The inline updateFooter should flip into the empty-scope state when the
  // scopeFolderCount field drops to zero (workspace folder removed while the
  // panel is open).
  const html = renderSearchPanelHtml(
    { indexedDone: 0, indexedTotal: 0, scopeFolderCount: 1 },
    NONCE,
  );
  assert.match(html, /scopeFolderCount/, 'updateFooter reads scopeFolderCount');
  assert.match(html, /No source folders in scope/, 'empty-scope footer text present in script branches');
  console.log('  ok: panel script reacts to scope-changed-to-zero topology updates');
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
  ['multi-toolbar present + hidden + update disabled', test_multi_toolbar_present_hidden],
  ['modal-host overlay present', test_modal_host_present],
  ['selection / primed / disabled CSS classes', test_selection_css_classes_defined],
  ['compareModalCss inlined', test_compare_modal_css_included],
  ['script wires multi-select + update flow', test_script_wires_multi_select],
  ['hash-badge CSS rule defined', test_hash_badge_css_defined],
  ['script wires hash-pairing palette + badge', test_script_wires_hash_palette],
  ['OR-mode checkbox + label present', test_or_checkbox_present],
  ['script threads op field into search message', test_script_wires_op_field],
  ['script surfaces indexer error count', test_script_surfaces_error_count],
  ['script reacts to scope changing to zero', test_script_reacts_to_scope_change],
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
