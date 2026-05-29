// Pure-module tests for src/event/titleSlides/templateInspect.ts.
//
// Driven off the three sample templates in samples/title-templates/.
// Run with: npm run test:title-slides-template-inspect

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectTemplate } from '../src/event/titleSlides/templateInspect';

const SAMPLES = join(__dirname, '..', 'samples', 'title-templates');
const load = (name: string): Uint8Array => new Uint8Array(readFileSync(join(SAMPLES, name)));

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

// ───── slide-role classification across the 3 samples ─────────────────

test('1 deck sample: 1 visible → template only, no walk-in or supplementary', () => {
  const r = inspectTemplate(load('1 deck sample.pptx'));
  assert.equal(r.walkIn, undefined, 'no walk-in for 1-visible');
  assert.equal(r.supplementary.length, 0, 'no supplementary for 1-visible');
  assert.equal(r.template.slideKey, 'ppt/slides/slide2.xml',
    `template should be the visible slide (slide2); got ${r.template.slideKey}`);
  // slide1 + slide3 hidden in source order.
  assert.equal(r.hidden.length, 2, '2 hidden slides preserved as informational');
  assert.equal(r.hidden[0].slideKey, 'ppt/slides/slide1.xml');
  assert.equal(r.hidden[1].slideKey, 'ppt/slides/slide3.xml');
});

test('2 deck sample: 2 visible → walk-in + template', () => {
  const r = inspectTemplate(load('2 deck sample.pptx'));
  assert.ok(r.walkIn, 'walk-in present for 2-visible');
  assert.equal(r.walkIn!.slideKey, 'ppt/slides/slide1.xml', 'walk-in is slide1');
  assert.equal(r.template.slideKey, 'ppt/slides/slide2.xml', 'template is slide2');
  assert.equal(r.supplementary.length, 0, 'no supplementary for 2-visible');
  assert.equal(r.hidden.length, 1, '1 hidden slide preserved');
  assert.equal(r.hidden[0].slideKey, 'ppt/slides/slide3.xml');
});

test('3 slide sample: 3 visible → walk-in + template + supplementary[1]', () => {
  const r = inspectTemplate(load('3 slide sample.pptx'));
  assert.ok(r.walkIn, 'walk-in present for 3+-visible');
  assert.equal(r.walkIn!.slideKey, 'ppt/slides/slide1.xml', 'walk-in is slide1');
  assert.equal(r.template.slideKey, 'ppt/slides/slide2.xml', 'template is slide2');
  assert.equal(r.supplementary.length, 1, '1 supplementary for 3-visible');
  assert.equal(r.supplementary[0].slideKey, 'ppt/slides/slide3.xml');
  assert.equal(r.hidden.length, 0, 'no hidden slides in this sample');
});

// ───── SlideRef shape ──────────────────────────────────────────────────

test('SlideRef carries relsKey alongside slideKey', () => {
  const r = inspectTemplate(load('2 deck sample.pptx'));
  assert.equal(r.template.relsKey, 'ppt/slides/_rels/slide2.xml.rels');
  assert.equal(r.walkIn!.relsKey, 'ppt/slides/_rels/slide1.xml.rels');
});

test('SlideRef.hidden = false for visible slides, true for hidden', () => {
  const r = inspectTemplate(load('1 deck sample.pptx'));
  assert.equal(r.template.hidden, false, 'template is visible');
  assert.equal(r.hidden[0].hidden, true, 'hidden slide flagged');
  assert.equal(r.hidden[1].hidden, true);
});

test('origSldId preserved from <p:sldIdLst>', () => {
  const r = inspectTemplate(load('2 deck sample.pptx'));
  // sample's <p:sldIdLst>: 256, 257, 258
  assert.equal(r.walkIn!.origSldId, 256);
  assert.equal(r.template.origSldId, 257);
  assert.equal(r.hidden[0].origSldId, 258);
});

// ───── text-frame extraction from the template slide ──────────────────

test('2 deck sample: template slide has expected sample text in frames', () => {
  const r = inspectTemplate(load('2 deck sample.pptx'));
  const texts = r.textFrames.map(f => f.sampleText);
  // Sanity check — the known sample content should appear among the frames.
  // (Exact frame count is incidental; we just want to confirm the expected
  // strings are findable, which proves <a:t> extraction works.)
  assert.ok(texts.some(t => t.includes('Widget Confer')),
    `expected "Widget Confer..." in some frame; got ${JSON.stringify(texts)}`);
  assert.ok(texts.includes('First Person'),
    `expected "First Person" as a frame; got ${JSON.stringify(texts)}`);
  assert.ok(texts.includes("Today’s agenda"),
    `expected "Today's agenda" as a frame; got ${JSON.stringify(texts)}`);
});

test('text-frame indices are zero-based and contiguous in document order', () => {
  const r = inspectTemplate(load('2 deck sample.pptx'));
  for (let i = 0; i < r.textFrames.length; i++) {
    assert.equal(r.textFrames[i].index, i,
      `frame at position ${i} should have index ${i}`);
  }
});

test('text frames carry shapeId + shapeName from <p:cNvPr>', () => {
  const r = inspectTemplate(load('2 deck sample.pptx'));
  const firstPerson = r.textFrames.find(f => f.sampleText === 'First Person');
  assert.ok(firstPerson, 'First Person frame found');
  assert.equal(firstPerson!.shapeId, 1502,
    'shape id matches what we saw in M0 inspection');
  assert.ok(firstPerson!.shapeName.includes('1502'),
    `shape name should reference the id; got "${firstPerson!.shapeName}"`);
});

test('text frames carry geometry from <a:xfrm>', () => {
  const r = inspectTemplate(load('2 deck sample.pptx'));
  const firstPerson = r.textFrames.find(f => f.sampleText === 'First Person');
  assert.ok(firstPerson!.geometry, 'geometry present');
  // Values from M0 inspection of the same shape:
  // <a:off x="1040775" y="666250"/> <a:ext cx="7581900" cy="641400"/>
  assert.equal(firstPerson!.geometry!.x, 1040775);
  assert.equal(firstPerson!.geometry!.y, 666250);
  assert.equal(firstPerson!.geometry!.cx, 7581900);
  assert.equal(firstPerson!.geometry!.cy, 641400);
});

test('decorative shapes (no <p:txBody>) are filtered out of textFrames', () => {
  const r = inspectTemplate(load('2 deck sample.pptx'));
  // No frame should have an empty sampleText (decorative shapes filtered).
  // Empty-string frames from "empty <a:t></a:t>" placeholders also get
  // dropped via the lines-empty check in extractTextFrames.
  for (const f of r.textFrames) {
    assert.ok(f.lines.length > 0, `frame ${f.index} should have at least one line`);
  }
});

test('lines array splits multi-paragraph text frames (if any)', () => {
  // The 2 deck sample uses one paragraph per text frame. We just confirm
  // that frames have at least one line and that lines is an array of
  // strings — multi-line behaviour is exercised indirectly by frames
  // that have empty-string entries via trailing endParaRPr (none expected
  // here, but the array contract is the same regardless).
  const r = inspectTemplate(load('2 deck sample.pptx'));
  for (const f of r.textFrames) {
    assert.ok(Array.isArray(f.lines), 'lines is an array');
    assert.ok(f.lines.every(l => typeof l === 'string'), 'lines are strings');
  }
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
