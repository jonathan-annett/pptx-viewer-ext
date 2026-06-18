// Pure tests for src/thumbnailSynth.ts.
//
// Runs under plain Node via tsx — no DOM, no canvas needed because the
// layout helper takes its measureText callback as an injected dependency.
// Run with: npm run test:thumbnail-synth

import { strict as assert } from 'node:assert';
import {
  deterministicHslFromSha,
  computeTitleLayout,
} from '../src/thumbnailSynth';

// ---------- deterministicHslFromSha ----------

function test_colour_deterministic(): void {
  const sha = 'a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd';
  const a = deterministicHslFromSha(sha);
  const b = deterministicHslFromSha(sha);
  assert.deepEqual(a, b, 'same sha → same colour');
  // Saturation/lightness are fixed; only hue depends on the sha.
  assert.equal(a.s, 60);
  assert.equal(a.l, 45);
  console.log('  ok: same sha yields same hsl');
}

function test_colour_varies_with_sha(): void {
  const sha1 = 'a1b2c3' + '0'.repeat(58);
  const sha2 = 'f1f2f3' + '0'.repeat(58);
  const a = deterministicHslFromSha(sha1);
  const b = deterministicHslFromSha(sha2);
  assert.notEqual(a.h, b.h, 'different sha prefix → different hue');
  console.log('  ok: different sha yields different hue');
}

function test_hue_in_range(): void {
  // Walk a handful of prefixes; hue must always be 0..359.
  const prefixes = ['000000', '0000ff', '00ff00', 'ff0000', 'ffffff', '7f7f7f'];
  for (const p of prefixes) {
    const { h } = deterministicHslFromSha(p + '0'.repeat(58));
    assert.ok(h >= 0 && h < 360, `hue ${h} for prefix ${p} out of range`);
  }
  // 'ffffff' = 16777215. 16777215 % 360 = 16777215 - 46603*360 = ?
  // 46603 * 360 = 16777080, remainder = 135 → matches.
  const all = deterministicHslFromSha('ffffff' + '0'.repeat(58));
  assert.equal(all.h, 135, 'ffffff prefix maps to hue 135');
  console.log('  ok: hue stays in [0, 360)');
}

function test_colour_rejects_short_input(): void {
  assert.throws(() => deterministicHslFromSha('abc'), /need at least 6 hex chars/);
  console.log('  ok: rejects sha prefix shorter than 6 hex chars');
}

// ---------- computeTitleLayout ----------

/**
 * Test stub: pretend every character is `fontPx * 0.6` pixels wide.
 * Linear in length, so wrapping logic is easy to reason about.
 */
function fakeMeasure(text: string, fontPx: number): number {
  return text.length * fontPx * 0.6;
}

function test_layout_single_line_fits(): void {
  // "Hi" at 96px → 2 * 96 * 0.6 = 115.2px ≤ 500 maxWidth.
  const out = computeTitleLayout('Hi', {
    maxWidth: 500,
    maxLines: 4,
    startFontPx: 96,
    minFontPx: 32,
    measureText: fakeMeasure,
  });
  assert.deepEqual(out.lines, ['Hi']);
  assert.equal(out.fontPx, 96, 'no shrink needed for short text');
  console.log('  ok: short title stays on one line at start font');
}

function test_layout_wraps_at_max_width(): void {
  // 5 words of 4 chars each (with spaces): "word word word word word".
  // At 32px, each char is ~19.2px; "word word" = 9 chars = 172.8px;
  // maxWidth=200 → 2 words per line, so we should get 3 lines.
  const out = computeTitleLayout('word word word word word', {
    maxWidth: 200,
    maxLines: 6,
    startFontPx: 32,
    minFontPx: 32,
    measureText: fakeMeasure,
  });
  assert.equal(out.lines.length, 3);
  assert.equal(out.lines[0], 'word word');
  assert.equal(out.lines[1], 'word word');
  assert.equal(out.lines[2], 'word');
  console.log('  ok: greedy word-wrap at the max width');
}

function test_layout_shrinks_to_fit(): void {
  // Single long word at 96px > 500 maxWidth, but at 32px = 12*32*0.6 = 230.4
  // still > 500/... wait. Let's pick numbers more carefully.
  // text = "abcdefghij" (10 chars). At 96px: 10*96*0.6 = 576px > 500.
  // At 64px: 10*64*0.6 = 384px ≤ 500 → fits.
  // Start font shrinks 96 → 92 → 88 → ... → 64 (8 steps of 4).
  const out = computeTitleLayout('abcdefghij', {
    maxWidth: 500,
    maxLines: 1,
    startFontPx: 96,
    minFontPx: 32,
    measureText: fakeMeasure,
  });
  assert.equal(out.lines.length, 1);
  // 84px: 10*84*0.6 = 504 > 500. 80px: 10*80*0.6 = 480 ≤ 500. So fontPx=80.
  assert.equal(out.fontPx, 80, 'shrunk to first size that fits');
  console.log('  ok: shrinks font until single line fits');
}

function test_layout_floor_at_min_font(): void {
  // Pathological: long text that can't fit even at minFontPx.
  // text = "a".repeat(1000). At any font this far exceeds maxWidth.
  // The function should return at minFontPx with lines capped at maxLines.
  const out = computeTitleLayout('a'.repeat(1000), {
    maxWidth: 500,
    maxLines: 3,
    startFontPx: 96,
    minFontPx: 32,
    measureText: fakeMeasure,
  });
  assert.equal(out.fontPx, 32, 'bottoms out at minFontPx');
  assert.ok(out.lines.length <= 3, 'lines capped at maxLines');
  console.log('  ok: terminates at minFontPx with line cap enforced');
}

function test_layout_empty_text(): void {
  // Empty / whitespace-only input — caller should typically substitute
  // a fallback before getting here, but tolerate it gracefully.
  const out = computeTitleLayout('', {
    maxWidth: 500,
    maxLines: 4,
    startFontPx: 96,
    minFontPx: 32,
    measureText: fakeMeasure,
  });
  assert.deepEqual(out.lines, ['']);
  assert.equal(out.fontPx, 96, 'empty text returns startFontPx');
  console.log('  ok: empty text returns one empty line at startFontPx');
}

function test_layout_rejects_bad_options(): void {
  assert.throws(
    () =>
      computeTitleLayout('x', {
        maxWidth: 100,
        maxLines: 0,
        startFontPx: 32,
        minFontPx: 16,
        measureText: fakeMeasure,
      }),
    /maxLines must be ≥ 1/,
  );
  assert.throws(
    () =>
      computeTitleLayout('x', {
        maxWidth: 100,
        maxLines: 1,
        startFontPx: 32,
        minFontPx: 4,
        measureText: fakeMeasure,
      }),
    /minFontPx must be ≥ 6/,
  );
  console.log('  ok: validates option bounds');
}

async function main(): Promise<void> {
  console.log('deterministicHslFromSha:');
  test_colour_deterministic();
  test_colour_varies_with_sha();
  test_hue_in_range();
  test_colour_rejects_short_input();

  console.log('computeTitleLayout:');
  test_layout_single_line_fits();
  test_layout_wraps_at_max_width();
  test_layout_shrinks_to_fit();
  test_layout_floor_at_min_font();
  test_layout_empty_text();
  test_layout_rejects_bad_options();
  console.log('all thumbnailSynth tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
