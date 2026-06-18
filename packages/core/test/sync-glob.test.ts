// Tests for the glob matcher used by folder sync.
// Run with: npm run test:sync-glob

import { strict as assert } from 'node:assert';
import { compileGlob, GlobSet, BUILT_IN_IGNORES } from '../src/sync/glob';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

function expectMatch(glob: string, path: string): void {
  if (!compileGlob(glob).test(path)) {
    throw new Error(`expected glob "${glob}" to MATCH "${path}"`);
  }
}
function expectNoMatch(glob: string, path: string): void {
  if (compileGlob(glob).test(path)) {
    throw new Error(`expected glob "${glob}" to NOT match "${path}"`);
  }
}

// ───── individual glob shapes ─────────────────────────────────────────────

test('* matches a non-slash sequence', () => {
  expectMatch('*.tmp', 'foo.tmp');
  expectMatch('*.tmp', '.tmp'); // bare extension
  expectNoMatch('*.tmp', 'foo/bar.tmp');
  expectNoMatch('*.tmp', 'foo.tmp.bak');
});

test('? matches exactly one non-slash char', () => {
  expectMatch('file?.txt', 'file1.txt');
  expectNoMatch('file?.txt', 'file12.txt');
  expectNoMatch('file?.txt', 'file/.txt');
});

test('** crosses slash boundaries', () => {
  expectMatch('**/*.log', 'foo.log');
  expectMatch('**/*.log', 'a/b/c.log');
  expectMatch('**/*.log', 'a/b/c/d.log');
  expectNoMatch('**/*.log', 'a/b.txt');
});

test('trailing /** matches the directory and its contents', () => {
  expectMatch('node_modules/**', 'node_modules');
  expectMatch('node_modules/**', 'node_modules/foo');
  expectMatch('node_modules/**', 'node_modules/foo/bar.js');
  expectNoMatch('node_modules/**', 'src/node_modules');
});

test('bare ** matches anything including paths', () => {
  expectMatch('**', 'a');
  expectMatch('**', 'a/b/c');
  expectMatch('**', '');
});

test('literal characters with regex meaning are escaped', () => {
  // ~$ would otherwise be a regex anchor (~ is literal, $ is end-of-string).
  expectMatch('~$*', '~$foo');
  expectNoMatch('~$*', 'foo~$bar');
  expectMatch('.vscode/**', '.vscode');
  expectMatch('.vscode/**', '.vscode/settings.json');
});

// ───── built-in ignores ──────────────────────────────────────────────────

test('built-in ignores catch .git anywhere', () => {
  const set = new GlobSet(BUILT_IN_IGNORES);
  assert.equal(set.matches('.git'), true);
  assert.equal(set.matches('.git/HEAD'), true);
  assert.equal(set.matches('sub/.git/HEAD'), true);
  assert.equal(set.matches('foo/.gitignore'), false);
});

test('built-in ignores catch OS metadata files', () => {
  const set = new GlobSet(BUILT_IN_IGNORES);
  assert.equal(set.matches('.DS_Store'), true);
  assert.equal(set.matches('sub/.DS_Store'), true);
  assert.equal(set.matches('Thumbs.db'), true);
  assert.equal(set.matches('docs/Thumbs.db'), true);
});

test('built-in ignores catch Office lock files anywhere', () => {
  const set = new GlobSet(BUILT_IN_IGNORES);
  assert.equal(set.matches('~$report.docx'), true);
  assert.equal(set.matches('sub/~$report.docx'), true);
  assert.equal(set.matches('not~$.txt'), false); // ~$ not at start
});

test('built-in ignores catch the sync config and manifest', () => {
  // Every honoured source-config filename shape must be ignored anywhere
  // in the tree — otherwise a config file in a source folder would be
  // copied to every destination as if it were content. See
  // SYNC_CONFIG_FILENAMES + isNamedRoomSyncFilename in configFilenames.ts.
  const set = new GlobSet(BUILT_IN_IGNORES);
  assert.equal(set.matches('.sync.jsonc'), true);
  assert.equal(set.matches('sub/.sync.jsonc'), true);
  assert.equal(set.matches('.roomSync'), true);
  assert.equal(set.matches('sub/.roomSync'), true);
  // Named workspace-root variants (M3 + generator workflow) — these are
  // the most likely to slip through as "content" since their filenames
  // look ordinary.
  assert.equal(set.matches('breakout-1.roomSync'), true);
  assert.equal(set.matches('Room 1.roomSync'), true);
  assert.equal(set.matches('sub/plenary.roomSync'), true);
  assert.equal(set.matches('.foldersync-manifest.json'), true);
});

test('built-in ignores catch orphan .tmp files anywhere', () => {
  // Interrupted executor.ts atomic writes leave <file>.tmp behind; the
  // planner must not surface these as destination-only entries.
  const set = new GlobSet(BUILT_IN_IGNORES);
  assert.equal(set.matches('foo.tmp'), true);
  assert.equal(set.matches('sub/foo.pptx.tmp'), true);
  assert.equal(set.matches('a/b/c/deep.tmp'), true);
  assert.equal(set.matches('foo.tmp.bak'), false); // only the .tmp suffix
});

// ───── GlobSet behaviour ─────────────────────────────────────────────────

test('GlobSet matches any pattern', () => {
  const set = new GlobSet(['*.tmp', 'node_modules/**']);
  assert.equal(set.matches('foo.tmp'), true);
  assert.equal(set.matches('node_modules/foo'), true);
  assert.equal(set.matches('src/main.ts'), false);
});

test('empty GlobSet matches nothing and reports isEmpty', () => {
  const set = new GlobSet([]);
  assert.equal(set.isEmpty(), true);
  assert.equal(set.matches('anything'), false);
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
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('all tests passed');
