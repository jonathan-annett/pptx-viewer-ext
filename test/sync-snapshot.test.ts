// Tests for the pure snapshot module — marshal, parse, equality.
//
// Runs under plain Node via tsx — no VS Code needed.
//
// Run with: npm run test:sync-snapshot

import { strict as assert } from 'node:assert';
import {
  effectivePlaceholderSet,
  emptySnapshot,
  EMPTY_FILE_SHA256,
  marshalSnapshot,
  parseSnapshot,
  snapshotsEqual,
  type Snapshot,
} from '../src/sync/snapshot';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

// ───── marshal/parse round-trip ───────────────────────────────────────────

test('marshal then parse round-trips the canonical snapshot', () => {
  const snapshot: Snapshot = {
    folders: [
      { uri: 'file:///Speakers%20Prep', name: 'Speakers Prep' },
      { uri: 'file:///Plenary1', name: 'P1 PC1' },
    ],
    settings: {
      'files.readonlyInclude': { '**/*.pptx': true },
      'files.readonlyExclude': { '**/Plenary 1/**': true },
    },
    placeholders: ['abc123', 'def456'],
    capturedAt: '2026-05-19T03:13:45.955Z',
  };
  const text = marshalSnapshot(snapshot);
  const { snapshot: parsed, errors } = parseSnapshot(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(parsed, snapshot);
});

test('marshal includes the managed-by-extension header comment', () => {
  const text = marshalSnapshot(emptySnapshot());
  assert.match(text, /managed automatically/);
  assert.match(text, /Do not hand-edit/);
});

test('marshal output starts with comment lines (jsonc, not pure json)', () => {
  const text = marshalSnapshot(emptySnapshot());
  assert.ok(text.startsWith('//'), `expected jsonc to start with //, got: ${text.slice(0, 40)}`);
});

// ───── tolerant parse ─────────────────────────────────────────────────────

test('parse tolerates trailing commas and line comments', () => {
  const text = `// header comment
{
  "folders": [
    { "uri": "file:///x", "name": "x" }, // inline
  ],
  "settings": {},
  "capturedAt": "2026-05-19T03:00:00.000Z",
}`;
  const { snapshot, errors } = parseSnapshot(text);
  assert.deepEqual(errors, []);
  assert.equal(snapshot.folders.length, 1);
  assert.equal(snapshot.folders[0].uri, 'file:///x');
});

test('parse defaults missing fields rather than throwing', () => {
  const { snapshot, errors } = parseSnapshot('{}');
  assert.deepEqual(snapshot.folders, []);
  assert.deepEqual(snapshot.settings, {});
  assert.deepEqual(snapshot.placeholders, []);
  assert.equal(snapshot.capturedAt, '');
  // The empty object is a structurally-valid snapshot — no errors expected.
  assert.deepEqual(errors, []);
});

test('parse preserves a populated placeholders array', () => {
  const text = `{ "placeholders": ["aaaaaa", "bbbbbb"] }`;
  const { snapshot, errors } = parseSnapshot(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(snapshot.placeholders, ['aaaaaa', 'bbbbbb']);
});

test('parse lowercases mixed-case placeholder hashes', () => {
  const text = `{ "placeholders": ["AaBbCc", "DEADBEEF"] }`;
  const { snapshot } = parseSnapshot(text);
  assert.deepEqual(snapshot.placeholders, ['aabbcc', 'deadbeef']);
});

test('parse defaults placeholders to [] when the field is absent (legacy file)', () => {
  const text = `{ "folders": [{ "uri": "file:///x", "name": "x" }], "settings": {} }`;
  const { snapshot, errors } = parseSnapshot(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(snapshot.placeholders, []);
});

test('parse reports an error when the root is not an object', () => {
  const { snapshot, errors } = parseSnapshot('"hello"');
  assert.equal(snapshot.folders.length, 0);
  assert.ok(errors.some((e) => /root is not an object/.test(e)), errors.join('; '));
});

test('parse skips malformed folder entries but keeps valid ones', () => {
  const text = `{
  "folders": [
    { "uri": "file:///ok", "name": "OK" },
    { "name": "missing-uri" },
    "not-an-object",
    { "uri": "" }
  ]
}`;
  const { snapshot, errors } = parseSnapshot(text);
  assert.equal(snapshot.folders.length, 1);
  assert.equal(snapshot.folders[0].uri, 'file:///ok');
  assert.ok(errors.length >= 2, `expected diagnostics for skipped entries, got: ${errors.join('; ')}`);
});

test('parse defaults folder name to uri when name is missing', () => {
  const text = `{ "folders": [ { "uri": "file:///no-name" } ] }`;
  const { snapshot } = parseSnapshot(text);
  assert.equal(snapshot.folders[0].name, 'file:///no-name');
});

test('parse preserves nested settings values (arrays, objects, booleans)', () => {
  const text = `{
  "settings": {
    "files.readonlyInclude": { "**/*.pptx": true, "**/*.docx": false },
    "some.array.key": ["a", "b", "c"],
    "some.bool": false
  }
}`;
  const { snapshot } = parseSnapshot(text);
  assert.deepEqual(snapshot.settings['files.readonlyInclude'], {
    '**/*.pptx': true,
    '**/*.docx': false,
  });
  assert.deepEqual(snapshot.settings['some.array.key'], ['a', 'b', 'c']);
  assert.equal(snapshot.settings['some.bool'], false);
});

// ───── equality ──────────────────────────────────────────────────────────

test('snapshotsEqual ignores capturedAt', () => {
  const a: Snapshot = {
    folders: [{ uri: 'file:///x', name: 'x' }],
    settings: {},
    placeholders: [],
    capturedAt: '2026-01-01T00:00:00.000Z',
  };
  const b: Snapshot = { ...a, capturedAt: '2026-12-31T23:59:59.000Z' };
  assert.ok(snapshotsEqual(a, b));
});

test('snapshotsEqual detects folder uri/name changes', () => {
  const a: Snapshot = {
    folders: [{ uri: 'file:///x', name: 'X' }],
    settings: {},
    placeholders: [],
    capturedAt: 'now',
  };
  const renamed: Snapshot = { ...a, folders: [{ uri: 'file:///x', name: 'Renamed' }] };
  const moved: Snapshot = { ...a, folders: [{ uri: 'file:///y', name: 'X' }] };
  assert.ok(!snapshotsEqual(a, renamed));
  assert.ok(!snapshotsEqual(a, moved));
});

test('snapshotsEqual is order-sensitive on folders (workspaceFolders[0] is positional)', () => {
  const a: Snapshot = {
    folders: [
      { uri: 'file:///x', name: 'X' },
      { uri: 'file:///y', name: 'Y' },
    ],
    settings: {},
    placeholders: [],
    capturedAt: 'now',
  };
  const reordered: Snapshot = { ...a, folders: [a.folders[1], a.folders[0]] };
  assert.ok(!snapshotsEqual(a, reordered));
});

test('snapshotsEqual detects settings key add/remove/change', () => {
  const a: Snapshot = {
    folders: [],
    settings: { 'files.readonlyInclude': ['**/*.pptx'] },
    placeholders: [],
    capturedAt: 'now',
  };
  const added: Snapshot = {
    ...a,
    settings: { ...a.settings, 'files.readonlyExclude': ['**/*.tmp'] },
  };
  const changed: Snapshot = {
    ...a,
    settings: { 'files.readonlyInclude': ['**/*.docx'] },
  };
  assert.ok(!snapshotsEqual(a, added));
  assert.ok(!snapshotsEqual(a, changed));
});

test('snapshotsEqual treats settings key-order as irrelevant', () => {
  const a: Snapshot = {
    folders: [],
    settings: { a: 1, b: 2 },
    placeholders: [],
    capturedAt: 'now',
  };
  const reordered: Snapshot = { ...a, settings: { b: 2, a: 1 } };
  assert.ok(snapshotsEqual(a, reordered));
});

// ───── placeholders ───────────────────────────────────────────────────────

test('snapshotsEqual returns true when placeholders differ in order only', () => {
  const a: Snapshot = {
    folders: [],
    settings: {},
    placeholders: ['aaa', 'bbb', 'ccc'],
    capturedAt: 'now',
  };
  const reordered: Snapshot = { ...a, placeholders: ['ccc', 'aaa', 'bbb'] };
  assert.ok(snapshotsEqual(a, reordered));
});

test('snapshotsEqual returns false when placeholders differ in membership', () => {
  const a: Snapshot = {
    folders: [],
    settings: {},
    placeholders: ['aaa', 'bbb'],
    capturedAt: 'now',
  };
  const added: Snapshot = { ...a, placeholders: ['aaa', 'bbb', 'ccc'] };
  const replaced: Snapshot = { ...a, placeholders: ['aaa', 'zzz'] };
  assert.ok(!snapshotsEqual(a, added));
  assert.ok(!snapshotsEqual(a, replaced));
});

test('effectivePlaceholderSet always includes EMPTY_FILE_SHA256', () => {
  const set = effectivePlaceholderSet(null);
  assert.equal(set.size, 1);
  assert.ok(set.has(EMPTY_FILE_SHA256));
});

test('effectivePlaceholderSet adds user entries lowercased on top of the default', () => {
  const snapshot: Snapshot = {
    folders: [],
    settings: {},
    placeholders: ['DEADBEEF', 'cafebabe'],
    capturedAt: 'now',
  };
  const set = effectivePlaceholderSet(snapshot);
  assert.ok(set.has(EMPTY_FILE_SHA256));
  assert.ok(set.has('deadbeef'));
  assert.ok(set.has('cafebabe'));
  assert.equal(set.size, 3);
});

// ───── run ────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok: ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('all tests passed');
