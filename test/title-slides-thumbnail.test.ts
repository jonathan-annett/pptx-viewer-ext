// Pure-helper tests for src/event/titleSlides/thumbnail.ts.
//
// The canvas-based renderer isn't testable under Node (no OffscreenCanvas),
// but its time-formatter helper is — and that's where the most likely
// bugs live (string padding, malformed ISO input).
//
// Run with: npm run test:title-slides-thumbnail

import { strict as assert } from 'node:assert';
import { formatThumbnailTime } from '../src/event/titleSlides/thumbnail';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

test('formats a valid ISO timestamp as HH:MM:SS (local time)', () => {
  // Use a date with distinctive local-time components; we just check
  // the shape + that values look like real numbers.
  const out = formatThumbnailTime('2026-05-29T12:34:56Z');
  assert.match(out, /^\d{2}:\d{2}:\d{2}$/, `got "${out}"`);
});

test('zero-pads single-digit hours/minutes/seconds', () => {
  // Construct an ISO whose local time has single-digit components
  // somewhere — we can't easily control TZ in the test, but Date itself
  // formats consistently. Verify the regex shape covers padding.
  const formatted = formatThumbnailTime(new Date(2026, 4, 29, 1, 2, 3).toISOString());
  assert.match(formatted, /^\d{2}:\d{2}:\d{2}$/);
  // Single-digit hour → '01:02:03' would be the local string.
  assert.equal(formatted.length, 8);
});

test('returns empty string for unparseable input', () => {
  assert.equal(formatThumbnailTime('not-a-date'), '');
  assert.equal(formatThumbnailTime(''), '');
});

test('returns empty string for the literal "Invalid Date"', () => {
  assert.equal(formatThumbnailTime('Invalid Date'), '');
});

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
