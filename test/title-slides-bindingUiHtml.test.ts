// Smoke tests for src/event/titleSlides/bindingUiHtml.ts.
//
// Pure-module: tests build a synthetic TemplateInspectResult, render the
// panel HTML, and assert that the right hooks, dropdowns, and pre-selected
// values appear in the output. No webview / vscode runtime involved.
//
// Run with: npm run test:title-slides-binding-ui-html

import { strict as assert } from 'node:assert';
import {
  renderBindingPanelHtml,
  renderBody,
  type BindingPanelViewModel,
} from '../src/event/titleSlides/bindingUiHtml';
import type { TemplateInspectResult, SlideRef, TextFrame } from '../src/event/titleSlides/templateInspect';
import type { TitleSlidesBinding } from '../src/event/titleSlides/binding';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

// ───── Helpers ─────────────────────────────────────────────────────────

function slideRef(slideKey: string, sldId: number, hidden = false): SlideRef {
  const dir = slideKey.slice(0, slideKey.lastIndexOf('/'));
  const file = slideKey.slice(slideKey.lastIndexOf('/') + 1);
  return { slideKey, relsKey: `${dir}/_rels/${file}.rels`, origSldId: sldId, hidden };
}

function frame(index: number, shapeId: number, sampleText: string, lines?: string[]): TextFrame {
  return {
    index,
    shapeId,
    shapeName: `Shape ${shapeId}`,
    geometry: { x: 0, y: 0, cx: 1000, cy: 500 },
    lines: lines ?? [sampleText],
    sampleText,
  };
}

function vm(inspection: TemplateInspectResult, existing?: TitleSlidesBinding): BindingPanelViewModel {
  return { templatePath: 'templates/my.pptx', inspection, existing };
}

function twoDeckInspection(): TemplateInspectResult {
  return {
    walkIn: slideRef('ppt/slides/slide1.xml', 256),
    template: slideRef('ppt/slides/slide2.xml', 257),
    supplementary: [],
    hidden: [slideRef('ppt/slides/slide3.xml', 258, true)],
    textFrames: [
      frame(0, 1493, 'The Widget Confernece 2026'),
      frame(1, 1494, 'Q1 / Month'),
      frame(2, 1502, 'First Person'),
    ],
  };
}

// ───── Top-level HTML envelope + CSP ──────────────────────────────────

test('renderBindingPanelHtml emits valid HTML envelope + CSP with nonce', () => {
  const html = renderBindingPanelHtml(vm(twoDeckInspection()), 'NONCE123');
  assert.ok(html.startsWith('<!doctype html>'), 'starts with doctype');
  assert.ok(html.includes('<meta http-equiv="Content-Security-Policy"'),
    'CSP meta tag present');
  assert.ok(html.includes("script-src 'nonce-NONCE123'"),
    'nonce threaded into CSP');
  assert.ok(html.includes(`nonce="NONCE123"`),
    'nonce on script tag(s)');
  // No unsafe-inline scripts.
  assert.ok(!html.includes("script-src 'unsafe-inline"),
    'no unsafe-inline script directive');
});

test('Init JSON script tag carries inspection + templatePath + existing', () => {
  const existing: TitleSlidesBinding = {
    templatePath: 'templates/my.pptx',
    fields: [{ role: 'speaker', frame: 2, position: 1 }],
    distributeEvenly: true,
  };
  const html = renderBindingPanelHtml(vm(twoDeckInspection(), existing), 'n');
  const match = html.match(/<script[^>]*id="binding-init"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, 'init script tag present');
  const payload = JSON.parse(match![1]);
  assert.equal(payload.templatePath, 'templates/my.pptx');
  assert.ok(payload.inspection.textFrames.length === 3);
  assert.equal(payload.existing.fields[0].role, 'speaker');
});

// ───── Slide-role detection messaging ──────────────────────────────────

test('1 visible (template only) renders correct detected message', () => {
  const inspection: TemplateInspectResult = {
    walkIn: undefined,
    template: slideRef('ppt/slides/slide2.xml', 257),
    supplementary: [],
    hidden: [slideRef('ppt/slides/slide1.xml', 256, true)],
    textFrames: [frame(0, 100, 'X')],
  };
  const html = renderBody(vm(inspection));
  assert.ok(html.includes('1 visible slide'), 'singular slide count');
  // The tips section mentions Walk-in cosmetically; check the role list
  // explicitly — no walk-in *role row*.
  assert.ok(!html.includes('Walk-in (copied verbatim'),
    'no walk-in role line in the slide-roles list');
  assert.ok(html.includes('1 hidden'), 'hidden count surfaced');
});

