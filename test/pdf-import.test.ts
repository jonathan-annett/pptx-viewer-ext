// Phase-3 (buildPptxFromImages) smoke tests for the PDF → PPTX pipeline.
//
// We don't exercise PDF.js or HTMLCanvasElement here — those are browser-only
// and live in phases 1+2 of the pipeline. What we do test is the pure packager:
// given an array of pre-encoded images + per-page EMU placements, it produces
// a structurally valid .pptx zip with the right number of slides, the right
// content types, and per-slide placement that matches the placements we passed.
//
// Run with: npm run test:pdf-import

import { strict as assert } from 'node:assert';
import { unzipSync, strFromU8 } from 'fflate';
import {
  buildPptxFromImages,
  SLIDE_SIZE_16x9_EMU,
  SLIDE_SIZE_4x3_EMU,
  EMU_PER_POINT,
  EMU_PER_INCH,
  type EncodedImage,
  type PageEmuPlacement,
} from '../src/pdfImport';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void): void => {
  tests.push([name, fn]);
};

// A 1×1 transparent PNG. The bytes don't need to be real for the packager —
// it just stores them and produces the rels — but using a real PNG header lets
// us sanity-check that the bytes round-trip through fflate unchanged.
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // magic
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, // IDAT
  0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05,
  0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, // IEND
  0xae, 0x42, 0x60, 0x82,
]);

const JPEG_TINY = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // SOI + EOI — small but valid JPEG framing

function img(overrides: Partial<EncodedImage> = {}): EncodedImage {
  return {
    bytes: PNG_1x1,
    sizeBytes: PNG_1x1.byteLength,
    widthPx: 100,
    heightPx: 75,
    widthPt: 100,
    heightPt: 75,
    ...overrides,
  };
}

function stretchPlacement(slide: { cx: number; cy: number }): PageEmuPlacement {
  return { offsetEmuX: 0, offsetEmuY: 0, imageEmuW: slide.cx, imageEmuH: slide.cy };
}

function centredPlacement(slide: { cx: number; cy: number }, w: number, h: number): PageEmuPlacement {
  return {
    offsetEmuX: Math.round((slide.cx - w) / 2),
    offsetEmuY: Math.round((slide.cy - h) / 2),
    imageEmuW: w,
    imageEmuH: h,
  };
}

// ───── Constants sanity ─────────────────────────────────────────────────

test('EMU constants match OOXML reference', () => {
  // 914400 / 72 = 12700 — definitional, but lock the number in so a typo on
  // either constant fails the build.
  assert.equal(EMU_PER_INCH / 72, EMU_PER_POINT);
  assert.equal(EMU_PER_INCH, 914400);
  assert.equal(EMU_PER_POINT, 12700);
});

test('SLIDE_SIZE_16x9_EMU matches PowerPoint widescreen', () => {
  // 13.333" × 7.5" → 12192000 × 6858000 EMU.
  assert.equal(SLIDE_SIZE_16x9_EMU.cx, 12192000);
  assert.equal(SLIDE_SIZE_16x9_EMU.cy, 6858000);
});

test('SLIDE_SIZE_4x3_EMU matches PowerPoint standard', () => {
  assert.equal(SLIDE_SIZE_4x3_EMU.cx, 9144000);
  assert.equal(SLIDE_SIZE_4x3_EMU.cy, 6858000);
});

// ───── buildPptxFromImages: empty/invalid inputs ─────────────────────────

test('buildPptxFromImages: throws on empty pages array', async () => {
  await assert.rejects(
    () =>
      buildPptxFromImages([], {
        format: 'png',
        slideSizeEmu: SLIDE_SIZE_16x9_EMU,
        letterbox: true,
      }),
    /No pages provided/,
  );
});

test('buildPptxFromImages: throws on unsupported format', async () => {
  await assert.rejects(
    () =>
      buildPptxFromImages(
        [{ ...img(), placement: stretchPlacement(SLIDE_SIZE_16x9_EMU) }],
        // @ts-expect-error — testing runtime validation of the union value
        { format: 'tiff', slideSizeEmu: SLIDE_SIZE_16x9_EMU, letterbox: true },
      ),
    /Unsupported format/,
  );
});

