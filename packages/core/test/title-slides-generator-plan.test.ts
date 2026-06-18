// Pure-module tests for src/event/titleSlides/generatorPlan.ts.
//
// Builds synthetic schedules + bindings, runs planTitleSlideDecks, and
// asserts on the output structure: per-(room, day) grouping, layout-
// specific output paths, timeslot ordering, pagination invocation.
//
// Run with: npm run test:title-slides-generator-plan

import { strict as assert } from 'node:assert';
import { planTitleSlideDecks } from '../src/event/titleSlides/generatorPlan';
import type {
  EventSchedule,
  EventSession,
  TitleSlidesBinding,
} from '../src/event/schedule';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

// ───── Helpers ─────────────────────────────────────────────────────────

function schedule(opts: {
  name?: string;
  days?: string[];
  rooms?: Array<{ id: string; name: string; kind?: 'plenary' | 'breakout' }>;
  sessions?: EventSession[];
  timeslotsByDay?: Record<string, string[]>;
}): EventSchedule {
  return {
    generatedAt: '2026-01-01T00:00:00Z',
    config: {
      seed: 1, name: opts.name ?? 'Test Event',
      days: opts.days ?? ['MON', 'TUE'],
      breakoutRoomCount: 1, plenaryOpenSpeakers: 1, closingSpeakers: 1,
      breakoutSessionsPerDay: 2, breakoutSessionsLastDay: 1,
      speakerPoolSize: 5, speakersPerBreakoutMin: 1, speakersPerBreakoutMax: 2,
      relocations: 0,
    },
    timeslotsByDay: opts.timeslotsByDay ?? { MON: ['A', 'B'], TUE: ['A', 'B'] },
    speakers: [],
    rooms: (opts.rooms ?? [
      { id: 'plenary', name: 'Plenary Hall', kind: 'plenary' as const },
      { id: 'breakout-1', name: 'Room 1', kind: 'breakout' as const },
    ]).map((r) => ({ id: r.id, name: r.name, kind: r.kind ?? 'breakout' })),
    sessions: opts.sessions ?? [],
    vacancies: [],
  };
}

function session(
  day: string,
  timeslot: string,
  roomId: string,
  speakers: string[] = [],
): EventSession {
  return {
    id: `${day}-${timeslot}-${roomId}`,
    day,
    timeslot,
    roomId,
    kind: 'breakout',
    relocatedFromRoomId: null,
    speakers: speakers.map((n, i) => ({
      slot: i + 1,
      speakerId: `spk-${i + 1}`,
      speakerName: n,
    })),
  };
}

const titleFor = (s: EventSession): string => `Session @${s.timeslot}`;

const oneSpeakerBinding: TitleSlidesBinding = {
  templatePath: 't.pptx',
  fields: [{ role: 'speaker', frame: 0, position: 1 }],
};

const twoSpeakerBinding: TitleSlidesBinding = {
  templatePath: 't.pptx',
  fields: [
    { role: 'speaker', frame: 0, position: 1 },
    { role: 'speaker', frame: 1, position: 2 },
  ],
};

// ───── Grouping by (room, day) ─────────────────────────────────────────

test('Empty schedule produces an empty plan', () => {
  const plan = planTitleSlideDecks({
    schedule: schedule({}),
    binding: oneSpeakerBinding,
    layout: 'room-major',
    resolveSessionTitle: titleFor,
  });
  assert.equal(plan.decks.length, 0);
  assert.equal(plan.capacity, 1);
});

test('One session → one deck entry', () => {
  const sched = schedule({
    sessions: [session('MON', 'A', 'breakout-1', ['Alice'])],
  });
  const plan = planTitleSlideDecks({
    schedule: sched, binding: oneSpeakerBinding,
    layout: 'room-major',
    resolveSessionTitle: titleFor,
  });
  assert.equal(plan.decks.length, 1);
  assert.equal(plan.decks[0].day, 'MON');
  assert.equal(plan.decks[0].roomId, 'breakout-1');
  assert.equal(plan.decks[0].roomName, 'Room 1');
});

