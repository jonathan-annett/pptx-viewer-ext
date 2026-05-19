// Smoke tests for the pure HTML renderer used by the .sync.jsonc custom
// editor. The vscode-wired half is in src/sync/configEditor.ts and is not
// covered here — these tests live alongside the other pure-renderer smoke
// tests and run under plain Node via tsx.
//
// Run with: npm run test:sync-config-editor

import { strict as assert } from 'node:assert';
import {
  renderConfigEditorHtml,
  type ConfigEditorViewModel,
} from '../src/sync/configEditorHtml';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

function baseVm(overrides: Partial<ConfigEditorViewModel> = {}): ConfigEditorViewModel {
  return {
    initialConfig: { destinations: [], include: [], exclude: [] },
    workspaceFolderNames: [],
    parseError: null,
    ...overrides,
  };
}

test('renders a CSP meta tag with the supplied nonce', () => {
  const html = renderConfigEditorHtml(baseVm(), 'abc123');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'nonce-abc123'/);
  // The nonce is used on both scripts (init payload + client JS).
  const occurrences = html.split('nonce="abc123"').length - 1;
  assert.equal(occurrences, 2, 'nonce should appear on both <script> tags');
});

test('init payload includes destinations, includes, excludes', () => {
  const html = renderConfigEditorHtml(
    baseVm({
      initialConfig: {
        destinations: [{ name: 'foo', path: 'a/b' }],
        include: ['**/*.ts'],
        exclude: ['*.tmp'],
      },
      workspaceFolderNames: ['foo', 'bar'],
    }),
    'n',
  );
  // The data-island is one JSON line — match it loosely.
  assert.match(html, /"destinations":\[\{"name":"foo","path":"a\/b"\}\]/);
  assert.match(html, /"include":\["\*\*\/\*\.ts"\]/);
  assert.match(html, /"exclude":\["\*\.tmp"\]/);
  assert.match(html, /"workspaceFolderNames":\["foo","bar"\]/);
});

test('parseError surfaces as a payload field', () => {
  const html = renderConfigEditorHtml(
    baseVm({ parseError: 'bad json at offset 5' }),
    'n',
  );
  assert.match(html, /"parseError":"bad json at offset 5"/);
});

test('renders the standard form sections', () => {
  const html = renderConfigEditorHtml(baseVm(), 'n');
  assert.match(html, /<h2>Destinations<\/h2>/);
  assert.match(html, /<h2>Include<\/h2>/);
  assert.match(html, /<h2>Exclude<\/h2>/);
  assert.match(html, /id="add-dest"/);
  assert.match(html, /id="open-workspace-plan"/);
  assert.match(html, /id="open-text"/);
});

test('renders the embedded room-scoped plan section', () => {
  const html = renderConfigEditorHtml(baseVm(), 'n');
  // The plan card hosts the auto-running scoped dry-run. Initial state is
  // "Scanning…" — the extension posts a `planStatus` message once the
  // walk + classify finish (or fails).
  assert.match(html, /<h2>Dry-run plan — this room<\/h2>/);
  assert.match(html, /id="plan-status"/);
  assert.match(html, /id="plan-totals"/);
  assert.match(html, /id="plan-pairs"/);
  assert.match(html, /id="plan-refresh"/);
  // The initial banner is the scanning indicator — the page-load state.
  assert.match(html, /class="plan-status plan-scanning">Scanning/);
});

test('relabelled action button references the workspace-wide plan, not "dry run"', () => {
  // M4.7 renamed "Open dry-run plan" → "Open workspace-wide plan" so the
  // scope distinction from the embedded plan card is explicit. Regression
  // guard against accidentally reverting the label.
  const html = renderConfigEditorHtml(baseVm(), 'n');
  assert.match(html, /Open workspace-wide plan/);
  assert.ok(!/>Open dry-run plan</.test(html), 'old "Open dry-run plan" label should not appear');
});

test('payload escapes </ to prevent script-tag breakout', () => {
  // A workspace folder name with "</script>" would, if naively interpolated,
  // close the surrounding <script type="application/json"> tag. The renderer
  // escapes "<" as "\u003c" inside the payload.
  const html = renderConfigEditorHtml(
    baseVm({ workspaceFolderNames: ['</script><script>alert(1)</script>'] }),
    'n',
  );
  assert.ok(!html.includes('</script><script>alert(1)'), 'breakout sequence leaked into HTML');
  assert.match(html, /\\u003c\/script>/);
});

// ───── run ────────────────────────────────────────────────────────────────

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