// ───── buildPptxFromImages: structural correctness ──────────────────────

test('buildPptxFromImages: produces a valid zip with the OOXML skeleton parts', async () => {
  const bytes = await buildPptxFromImages(
    [{ ...img(), placement: stretchPlacement(SLIDE_SIZE_16x9_EMU) }],
    { format: 'png', slideSizeEmu: SLIDE_SIZE_16x9_EMU, letterbox: false },
  );
  const entries = unzipSync(bytes);
  for (const required of [
    '[Content_Types].xml',
    '_rels/.rels',
    'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels',
    'ppt/theme/theme1.xml',
    'ppt/slideMasters/slideMaster1.xml',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    'ppt/slideLayouts/slideLayout1.xml',
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    'ppt/slides/slide1.xml',
    'ppt/slides/_rels/slide1.xml.rels',
    'ppt/media/image1.png',
  ]) {
    assert.ok(entries[required], `missing required entry: ${required}`);
  }
});

test('buildPptxFromImages: emits one slide + image + rels per input page', async () => {
  const n = 5;
  const pages = Array.from({ length: n }, () => ({
    ...img(),
    placement: stretchPlacement(SLIDE_SIZE_16x9_EMU),
  }));
  const bytes = await buildPptxFromImages(pages, {
    format: 'png',
    slideSizeEmu: SLIDE_SIZE_16x9_EMU,
    letterbox: false,
  });
  const entries = unzipSync(bytes);
  for (let i = 1; i <= n; i++) {
    assert.ok(entries[`ppt/slides/slide${i}.xml`], `slide ${i} present`);
    assert.ok(entries[`ppt/slides/_rels/slide${i}.xml.rels`], `slide ${i} rels present`);
    assert.ok(entries[`ppt/media/image${i}.png`], `image ${i} present`);
  }
  // And no off-by-one extras.
  assert.ok(!entries[`ppt/slides/slide${n + 1}.xml`], 'no extra slide');
  assert.ok(!entries[`ppt/media/image${n + 1}.png`], 'no extra image');
});

test('buildPptxFromImages: image bytes round-trip unchanged', async () => {
  const distinctive = new Uint8Array([
    ...PNG_1x1,
    // Tail bytes that wouldn't survive a re-encode — let us verify the
    // packager stored the bytes verbatim (level: 0 / store-only).
    0xde, 0xad, 0xbe, 0xef,
  ]);
  const bytes = await buildPptxFromImages(
    [
      {
        ...img(),
        bytes: distinctive,
        sizeBytes: distinctive.byteLength,
        placement: stretchPlacement(SLIDE_SIZE_16x9_EMU),
      },
    ],
    { format: 'png', slideSizeEmu: SLIDE_SIZE_16x9_EMU, letterbox: false },
  );
  const entries = unzipSync(bytes);
  const got = entries['ppt/media/image1.png'];
  assert.equal(got.byteLength, distinctive.byteLength, 'length preserved');
  assert.deepEqual(Array.from(got), Array.from(distinctive), 'bytes preserved');
});

// ───── buildPptxFromImages: slide-size + placement geometry ─────────────

test('buildPptxFromImages: <p:sldSz> reflects the chosen slide size', async () => {
  const bytes = await buildPptxFromImages(
    [{ ...img(), placement: stretchPlacement(SLIDE_SIZE_4x3_EMU) }],
    { format: 'png', slideSizeEmu: SLIDE_SIZE_4x3_EMU, letterbox: false },
  );
  const entries = unzipSync(bytes);
  const pres = strFromU8(entries['ppt/presentation.xml']);
  assert.ok(
    pres.includes(`<p:sldSz cx="${SLIDE_SIZE_4x3_EMU.cx}" cy="${SLIDE_SIZE_4x3_EMU.cy}"/>`),
    `sldSz expected ${SLIDE_SIZE_4x3_EMU.cx} × ${SLIDE_SIZE_4x3_EMU.cy}; got <<<${pres}>>>`,
  );
});

