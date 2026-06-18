// Tests for the scope helpers used by buildScopedDryRunPlan.
// Run with: npm run test:sync-scoped-plan
//
// The vscode-wired planner integration (walking, manifest reads) needs a
// vscode host — these tests cover the pure pieces: scope predicate, base/
// target relativisation, scope-from-relpath construction, and the
// FileInfo/manifest filters that feed into the classifier. The mixed-scope
// "filter then classify" integration check at the end mirrors the per-source
// flow without any vscode imports.

import { strict as assert } from 'node:assert';
import {
  type Scope,
  inScope,
  relPathFromBase,
  scopeFromRelPath,
  filterFilesToScope,
  filterManifestToScope,
} from '../src/sync/scopedPlan';
import { classifyFiles, summarisePlan, type FileInfo } from '../src/sync/plan';
import { emptyManifest, manifestKey, type Manifest, type ManifestEntry } from '../src/sync/manifest-types';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

const SOURCE = 'src-folder';

function file(relPath: string, sha256 = 'h-' + relPath, size = 100): FileInfo {
  return { relPath, sha256, size };
}

function entry(sha256: string, destPath: string): ManifestEntry {
  return { destPath, size: 100, sha256, syncedAt: '2026-05-19T00:00:00Z' };
}

function manifestOf(records: Array<{ source: string; relPath: string; entry: ManifestEntry }>): Manifest {
  const m = emptyManifest();
  for (const r of records) {
    m.entries[manifestKey(r.source, r.relPath)] = r.entry;
  }
  return m;
}

// ───── inScope ───────────────────────────────────────────────────────────

test('inScope: none accepts everything', () => {
  const s: Scope = { kind: 'none' };
  assert.equal(inScope('a.txt', s), true);
  assert.equal(inScope('src/utils/a.ts', s), true);
  assert.equal(inScope('', s), true);
});

test('inScope: directory matches at-or-below', () => {
  const s: Scope = { kind: 'directory', relPrefix: 'src/utils' };
  assert.equal(inScope('src/utils', s), true);
  assert.equal(inScope('src/utils/a.ts', s), true);
  assert.equal(inScope('src/utils/nested/b.ts', s), true);
  assert.equal(inScope('src/utils-other/a.ts', s), false, 'no prefix-only match');
  assert.equal(inScope('src/other/a.ts', s), false);
  assert.equal(inScope('a.ts', s), false);
});

test('inScope: file matches exact path only', () => {
  const s: Scope = { kind: 'file', relPath: 'src/utils/a.ts' };
  assert.equal(inScope('src/utils/a.ts', s), true);
  assert.equal(inScope('src/utils/a.ts.bak', s), false);
  assert.equal(inScope('src/utils', s), false);
  assert.equal(inScope('src/utils/b.ts', s), false);
});

// ───── relPathFromBase ───────────────────────────────────────────────────

test('relPathFromBase: target equals base → empty string', () => {
  assert.equal(relPathFromBase('/workspace/source', '/workspace/source'), '');
  assert.equal(relPathFromBase('/workspace/source/', '/workspace/source'), '');
  assert.equal(relPathFromBase('/workspace/source', '/workspace/source/'), '');
});

test('relPathFromBase: target below base → relative path', () => {
  assert.equal(relPathFromBase('/workspace/source', '/workspace/source/src/a.ts'), 'src/a.ts');
  assert.equal(relPathFromBase('/workspace/source/', '/workspace/source/a.ts'), 'a.ts');
});

test('relPathFromBase: target outside base → null', () => {
  assert.equal(relPathFromBase('/workspace/source', '/workspace/other/a.ts'), null);
  assert.equal(relPathFromBase('/workspace/source', '/workspace/sources/a.ts'), null);
  assert.equal(relPathFromBase('/workspace/source', '/elsewhere'), null);
});

// ───── scopeFromRelPath ──────────────────────────────────────────────────

test('scopeFromRelPath: empty path → none', () => {
  assert.deepEqual(scopeFromRelPath('', false), { kind: 'none' });
  assert.deepEqual(scopeFromRelPath('', true), { kind: 'none' });
});

test('scopeFromRelPath: directory when not a file', () => {
  assert.deepEqual(scopeFromRelPath('src/utils', false), { kind: 'directory', relPrefix: 'src/utils' });
});

