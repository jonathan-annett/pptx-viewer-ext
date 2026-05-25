// Parser smoke test. Runs under plain Node via tsx — no VS Code needed.
//
// We build synthetic in-memory zips that look enough like a .pptx for the
// parser to exercise each code path. This is not a substitute for testing
// against real-world files (real pptx files have quirks), but it catches
// gross regressions in the parsing logic during the build/package cycle.
//
// Run with: npm run test:parse

import { strict as assert } from 'node:assert';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { parsePptx } from '../src/pptx';

type ZipMap = Record<string, Uint8Array>;

function makePptx(files: Record<string, string | Uint8Array>): Uint8Array {
  const zip: ZipMap = {};
  for (const [name, content] of Object.entries(files)) {
    zip[name] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(zip);
}

function slide(show?: '0' | '1'): string {
  const showAttr = show !== undefined ? ` show="${show}"` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"${showAttr}>
  <p:cSld><p:spTree/></p:cSld>
</p:sld>`;
}

function core(creator: string | null, lastMod: string | null): string {
  const c = creator !== null ? `<dc:creator>${creator}</dc:creator>` : '';
  const l = lastMod !== null ? `<cp:lastModifiedBy>${lastMod}</cp:lastModifiedBy>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  ${c}${l}
</cp:coreProperties>`;
}

function presentation(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`;
}

// PowerPoint writes <p:showPr> into ppt/presProps.xml, not presentation.xml.
function presProps(opts: { showPr?: string } = {}): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${opts.showPr ?? ''}</p:presentationPr>`;
}

// p14 extension element form: <p14:showMediaCtrls val="0|1"/> wrapped in <p:extLst>.
function showMediaCtrlsExt(val: '0' | '1'): string {
  return `<p:extLst><p:ext uri="{2FDB2607-1784-4EEB-B798-7EB5836EED8A}"><p14:showMediaCtrls xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="${val}"/></p:ext></p:extLst>`;
}

function rels(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${entries}
</Relationships>`;
}

const info = { fileName: 'fixture.pptx', size: 1234, mtime: 1700000000000 };

