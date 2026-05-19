// Tests for parseSyncConfigText — the pure JSONC + schema validator used by
// the folder-sync feature.
//
// Runs under plain Node via tsx — no VS Code needed.
//
// Run with: npm run test:sync-jsonc

import { strict as assert } from 'node:assert';
import { parseSyncConfigText, type SyncConfig } from '../src/sync/configParse';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

function ok(text: string): { config: SyncConfig } {
  const got = parseSyncConfigText(text);
  if (got.kind !== 'ok') {
    throw new Error(`expected ok, got error: ${got.error}`);
  }
  return { config: got.config };
}

function err(text: string, matcher: RegExp): void {
  const got = parseSyncConfigText(text);
  if (got.kind !== 'error') {
    throw new Error(`expected error matching ${matcher}, got ok`);
  }
  assert.match(got.error, matcher);
}

// Test URIs mirror the shape vscode.dev's FSA URIs take. Spelled out as
// `file:///handle/...` for readability — the parser doesn't care about the
// scheme, only that it's a non-empty string. Stability across folder renames
// is the whole reason we key destinations off URI rather than display name.
const URI_A = 'file:///handle/abc-backup-drive';
const URI_B = 'file:///handle/def-archive-server';

// ───── happy path: the canonical .sync.jsonc shape ───────────────────────

test('full .sync.jsonc shape parses to expected SyncConfig', () => {
  const src = `{
  "destinations": [
    { "uri": "${URI_A}", "path": "projects/alpha" },
    { "uri": "${URI_B}", "path": "snapshots/alpha" }
  ],
  "exclude": ["~$*", "*.tmp", "node_modules/**"],
  "include": ["**/*"]
}`;
  const got = ok(src);
  assert.deepEqual(got.config, {
    destinations: [
      { uri: URI_A, path: 'projects/alpha' },
      { uri: URI_B, path: 'snapshots/alpha' },
    ],
    exclude: ['~$*', '*.tmp', 'node_modules/**'],
    include: ['**/*'],
  });
});

test('destinations with only required field', () => {
  const got = ok(`{ "destinations": [{ "uri": "${URI_A}" }] }`);
  assert.deepEqual(got.config.destinations, [{ uri: URI_A }]);
});

test('exclude and include default to empty when omitted', () => {
  const got = ok(`{ "destinations": [{ "uri": "${URI_A}" }] }`);
  assert.deepEqual(got.config.exclude, []);
  assert.deepEqual(got.config.include, []);
});

// ───── JSONC features: comments + trailing commas ─────────────────────────

test('line comments are accepted', () => {
  const src = `{
  // top-level comment
  "destinations": [
    { "uri": "${URI_A}" } // inline comment
  ]
}`;
  const got = ok(src);
  assert.deepEqual(got.config.destinations, [{ uri: URI_A }]);
});

test('block comments are accepted', () => {
  const src = `{
  /* block
     comment */
  "destinations": [{ "uri": "${URI_A}" }]
}`;
  const got = ok(src);
  assert.deepEqual(got.config.destinations, [{ uri: URI_A }]);
});

test('trailing commas are accepted', () => {
  const src = `{
  "destinations": [
    { "uri": "${URI_A}", },
    { "uri": "${URI_B}", },
  ],
  "exclude": ["a", "b",],
}`;
  const got = ok(src);
  assert.equal(got.config.destinations.length, 2);
  assert.deepEqual(got.config.exclude, ['a', 'b']);
});

// ───── subpath normalisation ──────────────────────────────────────────────

test('subpath has leading/trailing/duplicate slashes stripped', () => {
  const got = ok(`{ "destinations": [{ "uri": "${URI_A}", "path": "//a//b//" }] }`);
  assert.equal(got.config.destinations[0].path, 'a/b');
});

test('empty subpath stays empty (treated as destination root)', () => {
  const got = ok(`{ "destinations": [{ "uri": "${URI_A}", "path": "" }] }`);
  assert.equal(got.config.destinations[0].path, '');
});

// ───── error cases ────────────────────────────────────────────────────────

test('top-level array is rejected', () => {
  err(`[]`, /top-level value must be a JSON object/);
});

test('missing destinations is rejected', () => {
  err(`{}`, /`destinations` is required/);
});

test('empty destinations array is rejected', () => {
  err(`{ "destinations": [] }`, /`destinations` is required/);
});

test('destination without uri is rejected', () => {
  err(`{ "destinations": [{ "path": "a" }] }`, /destinations\[0\]\.uri/);
});

test('destination with empty uri is rejected', () => {
  err(`{ "destinations": [{ "uri": "" }] }`, /destinations\[0\]\.uri/);
});

test('destination uri not a string is rejected', () => {
  err(`{ "destinations": [{ "uri": 42 }] }`, /destinations\[0\]\.uri/);
});

test('destination path not a string is rejected', () => {
  err(`{ "destinations": [{ "uri": "${URI_A}", "path": 1 }] }`, /destinations\[0\]\.path/);
});

test('exclude not an array is rejected', () => {
  err(`{ "destinations": [{ "uri": "${URI_A}" }], "exclude": "nope" }`, /`exclude` must be an array/);
});

test('non-string entry in include is rejected', () => {
  err(
    `{ "destinations": [{ "uri": "${URI_A}" }], "include": ["a", 5] }`,
    /`include`\[1\] must be a string/,
  );
});

test('malformed JSON surfaces a parse error', () => {
  err(`{ "destinations": [`, /jsonc parse error/);
});

test('empty input is rejected as a parse error', () => {
  err(``, /top-level|parse error/);
});

// ───── unknown keys are tolerated (forward-compat) ────────────────────────

test('unknown top-level keys are ignored', () => {
  const got = ok(`{
  "destinations": [{ "uri": "${URI_A}" }],
  "futureOption": "irrelevant"
}`);
  assert.equal(got.config.destinations.length, 1);
});

// ───── stale `name` field is rejected (additionalProperties: false) ──────
// The schema sets additionalProperties: false on each destination entry, so a
// legacy `name` field surfaces as an unknown-property error in the JSON Schema
// editor. The parser itself is more tolerant — it ignores unknown keys at the
// destination level. This test confirms the parser still works when name is
// present alongside uri (forward-compat with mixed files during migration),
// but consumers should rely on the schema to flag the deprecated shape.
test('extra name field on destination is ignored (parser tolerates it)', () => {
  const got = ok(`{ "destinations": [{ "uri": "${URI_A}", "name": "legacy" }] }`);
  assert.deepEqual(got.config.destinations, [{ uri: URI_A }]);
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
