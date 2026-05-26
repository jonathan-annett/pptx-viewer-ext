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
  // Title hierarchy: dest root is the h1, "Folder Sync Manifest" is the subtitle.
  assert.match(html, /<h1[^>]*>\/x<\/h1>/);
  assert.match(html, /<p class="subtitle">Folder Sync Manifest<\/p>/);
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
  // Key column was dropped; only destPath renders in the table.
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
      // Key is no longer rendered (Key column was dropped) so its bytes
      // don't reach the HTML in either form. destPath still does — it's
      // the rendered cell and the highest-risk surface.
      'src:a': {
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
  assert.ok(!html.includes('"><img onerror=alert(1)>'), 'img onerror leaked');
  assert.match(html, /&quot;&gt;&lt;img onerror=alert\(1\)&gt;/);
});

test('renderer surfaces the destRootLabel as the page title', () => {
  const vm = toManifestViewModel(okRead(emptyManifest()), 'workspaceA/dest', NOW);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /<h1[^>]*>workspaceA\/dest<\/h1>/);
});

test('renderer html-escapes the destRootLabel in the h1', () => {
  const vm = toManifestViewModel(okRead(emptyManifest()), '<bad>&"', NOW);
  const html = renderManifestEditorHtml(vm, 'n');
  // Raw chars must not leak into the h1.
  assert.ok(!/\<h1[^>]*>[^<]*<bad>/.test(html), 'unescaped < leaked into h1');
  assert.match(html, /&lt;bad&gt;&amp;&quot;/);
});

test('renderer drops the duplicate Destination root row from the Header section', () => {
  // Previously the dest root was both the h2-section row and the section
  // header. Now the h1 carries it, so the dl row should be gone.
  const vm = toManifestViewModel(okRead(emptyManifest()), '/some/dest', NOW);
  const html = renderManifestEditorHtml(vm, 'n');
  assert.doesNotMatch(html, /<dt>Destination root<\/dt>/);
});

test('renderer moves the "managed automatically" disclaimer to the page footer', () => {
  const vm = toManifestViewModel(okRead(emptyManifest()), '/x', NOW);
  const html = renderManifestEditorHtml(vm, 'n');
  // Disclaimer should appear AFTER the entries section, inside a footer.
  assert.match(html, /<footer class="page-footer">[\s\S]*managed automatically by Folder Sync/);
  // And must NOT appear in the header anymore.
  const headerSlice = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.ok(!/managed automatically/.test(headerSlice), 'disclaimer should not be in header');
});

// ───── operator mode ────────────────────────────────────────────────────

test('operator mode: Decisions section is hidden', () => {
  const m: Manifest = {
    version: 1,
    lastSync: '2026-05-23T10:00:00.000Z',
    entries: {
      'src:a.txt': {
        destPath: 'a.txt',
        size: 100,
        sha256: 'aaaaaaaaaaaa',
        syncedAt: '2026-05-23T11:00:00.000Z',
      },
    },
    // A decision exists in the data — operator mode should still hide
    // the section so source-side state doesn't leak into the operator's
    // view.
    decisions: {
      'src:a.txt': {
        destOnlyDelete: false,
        collisionOverwrite: true,
        warningOverride: false,
        decidedAt: '2026-05-23T09:00:00.000Z',
      },
    },
  };
  const vm = toManifestViewModel(okRead(m), '/dest', NOW, 'operator');
  const html = renderManifestEditorHtml(vm, 'n');
  assert.doesNotMatch(html, /<h2>Decisions /);
  assert.doesNotMatch(html, /Overwrite collision/);
  // Entries still rendered. The destPath shows in the table cell;
  // the manifest key is no longer rendered (Key column was dropped).
  assert.match(html, /<h2>Entries /);
  assert.match(html, />a\.txt/);
});

test('operator mode: disclaimer copy is operator-appropriate', () => {
  const vm = toManifestViewModel(okRead(emptyManifest()), '/dest', NOW, 'operator');
  const html = renderManifestEditorHtml(vm, 'n');
  assert.match(html, /managed by Folder Sync from the source side/);
  // Main-user copy mentions "decisions you've toggled in the plan" —
  // operators have no plan, so that phrasing must be gone.
  assert.doesNotMatch(html, /decisions you[^<]*toggled/);
});

test('default mode is mainUser (back-compat for callers that omit it)', () => {
  const vm = toManifestViewModel(okRead(emptyManifest()), '/x', NOW);
  assert.equal(vm.kind, 'ok');
  if (vm.kind !== 'ok') return;
  assert.equal(vm.mode, 'mainUser');
  const html = renderManifestEditorHtml(vm, 'n');
  // Main-user rendering still shows the Decisions section.
  assert.match(html, /<h2>Decisions /);
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
