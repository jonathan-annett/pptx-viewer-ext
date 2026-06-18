// Tests for the placeholder registry's pure helper.
//
// The wired activation path (FileSystemWatcher, workspaceFolder subscription,
// async cache invalidation) is manual smoke only — these tests cover the
// text→Set transformation the registry uses on each disk read. The helper
// lives in src/sync/snapshot.ts (pure module) rather than the wired registry
// so it stays tsx-runnable.
//
// Run with: npm run test:sync-placeholder-registry

import { strict as assert } from 'node:assert';
import { computeEffectiveSetFromText, EMPTY_FILE_SHA256 } from '../src/sync/snapshot';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

test('empty text → set containing only EMPTY_FILE_SHA256', () => {
  const set = computeEffectiveSetFromText('');
  assert.equal(set.size, 1);
  assert.ok(set.has(EMPTY_FILE_SHA256));
});

test('JSONC with no placeholders field → empty-default-only set', () => {
  const text = `{ "folders": [], "settings": {}, "capturedAt": "" }`;
  const set = computeEffectiveSetFromText(text);
  assert.equal(set.size, 1);
  assert.ok(set.has(EMPTY_FILE_SHA256));
});

test('JSONC with placeholders adds them on top of the default (lowercased)', () => {
  const text = `{
    "folders": [],
    "settings": {},
    "placeholders": ["aaa", "BBB"],
    "capturedAt": ""
  }`;
  const set = computeEffectiveSetFromText(text);
  assert.equal(set.size, 3);
  assert.ok(set.has(EMPTY_FILE_SHA256));
  assert.ok(set.has('aaa'));
  assert.ok(set.has('bbb'));
});

test('malformed JSONC degrades to the empty-default set without throwing', () => {
  // parseSnapshot is tolerant — root-not-object yields the empty snapshot,
  // which effectivePlaceholderSet maps to {EMPTY_FILE_SHA256}.
  const text = `not-an-object`;
  const set = computeEffectiveSetFromText(text);
  assert.equal(set.size, 1);
  assert.ok(set.has(EMPTY_FILE_SHA256));
});

test('JSONC with line comments + trailing commas parses normally', () => {
  const text = `// header
{
  "placeholders": [
    "DEADBEEF", // a custom stub
  ],
}`;
  const set = computeEffectiveSetFromText(text);
  assert.ok(set.has('deadbeef'));
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
