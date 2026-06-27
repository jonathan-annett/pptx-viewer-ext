// Tests for destinationId.ts — GUID generation + the comment-preserving JSONC
// edits that stamp/rewrite `.sync.jsonc` destinations.
//
// Runs under plain Node via tsx — no VS Code needed.
//
// Run with: npm run test:sync-destination-id

import { strict as assert } from 'node:assert';
import {
  generateDestinationId,
  readRawDestinations,
  findDestination,
  rewriteDestinationUri,
  stampMissingIds,
} from '../src/sync/destinationId';
import { parseSyncConfigText } from '../src/sync/configParse';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

const URI_A = 'file:///handle/abc-backup-drive';
const URI_B = 'file:///handle/def-archive-server';
const URI_NEW = 'file:///handle/zzz-reconnected';

// Deterministic byte source: 0,1,2,… so the hex is predictable.
const seqBytes = (n: number): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => i);

// A monotonic id generator for tests that stamp several at once.
function counter(prefix = 'id'): () => string {
  let i = 0;
  return () => `${prefix}-${i++}`;
}

// ───── generateDestinationId ────────────────────────────────────────────────

test('generateDestinationId formats as d- + 32 hex chars', () => {
  const id = generateDestinationId(seqBytes);
  assert.equal(id, 'd-000102030405060708090a0b0c0d0e0f');
  assert.match(id, /^d-[0-9a-f]{32}$/);
});

