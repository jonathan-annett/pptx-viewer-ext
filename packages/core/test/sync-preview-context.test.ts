// Tests for classifyPreviewContext — the pure classifier that the pptx
// viewer's "Sync target" section branches on.
// Run with: npm run test:sync-preview-context

import { strict as assert } from 'node:assert';
import {
  classifyPreviewContext,
  type PreviewInput,
  type PreviewSource,
  type PreviewWorkspaceFolder,
} from '../src/sync/previewContext';
import { emptyManifest, manifestKey, type Manifest, type ManifestEntry } from '../src/sync/manifest-types';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

function folder(name: string, path: string): PreviewWorkspaceFolder {
  return { uri: `file://${path}`, path, name };
}

function source(
  configUri: string,
  sourceFolderPath: string,
  workspaceFolderName: string,
  destinations: ReadonlyArray<{ uri: string; subpath: string }> = [],
): PreviewSource {
  return {
    configUri,
    sourceFolderPath,
    workspaceFolderName,
    destinations,
  };
}

function entry(destPath: string, sha256 = 'h'): ManifestEntry {
  return { destPath, size: 100, sha256, syncedAt: '2026-05-19T00:00:00Z' };
}

function manifestWith(records: Array<{ source: string; relPath: string; entry: ManifestEntry }>): Manifest {
  const m = emptyManifest();
  for (const r of records) {
    m.entries[manifestKey(r.source, r.relPath)] = r.entry;
  }
  return m;
}

// ───── outsideWorkspace ─────────────────────────────────────────────────

test('outsideWorkspace: no folder contains the document', () => {
  const input: PreviewInput = {
    documentUri: 'file:///elsewhere/x.pptx',
    documentPath: '/elsewhere/x.pptx',
    workspaceFolders: [folder('SourceRoom', '/rooms/source')],
    sources: [],
    manifest: null,
  };
  const ctx = classifyPreviewContext(input);
  assert.equal(ctx.kind, 'outsideWorkspace');
});

// ───── source ───────────────────────────────────────────────────────────

test('source: file under a source folder returns source-case with sourceConfigUri + relPath', () => {
  const wf = folder('SourceRoom', '/rooms/source');
  const src = source(
    'file:///rooms/source/.sync.jsonc',
    '/rooms/source',
    'SourceRoom',
    [{ uri: 'file:///rooms/dest', subpath: '' }],
  );
  const ctx = classifyPreviewContext({
    documentUri: 'file:///rooms/source/decks/intro.pptx',
    documentPath: '/rooms/source/decks/intro.pptx',
    workspaceFolders: [wf],
    sources: [src],
    manifest: null,
  });
  assert.equal(ctx.kind, 'source');
  if (ctx.kind !== 'source') return;
  assert.equal(ctx.sourceConfigUri, 'file:///rooms/source/.sync.jsonc');
  assert.equal(ctx.relPath, 'decks/intro.pptx');
  assert.equal(ctx.workspaceFolderName, 'SourceRoom');
});

test('source: nearest-config rule picks the deepest source', () => {
  const wf = folder('Projects', '/projects');
  const outer = source('file:///projects/.sync.jsonc', '/projects', 'Projects', []);
  const inner = source('file:///projects/alpha/.sync.jsonc', '/projects/alpha', 'Projects', []);
  const ctx = classifyPreviewContext({
    documentUri: 'file:///projects/alpha/src/main.pptx',
    documentPath: '/projects/alpha/src/main.pptx',
    workspaceFolders: [wf],
    sources: [outer, inner],
    manifest: null,
  });
  assert.equal(ctx.kind, 'source');
  if (ctx.kind !== 'source') return;
  assert.equal(ctx.sourceConfigUri, 'file:///projects/alpha/.sync.jsonc');
  assert.equal(ctx.relPath, 'src/main.pptx');
});

test('source: file equal to the source folder returns empty relPath', () => {
  const wf = folder('SourceRoom', '/rooms/source');
  // A degenerate case — the source folder itself can't be a .pptx, but the
  // classifier should still produce a meaningful structure rather than null.
  const src = source('file:///rooms/source/.sync.jsonc', '/rooms/source', 'SourceRoom', []);
  const ctx = classifyPreviewContext({
    documentUri: 'file:///rooms/source',
    documentPath: '/rooms/source',
    workspaceFolders: [wf],
    sources: [src],
    manifest: null,
  });
  assert.equal(ctx.kind, 'source');
  if (ctx.kind !== 'source') return;
  assert.equal(ctx.relPath, '');
});

// ───── uncovered ────────────────────────────────────────────────────────

test('uncovered: file in workspaceFolders[0] with no .sync.jsonc covering it', () => {
  const wf = folder('Projects', '/projects');
  const ctx = classifyPreviewContext({
    documentUri: 'file:///projects/decks/intro.pptx',
    documentPath: '/projects/decks/intro.pptx',
    workspaceFolders: [wf],
    sources: [], // no configs at all
    manifest: null,
  });
  assert.equal(ctx.kind, 'uncovered');
  if (ctx.kind !== 'uncovered') return;
  assert.equal(ctx.workspaceFolderName, 'Projects');
  assert.equal(ctx.relPath, 'decks/intro.pptx');
});

