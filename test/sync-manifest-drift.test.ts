// Tests for the manifest drift classifier + renderer drift-column markup (M4).
//
// The wired half (`manifestDriftWired.ts`) touches vscode.workspace.fs and
// is not covered here. The pure classifier + the renderer's per-status
// markup are both tsx-testable under plain Node.
//
// Run with: npm run test:sync-manifest-drift

import { strict as assert } from 'node:assert';
import {
  computeDriftRow,
  type DriftRecord,
  type ManifestDriftMap,
} from '../src/sync/manifestDrift';
import {
  renderManifestEditorHtml,
  toManifestViewModel,
} from '../src/sync/manifestEditorHtml';
import type { Manifest, ManifestReadResult } from '../src/sync/manifest-types';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

const NOW = new Date('2026-05-26T12:00:00.000Z');
const EXPECTED_SHA = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const ACTUAL_DIFFERENT = '999fed0123456789999fed0123456789999fed0123456789999fed0123456789';

function okRead(manifest: Manifest): ManifestReadResult {
  return { kind: 'ok', manifest };
}

function manifestWithEntry(key: string, sha: string): Manifest {
  return {
    version: 1,
    lastSync: '2026-05-26T11:00:00.000Z',
    entries: {
      [key]: {
        destPath: key.split(':')[1] ?? key,
        size: 100,
        sha256: sha,
        syncedAt: '2026-05-26T11:00:00.000Z',
      },
    },
    decisions: {},
  };
}

function driftMap(entries: Array<[string, DriftRecord]>): ManifestDriftMap {
  return new Map(entries);
}

// ───── pure classifier ──────────────────────────────────────────────────

test('computeDriftRow: fileExists=false → missing (regardless of hash args)', () => {
  const rec = computeDriftRow('src:a.txt', EXPECTED_SHA, undefined, false);
  assert.equal(rec.status, 'missing');
  assert.equal(rec.actualSha256, undefined);
});

test('computeDriftRow: fileExists=false ignores even a passed actualSha', () => {
  // Defensive: a caller that managed to hash a "missing" file shouldn't
  // produce a matches/drifted record. fileExists wins.
  const rec = computeDriftRow('src:a.txt', EXPECTED_SHA, EXPECTED_SHA, false);
  assert.equal(rec.status, 'missing');
});

test('computeDriftRow: fileExists=true + matching hash → matches', () => {
  const rec = computeDriftRow('src:a.txt', EXPECTED_SHA, EXPECTED_SHA, true);
  assert.equal(rec.status, 'matches');
  assert.equal(rec.actualSha256, EXPECTED_SHA);
});

test('computeDriftRow: fileExists=true + different hash → drifted', () => {
  const rec = computeDriftRow('src:a.txt', EXPECTED_SHA, ACTUAL_DIFFERENT, true);
  assert.equal(rec.status, 'drifted');
  assert.equal(rec.actualSha256, ACTUAL_DIFFERENT);
});

test('computeDriftRow: fileExists=true + actualSha undefined → computing', () => {
  // Defensive shape for "we know the file is there but we haven't hashed
  // it yet". Wired layer shouldn't actually produce this output, but the
  // type allows it.
  const rec = computeDriftRow('src:a.txt', EXPECTED_SHA, undefined, true);
  assert.equal(rec.status, 'computing');
  assert.equal(rec.actualSha256, undefined);
});

// ───── renderer drift-column markup ─────────────────────────────────────

test('entries table: Key column is dropped from both modes', () => {
  // The manifest key is `<source>:<relPath>` — redundant with the
  // dest-path column for the single-source-per-destination case (which
  // is everything in v1). Dropped to keep the table compact.
  const m = manifestWithEntry('src:a.txt', EXPECTED_SHA);
  for (const mode of ['mainUser', 'operator'] as const) {
    const vm = toManifestViewModel(okRead(m), '/dest', NOW, mode);
    const html = renderManifestEditorHtml(vm, 'n');
    assert.doesNotMatch(html, /<th class="col-key"/, `Key col header should be absent (mode=${mode})`);
    assert.doesNotMatch(html, />Key</, `Key text should not appear as a column header (mode=${mode})`);
    // The "src:" prefix string shouldn't bleed into the table at all.
    assert.doesNotMatch(html, /<td[^>]*>src:a\.txt<\/td>/, `key cell content should be absent (mode=${mode})`);
  }
});

test('entries table: File column header replaces the old Key/Dest path pair', () => {
  const m = manifestWithEntry('src:a.txt', EXPECTED_SHA);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'operator');
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /<th class="col-dest">File<\/th>/);
});

test('operator mode: drift badge has no column header (badge tells the story)', () => {
  // The badge inlines as a prefix to the file path; no separate Drift
  // column. Per design: "less is more — the badge's tooltip explains
  // the meaning".
  const m = manifestWithEntry('src:a.txt', EXPECTED_SHA);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'operator');
  const html = renderManifestEditorHtml(vm, 'n');
  assert.doesNotMatch(html, /<th class="col-drift"/);
  assert.doesNotMatch(html, />Drift</);
});

