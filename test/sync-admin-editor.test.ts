// Smoke tests for the pure HTML renderer used by the .admin-sync.jsonc
// custom editor. The vscode-wired half is in src/sync/adminEditor.ts and is
// not covered here — these tests run under plain Node via tsx alongside the
// other pure-renderer smoke tests.
//
// Run with: npm run test:sync-admin-editor

import { strict as assert } from 'node:assert';
import {
  renderAdminEditorHtml,
  type AdminEditorFolder,
  type AdminEditorViewModel,
  type PlaceholderRow,
} from '../src/sync/adminEditorHtml';
import { EMPTY_FILE_SHA256 } from '../src/sync/snapshot';

function folder(overrides: Partial<AdminEditorFolder> & { uri: string; name: string }): AdminEditorFolder {
  return {
    index: 0,
    isWorkspaceRoot: false,
    sources: [],
    canCreateSource: false,
    ...overrides,
  };
}

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

function baseVm(overrides: Partial<AdminEditorViewModel> = {}): AdminEditorViewModel {
  return {
    folders: [],
    settings: [],
    placeholders: [
      { sha256: EMPTY_FILE_SHA256, locked: true, label: '(default — zero-byte file)' },
    ],
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
  // init payload + client JS + shared decision-wiring snippet from planHtml.
  const occurrences = html.split('nonce="abc123"').length - 1;
  assert.equal(occurrences, 3, 'nonce should appear on all three <script> tags');
});

test('init payload includes folders, settings, capturedAt, pointerInfo', () => {
  const html = renderAdminEditorHtml(
    baseVm({
      folders: [folder({ uri: 'file:///x', name: 'X', index: 0, isWorkspaceRoot: true })],
      settings: [{ key: 'files.readonlyInclude', valueSummary: '[2 item(s)]', unknown: false }],
      capturedAt: '2026-05-19T03:00:00.000Z',
      pointerInfo: { uri: 'file:///x/.admin-sync.jsonc', lastWriteAt: '2026-05-19T03:00:00.000Z' },
    }),
    'n',
  );
  // Fields appear in any order in the serialised JSON; check each key
  // individually rather than locking down the property order.
  assert.match(html, /"folders":\[/);
  assert.match(html, /"uri":"file:\/\/\/x"/);
  assert.match(html, /"name":"X"/);
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

test('renders the embedded workspace-wide plan section', () => {
  // M4.7 added a Full Dry-Run plan card to the admin editor. The plan card
  // hosts the auto-running workspace-wide dry-run + Run Sync button. Initial
  // state is "Scanning…" — the extension posts a `planStatus` once the walk
  // completes (or fails).
  const html = renderAdminEditorHtml(baseVm(), 'n');
  assert.match(html, /<h2>Full dry-run plan — this workspace<\/h2>/);
  assert.match(html, /id="plan-status"/);
  assert.match(html, /id="plan-totals"/);
  assert.match(html, /id="plan-pairs"/);
  assert.match(html, /id="plan-refresh"/);
  assert.match(html, /id="run-sync"/);
  // Initial banner is the scanning indicator — the page-load state.
  assert.match(html, /class="plan-status plan-scanning">Scanning/);
  // Run Sync starts disabled — it's enabled by setPlanReady when the plan
  // finishes with hasWork && !blocking.
  assert.match(html, /id="run-sync"[^>]*disabled/);
  // Orange "safe items only" button is in the markup, initially hidden.
  // setPlanReady reveals it when blocking>0 and safe-path items exist.
  assert.match(html, /id="run-sync-safe"[^>]*class="btn btn-orange"/);
  assert.match(html, /id="run-sync-safe"[^>]*hidden/);
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
      folders: [folder({ uri: 'file:///x', name: '</script><script>alert(1)</script>' })],
    }),
    'n',
  );
  assert.ok(!html.includes('</script><script>alert(1)'), 'breakout sequence leaked into HTML');
  assert.match(html, /\\u003c\/script>/);
});