test('2 visible (walk-in + template) renders both roles', () => {
  const html = renderBody(vm(twoDeckInspection()));
  assert.ok(html.includes('2 visible slides'));
  assert.ok(html.includes('Walk-in'), 'walk-in role line present');
  assert.ok(html.includes('Template'), 'template role line present');
});

test('3+ visible (walk-in + template + supplementary) renders all roles', () => {
  const inspection: TemplateInspectResult = {
    walkIn: slideRef('ppt/slides/slide1.xml', 256),
    template: slideRef('ppt/slides/slide2.xml', 257),
    supplementary: [
      slideRef('ppt/slides/slide3.xml', 258),
      slideRef('ppt/slides/slide4.xml', 259),
    ],
    hidden: [],
    textFrames: [frame(0, 100, 'X')],
  };
  const html = renderBody(vm(inspection));
  // walk-in + template + 2 supplementary = 4 visible
  assert.ok(html.includes('4 visible slides'));
  assert.ok(html.includes('Walk-in (copied verbatim'),
    'walk-in role line present');
  assert.ok(html.includes('<strong>Template</strong>'),
    'template role line present');
  assert.ok(html.includes('2 supplementary slides'),
    'plural supplementary count surfaced');
});

// ───── Frame list rendering ────────────────────────────────────────────

test('Each text frame gets a row with index, sample text, and role dropdown', () => {
  const html = renderBody(vm(twoDeckInspection()));
  // 3 frames → 3 select elements
  const selects = [...html.matchAll(/<select[^>]*data-frame-role="(\d+)"/g)];
  assert.equal(selects.length, 3, '3 dropdowns for 3 frames');
  assert.deepEqual(selects.map(m => Number(m[1])), [0, 1, 2]);
  // Sample text appears
  assert.ok(html.includes('The Widget Confernece 2026'));
  assert.ok(html.includes('First Person'));
});

test('Existing binding pre-selects matching role on each dropdown', () => {
  const existing: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [
      { role: 'roomName', frame: 0 },
      { role: 'day', frame: 1 },
      { role: 'speaker', frame: 2, position: 1 },
    ],
  };
  const html = renderBody(vm(twoDeckInspection(), existing));
  // Each select has 'selected' on the bound option.
  assert.ok(/<select[^>]*data-frame-role="0"[\s\S]*?<option value="roomName" selected>/.test(html),
    'frame 0 → roomName selected');
  assert.ok(/<select[^>]*data-frame-role="1"[\s\S]*?<option value="day" selected>/.test(html),
    'frame 1 → day selected');
  // Speaker bindings now use `speaker:N` encoding so the position round-trips.
  assert.ok(/<select[^>]*data-frame-role="2"[\s\S]*?<option value="speaker:1" selected>/.test(html),
    'frame 2 → Speaker 1 selected');
});

test('Speaker positions surface as Speaker 1 / 2 / 3 in the order the user assigned', () => {
  // Three frames bound to speakers with explicit positions 2, 1, 3 (out of
  // document order). The UI should render each frame with its true
  // position-N selected so the binding round-trips cleanly.
  const existing: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [
      { role: 'speaker', frame: 0, position: 2 },
      { role: 'speaker', frame: 1, position: 1 },
      { role: 'speaker', frame: 2, position: 3 },
    ],
  };
  const html = renderBody(vm(twoDeckInspection(), existing));
  assert.ok(/<select[^>]*data-frame-role="0"[\s\S]*?<option value="speaker:2" selected>/.test(html));
  assert.ok(/<select[^>]*data-frame-role="1"[\s\S]*?<option value="speaker:1" selected>/.test(html));
  assert.ok(/<select[^>]*data-frame-role="2"[\s\S]*?<option value="speaker:3" selected>/.test(html));
});

test('Dropdown emits Speaker 1..N options (N up to MAX_SPEAKER_OPTIONS)', () => {
  const html = renderBody(vm(twoDeckInspection()));
  // At least Speaker 1 through Speaker 10 emitted as options in each select.
  const firstSelect = html.match(/<select[^>]*data-frame-role="0"[\s\S]*?<\/select>/)![0];
  for (let n = 1; n <= 10; n++) {
    assert.ok(firstSelect.includes(`value="speaker:${n}"`),
      `Speaker ${n} option present`);
    assert.ok(firstSelect.includes(`>Speaker ${n}<`),
      `Speaker ${n} label rendered`);
  }
});