test('scopeFromRelPath: file when is a file', () => {
  assert.deepEqual(scopeFromRelPath('src/utils/a.ts', true), { kind: 'file', relPath: 'src/utils/a.ts' });
});

// ───── filterFilesToScope ────────────────────────────────────────────────

test('filterFilesToScope: none preserves all', () => {
  const files = [file('a.txt'), file('src/b.ts')];
  const out = filterFilesToScope(files, { kind: 'none' });
  assert.equal(out.length, 2);
  // Returns a copy, not the original reference, so callers can mutate freely.
  assert.notEqual(out, files);
});

test('filterFilesToScope: directory prunes outside-scope files', () => {
  const files = [
    file('a.txt'),
    file('src/utils/a.ts'),
    file('src/utils/nested/b.ts'),
    file('src/other/c.ts'),
  ];
  const out = filterFilesToScope(files, { kind: 'directory', relPrefix: 'src/utils' });
  assert.deepEqual(
    out.map((f) => f.relPath).sort(),
    ['src/utils/a.ts', 'src/utils/nested/b.ts'],
  );
});

test('filterFilesToScope: file scope keeps only the exact path', () => {
  const files = [file('src/utils/a.ts'), file('src/utils/b.ts')];
  const out = filterFilesToScope(files, { kind: 'file', relPath: 'src/utils/a.ts' });
  assert.equal(out.length, 1);
  assert.equal(out[0].relPath, 'src/utils/a.ts');
});

// ───── filterManifestToScope ─────────────────────────────────────────────

test('filterManifestToScope: none returns the manifest verbatim', () => {
  const m = manifestOf([{ source: SOURCE, relPath: 'a.txt', entry: entry('h', 'a.txt') }]);
  const out = filterManifestToScope(m, SOURCE, { kind: 'none' });
  assert.equal(out, m, 'short-circuit returns the same reference');
});

test('filterManifestToScope: drops out-of-scope entries from the named source', () => {
  const m = manifestOf([
    { source: SOURCE, relPath: 'src/utils/a.ts', entry: entry('h1', 'src/utils/a.ts') },
    { source: SOURCE, relPath: 'src/other/b.ts', entry: entry('h2', 'src/other/b.ts') },
  ]);
  const out = filterManifestToScope(m, SOURCE, { kind: 'directory', relPrefix: 'src/utils' });
  assert.equal(Object.keys(out.entries).length, 1);
  assert.ok(out.entries[manifestKey(SOURCE, 'src/utils/a.ts')], 'in-scope entry retained');
  assert.equal(out.entries[manifestKey(SOURCE, 'src/other/b.ts')], undefined, 'out-of-scope dropped');
});

test('filterManifestToScope: preserves foreign-source entries verbatim', () => {
  // Foreign-source manifest entries are passed through so the classifier's
  // prefix-based "ignore other sources" logic still sees them.
  const m = manifestOf([
    { source: SOURCE, relPath: 'src/other/b.ts', entry: entry('h', 'src/other/b.ts') },
    { source: 'other-source', relPath: 'src/other/b.ts', entry: entry('h-foreign', 'src/other/b.ts') },
  ]);
  const out = filterManifestToScope(m, SOURCE, { kind: 'directory', relPrefix: 'src/utils' });
  assert.ok(out.entries[manifestKey('other-source', 'src/other/b.ts')]);
  assert.equal(out.entries[manifestKey(SOURCE, 'src/other/b.ts')], undefined);
});

// ───── integration: filter then classify ─────────────────────────────────

