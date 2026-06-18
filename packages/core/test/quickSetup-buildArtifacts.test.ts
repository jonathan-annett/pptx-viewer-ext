// Tests for the wizard's pure artifact builder. Run with:
//   npm run test:quick-setup-build
//
// Two flavours of test:
//   1. Structural — assertions over the parsed JSON of each artifact.
//      Catches drift in the builder's field-derivation logic without
//      pinning every byte of the surrounding format.
//   2. Determinism — same inputs (incl. `generatedAt`) → byte-identical
//      outputs across two calls. Locks the contract the wizard's
//      success-toast handoff depends on (the file hashes are stable
//      across the openFolder reload).

import { strict as assert } from 'node:assert';
import {
  buildArtifacts,
  buildEventSchedule,
  type QuickSetupInputs,
} from '../src/event/quickSetup/buildArtifacts';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

// Standard fixture input used across most tests. Deliberately small
// (2 days × 2 timeslots × 1 room × 1 speaker) so structural asserts
// stay readable. Larger-grid variants override fields per-test.
const FIXTURE: QuickSetupInputs = {
  eventName: 'TestEvent',
  days: ['MON', 'TUE'],
  timeslots: ['0900', '1300'],
  rooms: ['RM001'],
  speakerNames: ['Jane Doe'],
  generatedAt: '2026-05-30T00:00:00.000Z',
};

// ───── eventSchedule — top-level shape ────────────────────────────────

test('eventSchedule: stamps generatedAt from input', () => {
  const out = buildArtifacts(FIXTURE);
  const schedule = JSON.parse(decode(out.eventScheduleBytes));
  assert.equal(schedule.generatedAt, '2026-05-30T00:00:00.000Z');
});

test('eventSchedule: trailing newline on serialised output', () => {
  // marshalSchedule's contract is `JSON + '\n'` — the wizard inherits it.
  // Locking this catches an accidental rewrite of the serializer.
  const out = buildArtifacts(FIXTURE);
  const text = decode(out.eventScheduleBytes);
  assert.ok(text.endsWith('\n'), 'expected trailing newline');
});

test('eventSchedule: vacancies array is always empty', () => {
  const out = buildArtifacts(FIXTURE);
  const schedule = JSON.parse(decode(out.eventScheduleBytes));
  assert.deepEqual(schedule.vacancies, []);
});

// ───── eventSchedule.config ───────────────────────────────────────────

test('eventSchedule.config: name + days + defaultTimeslots + layout from input', () => {
  const out = buildArtifacts(FIXTURE);
  const { config } = JSON.parse(decode(out.eventScheduleBytes));
  assert.equal(config.name, 'TestEvent');
  assert.deepEqual(config.days, ['MON', 'TUE']);
  assert.deepEqual(config.defaultTimeslots, ['0900', '1300']);
  assert.equal(config.layout, 'day-major');
});

test('eventSchedule.config: breakoutRoomCount = rooms.length', () => {
  const out = buildArtifacts({ ...FIXTURE, rooms: ['A', 'B', 'C'] });
  const { config } = JSON.parse(decode(out.eventScheduleBytes));
  assert.equal(config.breakoutRoomCount, 3);
});

test('eventSchedule.config: sample-generator slot counts from timeslot count', () => {
  // T=4 → non-last day slot count = 1 + (T-1) = 4 ✓
  //       last-day slot count    = 1 + (T-2) + 1 = 4 ✓
  // i.e. a future "Generate sample schedule" click produces a slot
  // count matching the user's timeslots length.
  const out = buildArtifacts({
    ...FIXTURE,
    timeslots: ['A', 'B', 'C', 'D'],
  });
  const { config } = JSON.parse(decode(out.eventScheduleBytes));
  assert.equal(config.breakoutSessionsPerDay, 3); // T-1
  assert.equal(config.breakoutSessionsLastDay, 2); // T-2
});

test('eventSchedule.config: slot counts clamp at 0 for very short events', () => {
  // T=1 timeslot → both clamps engage (negative would crash the
  // generator on the FromCharCode(65 + i) loop).
  const out = buildArtifacts({ ...FIXTURE, timeslots: ['ONLY'] });
  const { config } = JSON.parse(decode(out.eventScheduleBytes));
  assert.equal(config.breakoutSessionsPerDay, 0);
  assert.equal(config.breakoutSessionsLastDay, 0);
});

