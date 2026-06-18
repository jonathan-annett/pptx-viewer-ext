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
import {
  buildTitleDeck,
  computeDeckHashes,
  nextDeckVersion,
  readDeckFingerprint,
  titleDeckHyperlinkTarget,
  type DeckBuildInput,
  type DeckFingerprint,
} from '../src/event/titleSlides/pptxBuild';
import { splitSpeakers } from '../src/event/titleSlides/pagination';
import type { TitleSlidesBinding } from '../src/event/titleSlides/binding';
import type { EventSession, SessionSpeakerSlot } from '../src/event/schedule';

const SAMPLES = join(__dirname, '..', 'samples', 'title-templates');
const load = (name: string): Uint8Array => new Uint8Array(readFileSync(join(SAMPLES, name)));

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>): void => {
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

test('titleDeckHyperlinkTarget composes <timeslot>/<placeholder-filename>', async () => {
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

test('titleDeckHyperlinkTarget respects custom extension', async () => {
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

test('2 deck sample: walk-in + 1 session slide; substitutes speaker name', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');

  const binding: TitleSlidesBinding = {
    templatePath: '2 deck sample.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John Smith']),
  });
  const out = await buildTitleDeck({
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

test('2 deck sample: hyperlink rels added on session slides', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John Smith']),
  });
  const out = await buildTitleDeck({
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

test('2 deck sample: shape-attached hyperlink lands on <p:cNvPr>', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const frame = inspection.textFrames[speakerFrame];
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John Smith']),
  });
  const out = await buildTitleDeck({
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

test('5 speakers @ capacity 1 produces 5 session slides + walk-in = 6 total', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
  };
  const speakers = makeSpeakers(['A', 'B', 'C', 'D', 'E']);
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1', speakers,
  });
  const out = await buildTitleDeck({
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

test('3 slide sample: supplementary slide appended after session slides', async () => {
  const tpl = load('3 slide sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John']),
  });
  const out = await buildTitleDeck({
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

test('1 deck sample: no walk-in; 1 session = 1 slide total', async () => {
  const tpl = load('1 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John']),
  });
  const out = await buildTitleDeck({
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

test('Multi-field binding substitutes all roles', async () => {
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
      { role: 'speaker', frame: speakerFrame, position: 1 },
    ],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'breakout-1',
    speakers: makeSpeakers(['Jane Doe']),
  });
  const out = await buildTitleDeck({
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

test('Content_Types has Override for each output slide; no orphan notes', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John', 'Jane']),
  });
  const out = await buildTitleDeck({
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

test('presentation.xml sldIdLst rebuilt with one entry per output slide', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['A', 'B', 'C']),
  });
  const out = await buildTitleDeck({
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

test('Line-bound speaker binding substitutes line text + emits warning', async () => {
  // The 2 deck sample doesn't have a natural multi-line speaker frame,
  // but we can synthesise the case by binding a speaker to line 0 of a
  // single-line frame. The substitution should still target that line
  // (paragraph 0), and we expect a warning about skipped hyperlink.
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame, line: 0, position: 1 }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John Smith']),
  });
  const out = await buildTitleDeck({
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

test('Last page with fewer speakers than capacity blanks trailing slots', async () => {
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
      { role: 'speaker', frame: speakerFrame, position: 1 },
      { role: 'speaker', frame: otherFrame, position: 2 },
    ],
  };
  const speakers = makeSpeakers(['A', 'B', 'C']);
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1', speakers,
  });
  const out = await buildTitleDeck({
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

// ───── explicit positions drive speaker→frame assignment ───────────────

test('Speaker positions assign session speakers in position order, not array order', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  // Pick two distinct frames as speakers. We deliberately put them in
  // fields in REVERSE position order to prove position drives the
  // assignment (not array order).
  const speakerFrameA = frameIdx(inspection.textFrames, 'First Person');
  const speakerFrameB = inspection.textFrames[0].index;
  if (speakerFrameA === speakerFrameB) throw new Error('test setup: collision');

  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [
      // Frame A is Speaker 2 — listed first in the array.
      { role: 'speaker', frame: speakerFrameA, position: 2 },
      // Frame B is Speaker 1 — listed second.
      { role: 'speaker', frame: speakerFrameB, position: 1 },
    ],
  };
  const speakers = makeSpeakers(['ALPHA', 'BETA']);
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1', speakers,
  });
  const out = await buildTitleDeck({
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(speakers, 2, false),
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  });
  const zip = unzipSync(out.bytes);

  // First session speaker (ALPHA) should land in Frame B (= Speaker 1's frame).
  // Second session speaker (BETA) should land in Frame A (= Speaker 2's frame).
  const slide2Xml = strFromU8(zip['ppt/slides/slide2.xml']);
  const frameAText = extractFirstATInShape(slide2Xml, inspection.textFrames.find(f => f.index === speakerFrameA)!.shapeId);
  const frameBText = extractFirstATInShape(slide2Xml, inspection.textFrames.find(f => f.index === speakerFrameB)!.shapeId);
  assert.equal(frameBText, 'ALPHA', 'Speaker 1 (first session speaker) lands in the frame bound to position 1');
  assert.equal(frameAText, 'BETA', 'Speaker 2 (second session speaker) lands in the frame bound to position 2');
});

// ───── unused speaker frame on partial page is blanked (not template text) ──

test('Partial page: unused speaker frames render empty <a:t>, not the template sample text', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  // Two speaker frames @ capacity 2; only 1 speaker → page 1 has the
  // speaker in slot 1, slot 2 should be BLANK (not "First Person").
  const speakerFrameA = frameIdx(inspection.textFrames, 'First Person');
  const speakerFrameB = inspection.textFrames[0].index;
  if (speakerFrameA === speakerFrameB) throw new Error('test setup: collision');

  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [
      { role: 'speaker', frame: speakerFrameA, position: 1 },
      { role: 'speaker', frame: speakerFrameB, position: 2 },
    ],
  };
  const speakers = makeSpeakers(['ONLY']);
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1', speakers,
  });
  const out = await buildTitleDeck({
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(speakers, 2, false),
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  });
  const zip = unzipSync(out.bytes);
  const slide2Xml = strFromU8(zip['ppt/slides/slide2.xml']);
  const slot1Text = extractFirstATInShape(slide2Xml, inspection.textFrames.find(f => f.index === speakerFrameA)!.shapeId);
  const slot2Text = extractFirstATInShape(slide2Xml, inspection.textFrames.find(f => f.index === speakerFrameB)!.shapeId);
  assert.equal(slot1Text, 'ONLY', 'slot 1 has the only speaker');
  assert.equal(slot2Text, '',
    `slot 2 should be blanked (empty string), not the template's original text; got "${slot2Text}"`);
});

// Pull just the first <a:t>...</a:t> content inside a specific shape.
function extractFirstATInShape(slideXml: string, shapeId: number): string {
  const spRe = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let m: RegExpExecArray | null;
  while ((m = spRe.exec(slideXml))) {
    if (!m[1].includes(`id="${shapeId}"`)) continue;
    const t = m[1].match(/<a:t>([^<]*)<\/a:t>/);
    return t ? t[1] : '';
  }
  return '';
}

// ───── deterministic output ────────────────────────────────────────────

test('Same inputs produce byte-identical output (deterministic)', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
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
  const a = await buildTitleDeck(input);
  const b = await buildTitleDeck(input);
  assert.equal(a.bytes.length, b.bytes.length, 'byte lengths match');
  for (let i = 0; i < a.bytes.length; i++) {
    if (a.bytes[i] !== b.bytes[i]) {
      throw new Error(`mismatch at byte ${i}`);
    }
  }
});

// ───── fingerprint: compute, embed, read back, version-bump ────────────

test('Output carries a fingerprint with deck-version, template-sha256, data-sha256', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John']),
  });
  const out = await buildTitleDeck({
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(session.speakers, 1, false),
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  });
  assert.equal(out.fingerprint.formatVersion, 1);
  assert.equal(out.fingerprint.deckVersion, 1, 'first generation defaults to v1');
  assert.match(out.fingerprint.templateHash, /^[0-9a-f]{64}$/, 'sha256 hex');
  assert.match(out.fingerprint.dataHash, /^[0-9a-f]{64}$/, 'sha256 hex');
  assert.notEqual(out.fingerprint.templateHash, out.fingerprint.dataHash,
    'template and data hashes are independent');
});

