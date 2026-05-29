// Pure-module tests for src/event/titleSlides/pptxBuild.ts.
//
// Builds decks from sample templates + synthetic session data, then
// round-trips through fflate and asserts on the output structure.
//
// Run with: npm run test:title-slides-pptx-build

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { inspectTemplate, type TextFrame } from '../src/event/titleSlides/templateInspect';
import { buildTitleDeck, titleDeckHyperlinkTarget, type DeckBuildInput } from '../src/event/titleSlides/pptxBuild';
import { splitSpeakers } from '../src/event/titleSlides/pagination';
import type { TitleSlidesBinding } from '../src/event/titleSlides/binding';
import type { EventSession, SessionSpeakerSlot } from '../src/event/schedule';

const SAMPLES = join(__dirname, '..', 'samples', 'title-templates');
const load = (name: string): Uint8Array => new Uint8Array(readFileSync(join(SAMPLES, name)));

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

// ───── Helpers ─────────────────────────────────────────────────────────

function frameIdx(frames: TextFrame[], sampleText: string): number {
  const f = frames.find(f => f.sampleText === sampleText);
  if (!f) throw new Error(`No frame with sample text ${JSON.stringify(sampleText)}`);
  return f.index;
}

function makeSession(opts: {
  day: string;
  timeslot: string;
  roomId: string;
  speakers: SessionSpeakerSlot[];
}): EventSession {
  return {
    id: `${opts.day}-${opts.timeslot}-${opts.roomId}`,
    day: opts.day,
    timeslot: opts.timeslot,
    roomId: opts.roomId,
    kind: 'breakout',
    relocatedFromRoomId: null,
    speakers: opts.speakers,
  };
}

function makeSpeakers(names: string[]): SessionSpeakerSlot[] {
  return names.map((n, i) => ({
    slot: i + 1,
    speakerId: `spk-${i + 1}`,
    speakerName: n,
  }));
}

function getSlidePaths(zip: Record<string, Uint8Array>): string[] {
  return Object.keys(zip)
    .filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)/)![1]);
      const nb = Number(b.match(/slide(\d+)/)![1]);
      return na - nb;
    });
}

function slideText(zip: Record<string, Uint8Array>, slideKey: string): string[] {
  const xml = strFromU8(zip[slideKey]);
  return [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]);
}

// ───── titleDeckHyperlinkTarget (pure helper) ─────────────────────────

test('titleDeckHyperlinkTarget composes <timeslot>/<placeholder-filename>', () => {
  const session = makeSession({
    day: 'MON',
    timeslot: 'A',
    roomId: 'room-1',
    speakers: makeSpeakers(['John Smith']),
  });
  const target = titleDeckHyperlinkTarget(session, session.speakers[0]);
  // sessionSpeakerFilename: "MON ROOM1 A 1 John Smith.pptx"  (roomFilenameToken
  // = uppercased, hyphens stripped)
  assert.equal(target, 'A/MON ROOM1 A 1 John Smith.pptx');
});

test('titleDeckHyperlinkTarget respects custom extension', () => {
  const session = makeSession({
    day: 'TUE',
    timeslot: 'B',
    roomId: 'breakout-2',
    speakers: makeSpeakers(['Jane']),
  });
  const target = titleDeckHyperlinkTarget(session, session.speakers[0], '.key');
  assert.equal(target, 'B/TUE BREAKOUT2 B 1 Jane.key');
});

// ───── 2 deck sample: 1 session, single-speaker binding ────────────────

test('2 deck sample: walk-in + 1 session slide; substitutes speaker name', () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');

  const binding: TitleSlidesBinding = {
    templatePath: '2 deck sample.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John Smith']),
  });
  const out = buildTitleDeck({
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'Welcome',
      timeslot: session.timeslot,
      speakerPages: splitSpeakers(session.speakers, 1, false),
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  });
  const zip = unzipSync(out.bytes);
  const slides = getSlidePaths(zip);
  assert.equal(slides.length, 2, '2 slides: walk-in + 1 session page');
  // slide2 is the session clone; speaker name substituted.
  assert.ok(slideText(zip, 'ppt/slides/slide2.xml').includes('John Smith'),
    'speaker name present in session slide');
  // slide1 is the walk-in (original first paragraph).
  assert.ok(slideText(zip, 'ppt/slides/slide1.xml').includes('Topic for live discussion'),
    'walk-in slide text preserved verbatim');
  assert.equal(out.warnings.length, 0, 'no warnings for single-frame speaker');
});

test('2 deck sample: hyperlink rels added on session slides', () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John Smith']),
  });
  const out = buildTitleDeck({
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'Welcome', timeslot: 'A',
      speakerPages: splitSpeakers(session.speakers, 1, false),
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  });
  const zip = unzipSync(out.bytes);
  const rels = strFromU8(zip['ppt/slides/_rels/slide2.xml.rels']);
  assert.ok(rels.includes('hyperlink'), 'session slide rels contain hyperlink');
  assert.ok(rels.includes('A/MON ROOM1 A 1 John Smith.pptx'),
    `hyperlink target follows convention; rels = ${rels}`);
  assert.ok(rels.includes('TargetMode="External"'), 'external link mode set');
});

