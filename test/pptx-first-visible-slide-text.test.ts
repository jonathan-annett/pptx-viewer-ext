// Tests for `extractAllSlideText` + the `firstVisibleSlideText` field on
// ParseResult. Runs under plain Node via tsx — no VS Code needed.
// Run with: npm run test:pptx-first-visible-slide-text
//
// The feature: pptx-search needs all visible text on a deck's first
// non-hidden slide for the search projection. This is broader than
// `extractFirstSlideTitle` (which only grabs the title placeholder) —
// it collects every `<a:t>` run on the slide so body text, text boxes,
// table cells, and grouped shapes are all searchable.

import { strict as assert } from 'node:assert';
import { zipSync, strToU8 } from 'fflate';
import { webcrypto } from 'node:crypto';
import { extractAllSlideText, parsePptx } from '../src/pptx';

// crypto.subtle is needed by parsePptx for sha256; node 18+ exposes
// webcrypto explicitly.
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto?: unknown }).crypto = webcrypto;
}

function wrap(spTreeInner: string): string {
  return `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>${spTreeInner}</p:spTree></p:cSld>
</p:sld>`;
}

function shape(runs: string[], opts: { type?: string } = {}): string {
  const phType = opts.type ? ` type="${opts.type}"` : '';
  const runXml = runs.map((t) => `<a:r><a:t>${t}</a:t></a:r>`).join('');
  return `<p:sp>
    <p:nvSpPr><p:nvPr><p:ph${phType}/></p:nvPr></p:nvSpPr>
    <p:txBody><a:p>${runXml}</a:p></p:txBody>
  </p:sp>`;
}

function hiddenSlide(spTreeInner: string): string {
  return `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" show="0">
  <p:cSld><p:spTree>${spTreeInner}</p:spTree></p:cSld>
</p:sld>`;
}

// ───── extractAllSlideText unit tests ───────────────────────────────────

function test_concatenates_all_runs(): void {
  const xml = wrap(
    shape(['Welcome'], { type: 'title' }) +
      shape(['Bullet one', 'Bullet two'], { type: 'body' }) +
      shape(['Free text box content']),
  );
  const out = extractAllSlideText(strToU8(xml));
  // Order follows source order; runs joined by spaces; whitespace collapsed.
  assert.equal(out, 'Welcome Bullet one Bullet two Free text box content');
  console.log('  ok: concatenates title + body + textbox runs in source order');
}

function test_grouped_shapes_picked_up(): void {
  // grpSp wraps inner sp — our regex pulls <a:t> anywhere in the slide XML,
  // so grouped shapes naturally come through.
  const xml = wrap(
    `<p:grpSp>${shape(['Inside group'])}</p:grpSp>`,
  );
  assert.equal(extractAllSlideText(strToU8(xml)), 'Inside group');
  console.log('  ok: grouped shapes included');
}

function test_table_cells_picked_up(): void {
  // pptx tables wrap each cell's text in standard <a:t>. Same regex catches.
  const xml = wrap(
    `<p:graphicFrame><a:graphic><a:graphicData>
       <a:tbl>
         <a:tr><a:tc><a:txBody><a:p><a:r><a:t>Header A</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>Header B</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
       </a:tbl>
     </a:graphicData></a:graphic></p:graphicFrame>`,
  );
  assert.equal(extractAllSlideText(strToU8(xml)), 'Header A Header B');
  console.log('  ok: table cell text included');
}

function test_decodes_xml_entities(): void {
  const xml = wrap(shape(['Q1 &amp; Q2 review'], { type: 'title' }));
  assert.equal(extractAllSlideText(strToU8(xml)), 'Q1 & Q2 review');
  console.log('  ok: XML entities decoded');
}

function test_empty_slide(): void {
  // No <a:t> runs at all (image-only slide).
  const xml = wrap('<p:pic><p:nvPicPr/></p:pic>');
  assert.equal(extractAllSlideText(strToU8(xml)), '');
  console.log('  ok: image-only slide → empty string');
}

function test_undefined_input(): void {
  assert.equal(extractAllSlideText(undefined), '');
  console.log('  ok: undefined input → empty string');
}