test('buildPptxFromImages: per-slide xfrm carries the placement we passed in', async () => {
  // Two pages with deliberately distinct placements — one stretched (fills
  // slide), one letterboxed at a small size centred in the middle.
  const stretched = stretchPlacement(SLIDE_SIZE_16x9_EMU);
  const centred = centredPlacement(SLIDE_SIZE_16x9_EMU, 4_000_000, 3_000_000);
  const bytes = await buildPptxFromImages(
    [
      { ...img(), placement: stretched },
      { ...img(), placement: centred },
    ],
    { format: 'png', slideSizeEmu: SLIDE_SIZE_16x9_EMU, letterbox: true },
  );
  const entries = unzipSync(bytes);
  const slide1 = strFromU8(entries['ppt/slides/slide1.xml']);
  const slide2 = strFromU8(entries['ppt/slides/slide2.xml']);
  // Each slide has TWO <a:off> tags: the dummy group offset at (0,0) and the
  // picture's offset that we set. We grep for the picture-shaped pair (off +
  // ext together) to disambiguate.
  assert.ok(
    slide1.includes(
      `<a:off x="${stretched.offsetEmuX}" y="${stretched.offsetEmuY}"/><a:ext cx="${stretched.imageEmuW}" cy="${stretched.imageEmuH}"/>`,
    ),
    'slide 1 picture placement = stretched',
  );
  assert.ok(
    slide2.includes(
      `<a:off x="${centred.offsetEmuX}" y="${centred.offsetEmuY}"/><a:ext cx="${centred.imageEmuW}" cy="${centred.imageEmuH}"/>`,
    ),
    'slide 2 picture placement = centred',
  );
});

// ───── buildPptxFromImages: content-types + format ──────────────────────

test('buildPptxFromImages: PNG format emits the right Default Extension', async () => {
  const bytes = await buildPptxFromImages(
    [{ ...img(), placement: stretchPlacement(SLIDE_SIZE_16x9_EMU) }],
    { format: 'png', slideSizeEmu: SLIDE_SIZE_16x9_EMU, letterbox: false },
  );
  const ct = strFromU8(unzipSync(bytes)['[Content_Types].xml']);
  assert.ok(ct.includes('<Default Extension="png" ContentType="image/png"/>'), 'png default');
  assert.ok(!ct.includes('image/jpeg'), 'no jpeg default');
});

test('buildPptxFromImages: JPEG format emits image/jpeg and image1.jpeg', async () => {
  const bytes = await buildPptxFromImages(
    [{ ...img({ bytes: JPEG_TINY }), placement: stretchPlacement(SLIDE_SIZE_16x9_EMU) }],
    { format: 'jpeg', slideSizeEmu: SLIDE_SIZE_16x9_EMU, letterbox: false },
  );
  const entries = unzipSync(bytes);
  const ct = strFromU8(entries['[Content_Types].xml']);
  assert.ok(ct.includes('<Default Extension="jpeg" ContentType="image/jpeg"/>'), 'jpeg default');
  assert.ok(entries['ppt/media/image1.jpeg'], 'image1.jpeg entry');
  // The slide rels should target the .jpeg path, not .png.
  const slideRels = strFromU8(entries['ppt/slides/_rels/slide1.xml.rels']);
  assert.ok(slideRels.includes('Target="../media/image1.jpeg"'), 'rels target = .jpeg');
});

