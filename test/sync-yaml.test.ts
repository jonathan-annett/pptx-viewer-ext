// Tests for the mini YAML parser used by the folder-sync feature.
// Runs under plain Node via tsx — no VS Code needed.
//
// Run with: npm run test:sync-yaml

import { strict as assert } from 'node:assert';
import { parseYamlMini, type YamlValue } from '../src/sync/yaml-mini';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

// ───── happy path: the canonical .sync.yaml shape ─────────────────────────

test('full .sync.yaml shape parses to expected JS object', () => {
  const src = `
destinations:
  - name: backup-drive
    path: projects/alpha
  - name: archive-server
    path: snapshots/alpha

exclude:
  - "~$*"
  - "*.tmp"
  - "node_modules/**"

include:
  - "**/*"
`;
  const got = parseYamlMini(src);
  assert.deepEqual(got, {
    destinations: [
      { name: 'backup-drive', path: 'projects/alpha' },
      { name: 'archive-server', path: 'snapshots/alpha' },
    ],
    exclude: ['~$*', '*.tmp', 'node_modules/**'],
    include: ['**/*'],
  });
});

test('destinations with only required field', () => {
  const got = parseYamlMini(`destinations:\n  - name: only\n`);
  assert.deepEqual(got, { destinations: [{ name: 'only' }] });
});

// ───── scalars and quoting ────────────────────────────────────────────────

test('double-quoted strings: escapes', () => {
  const got = parseYamlMini(`destinations:\n  - name: "with \\"quotes\\" and \\n newline"\n`) as {
    destinations: Array<{ name: string }>;
  };
  assert.equal(got.destinations[0].name, 'with "quotes" and \n newline');
});

test('single-quoted strings: doubled apostrophe', () => {
  const got = parseYamlMini(`destinations:\n  - name: 'isn''t'\n`) as {
    destinations: Array<{ name: string }>;
  };
  assert.equal(got.destinations[0].name, "isn't");
});

test('unquoted scalars trim trailing whitespace', () => {
  const got = parseYamlMini('destinations:\n  - name: trimmed   \n') as {
    destinations: Array<{ name: string }>;
  };
  assert.equal(got.destinations[0].name, 'trimmed');
});

test('strings containing colons can be quoted', () => {
  const got = parseYamlMini(`exclude:\n  - "a:b"\n`) as { exclude: string[] };
  assert.deepEqual(got.exclude, ['a:b']);
});

// ───── comments ───────────────────────────────────────────────────────────

test('# starts a comment after whitespace', () => {
  const got = parseYamlMini(`
# top comment
destinations:    # inline comment
  - name: foo    # trailing comment on item line
include:
  - "**/*"
`);
  assert.deepEqual(got, {
    destinations: [{ name: 'foo' }],
    include: ['**/*'],
  });
});

test('# inside quoted string is NOT a comment', () => {
  const got = parseYamlMini(`exclude:\n  - "node_modules/#stuff"\n`) as { exclude: string[] };
  assert.deepEqual(got.exclude, ['node_modules/#stuff']);
});

test('# embedded without preceding whitespace is NOT a comment', () => {
  // `~$*foo#bar` should stay intact when unquoted (no whitespace before #).
  const got = parseYamlMini(`exclude:\n  - value#nope\n`) as { exclude: string[] };
  assert.deepEqual(got.exclude, ['value#nope']);
});

// ───── document edge cases ────────────────────────────────────────────────

test('empty document returns null', () => {
  assert.equal(parseYamlMini(''), null);
  assert.equal(parseYamlMini('\n\n   \n'), null);
  assert.equal(parseYamlMini('# only a comment\n'), null);
});

test('CRLF line endings are handled', () => {
  const got = parseYamlMini('destinations:\r\n  - name: foo\r\n');
  assert.deepEqual(got, { destinations: [{ name: 'foo' }] });
});

// ───── sequence shapes ────────────────────────────────────────────────────

test('sequence of plain strings (no mapping fields)', () => {
  const got = parseYamlMini(`include:\n  - a\n  - b\n  - c\n`) as { include: string[] };
  assert.deepEqual(got.include, ['a', 'b', 'c']);
});

test('multi-key list items', () => {
  const got = parseYamlMini(
    `destinations:\n  - name: foo\n    path: x/y\n  - name: bar\n    path: z\n`,
  );
  assert.deepEqual((got as { destinations: YamlValue[] }).destinations, [
    { name: 'foo', path: 'x/y' },
    { name: 'bar', path: 'z' },
  ]);
});

// ───── error cases ────────────────────────────────────────────────────────

test('tabs in indentation are rejected', () => {
  assert.throws(
    () => parseYamlMini('destinations:\n\t- name: foo\n'),
    /tabs are not supported/,
  );
});

test('top-level content not at column 0 is rejected', () => {
  assert.throws(() => parseYamlMini('   destinations:\n'), /must start at column 0/);
});

test('trailing backslash in double-quoted string is rejected', () => {
  // The escape sequence "\\" represents a single backslash inside the source
  // string literal. The yaml input is therefore: name: "abc\
  assert.throws(
    () => parseYamlMini('destinations:\n  - name: "abc\\"\n'),
    /trailing backslash|unexpected/,
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
