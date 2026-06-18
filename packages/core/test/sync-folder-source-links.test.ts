// Smoke tests for the pure folder-source-links helper. Verifies the topology
// → folder-URI lookup that the admin editor uses to decide which folder rows
// should display source hyperlinks.
//
// Run with: npm run test:sync-folder-source-links

import { strict as assert } from 'node:assert';
import {
  findSourceLinksForFolder,
  type FolderSourceLinkInputSource,
} from '../src/sync/folderSourceLinks';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

/** Build a minimal source-shaped record using strings for URIs. */
function src(
  configUri: string,
  sourceFolderUri: string,
  destinations: Array<{ uri: string; subpath?: string }>,
): FolderSourceLinkInputSource {
  return {
    configUri: { toString: () => configUri },
    sourceFolderUri: { toString: () => sourceFolderUri },
    destinations: destinations.map((d) => ({ uri: d.uri, subpath: d.subpath ?? '' })),
  };
}

test('returns empty when no sources match', () => {
  const sources = [src('file:///src/.sync.jsonc', 'file:///src', [{ uri: 'file:///other' }])];
  const links = findSourceLinksForFolder(sources, 'file:///dest');
  assert.deepEqual(links, []);
});

test('returns one link when a single source targets the folder root', () => {
  const sources = [src('file:///src/.sync.jsonc', 'file:///src', [{ uri: 'file:///dest' }])];
  const links = findSourceLinksForFolder(sources, 'file:///dest');
  assert.equal(links.length, 1);
  assert.equal(links[0].sourceFolderUri, 'file:///src');
  assert.equal(links[0].configUri, 'file:///src/.sync.jsonc');
  assert.equal(links[0].subpath, '');
});

test('returns multiple links when several sources point at the same destination', () => {
  // Reflects the real "two sources writing into a shared destination via
  // different subpaths" topology — the user wants to see both bindings.
  const sources = [
    src('file:///a/.sync.jsonc', 'file:///a', [{ uri: 'file:///dest', subpath: 'a-stuff' }]),
    src('file:///b/.sync.jsonc', 'file:///b', [{ uri: 'file:///dest', subpath: 'b-stuff' }]),
  ];
  const links = findSourceLinksForFolder(sources, 'file:///dest');
  assert.equal(links.length, 2);
  assert.equal(links[0].sourceFolderUri, 'file:///a');
  assert.equal(links[0].subpath, 'a-stuff');
  assert.equal(links[1].sourceFolderUri, 'file:///b');
  assert.equal(links[1].subpath, 'b-stuff');
});

test('returns one link per subpath when a source targets the same dest twice', () => {
  // Two destinations on the same source with the same URI but different
  // subpaths — both are legitimate bindings (caught only when the subpath
  // also matches; topology.ts already rejects exact dupes).
  const sources = [
    src('file:///a/.sync.jsonc', 'file:///a', [
      { uri: 'file:///dest', subpath: 'one' },
      { uri: 'file:///dest', subpath: 'two' },
    ]),
  ];
  const links = findSourceLinksForFolder(sources, 'file:///dest');
  assert.equal(links.length, 2);
  assert.equal(links[0].subpath, 'one');
  assert.equal(links[1].subpath, 'two');
});

test('preserves source order from the input', () => {
  const sources = [
    src('file:///z/.sync.jsonc', 'file:///z', [{ uri: 'file:///dest' }]),
    src('file:///a/.sync.jsonc', 'file:///a', [{ uri: 'file:///dest' }]),
  ];
  const links = findSourceLinksForFolder(sources, 'file:///dest');
  assert.equal(links[0].sourceFolderUri, 'file:///z');
  assert.equal(links[1].sourceFolderUri, 'file:///a');
});

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