test('2 deck sample: shape-attached hyperlink lands on <p:cNvPr>', () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const frame = inspection.textFrames[speakerFrame];
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John Smith']),
  });
  const out = buildTitleDeck({
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(session.speakers, 1, false),
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  });
  const zip = unzipSync(out.bytes);
  const slide = strFromU8(zip['ppt/slides/slide2.xml']);
  // M0.4c pattern: <p:cNvPr id="1502" name="..."><a:hlinkClick r:id="..."/></p:cNvPr>
  const pattern = new RegExp(
    `<p:cNvPr id="${frame.shapeId}"[^>]*><a:hlinkClick r:id="[^"]+"/></p:cNvPr>`,
  );
  assert.ok(pattern.test(slide),
    `expected shape-attached hyperlink on shape ${frame.shapeId}`);
});

// ───── pagination integration: 5 speakers, capacity 1, fill mode ───────

test('5 speakers @ capacity 1 produces 5 session slides + walk-in = 6 total', () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame }],
  };
  const speakers = makeSpeakers(['A', 'B', 'C', 'D', 'E']);
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1', speakers,
  });
  const out = buildTitleDeck({
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(speakers, 1, false),   // [['A'], ['B'], ['C'], ['D'], ['E']]
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  });
  const zip = unzipSync(out.bytes);
  const slides = getSlidePaths(zip);
  assert.equal(slides.length, 6, '1 walk-in + 5 session pages');
  // Each session slide has a different speaker name.
  for (let i = 0; i < 5; i++) {
    const name = String.fromCharCode(65 + i);   // 'A', 'B', ...
    assert.ok(slideText(zip, `ppt/slides/slide${i + 2}.xml`).includes(name),
      `slide${i + 2} should contain "${name}"`);
  }
});

// ───── 3 slide sample: supplementary preserved at end ──────────────────

test('3 slide sample: supplementary slide appended after session slides', () => {
  const tpl = load('3 slide sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John']),
  });
  const out = buildTitleDeck({
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(session.speakers, 1, false),
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  });
  const zip = unzipSync(out.bytes);
  const slides = getSlidePaths(zip);
  assert.equal(slides.length, 3,
    '1 walk-in + 1 session page + 1 supplementary');
  // Supplementary lands at slide3 — contains its known text "Add a title".
  assert.ok(slideText(zip, 'ppt/slides/slide3.xml').some(t => t.includes('Add a title')),
    'supplementary slide preserved at end');
});

// ───── 1 deck sample: no walk-in, no supplementary ─────────────────────

test('1 deck sample: no walk-in; 1 session = 1 slide total', () => {
  const tpl = load('1 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John']),
  });
  const out = buildTitleDeck({
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(session.speakers, 1, false),
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  });
  const zip = unzipSync(out.bytes);
  assert.equal(getSlidePaths(zip).length, 1,
    '1 session page only — no walk-in, no supplementary');
});

// ───── multi-field binding: sessionTitle + roomName + speaker ──────────

test('Multi-field binding substitutes all roles', () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const titleFrame = frameIdx(inspection.textFrames, "Today’s agenda");
  const roomFrame = frameIdx(inspection.textFrames, 'The Widget Confernece 2026');
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [
      { role: 'sessionTitle', frame: titleFrame },
      { role: 'roomName', frame: roomFrame },
      { role: 'speaker', frame: speakerFrame },
    ],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'breakout-1',
    speakers: makeSpeakers(['Jane Doe']),
  });
  const out = buildTitleDeck({
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'Opening Keynote', timeslot: 'A',
      speakerPages: splitSpeakers(session.speakers, 1, false),
      session,
    }],
    day: 'MON', roomName: 'Main Hall',
  });
  const zip = unzipSync(out.bytes);
  const texts = slideText(zip, 'ppt/slides/slide2.xml');
  assert.ok(texts.includes('Opening Keynote'), `sessionTitle substituted; got ${JSON.stringify(texts)}`);
  assert.ok(texts.includes('Main Hall'), 'roomName substituted');
  assert.ok(texts.includes('Jane Doe'), 'speaker substituted');
});

// ───── scaffolding rebuilt correctly ───────────────────────────────────

test('Content_Types has Override for each output slide; no orphan notes', () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John', 'Jane']),
  });
  const out = buildTitleDeck({
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(session.speakers, 1, false),
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  });
  const zip = unzipSync(out.bytes);
  const ct = strFromU8(zip['[Content_Types].xml']);
  // 1 walk-in + 2 sessions = 3 slides.
  for (const n of [1, 2, 3]) {
    assert.ok(
      ct.includes(`PartName="/ppt/slides/slide${n}.xml"`),
      `Content_Types has slide${n} Override`,
    );
  }
  // notesSlide overrides except notesSlide1 (the walk-in's note) should be dropped.
  // Actually our impl drops ALL notesSlide overrides. The walk-in's notesSlide
  // file is also dropped (we strip notes from all output rels).
  assert.ok(!ct.includes('notesSlide2'),
    'no orphan notesSlide2 override');
  assert.ok(!ct.includes('notesSlide3'),
    'no orphan notesSlide3 override');
});