test('eventSchedule.config: speakerPoolSize ≥ user speaker count, floor 1', () => {
  const out0 = buildArtifacts({ ...FIXTURE, speakerNames: [] });
  const c0 = JSON.parse(decode(out0.eventScheduleBytes)).config;
  assert.equal(c0.speakerPoolSize, 1, 'empty speakers floors at 1');

  const out5 = buildArtifacts({
    ...FIXTURE,
    speakerNames: ['a', 'b', 'c', 'd', 'e'],
  });
  const c5 = JSON.parse(decode(out5.eventScheduleBytes)).config;
  assert.equal(c5.speakerPoolSize, 5);
});

test('eventSchedule.config: relocations forced to 0', () => {
  // The wizard creates no plenary room, so the sample generator's
  // relocate-to-plenary step would have nowhere to send anything.
  const out = buildArtifacts(FIXTURE);
  const { config } = JSON.parse(decode(out.eventScheduleBytes));
  assert.equal(config.relocations, 0);
});

test('eventSchedule.config: inherits DEFAULT_CONFIG for un-derived knobs', () => {
  // plenaryOpenSpeakers, closingSpeakers, speakersPerBreakoutMin/Max,
  // seed — all sourced from DEFAULT_CONFIG. The wizard doesn't ask
  // about these; future "Generate sample schedule" gets the defaults.
  const out = buildArtifacts(FIXTURE);
  const { config } = JSON.parse(decode(out.eventScheduleBytes));
  assert.equal(config.seed, 1);
  assert.equal(config.plenaryOpenSpeakers, 3);
  assert.equal(config.closingSpeakers, 3);
  assert.equal(config.speakersPerBreakoutMin, 1);
  assert.equal(config.speakersPerBreakoutMax, 3);
});

// ───── eventSchedule.timeslotsByDay ───────────────────────────────────

test('eventSchedule.timeslotsByDay: every day gets the same timeslot list', () => {
  const out = buildArtifacts({
    ...FIXTURE,
    days: ['MON', 'TUE', 'WED'],
    timeslots: ['0900', '1300', '1600'],
  });
  const schedule = JSON.parse(decode(out.eventScheduleBytes));
  assert.deepEqual(schedule.timeslotsByDay, {
    MON: ['0900', '1300', '1600'],
    TUE: ['0900', '1300', '1600'],
    WED: ['0900', '1300', '1600'],
  });
});

test('eventSchedule.timeslotsByDay: per-day lists are independent arrays', () => {
  // Catches an accidental shared-reference bug — if all days held the
  // same array, the editor's per-day rename UI would clobber every day.
  const out = buildArtifacts({
    ...FIXTURE,
    days: ['MON', 'TUE'],
  });
  const schedule = JSON.parse(decode(out.eventScheduleBytes));
  assert.notEqual(
    schedule.timeslotsByDay.MON,
    schedule.timeslotsByDay.TUE,
    'each day must own its own array',
  );
});

// ───── eventSchedule.speakers ─────────────────────────────────────────

test('eventSchedule.speakers: spk-NN zero-padded sequential IDs', () => {
  const out = buildArtifacts({
    ...FIXTURE,
    speakerNames: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
  });
  const schedule = JSON.parse(decode(out.eventScheduleBytes));
  assert.equal(schedule.speakers[0].id, 'spk-01');
  assert.equal(schedule.speakers[9].id, 'spk-10');
});

test('eventSchedule.speakers: name preserved verbatim (no sanitization)', () => {
  // The wizard sanitizes day/timeslot/room tokens but speaker names
  // are display strings — they survive with spaces + casing intact.
  const out = buildArtifacts({
    ...FIXTURE,
    speakerNames: ['John Smith', 'jane doe', 'A. B. SINGH'],
  });
  const schedule = JSON.parse(decode(out.eventScheduleBytes));
  assert.deepEqual(
    schedule.speakers.map((s: { name: string }) => s.name),
    ['John Smith', 'jane doe', 'A. B. SINGH'],
  );
});