// ---- Test 1: Normal — presenter mode, populated metadata ----
async function testNormal() {
  const bytes = makePptx({
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
    </Types>`,
    'docProps/core.xml': core('Alice Author', 'Bob Editor'),
    'ppt/presentation.xml': presentation(),
    'ppt/presProps.xml': presProps({
      showPr: `<p:showPr><p:present/>${showMediaCtrlsExt('0')}</p:showPr>`,
    }),
    'ppt/slides/slide1.xml': slide(),
    'ppt/slides/slide2.xml': slide(),
  });
  const r = await parsePptx(bytes, info);
  assert.equal(r.slideCount, 2, 'slide count');
  assert.equal(r.hiddenSlideCount, 0, 'no hidden slides');
  assert.equal(r.author, 'Alice Author');
  assert.equal(r.lastModifiedBy, 'Bob Editor');
  assert.equal(r.embeddedMedia.length, 0);
  assert.equal(r.flags.linkedMedia.ok, true, 'linked media pass');
  assert.equal(r.flags.showType.ok, true, 'show type pass');
  assert.equal(r.flags.showMediaControls.ok, true, 'media controls pass (val=0)');
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  console.log('  ok: normal');
}

// ---- Test 2: Bad — kiosk mode, showMediaControls, linked external video, hidden slide ----
async function testBad() {
  const bytes = makePptx({
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Override PartName="/ppt/media/video1.mp4" ContentType="video/mp4"/>
      <Override PartName="/ppt/media/video2.mp4" ContentType="video/mp4"/>
      <Override PartName="/ppt/media/audio1.mp3" ContentType="audio/mpeg"/>
    </Types>`,
    'docProps/core.xml': core('Bad Actor', 'Bad Actor'),
    'ppt/presentation.xml': presentation(),
    'ppt/presProps.xml': presProps({
      showPr: `<p:showPr><p:kiosk/>${showMediaCtrlsExt('1')}</p:showPr>`,
    }),
    'ppt/slides/slide1.xml': slide('0'), // hidden
    'ppt/slides/slide2.xml': slide(),
    'ppt/slides/_rels/slide1.xml.rels': rels(
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="https://evil.example.com/clip.mp4" TargetMode="External"/>`,
    ),
  });
  const r = await parsePptx(bytes, info);
  assert.equal(r.slideCount, 2);
  assert.equal(r.hiddenSlideCount, 1, 'one hidden slide');
  assert.deepEqual(
    r.embeddedMedia.map((m) => `${m.mime}:${m.count}`),
    ['audio/mpeg:1', 'video/mp4:2'],
  );
  assert.equal(r.flags.linkedMedia.ok, false, 'linked media warn');
  assert.equal(r.flags.showType.ok, false, 'show type warn');
  assert.match(r.flags.showType.detail, /[Kk]iosk/);
  assert.equal(r.flags.showMediaControls.ok, false, 'media controls warn');
  console.log('  ok: bad');
}

// ---- Test 3: Messy — missing author, no <p:showPr/> at all ----
// PowerPoint's default for showMediaCtrls is true when absent. The
// showMediaControls warn additionally requires embedded video to be present —
// this messy fixture has no media, so controls "on" is harmless and we pass.
async function testMessy() {
  const bytes = makePptx({
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    'docProps/core.xml': core(null, null),
    'ppt/presentation.xml': presentation(),
    'ppt/slides/slide1.xml': slide(),
  });
  const r = await parsePptx(bytes, info);
  assert.equal(r.author, 'unknown');
  assert.equal(r.lastModifiedBy, 'unknown');
  assert.equal(r.flags.showType.ok, true, 'no showPr => presenter pass');
  assert.equal(r.flags.showMediaControls.ok, true, 'no video => controls flag passes regardless of setting');
  assert.match(r.flags.showMediaControls.detail, /no embedded video/i);
  console.log('  ok: messy');
}

// ---- Test 4: Browse mode is also a warn ----
async function testBrowse() {
  const bytes = makePptx({
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    'docProps/core.xml': core('X', 'Y'),
    'ppt/presentation.xml': presentation(),
    'ppt/presProps.xml': presProps({
      showPr: `<p:showPr><p:browse/>${showMediaCtrlsExt('0')}</p:showPr>`,
    }),
    'ppt/slides/slide1.xml': slide(),
  });
  const r = await parsePptx(bytes, info);
  assert.equal(r.flags.showType.ok, false);
  assert.match(r.flags.showType.detail, /[Bb]rowse|[Ww]indow/);
  console.log('  ok: browse');
}

// ---- Test 5: Self-closing <p:showPr/> — no inner setting → ECMA default ON.
// With no embedded video the controls flag still passes (the warn requires both
// controls-on and embedded video). A separate test below covers the warn path.
async function testSelfClosingShowPr() {
  const bytes = makePptx({
    '[Content_Types].xml': `<?xml version="1.0"?><Types/>`,
    'docProps/core.xml': core('A', 'B'),
    'ppt/presentation.xml': presentation(),
    'ppt/presProps.xml': presProps({
      showPr: `<p:showPr/>`,
    }),
    'ppt/slides/slide1.xml': slide(),
  });
  const r = await parsePptx(bytes, info);
  assert.equal(r.flags.showMediaControls.ok, true, 'self-closing showPr + no video → pass');
  assert.match(r.flags.showMediaControls.detail, /no embedded video/i);
  assert.equal(r.flags.showType.ok, true, 'no child => presenter pass');
  console.log('  ok: self-closing showPr');
}

// ---- Test 5c: Controls on AND embedded video — both conditions, warn fires.
async function testControlsOnWithVideo() {
  const bytes = makePptx({
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="mp4" ContentType="video/mp4"/>
    </Types>`,
    'docProps/core.xml': core('A', 'B'),
    'ppt/presentation.xml': presentation(),
    'ppt/presProps.xml': presProps({ showPr: `<p:showPr/>` }), // default ON
    'ppt/slides/slide1.xml': slide(),
    'ppt/media/media1.mp4': new Uint8Array([0, 0, 0, 1]),
  });
  const r = await parsePptx(bytes, info);
  assert.equal(r.flags.showMediaControls.ok, false, 'controls on + embedded video → warn');
  assert.match(r.flags.showMediaControls.detail, /embedded video is present/i);
  console.log('  ok: controls on + video warns');
}

// ---- Test 5d: Controls on but only embedded audio — no warn (audio not gated).
async function testControlsOnWithAudioOnly() {
  const bytes = makePptx({
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="mp3" ContentType="audio/mpeg"/>
    </Types>`,
    'docProps/core.xml': core('A', 'B'),
    'ppt/presentation.xml': presentation(),
    'ppt/presProps.xml': presProps({ showPr: `<p:showPr/>` }), // default ON
    'ppt/slides/slide1.xml': slide(),
    'ppt/media/audio1.mp3': new Uint8Array([0, 0, 0, 1]),
  });
  const r = await parsePptx(bytes, info);
  assert.equal(r.flags.showMediaControls.ok, true, 'controls on + audio only → pass');
  console.log('  ok: controls on + audio only passes');
}

// ---- Test 5b: Default-by-extension media in Content_Types — count per actual zip part.
// PowerPoint writes one <Default Extension="mp4" ContentType="video/mp4"/> for any
// number of mp4 parts. The earlier parser counted ContentType="..." occurrences,
// reporting "video/mp4 × 1" regardless of part count. Two real mp4 parts → 2.
async function testDefaultExtensionMedia() {
  const bytes = makePptx({
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="mp4" ContentType="video/mp4"/>
      <Default Extension="png" ContentType="image/png"/>
    </Types>`,
    'docProps/core.xml': core('A', 'B'),
    'ppt/presentation.xml': presentation(),
    'ppt/slides/slide1.xml': slide(),
    'ppt/media/media1.mp4': new Uint8Array([0, 0, 0, 1]),
    'ppt/media/media2.mp4': new Uint8Array([0, 0, 0, 2]),
    'ppt/media/image1.png': new Uint8Array([0, 0, 0, 3]), // image, must not count
  });
  const r = await parsePptx(bytes, info);
  assert.deepEqual(
    r.embeddedMedia.map((m) => `${m.mime}:${m.count}`),
    ['video/mp4:2'],
    'two mp4 parts with one Default entry → video/mp4 × 2',
  );
  console.log('  ok: default-extension media counts zip parts');
}

// ---- Test 5e: mediaFiles join — single-use, multi-use, orphan media ----
// Exercises the buildMediaFileEntries pass: one mp4 referenced from a single
// slide, one referenced from two slides (reuse), one present in the zip but
// not referenced from any rels file (orphan). Asserts the join is correct
// and the orphan still appears in the output with slides=[].
async function testMediaFilesJoin() {
  const bytes = makePptx({
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="mp4" ContentType="video/mp4"/>
    </Types>`,
    'docProps/core.xml': core('A', 'B'),
    'ppt/presentation.xml': presentation(),
    'ppt/slides/slide1.xml': slide(),
    'ppt/slides/slide2.xml': slide(),
    'ppt/slides/slide3.xml': slide(),
    // single-use: only slide1 refs solo.mp4
    'ppt/slides/_rels/slide1.xml.rels': rels(
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/solo.mp4"/>`,
    ),
    // multi-use: slide2 + slide3 both ref reused.mp4
    'ppt/slides/_rels/slide2.xml.rels': rels(
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/reused.mp4"/>`,
    ),
    'ppt/slides/_rels/slide3.xml.rels': rels(
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/reused.mp4"/>`,
    ),
    // payloads — sizes asserted below to confirm sizeBytes uses inflated length
    'ppt/media/solo.mp4': new Uint8Array(7),
    'ppt/media/reused.mp4': new Uint8Array(13),
    'ppt/media/orphan.mp4': new Uint8Array(5),
  });
  const r = await parsePptx(bytes, info);

  const byPath = Object.fromEntries(r.mediaFiles.map((m) => [m.mediaPath, m]));
  assert.equal(r.mediaFiles.length, 3, 'three media files including orphan');
  assert.deepEqual(byPath['ppt/media/solo.mp4'].slides, [1], 'solo: slide 1');
  assert.deepEqual(byPath['ppt/media/reused.mp4'].slides, [2, 3], 'reused: slides 2, 3 sorted');
  assert.deepEqual(byPath['ppt/media/orphan.mp4'].slides, [], 'orphan: empty slides');
  assert.equal(byPath['ppt/media/solo.mp4'].mime, 'video/mp4');
  assert.equal(byPath['ppt/media/solo.mp4'].sizeBytes, 7, 'sizeBytes = inflated length');
  assert.equal(byPath['ppt/media/reused.mp4'].sizeBytes, 13);
  assert.equal(byPath['ppt/media/orphan.mp4'].sizeBytes, 5);
  console.log('  ok: mediaFiles join (single + reuse + orphan)');
}