function test_malformed_xml_no_crash(): void {
  const xml = '<p:sld xmlns:p="…"><not-closed';
  assert.doesNotThrow(() => extractAllSlideText(strToU8(xml)));
  assert.equal(extractAllSlideText(strToU8(xml)), '');
  console.log('  ok: malformed XML returns empty without throwing');
}

function test_caps_long_text(): void {
  // Build a slide with one huge run. The cap is 4096 bytes.
  const huge = 'A'.repeat(10_000);
  const xml = wrap(shape([huge], { type: 'body' }));
  const out = extractAllSlideText(strToU8(xml));
  assert.equal(out.length, 4096, 'capped at 4 KB');
  assert.equal(out, 'A'.repeat(4096));
  console.log('  ok: oversized text capped at 4 KB');
}

function test_whitespace_collapsed(): void {
  const xml = wrap(shape(['  line   one\n\n', '\t\tline two'], { type: 'body' }));
  assert.equal(extractAllSlideText(strToU8(xml)), 'line one line two');
  console.log('  ok: whitespace runs collapsed');
}

// ───── parsePptx integration tests ──────────────────────────────────────

function makePptx(files: Record<string, string | Uint8Array>): Uint8Array {
  const zip: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    zip[name] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(zip);
}

const info = { fileName: 'fixture.pptx', size: 1024, mtime: 1700000000000 };

const TYPES_XML = `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`;

const CORE_XML = `<?xml version="1.0"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:creator>Alice</dc:creator>
</cp:coreProperties>`;

const PRES_XML = `<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`;

async function test_parsePptx_uses_first_visible_slide(): Promise<void> {
  // slide1 is hidden, slide2 is the first visible — its text should win.
  const bytes = makePptx({
    '[Content_Types].xml': TYPES_XML,
    'docProps/core.xml': CORE_XML,
    'ppt/presentation.xml': PRES_XML,
    'ppt/slides/slide1.xml': hiddenSlide(shape(['Hidden slide content'])),
    'ppt/slides/slide2.xml': wrap(shape(['Visible second slide'])),
  });
  const r = await parsePptx(bytes, info);
  assert.equal(r.firstVisibleSlideText, 'Visible second slide');
  console.log('  ok: parsePptx picks first non-hidden slide for the field');
}

async function test_parsePptx_no_visible_slides(): Promise<void> {
  const bytes = makePptx({
    '[Content_Types].xml': TYPES_XML,
    'docProps/core.xml': CORE_XML,
    'ppt/presentation.xml': PRES_XML,
    'ppt/slides/slide1.xml': hiddenSlide(shape(['Hidden'])),
  });
  const r = await parsePptx(bytes, info);
  assert.equal(r.firstVisibleSlideText, '', 'empty when no visible slides');
  console.log('  ok: no visible slides → empty string');
}

async function test_parsePptx_no_slides_at_all(): Promise<void> {
  const bytes = makePptx({
    '[Content_Types].xml': TYPES_XML,
    'docProps/core.xml': CORE_XML,
    'ppt/presentation.xml': PRES_XML,
  });
  const r = await parsePptx(bytes, info);
  assert.equal(r.firstVisibleSlideText, '', 'empty when no slides');
  console.log('  ok: no slides at all → empty string');
}

async function test_parsePptx_image_only_first_slide(): Promise<void> {
  const bytes = makePptx({
    '[Content_Types].xml': TYPES_XML,
    'docProps/core.xml': CORE_XML,
    'ppt/presentation.xml': PRES_XML,
    'ppt/slides/slide1.xml': wrap('<p:pic/>'),
  });
  const r = await parsePptx(bytes, info);
  assert.equal(r.firstVisibleSlideText, '');
  console.log('  ok: image-only first visible slide → empty');
}

async function main(): Promise<void> {
  console.log('extractAllSlideText:');
  test_concatenates_all_runs();
  test_grouped_shapes_picked_up();
  test_table_cells_picked_up();
  test_decodes_xml_entities();
  test_empty_slide();
  test_undefined_input();
  test_malformed_xml_no_crash();
  test_caps_long_text();
  test_whitespace_collapsed();
  console.log('parsePptx firstVisibleSlideText:');
  await test_parsePptx_uses_first_visible_slide();
  await test_parsePptx_no_visible_slides();
  await test_parsePptx_no_slides_at_all();
  await test_parsePptx_image_only_first_slide();
  console.log('all firstVisibleSlideText tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