test('readDeckFingerprint round-trips the embedded block', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John']),
  });
  const out = await buildTitleDeck({
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(session.speakers, 1, false),
      session,
    }],
    day: 'MON', roomName: 'Room 1',
    deckVersion: 7,
    generatedAt: '2026-05-29T12:00:00Z',
  });
  const fp = readDeckFingerprint(out.bytes);
  assert.ok(fp, 'fingerprint readable');
  assert.equal(fp!.formatVersion, 1);
  assert.equal(fp!.deckVersion, 7, 'caller-supplied deck version preserved');
  assert.equal(fp!.templateHash, out.fingerprint.templateHash);
  assert.equal(fp!.dataHash, out.fingerprint.dataHash);
  assert.equal(fp!.generatedAt, '2026-05-29T12:00:00Z');
});

test('readDeckFingerprint returns null for files without an embedded block', () => {
  // The raw template has no fingerprint — should return null cleanly.
  const tpl = load('2 deck sample.pptx');
  assert.equal(readDeckFingerprint(tpl), null);
});

test('readDeckFingerprint returns null for non-pptx bytes (corrupt zip)', () => {
  assert.equal(readDeckFingerprint(new Uint8Array([0, 1, 2, 3])), null);
});

test('dataHash is independent of generatedAt and deckVersion (byte-deterministic core)', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John']),
  });
  const baseInput: DeckBuildInput = {
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(session.speakers, 1, false),
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  };
  const a = await buildTitleDeck({ ...baseInput, deckVersion: 1, generatedAt: '2026-05-29T01:00Z' });
  const b = await buildTitleDeck({ ...baseInput, deckVersion: 9, generatedAt: '2099-01-01T00:00Z' });
  assert.equal(a.fingerprint.dataHash, b.fingerprint.dataHash,
    'data hash same regardless of version/timestamp');
  assert.equal(a.fingerprint.templateHash, b.fingerprint.templateHash);
});

