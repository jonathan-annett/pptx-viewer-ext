// Pure-module tests for the .eventSchedule parse / marshal / mutate helpers.
//
// Run with: npm run test:event-schedule-data
//
// No vscode shim needed — every helper takes/returns plain values.

import { strict as assert } from 'node:assert';
import {
  addRoom,
  addRooms,
  addSession,
  addSpeaker,
  addSpeakers,
  addTimeslot,
  applyDefaultTimeslotsToAllDays,
  clearAll,
  displayTitleForSession,
  eligibleSpeakersForSession,
  emptySchedule,
  ensureTimeslotsByDay,
  isStructurallyEmpty,
  isValidTimeslotLabel,
  marshalSchedule,
  parseSchedule,
  removeRoom,
  removeSession,
  removeSpeaker,
  removeTimeslot,
  renameRoom,
  renameSpeaker,
  renameTimeslot,
  reorderTimeslots,
  replaceSessionSpeakersByNames,
  setDays,
  setDefaultTimeslots,
  setEventName,
  resolveLayout,
  setEventLayout,
  setSessionKind,
  setSessionSpeakers,
  setSessionTitle,
  setTitleSlidesBinding,
  swapSessionsInRoom,
  timeslotsForDayResolved,
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

// ───── M1: titles, timeslotsByDay, clearAll, timeslot ops, swaps ─────

test('parseSchedule + marshalSchedule round-trip preserves session titles', () => {
  let s = emptySchedule();
  s = addRoom(s, { name: 'Plenary Hall', kind: 'plenary' });
  s = addSession(s, { day: 'MON', timeslot: 'A', roomId: 'plenary', kind: 'plenary-open' });
  s = setSessionTitle(s, 'MON-A-plenary', 'Welcome remarks');
  const text = marshalSchedule(s);
  const { schedule, errors } = parseSchedule(text);
  assert.deepEqual(errors, []);
  assert.equal(schedule.sessions[0].title, 'Welcome remarks');
});

test('marshalSchedule omits title when empty / undefined', () => {
  let s = emptySchedule();
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  const text = marshalSchedule(s);
  assert.ok(!/"title"/.test(text), 'no title key emitted when no session carries one');
});

test('marshalSchedule serialises timeslotsByDay; parse round-trips it', () => {
  const s = ensureTimeslotsByDay(emptySchedule());
  const text = marshalSchedule(s);
  assert.ok(/"timeslotsByDay"/.test(text), 'timeslotsByDay present in serialised form');
  const { schedule } = parseSchedule(text);
  assert.ok(schedule.timeslotsByDay, 'parsed schedule has timeslotsByDay');
  assert.deepEqual(
    Object.keys(schedule.timeslotsByDay!).sort(),
    [...s.config.days].sort(),
    'one entry per configured day',
  );
});

test('parseSchedule strips a legacy top-level timeslots field on input', () => {
  // Hand-craft a file that carries the legacy field. After parse + marshal
  // the field is gone — round-trip is one-way for the legacy shape.
  const text = JSON.stringify({
    generatedAt: '2026-01-01T00:00:00Z',
    config: { name: 'X', days: ['MON'] },
    timeslots: ['A', 'B', 'C', 'D'],
    speakers: [],
    rooms: [],
    sessions: [],
    vacancies: [],
  });
  const { errors } = parseSchedule(text);
  // No diagnostic noise about the legacy field — silently dropped.
  assert.ok(!errors.some((e) => /timeslots/.test(e)));
  const reparsed = parseSchedule(marshalSchedule(parseSchedule(text).schedule));
  assert.ok(!('timeslots' in (reparsed.schedule as unknown as Record<string, unknown>)));
});

test('clearAll empties speakers/rooms/sessions/vacancies, preserves config + days + timeslotsByDay', () => {
  let s = ensureTimeslotsByDay(emptySchedule());
  s = setEventName(s, 'Demo');
  s = setDays(s, ['MON', 'TUE']);
  s = ensureTimeslotsByDay(s);
  s = addSpeaker(s, 'A');
  s = addRoom(s, { name: 'Plenary', kind: 'plenary' });
  s = addSession(s, { day: 'MON', timeslot: 'A', roomId: 'plenary', kind: 'plenary-open', speakerIds: ['spk-01'] });
  const beforeByDay = s.timeslotsByDay;
  const next = clearAll(s);
  assert.equal(next.speakers.length, 0);
  assert.equal(next.rooms.length, 0);
  assert.equal(next.sessions.length, 0);
  assert.equal(next.vacancies.length, 0);
  assert.equal(next.config.name, 'Demo');
  assert.deepEqual(next.config.days, ['MON', 'TUE']);
  assert.deepEqual(next.timeslotsByDay, beforeByDay);
});

test('addTimeslot appends next uppercase letter past the max', () => {
  let s = setDays(emptySchedule(), ['MON']);
  s = ensureTimeslotsByDay(s);
  // Wipe MON's seeded labels so we start from empty.
  s = { ...s, timeslotsByDay: { ...s.timeslotsByDay, MON: [] } };
  s = addTimeslot(s, 'MON'); // [] → A
  s = addTimeslot(s, 'MON'); // [A] → B
  s = addTimeslot(s, 'MON'); // [A,B] → C
  assert.deepEqual(s.timeslotsByDay!.MON, ['A', 'B', 'C']);
});

test('addTimeslot picks next-past-max even when there are gaps (no fill-the-gap)', () => {
  // User chose "add to end" semantics — [A, C] should yield D, not B.
  let s = setDays(emptySchedule(), ['MON']);
  s = { ...s, timeslotsByDay: { MON: ['A', 'C'] } };
  s = addTimeslot(s, 'MON');
  assert.deepEqual(s.timeslotsByDay!.MON, ['A', 'C', 'D']);
});

test('addTimeslot accepts a custom valid label; refuses duplicates and unknown day', () => {
  let s = setDays(emptySchedule(), ['MON']);
  s = { ...s, timeslotsByDay: { MON: ['A'] } };
  s = addTimeslot(s, 'MON', '1030');
  assert.deepEqual(s.timeslotsByDay!.MON, ['A', '1030']);
  const beforeDup = s;
  s = addTimeslot(s, 'MON', '1030');
  assert.equal(s, beforeDup, 'duplicate is a no-op (same reference)');
  const beforeUnknown = s;
  s = addTimeslot(s, 'NOPE', 'X');
  assert.equal(s, beforeUnknown, 'unknown day is a no-op');
});

test('removeTimeslot cascades into sessions and vacancies; no-op when absent', () => {
  let s = setDays(emptySchedule(), ['MON']);
  s = ensureTimeslotsByDay(s);
  s = { ...s, timeslotsByDay: { MON: ['A', 'B'] } };
  s = addRoom(s, { name: 'Plenary', kind: 'plenary' });
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'A', roomId: 'plenary', kind: 'plenary-open' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  // Inject a vacancy at MON/B so the cascade can drop it.
  s = { ...s, vacancies: [{ day: 'MON', timeslot: 'B', roomId: 'breakout-1', reason: 'relocated-to-plenary' }] };
  s = removeTimeslot(s, 'MON', 'B');
  assert.deepEqual(s.timeslotsByDay!.MON, ['A']);
  assert.equal(s.sessions.length, 1);
  assert.equal(s.sessions[0].timeslot, 'A');
  assert.equal(s.vacancies.length, 0);
  const before = s;
  s = removeTimeslot(s, 'MON', 'never-existed');
  assert.equal(s, before, 'absent label is a no-op');
});

test('renameTimeslot cascades into sessions and rebuilds ids', () => {
  let s = setDays(emptySchedule(), ['MON']);
  s = { ...s, timeslotsByDay: { MON: ['A', 'B'] } };
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  s = renameTimeslot(s, 'MON', 'B', '1030');
  assert.deepEqual(s.timeslotsByDay!.MON, ['A', '1030']);
  assert.equal(s.sessions[0].timeslot, '1030');
  assert.equal(s.sessions[0].id, 'MON-1030-breakout-1');
});

test('renameTimeslot refuses invalid characters, duplicates, and self-rename', () => {
  let s = setDays(emptySchedule(), ['MON']);
  s = { ...s, timeslotsByDay: { MON: ['A', 'B'] } };
  // Forbidden character → no-op.
  let next = renameTimeslot(s, 'MON', 'A', 'A/B');
  assert.equal(next, s);
  // Duplicate within the day → no-op.
  next = renameTimeslot(s, 'MON', 'A', 'B');
  assert.equal(next, s);
  // No-op when old == new.
  next = renameTimeslot(s, 'MON', 'A', 'A');
  assert.equal(next, s);
  // Empty / whitespace-only → no-op.
  next = renameTimeslot(s, 'MON', 'A', '');
  assert.equal(next, s);
  next = renameTimeslot(s, 'MON', 'A', '  ');
  assert.equal(next, s);
});

test('setSessionTitle round-trips through marshal/parse; empty input clears', () => {
  let s = emptySchedule();
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  s = setSessionTitle(s, 'MON-B-breakout-1', '  Strategy Review  ');
  const reparsed = parseSchedule(marshalSchedule(s));
  assert.equal(reparsed.schedule.sessions[0].title, 'Strategy Review', 'trimmed and persisted');
  let cleared = setSessionTitle(reparsed.schedule, 'MON-B-breakout-1', '');
  assert.equal(cleared.sessions[0].title, undefined, 'empty input clears the field');
  cleared = setSessionTitle(reparsed.schedule, 'MON-B-breakout-1', '   ');
  assert.equal(cleared.sessions[0].title, undefined, 'whitespace-only also clears');
});

test('displayTitleForSession returns title when set, falls back to kind otherwise', () => {
  let s = emptySchedule();
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  assert.equal(displayTitleForSession(s.sessions[0]), 'breakout');
  s = setSessionTitle(s, 'MON-B-breakout-1', 'Q4 Planning');
  assert.equal(displayTitleForSession(s.sessions[0]), 'Q4 Planning');
});

test('isValidTimeslotLabel rejects forbidden chars and whitespace edges', () => {
  for (const ch of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
    assert.ok(!isValidTimeslotLabel(`A${ch}B`), `should reject containing ${ch}`);
  }
  assert.ok(!isValidTimeslotLabel(''));
  assert.ok(!isValidTimeslotLabel('   '));
  assert.ok(!isValidTimeslotLabel(' A'));
  assert.ok(!isValidTimeslotLabel('A '));
  assert.ok(isValidTimeslotLabel('A'));
  assert.ok(isValidTimeslotLabel('1030'));
  assert.ok(isValidTimeslotLabel('Lunch'));
});

test('reorderTimeslots accepts a permutation, rejects anything else', () => {
  let s = setDays(emptySchedule(), ['MON']);
  s = { ...s, timeslotsByDay: { MON: ['A', 'B', 'C'] } };
  s = reorderTimeslots(s, 'MON', ['C', 'A', 'B']);
  assert.deepEqual(s.timeslotsByDay!.MON, ['C', 'A', 'B']);
  // Wrong length → no-op.
  let next = reorderTimeslots(s, 'MON', ['C', 'A']);
  assert.equal(next, s);
  // Different set → no-op.
  next = reorderTimeslots(s, 'MON', ['C', 'A', 'D']);
  assert.equal(next, s);
  // Duplicate → no-op.
  next = reorderTimeslots(s, 'MON', ['C', 'A', 'A']);
  assert.equal(next, s);
});

test('swapSessionsInRoom: both occupied → trade timeslots; ids rebuilt', () => {
  let s = setDays(emptySchedule(), ['MON']);
  s = { ...s, timeslotsByDay: { MON: ['A', 'B'] } };
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSpeaker(s, 'A'); // spk-01
  s = addSpeaker(s, 'B'); // spk-02
  s = addSession(s, { day: 'MON', timeslot: 'A', roomId: 'breakout-1', kind: 'breakout', speakerIds: ['spk-01'] });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout', speakerIds: ['spk-02'] });
  s = swapSessionsInRoom(s, 'MON', 'breakout-1', 'A', 'B');
  const byTimeslot = new Map(s.sessions.map((sess) => [sess.timeslot, sess]));
  // The session originally carrying spk-01 is now at timeslot B; the one
  // carrying spk-02 is at A. Ids reflect the new positions.
  assert.equal(byTimeslot.get('B')!.speakers[0].speakerId, 'spk-01');
  assert.equal(byTimeslot.get('B')!.id, 'MON-B-breakout-1');
  assert.equal(byTimeslot.get('A')!.speakers[0].speakerId, 'spk-02');
  assert.equal(byTimeslot.get('A')!.id, 'MON-A-breakout-1');
});

test('swapSessionsInRoom: one occupied → move; both empty → no-op', () => {
  let s = setDays(emptySchedule(), ['MON']);
  s = { ...s, timeslotsByDay: { MON: ['A', 'B'] } };
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'A', roomId: 'breakout-1', kind: 'breakout' });
  // Move from A to B (B is empty).
  s = swapSessionsInRoom(s, 'MON', 'breakout-1', 'A', 'B');
  assert.equal(s.sessions.length, 1);
  assert.equal(s.sessions[0].timeslot, 'B');
  assert.equal(s.sessions[0].id, 'MON-B-breakout-1');
  // Now both A and somewhere-else are empty in this room → no-op.
  const before = s;
  s = swapSessionsInRoom(s, 'MON', 'breakout-1', 'A', 'NEVER');
  assert.equal(s, before);
});

