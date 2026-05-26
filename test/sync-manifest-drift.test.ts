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

test('operator mode: drift column header is present', () => {
  const m = manifestWithEntry('src:a.txt', EXPECTED_SHA);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'operator');
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /<th class="col-drift"/);
  assert.match(html, />Drift</);
});

test('main-user mode: drift column is NOT rendered', () => {
  // Drift is operator-mode-only per the M4 plan. Main-user mode keeps the
  // pre-drift entries table.
  const m = manifestWithEntry('src:a.txt', EXPECTED_SHA);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'mainUser');
  const html = renderManifestEditorHtml(vm, 'n');
  assert.doesNotMatch(html, /<th class="col-drift"/);
  assert.doesNotMatch(html, /class="drift-/);
});

test('operator mode without drift map: row renders the computing placeholder', () => {
  // Editor renders this on initial open, before the wired layer's pass lands.
  const m = manifestWithEntry('src:a.txt', EXPECTED_SHA);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'operator', undefined);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /class="drift-computing"/);
  assert.match(html, /…<\/span>/);
});

test('operator mode: matches status renders ✓ with full-sha tooltip', () => {
  const m = manifestWithEntry('src:a.txt', EXPECTED_SHA);
  const drift = driftMap([['src:a.txt', { status: 'matches', actualSha256: EXPECTED_SHA }]]);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'operator', drift);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /class="drift-match"[^>]*title="On disk matches manifest sha[^"]*"/);
  assert.match(html, /✓<\/span>/);
});

test('operator mode: drifted status renders ⚠ with expected-vs-actual tooltip', () => {
  const m = manifestWithEntry('src:a.txt', EXPECTED_SHA);
  const drift = driftMap([['src:a.txt', { status: 'drifted', actualSha256: ACTUAL_DIFFERENT }]]);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'operator', drift);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /class="drift-drifted"/);
  assert.match(html, /⚠<\/span>/);
  // Tooltip should mention both short hashes.
  assert.match(html, /Expected abcdef012345, on disk 999fed012345/);
});

test('operator mode: missing status renders ✗ with destPath tooltip', () => {
  const m = manifestWithEntry('src:a.txt', EXPECTED_SHA);
  const drift = driftMap([['src:a.txt', { status: 'missing' }]]);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'operator', drift);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /class="drift-missing"/);
  assert.match(html, /✗<\/span>/);
  assert.match(html, /title="File not present at a\.txt"/);
});

test('operator mode: row missing from drift map falls back to computing placeholder', () => {
  // The wired layer may produce a partial map (e.g. one entry's hash
  // failed). The renderer must still emit a cell for the missing key
  // rather than skipping the column for that row.
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
  // Only 'src:a.txt' has a drift record; 'src:b.txt' is absent from the map.
  const drift = driftMap([['src:a.txt', { status: 'matches', actualSha256: EXPECTED_SHA }]]);
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'operator', drift);
  const html = renderManifestEditorHtml(vm, 'n');
  // Both row glyphs should be present: one match (✓), one computing (…).
  const matchCount = html.split('class="drift-match"').length - 1;
  const computingCount = html.split('class="drift-computing"').length - 1;
  assert.equal(matchCount, 1, 'expected one ✓ for src:a.txt');
  assert.equal(computingCount, 1, 'expected one … for src:b.txt');
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
