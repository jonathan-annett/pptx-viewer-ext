// Pure-module tests for the .eventSchedule parse / marshal / mutate helpers.
//
// Run with: npm run test:event-schedule-data
//
// No vscode shim needed — every helper takes/returns plain values.

import { strict as assert } from 'node:assert';
import {
  addRoom,
  addSession,
  addSpeaker,
  eligibleSpeakersForSession,
  emptySchedule,
  marshalSchedule,
  parseSchedule,
  removeRoom,
  removeSession,
  removeSpeaker,
  renameRoom,
  renameSpeaker,
  setDays,
  setEventName,
  setSessionKind,
  setSessionSpeakers,
} from '../src/event/scheduleData';
import { generateEventSchedule } from '../src/event/schedule';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

// ───── parse / marshal round trip ─────────────────────────────────────

test('parseSchedule + marshalSchedule round-trip the generator output', () => {
  const original = generateEventSchedule({ seed: 7 });
  const text = marshalSchedule(original);
  const { schedule, errors } = parseSchedule(text);
  assert.deepEqual(errors, [], 'no errors on the generator output');
  assert.equal(schedule.config.name, original.config.name);
  assert.equal(schedule.speakers.length, original.speakers.length);
  assert.equal(schedule.rooms.length, original.rooms.length);
  assert.equal(schedule.sessions.length, original.sessions.length);
  assert.equal(schedule.vacancies.length, original.vacancies.length);
});

test('parseSchedule recovers from corrupt JSON with empty schedule + error', () => {
  const { schedule, errors } = parseSchedule('{not json');
  assert.ok(errors.length > 0);
  assert.equal(schedule.speakers.length, 0);
  assert.equal(schedule.sessions.length, 0);
});

test('parseSchedule treats empty text as emptySchedule (no errors)', () => {
  const { schedule, errors } = parseSchedule('');
  assert.deepEqual(errors, []);
  assert.equal(schedule.speakers.length, 0);
  assert.equal(schedule.sessions.length, 0);
});

test('parseSchedule rejects non-object top-level with a clear error', () => {
  const { errors } = parseSchedule('[]');
  assert.ok(errors.some((e) => /must be an object/.test(e)));
});

test('parseSchedule normalises malformed entries — drops them quietly', () => {
  // Mix one well-formed speaker with several malformed entries — only the
  // good one survives, no thrown errors, no top-level diagnostic noise.
  const text = JSON.stringify({
    config: { name: 'X' },
    speakers: [
      { id: 'spk-01', name: 'OK' },
      { id: 'spk-02' }, // missing name
      'not-an-object',
      { id: 5, name: 'bad id type' },
    ],
    rooms: [],
    sessions: [],
  });
  const { schedule } = parseSchedule(text);
  assert.equal(schedule.speakers.length, 1);
  assert.equal(schedule.speakers[0].id, 'spk-01');
});

// ───── mutators ───────────────────────────────────────────────────────

test('setEventName updates config.name without touching other fields', () => {
  const s = emptySchedule();
  const next = setEventName(s, 'Demo Conference');
  assert.equal(next.config.name, 'Demo Conference');
  assert.equal(s.config.name, 'Sample Conference', 'original unchanged (immutable)');
});

test('setDays replaces the days list', () => {
  const s = setDays(emptySchedule(), ['FRI', 'SAT']);
  assert.deepEqual(s.config.days, ['FRI', 'SAT']);
});

test('addSpeaker assigns the next padded id and trims the name', () => {
  let s = emptySchedule();
  s = addSpeaker(s, '  First Speaker  ');
  s = addSpeaker(s, 'Second Speaker');
  assert.equal(s.speakers.length, 2);
  assert.equal(s.speakers[0].id, 'spk-01');
  assert.equal(s.speakers[0].name, 'First Speaker');
  assert.equal(s.speakers[1].id, 'spk-02');
});

test('addSpeaker is a no-op on empty/whitespace input', () => {
  const before = emptySchedule();
  const after = addSpeaker(before, '   ');
  assert.equal(after.speakers.length, 0);
});

test('renameSpeaker cascades into every session-slot referencing the id', () => {
  let s = emptySchedule();
  s = addSpeaker(s, 'Old Name');
  s = addRoom(s, { name: 'Plenary Hall', kind: 'plenary' });
  s = addSession(s, {
    day: 'MON',
    timeslot: 'A',
    roomId: 'plenary',
    kind: 'plenary-open',
    speakerIds: ['spk-01'],
  });
  s = renameSpeaker(s, 'spk-01', 'New Name');
  assert.equal(s.speakers[0].name, 'New Name');
  assert.equal(s.sessions[0].speakers[0].speakerName, 'New Name', 'session slot updated');
});

