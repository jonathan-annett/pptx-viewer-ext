// Pure tests for the PDF → PPTX layout helper.
//
// Runnable directly under tsx; no DOM, no PDF.js, no VS Code shim.
// `npm run test:pdf-import-layout`

import {
  computePageLayout,
  targetPxWFor,
  estimateCanvasBytes,
  type PageLayout,
} from '../src/pdfImportLayout';
import { SLIDE_SIZE_16x9_EMU, SLIDE_SIZE_4x3_EMU } from '../src/pdfImport';

const tests: Array<[string, () => void | Promise<void>]> = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push([name, fn]);
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function approx(a: number, b: number, tol: number, label: string): void {
  if (Math.abs(a - b) > tol) {
    throw new Error(`${label}: expected ${b}, got ${a} (tolerance ${tol})`);
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

// A4 portrait: 595.28 × 841.89 pt (PDF default)
const A4_PORTRAIT = { widthPt: 595.28, heightPt: 841.89 };
// A4 landscape (rotated). aspect=1.414, narrower than 16:9 — still side-barred on 16:9.
const A4_LANDSCAPE = { widthPt: 841.89, heightPt: 595.28 };
// US Letter portrait
const LETTER_PORTRAIT = { widthPt: 612, heightPt: 792 };
// Exact 16:9 page — e.g. an already-presentation-shaped PDF
const PAGE_16x9 = { widthPt: 1280, heightPt: 720 };
// Exact 4:3 page
const PAGE_4x3 = { widthPt: 800, heightPt: 600 };
// Panoramic 2:1 page — wider than any standard slide → top/bottom bars on 16:9.
const PAGE_PANORAMIC = { widthPt: 1600, heightPt: 800 };

// ─── tests ────────────────────────────────────────────────────────────────

test('computePageLayout: 16:9 page on 16:9 slide → exact fit, no bars', () => {
  const out = computePageLayout(PAGE_16x9, SLIDE_SIZE_16x9_EMU, { targetPxW: 1920 });
  assert(out.placement.offsetEmuX === 0, `X offset should be 0, got ${out.placement.offsetEmuX}`);
  assert(out.placement.offsetEmuY === 0, `Y offset should be 0, got ${out.placement.offsetEmuY}`);
  assert(
    out.placement.imageEmuW === SLIDE_SIZE_16x9_EMU.cx,
    `image should fill slide width`,
  );
  // Allow rounding slack (cx/aspect): 12192000 / (1280/720) = 6858000 → equals cy.
  approx(out.placement.imageEmuH, SLIDE_SIZE_16x9_EMU.cy, 1, 'imageEmuH');
  assert(out.imagePxW === 1920, `imagePxW = ${out.imagePxW}`);
  approx(out.imagePxH, 1080, 1, 'imagePxH');
});

test('computePageLayout: A4 portrait on 16:9 slide → left/right bars', () => {
  const out = computePageLayout(A4_PORTRAIT, SLIDE_SIZE_16x9_EMU, { targetPxW: 1920 });
  // Height-bound: image height equals slide cy, width is narrower.
  assert(
    out.placement.imageEmuH === SLIDE_SIZE_16x9_EMU.cy,
    `image height should fill slide cy, got ${out.placement.imageEmuH}`,
  );
  assert(
    out.placement.imageEmuW < SLIDE_SIZE_16x9_EMU.cx,
    `image width should be narrower than slide, got ${out.placement.imageEmuW}`,
  );
  // Centred horizontally.
  const expectedX = Math.round(
    (SLIDE_SIZE_16x9_EMU.cx - out.placement.imageEmuW) / 2,
  );
  assert(
    out.placement.offsetEmuX === expectedX,
    `X offset should centre, got ${out.placement.offsetEmuX} expected ${expectedX}`,
  );
  assert(out.placement.offsetEmuY === 0, `Y offset should be 0`);
  // Aspect check: imageEmuW / imageEmuH ≈ pageAspect.
  const pageAspect = A4_PORTRAIT.widthPt / A4_PORTRAIT.heightPt;
  const placedAspect = out.placement.imageEmuW / out.placement.imageEmuH;
  approx(placedAspect, pageAspect, 0.001, 'placed aspect matches page aspect');
});

test('computePageLayout: panoramic 2:1 page on 16:9 slide → top/bottom bars', () => {
  const out = computePageLayout(PAGE_PANORAMIC, SLIDE_SIZE_16x9_EMU, { targetPxW: 1920 });
  // 2:1 = 2.0, wider than 16:9 = 1.778 → width-bound, top/bottom bars.
  assert(
    out.placement.imageEmuW === SLIDE_SIZE_16x9_EMU.cx,
    `image should fill slide width, got ${out.placement.imageEmuW}`,
  );
  assert(
    out.placement.imageEmuH < SLIDE_SIZE_16x9_EMU.cy,
    `image height should be shorter than slide, got ${out.placement.imageEmuH}`,
  );
  const expectedY = Math.round(
    (SLIDE_SIZE_16x9_EMU.cy - out.placement.imageEmuH) / 2,
  );
  assert(
    out.placement.offsetEmuY === expectedY,
    `Y offset should centre, got ${out.placement.offsetEmuY} expected ${expectedY}`,
  );
  assert(out.placement.offsetEmuX === 0, `X offset should be 0`);
});

test('computePageLayout: A4 landscape on 16:9 → still side-barred (slide is wider)', () => {
  // Sanity check: A4 landscape (1.414) < 16:9 (1.778), so it's height-bound
  // even though it's "landscape" — the page is narrower-shaped than 16:9.
  const out = computePageLayout(A4_LANDSCAPE, SLIDE_SIZE_16x9_EMU, { targetPxW: 1920 });
  assert(out.placement.offsetEmuX > 0, 'expected side bars');
  assert(out.placement.offsetEmuY === 0, 'no top/bottom bars');
  assert(out.placement.imageEmuH === SLIDE_SIZE_16x9_EMU.cy, 'height-bound');
});

test('computePageLayout: 4:3 page on 4:3 slide → exact fit', () => {
  const out = computePageLayout(PAGE_4x3, SLIDE_SIZE_4x3_EMU, { targetPxW: 1440 });
  assert(out.placement.offsetEmuX === 0, `X offset should be 0`);
  assert(out.placement.offsetEmuY === 0, `Y offset should be 0`);
  assert(out.placement.imageEmuW === SLIDE_SIZE_4x3_EMU.cx, 'image fills slide width');
  approx(out.placement.imageEmuH, SLIDE_SIZE_4x3_EMU.cy, 1, 'image fills slide height');
  assert(out.imagePxW === 1440, `imagePxW = ${out.imagePxW}`);
  approx(out.imagePxH, 1080, 1, 'imagePxH = 1080 (4:3 of 1440)');
});

test('computePageLayout: 4:3 page on 16:9 slide → left/right bars', () => {
  const out = computePageLayout(PAGE_4x3, SLIDE_SIZE_16x9_EMU, { targetPxW: 1920 });
  // 4:3 = 1.333; 16:9 = 1.778; page is narrower → height-bound.
  assert(
    out.placement.imageEmuH === SLIDE_SIZE_16x9_EMU.cy,
    `image height fills slide`,
  );
  assert(
    out.placement.imageEmuW < SLIDE_SIZE_16x9_EMU.cx,
    `image width should be narrower`,
  );
  // The 4:3 image inside a 16:9 slide: image width = cy × 4/3.
  const expectedW = Math.round(SLIDE_SIZE_16x9_EMU.cy * (4 / 3));
  approx(out.placement.imageEmuW, expectedW, 1, 'image width');
});

test('computePageLayout: stretch mode fills slide, no bars, no aspect preservation', () => {
  const out = computePageLayout(A4_PORTRAIT, SLIDE_SIZE_16x9_EMU, {
    targetPxW: 1920,
    letterbox: false,
  });
  assert(out.placement.offsetEmuX === 0, `X offset = 0 in stretch`);
  assert(out.placement.offsetEmuY === 0, `Y offset = 0 in stretch`);
  assert(out.placement.imageEmuW === SLIDE_SIZE_16x9_EMU.cx, 'fills slide cx');
  assert(out.placement.imageEmuH === SLIDE_SIZE_16x9_EMU.cy, 'fills slide cy');
  // Canvas pixel aspect matches the slide (1920×1080), not the A4 page.
  assert(out.imagePxW === 1920, 'imagePxW');
  approx(out.imagePxH, 1080, 1, 'imagePxH matches slide aspect');
});

test('computePageLayout: renderScale derives from imagePxW / widthPt', () => {
  const out = computePageLayout(LETTER_PORTRAIT, SLIDE_SIZE_16x9_EMU, { targetPxW: 1920 });
  const expectedScale = out.imagePxW / LETTER_PORTRAIT.widthPt;
  approx(out.renderScale, expectedScale, 1e-9, 'renderScale');
  assert(out.renderScale > 0, 'renderScale > 0');
});

test('computePageLayout: imagePxW scales with picture width fraction of slide', () => {
  // A 4:3 page on 16:9 slide occupies 3/4 of the slide width (3:4 aspect ratio
  // implies imageEmuW = cy × 4/3, ratio to cx = cy×4/3 / cx).
  const out = computePageLayout(PAGE_4x3, SLIDE_SIZE_16x9_EMU, { targetPxW: 1920 });
  const ratio = out.placement.imageEmuW / SLIDE_SIZE_16x9_EMU.cx;
  approx(out.imagePxW / 1920, ratio, 0.002, 'imagePxW tracks EMU width ratio');
});

test('computePageLayout: side-bar vs top/bottom-bar cases on same slide', () => {
  const portrait = computePageLayout(A4_PORTRAIT, SLIDE_SIZE_16x9_EMU, { targetPxW: 1920 });
  const panoramic = computePageLayout(PAGE_PANORAMIC, SLIDE_SIZE_16x9_EMU, { targetPxW: 1920 });
  // Portrait (narrower than slide) → side bars.
  assert(portrait.placement.offsetEmuX > 0 && portrait.placement.offsetEmuY === 0, 'portrait side bars');
  // Panoramic (wider than slide) → top/bottom bars.
  assert(panoramic.placement.offsetEmuX === 0 && panoramic.placement.offsetEmuY > 0, 'panoramic t/b bars');
});

test('computePageLayout: rejects zero/negative inputs', () => {
  let threw = false;
  try {
    computePageLayout({ widthPt: 0, heightPt: 100 }, SLIDE_SIZE_16x9_EMU, { targetPxW: 1920 });
  } catch {
    threw = true;
  }
  assert(threw, 'zero width should throw');

  threw = false;
  try {
    computePageLayout(A4_PORTRAIT, { cx: 0, cy: 100 }, { targetPxW: 1920 });
  } catch {
    threw = true;
  }
  assert(threw, 'zero slide cx should throw');

  threw = false;
  try {
    computePageLayout(A4_PORTRAIT, SLIDE_SIZE_16x9_EMU, { targetPxW: 0 });
  } catch {
    threw = true;
  }
  assert(threw, 'zero targetPxW should throw');
});

test('targetPxWFor: 16:9 slide passes long-edge through', () => {
  assert(targetPxWFor(SLIDE_SIZE_16x9_EMU, 1920) === 1920, '16:9 → 1920');
  assert(targetPxWFor(SLIDE_SIZE_4x3_EMU, 1440) === 1440, '4:3 → 1440 (cx > cy)');
});

test('targetPxWFor: rejects non-positive longEdgePx', () => {
  let threw = false;
  try {
    targetPxWFor(SLIDE_SIZE_16x9_EMU, 0);
  } catch {
    threw = true;
  }
  assert(threw, 'zero longEdgePx should throw');
});

test('estimateCanvasBytes: 1920×1080 = 8.3 MB RGBA', () => {
  const layout: PageLayout = {
    imagePxW: 1920,
    imagePxH: 1080,
    renderScale: 1,
    placement: { offsetEmuX: 0, offsetEmuY: 0, imageEmuW: 0, imageEmuH: 0 },
  };
  const bytes = estimateCanvasBytes(layout);
  assert(bytes === 1920 * 1080 * 4, `bytes = ${bytes}`);
});

// ─── runner ───────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok: ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL: ${name}`);
      console.log(`    ${(e as Error).message}`);
    }
  }
  if (failed) {
    console.log(`\n${failed} test(s) failed`);
    process.exit(1);
  } else {
    console.log('all tests passed');
  }
}

run();