test('timeslotsForDayResolved reads timeslotsByDay when present, derives otherwise', () => {
  let s = setDays(emptySchedule(), ['MON', 'TUE']);
  s = { ...s, timeslotsByDay: { MON: ['X', 'Y'] } }; // TUE missing on purpose
  assert.deepEqual(timeslotsForDayResolved(s, 'MON'), ['X', 'Y']);
  // TUE not pinned → falls back to deterministic per-config list. We don't
  // pin specific values (config-dependent) but it must be a non-empty array.
  const tue = timeslotsForDayResolved(s, 'TUE');
  assert.ok(Array.isArray(tue) && tue.length > 0);
  // Unknown day → empty array (no row rendered).
  assert.deepEqual(timeslotsForDayResolved(s, 'NOPE'), []);
});

test('ensureTimeslotsByDay is idempotent', () => {
  const a = ensureTimeslotsByDay(emptySchedule());
  const b = ensureTimeslotsByDay(a);
  assert.equal(a, b, 'second call returns the same reference (no spurious copy)');
  // Concretely: every configured day has a non-empty label list.
  for (const day of a.config.days) {
    assert.ok((a.timeslotsByDay![day] ?? []).length > 0);
  }
});

// ───── bulk add (paste-multiline support) ────────────────────────────

test('addSpeakers folds names through addSpeaker, assigning sequential ids', () => {
  const s = addSpeakers(emptySchedule(), ['Alice', 'Bob', 'Carol']);
  assert.deepEqual(
    s.speakers.map((sp) => sp.id),
    ['spk-01', 'spk-02', 'spk-03'],
  );
  assert.deepEqual(
    s.speakers.map((sp) => sp.name),
    ['Alice', 'Bob', 'Carol'],
  );
});

