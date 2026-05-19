// Smoke tests for the pure HTML renderer used by the .admin-sync.jsonc
// custom editor. The vscode-wired half is in src/sync/adminEditor.ts and is
// not covered here — these tests run under plain Node via tsx alongside the
// other pure-renderer smoke tests.
//
// Run with: npm run test:sync-admin-editor

import { strict as assert } from 'node:assert';
import {
  renderAdminEditorHtml,
  type AdminEditorViewModel,
} from '../src/sync/adminEditorHtml';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

function baseVm(overrides: Partial<AdminEditorViewModel> = {}): AdminEditorViewModel {
  return {
    folders: [],
    settings: [],
    capturedAt: '',
    pointerInfo: null,
    parseError: null,
    ...overrides,
  };
}

test('renders a CSP meta tag with the supplied nonce', () => {
  const html = renderAdminEditorHtml(baseVm(), 'abc123');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'nonce-abc123'/);
  const occurrences = html.split('nonce="abc123"').length - 1;
  assert.equal(occurrences, 2, 'nonce should appear on both <script> tags');
});

test('init payload includes folders, settings, capturedAt, pointerInfo', () => {
  const html = renderAdminEditorHtml(
    baseVm({
      folders: [{ uri: 'file:///x', name: 'X' }],
      settings: [{ key: 'files.readonlyInclude', valueSummary: '[2 item(s)]', unknown: false }],
      capturedAt: '2026-05-19T03:00:00.000Z',
      pointerInfo: { uri: 'file:///x/.admin-sync.jsonc', lastWriteAt: '2026-05-19T03:00:00.000Z' },
    }),
    'n',
  );
  assert.match(html, /"folders":\[\{"uri":"file:\/\/\/x","name":"X"\}\]/);
  assert.match(html, /"key":"files\.readonlyInclude"/);
  assert.match(html, /"valueSummary":"\[2 item\(s\)\]"/);
  assert.match(html, /"capturedAt":"2026-05-19T03:00:00\.000Z"/);
  assert.match(html, /"pointerInfo":\{"uri":"file:\/\/\/x\/\.admin-sync\.jsonc"/);
});

test('parseError surfaces as a payload field', () => {
  const html = renderAdminEditorHtml(
    baseVm({ parseError: 'folders is not an array' }),
    'n',
  );
  assert.match(html, /"parseError":"folders is not an array"/);
});

test('pointerInfo null serialises as JSON null, not omitted', () => {
  const html = renderAdminEditorHtml(baseVm({ pointerInfo: null }), 'n');
  assert.match(html, /"pointerInfo":null/);
});

test('renders the standard sections + action buttons', () => {
  const html = renderAdminEditorHtml(baseVm(), 'n');
  assert.match(html, /<h1>Workspace snapshot<\/h1>/);
  assert.match(html, /<h2>Pointer<\/h2>/);
  assert.match(html, /<h2>Folders<\/h2>/);
  assert.match(html, /<h2>Settings<\/h2>/);
  assert.match(html, /id="refresh"/);
  assert.match(html, /id="clear"/);
  assert.match(html, /id="open-text"/);
});

test('settings unknown flag is preserved in payload', () => {
  const html = renderAdminEditorHtml(
    baseVm({
      settings: [
        { key: 'files.readonlyInclude', valueSummary: '[1]', unknown: false },
        { key: 'editor.fontSize', valueSummary: '14', unknown: true },
      ],
    }),
    'n',
  );
  assert.match(html, /"key":"editor\.fontSize","valueSummary":"14","unknown":true/);
  assert.match(html, /"key":"files\.readonlyInclude","valueSummary":"\[1\]","unknown":false/);
});

test('payload escapes </ to prevent script-tag breakout', () => {
  // A folder name containing "</script>" would close the surrounding
  // <script type="application/json"> tag if naively interpolated. The
  // renderer escapes "<" as "\u003c" inside the JSON payload.
  const html = renderAdminEditorHtml(
    baseVm({
      folders: [{ uri: 'file:///x', name: '</script><script>alert(1)</script>' }],
    }),
    'n',
  );
  assert.ok(!html.includes('</script><script>alert(1)'), 'breakout sequence leaked into HTML');
  assert.match(html, /\\u003c\/script>/);
});

test('header explains the file is managed automatically', () => {
  const html = renderAdminEditorHtml(baseVm(), 'n');
  assert.match(html, /managed automatically/i);
  assert.match(html, /Do not hand-edit/i);
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