test('No existing binding → all dropdowns default to unbound', () => {
  const html = renderBody(vm(twoDeckInspection()));
  // All 3 selects should have `unbound` selected.
  const selects = html.match(/<select[^>]*data-frame-role="\d+"[\s\S]*?<\/select>/g) ?? [];
  assert.equal(selects.length, 3);
  for (const sel of selects) {
    assert.ok(/<option value="unbound" selected>/.test(sel),
      `unbound selected by default in ${sel.slice(0, 100)}…`);
  }
});

test('Multi-line frame gets a "first line only" note', () => {
  const inspection: TemplateInspectResult = {
    walkIn: undefined,
    template: slideRef('ppt/slides/slide1.xml', 256),
    supplementary: [],
    hidden: [],
    textFrames: [
      frame(0, 100, 'A\nB\nC\nD', ['A', 'B', 'C', 'D']),
    ],
  };
  const html = renderBody(vm(inspection));
  assert.ok(html.includes('4 lines'),
    'frame with 4 paragraphs surfaces the line count');
  assert.ok(html.includes('first line only in v1'),
    'multi-line scope-limitation note present');
});

test('Empty textFrames list shows a helpful empty state', () => {
  const inspection: TemplateInspectResult = {
    walkIn: undefined,
    template: slideRef('ppt/slides/slide1.xml', 256),
    supplementary: [],
    hidden: [],
    textFrames: [],
  };
  const html = renderBody(vm(inspection));
  assert.ok(html.includes('No text-bearing shapes'),
    'empty state message present');
  assert.ok(!html.includes('<select'),
    'no dropdowns when there are no frames');
});

// ───── distributeEvenly checkbox ───────────────────────────────────────

test('distributeEvenly checkbox unchecked when binding omits it / false', () => {
  const html = renderBody(vm(twoDeckInspection()));
  const cb = html.match(/<input[^>]*id="bind-distribute-evenly"[^>]*>/);
  assert.ok(cb);
  assert.ok(!cb![0].includes('checked'),
    `checkbox should not be checked by default; got ${cb![0]}`);
});

test('distributeEvenly checkbox checked when existing binding has it true', () => {
  const existing: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: 2, position: 1 }],
    distributeEvenly: true,
  };
  const html = renderBody(vm(twoDeckInspection(), existing));
  const cb = html.match(/<input[^>]*id="bind-distribute-evenly"[^>]*>/);
  assert.ok(cb);
  assert.ok(cb![0].includes('checked'),
    `checkbox should be checked; got ${cb![0]}`);
});

// ───── Action buttons ──────────────────────────────────────────────────

test('Save, Reset, Cancel, Change-template buttons present with stable IDs', () => {
  const html = renderBody(vm(twoDeckInspection()));
  for (const id of ['bind-save-btn', 'bind-reset-btn', 'bind-cancel-btn', 'bind-change-template-btn']) {
    assert.ok(html.includes(`id="${id}"`), `button #${id} present`);
  }
});

// ───── HTML escaping ───────────────────────────────────────────────────

test('Sample text with < > & " is HTML-escaped in the frame row', () => {
  const inspection: TemplateInspectResult = {
    walkIn: undefined,
    template: slideRef('ppt/slides/slide1.xml', 256),
    supplementary: [],
    hidden: [],
    textFrames: [frame(0, 100, '<script>alert("x")</script>')],
  };
  const html = renderBody(vm(inspection));
  assert.ok(!html.includes('<script>alert'),
    'raw script tag not present');
  assert.ok(html.includes('&lt;script&gt;'),
    'angle brackets escaped');
});

test('Template path with HTML special chars is escaped in header', () => {
  const inspection = twoDeckInspection();
  const html = renderBody({ templatePath: 'foo/<bar>.pptx', inspection });
  assert.ok(html.includes('foo/&lt;bar&gt;.pptx'),
    'template path escaped in display');
});

// ───── Script-tag JSON safety ──────────────────────────────────────────

test('Sample text containing </script blocks does NOT break the init JSON', () => {
  // Embedded JSON inside a <script type="application/json"> tag — naive
  // serialisation would let a </script in the data close the script
  // prematurely. The renderer escapes the slash.
  const inspection: TemplateInspectResult = {
    walkIn: undefined,
    template: slideRef('ppt/slides/slide1.xml', 256),
    supplementary: [],
    hidden: [],
    textFrames: [frame(0, 100, 'see </script> here')],
  };
  const html = renderBindingPanelHtml(vm(inspection), 'n');
  const match = html.match(/<script[^>]*id="binding-init"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, 'init script tag still closes correctly');
  // The escape should make it parse cleanly.
  const payload = JSON.parse(match![1]);
  assert.equal(payload.inspection.textFrames[0].sampleText, 'see </script> here',
    'round-trip preserves the original text after un-escaping');
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