test('addSpeakers skips empty / whitespace-only entries; trims the rest', () => {
  const s = addSpeakers(emptySchedule(), ['  Alice  ', '', '   ', 'Bob']);
  assert.equal(s.speakers.length, 2);
  assert.equal(s.speakers[0].name, 'Alice');
  assert.equal(s.speakers[1].name, 'Bob');
});

test('addSpeakers appends past existing speakers without renumbering', () => {
  let s = addSpeaker(emptySchedule(), 'Original');
  s = addSpeakers(s, ['Two', 'Three']);
  assert.deepEqual(
    s.speakers.map((sp) => sp.id),
    ['spk-01', 'spk-02', 'spk-03'],
  );
});

test('addRooms folds entries through addRoom with the shared kind', () => {
  const s = addRooms(emptySchedule(), { names: ['Hall A', 'Hall B', 'Hall C'] });
  assert.deepEqual(
    s.rooms.map((r) => r.id),
    ['breakout-1', 'breakout-2', 'breakout-3'],
  );
  for (const r of s.rooms) assert.equal(r.kind, 'breakout');
});

test('addRooms with kind=plenary mints singleton then numbered fallbacks', () => {
  const s = addRooms(emptySchedule(), { names: ['Main', 'Annex'], kind: 'plenary' });
  assert.equal(s.rooms[0].id, 'plenary');
  assert.equal(s.rooms[1].id, 'plenary-2');
});

