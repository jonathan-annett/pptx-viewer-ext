// Parser smoke test. Runs under plain Node via tsx — no VS Code needed.
//
// We build synthetic in-memory zips that look enough like a .pptx for the
// parser to exercise each code path. This is not a substitute for testing
// against real-world files (real pptx files have quirks), but it catches
// gross regressions in the parsing logic during the build/package cycle.
//
// Run with: npm run test:parse

import { strict as assert } from 'node:assert';
import { zipSync, strToU8 } from 'fflate';
import { parsePptx } from '../src/pptx';

type ZipMap = Record<string, Uint8Array>;

function makePptx(files: Record<string, string>): Uint8Array {
  const zip: ZipMap = {};
  for (const [name, content] of Object.entries(files)) {
    zip[name] = strToU8(content);
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

function presentation(opts: { showPr?: string } = {}): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  ${opts.showPr ?? ''}
</p:presentation>`;
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
  assert.equal(r.flags.showMediaControls.ok, true, 'media controls pass');
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
    'ppt/presentation.xml': presentation({
      showPr: `<p:showPr showMediaControls="1"><p:kiosk/></p:showPr>`,
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
  assert.equal(r.flags.showMediaControls.ok, true, 'no showPr => controls pass');
  console.log('  ok: messy');
}

// ---- Test 4: Browse mode is also a warn ----
async function testBrowse() {
  const bytes = makePptx({
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    'docProps/core.xml': core('X', 'Y'),
    'ppt/presentation.xml': presentation({
      showPr: `<p:showPr><p:browse/></p:showPr>`,
    }),
    'ppt/slides/slide1.xml': slide(),
  });
  const r = await parsePptx(bytes, info);
  assert.equal(r.flags.showType.ok, false);
  assert.match(r.flags.showType.detail, /[Bb]rowse|[Ww]indow/);
  console.log('  ok: browse');
}

// ---- Test 5: Self-closing <p:showPr/> with showMediaControls ----
async function testSelfClosingShowPr() {
  const bytes = makePptx({
    '[Content_Types].xml': `<?xml version="1.0"?><Types/>`,
    'docProps/core.xml': core('A', 'B'),
    'ppt/presentation.xml': presentation({
      showPr: `<p:showPr showMediaControls="true"/>`,
    }),
    'ppt/slides/slide1.xml': slide(),
  });
  const r = await parsePptx(bytes, info);
  assert.equal(r.flags.showMediaControls.ok, false, 'self-closing with controls=true');
  assert.equal(r.flags.showType.ok, true, 'no child => presenter pass');
  console.log('  ok: self-closing showPr');
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

(async () => {
  console.log('parse.test.ts');
  await testNormal();
  await testBad();
  await testMessy();
  await testBrowse();
  await testSelfClosingShowPr();
  await testInternalMediaIsFine();
  await testGarbage();
  console.log('all tests passed');
})().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