test('scoped classification: directory scope yields only in-scope operations', () => {
  // Workspace-wide we'd get four categories — after scoping to src/utils we
  // should see only the operations on files in that directory.
  const sourceFiles: FileInfo[] = [
    file('README.md', 'h-readme'),                  // outside scope
    file('src/utils/a.ts', 'h-utils-a-new'),        // in scope, change
    file('src/utils/b.ts', 'h-utils-b'),            // in scope, unchanged
    file('src/other/c.ts', 'h-other-c'),            // outside scope
  ];
  const destFiles: FileInfo[] = [
    file('README.md', 'h-readme-old'),
    file('src/utils/a.ts', 'h-utils-a-old'),
    file('src/utils/b.ts', 'h-utils-b'),
    file('src/utils/orphan.ts', 'h-orphan'),        // in scope, dest-only
    file('src/other/c.ts', 'h-other-c'),
  ];
  const manifest = manifestOf([
    { source: SOURCE, relPath: 'src/utils/a.ts', entry: entry('h-utils-a-old', 'src/utils/a.ts') },
    { source: SOURCE, relPath: 'src/utils/gone.ts', entry: entry('h-gone', 'src/utils/gone.ts') },
    { source: SOURCE, relPath: 'src/other/c.ts', entry: entry('h-other-c-old', 'src/other/c.ts') },
  ]);

  const scope: Scope = { kind: 'directory', relPrefix: 'src/utils' };
  const items = classifyFiles(
    SOURCE,
    filterFilesToScope(sourceFiles, scope),
    filterFilesToScope(destFiles, scope),
    filterManifestToScope(manifest, SOURCE, scope),
  );
  const summary = summarisePlan(items);

  assert.deepEqual(
    summary.updateTracked.map((i) => i.relPath),
    ['src/utils/a.ts'],
    'src/utils/a.ts is the only tracked update in scope',
  );
  assert.deepEqual(
    summary.skip.map((i) => i.relPath),
    ['src/utils/b.ts'],
  );
  assert.deepEqual(
    summary.destinationOnly.map((i) => i.relPath),
    ['src/utils/orphan.ts'],
    'orphan stays because it is in scope; README and src/other/c.ts are filtered out',
  );
  assert.deepEqual(
    summary.deleteTracked.map((i) => i.relPath),
    ['src/utils/gone.ts'],
    'in-scope manifest delete surfaces; src/other/c.ts manifest entry is dropped',
  );
  assert.equal(summary.create.length, 0);
  assert.equal(summary.updateCollision.length, 0);
});

test('scoped classification: single-file scope yields at most one operation', () => {
  const sourceFiles: FileInfo[] = [
    file('src/utils/a.ts', 'h-utils-a-new'),
    file('src/utils/b.ts', 'h-utils-b'),
  ];
  const destFiles: FileInfo[] = [
    file('src/utils/a.ts', 'h-utils-a-old'),
    file('src/utils/b.ts', 'h-utils-b'),
  ];
  const manifest = manifestOf([
    { source: SOURCE, relPath: 'src/utils/a.ts', entry: entry('h-utils-a-old', 'src/utils/a.ts') },
  ]);
  const scope: Scope = { kind: 'file', relPath: 'src/utils/a.ts' };
  const items = classifyFiles(
    SOURCE,
    filterFilesToScope(sourceFiles, scope),
    filterFilesToScope(destFiles, scope),
    filterManifestToScope(manifest, SOURCE, scope),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'update-tracked');
  assert.equal(items[0].relPath, 'src/utils/a.ts');
});

test('scoped classification: file scope on a missing dest yields a single create', () => {
  const items = classifyFiles(
    SOURCE,
    filterFilesToScope([file('src/utils/a.ts', 'h-new')], { kind: 'file', relPath: 'src/utils/a.ts' }),
    filterFilesToScope([], { kind: 'file', relPath: 'src/utils/a.ts' }),
    filterManifestToScope(emptyManifest(), SOURCE, { kind: 'file', relPath: 'src/utils/a.ts' }),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'create');
});

test('scope filtering preserves the placeholder flag', () => {
  // Placeholders are workspace-level — scoping in or out of a directory must
  // not change which files inside scope get flagged.
  const sourceFiles: FileInfo[] = [
    file('src/utils/stub.pptx', 'sha-zero'),
    file('src/utils/real.pptx', 'h-real'),
    file('src/other/c.ts', 'h-other-c'),
  ];
  const scope: Scope = { kind: 'directory', relPrefix: 'src/utils' };
  const items = classifyFiles(
    SOURCE,
    filterFilesToScope(sourceFiles, scope),
    [],
    emptyManifest(),
    new Set<string>(['sha-zero']),
  );
  const stub = items.find((i) => i.relPath === 'src/utils/stub.pptx');
  const real = items.find((i) => i.relPath === 'src/utils/real.pptx');
  assert.equal(stub?.isPlaceholder, true, 'stub flagged inside scope');
  assert.equal(real?.isPlaceholder, undefined, 'real not flagged');
  assert.equal(
    items.find((i) => i.relPath === 'src/other/c.ts'),
    undefined,
    'out-of-scope file dropped by filterFilesToScope',
  );
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