test('addRooms skips empty entries', () => {
  const s = addRooms(emptySchedule(), { names: ['Hall A', '  ', '', 'Hall B'] });
  assert.equal(s.rooms.length, 2);
  assert.equal(s.rooms[0].name, 'Hall A');
  assert.equal(s.rooms[1].name, 'Hall B');
});

test('setDefaultTimeslots: trims, dedupes, validates, and clears on empty', () => {
  let s = emptySchedule();
  s = setDefaultTimeslots(s, ['  A ', 'B', 'A', 'C']);
  assert.deepEqual(s.config.defaultTimeslots, ['A', 'B', 'C'], 'trim + dedupe');
  // Invalid char → no-op (whole call refused defensively).
  const before = s;
  s = setDefaultTimeslots(s, ['X', 'Y/Z', 'W']);
  assert.equal(s, before);
  // Empty cleaned list → clears the field.
  s = setDefaultTimeslots(s, ['', '   ']);
  assert.equal(s.config.defaultTimeslots, undefined);
});

test('ensureTimeslotsByDay seeds new days from defaultTimeslots when set', () => {
  let s = emptySchedule();
  s = setDefaultTimeslots(s, ['Morning', 'Lunch', 'Afternoon']);
  s = setDays(s, ['FRI', 'SAT', 'SUN']);
  s = ensureTimeslotsByDay(s);
  assert.deepEqual(s.timeslotsByDay!.FRI, ['Morning', 'Lunch', 'Afternoon']);
  assert.deepEqual(s.timeslotsByDay!.SAT, ['Morning', 'Lunch', 'Afternoon']);
  assert.deepEqual(s.timeslotsByDay!.SUN, ['Morning', 'Lunch', 'Afternoon']);
});