test('removeSpeaker drops them from every session and from the pool', () => {
  let s = emptySchedule();
  s = addSpeaker(s, 'A');
  s = addSpeaker(s, 'B');
  s = addRoom(s, { name: 'Plenary Hall', kind: 'plenary' });
  s = addSession(s, {
    day: 'MON',
    timeslot: 'A',
    roomId: 'plenary',
    kind: 'plenary-open',
    speakerIds: ['spk-01', 'spk-02'],
  });
  s = removeSpeaker(s, 'spk-01');
  assert.equal(s.speakers.length, 1);
  assert.equal(s.speakers[0].id, 'spk-02');
  assert.equal(s.sessions[0].speakers.length, 1);
  assert.equal(s.sessions[0].speakers[0].speakerId, 'spk-02');
});

test('addRoom mints plenary singleton when none exists, then numbered fallbacks', () => {
  let s = emptySchedule();
  s = addRoom(s, { name: 'Main Hall', kind: 'plenary' });
  s = addRoom(s, { name: 'Annex', kind: 'plenary' });
  assert.equal(s.rooms[0].id, 'plenary', 'first plenary takes the bare id');
  assert.equal(s.rooms[1].id, 'plenary-2', 'second plenary numbered');
});

test('addRoom mints sequential breakout ids', () => {
  let s = emptySchedule();
  s = addRoom(s, { name: 'Room 1' });
  s = addRoom(s, { name: 'Room 2' });
  s = addRoom(s, { name: 'Room 3' });
  assert.deepEqual(
    s.rooms.map((r) => r.id),
    ['breakout-1', 'breakout-2', 'breakout-3'],
  );
});

test('renameRoom updates only the matching room', () => {
  let s = emptySchedule();
  s = addRoom(s, { name: 'A' });
  s = addRoom(s, { name: 'B' });
  s = renameRoom(s, 'breakout-1', 'Renamed');
  assert.equal(s.rooms[0].name, 'Renamed');
  assert.equal(s.rooms[1].name, 'B');
});

test('removeRoom drops sessions hosted in that room', () => {
  let s = emptySchedule();
  s = addRoom(s, { name: 'Breakout 1' });
  s = addRoom(s, { name: 'Breakout 2' });
  s = addSpeaker(s, 'Speaker');
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout', speakerIds: ['spk-01'] });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-2', kind: 'breakout', speakerIds: ['spk-01'] });
  s = removeRoom(s, 'breakout-1');
  assert.equal(s.rooms.length, 1);
  assert.equal(s.sessions.length, 1);
  assert.equal(s.sessions[0].roomId, 'breakout-2');
});

test('addSession refuses to double-book the same (day, timeslot, room)', () => {
  let s = emptySchedule();
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  const before = s.sessions.length;
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  assert.equal(s.sessions.length, before, 'second add was a no-op');
});

