// Smoke tests for the pure HTML renderer + view-model helpers used by the
// .foldersync-manifest.json custom editor. The vscode-wired half is in
// src/sync/manifestEditor.ts and is not covered here.
//
// Run with: npm run test:sync-manifest-editor-html

import { strict as assert } from 'node:assert';
import {
  humaniseSize,
  relativeTime,
  renderManifestEditorHtml,
  toManifestViewModel,
  type ManifestEditorViewModel,
} from '../src/sync/manifestEditorHtml';
import type { Manifest, ManifestReadResult } from '../src/sync/manifest-types';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

const NOW = new Date('2026-05-23T12:00:00.000Z');

function okRead(manifest: Manifest): ManifestReadResult {
  return { kind: 'ok', manifest };
}

function emptyManifest(): Manifest {
  return { version: 1, lastSync: null, entries: {}, decisions: {} };
}

// ───── view-model helpers ───────────────────────────────────────────────

test('humaniseSize formats bytes, KB, MB, GB', () => {
  assert.equal(humaniseSize(0), '0 B');
  assert.equal(humaniseSize(512), '512 B');
  assert.equal(humaniseSize(1024), '1.0 KB');
  assert.equal(humaniseSize(2048), '2.0 KB');
  assert.equal(humaniseSize(1024 * 1024), '1.0 MB');
  assert.equal(humaniseSize(15 * 1024 * 1024), '15 MB');
  assert.equal(humaniseSize(1024 * 1024 * 1024), '1.0 GB');
});

test('relativeTime returns "just now" inside the window', () => {
  assert.equal(relativeTime('2026-05-23T11:59:50.000Z', NOW), 'just now');
});

test('relativeTime formats minutes/hours/days', () => {
  assert.equal(relativeTime('2026-05-23T11:00:00.000Z', NOW), '1h ago');
  assert.equal(relativeTime('2026-05-22T12:00:00.000Z', NOW), '1d ago');
});

test('relativeTime returns empty string for unparseable input', () => {
  assert.equal(relativeTime('not-a-date', NOW), '');
});

test('toManifestViewModel: ok variant copies fields and sorts entries by key', () => {
  const m: Manifest = {
    version: 1,
    lastSync: '2026-05-23T10:00:00.000Z',
    entries: {
      'src:z.txt': {
        destPath: 'z.txt',
        size: 1024,
        sha256: 'zzzzzzzzzzzzzzzzzzzz',
        syncedAt: '2026-05-23T10:00:00.000Z',
      },
      'src:a.txt': {
        destPath: 'a.txt',
        size: 512,
        sha256: 'aaaaaaaaaaaaaaaaaaaa',
        syncedAt: '2026-05-23T11:00:00.000Z',
      },
    },
    decisions: {
      'src:b.txt': {
        destOnlyDelete: false,
        collisionOverwrite: true,
        warningOverride: false,
        decidedAt: '2026-05-23T09:00:00.000Z',
      },
    },
  };
  const vm = toManifestViewModel(okRead(m), '/workspace/dest', NOW);
  assert.equal(vm.kind, 'ok');
  if (vm.kind !== 'ok') return;
  assert.equal(vm.destRootLabel, '/workspace/dest');
  assert.equal(vm.version, 1);
  assert.equal(vm.entries.length, 2);
  // Sorted alphabetically by key.
  assert.equal(vm.entries[0].key, 'src:a.txt');
  assert.equal(vm.entries[1].key, 'src:z.txt');
  assert.equal(vm.entries[0].sha256Short, 'aaaaaaaaaaaa');
  assert.equal(vm.entries[0].sha256Full, 'aaaaaaaaaaaaaaaaaaaa');
  assert.equal(vm.entries[0].sizeHuman, '512 B');
  assert.equal(vm.entries[1].sizeHuman, '1.0 KB');
  assert.equal(vm.decisions.length, 1);
  assert.equal(vm.decisions[0].collisionOverwrite, true);
});

test('toManifestViewModel: version-mismatch variant carries actual label', () => {
  const vm = toManifestViewModel(
    { kind: 'version-mismatch', actual: 2 },
    '/workspace/dest',
    NOW,
  );
  assert.equal(vm.kind, 'version-mismatch');
  if (vm.kind !== 'version-mismatch') return;
  assert.equal(vm.actualLabel, '2');
});

test('toManifestViewModel: version-mismatch with missing version field is labelled', () => {
  const vm = toManifestViewModel(
    { kind: 'version-mismatch', actual: undefined },
    '/workspace/dest',
    NOW,
  );
  assert.equal(vm.kind, 'version-mismatch');
  if (vm.kind !== 'version-mismatch') return;
  assert.match(vm.actualLabel, /missing/i);
});