test('ensureTimeslotsByDay preserves existing per-day lists when defaults are set', () => {
  let s = emptySchedule();
  s = setDefaultTimeslots(s, ['Morning', 'Lunch']);
  s = setDays(s, ['MON', 'TUE']);
  s = { ...s, timeslotsByDay: { MON: ['Custom-A', 'Custom-B'] } };
  s = ensureTimeslotsByDay(s);
  // MON keeps its custom list; TUE gets the default seed.
  assert.deepEqual(s.timeslotsByDay!.MON, ['Custom-A', 'Custom-B']);
  assert.deepEqual(s.timeslotsByDay!.TUE, ['Morning', 'Lunch']);
});

test('defaultTimeslots round-trips through marshal/parse; absent when empty', () => {
  let s = emptySchedule();
  s = setDefaultTimeslots(s, ['A', 'B', 'C']);
  const text = marshalSchedule(s);
  assert.ok(/"defaultTimeslots"/.test(text));
  const { schedule } = parseSchedule(text);
  assert.deepEqual(schedule.config.defaultTimeslots, ['A', 'B', 'C']);
  // Clear + marshal → field omitted.
  const cleared = setDefaultTimeslots(s, []);
  const text2 = marshalSchedule(cleared);
  assert.ok(!/"defaultTimeslots"/.test(text2));
});

// ───── replaceSessionSpeakersByNames ─────────────────────────────────

test('replaceSessionSpeakersByNames matches existing speakers case-insensitively', () => {
  let s = emptySchedule();
  s = addSpeakers(s, ['Alice Smith', 'Bob Jones', 'Carol Lee']);
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  // Paste with mixed case + extra whitespace — all should resolve to
  // existing ids.
  const result = replaceSessionSpeakersByNames(s, 'MON-B-breakout-1', [
    'alice smith',
    '  CAROL LEE  ',
  ]);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.addedSpeakers.length, 0, 'no new speakers added');
  const ids = result.schedule.sessions[0].speakers.map((sp) => sp.speakerId);
  assert.deepEqual(ids, ['spk-01', 'spk-03'], 'matched by name, paste order preserved');
});

test('replaceSessionSpeakersByNames auto-adds unknown names to the pool', () => {
  let s = emptySchedule();
  s = addSpeakers(s, ['Alice']);
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  const result = replaceSessionSpeakersByNames(s, 'MON-B-breakout-1', [
    'Alice',
    'New Person',
    'Another One',
  ]);
  assert.equal(result.addedSpeakers.length, 2, 'two unknown names became new speakers');
  assert.deepEqual(
    result.addedSpeakers.map((sp) => sp.name),
    ['New Person', 'Another One'],
  );
  // Pool grew to 3, session got all 3 in paste order.
  assert.equal(result.schedule.speakers.length, 3);
  assert.deepEqual(
    result.schedule.sessions[0].speakers.map((sp) => sp.speakerName),
    ['Alice', 'New Person', 'Another One'],
  );
});

test('replaceSessionSpeakersByNames dedupes within the paste', () => {
  let s = emptySchedule();
  s = addSpeakers(s, ['Alice']);
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  const result = replaceSessionSpeakersByNames(s, 'MON-B-breakout-1', [
    'Alice',
    'Bob',
    'alice', // case-fold dupe of first
    'Bob',   // exact dupe
  ]);
  assert.equal(result.schedule.sessions[0].speakers.length, 2, 'dedupe across paste');
  assert.equal(result.addedSpeakers.length, 1, 'only Bob is new');
});

test('replaceSessionSpeakersByNames moves speakers from sibling sessions at same (day, timeslot)', () => {
  let s = emptySchedule();
  s = addSpeakers(s, ['Alice', 'Bob']);
  s = addRoom(s, { name: 'Breakout 1' });
  s = addRoom(s, { name: 'Breakout 2' });
  // Two concurrent sessions at MON/B; Alice currently in breakout-1.
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout', speakerIds: ['spk-01'] });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-2', kind: 'breakout', speakerIds: ['spk-02'] });
  // Paste Alice into breakout-2 — Alice should be displaced from breakout-1.
  const result = replaceSessionSpeakersByNames(s, 'MON-B-breakout-2', ['Alice']);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].speakerName, 'Alice');
  assert.equal(result.conflicts[0].fromRoomName, 'Breakout 1');
  assert.equal(result.conflicts[0].day, 'MON');
  assert.equal(result.conflicts[0].timeslot, 'B');
  // After: breakout-1 has nobody, breakout-2 has only Alice.
  const sessions = new Map(result.schedule.sessions.map((s2) => [s2.roomId, s2]));
  assert.equal(sessions.get('breakout-1')!.speakers.length, 0);
  assert.equal(sessions.get('breakout-2')!.speakers[0].speakerName, 'Alice');
});