test('uncovered: source exists in a sibling folder but does not cover this file', () => {
  const wfA = folder('Projects', '/projects');
  const wfB = folder('Other', '/other');
  // Source is in /other, claims /projects only as a destination — not a source.
  const src = source('file:///other/.sync.jsonc', '/other', 'Other', [
    { uri: 'file:///projects', subpath: '' },
  ]);
  // But the manifest doesn't claim this particular file, so this is a
  // destinationOrphan rather than uncovered. Verify the distinction.
  const ctx = classifyPreviewContext({
    documentUri: 'file:///projects/decks/intro.pptx',
    documentPath: '/projects/decks/intro.pptx',
    workspaceFolders: [wfA, wfB],
    sources: [src],
    manifest: emptyManifest(),
  });
  assert.equal(ctx.kind, 'destinationOrphan', 'destination orphan should win over uncovered');
});

// ───── destinationMapped ────────────────────────────────────────────────

test('destinationMapped: manifest entry maps a destination file to its source', () => {
  const wfSrc = folder('SourceRoom', '/rooms/source');
  const wfDest = folder('DestRoom', '/rooms/dest');
  const src = source('file:///rooms/source/.sync.jsonc', '/rooms/source', 'SourceRoom', [
    { uri: 'file:///rooms/dest', subpath: '' },
  ]);
  const manifest = manifestWith([
    { source: 'SourceRoom', relPath: 'decks/intro.pptx', entry: entry('decks/intro.pptx') },
  ]);
  const ctx = classifyPreviewContext({
    documentUri: 'file:///rooms/dest/decks/intro.pptx',
    documentPath: '/rooms/dest/decks/intro.pptx',
    workspaceFolders: [wfSrc, wfDest],
    sources: [src],
    manifest,
  });
  assert.equal(ctx.kind, 'destinationMapped');
  if (ctx.kind !== 'destinationMapped') return;
  assert.equal(ctx.destinationWorkspaceFolderName, 'DestRoom');
  assert.equal(ctx.sourceConfigUri, 'file:///rooms/source/.sync.jsonc');
  assert.equal(ctx.sourceWorkspaceFolderName, 'SourceRoom');
  assert.equal(ctx.sourceRelPath, 'decks/intro.pptx');
});

test('destinationMapped: subpath is honoured (manifest destPath includes the subpath)', () => {
  const wfDest = folder('Archive', '/archive');
  const src = source('file:///rooms/source/.sync.jsonc', '/rooms/source', 'SourceRoom', [
    { uri: 'file:///archive', subpath: 'snapshots/alpha' },
  ]);
  const manifest = manifestWith([
    { source: 'SourceRoom', relPath: 'a.pptx', entry: entry('snapshots/alpha/a.pptx') },
  ]);
  const ctx = classifyPreviewContext({
    documentUri: 'file:///archive/snapshots/alpha/a.pptx',
    documentPath: '/archive/snapshots/alpha/a.pptx',
    workspaceFolders: [wfDest],
    sources: [src],
    manifest,
  });
  assert.equal(ctx.kind, 'destinationMapped');
  if (ctx.kind !== 'destinationMapped') return;
  assert.equal(ctx.sourceRelPath, 'a.pptx');
});

// ───── destinationOrphan ────────────────────────────────────────────────

test('destinationOrphan: file in a destination folder with no manifest entry', () => {
  const wfSrc = folder('SourceRoom', '/rooms/source');
  const wfDest = folder('DestRoom', '/rooms/dest');
  const src = source('file:///rooms/source/.sync.jsonc', '/rooms/source', 'SourceRoom', [
    { uri: 'file:///rooms/dest', subpath: '' },
  ]);
  const ctx = classifyPreviewContext({
    documentUri: 'file:///rooms/dest/leftover.pptx',
    documentPath: '/rooms/dest/leftover.pptx',
    workspaceFolders: [wfSrc, wfDest],
    sources: [src],
    manifest: emptyManifest(),
  });
  assert.equal(ctx.kind, 'destinationOrphan');
  if (ctx.kind !== 'destinationOrphan') return;
  assert.equal(ctx.destinationWorkspaceFolderName, 'DestRoom');
  assert.equal(ctx.relPath, 'leftover.pptx');
});

test('destinationOrphan: missing manifest still produces orphan (not destinationMapped)', () => {
  const wfDest = folder('DestRoom', '/rooms/dest');
  const src = source('file:///elsewhere/.sync.jsonc', '/elsewhere', 'Other', [
    { uri: 'file:///rooms/dest', subpath: '' },
  ]);
  const ctx = classifyPreviewContext({
    documentUri: 'file:///rooms/dest/x.pptx',
    documentPath: '/rooms/dest/x.pptx',
    workspaceFolders: [folder('Other', '/elsewhere'), wfDest],
    sources: [src],
    manifest: null,
  });
  assert.equal(ctx.kind, 'destinationOrphan');
});

// ───── precedence ───────────────────────────────────────────────────────

test('precedence: source case wins when a folder is both a source and a destination', () => {
  const wf = folder('Mixed', '/mixed');
  const ownSrc = source('file:///mixed/.sync.jsonc', '/mixed', 'Mixed', [
    { uri: 'file:///elsewhere', subpath: '' },
  ]);
  // Another source treats /mixed as a destination.
  const otherSrc = source('file:///elsewhere/.sync.jsonc', '/elsewhere', 'Other', [
    { uri: 'file:///mixed', subpath: '' },
  ]);
  const ctx = classifyPreviewContext({
    documentUri: 'file:///mixed/a.pptx',
    documentPath: '/mixed/a.pptx',
    workspaceFolders: [wf, folder('Other', '/elsewhere')],
    sources: [ownSrc, otherSrc],
    manifest: manifestWith([{ source: 'Other', relPath: 'a.pptx', entry: entry('a.pptx') }]),
  });
  // The source-case match wins — same file would be a destinationMapped if
  // ownSrc's coverage didn't exist.
  assert.equal(ctx.kind, 'source');
});

// ───── run ──────────────────────────────────────────────────────────────

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