test('buildPptxFromImages: presentation rels carry slideMaster + theme + N slides', async () => {
  const n = 3;
  const pages = Array.from({ length: n }, () => ({
    ...img(),
    placement: stretchPlacement(SLIDE_SIZE_16x9_EMU),
  }));
  const bytes = await buildPptxFromImages(pages, {
    format: 'png',
    slideSizeEmu: SLIDE_SIZE_16x9_EMU,
    letterbox: false,
  });
  const rels = strFromU8(unzipSync(bytes)['ppt/_rels/presentation.xml.rels']);
  // slideMaster = rId1, slides = rId2..rId(N+1), theme = rId(N+2).
  assert.ok(rels.includes('Target="slideMasters/slideMaster1.xml"'), 'slideMaster rel');
  for (let i = 1; i <= n; i++) {
    assert.ok(rels.includes(`Target="slides/slide${i}.xml"`), `slide ${i} rel`);
  }
  assert.ok(rels.includes('Target="theme/theme1.xml"'), 'theme rel');
});

test('buildPptxFromImages: writes docProps/thumbnail using first-slide bytes', async () => {
  // Distinctive payload tail so we can prove the thumbnail is the first slide
  // verbatim (not a re-encode and not a different slide).
  const distinctive = new Uint8Array([
    ...PNG_1x1,
    0xfe, 0xed, 0xfa, 0xce,
  ]);
  const pages = [
    {
      ...img(),
      bytes: distinctive,
      sizeBytes: distinctive.byteLength,
      placement: stretchPlacement(SLIDE_SIZE_16x9_EMU),
    },
    { ...img(), placement: stretchPlacement(SLIDE_SIZE_16x9_EMU) },
  ];
  const bytes = await buildPptxFromImages(pages, {
    format: 'png',
    slideSizeEmu: SLIDE_SIZE_16x9_EMU,
    letterbox: false,
  });
  const entries = unzipSync(bytes);
  const thumb = entries['docProps/thumbnail.png'];
  assert.ok(thumb, 'docProps/thumbnail.png present');
  assert.deepEqual(
    Array.from(thumb),
    Array.from(distinctive),
    'thumbnail bytes equal first slide image bytes',
  );
  // Same rels file should advertise the thumbnail so PowerPoint / Finder /
  // Explorer surface the preview through the standard OOXML relationship.
  const topRels = strFromU8(entries['_rels/.rels']);
  assert.ok(
    topRels.includes('Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"'),
    'top-level rels carry thumbnail relationship type',
  );
  assert.ok(
    topRels.includes('Target="docProps/thumbnail.png"'),
    'top-level rels point at docProps/thumbnail.png',
  );
});

test('buildPptxFromImages: thumbnail extension tracks the format (jpeg)', async () => {
  const bytes = await buildPptxFromImages(
    [{ ...img(), placement: stretchPlacement(SLIDE_SIZE_16x9_EMU) }],
    { format: 'jpeg', slideSizeEmu: SLIDE_SIZE_16x9_EMU, letterbox: false },
  );
  const entries = unzipSync(bytes);
  assert.ok(entries['docProps/thumbnail.jpeg'], 'JPEG thumbnail entry present');
  assert.ok(!entries['docProps/thumbnail.png'], 'no PNG thumbnail entry for JPEG build');
  const topRels = strFromU8(entries['_rels/.rels']);
  assert.ok(
    topRels.includes('Target="docProps/thumbnail.jpeg"'),
    'top-level rels point at .jpeg target',
  );
});

test('buildPptxFromImages: <p:sldIdLst> has exactly N <p:sldId> children', async () => {
  const n = 4;
  const pages = Array.from({ length: n }, () => ({
    ...img(),
    placement: stretchPlacement(SLIDE_SIZE_16x9_EMU),
  }));
  const bytes = await buildPptxFromImages(pages, {
    format: 'png',
    slideSizeEmu: SLIDE_SIZE_16x9_EMU,
    letterbox: false,
  });
  const pres = strFromU8(unzipSync(bytes)['ppt/presentation.xml']);
  const matches = pres.match(/<p:sldId\s+id="\d+"\s+r:id="rId\d+"\s*\/>/g) ?? [];
  assert.equal(matches.length, n, `expected ${n} sldId entries, got ${matches.length}`);
});

// ───── run ──────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
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
}

void run();