test('addSession sorts canonically by (day index, timeslot, roomId)', () => {
  let s = setDays(emptySchedule(), ['MON', 'TUE']);
  s = addRoom(s, { name: 'A' });
  s = addRoom(s, { name: 'B' });
  s = addSession(s, { day: 'TUE', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-2', kind: 'breakout' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  assert.deepEqual(
    s.sessions.map((x) => x.id),
    ['MON-B-breakout-1', 'MON-B-breakout-2', 'TUE-B-breakout-1'],
  );
});

test('setSessionSpeakers re-numbers slot indices from 1', () => {
  let s = emptySchedule();
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSpeaker(s, 'A');
  s = addSpeaker(s, 'B');
  s = addSpeaker(s, 'C');
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout', speakerIds: ['spk-01'] });
  s = setSessionSpeakers(s, 'MON-B-breakout-1', ['spk-03', 'spk-02']);
  const slots = s.sessions[0].speakers;
  assert.equal(slots.length, 2);
  assert.equal(slots[0].slot, 1);
  assert.equal(slots[0].speakerId, 'spk-03');
  assert.equal(slots[1].slot, 2);
  assert.equal(slots[1].speakerId, 'spk-02');
});

test('setSessionKind changes only the matching session', () => {
  let s = emptySchedule();
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  s = setSessionKind(s, 'MON-B-breakout-1', 'breakout-relocated');
  assert.equal(s.sessions[0].kind, 'breakout-relocated');
});

test('removeSession drops it without touching speakers or rooms', () => {
  let s = emptySchedule();
  s = addRoom(s, { name: 'A' });
  s = addSpeaker(s, 'X');
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout', speakerIds: ['spk-01'] });
  s = removeSession(s, 'MON-B-breakout-1');
  assert.equal(s.sessions.length, 0);
  assert.equal(s.speakers.length, 1);
  assert.equal(s.rooms.length, 1);
});

// ───── eligibleSpeakersForSession ────────────────────────────────────

test('eligibleSpeakersForSession excludes speakers in OTHER sessions in the same (day, timeslot)', () => {
  let s = emptySchedule();
  s = addSpeaker(s, 'A'); // spk-01
  s = addSpeaker(s, 'B'); // spk-02
  s = addSpeaker(s, 'C'); // spk-03
  s = addRoom(s, { name: 'Breakout 1' });
  s = addRoom(s, { name: 'Breakout 2' });
  // Two concurrent sessions in different rooms at MON/B.
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout', speakerIds: ['spk-01'] });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-2', kind: 'breakout', speakerIds: ['spk-02'] });

  // Editing breakout-1: spk-01 (already in this session) is still
  // eligible; spk-02 (in the concurrent room) is NOT; spk-03 is.
  const eligible = eligibleSpeakersForSession(s, 'MON', 'B', 'MON-B-breakout-1');
  assert.deepEqual(eligible.sort(), ['spk-01', 'spk-03']);
});

test('eligibleSpeakersForSession returns all speakers when no other session in the timeslot', () => {
  let s = emptySchedule();
  s = addSpeaker(s, 'A');
  s = addSpeaker(s, 'B');
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout', speakerIds: ['spk-01'] });
  const eligible = eligibleSpeakersForSession(s, 'MON', 'B', 'MON-B-breakout-1');
  assert.deepEqual(eligible.sort(), ['spk-01', 'spk-02']);
});

test('eligibleSpeakersForSession with no currentSessionId excludes the in-session speakers too', () => {
  // Used when adding a NEW session at (day, timeslot) — every speaker
  // currently busy in that slot is blocked, including the candidate
  // sessions at that slot.
  let s = emptySchedule();
  s = addSpeaker(s, 'A');
  s = addSpeaker(s, 'B');
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout', speakerIds: ['spk-01'] });
  const eligible = eligibleSpeakersForSession(s, 'MON', 'B');
  assert.deepEqual(eligible, ['spk-02']);
});

// ───── setSessionSpeakers dedup ──────────────────────────────────────

test('setSessionSpeakers drops duplicate ids, preserving first-seen order', () => {
  let s = emptySchedule();
  s = addSpeaker(s, 'A');
  s = addSpeaker(s, 'B');
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  s = setSessionSpeakers(s, 'MON-B-breakout-1', ['spk-01', 'spk-02', 'spk-01']);
  const slots = s.sessions[0].speakers;
  assert.equal(slots.length, 2);
  assert.equal(slots[0].speakerId, 'spk-01');
  assert.equal(slots[1].speakerId, 'spk-02');
});

// ───── round-trip after mutation ─────────────────────────────────────

test('marshal → parse round-trip preserves a hand-authored schedule', () => {
  let s = emptySchedule();
  s = setEventName(s, 'Demo');
  s = setDays(s, ['MON', 'TUE']);
  s = addSpeaker(s, 'Speaker A');
  s = addSpeaker(s, 'Speaker B');
  s = addRoom(s, { name: 'Plenary Hall', kind: 'plenary' });
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'A', roomId: 'plenary', kind: 'plenary-open', speakerIds: ['spk-01'] });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout', speakerIds: ['spk-01', 'spk-02'] });
  const text = marshalSchedule(s);
  const reparsed = parseSchedule(text);
  assert.deepEqual(reparsed.errors, []);
  assert.equal(reparsed.schedule.config.name, 'Demo');
  assert.deepEqual(reparsed.schedule.config.days, ['MON', 'TUE']);
  assert.equal(reparsed.schedule.sessions.length, 2);
  assert.equal(reparsed.schedule.sessions[1].speakers[1].speakerName, 'Speaker B');
});

// ───── run ────────────────────────────────────────────────────────────

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