test('presentation.xml sldIdLst rebuilt with one entry per output slide', () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['A', 'B', 'C']),
  });
  const out = buildTitleDeck({
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(session.speakers, 1, false),
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  });
  const zip = unzipSync(out.bytes);
  const pres = strFromU8(zip['ppt/presentation.xml']);
  const entries = [...pres.matchAll(/<p:sldId\s+id="(\d+)"\s+r:id="([^"]+)"\/>/g)];
  assert.equal(entries.length, 4, '1 walk-in + 3 session pages');
  // sldIds start at 256, increment.
  for (let i = 0; i < 4; i++) {
    assert.equal(Number(entries[i][1]), 256 + i,
      `sldId ${i} should be ${256 + i}`);
  }
});

// ───── line-bound speaker bindings — substitute + warn (no hyperlink) ──

test('Line-bound speaker binding substitutes line text + emits warning', () => {
  // The 2 deck sample doesn't have a natural multi-line speaker frame,
  // but we can synthesise the case by binding a speaker to line 0 of a
  // single-line frame. The substitution should still target that line
  // (paragraph 0), and we expect a warning about skipped hyperlink.
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame, line: 0 }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John Smith']),
  });
  const out = buildTitleDeck({
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(session.speakers, 1, false),
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  });
  const zip = unzipSync(out.bytes);
  assert.ok(slideText(zip, 'ppt/slides/slide2.xml').includes('John Smith'),
    'line-bound substitution lands');
  assert.equal(out.warnings.length, 1, 'one warning per line-bound speaker');
  assert.ok(out.warnings[0].includes('Line-bound'),
    `warning mentions line-bound; got "${out.warnings[0]}"`);
  // No hyperlink rel on this slide (skipped for line-bound).
  const rels = strFromU8(zip['ppt/slides/_rels/slide2.xml.rels']);
  assert.ok(!rels.includes('hyperlink'),
    'line-bound speakers skip hyperlink injection');
});

// ───── partial-page substitution: trailing slot empty when speakers < cap ──

test('Last page with fewer speakers than capacity blanks trailing slots', () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  // Set up 2 speaker frames (capacity=2). 3 speakers will paginate to [2, 1].
  // Page 2 has only 1 speaker; slot 2 should be blanked.
  // The 2 deck sample only has one obvious speaker-shaped frame ("First Person"),
  // so we synthetically bind two frames as speakers — frame 0 + frame for First Person.
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  // Use the second-to-last frame as a 2nd "speaker" — doesn't matter which, any
  // text-bearing frame will accept substitution.
  const otherFrame = inspection.textFrames[0].index;
  if (otherFrame === speakerFrame) throw new Error('frame collision in test setup');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [
      { role: 'speaker', frame: speakerFrame },
      { role: 'speaker', frame: otherFrame },
    ],
  };
  const speakers = makeSpeakers(['A', 'B', 'C']);
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1', speakers,
  });
  const out = buildTitleDeck({
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(speakers, 2, false),   // [['A','B'], ['C']]
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  });
  const zip = unzipSync(out.bytes);
  const slides = getSlidePaths(zip);
  assert.equal(slides.length, 3, '1 walk-in + 2 session pages');
  // Page 2 (slide3) should have "C" in one slot and empty in the other.
  const page2Texts = slideText(zip, 'ppt/slides/slide3.xml');
  assert.ok(page2Texts.includes('C'), 'page 2 speaker slot 0 has C');
  // Verify only one hyperlink rel on page 2 (for "C", not for the empty slot).
  const page2Rels = strFromU8(zip['ppt/slides/_rels/slide3.xml.rels']);
  const hyperlinks = [...page2Rels.matchAll(/hyperlink/g)];
  assert.equal(hyperlinks.length, 1,
    `page 2 should have exactly 1 hyperlink (for C); got ${hyperlinks.length}`);
});

// ───── deterministic output ────────────────────────────────────────────

test('Same inputs produce byte-identical output (deterministic)', () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John']),
  });
  const input: DeckBuildInput = {
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(session.speakers, 1, false),
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  };
  const a = buildTitleDeck(input);
  const b = buildTitleDeck(input);
  assert.equal(a.bytes.length, b.bytes.length, 'byte lengths match');
  for (let i = 0; i < a.bytes.length; i++) {
    if (a.bytes[i] !== b.bytes[i]) {
      throw new Error(`mismatch at byte ${i}`);
    }
  }
});

// ───── validation: out-of-range frame → throw ──────────────────────────

test('Binding referencing an out-of-range frame throws at build time', () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: 9999 }],   // way out of range
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['X']),
  });
  assert.throws(
    () => buildTitleDeck({
      templateBytes: tpl, inspection, binding,
      sessions: [{
        title: 'X', timeslot: 'A',
        speakerPages: splitSpeakers(session.speakers, 1, false),
        session,
      }],
      day: 'MON', roomName: 'Room 1',
    }),
    /frame 9999/,
    'throws with clear message about the invalid frame index',
  );
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
