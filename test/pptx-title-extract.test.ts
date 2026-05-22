// Pure tests for extractFirstSlideTitle from src/pptx.ts.
//
// Runs under plain Node via tsx — no VS Code, no browser context needed.
// Run with: npm run test:pptx-title-extract
//
// extractFirstSlideTitle backs the M-VE-3 synthesised-thumbnail path: when
// a pptx has no usable in-file thumbnail, the parser surfaces the slide-1
// title to the webview so the canvas fallback can render real text rather
// than just the filename.

import { strict as assert } from 'node:assert';
import { strToU8 } from 'fflate';
import { extractFirstSlideTitle } from '../src/pptx';

function entries(slide1Xml: string | null): Record<string, Uint8Array> {
  const e: Record<string, Uint8Array> = {};
  if (slide1Xml !== null) e['ppt/slides/slide1.xml'] = strToU8(slide1Xml);
  return e;
}

function titleShape(text: string, type: 'title' | 'ctrTitle' = 'title'): string {
  return `<p:sp>
    <p:nvSpPr>
      <p:cNvPr id="2" name="Title 1"/>
      <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
      <p:nvPr><p:ph type="${type}"/></p:nvPr>
    </p:nvSpPr>
    <p:spPr/>
    <p:txBody>
      <a:bodyPr/>
      <a:lstStyle/>
      <a:p>
        <a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r>
      </a:p>
    </p:txBody>
  </p:sp>`;
}

function bodyShape(text: string): string {
  return `<p:sp>
    <p:nvSpPr>
      <p:cNvPr id="3" name="Content"/>
      <p:nvPr><p:ph type="body" idx="1"/></p:nvPr>
    </p:nvSpPr>
    <p:txBody>
      <a:p><a:r><a:t>${text}</a:t></a:r></a:p>
    </p:txBody>
  </p:sp>`;
}

function multiRunTitleShape(runs: string[]): string {
  const runXml = runs.map((t) => `<a:r><a:t>${t}</a:t></a:r>`).join('');
  return `<p:sp>
    <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
    <p:txBody><a:p>${runXml}</a:p></p:txBody>
  </p:sp>`;
}

function wrap(spXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>${spXml}</p:spTree></p:cSld>
</p:sld>`;
}

function test_title_type(): void {
  const e = entries(wrap(titleShape('My Presentation', 'title')));
  assert.equal(extractFirstSlideTitle(e), 'My Presentation');
  console.log('  ok: type="title" returns the title text');
}

function test_ctrtitle_type(): void {
  const e = entries(wrap(titleShape('Welcome', 'ctrTitle')));
  assert.equal(extractFirstSlideTitle(e), 'Welcome');
  console.log('  ok: type="ctrTitle" also recognised');
}

function test_missing_title_shape(): void {
  // Only a body placeholder — should return undefined.
  const e = entries(wrap(bodyShape('Just body content')));
  assert.equal(extractFirstSlideTitle(e), undefined);
  console.log('  ok: missing title shape → undefined');
}

function test_no_slide_file(): void {
  // No ppt/slides/slide1.xml at all.
  const e = entries(null);
  assert.equal(extractFirstSlideTitle(e), undefined);
  console.log('  ok: no slide1.xml → undefined');
}

function test_multiple_runs_joined(): void {
  const e = entries(wrap(multiRunTitleShape(['Hello ', 'world', '!'])));
  // Runs are joined with spaces, then collapsed: "Hello   world !" → "Hello world !"
  // Trailing space inside a run survives the join + collapse on the boundary.
  assert.equal(extractFirstSlideTitle(e), 'Hello world !');
  console.log('  ok: multiple <a:t> runs are joined');
}

function test_empty_title_text(): void {
  const e = entries(wrap(titleShape('   ')));
  // Whitespace-only title collapses to empty → undefined.
  assert.equal(extractFirstSlideTitle(e), undefined);
  console.log('  ok: whitespace-only title → undefined');
}

function test_decode_entities(): void {
  const e = entries(wrap(titleShape('Q1 &amp; Q2 review')));
  assert.equal(extractFirstSlideTitle(e), 'Q1 & Q2 review');
  console.log('  ok: XML entities are decoded');
}

function test_long_title_truncated(): void {
  const long = 'A'.repeat(200);
  const e = entries(wrap(titleShape(long)));
  const out = extractFirstSlideTitle(e);
  assert.ok(out && out.length === 120, 'title capped at 120 chars');
  console.log('  ok: long title capped at 120 chars');
}

function test_malformed_xml_no_crash(): void {
  // Truncated / garbage tag — regex just doesn't match. Must not throw.
  const e = entries('<p:sld xmlns:p="…"><not-closed');
  assert.doesNotThrow(() => extractFirstSlideTitle(e));
  assert.equal(extractFirstSlideTitle(e), undefined);
  console.log('  ok: malformed XML returns undefined without throwing');
}

function test_title_picked_before_body(): void {
  // Body shape declared first in the XML, title shape second — the function
  // walks shapes in order but filters by type, so the title still wins.
  const e = entries(wrap(bodyShape('Body first') + titleShape('Real Title')));
  assert.equal(extractFirstSlideTitle(e), 'Real Title');
  console.log('  ok: title shape chosen regardless of source order');
}

async function main(): Promise<void> {
  console.log('extractFirstSlideTitle:');
  test_title_type();
  test_ctrtitle_type();
  test_missing_title_shape();
  test_no_slide_file();
  test_multiple_runs_joined();
  test_empty_title_text();
  test_decode_entities();
  test_long_title_truncated();
  test_malformed_xml_no_crash();
  test_title_picked_before_body();
  console.log('all extractFirstSlideTitle tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
