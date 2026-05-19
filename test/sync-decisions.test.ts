// Tests for the pure decision parser + applier used by the plan webview.
// Run with: npm run test:sync-decisions
//
// The webview posts {type:'decision', id, kind, relPath, accepted} messages
// as the user toggles per-row checkboxes. The parser validates the shape
// (untrusted input — every field is checked) and the applier mutates the
// in-memory map that Phase C will read when wiring decisions into the
// executor.

import { strict as assert } from 'node:assert';
import {
  applyDecision,
  parseDecisionMessage,
  type RowDecision,
} from '../src/sync/decisions';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

// ───── parseDecisionMessage ──────────────────────────────────────────────

test('parseDecisionMessage: well-formed accept message → RowDecision', () => {
  const out = parseDecisionMessage({
    type: 'decision',
    id: '0:overwrite:a.txt',
    kind: 'overwrite',
    relPath: 'a.txt',
    accepted: true,
    remember: false,
  });
  assert.deepEqual(out, {
    id: '0:overwrite:a.txt',
    kind: 'overwrite',
    relPath: 'a.txt',
    accepted: true,
    remember: false,
  });
});

test('parseDecisionMessage: well-formed reject message → RowDecision', () => {
  const out = parseDecisionMessage({
    type: 'decision',
    id: '1:delete:gone.txt',
    kind: 'delete',
    relPath: 'gone.txt',
    accepted: false,
    remember: false,
  });
  assert.equal(out?.accepted, false);
  assert.equal(out?.kind, 'delete');
});

test('parseDecisionMessage: remember=true on accept → preserved', () => {
  const out = parseDecisionMessage({
    type: 'decision',
    id: 'a',
    kind: 'overwrite',
    relPath: 'a.txt',
    accepted: true,
    remember: true,
  });
  assert.equal(out?.remember, true);
});

test('parseDecisionMessage: remember=true on reject → forced false (no remember-without-accept)', () => {
  const out = parseDecisionMessage({
    type: 'decision',
    id: 'a',
    kind: 'overwrite',
    relPath: 'a.txt',
    accepted: false,
    remember: true,
  });
  assert.equal(out?.remember, false);
});

test('parseDecisionMessage: missing remember field → defaults false (pre-Phase-C messages)', () => {
  const out = parseDecisionMessage({
    type: 'decision',
    id: 'a',
    kind: 'overwrite',
    relPath: 'a.txt',
    accepted: true,
  });
  assert.equal(out?.remember, false);
});

test('parseDecisionMessage: rejects wrong type', () => {
  assert.equal(parseDecisionMessage({ type: 'cancel' }), undefined);
});

test('parseDecisionMessage: rejects unknown kind', () => {
  assert.equal(
    parseDecisionMessage({
      type: 'decision',
      id: 'x',
      kind: 'destroy', // not in the allow-list
      relPath: 'a.txt',
      accepted: true,
    }),
    undefined,
  );
});

test('parseDecisionMessage: rejects non-boolean accepted', () => {
  assert.equal(
    parseDecisionMessage({
      type: 'decision',
      id: 'x',
      kind: 'overwrite',
      relPath: 'a.txt',
      accepted: 'yes',
    }),
    undefined,
  );
});

test('parseDecisionMessage: rejects missing fields', () => {
  assert.equal(
    parseDecisionMessage({
      type: 'decision',
      id: 'x',
      kind: 'overwrite',
      // relPath missing
      accepted: true,
    }),
    undefined,
  );
});

test('parseDecisionMessage: rejects non-object input', () => {
  assert.equal(parseDecisionMessage(null), undefined);
  assert.equal(parseDecisionMessage(undefined), undefined);
  assert.equal(parseDecisionMessage('decision'), undefined);
  assert.equal(parseDecisionMessage(42), undefined);
});

// ───── applyDecision ─────────────────────────────────────────────────────

const dec = (
  id: string,
  kind: 'overwrite' | 'delete',
  relPath: string,
  accepted: boolean,
  remember = false,
): RowDecision => ({ id, kind, relPath, accepted, remember });

test('applyDecision: accepted true → stored, returns new size', () => {
  const map = new Map<string, RowDecision>();
  const size = applyDecision(map, dec('a', 'overwrite', 'a.txt', true));
  assert.equal(size, 1);
  assert.equal(map.get('a')?.accepted, true);
});

test('applyDecision: accepted false → deleted (absence is the safe default)', () => {
  const map = new Map<string, RowDecision>();
  applyDecision(map, dec('a', 'overwrite', 'a.txt', true));
  const size = applyDecision(map, dec('a', 'overwrite', 'a.txt', false));
  assert.equal(size, 0);
  assert.equal(map.has('a'), false);
});

test('applyDecision: clearing a never-set key is a no-op', () => {
  const map = new Map<string, RowDecision>();
  const size = applyDecision(map, dec('a', 'overwrite', 'a.txt', false));
  assert.equal(size, 0);
});

test('applyDecision: two ids coexist independently', () => {
  const map = new Map<string, RowDecision>();
  applyDecision(map, dec('0:overwrite:a.txt', 'overwrite', 'a.txt', true));
  applyDecision(map, dec('0:delete:b.txt', 'delete', 'b.txt', true));
  assert.equal(map.size, 2);
});

test('applyDecision: re-accepting an existing id overwrites prior record', () => {
  const map = new Map<string, RowDecision>();
  applyDecision(map, dec('a', 'overwrite', 'a.txt', true));
  // Caller posts a second message — applier last-write-wins.
  applyDecision(map, {
    id: 'a',
    kind: 'overwrite',
    relPath: 'a.txt',
    accepted: true,
    remember: true,
  });
  assert.equal(map.size, 1);
  assert.equal(map.get('a')?.remember, true);
});

// ───── runner ────────────────────────────────────────────────────────────

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