// ---- Test 5f: linked external media is NOT joined as a mediaFile ----
// External Targets refer to URLs, not zip parts. The join must skip them so
// they don't pollute the Extract UI with un-extractable rows.
async function testMediaFilesSkipsExternal() {
  const bytes = makePptx({
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="mp4" ContentType="video/mp4"/>
    </Types>`,
    'docProps/core.xml': core('A', 'B'),
    'ppt/presentation.xml': presentation(),
    'ppt/slides/slide1.xml': slide(),
    'ppt/slides/_rels/slide1.xml.rels': rels(
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="https://evil.example.com/clip.mp4" TargetMode="External"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/local.mp4"/>`,
    ),
    'ppt/media/local.mp4': new Uint8Array(3),
  });
  const r = await parsePptx(bytes, info);
  assert.equal(r.mediaFiles.length, 1, 'only the local part is joined');
  assert.equal(r.mediaFiles[0].mediaPath, 'ppt/media/local.mp4');
  assert.deepEqual(r.mediaFiles[0].slides, [1]);
  console.log('  ok: mediaFiles skips external Targets');
}

// ---- Test 6: Internal media rel should NOT trigger linked-media warn ----
async function testInternalMediaIsFine() {
  const bytes = makePptx({
    '[Content_Types].xml': `<?xml version="1.0"?><Types/>`,
    'docProps/core.xml': core('A', 'B'),
    'ppt/presentation.xml': presentation(),
    'ppt/slides/slide1.xml': slide(),
    'ppt/slides/_rels/slide1.xml.rels': rels(
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/video1.mp4"/>`,
    ),
  });
  const r = await parsePptx(bytes, info);
  assert.equal(r.flags.linkedMedia.ok, true, 'internal media is not linked');
  console.log('  ok: internal media is not linked');
}

