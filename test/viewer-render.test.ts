// Smoke tests for the pptx viewer's renderHtml() — locks in the visible
// invariants the M4.7 Phase D-adj rewrite introduced: Save As / Update
// buttons, validation suppressed on parseError, sync target section,
// initialStatus baking, modal/overlay host nodes.
// Run with: npm run test:viewer-render

import { strict as assert } from 'node:assert';
import { renderHtml } from '../src/webview';
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
    flags: {
      linkedMedia: { ok: true, label: 'Linked media', detail: '' },
      showType: { ok: true, label: 'Show type', detail: '' },
      showMediaControls: { ok: true, label: 'Show media controls', detail: '' },
    },
  };
  return { ...base, ...overrides };
}

const NONCE = 'test-nonce-1234567890abcdef';

// ───── action row ───────────────────────────────────────────────────────

test('renderHtml: shows Save As… and Update… buttons with stable IDs', () => {
  const html = renderHtml(parseResult(), NONCE);
  assert.ok(html.includes('id="save-as-btn"'), 'save-as button id');
  assert.ok(html.includes('id="update-btn"'), 'update button id');
  assert.ok(/Save As/.test(html), 'save-as label');
  assert.ok(/Update/.test(html), 'update label');
});

test('renderHtml: includes hidden file input for picker flow', () => {
  const html = renderHtml(parseResult(), NONCE);
  assert.ok(html.includes('id="update-input"'), 'picker input id');
  assert.ok(/type="file"/.test(html), 'is file input');
  assert.ok(/accept="\.pptx/.test(html), 'accept filter present');
});

test('renderHtml: action-status starts empty by default', () => {
  const html = renderHtml(parseResult(), NONCE);
  // The status span exists, and (with no initialStatus) contains nothing
  // between the opening/closing tags.
  assert.ok(/id="action-status"[^>]*>(\s*)<\/span>/.test(html), 'empty status span');
});

test('renderHtml: initialStatus is baked into action-status', () => {
  const html = renderHtml(parseResult(), NONCE, { initialStatus: 'Updated' });
  assert.ok(/id="action-status"[^>]*>Updated<\/span>/.test(html), 'baked-in status');
});

test('renderHtml: initialStatus is HTML-escaped', () => {
  const html = renderHtml(parseResult(), NONCE, { initialStatus: '<script>x</script>' });
  assert.ok(!html.includes('<script>x</script>'), 'raw script not present');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped form present');
});

// ───── validation suppression on parseError ─────────────────────────────

test('renderHtml: validation section present when parsing succeeded', () => {
  const html = renderHtml(parseResult(), NONCE);
  assert.ok(/>Validation</.test(html), 'validation heading');
  assert.ok(html.includes('class="flag pass"') || html.includes('class="flag warn"'),
    'at least one flag li');
});

test('renderHtml: validation section omitted when parseError is set', () => {
  const html = renderHtml(parseResult({ parseError: 'Could not unzip' }), NONCE);
  assert.ok(!/>Validation</.test(html), 'no Validation heading on parseError');
  assert.ok(!html.includes('class="flag pass"'), 'no pass flag li');
  assert.ok(!html.includes('class="flag warn"'), 'no warn flag li');
});

test('renderHtml: parseError surfaces as a warn banner', () => {
  const html = renderHtml(parseResult({ parseError: 'Could not unzip' }), NONCE);
  assert.ok(html.includes('banner warn'), 'warn banner class');
  assert.ok(html.includes('Could not unzip'), 'error text present');
});

// ───── sync target section ──────────────────────────────────────────────

test('renderHtml: sync target section absent when syncTargetHtml omitted', () => {
  const html = renderHtml(parseResult(), NONCE);
  assert.ok(!/>Sync target</.test(html), 'no Sync target heading by default');
});

test('renderHtml: sync target section absent when syncTargetHtml is null', () => {
  const html = renderHtml(parseResult(), NONCE, { syncTargetHtml: null });
  assert.ok(!/>Sync target</.test(html), 'no Sync target heading on null');
});

test('renderHtml: sync target section rendered when syncTargetHtml provided', () => {
  const html = renderHtml(parseResult(), NONCE, {
    syncTargetHtml: '<div class="sync-target"><p>plan goes here</p></div>',
  });
  assert.ok(/>Sync target</.test(html), 'Sync target heading present');
  assert.ok(html.includes('plan goes here'), 'caller HTML inlined verbatim');
  assert.ok(html.includes('class="sync-target"'), 'caller wrapper preserved');
});

// ───── modal + drop overlay hosts ───────────────────────────────────────

test('renderHtml: modal-host container is present and starts closed', () => {
  const html = renderHtml(parseResult(), NONCE);
  assert.ok(html.includes('id="modal-host"'), 'modal host id');
  assert.ok(html.includes('aria-hidden="true"'), 'starts aria-hidden');
});

test('renderHtml: drop-overlay container is present', () => {
  const html = renderHtml(parseResult(), NONCE);
  assert.ok(html.includes('id="drop-overlay"'), 'drop overlay id');
  assert.ok(/Drop a \.pptx/.test(html), 'drop hint text');
});

// ───── CSP + nonce ──────────────────────────────────────────────────────

test('renderHtml: nonce flows into both CSP and the <script> tag', () => {
  const html = renderHtml(parseResult(), NONCE);
  assert.ok(html.includes(`script-src 'nonce-${NONCE}'`), 'CSP carries nonce');
  assert.ok(html.includes(`<script nonce="${NONCE}">`), 'script tag carries nonce');
});

test('renderHtml: CSP forbids default-src and allows only data: images', () => {
  const html = renderHtml(parseResult(), NONCE);
  assert.ok(html.includes("default-src 'none'"), 'default-src none');
  assert.ok(html.includes('img-src data:'), 'img-src data: only');
});

// ───── M5.1: shared decision-wiring snippet ─────────────────────────────

test('renderHtml: embeds the shared decisionWiringScript so per-row checkboxes post {type:"decision"}', () => {
  const html = renderHtml(parseResult(), NONCE);
  // Distinctive tokens emitted by decisionWiringScript() in src/sync/planHtml.ts.
  // The viewer needs these whether or not a sync-target section is present,
  // so the script can attach to rows that show up on a subsequent re-render
  // (drop / save-as → renderWithSyncTarget rebuilds the whole HTML, but the
  // first render with no sync section still benefits from a no-op listener).
  assert.ok(
    html.includes('__decisionWiringInstalled'),
    'delegated listener guard token present',
  );
  assert.ok(
    html.includes('__decisionVscode'),
    'cached vscode API singleton present (so the viewer + decision scripts share it)',
  );
  assert.ok(
    /type:\s*['"]decision['"]/.test(html),
    'decision message type emitted by the shared snippet',
  );
});

test('renderHtml: nonce flows onto every <script> tag (viewer + decision wiring)', () => {
  const html = renderHtml(parseResult(), NONCE);
  // M5.1 added a second <script> for the shared decisionWiringScript. Both
  // must carry the per-render nonce — otherwise the strict CSP blocks them.
  const occurrences = html.split(`<script nonce="${NONCE}">`).length - 1;
  assert.equal(occurrences, 2, 'two nonce-tagged <script> tags (viewer + decision wiring)');
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