// ───── renderer ─────────────────────────────────────────────────────────

test('renderer emits a CSP meta tag with the supplied nonce', () => {
  const vm = toManifestViewModel(okRead(emptyManifest()), '/x', NOW);
  const html = renderManifestEditorHtml(vm, 'abc123');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'nonce-abc123'/);
  // One inline script (Reopen-as-text wiring).
  const occurrences = html.split('nonce="abc123"').length - 1;
  assert.equal(occurrences, 1, 'nonce should appear on the single <script> tag');
});

test('renderer shows the empty state when there are no entries or decisions', () => {
  const vm = toManifestViewModel(okRead(emptyManifest()), '/x', NOW);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /<h1>Folder Sync manifest<\/h1>/);
  assert.match(html, /<h2>Entries <span class="count">\(0\)<\/span><\/h2>/);
  assert.match(html, /<h2>Decisions <span class="count">\(0\)<\/span><\/h2>/);
  assert.match(html, /No tracked entries/);
  assert.match(html, /No remembered decisions/);
  assert.match(html, /id="open-text"/);
});

test('renderer prints the entries table with size + sha + tooltip', () => {
  const m: Manifest = {
    version: 1,
    lastSync: null,
    entries: {
      'src:foo/bar.txt': {
        destPath: 'foo/bar.txt',
        size: 2_500_000,
        sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        syncedAt: '2026-05-23T11:55:00.000Z',
      },
    },
    decisions: {},
  };
  const vm = toManifestViewModel(okRead(m), '/x', NOW);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /<table class="data">/);
  assert.match(html, /src:foo\/bar\.txt/);
  assert.match(html, /foo\/bar\.txt/);
  assert.match(html, /2\.4 MB/);
  // sha256 truncated to 12 chars in cell, full hash in tooltip.
  assert.match(html, /abcdef012345/);
  assert.match(
    html,
    /title="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"/,
  );
});

test('renderer prints decisions table with flag glyphs', () => {
  const m: Manifest = {
    version: 1,
    lastSync: null,
    entries: {},
    decisions: {
      'src:over.txt': {
        destOnlyDelete: false,
        collisionOverwrite: true,
        warningOverride: false,
        decidedAt: '2026-05-23T11:00:00.000Z',
      },
      'src:warn.txt': {
        destOnlyDelete: false,
        collisionOverwrite: false,
        warningOverride: true,
        decidedAt: '2026-05-23T10:00:00.000Z',
      },
    },
  };
  const vm = toManifestViewModel(okRead(m), '/x', NOW);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /Overwrite collision/);
  assert.match(html, /Sync anyway/i);
  // Two ✓ glyphs (one in each row's true column).
  const checkmarks = html.split('\u2713').length - 1;
  assert.equal(checkmarks, 2, 'expected two ✓ glyphs for the two true flags');
});

test('renderer shows the version-mismatch banner instead of tables', () => {
  const vm = toManifestViewModel(
    { kind: 'version-mismatch', actual: 99 },
    '/workspace/dest',
    NOW,
  );
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /This manifest was written by a newer version/);
  // No data tables rendered in the mismatch state.
  assert.doesNotMatch(html, /<table class="data">/);
  // Reopen-as-text button stays available so the user can inspect.
  assert.match(html, /id="open-text"/);
  // Header badge surfaces the actual value.
  assert.match(html, /unsupported: 99/);
});

test('renderer html-escapes user-controlled strings', () => {
  const m: Manifest = {
    version: 1,
    lastSync: null,
    entries: {
      '<script>alert(1)</script>': {
        destPath: '"><img onerror=alert(1)>',
        size: 1,
        sha256: 'aaaaaaaaaaaa',
        syncedAt: '2026-05-23T11:55:00.000Z',
      },
    },
    decisions: {},
  };
  const vm = toManifestViewModel(okRead(m), '/x', NOW);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.ok(!html.includes('<script>alert(1)'), 'script tag leaked into HTML');
  assert.ok(!html.includes('"><img onerror=alert(1)>'), 'img onerror leaked');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('renderer surfaces the destRootLabel in the header', () => {
  const vm = toManifestViewModel(okRead(emptyManifest()), 'workspaceA/dest', NOW);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /workspaceA\/dest/);
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

// Silence unused-import warning when ManifestEditorViewModel is only used
// inside the .kind === narrowing assertions above.
export type _ManifestEditorViewModel = ManifestEditorViewModel;