test('replaceSessionSpeakersByNames leaves OTHER timeslots alone', () => {
  let s = emptySchedule();
  s = addSpeakers(s, ['Alice']);
  s = addRoom(s, { name: 'Breakout 1' });
  // Alice is in MON/B/breakout-1; we're pasting Alice into MON/C/breakout-1.
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout', speakerIds: ['spk-01'] });
  s = addSession(s, { day: 'MON', timeslot: 'C', roomId: 'breakout-1', kind: 'breakout' });
  const result = replaceSessionSpeakersByNames(s, 'MON-C-breakout-1', ['Alice']);
  assert.equal(result.conflicts.length, 0, 'different timeslot is not a conflict');
  const sessions = new Map(result.schedule.sessions.map((s2) => [`${s2.day}-${s2.timeslot}`, s2]));
  assert.equal(sessions.get('MON-B')!.speakers.length, 1, 'B-Alice unchanged');
  assert.equal(sessions.get('MON-C')!.speakers[0].speakerName, 'Alice');
});

test('replaceSessionSpeakersByNames is a no-op when sessionId is unknown', () => {
  let s = emptySchedule();
  s = addSpeakers(s, ['Alice']);
  const before = s;
  const result = replaceSessionSpeakersByNames(s, 'NOPE', ['Alice', 'Bob']);
  assert.equal(result.schedule, before, 'schedule reference unchanged');
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.addedSpeakers, []);
});

// ───── applyDefaultTimeslotsToAllDays ───────────────────────────────

test('applyDefaultTimeslotsToAllDays: positional rename cascades into sessions', () => {
  let s = setDays(emptySchedule(), ['MON', 'TUE']);
  s = { ...s, timeslotsByDay: { MON: ['A', 'B', 'C'], TUE: ['A', 'B', 'C'] } };
  s = setDefaultTimeslots(s, ['Morning', 'Lunch', 'Afternoon']);
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  s = addSession(s, { day: 'TUE', timeslot: 'C', roomId: 'breakout-1', kind: 'breakout' });
  const result = applyDefaultTimeslotsToAllDays(s);
  assert.deepEqual(result.timeslotsByDay!.MON, ['Morning', 'Lunch', 'Afternoon']);
  assert.deepEqual(result.timeslotsByDay!.TUE, ['Morning', 'Lunch', 'Afternoon']);
  // Sessions follow positionally + id rebuilds.
  const monSession = result.sessions.find((sess) => sess.day === 'MON')!;
  const tueSession = result.sessions.find((sess) => sess.day === 'TUE')!;
  assert.equal(monSession.timeslot, 'Lunch');
  assert.equal(monSession.id, 'MON-Lunch-breakout-1');
  assert.equal(tueSession.timeslot, 'Afternoon');
  assert.equal(tueSession.id, 'TUE-Afternoon-breakout-1');
});

test('applyDefaultTimeslotsToAllDays: keeps old extras when old list is longer', () => {
  let s = setDays(emptySchedule(), ['MON']);
  s = { ...s, timeslotsByDay: { MON: ['A', 'B', 'C', 'D'] } };
  s = setDefaultTimeslots(s, ['Morning', 'Lunch']);
  s = addRoom(s, { name: 'Breakout 1' });
  // Session at D should be preserved (D is past the defaults' length).
  s = addSession(s, { day: 'MON', timeslot: 'D', roomId: 'breakout-1', kind: 'breakout' });
  const result = applyDefaultTimeslotsToAllDays(s);
  assert.deepEqual(result.timeslotsByDay!.MON, ['Morning', 'Lunch', 'C', 'D']);
  // Session at D survives — the operation is rename-only, never wipe.
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].timeslot, 'D');
});

test('applyDefaultTimeslotsToAllDays: appends when new list is longer', () => {
  let s = setDays(emptySchedule(), ['MON']);
  s = { ...s, timeslotsByDay: { MON: ['A', 'B'] } };
  s = setDefaultTimeslots(s, ['Morning', 'Lunch', 'Afternoon', 'Evening']);
  const result = applyDefaultTimeslotsToAllDays(s);
  assert.deepEqual(
    result.timeslotsByDay!.MON,
    ['Morning', 'Lunch', 'Afternoon', 'Evening'],
  );
});

test('applyDefaultTimeslotsToAllDays: no-op when defaults are empty', () => {
  let s = setDays(emptySchedule(), ['MON']);
  s = { ...s, timeslotsByDay: { MON: ['A', 'B'] } };
  const result = applyDefaultTimeslotsToAllDays(s);
  assert.equal(result, s, 'returns the same reference');
});