// ---- Test 7: Garbage bytes — parser fails soft, fields populated as unknown ----
async function testGarbage() {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]); // not a zip
  const r = await parsePptx(bytes, info);
  assert.ok(r.parseError, 'parseError set');
  assert.equal(r.slideCount, 0);
  assert.equal(r.author, 'unknown');
  console.log('  ok: garbage bytes fail soft');
}

// ---- Test 7b: Zero-byte file short-circuits to a clean placeholder result
// (no misleading "Could not unzip" parseError; sha256 is the well-known
// empty digest the placeholder registry treats as the default). ----
async function testZeroByte() {
  const r = await parsePptx(new Uint8Array(0), info);
  assert.equal(
    r.sha256,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'sha256 equals the well-known empty digest',
  );
  assert.equal(r.parseError, undefined, 'no misleading unzip error on a zero-byte file');
  assert.equal(r.slideCount, 0);
  assert.equal(r.hiddenSlideCount, 0);
  assert.deepEqual(r.embeddedMedia, []);
  assert.deepEqual(r.mediaFiles, []);
  assert.equal(r.thumbnail, undefined);
  assert.equal(r.flags.linkedMedia.ok, true);
  assert.equal(r.flags.showType.ok, true);
  assert.equal(r.flags.showMediaControls.ok, true);
  // Display fields still come from the supplied info — filename, size,
  // mtime, sizeHuman, mtimeHuman.
  assert.equal(r.fileName, info.fileName);
  assert.equal(r.size, info.size);
  assert.equal(r.mtime, info.mtime);
  console.log('  ok: zero-byte short-circuit');
}

// ---- Test 8: Thumbnail jpeg is extracted as data URL; emf is skipped ----
async function testThumbnail() {
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const withJpeg = await parsePptx(
    makePptx({
      '[Content_Types].xml': `<?xml version="1.0"?><Types/>`,
      'docProps/core.xml': core('A', 'B'),
      'ppt/presentation.xml': presentation(),
      'ppt/slides/slide1.xml': slide(),
      'docProps/thumbnail.jpeg': jpegBytes,
    }),
    info,
  );
  assert.ok(withJpeg.thumbnail, 'thumbnail extracted');
  assert.equal(withJpeg.thumbnail!.mime, 'image/jpeg');
  assert.match(withJpeg.thumbnail!.dataUrl, /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/);

  const withEmf = await parsePptx(
    makePptx({
      '[Content_Types].xml': `<?xml version="1.0"?><Types/>`,
      'docProps/core.xml': core('A', 'B'),
      'ppt/presentation.xml': presentation(),
      'ppt/slides/slide1.xml': slide(),
      'docProps/thumbnail.emf': new Uint8Array([1, 2, 3, 4]),
    }),
    info,
  );
  assert.equal(withEmf.thumbnail, undefined, 'emf thumbnail is skipped');

  const noThumb = await parsePptx(
    makePptx({
      '[Content_Types].xml': `<?xml version="1.0"?><Types/>`,
      'docProps/core.xml': core('A', 'B'),
      'ppt/presentation.xml': presentation(),
      'ppt/slides/slide1.xml': slide(),
    }),
    info,
  );
  assert.equal(noThumb.thumbnail, undefined, 'no thumbnail entry => undefined');
  console.log('  ok: thumbnail extraction');
}