// ───── folder source links / create-source button ──────────────────────

test('folder sources surface in the init payload', () => {
  // Sources serialise into the data-island so the client renderer can build
  // the per-row link list at mount. This catches a regression where the
  // payload accidentally drops `sources` from the JSON shape.
  const html = renderAdminEditorHtml(
    baseVm({
      folders: [
        folder({
          uri: 'file:///dest',
          name: 'Dest',
          index: 1,
          isWorkspaceRoot: false,
          sources: [
            {
              configUri: 'file:///src/.sync.jsonc',
              sourceFolderUri: 'file:///src',
              displayPath: 'src',
              subpath: '',
            },
          ],
        }),
      ],
    }),
    'n',
  );
  assert.match(html, /"sources":\[/);
  assert.match(html, /"sourceFolderUri":"file:\/\/\/src"/);
  assert.match(html, /"displayPath":"src"/);
  assert.match(html, /"configUri":"file:\/\/\/src\/\.sync\.jsonc"/);
});

test('canCreateSource surfaces in the init payload', () => {
  const html = renderAdminEditorHtml(
    baseVm({
      folders: [folder({ uri: 'file:///orphan', name: 'Orphan', index: 1, canCreateSource: true })],
    }),
    'n',
  );
  assert.match(html, /"canCreateSource":true/);
});

test('folder grid template reserves a column for the source-link cell', () => {
  // Five tracks now: idx | name | uri | source-links | actions. The pure
  // renderer's CSS is the contract — a regression that drops the column
  // would collapse the layout, this assertion catches that early.
  const html = renderAdminEditorHtml(baseVm(), 'n');
  assert.match(
    html,
    /\.folder-list li \{ grid-template-columns: 24px minmax\(140px, 1fr\) minmax\(160px, 2fr\) minmax\(160px, auto\) auto; \}/,
  );
});

test('header explains the file is managed automatically', () => {
  const html = renderAdminEditorHtml(baseVm(), 'n');
  assert.match(html, /managed automatically/i);
  assert.match(html, /Do not hand-edit/i);
});

// ───── placeholders card ──────────────────────────────────────────────────

test('renders the Placeholders card section + add button', () => {
  const html = renderAdminEditorHtml(baseVm(), 'n');
  assert.match(html, /id="placeholders-card"/);
  assert.match(html, /id="placeholder-list"/);
  assert.match(html, /id="add-placeholder"/);
  assert.match(html, /Add placeholder/);
});

test('init payload carries the locked default row even when no user entries exist', () => {
  const html = renderAdminEditorHtml(baseVm(), 'n');
  // The locked default row is constructed in the wired buildViewModel; the
  // pure renderer accepts whatever's in the VM. baseVm() seeds the locked
  // row, mirroring what the wired side will do.
  assert.match(html, new RegExp(`"sha256":"${EMPTY_FILE_SHA256}","locked":true`));
});

test('init payload includes user placeholder entries unlocked, after the default', () => {
  const placeholders: PlaceholderRow[] = [
    { sha256: EMPTY_FILE_SHA256, locked: true, label: '(default — zero-byte file)' },
    { sha256: 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899', locked: false },
  ];
  const html = renderAdminEditorHtml(baseVm({ placeholders }), 'n');
  assert.match(
    html,
    /"sha256":"aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899","locked":false/,
  );
});

test('placeholder hashes are JSON-encoded plainly (hex only, no escape needed)', () => {
  // Sanity check: hashes are lowercase hex so escapeHtml / JSON escape has
  // nothing to do. Catches a future regression where a hash field accidentally
  // becomes user-supplied text and would need explicit escaping.
  const placeholders: PlaceholderRow[] = [
    { sha256: EMPTY_FILE_SHA256, locked: true, label: '(default — zero-byte file)' },
    { sha256: 'deadbeef'.repeat(8), locked: false },
  ];
  const html = renderAdminEditorHtml(baseVm({ placeholders }), 'n');
  assert.match(html, /"sha256":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"/);
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