test('generateDestinationId default source yields a well-formed, unique id', () => {
  const a = generateDestinationId();
  const b = generateDestinationId();
  assert.match(a, /^d-[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

// ───── schema round-trip (configParse carries id) ───────────────────────────

test('parseSyncConfigText preserves a non-empty id', () => {
  const got = parseSyncConfigText(`{ "destinations": [{ "uri": "${URI_A}", "id": "d-abc" }] }`);
  assert.equal(got.kind, 'ok');
  if (got.kind === 'ok') assert.deepEqual(got.config.destinations, [{ uri: URI_A, id: 'd-abc' }]);
});

test('parseSyncConfigText drops an empty-string id (treated as absent)', () => {
  const got = parseSyncConfigText(`{ "destinations": [{ "uri": "${URI_A}", "id": "" }] }`);
  assert.equal(got.kind, 'ok');
  if (got.kind === 'ok') assert.deepEqual(got.config.destinations, [{ uri: URI_A }]);
});

test('parseSyncConfigText rejects a non-string id', () => {
  const got = parseSyncConfigText(`{ "destinations": [{ "uri": "${URI_A}", "id": 5 }] }`);
  assert.equal(got.kind, 'error');
  if (got.kind === 'error') assert.match(got.error, /id must be a string/);
});

// ───── readRawDestinations ──────────────────────────────────────────────────

test('readRawDestinations extracts index/uri/id and skips malformed entries', () => {
  const text = `{
  "destinations": [
    { "uri": "${URI_A}", "id": "d-1" },
    { "nope": true },
    { "uri": "${URI_B}" }
  ]
}`;
  assert.deepEqual(readRawDestinations(text), [
    { index: 0, uri: URI_A, id: 'd-1' },
    // index 1 (malformed) skipped, but index 2 keeps its true array position
    { index: 2, uri: URI_B, id: undefined },
  ]);
});

test('readRawDestinations returns null when there is no destinations array', () => {
  assert.equal(readRawDestinations('{ "exclude": [] }'), null);
  assert.equal(readRawDestinations('not json'), null);
});

// ───── findDestination ──────────────────────────────────────────────────────

test('findDestination prefers an id match over uri', () => {
  const dests = readRawDestinations(
    `{ "destinations": [{ "uri": "${URI_A}", "id": "d-1" }, { "uri": "${URI_B}", "id": "d-2" }] }`,
  )!;
  // Match by id even though the supplied uri points at the other entry.
  assert.equal(findDestination(dests, { id: 'd-2', uri: URI_A })?.uri, URI_B);
});

test('findDestination falls back to uri when no id given', () => {
  const dests = readRawDestinations(`{ "destinations": [{ "uri": "${URI_A}" }] }`)!;
  assert.equal(findDestination(dests, { uri: URI_A })?.index, 0);
  assert.equal(findDestination(dests, { uri: 'file:///nope' }), undefined);
});

// ───── rewriteDestinationUri ────────────────────────────────────────────────

test('rewriteDestinationUri re-points uri AND stamps an id, preserving comments', () => {
  const text = `{
  // keep me
  "destinations": [
    { "uri": "${URI_A}" }
  ],
  "exclude": ["*.tmp"]
}`;
  const r = rewriteDestinationUri(text, { uri: URI_A }, URI_NEW, counter('d'));
  assert.equal(r.id, 'd-0');
  assert.match(r.text, /\/\/ keep me/); // comment preserved
  assert.match(r.text, /"exclude": \["\*\.tmp"\]/); // sibling key preserved
  // Re-parse to confirm semantics, not just text.
  const parsed = parseSyncConfigText(r.text);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind === 'ok') {
    assert.deepEqual(parsed.config.destinations, [{ uri: URI_NEW, id: 'd-0' }]);
  }
});

test('rewriteDestinationUri keeps an existing id instead of regenerating', () => {
  const text = `{ "destinations": [{ "uri": "${URI_A}", "id": "d-existing" }] }`;
  const r = rewriteDestinationUri(text, { id: 'd-existing', uri: URI_A }, URI_NEW, counter('new'));
  assert.equal(r.id, 'd-existing');
  const parsed = parseSyncConfigText(r.text);
  if (parsed.kind === 'ok') {
    assert.deepEqual(parsed.config.destinations, [{ uri: URI_NEW, id: 'd-existing' }]);
  }
});

test('rewriteDestinationUri reports notFound and leaves text unchanged', () => {
  const text = `{ "destinations": [{ "uri": "${URI_A}" }] }`;
  const r = rewriteDestinationUri(text, { uri: 'file:///missing' }, URI_NEW);
  assert.equal(r.notFound, true);
  assert.equal(r.text, text);
});

test('rewriteDestinationUri only touches the matched entry among several', () => {
  const text = `{ "destinations": [{ "uri": "${URI_A}" }, { "uri": "${URI_B}" }] }`;
  const r = rewriteDestinationUri(text, { uri: URI_B }, URI_NEW, counter('d'));
  const parsed = parseSyncConfigText(r.text);
  if (parsed.kind === 'ok') {
    assert.deepEqual(parsed.config.destinations, [
      { uri: URI_A },
      { uri: URI_NEW, id: 'd-0' },
    ]);
  }
});

// ───── stampMissingIds ──────────────────────────────────────────────────────

test('stampMissingIds stamps only id-less entries and preserves comments', () => {
  const text = `{
  // header
  "destinations": [
    { "uri": "${URI_A}", "id": "d-keep" },
    { "uri": "${URI_B}" }
  ]
}`;
  const r = stampMissingIds(text, counter('gen'));
  assert.equal(r.stamped, 1);
  assert.match(r.text, /\/\/ header/);
  const parsed = parseSyncConfigText(r.text);
  if (parsed.kind === 'ok') {
    assert.deepEqual(parsed.config.destinations, [
      { uri: URI_A, id: 'd-keep' },
      { uri: URI_B, id: 'gen-0' },
    ]);
  }
});

test('stampMissingIds is a no-op when every entry already has an id', () => {
  const text = `{ "destinations": [{ "uri": "${URI_A}", "id": "d-1" }] }`;
  const r = stampMissingIds(text, counter('gen'));
  assert.equal(r.stamped, 0);
  assert.equal(r.text, text);
});

// ───── run ──────────────────────────────────────────────────────────────────

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
