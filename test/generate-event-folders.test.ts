// Smoke tests for the event-folder planner. Verifies path shape for both
// layouts, filename sort-order within a session, relocation placement,
// placeholder bytes, and the room-major vs day-major distinction. Pure
// planning only — no filesystem touch.
//
// Run with: npm run test:generate-event-folders

import { strict as assert } from 'node:assert';
import { generateEventSchedule } from '../scripts/generate-event-schedule';
import {
  planEventFolders,
  sessionSpeakerFilename,
  type FolderGenInput,
} from '../scripts/generate-event-folders';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

function planFor(
  layout: 'room-major' | 'day-major',
  extras: Partial<FolderGenInput> = {},
): { schedule: ReturnType<typeof generateEventSchedule>; plan: ReturnType<typeof planEventFolders> } {
  const schedule = generateEventSchedule({ seed: 7, name: 'TestEvent' });
  return {
    schedule,
    plan: planEventFolders({
      schedule,
      layout,
      outRoot: '/tmp/x',
      ...extras,
    }),
  };
}

test('room-major: every dir starts with eventRoot/<room>/<day>/<timeslot>', () => {
  const { plan } = planFor('room-major');
  assert.equal(plan.eventRoot, '/tmp/x/TestEvent');
  for (const d of plan.directories) {
    // Strip eventRoot + leading slash to inspect the path tail.
    const tail: string[] = d.slice(plan.eventRoot.length + 1).split('/');
    assert.equal(tail.length, 3, `expected 3 segments, got ${tail.length} in ${d}`);
    // First segment is a room (id form: "plenary" or "breakout-N").
    assert.ok(tail[0] === 'plenary' || /^breakout-\d+$/.test(tail[0]), `bad room: ${tail[0]}`);
    // Second is the day label, third is the timeslot letter.
    assert.match(tail[1], /^[A-Z]+$/);
    assert.match(tail[2], /^[A-Z]$/);
  }
});

test('day-major: every dir starts with eventRoot/<day>/<room>/<timeslot>', () => {
  const { plan } = planFor('day-major');
  for (const d of plan.directories) {
    const tail: string[] = d.slice(plan.eventRoot.length + 1).split('/');
    assert.equal(tail.length, 3);
    assert.match(tail[0], /^[A-Z]+$/);
    assert.ok(tail[1] === 'plenary' || /^breakout-\d+$/.test(tail[1]));
    assert.match(tail[2], /^[A-Z]$/);
  }
});

test('one file per speaker slot across all sessions', () => {
  const { schedule, plan } = planFor('room-major');
  const expected = schedule.sessions.reduce((acc, s) => acc + s.speakers.length, 0);
  assert.equal(plan.files.length, expected);
});

test('filenames carry day / room-upper / timeslot / slot / speaker name + extension', () => {
  const { plan } = planFor('room-major');
  // Pull one filename and sanity-check the shape.
  const sample = plan.files[0].path.split('/').pop()!;
  // e.g. "MON BREAKOUT1 B 1 Alice Smith.pptx" or "MON PLENARY A 1 ...".
  assert.match(sample, /^(MON|TUE|WED) (PLENARY|BREAKOUT\d+) [A-Z] \d+ .+\.pptx$/);
});

test('filenames in a directory alpha-sort by slot order', () => {
  const { plan } = planFor('room-major');
  // Group files by directory; for any dir with 2+ entries the sorted order
  // must match the original speaker slot sequence (1, 2, 3, …).
  const byDir = new Map<string, string[]>();
  for (const f of plan.files) {
    const lastSlash = f.path.lastIndexOf('/');
    const dir = f.path.slice(0, lastSlash);
    const name = f.path.slice(lastSlash + 1);
    const list = byDir.get(dir) ?? [];
    list.push(name);
    byDir.set(dir, list);
  }
  let checked = 0;
  for (const [, names] of byDir) {
    if (names.length < 2) continue;
    const sorted = [...names].sort();
    // Extract the slot number from each sorted filename and verify monotonic.
    const slots = sorted.map((n) => {
      const m = n.match(/^(?:MON|TUE|WED) (?:PLENARY|BREAKOUT\d+) [A-Z] (\d+) /);
      assert.ok(m, `couldn't parse slot from ${n}`);
      return Number(m![1]);
    });
    for (let i = 1; i < slots.length; i++) {
      assert.ok(slots[i] > slots[i - 1], `slots not monotonic when sorted: ${sorted.join(', ')}`);
    }
    checked++;
  }
  assert.ok(checked > 0, 'no multi-speaker session found — test would silently pass');
});

test('relocated breakouts land under the plenary folder (post-move room)', () => {
  // The "popular elective" relocation moves a breakout into the plenary
  // room. Folder layout follows the live roomId, not the originating
  // breakout — the deck is physically delivered to the plenary AV booth.
  const { schedule, plan } = planFor('room-major');
  const relocated = schedule.sessions.filter((s) => s.kind === 'breakout-relocated');
  assert.ok(relocated.length > 0, 'fixture should include at least one relocation');
  for (const r of relocated) {
    const dir = `/tmp/x/TestEvent/plenary/${r.day}/${r.timeslot}`;
    assert.ok(plan.directories.includes(dir), `expected plan to include ${dir}`);
    // Filename ROOM token must say PLENARY, not the originating BREAKOUT.
    const file = plan.files.find((f) => f.path.startsWith(dir + '/'));
    assert.ok(file, `expected at least one file under ${dir}`);
    assert.match(file!.path, / PLENARY /);
  }
});

test('zero-byte placeholders when no template is supplied', () => {
  const { plan } = planFor('room-major');
  for (const f of plan.files) {
    assert.equal(f.bytes.length, 0, `expected zero-byte placeholder, got ${f.bytes.length}`);
  }
});

test('custom placeholder bytes are reused for every file', () => {
  const placeholderBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
  const { plan } = planFor('room-major', { placeholderBytes });
  for (const f of plan.files) {
    assert.equal(f.bytes, placeholderBytes, 'every file should reference the same buffer');
  }
});

test('eventName override wins over the schedule config name', () => {
  const { plan } = planFor('day-major', { eventName: 'Override' });
  assert.equal(plan.eventRoot, '/tmp/x/Override');
});

test('extension flag drives the filename suffix', () => {
  const { plan } = planFor('room-major', { extension: '.bin' });
  for (const f of plan.files) {
    assert.ok(f.path.endsWith('.bin'), `expected .bin suffix, got ${f.path}`);
  }
});

test('extension without leading dot is normalised', () => {
  const { plan } = planFor('room-major', { extension: 'pdf' });
  for (const f of plan.files) {
    assert.ok(f.path.endsWith('.pdf'));
  }
});

test('helper: sessionSpeakerFilename composes the documented format', () => {
  // Lock down the format string — it's part of the public contract because
  // downstream tooling may parse these filenames back into metadata.
  const filename = sessionSpeakerFilename(
    {
      id: 'MON-B-breakout-1',
      day: 'MON',
      timeslot: 'B',
      roomId: 'breakout-1',
      kind: 'breakout',
      relocatedFromRoomId: null,
      speakers: [],
    },
    { slot: 2, speakerId: 'spk-02', speakerName: 'Anya Cavalcanti' },
    '.pptx',
  );
  assert.equal(filename, 'MON BREAKOUT1 B 2 Anya Cavalcanti.pptx');
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
