// Pure-module tests for src/event/titleSlides/pagination.ts.
//
// Run with: npm run test:title-slides-pagination

import { strict as assert } from 'node:assert';
import { splitSpeakers } from '../src/event/titleSlides/pagination';
import type { SessionSpeakerSlot } from '../src/event/schedule';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

function speakers(n: number): SessionSpeakerSlot[] {
  return Array.from({ length: n }, (_, i) => ({
    slot: i + 1,
    speakerId: `spk-${i + 1}`,
    speakerName: `S${i + 1}`,
  }));
}

function shape(pages: SessionSpeakerSlot[][]): number[] {
  return pages.map(p => p.length);
}

// ───── capacity edge cases ─────────────────────────────────────────────

test('capacity = 0 returns []', () => {
  assert.deepEqual(splitSpeakers(speakers(3), 0, false), []);
  assert.deepEqual(splitSpeakers(speakers(3), 0, true), []);
});

test('capacity < 0 returns []', () => {
  assert.deepEqual(splitSpeakers(speakers(3), -1, false), []);
});

// ───── empty speakers ──────────────────────────────────────────────────

test('0 speakers returns [[]] — one empty slide', () => {
  assert.deepEqual(splitSpeakers([], 4, false), [[]]);
  assert.deepEqual(splitSpeakers([], 4, true), [[]]);
});

// ───── speakers fit on one page ────────────────────────────────────────

test('speakers <= capacity returns single page (fill)', () => {
  assert.deepEqual(shape(splitSpeakers(speakers(1), 4, false)), [1]);
  assert.deepEqual(shape(splitSpeakers(speakers(3), 4, false)), [3]);
  assert.deepEqual(shape(splitSpeakers(speakers(4), 4, false)), [4]);
});

test('speakers <= capacity returns single page (evenly)', () => {
  assert.deepEqual(shape(splitSpeakers(speakers(1), 4, true)), [1]);
  assert.deepEqual(shape(splitSpeakers(speakers(3), 4, true)), [3]);
  assert.deepEqual(shape(splitSpeakers(speakers(4), 4, true)), [4]);
});

// ───── overflow: fill mode (distributeEvenly = false) ──────────────────

test('fill mode: 5 @ 4 = [4, 1]', () => {
  const pages = splitSpeakers(speakers(5), 4, false);
  assert.deepEqual(shape(pages), [4, 1]);
  assert.equal(pages[0][0].speakerName, 'S1');
  assert.equal(pages[1][0].speakerName, 'S5');
});

test('fill mode: 7 @ 4 = [4, 3]', () => {
  assert.deepEqual(shape(splitSpeakers(speakers(7), 4, false)), [4, 3]);
});

test('fill mode: 8 @ 4 = [4, 4]', () => {
  assert.deepEqual(shape(splitSpeakers(speakers(8), 4, false)), [4, 4]);
});

test('fill mode: 9 @ 4 = [4, 4, 1]', () => {
  assert.deepEqual(shape(splitSpeakers(speakers(9), 4, false)), [4, 4, 1]);
});

test('fill mode: 10 @ 4 = [4, 4, 2]', () => {
  assert.deepEqual(shape(splitSpeakers(speakers(10), 4, false)), [4, 4, 2]);
});

// ───── overflow: evenly mode (distributeEvenly = true) ─────────────────

test('evenly mode: 5 @ 4 = [3, 2]', () => {
  const pages = splitSpeakers(speakers(5), 4, true);
  assert.deepEqual(shape(pages), [3, 2]);
  assert.equal(pages[0][0].speakerName, 'S1');
  assert.equal(pages[1][0].speakerName, 'S4');
});

test('evenly mode: 6 @ 4 = [3, 3]', () => {
  assert.deepEqual(shape(splitSpeakers(speakers(6), 4, true)), [3, 3]);
});

test('evenly mode: 7 @ 4 = [4, 3]', () => {
  assert.deepEqual(shape(splitSpeakers(speakers(7), 4, true)), [4, 3]);
});

test('evenly mode: 8 @ 4 = [4, 4]', () => {
  assert.deepEqual(shape(splitSpeakers(speakers(8), 4, true)), [4, 4]);
});

test('evenly mode: 9 @ 4 = [3, 3, 3]', () => {
  assert.deepEqual(shape(splitSpeakers(speakers(9), 4, true)), [3, 3, 3]);
});

test('evenly mode: 10 @ 4 = [4, 3, 3]', () => {
  assert.deepEqual(shape(splitSpeakers(speakers(10), 4, true)), [4, 3, 3]);
});

test('evenly mode: 11 @ 4 = [4, 4, 3]', () => {
  assert.deepEqual(shape(splitSpeakers(speakers(11), 4, true)), [4, 4, 3]);
});

// ───── preserves speaker order + identity across both modes ────────────

test('all speakers preserved in order — fill mode', () => {
  const pages = splitSpeakers(speakers(10), 4, false);
  const flat = pages.flat().map(s => s.speakerName);
  assert.deepEqual(flat, ['S1','S2','S3','S4','S5','S6','S7','S8','S9','S10']);
});

test('all speakers preserved in order — evenly mode', () => {
  const pages = splitSpeakers(speakers(10), 4, true);
  const flat = pages.flat().map(s => s.speakerName);
  assert.deepEqual(flat, ['S1','S2','S3','S4','S5','S6','S7','S8','S9','S10']);
});

test('input not mutated (no aliasing into the input array)', () => {
  const src = speakers(5);
  const pages = splitSpeakers(src, 4, false);
  pages[0].push({ slot: 99, speakerId: 'spk-99', speakerName: 'X' });
  assert.equal(src.length, 5, 'mutating output page did not change input length');
});

// ───── capacity = 1: every speaker on its own slide ────────────────────

test('capacity = 1: 4 speakers → [1, 1, 1, 1]', () => {
  assert.deepEqual(shape(splitSpeakers(speakers(4), 1, false)), [1, 1, 1, 1]);
  assert.deepEqual(shape(splitSpeakers(speakers(4), 1, true)), [1, 1, 1, 1]);
});

// ───── run ─────────────────────────────────────────────────────────────

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