test('Sessions on the same room different days → one deck per (room, day)', () => {
  const sched = schedule({
    sessions: [
      session('MON', 'A', 'breakout-1', ['A']),
      session('TUE', 'A', 'breakout-1', ['B']),
    ],
  });
  const plan = planTitleSlideDecks({
    schedule: sched, binding: oneSpeakerBinding,
    layout: 'room-major',
    resolveSessionTitle: titleFor,
  });
  assert.equal(plan.decks.length, 2);
  const days = plan.decks.map((d) => d.day).sort();
  assert.deepEqual(days, ['MON', 'TUE']);
});

test('Multiple rooms on the same day → one deck per (room, day)', () => {
  const sched = schedule({
    sessions: [
      session('MON', 'A', 'plenary', ['P']),
      session('MON', 'A', 'breakout-1', ['B']),
    ],
  });
  const plan = planTitleSlideDecks({
    schedule: sched, binding: oneSpeakerBinding,
    layout: 'room-major',
    resolveSessionTitle: titleFor,
  });
  assert.equal(plan.decks.length, 2);
});

// ───── Layout-specific output paths ─────────────────────────────────────

test('room-major path = <roomId>/<day>/<DAY> <ROOM> Title Slides.pptx', () => {
  const sched = schedule({
    name: 'Widget Conf',
    sessions: [session('MON', 'A', 'breakout-1', ['Alice'])],
  });
  const plan = planTitleSlideDecks({
    schedule: sched, binding: oneSpeakerBinding,
    layout: 'room-major',
    resolveSessionTitle: titleFor,
  });
  // No <eventName> wrapper — destination is the folder containing the
  // .eventSchedule; output lives directly inside it.
  assert.equal(plan.decks[0].outputPath,
    'breakout-1/MON/MON Room 1 Title Slides.pptx');
});

test('day-major path = <day>/<roomId>/<DAY> <ROOM> Title Slides.pptx', () => {
  const sched = schedule({
    name: 'Widget Conf',
    sessions: [session('MON', 'A', 'breakout-1', ['Alice'])],
  });
  const plan = planTitleSlideDecks({
    schedule: sched, binding: oneSpeakerBinding,
    layout: 'day-major',
    resolveSessionTitle: titleFor,
  });
  assert.equal(plan.decks[0].outputPath,
    'MON/breakout-1/MON Room 1 Title Slides.pptx');
});