test('dataHash differs when any output-affecting input changes', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['John']),
  });
  const sessionAlt = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['Jane']),   // different speaker → different hash
  });
  const baseInput: DeckBuildInput = {
    templateBytes: tpl, inspection, binding,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(session.speakers, 1, false),
      session,
    }],
    day: 'MON', roomName: 'Room 1',
  };
  const baseHashes = (await computeDeckHashes(baseInput));
  // Different speaker
  const altSpeaker = (await computeDeckHashes({
    ...baseInput,
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(sessionAlt.speakers, 1, false),
      session: sessionAlt,
    }],
  }));
  assert.notEqual(altSpeaker.dataHash, baseHashes.dataHash,
    'changing the speaker name flips the data hash');
  // Different roomName
  const altRoom = (await computeDeckHashes({ ...baseInput, roomName: 'Plenary Hall' }));
  assert.notEqual(altRoom.dataHash, baseHashes.dataHash,
    'changing roomName flips the data hash');
  // Different day
  const altDay = (await computeDeckHashes({ ...baseInput, day: 'TUE' }));
  assert.notEqual(altDay.dataHash, baseHashes.dataHash,
    'changing day flips the data hash');
});

test('nextDeckVersion: no previous → v1 changed', () => {
  const { version, changed } = nextDeckVersion(null, {
    templateHash: 'a'.repeat(64),
    dataHash: 'b'.repeat(64),
  });
  assert.equal(version, 1);
  assert.equal(changed, true);
});

test('nextDeckVersion: identical hashes → same version, NOT changed', () => {
  const prev: DeckFingerprint = {
    formatVersion: 1, deckVersion: 5,
    templateHash: 'a'.repeat(64), dataHash: 'b'.repeat(64),
  };
  const { version, changed } = nextDeckVersion(prev, {
    templateHash: 'a'.repeat(64),
    dataHash: 'b'.repeat(64),
  });
  assert.equal(version, 5, 'no bump when nothing changed');
  assert.equal(changed, false);
});

test('nextDeckVersion: any hash change → version + 1, changed', () => {
  const prev: DeckFingerprint = {
    formatVersion: 1, deckVersion: 3,
    templateHash: 'a'.repeat(64), dataHash: 'b'.repeat(64),
  };
  const dataChange = nextDeckVersion(prev, {
    templateHash: 'a'.repeat(64),
    dataHash: 'c'.repeat(64),
  });
  assert.deepEqual(dataChange, { version: 4, changed: true });
  const tplChange = nextDeckVersion(prev, {
    templateHash: 'z'.repeat(64),
    dataHash: 'b'.repeat(64),
  });
  assert.deepEqual(tplChange, { version: 4, changed: true });
});