test('applyDefaultTimeslotsToAllDays: positional swap leaves no duplicates', () => {
  let s = setDays(emptySchedule(), ['MON']);
  s = { ...s, timeslotsByDay: { MON: ['A', 'B'] } };
  s = setDefaultTimeslots(s, ['B', 'A']);
  s = addRoom(s, { name: 'Breakout 1' });
  s = addSession(s, { day: 'MON', timeslot: 'A', roomId: 'breakout-1', kind: 'breakout' });
  const result = applyDefaultTimeslotsToAllDays(s);
  assert.deepEqual(result.timeslotsByDay!.MON, ['B', 'A']);
  // The session previously at A is now at B (positional rename).
  assert.equal(result.sessions[0].timeslot, 'B');
});

// ───── config.layout (resolveLayout + setEventLayout + roundtrip) ──────

test('resolveLayout defaults to day-major when config.layout is absent', () => {
  const s = emptySchedule();
  assert.equal(s.config.layout, undefined,
    'fresh schedule has no layout set');
  assert.equal(resolveLayout(s), 'day-major');
});

test('setEventLayout writes the value; resolveLayout returns it; roundtrip survives', () => {
  let s = emptySchedule();
  s = setEventLayout(s, 'room-major');
  assert.equal(s.config.layout, 'room-major');
  assert.equal(resolveLayout(s), 'room-major');
  const reparsed = parseSchedule(marshalSchedule(s));
  assert.equal(reparsed.schedule.config.layout, 'room-major',
    'layout survives marshal + parse roundtrip');
});

test('parser drops invalid layout values (corrupt hand-edit)', () => {
  const text = JSON.stringify({
    generatedAt: '2026-01-01T00:00:00Z',
    config: { name: 'Test', days: ['MON'], layout: 'sideways' },
    speakers: [], rooms: [], sessions: [], vacancies: [],
  });
  const r = parseSchedule(text);
  assert.equal(r.schedule.config.layout, undefined,
    'invalid layout dropped — resolveLayout will fall back to day-major');
  assert.equal(resolveLayout(r.schedule), 'day-major');
});

// ───── titleSlides binding (setTitleSlidesBinding + roundtrip) ─────────

test('setTitleSlidesBinding writes the binding into config; round-trips through marshal/parse', () => {
  let s = emptySchedule();
  const binding = {
    templatePath: 'templates/my.pptx',
    fields: [
      { role: 'sessionTitle' as const, frame: 3 },
      { role: 'speaker' as const, frame: 5, position: 1 },
      { role: 'speaker' as const, frame: 6, position: 2 },
    ],
    distributeEvenly: true,
  };
  s = setTitleSlidesBinding(s, binding);
  assert.deepEqual(s.config.titleSlides, binding);
  const reparsed = parseSchedule(marshalSchedule(s));
  assert.equal(reparsed.errors.length, 0, 'no parse errors');
  assert.deepEqual(reparsed.schedule.config.titleSlides, binding,
    'titleSlides survives serialise + reparse');
});

test('setTitleSlidesBinding(undefined) clears the binding (field becomes absent in output)', () => {
  let s = emptySchedule();
  s = setTitleSlidesBinding(s, {
    templatePath: 't.pptx',
    fields: [{ role: 'speaker', frame: 0, position: 1 }],
  });
  assert.ok(s.config.titleSlides);
  s = setTitleSlidesBinding(s, undefined);
  assert.equal(s.config.titleSlides, undefined);
  // Output JSON should not have the key at all (not just null).
  const text = marshalSchedule(s);
  assert.ok(!text.includes('titleSlides'), 'titleSlides absent from serialised output');
});

test('parseSchedule preserves line-bound speaker entries verbatim', () => {
  // Hand-authored line-bound binding — should round-trip without losing `line`.
  let s = emptySchedule();
  s = setTitleSlidesBinding(s, {
    templatePath: 't.pptx',
    fields: [
      { role: 'speaker', frame: 3, line: 0, position: 1 },
      { role: 'speaker', frame: 3, line: 1, position: 2 },
      { role: 'speaker', frame: 3, line: 2, position: 3 },
    ],
  });
  const reparsed = parseSchedule(marshalSchedule(s));
  const fields = reparsed.schedule.config.titleSlides?.fields ?? [];
  assert.equal(fields.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(fields[i].role, 'speaker');
    assert.equal(fields[i].frame, 3);
    assert.equal((fields[i] as { line?: number }).line, i,
      `line ${i} preserved`);
  }
});

