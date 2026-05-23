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
  seedRememberedDecisions,
  type RowDecision,
} from '../src/sync/decisions';
import type { PlanItem } from '../src/sync/plan';

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

test('parseDecisionMessage: accepts warning-override kind', () => {
  const out = parseDecisionMessage({
    type: 'decision',
    id: '0:warning-override:a.pptx',
    kind: 'warning-override',
    relPath: 'a.pptx',
    accepted: true,
    remember: false,
  });
  assert.equal(out?.kind, 'warning-override');
  assert.equal(out?.relPath, 'a.pptx');
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
  kind: 'overwrite' | 'delete' | 'warning-override',
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

// ───── seedRememberedDecisions ───────────────────────────────────────────

function item(over: Partial<PlanItem> & Pick<PlanItem, 'kind' | 'relPath'>): PlanItem {
  return { ...over } as PlanItem;
}

test('seedRememberedDecisions: empty input → no entries, returns 0', () => {
  const map = new Map<string, RowDecision>();
  const n = seedRememberedDecisions([], map);
  assert.equal(n, 0);
  assert.equal(map.size, 0);
});

test('seedRememberedDecisions: items without remembered → no entries', () => {
  const map = new Map<string, RowDecision>();
  const n = seedRememberedDecisions(
    [{ items: [item({ kind: 'create', relPath: 'a.pptx' })] }],
    map,
  );
  assert.equal(n, 0);
});

test('seedRememberedDecisions: remembered update-collision → overwrite entry', () => {
  // A collision row with a remembered "don't ask again" overwrite decision.
  // The renderer pre-checks the row; this seed must mirror that so the
  // executor sees it as armed.
  const map = new Map<string, RowDecision>();
  const n = seedRememberedDecisions(
    [
      {
        items: [
          item({
            kind: 'update-collision',
            relPath: 'a.pptx',
            remembered: { accepted: true },
          }),
        ],
      },
    ],
    map,
  );
  assert.equal(n, 1);
  const row = map.get('0:overwrite:a.pptx');
  assert.ok(row, 'expected an overwrite entry at id 0:overwrite:a.pptx');
  assert.equal(row.accepted, true);
  assert.equal(row.remember, true);
  assert.equal(row.kind, 'overwrite');
});

test('seedRememberedDecisions: remembered destination-only → delete entry', () => {
  const map = new Map<string, RowDecision>();
  seedRememberedDecisions(
    [
      {
        items: [
          item({
            kind: 'destination-only',
            relPath: 'orphan.pptx',
            remembered: { accepted: true },
          }),
        ],
      },
    ],
    map,
  );
  const row = map.get('0:delete:orphan.pptx');
  assert.ok(row);
  assert.equal(row.kind, 'delete');
});

test('seedRememberedDecisions: remembered create + override-warning → warning-override entry', () => {
  // Reproduces the bug from the live test: a create row with an overridable
  // warning (e.g. pptx media-controls + embedded video) and a manifest-
  // remembered warning-override decision. The renderer pre-checks the box;
  // without seeding, the extension's decision map stays empty and the
  // executor's warning-override gate filters the row out — first click on
  // orange does nothing, second click after a manual toggle succeeds.
  const map = new Map<string, RowDecision>();
  const n = seedRememberedDecisions(
    [
      {
        items: [
          item({
            kind: 'create',
            relPath: 'wed/talk.pptx',
            remembered: { accepted: true },
            warnings: [
              { code: 'media-controls', severity: 'override', message: '' },
            ],
          }),
        ],
      },
    ],
    map,
  );
  assert.equal(n, 1);
  const row = map.get('0:warning-override:wed/talk.pptx');
  assert.ok(row, 'expected warning-override entry to be seeded');
  assert.equal(row.kind, 'warning-override');
});

test('seedRememberedDecisions: create without warnings + remembered → no entry', () => {
  // Defensive: a create row with no warnings has no warning-override
  // checkbox in the UI, so the seed must not invent an arming.
  const map = new Map<string, RowDecision>();
  const n = seedRememberedDecisions(
    [
      {
        items: [
          item({
            kind: 'create',
            relPath: 'clean.pptx',
            remembered: { accepted: true },
          }),
        ],
      },
    ],
    map,
  );
  assert.equal(n, 0);
});

test('seedRememberedDecisions: pairIndex is positional across plans', () => {
  // Two plans, one item each, both remembered. The IDs need to be 0:* and
  // 1:* — same positional convention the renderer uses in toViewModel.
  const map = new Map<string, RowDecision>();
  seedRememberedDecisions(
    [
      {
        items: [
          item({
            kind: 'update-collision',
            relPath: 'a.pptx',
            remembered: { accepted: true },
          }),
        ],
      },
      {
        items: [
          item({
            kind: 'update-collision',
            relPath: 'a.pptx',
            remembered: { accepted: true },
          }),
        ],
      },
    ],
    map,
  );
  assert.equal(map.size, 2);
  assert.ok(map.get('0:overwrite:a.pptx'));
  assert.ok(map.get('1:overwrite:a.pptx'));
});

test('seedRememberedDecisions: remembered.accepted=false → no entry', () => {
  // Phase-C only writes manifest decisions for accepted=true, but the type
  // allows false; the seed must not arm an unticked-remembered row.
  const map = new Map<string, RowDecision>();
  const n = seedRememberedDecisions(
    [
      {
        items: [
          item({
            kind: 'update-collision',
            relPath: 'a.pptx',
            remembered: { accepted: false },
          }),
        ],
      },
    ],
    map,
  );
  assert.equal(n, 0);
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