// ---- Test 9: Real-world samples — exercise the parser against actual PowerPoint output.
// Samples live in samples/ and are checked into the repo. The existsSync guard
// keeps the test conditional in case the dir is ever absent (shallow clone etc.).
async function testRealSamples() {
  const samplesDir = join(__dirname, '..', 'samples');
  if (!existsSync(samplesDir)) {
    console.log('  skip: real samples (samples/ not present)');
    return;
  }
  const cases: Array<{
    file: string;
    showType: 'presenter' | 'browse' | 'kiosk';
    mediaCtrlsOk: boolean;
    embeddedMedia?: string[]; // ["video/mp4:2", ...] — checked only when provided
  }> = [
    // mediaCtrlsOk now requires (controls-on AND embedded-video) to fail.
    // None of the first four samples contain video, so all four pass the
    // controls flag regardless of the underlying setting.
    { file: 'Has media controls.pptx', showType: 'presenter', mediaCtrlsOk: true },
    { file: 'No media controls.pptx',  showType: 'presenter', mediaCtrlsOk: true },
    { file: 'Is kiosk.pptx',           showType: 'kiosk',     mediaCtrlsOk: true },
    { file: 'Is windowed.pptx',        showType: 'browse',    mediaCtrlsOk: true },
    // has media.pptx has 2 embedded mp4s and the default (on) controls setting → warn.
    { file: 'has media.pptx',          showType: 'presenter', mediaCtrlsOk: false, embeddedMedia: ['video/mp4:2'] },
  ];
  for (const c of cases) {
    const path = join(samplesDir, c.file);
    if (!existsSync(path)) {
      console.log(`  skip: ${c.file} not found`);
      continue;
    }
    const bytes = new Uint8Array(readFileSync(path));
    const st = statSync(path);
    const r = await parsePptx(bytes, { fileName: c.file, size: st.size, mtime: st.mtimeMs });
    const expectShowTypeOk = c.showType === 'presenter';
    assert.equal(
      r.flags.showType.ok, expectShowTypeOk,
      `${c.file}: showType.ok expected ${expectShowTypeOk}, got ${r.flags.showType.ok} (detail: ${r.flags.showType.detail})`,
    );
    if (c.showType !== 'presenter') {
      assert.match(r.flags.showType.detail, new RegExp(c.showType, 'i'),
        `${c.file}: showType.detail should mention ${c.showType}`);
    }
    assert.equal(
      r.flags.showMediaControls.ok, c.mediaCtrlsOk,
      `${c.file}: showMediaControls.ok expected ${c.mediaCtrlsOk}, got ${r.flags.showMediaControls.ok} (detail: ${r.flags.showMediaControls.detail})`,
    );
    if (c.embeddedMedia) {
      assert.deepEqual(
        r.embeddedMedia.map((m) => `${m.mime}:${m.count}`),
        c.embeddedMedia,
        `${c.file}: embeddedMedia expected ${JSON.stringify(c.embeddedMedia)}, got ${JSON.stringify(r.embeddedMedia)}`,
      );
    }
    const mediaTag = c.embeddedMedia ? `, media=[${c.embeddedMedia.join(',')}]` : '';
    console.log(`  ok: ${c.file} (showType=${c.showType}, mediaCtrlsOk=${c.mediaCtrlsOk}${mediaTag})`);
  }
}

(async () => {
  console.log('parse.test.ts');
  await testNormal();
  await testBad();
  await testMessy();
  await testBrowse();
  await testSelfClosingShowPr();
  await testControlsOnWithVideo();
  await testControlsOnWithAudioOnly();
  await testDefaultExtensionMedia();
  await testMediaFilesJoin();
  await testMediaFilesSkipsExternal();
  await testInternalMediaIsFine();
  await testGarbage();
  await testZeroByte();
  await testThumbnail();
  await testRealSamples();
  console.log('all tests passed');
})().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