test('eventSchedule.speakers: empty input → empty array (still valid)', () => {
  const out = buildArtifacts({ ...FIXTURE, speakerNames: [] });
  const schedule = JSON.parse(decode(out.eventScheduleBytes));
  assert.deepEqual(schedule.speakers, []);
});

// ───── eventSchedule.rooms ────────────────────────────────────────────

test('eventSchedule.rooms: id === name === tokenized input, all kind:breakout', () => {
  const out = buildArtifacts({
    ...FIXTURE,
    rooms: ['RM001', 'PLENARY', 'Plenary'],
  });
  const schedule = JSON.parse(decode(out.eventScheduleBytes));
  assert.deepEqual(schedule.rooms, [
    { id: 'RM001', name: 'RM001', kind: 'breakout' },
    { id: 'PLENARY', name: 'PLENARY', kind: 'breakout' },
    { id: 'Plenary', name: 'Plenary', kind: 'breakout' },
  ]);
});

// ───── eventSchedule.sessions — full grid ─────────────────────────────

test('eventSchedule.sessions: one per (day × timeslot × room)', () => {
  const out = buildArtifacts({
    ...FIXTURE,
    days: ['MON', 'TUE', 'WED'],
    timeslots: ['A', 'B'],
    rooms: ['R1', 'R2'],
  });
  const schedule = JSON.parse(decode(out.eventScheduleBytes));
  assert.equal(schedule.sessions.length, 3 * 2 * 2, '3 days × 2 ts × 2 rooms');
});

test('eventSchedule.sessions: stable id pattern day-timeslot-roomId', () => {
  // Matches the existing generator's id convention (schedule.ts:135)
  // so downstream tools — including the existing event editor and the
  // title-slide deck generator — recognise sessions as belonging to
  // the same room across re-renders.
  const out = buildArtifacts(FIXTURE);
  const schedule = JSON.parse(decode(out.eventScheduleBytes));
  const ids = schedule.sessions.map((s: { id: string }) => s.id).sort();
  assert.deepEqual(ids, [
    'MON-0900-RM001',
    'MON-1300-RM001',
    'TUE-0900-RM001',
    'TUE-1300-RM001',
  ]);
});

test('eventSchedule.sessions: every session is empty (kind:breakout, no speakers, no title)', () => {
  const out = buildArtifacts({
    ...FIXTURE,
    rooms: ['R1', 'R2', 'R3'],
  });
  const schedule = JSON.parse(decode(out.eventScheduleBytes));
  for (const sess of schedule.sessions) {
    assert.equal(sess.kind, 'breakout');
    assert.deepEqual(sess.speakers, []);
    assert.equal(sess.relocatedFromRoomId, null);
    assert.equal(
      'title' in sess,
      false,
      'empty/missing title is stripped by marshalSchedule',
    );
  }
});

test('eventSchedule.sessions: ids are unique across the full grid', () => {
  // Catches an off-by-one in the triple-loop or a roomId collision
  // that would orphan one room's sessions.
  const out = buildArtifacts({
    ...FIXTURE,
    days: ['MON', 'TUE'],
    timeslots: ['A', 'B', 'C'],
    rooms: ['R1', 'R2'],
  });
  const schedule = JSON.parse(decode(out.eventScheduleBytes));
  const ids = new Set(schedule.sessions.map((s: { id: string }) => s.id));
  assert.equal(ids.size, schedule.sessions.length);
  assert.equal(ids.size, 12);
});

// ───── eventSync — snapshot ───────────────────────────────────────────

test('eventSync: minimal valid Snapshot shape with capturedAt threaded from input', () => {
  const out = buildArtifacts(FIXTURE);
  const text = decode(out.eventSyncBytes);

  // marshalSnapshot prefixes a JSONC header comment block. Strip the
  // leading `//` lines before JSON.parse — the parser doesn't accept
  // them on its own.
  const jsonStart = text.indexOf('{');
  const body = JSON.parse(text.slice(jsonStart));
  assert.deepEqual(body.folders, []);
  assert.deepEqual(body.settings, {});
  assert.deepEqual(body.placeholders, []);
  assert.equal(body.capturedAt, '2026-05-30T00:00:00.000Z');
});