test('main-user mode: no drift badge rendered', () => {
  const m = manifestWithEntry('src:a.txt', EXPECTED_SHA);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'mainUser');
  const html = renderManifestEditorHtml(vm, 'n');
  assert.doesNotMatch(html, /class="drift-badge/);
});

test('operator mode without drift map: badge renders the computing placeholder', () => {
  const m = manifestWithEntry('src:a.txt', EXPECTED_SHA);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'operator', undefined);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /class="drift-badge drift-computing"/);
  assert.match(html, /…<\/span>a\.txt/);
});

test('operator mode: matches badge renders ✓ inline before the path', () => {
  const m = manifestWithEntry('src:a.txt', EXPECTED_SHA);
  const drift = driftMap([['src:a.txt', { status: 'matches', actualSha256: EXPECTED_SHA }]]);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'operator', drift);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /class="drift-badge drift-match"[^>]*title="On disk matches manifest sha[^"]*"/);
  // Badge sits before the path in the same cell.
  assert.match(html, /✓<\/span>a\.txt/);
});

test('operator mode: drifted badge renders ⚠ with expected-vs-actual tooltip', () => {
  const m = manifestWithEntry('src:a.txt', EXPECTED_SHA);
  const drift = driftMap([['src:a.txt', { status: 'drifted', actualSha256: ACTUAL_DIFFERENT }]]);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'operator', drift);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /class="drift-badge drift-drifted"/);
  assert.match(html, /⚠<\/span>a\.txt/);
  assert.match(html, /Expected abcdef012345, on disk 999fed012345/);
});

test('operator mode: missing badge renders ✗ with destPath tooltip', () => {
  const m = manifestWithEntry('src:a.txt', EXPECTED_SHA);
  const drift = driftMap([['src:a.txt', { status: 'missing' }]]);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'operator', drift);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /class="drift-badge drift-missing"/);
  assert.match(html, /✗<\/span>a\.txt/);
  assert.match(html, /title="File not present at a\.txt"/);
});

test('operator mode: row missing from drift map falls back to computing badge', () => {
  // The wired layer may produce a partial map (e.g. one entry's hash
  // failed). Each remaining row must still get a badge so the column
  // alignment stays consistent.
  const m: Manifest = {
    version: 1,
    lastSync: null,
    entries: {
      'src:a.txt': {
        destPath: 'a.txt',
        size: 100,
        sha256: EXPECTED_SHA,
        syncedAt: '2026-05-26T11:00:00.000Z',
      },
      'src:b.txt': {
        destPath: 'b.txt',
        size: 100,
        sha256: EXPECTED_SHA,
        syncedAt: '2026-05-26T11:00:00.000Z',
      },
    },
    decisions: {},
  };
  const drift = driftMap([['src:a.txt', { status: 'matches', actualSha256: EXPECTED_SHA }]]);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'operator', drift);
  const html = renderManifestEditorHtml(vm, 'n');
  const matchCount = html.split('drift-badge drift-match').length - 1;
  const computingCount = html.split('drift-badge drift-computing').length - 1;
  assert.equal(matchCount, 1, 'expected one ✓ badge for src:a.txt');
  assert.equal(computingCount, 1, 'expected one … badge for src:b.txt');
});

test('operator mode: Refresh drift button is rendered in the actions section', () => {
  const vm = toManifestViewModel(
    okRead(manifestWithEntry('src:a.txt', EXPECTED_SHA)),
    '/dest',
    NOW,
    'operator',
  );
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /id="refresh-drift"/);
  // Reopen-as-text stays alongside.
  assert.match(html, /id="open-text"/);
});

test('main-user mode: Refresh drift button is NOT rendered', () => {
  const vm = toManifestViewModel(
    okRead(manifestWithEntry('src:a.txt', EXPECTED_SHA)),
    '/dest',
    NOW,
    'mainUser',
  );
  const html = renderManifestEditorHtml(vm, 'n');
  assert.doesNotMatch(html, /id="refresh-drift"/);
});

test('drift tooltips escape user-controlled strings', () => {
  // destPath could in theory contain HTML-significant characters; the
  // missing-status tooltip surfaces it directly.
  const m: Manifest = {
    version: 1,
    lastSync: null,
    entries: {
      'src:x': {
        destPath: '<bad>"path',
        size: 1,
        sha256: EXPECTED_SHA,
        syncedAt: '2026-05-26T11:00:00.000Z',
      },
    },
    decisions: {},
  };
  const drift = driftMap([['src:x', { status: 'missing' }]]);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'operator', drift);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.ok(!/<bad>"/.test(html), 'raw destPath leaked into tooltip');
  assert.match(html, /&lt;bad&gt;&quot;path/);
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
