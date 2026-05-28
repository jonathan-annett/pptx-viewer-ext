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
    initialConfig: { destinations: [], include: [], exclude: [], pathAliases: {} },
    workspaceFolders: [],
    sourceFolderUri: null,
    claimedElsewhere: [],
    parseError: null,
    isWorkspaceRoot: false,
    workspaceRootHandle: '',
    roomSyncHandle: '',
    ...overrides,
  };
}

test('renders a CSP meta tag with the supplied nonce', () => {
  const html = renderConfigEditorHtml(baseVm(), 'abc123');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'nonce-abc123'/);
  // The nonce is used on all three scripts (init payload + client JS +
  // shared per-row decision wiring snippet from planHtml.ts).
  const occurrences = html.split('nonce="abc123"').length - 1;
  assert.equal(occurrences, 3, 'nonce should appear on all three <script> tags');
});

test('init payload includes destinations (uri-keyed), includes, excludes', () => {
  const html = renderConfigEditorHtml(
    baseVm({
      initialConfig: {
        destinations: [{ uri: 'file:///handle/abc', path: 'a/b' }],
        include: ['**/*.ts'],
        exclude: ['*.tmp'],
        pathAliases: {},
      },
      workspaceFolders: [
        { uri: 'file:///handle/abc', name: 'foo' },
        { uri: 'file:///handle/def', name: 'bar' },
      ],
    }),
    'n',
  );
  // Destinations are keyed by URI now; the form maps URI → display name at
  // render time via the workspaceFolders payload.
  assert.match(html, /"destinations":\[\{"uri":"file:\/\/\/handle\/abc","path":"a\/b"\}\]/);
  assert.match(html, /"include":\["\*\*\/\*\.ts"\]/);
  assert.match(html, /"exclude":\["\*\.tmp"\]/);
  assert.match(html, /"workspaceFolders":\[\{"uri":"file:\/\/\/handle\/abc","name":"foo"\}/);
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

test('renders a room-scoped Run Sync button, initially disabled', () => {
  // M4.7 follow-up: the room editor mirrors the admin editor's Run Sync
  // affordance, scoped to this room's plan. Initial state is disabled —
  // the extension posts a planStatus message with hasWork/blocking to gate.
  const html = renderConfigEditorHtml(baseVm(), 'n');
  assert.match(html, /id="run-sync"[^>]*class="btn btn-green"/);
  assert.match(html, /id="run-sync"[^>]*disabled/);
  assert.match(html, /id="run-sync-hint"/);
  // Orange "safe items only" button mirrors the admin editor — present
  // but hidden initially; setPlanReady reveals it when blocking>0 and
  // some safe-path items exist.
  assert.match(html, /id="run-sync-safe"[^>]*class="btn btn-orange"/);
  assert.match(html, /id="run-sync-safe"[^>]*hidden/);
});

test('relabelled action button references the workspace-wide plan, not "dry run"', () => {
  // M4.7 renamed "Open dry-run plan" → "Open workspace-wide plan" so the
  // scope distinction from the embedded plan card is explicit. Regression
  // guard against accidentally reverting the label.
  const html = renderConfigEditorHtml(baseVm(), 'n');
  assert.match(html, /Open workspace-wide plan/);
  assert.ok(!/>Open dry-run plan</.test(html), 'old "Open dry-run plan" label should not appear');
});

test('payload includes sourceFolderUri and claimedElsewhere', () => {
  // These two fields drive the dropdown filtering on the client. They must
  // round-trip through the init payload so the page renders correctly on
  // first paint (before the extension has a chance to post an update).
  const html = renderConfigEditorHtml(
    baseVm({
      sourceFolderUri: 'file:///handle/src',
      claimedElsewhere: ['file:///handle/dest-a', 'file:///handle/dest-b'],
    }),
    'n',
  );
  assert.match(html, /"sourceFolderUri":"file:\/\/\/handle\/src"/);
  assert.match(html, /"claimedElsewhere":\["file:\/\/\/handle\/dest-a","file:\/\/\/handle\/dest-b"\]/);
});

test('hint text explains the source + claimed-elsewhere filters', () => {
  // Regression guard against the older hint wording that just mentioned
  // matching a workspace folder name — the new copy needs to set the
  // expectation that the dropdown is filtered.
  const html = renderConfigEditorHtml(baseVm(), 'n');
  assert.match(html, /source folder.*filtered out automatically/);
});

test('default (folder-level) header banner is rendered when isWorkspaceRoot is false', () => {
  const html = renderConfigEditorHtml(baseVm(), 'n');
  assert.match(html, /<h1>Folder Sync configuration<\/h1>/);
  // Workspace-root copy must NOT appear in the folder-level case.
  assert.ok(!/Logical destination:/.test(html), 'workspace-root heading leaked into folder-level render');
  assert.ok(!/Path aliases are mandatory/.test(html), 'workspace-root mandatory-aliases copy leaked into folder-level render');
});

test('workspace-root header banner replaces the folder-level intro (M3)', () => {
  // M3 of room-sync-format-v1-plan.md: a workspace-root named `<dest>.roomSync`
  // surfaces a distinct intro banner — the prefix is shown as the logical
  // destination handle, and the mandatory-path-aliases requirement is called
  // out so the user knows why the aliases section can't be empty.
  const html = renderConfigEditorHtml(
    baseVm({ isWorkspaceRoot: true, workspaceRootHandle: 'Room 1' }),
    'n',
  );
  assert.match(html, /<h1>Logical destination: Room 1<\/h1>/);
  // The folder-level heading must NOT also appear — the banners are
  // alternatives, not appended together.
  assert.ok(!/<h1>Folder Sync configuration<\/h1>/.test(html), 'folder-level h1 leaked alongside the workspace-root h1');
  // Mandatory-aliases copy is the load-bearing piece of UX for the variant.
  assert.match(html, /Path aliases are mandatory at this location/);
});

test('workspace-root payload threads isWorkspaceRoot + handle into the data island', () => {
  const html = renderConfigEditorHtml(
    baseVm({ isWorkspaceRoot: true, workspaceRootHandle: 'Stage Left' }),
    'n',
  );
  assert.match(html, /"isWorkspaceRoot":true/);
  assert.match(html, /"workspaceRootHandle":"Stage Left"/);
});

test('workspace-root handle is HTML-escaped in the heading', () => {
  // Defensive — workspace folders / filenames are user-controlled inputs in
  // a sense (the user picks them). Make sure no breakout via the prefix.
  const html = renderConfigEditorHtml(
    baseVm({ isWorkspaceRoot: true, workspaceRootHandle: '<img src=x>' }),
    'n',
  );
  assert.ok(!html.includes('<h1>Logical destination: <img'), 'unescaped HTML leaked into the heading');
  assert.match(html, /<h1>Logical destination: &lt;img src=x&gt;<\/h1>/);
});

test('renders the Path aliases section + add button', () => {
  // M2 of room-sync-format-v1-plan.md: the editor surfaces a dedicated card
  // for the path-aliases field. Initially empty; the user adds rows via the
  // "+ Add path alias" button.
  const html = renderConfigEditorHtml(baseVm(), 'n');
  assert.match(html, /<h2>Path aliases<\/h2>/);
  assert.match(html, /id="alias-list"/);
  assert.match(html, /id="add-alias"/);
});

test('payload carries pathAliases verbatim from initial config', () => {
  const html = renderConfigEditorHtml(
    baseVm({
      initialConfig: {
        destinations: [{ uri: 'file:///handle/abc' }],
        include: [],
        exclude: [],
        pathAliases: { 'MON/room1': 'MON', 'TUE/room1': 'TUE' },
      },
    }),
    'n',
  );
  assert.match(html, /"pathAliases":\{"MON\/room1":"MON","TUE\/room1":"TUE"\}/);
});

test('Path aliases section omits the ${roomSync} helper line when no handle resolved', () => {
  // Defensive: when roomSyncHandle is empty (no meaningful identifier),
  // the helper line should NOT appear at all — surfacing an empty value
  // would be misleading.
  const html = renderConfigEditorHtml(baseVm(), 'n');
  assert.ok(!/Template variable:/.test(html), 'helper line leaked into render with empty handle');
});

test('Path aliases section shows the ${roomSync} helper line when a handle is resolved', () => {
  // v1 follow-up: the editor reads the document text literally (no
  // substitution) so the form preserves the template, and the resolved
  // value appears alongside as helper text so the user sees the runtime
  // value in context.
  const html = renderConfigEditorHtml(
    baseVm({ roomSyncHandle: 'breakout-1' }),
    'n',
  );
  assert.match(html, /Template variable: <code>\$\{roomSync\}<\/code> resolves to <code>breakout-1<\/code>/);
});

test('${roomSync} helper line escapes a user-controlled handle', () => {
  // The handle is derived from a filename or folder name — both
  // user-controlled. Defensive HTML escaping prevents tag breakout.
  const html = renderConfigEditorHtml(
    baseVm({ roomSyncHandle: '<img src=x>' }),
    'n',
  );
  assert.ok(!html.includes('resolves to <code><img'), 'unescaped handle leaked into helper line');
  assert.match(html, /resolves to <code>&lt;img src=x&gt;<\/code>/);
});

test('payload escapes </ to prevent script-tag breakout', () => {
  // A workspace folder name with "</script>" would, if naively interpolated,
  // close the surrounding <script type="application/json"> tag. The renderer
  // escapes "<" as "\u003c" inside the payload.
  const html = renderConfigEditorHtml(
    baseVm({
      workspaceFolders: [
        { uri: 'file:///handle/abc', name: '</script><script>alert(1)</script>' },
      ],
    }),
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
