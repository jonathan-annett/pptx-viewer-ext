// Tests for the operator-mode status bar pure helpers (M2).
//
// `formatOperatorText`, `pickOperatorClickTarget`, and `formatRelativeTime`
// have no vscode runtime dependency — type imports only — so they run
// directly under tsx with synthetic Uri objects.
//
// Run with: npm run test:sync-status-bar-operator

import { strict as assert } from 'node:assert';
import type { Uri } from 'vscode';
import {
  formatOperatorText,
  formatRelativeTime,
  pickOperatorClickTarget,
  type ManifestSummary,
} from '../src/sync/statusBarOperator';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

// Synthetic Uri — only methods we actually call on it in these helpers are
// referenced via the Command.arguments array (which the helpers don't read).
function fakeUri(str: string): Uri {
  return { toString: () => str } as unknown as Uri;
}

function summary(lastSync: string | null): ManifestSummary {
  return {
    manifestUri: fakeUri('vscode-vfs://github/u/repo/.foldersync-manifest.json'),
    folderUri: fakeUri('vscode-vfs://github/u/repo'),
    lastSync,
  };
}

// Reference "now" pinned so relative-time outputs are deterministic.
const NOW = new Date('2026-05-26T12:00:00.000Z');

// ───── formatRelativeTime ────────────────────────────────────────────────

test('formatRelativeTime: < 60s → "just now"', () => {
  assert.equal(formatRelativeTime('2026-05-26T11:59:30.000Z', NOW), 'just now');
});

test('formatRelativeTime: exactly 60s → "1 minute ago"', () => {
  assert.equal(formatRelativeTime('2026-05-26T11:59:00.000Z', NOW), '1 minute ago');
});

test('formatRelativeTime: 5 minutes ago (plural)', () => {
  assert.equal(formatRelativeTime('2026-05-26T11:55:00.000Z', NOW), '5 minutes ago');
});

test('formatRelativeTime: 1 hour boundary (singular)', () => {
  assert.equal(formatRelativeTime('2026-05-26T11:00:00.000Z', NOW), '1 hour ago');
});

test('formatRelativeTime: 12 hours ago', () => {
  assert.equal(formatRelativeTime('2026-05-26T00:00:00.000Z', NOW), '12 hours ago');
});

test('formatRelativeTime: 1 day ago (singular)', () => {
  assert.equal(formatRelativeTime('2026-05-25T12:00:00.000Z', NOW), '1 day ago');
});

test('formatRelativeTime: 7 days ago (plural)', () => {
  assert.equal(formatRelativeTime('2026-05-19T12:00:00.000Z', NOW), '7 days ago');
});

test('formatRelativeTime: older than 30 days → ISO date slice', () => {
  // ~60 days back → date slice instead of "60 days ago" (less scannable).
  assert.equal(formatRelativeTime('2026-03-20T12:00:00.000Z', NOW), '2026-03-20');
});

test('formatRelativeTime: future timestamp (clock skew) → "just now"', () => {
  assert.equal(formatRelativeTime('2026-05-26T13:00:00.000Z', NOW), 'just now');
});

test('formatRelativeTime: invalid timestamp → "unknown"', () => {
  assert.equal(formatRelativeTime('not-a-date', NOW), 'unknown');
});

// ───── formatOperatorText ────────────────────────────────────────────────

test('formatOperatorText: no canonical manifest → "no manifest yet"', () => {
  const { text, tooltip } = formatOperatorText(undefined, NOW);
  assert.ok(text.includes('Destination — no manifest yet'), `text was: ${text}`);
  assert.ok(text.includes('$(eye)'), 'text should carry the codicon');
  assert.ok(tooltip.length > 0, 'tooltip should explain the state');
});

test('formatOperatorText: manifest with timestamp → relative time', () => {
  const { text } = formatOperatorText(summary('2026-05-26T11:55:00.000Z'), NOW);
  assert.equal(text, '$(eye) Destination only — last sync 5 minutes ago');
});

test('formatOperatorText: manifest with null lastSync → "never"', () => {
  // A manifest file may exist with lastSync=null when it was created but no
  // sync has stamped a timestamp yet (e.g. failed mid-run).
  const { text, tooltip } = formatOperatorText(summary(null), NOW);
  assert.equal(text, '$(eye) Destination only — last sync never');
  assert.ok(tooltip.includes('never'), 'tooltip should also surface "never"');
});

test('formatOperatorText: tooltip includes exact timestamp for hover-level detail', () => {
  const iso = '2026-05-26T11:55:00.000Z';
  const { tooltip } = formatOperatorText(summary(iso), NOW);
  assert.ok(tooltip.includes(iso), `tooltip should include exact timestamp: ${tooltip}`);
});

// ───── pickOperatorClickTarget ───────────────────────────────────────────

test('pickOperatorClickTarget: no manifest → undefined', () => {
  assert.equal(pickOperatorClickTarget(undefined), undefined);
});

test('pickOperatorClickTarget: with manifest → vscode.openWith Command', () => {
  const s = summary('2026-05-26T11:55:00.000Z');
  const cmd = pickOperatorClickTarget(s);
  assert.ok(cmd, 'expected a Command object');
  assert.equal(cmd!.command, 'vscode.openWith');
  // arguments[0] is the manifest URI; arguments[1] is the M6.E view type.
  assert.deepEqual(cmd!.arguments?.[0], s.manifestUri);
  assert.equal(cmd!.arguments?.[1], 'folderSync.manifestEditor');
});

test('pickOperatorClickTarget: title field set for keybinding/menu display', () => {
  const cmd = pickOperatorClickTarget(summary(null));
  assert.ok(cmd?.title, 'Command.title should be set');
});

// ───── runner ────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err);
  }
}
if (failed > 0) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log(`all ${tests.length} tests passed`);