test('Filename-unsafe characters in room name get scrubbed', () => {
  const sched = schedule({
    name: 'Bad/Name:1',
    rooms: [{ id: 'r1', name: 'Room*1?' }],
    sessions: [session('MON', 'A', 'r1', ['X'])],
  });
  const plan = planTitleSlideDecks({
    schedule: sched, binding: oneSpeakerBinding,
    layout: 'room-major',
    resolveSessionTitle: titleFor,
  });
  // Slashes/colons/asterisks/question-marks → underscores in filename.
  assert.ok(!/[\\/:*?"<>|]/.test(plan.decks[0].outputPath.split('/').pop()!),
    `filename has no unsafe chars; got ${plan.decks[0].outputPath}`);
  assert.equal(plan.decks[0].outputPath,
    'r1/MON/MON Room_1_ Title Slides.pptx');
});

// ───── Sorting / ordering ──────────────────────────────────────────────

test('Sessions within a deck are sorted by timeslot (per timeslotsByDay)', () => {
  const sched = schedule({
    timeslotsByDay: { MON: ['A', 'B', 'C'] },
    sessions: [
      session('MON', 'B', 'breakout-1', ['B-speaker']),
      session('MON', 'A', 'breakout-1', ['A-speaker']),
      session('MON', 'C', 'breakout-1', ['C-speaker']),
    ],
  });
  const plan = planTitleSlideDecks({
    schedule: sched, binding: oneSpeakerBinding,
    layout: 'room-major',
    resolveSessionTitle: titleFor,
  });
  assert.equal(plan.decks.length, 1);
  const tsOrder = plan.decks[0].sessions.map((s) => s.timeslot);
  assert.deepEqual(tsOrder, ['A', 'B', 'C']);
});

test('day-major plan iteration: day outer, room inner', () => {
  const sched = schedule({
    sessions: [
      session('MON', 'A', 'plenary', ['P-MON']),
      session('TUE', 'A', 'plenary', ['P-TUE']),
      session('MON', 'A', 'breakout-1', ['B-MON']),
      session('TUE', 'A', 'breakout-1', ['B-TUE']),
    ],
  });
  const plan = planTitleSlideDecks({
    schedule: sched, binding: oneSpeakerBinding,
    layout: 'day-major',
    resolveSessionTitle: titleFor,
  });
  // Expected order: MON plenary, MON breakout-1, TUE plenary, TUE breakout-1
  const keys = plan.decks.map((d) => `${d.day}/${d.roomId}`);
  assert.deepEqual(keys, [
    'MON/plenary', 'MON/breakout-1',
    'TUE/plenary', 'TUE/breakout-1',
  ]);
});

test('room-major plan iteration: room outer, day inner', () => {
  const sched = schedule({
    sessions: [
      session('MON', 'A', 'plenary', ['P-MON']),
      session('TUE', 'A', 'plenary', ['P-TUE']),
      session('MON', 'A', 'breakout-1', ['B-MON']),
      session('TUE', 'A', 'breakout-1', ['B-TUE']),
    ],
  });
  const plan = planTitleSlideDecks({
    schedule: sched, binding: oneSpeakerBinding,
    layout: 'room-major',
    resolveSessionTitle: titleFor,
  });
  // Expected order: plenary MON, plenary TUE, breakout-1 MON, breakout-1 TUE
  const keys = plan.decks.map((d) => `${d.roomId}/${d.day}`);
  assert.deepEqual(keys, [
    'plenary/MON', 'plenary/TUE',
    'breakout-1/MON', 'breakout-1/TUE',
  ]);
});

// ───── Pagination integration ──────────────────────────────────────────

test('Pagination invoked: 5 speakers @ capacity 2 → 3 pages [2, 2, 1]', () => {
  const sched = schedule({
    sessions: [
      session('MON', 'A', 'breakout-1', ['A', 'B', 'C', 'D', 'E']),
    ],
  });
  const plan = planTitleSlideDecks({
    schedule: sched, binding: twoSpeakerBinding,
    layout: 'room-major',
    resolveSessionTitle: titleFor,
  });
  const pages = plan.decks[0].sessions[0].speakerPages;
  assert.deepEqual(pages.map((p) => p.length), [2, 2, 1]);
});

test('distributeEvenly flag in binding flows through to pagination', () => {
  const sched = schedule({
    sessions: [
      session('MON', 'A', 'breakout-1', ['A', 'B', 'C', 'D', 'E']),
    ],
  });
  const plan = planTitleSlideDecks({
    schedule: sched,
    binding: { ...twoSpeakerBinding, distributeEvenly: true },
    layout: 'room-major',
    resolveSessionTitle: titleFor,
  });
  // Evenly: 5 @ cap 2 → 3 pages of ceil(5/3) base 1, extra 2 → [2, 2, 1].
  // Same shape as fill in this case; check via the exposed flag.
  assert.equal(plan.distributeEvenly, true);
});

// ───── session.title resolution ────────────────────────────────────────

test('resolveSessionTitle is called and its return populates sessions[].title', () => {
  const sched = schedule({
    sessions: [session('MON', 'A', 'breakout-1', ['X'])],
  });
  const plan = planTitleSlideDecks({
    schedule: sched, binding: oneSpeakerBinding,
    layout: 'room-major',
    resolveSessionTitle: (s) => `CUSTOM ${s.timeslot}`,
  });
  assert.equal(plan.decks[0].sessions[0].title, 'CUSTOM A');
});

// ───── Missing-room fallback ───────────────────────────────────────────

test('Session references a deleted room: roomName falls back to roomId', () => {
  const sched = schedule({
    rooms: [],   // no rooms at all
    sessions: [session('MON', 'A', 'orphan-room', ['X'])],
  });
  const plan = planTitleSlideDecks({
    schedule: sched, binding: oneSpeakerBinding,
    layout: 'room-major',
    resolveSessionTitle: titleFor,
  });
  assert.equal(plan.decks[0].roomName, 'orphan-room');
});

// ───── displayKey ──────────────────────────────────────────────────────

test('displayKey is "DAY / Room Name" for the result modal', () => {
  const sched = schedule({
    sessions: [session('MON', 'A', 'breakout-1', ['X'])],
  });
  const plan = planTitleSlideDecks({
    schedule: sched, binding: oneSpeakerBinding,
    layout: 'room-major',
    resolveSessionTitle: titleFor,
  });
  assert.equal(plan.decks[0].displayKey, 'MON / Room 1');
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
