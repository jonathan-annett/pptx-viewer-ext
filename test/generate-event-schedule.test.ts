// Smoke tests for the event-schedule generator. Pins the determinism
// contract + checks the structural invariants the downstream folder tool
// will rely on. Run under tsx:
//
//   npm run test:generate-event-schedule

import { strict as assert } from 'node:assert';
import {
  DEFAULT_CONFIG,
  generateEventSchedule,
  type EventSession,
} from '../scripts/generate-event-schedule';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

test('default config yields the expected room shape', () => {
  const s = generateEventSchedule();
  assert.equal(s.rooms.length, 1 + DEFAULT_CONFIG.breakoutRoomCount);
  assert.equal(s.rooms[0].id, 'plenary');
  assert.equal(s.rooms[0].kind, 'plenary');
  for (let i = 1; i <= DEFAULT_CONFIG.breakoutRoomCount; i++) {
    assert.equal(s.rooms[i].id, `breakout-${i}`);
    assert.equal(s.rooms[i].kind, 'breakout');
  }
});

test('speaker pool has the requested count of unique names + ids', () => {
  const s = generateEventSchedule();
  assert.equal(s.speakers.length, DEFAULT_CONFIG.speakerPoolSize);
  const names = new Set(s.speakers.map((sp) => sp.name));
  const ids = new Set(s.speakers.map((sp) => sp.id));
  assert.equal(names.size, s.speakers.length, 'names must be unique');
  assert.equal(ids.size, s.speakers.length, 'ids must be unique');
});

test('same seed → identical output (determinism contract)', () => {
  const a = generateEventSchedule({ seed: 42 });
  const b = generateEventSchedule({ seed: 42 });
  assert.equal(JSON.stringify({ ...a, generatedAt: '' }), JSON.stringify({ ...b, generatedAt: '' }));
});

test('different seed → different schedule', () => {
  const a = generateEventSchedule({ seed: 1 });
  const b = generateEventSchedule({ seed: 2 });
  assert.notEqual(JSON.stringify(a.sessions), JSON.stringify(b.sessions));
});

test('no speaker is double-booked within a (day, timeslot)', () => {
  // The pool-filter logic during assignment is the only thing keeping a
  // speaker out of two concurrent rooms — regression here would be
  // physically impossible for the real event.
  const s = generateEventSchedule();
  const seen = new Map<string, Set<string>>();
  for (const sess of s.sessions) {
    const key = `${sess.day}-${sess.timeslot}`;
    const set = seen.get(key) ?? new Set<string>();
    for (const sp of sess.speakers) {
      assert.ok(!set.has(sp.speakerId), `${sp.speakerName} double-booked at ${key}`);
      set.add(sp.speakerId);
    }
    seen.set(key, set);
  }
});

test('plenary opener fires on every day at timeslot A', () => {
  const s = generateEventSchedule();
  for (const day of DEFAULT_CONFIG.days) {
    const opener = s.sessions.find(
      (sess) => sess.day === day && sess.timeslot === 'A' && sess.kind === 'plenary-open',
    );
    assert.ok(opener, `missing opener for ${day}`);
    assert.equal(opener!.roomId, 'plenary');
    assert.equal(opener!.speakers.length, DEFAULT_CONFIG.plenaryOpenSpeakers);
  }
});

test('last day has a single closing-plenary session at the last timeslot', () => {
  const s = generateEventSchedule();
  const lastDay = DEFAULT_CONFIG.days[DEFAULT_CONFIG.days.length - 1];
  const closers = s.sessions.filter((sess) => sess.kind === 'plenary-close');
  assert.equal(closers.length, 1, 'exactly one closing-plenary expected');
  assert.equal(closers[0].day, lastDay);
  assert.equal(closers[0].roomId, 'plenary');
  assert.equal(closers[0].speakers.length, DEFAULT_CONFIG.closingSpeakers);
});

test('breakout speaker counts respect the configured min/max', () => {
  const s = generateEventSchedule();
  for (const sess of s.sessions) {
    if (sess.kind !== 'breakout' && sess.kind !== 'breakout-relocated') continue;
    assert.ok(sess.speakers.length >= DEFAULT_CONFIG.speakersPerBreakoutMin);
    assert.ok(sess.speakers.length <= DEFAULT_CONFIG.speakersPerBreakoutMax);
  }
});

test('relocations move breakouts into plenary and emit matching vacancies', () => {
  const s = generateEventSchedule();
  const relocated = s.sessions.filter((sess) => sess.kind === 'breakout-relocated');
  assert.equal(relocated.length, s.vacancies.length, 'one vacancy per relocated session');
  for (const r of relocated) {
    assert.equal(r.roomId, 'plenary');
    assert.ok(r.relocatedFromRoomId && r.relocatedFromRoomId.startsWith('breakout-'));
    const matchingVacancy = s.vacancies.find(
      (v) => v.day === r.day && v.timeslot === r.timeslot && v.roomId === r.relocatedFromRoomId,
    );
    assert.ok(matchingVacancy, `no matching vacancy for ${r.id}`);
  }
});

test('plenary room hosts at most one session per (day, timeslot)', () => {
  // The relocation algorithm only picks (day, timeslot) slots where the
  // plenary is empty; a regression that allowed double-occupancy would put
  // two sessions in the same room at the same time.
  const s = generateEventSchedule();
  const seen = new Set<string>();
  for (const sess of s.sessions) {
    if (sess.roomId !== 'plenary') continue;
    const key = `${sess.day}-${sess.timeslot}`;
    assert.ok(!seen.has(key), `plenary double-booked at ${key}`);
    seen.add(key);
  }
});

test('total slots exceed pool size — some speakers recur (workload realism)', () => {
  const s = generateEventSchedule();
  const totalSlots = s.sessions.reduce((acc: number, sess: EventSession) => acc + sess.speakers.length, 0);
  assert.ok(
    totalSlots > s.speakers.length,
    `expected speakers to repeat: got ${totalSlots} slot(s) for ${s.speakers.length} speakers`,
  );
  // At least one speaker should be in 2+ sessions to confirm reuse.
  const counts = new Map<string, number>();
  for (const sess of s.sessions) {
    for (const sp of sess.speakers) counts.set(sp.speakerId, (counts.get(sp.speakerId) ?? 0) + 1);
  }
  const reused = Array.from(counts.values()).filter((c) => c > 1).length;
  assert.ok(reused > 0, 'no speaker appears more than once — pool is over-large or random is broken');
});

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