test('eventSync: header comment block is preserved (round-trips through parser)', () => {
  // The snapshot writer prepends a "managed automatically" warning so
  // operators don't hand-edit the file. The wizard's output should
  // carry that warning so the user sees it on first open.
  const out = buildArtifacts(FIXTURE);
  const text = decode(out.eventSyncBytes);
  assert.ok(text.startsWith('//'), 'expected leading comment block');
  assert.ok(
    text.includes('managed automatically'),
    'expected substring "managed automatically" in header comment',
  );
});

// ───── roomSync files ─────────────────────────────────────────────────

test('roomSync: one file per user-entered room, filename = <roomId>.roomSync', () => {
  const out = buildArtifacts({
    ...FIXTURE,
    rooms: ['RM001', 'RM002', 'PLENARY'],
  });
  assert.deepEqual(
    out.roomSyncFiles.map((f) => f.filename),
    ['RM001.roomSync', 'RM002.roomSync', 'PLENARY.roomSync'],
  );
});

test('roomSync: template content embeds roomId in both comment + alias', () => {
  // Spot-check that the roomSyncTemplate import is wired correctly.
  // The full template assertion lives in eventFolders' own tests.
  const out = buildArtifacts({ ...FIXTURE, rooms: ['RM001'] });
  const text = decode(out.roomSyncFiles[0].bytes);
  assert.ok(text.includes('"RM001"'));
  assert.ok(text.includes('${roomSync}'));
  assert.ok(text.includes('"destinations": []'));
});

test('roomSync: empty rooms list → empty array (defensive, wizard rejects this upstream)', () => {
  // The wizard validates rooms ≥ 1 in M0's validateCommaList, but
  // the builder shouldn't crash on an empty array regardless.
  const out = buildArtifacts({ ...FIXTURE, rooms: [] });
  assert.deepEqual(out.roomSyncFiles, []);
});

// ───── determinism ────────────────────────────────────────────────────

test('determinism: identical inputs produce byte-identical bytes', () => {
  const a = buildArtifacts(FIXTURE);
  const b = buildArtifacts(FIXTURE);
  assert.deepEqual(
    Array.from(a.eventScheduleBytes),
    Array.from(b.eventScheduleBytes),
  );
  assert.deepEqual(
    Array.from(a.eventSyncBytes),
    Array.from(b.eventSyncBytes),
  );
  for (let i = 0; i < a.roomSyncFiles.length; i++) {
    assert.equal(a.roomSyncFiles[i].filename, b.roomSyncFiles[i].filename);
    assert.deepEqual(
      Array.from(a.roomSyncFiles[i].bytes),
      Array.from(b.roomSyncFiles[i].bytes),
    );
  }
});

test('determinism: input arrays are not mutated (defensive — caller may reuse)', () => {
  // The wizard collects inputs across five showInputBox calls; if the
  // builder mutated `days` / `timeslots` / `rooms` it would corrupt
  // the user's collected state in the cancel-and-restart path.
  const days = ['MON', 'TUE'];
  const timeslots = ['0900', '1300'];
  const rooms = ['RM001'];
  const speakerNames = ['Jane Doe'];
  buildArtifacts({
    ...FIXTURE,
    days,
    timeslots,
    rooms,
    speakerNames,
  });
  assert.deepEqual(days, ['MON', 'TUE']);
  assert.deepEqual(timeslots, ['0900', '1300']);
  assert.deepEqual(rooms, ['RM001']);
  assert.deepEqual(speakerNames, ['Jane Doe']);
});

// ───── buildEventSchedule (exported for the wizard's preview UX) ──────

test('buildEventSchedule: returns the same EventSchedule that gets marshalled', () => {
  // The wizard's M4 post-reload handoff opens the schedule file via
  // vscode.openWith — it doesn't need the in-memory object — but the
  // exported helper lets a future preview-the-config UX poke at the
  // pre-marshalled value. Lock the export so it doesn't bit-rot.
  const schedule = buildEventSchedule(FIXTURE);
  assert.equal(schedule.config.name, 'TestEvent');
  assert.equal(schedule.sessions.length, 2 * 2 * 1);
  assert.deepEqual(schedule.config.days, ['MON', 'TUE']);
});

// ───── runner ─────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(
      `    ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
    );
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('all tests passed');
