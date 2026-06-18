// Tests for parseSyncConfigText — the pure JSONC + schema validator used by
// the folder-sync feature.
//
// Runs under plain Node via tsx — no VS Code needed.
//
// Run with: npm run test:sync-jsonc

import { strict as assert } from 'node:assert';
import {
  expandRoomSyncVariable,
  parseSyncConfigText,
  validateWorkspaceRootConfig,
  type SyncConfig,
} from '../src/sync/configParse';

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
    pathAliases: {},
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

test('empty destinations array is accepted as a not-yet-wired template', () => {
  // Generator-emitted templates (see scripts/generate-event-folders.ts)
  // ship with `destinations: []` so the operator can wire them up via the
  // form editor — the file should parse cleanly so the editor renders the
  // form without a scary parse-error banner.
  const got = ok(`{ "destinations": [] }`);
  assert.deepEqual(got.config.destinations, []);
});

test('non-array destinations is still rejected', () => {
  // Defensive: a shape error (e.g. `destinations: "foo"`) is a real
  // problem, not a not-yet-wired state. Keep the type check strict.
  err(`{ "destinations": "nope" }`, /`destinations` is required and must be an array/);
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

// ───── path-aliases (M2 of room-sync-format-v1-plan.md) ──────────────────

test('path-aliases parses the hyphenated spelling', () => {
  const got = ok(`{
  "destinations": [{ "uri": "${URI_A}" }],
  "path-aliases": {
    "MON/room1": "MON",
    "TUE/room1": "TUE"
  }
}`);
  assert.deepEqual(got.config.pathAliases, {
    'MON/room1': 'MON',
    'TUE/room1': 'TUE',
  });
});

test('path-aliases also accepts the camelCase spelling', () => {
  // The TypeScript field is `pathAliases`; users typing it from the type
  // shape should still see it work. The schema documents the hyphenated form.
  const got = ok(`{
  "destinations": [{ "uri": "${URI_A}" }],
  "pathAliases": { "MON/room1": "MON" }
}`);
  assert.deepEqual(got.config.pathAliases, { 'MON/room1': 'MON' });
});

test('path-aliases is empty record when omitted', () => {
  const got = ok(`{ "destinations": [{ "uri": "${URI_A}" }] }`);
  assert.deepEqual(got.config.pathAliases, {});
});

test('path-aliases normalises leading/trailing/duplicate slashes on both sides', () => {
  const got = ok(`{
  "destinations": [{ "uri": "${URI_A}" }],
  "path-aliases": {
    "/MON/room1/": "/MON/",
    "TUE//room1": "TUE"
  }
}`);
  assert.deepEqual(got.config.pathAliases, {
    'MON/room1': 'MON',
    'TUE/room1': 'TUE',
  });
});

test('path-aliases preserves authoring order (used as precedence)', () => {
  // First-match-wins resolution depends on order. JSON property order is
  // preserved by jsonc-parser, so the runtime sees aliases in the order
  // the user wrote them.
  const got = ok(`{
  "destinations": [{ "uri": "${URI_A}" }],
  "path-aliases": {
    "z/first": "z",
    "a/second": "a",
    "m/third": "m"
  }
}`);
  assert.deepEqual(Object.keys(got.config.pathAliases), [
    'z/first',
    'a/second',
    'm/third',
  ]);
});

test('path-aliases not an object is rejected', () => {
  err(
    `{ "destinations": [{ "uri": "${URI_A}" }], "path-aliases": ["nope"] }`,
    /`path-aliases` must be an object/,
  );
});

test('path-aliases with a non-string value is rejected', () => {
  err(
    `{ "destinations": [{ "uri": "${URI_A}" }], "path-aliases": { "a": 42 } }`,
    /`path-aliases`\["a"\] must be a string/,
  );
});

// ───── workspace-root validation (M3 of room-sync-format-v1-plan) ────────

test('validateWorkspaceRootConfig accepts a config with non-empty path-aliases', () => {
  const config: SyncConfig = {
    destinations: [{ uri: URI_A }],
    include: [],
    exclude: [],
    pathAliases: { 'MON/room1': 'MON' },
  };
  assert.equal(validateWorkspaceRootConfig(config, 'Room1.roomSync'), null);
});

// ───── expandRoomSyncVariable (v1 follow-up: ${roomSync} template) ──────

test('expandRoomSyncVariable replaces every occurrence with the handle', () => {
  const text = '{ "path-aliases": { "${roomSync}/foo": "${roomSync}" } }';
  const got = expandRoomSyncVariable(text, 'breakout-1');
  assert.equal(got, '{ "path-aliases": { "breakout-1/foo": "breakout-1" } }');
});

test('expandRoomSyncVariable leaves text untouched when handle is empty', () => {
  // Defensive: no meaningful handle means "leave literal" so downstream
  // surfaces a clear error rather than silently substituting empty.
  const text = '{ "path-aliases": { "${roomSync}/foo": "x" } }';
  assert.equal(expandRoomSyncVariable(text, ''), text);
});

test('expandRoomSyncVariable is a passthrough when there are no tokens', () => {
  const text = '{ "destinations": [] }';
  assert.equal(expandRoomSyncVariable(text, 'breakout-1'), text);
});

test('expandRoomSyncVariable substitutes the handle through to parsing', () => {
  // End-to-end shape — substitution + parse produces a config whose
  // alias keys reflect the resolved handle, not the template.
  const text = `{
  "destinations": [{ "uri": "${URI_A}" }],
  "path-aliases": { "\${roomSync}/talks": "\${roomSync}" }
}`;
  const expanded = expandRoomSyncVariable(text, 'breakout-1');
  const got = ok(expanded);
  assert.deepEqual(got.config.pathAliases, { 'breakout-1/talks': 'breakout-1' });
});

test('validateWorkspaceRootConfig rejects an empty path-aliases record', () => {
  const config: SyncConfig = {
    destinations: [{ uri: URI_A }],
    include: [],
    exclude: [],
    pathAliases: {},
  };
  const got = validateWorkspaceRootConfig(config, 'Room1.roomSync');
  assert.ok(got, 'expected an error for missing path-aliases');
  // The error message names the file (so the user can find the offending
  // config in a workspace with several) and explains the mandatory field.
  assert.match(got!.error, /Room1\.roomSync/);
  assert.match(got!.error, /path-aliases/);
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