test('docProps/core.xml is created from scratch when absent in template', async () => {
  const tpl = load('2 deck sample.pptx');
  // Verify the sample really has no core.xml.
  const tplZip = unzipSync(tpl);
  assert.ok(!tplZip['docProps/core.xml'],
    'precondition: sample has no docProps/core.xml');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const out = await buildTitleDeck({
    templateBytes: tpl,
    inspection,
    binding: {
      templatePath: 't.pptx',
      fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
    },
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(makeSpeakers(['John']), 1, false),
      session: makeSession({
        day: 'MON', timeslot: 'A', roomId: 'room-1',
        speakers: makeSpeakers(['John']),
      }),
    }],
    day: 'MON', roomName: 'Room 1',
  });
  const outZip = unzipSync(out.bytes);
  assert.ok(outZip['docProps/core.xml'], 'core.xml created');
  const ct = strFromU8(outZip['[Content_Types].xml']);
  assert.ok(ct.includes('PartName="/docProps/core.xml"'),
    'Content_Types Override added');
  const rootRels = strFromU8(outZip['_rels/.rels']);
  assert.ok(rootRels.includes('relationships/metadata/core-properties'),
    'root rels Relationship added');
});

// ───── thumbnail embed ─────────────────────────────────────────────────

test('thumbnailBytes are embedded at docProps/thumbnail.jpeg with scaffolding', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  // Synthetic "JPEG" bytes — content doesn't matter for embed-side tests,
  // only that they round-trip and the scaffolding lands correctly.
  const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xde, 0xad, 0xbe, 0xef]);
  const out = await buildTitleDeck({
    templateBytes: tpl, inspection,
    binding: {
      templatePath: 't.pptx',
      fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
    },
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(makeSpeakers(['John']), 1, false),
      session: makeSession({
        day: 'MON', timeslot: 'A', roomId: 'room-1',
        speakers: makeSpeakers(['John']),
      }),
    }],
    day: 'MON', roomName: 'Room 1',
    thumbnailBytes: fakeJpeg,
  });
  const zip = unzipSync(out.bytes);
  // File present + bytes match.
  assert.ok(zip['docProps/thumbnail.jpeg'], 'thumbnail file in zip');
  assert.equal(zip['docProps/thumbnail.jpeg'].length, fakeJpeg.length);
  // Content_Types Override added.
  const ct = strFromU8(zip['[Content_Types].xml']);
  assert.ok(ct.includes('PartName="/docProps/thumbnail.jpeg"'),
    'Content_Types Override added');
  assert.ok(ct.includes('image/jpeg'),
    'Override declares image/jpeg content type');
  // Root rels Relationship added.
  const rootRels = strFromU8(zip['_rels/.rels']);
  assert.ok(rootRels.includes('relationships/metadata/thumbnail'),
    'root rels Relationship added');
  assert.ok(rootRels.includes('Target="docProps/thumbnail.jpeg"'),
    'root rels Target points at the embedded thumbnail');
});

test('No thumbnail input → no docProps/thumbnail.jpeg in output', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const speakerFrame = frameIdx(inspection.textFrames, 'First Person');
  const out = await buildTitleDeck({
    templateBytes: tpl, inspection,
    binding: {
      templatePath: 't.pptx',
      fields: [{ role: 'speaker', frame: speakerFrame, position: 1 }],
    },
    sessions: [{
      title: 'X', timeslot: 'A',
      speakerPages: splitSpeakers(makeSpeakers(['John']), 1, false),
      session: makeSession({
        day: 'MON', timeslot: 'A', roomId: 'room-1',
        speakers: makeSpeakers(['John']),
      }),
    }],
    day: 'MON', roomName: 'Room 1',
  });
  const zip = unzipSync(out.bytes);
  assert.ok(!zip['docProps/thumbnail.jpeg'], 'no thumbnail file when not requested');
  const ct = strFromU8(zip['[Content_Types].xml']);
  assert.ok(!ct.includes('thumbnail.jpeg'),
    'no Content_Types entry for absent thumbnail');
});

// ───── validation: out-of-range frame → throw ──────────────────────────

test('Binding referencing an out-of-range frame throws at build time', async () => {
  const tpl = load('2 deck sample.pptx');
  const inspection = inspectTemplate(tpl);
  const binding: TitleSlidesBinding = {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: 9999, position: 1 }],   // way out of range
  };
  const session = makeSession({
    day: 'MON', timeslot: 'A', roomId: 'room-1',
    speakers: makeSpeakers(['X']),
  });
  await assert.rejects(
    buildTitleDeck({
      templateBytes: tpl, inspection, binding,
      sessions: [{
        title: 'X', timeslot: 'A',
        speakerPages: splitSpeakers(session.speakers, 1, false),
        session,
      }],
      day: 'MON', roomName: 'Room 1',
    }),
    /frame 9999/,
    'rejects with clear message about the invalid frame index',
  );
});

// ───── run ─────────────────────────────────────────────────────────────

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