test('parseSchedule with malformed titleSlides surfaces error + drops the binding', () => {
  // Not an object → drop.
  const text = JSON.stringify({
    generatedAt: '2026-01-01T00:00:00Z',
    config: {
      name: 'Test', days: ['MON'],
      titleSlides: 'not an object',
    },
    speakers: [], rooms: [], sessions: [], vacancies: [],
  });
  const r = parseSchedule(text);
  assert.equal(r.schedule.config.titleSlides, undefined);
  assert.ok(r.errors.some(e => e.includes('titleSlides')),
    `expected an error mentioning titleSlides; got ${JSON.stringify(r.errors)}`);
});

test('parseSchedule preserves explicit speaker position field on round-trip', () => {
  let s = emptySchedule();
  s = setTitleSlidesBinding(s, {
    templatePath: 't.pptx',
    fields: [
      { role: 'speaker', frame: 2, position: 2 },
      { role: 'speaker', frame: 5, position: 1 },
      { role: 'speaker', frame: 7, position: 3 },
    ],
  });
  const reparsed = parseSchedule(marshalSchedule(s));
  const fields = reparsed.schedule.config.titleSlides?.fields ?? [];
  // Round-trip preserves position values verbatim — sort order in the
  // array doesn't matter (titleSlideFieldsByRole sorts by position).
  const byFrame = new Map(fields.map((f) => [f.frame, f]));
  assert.equal((byFrame.get(2) as { position?: number }).position, 2);
  assert.equal((byFrame.get(5) as { position?: number }).position, 1);
  assert.equal((byFrame.get(7) as { position?: number }).position, 3);
});

test('parseTitleSlidesBinding drops speaker entries lacking a valid position', () => {
  // position is required for speaker bindings — entries with missing /
  // <1 / non-finite values get dropped at parse time (safer than
  // inventing an order).
  const text = JSON.stringify({
    generatedAt: '2026-01-01T00:00:00Z',
    config: {
      name: 'Test', days: ['MON'],
      titleSlides: {
        templatePath: 't.pptx',
        fields: [
          { role: 'speaker', frame: 0, position: 1 },     // ok
          { role: 'speaker', frame: 1, position: 0 },     // <1 → drop entry
          { role: 'speaker', frame: 2, position: -3 },    // negative → drop entry
          { role: 'speaker', frame: 3, position: 'abc' }, // wrong type → drop entry
          { role: 'speaker', frame: 4 },                  // missing position → drop entry
        ],
      },
    },
    speakers: [], rooms: [], sessions: [], vacancies: [],
  });
  const r = parseSchedule(text);
  const fields = r.schedule.config.titleSlides?.fields ?? [];
  assert.equal(fields.length, 1, 'only the entry with a valid position survives');
  assert.equal(fields[0].frame, 0);
  assert.equal((fields[0] as { position: number }).position, 1);
});

test('parseSchedule drops invalid field entries but keeps valid ones', () => {
  const text = JSON.stringify({
    generatedAt: '2026-01-01T00:00:00Z',
    config: {
      name: 'Test', days: ['MON'],
      titleSlides: {
        templatePath: 't.pptx',
        fields: [
          { role: 'speaker', frame: 0, position: 1 }, // ok
          { role: 'bogus', frame: 1 },                // invalid role → drop
          { role: 'speaker', frame: -1, position: 2 },// invalid frame → drop
          { role: 'speaker', frame: 'abc', position: 3 }, // not a number → drop
          { role: 'roomName', frame: 2 },             // ok (no position needed)
        ],
      },
    },
    speakers: [], rooms: [], sessions: [], vacancies: [],
  });
  const r = parseSchedule(text);
  const fields = r.schedule.config.titleSlides?.fields ?? [];
  assert.equal(fields.length, 2);
  assert.equal(fields[0].role, 'speaker');
  assert.equal(fields[1].role, 'roomName');
});

test('isStructurallyEmpty: empty + cleared schedules count; populated does not', () => {
  assert.ok(isStructurallyEmpty(emptySchedule()));
  let s = emptySchedule();
  s = addSpeaker(s, 'A');
  s = addRoom(s, { name: 'Room' });
  s = addSession(s, { day: 'MON', timeslot: 'B', roomId: 'breakout-1', kind: 'breakout' });
  assert.ok(!isStructurallyEmpty(s), 'populated schedule is NOT structurally empty');
  // Custom timeslot labels and a non-default event name don't count as
  // authored content for placeholder purposes — Clear deliberately
  // preserves them.
  const cleared = clearAll(s);
  assert.ok(isStructurallyEmpty(cleared), 'post-Clear schedule IS structurally empty');
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
