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
  roomSyncTemplate,
  sessionSpeakerFilename,
  type FolderGenInput,
} from '../scripts/generate-event-folders';
import { expandRoomSyncVariable, parseSyncConfigText } from '../src/sync/configParse';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

/**
 * The plan's `files[]` now mixes per-speaker placeholders and per-room
 * .roomSync templates. Existing assertions that wanted "every placeholder"
 * go through this filter so they aren't surprised by the new entries; the
 * placeholder extension is always provided (default `.pptx`).
 */
function placeholdersOnly(
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
  extension: string,
): Array<{ path: string; bytes: Uint8Array }> {
  return files.filter((f) => f.path.endsWith(extension));
}

function roomSyncFilesOnly(
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
): Array<{ path: string; bytes: Uint8Array }> {
  return files.filter((f) => f.path.endsWith('.roomSync'));
}

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

test('one placeholder per speaker slot across all sessions', () => {
  const { schedule, plan } = planFor('room-major');
  const expected = schedule.sessions.reduce((acc, s) => acc + s.speakers.length, 0);
  // plan.files now also includes per-room .roomSync templates appended
  // after the placeholders — filter to placeholder extension before the
  // count compare.
  assert.equal(placeholdersOnly(plan.files, '.pptx').length, expected);
});

test('filenames carry day / room-upper / timeslot / slot / speaker name + extension', () => {
  const { plan } = planFor('room-major');
  // Pull one placeholder filename and sanity-check the shape — the first
  // entry may now be a .roomSync template or a placeholder depending on
  // ordering, so we filter explicitly.
  const placeholders = placeholdersOnly(plan.files, '.pptx');
  const sample = placeholders[0].path.split('/').pop()!;
  // e.g. "MON BREAKOUT1 B 1 Alice Smith.pptx" or "MON PLENARY A 1 ...".
  assert.match(sample, /^(MON|TUE|WED) (PLENARY|BREAKOUT\d+) [A-Z] \d+ .+\.pptx$/);
});

test('filenames in a directory alpha-sort by slot order', () => {
  const { plan } = planFor('room-major');
  // Group placeholder files by directory; for any dir with 2+ entries the
  // sorted order must match the original speaker slot sequence (1, 2, 3, …).
  // .roomSync templates live at the event root, so filtering by extension
  // also keeps them out of this grouping.
  const byDir = new Map<string, string[]>();
  for (const f of placeholdersOnly(plan.files, '.pptx')) {
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
  // Only the speaker-slot placeholders should be zero-byte; .roomSync
  // templates always carry their JSONC body, so they're filtered out here.
  for (const f of placeholdersOnly(plan.files, '.pptx')) {
    assert.equal(f.bytes.length, 0, `expected zero-byte placeholder, got ${f.bytes.length}`);
  }
});

test('custom placeholder bytes are reused for every placeholder file', () => {
  const placeholderBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
  const { plan } = planFor('room-major', { placeholderBytes });
  for (const f of placeholdersOnly(plan.files, '.pptx')) {
    assert.equal(f.bytes, placeholderBytes, 'every placeholder should reference the same buffer');
  }
});

test('eventName override wins over the schedule config name', () => {
  const { plan } = planFor('day-major', { eventName: 'Override' });
  assert.equal(plan.eventRoot, '/tmp/x/Override');
});

test('extension flag drives the filename suffix', () => {
  const { plan } = planFor('room-major', { extension: '.bin' });
  for (const f of placeholdersOnly(plan.files, '.bin')) {
    assert.ok(f.path.endsWith('.bin'), `expected .bin suffix, got ${f.path}`);
  }
  // Sanity: there ARE placeholders (the filter didn't accidentally
  // remove everything).
  assert.ok(placeholdersOnly(plan.files, '.bin').length > 0);
});

test('extension without leading dot is normalised', () => {
  const { plan } = planFor('room-major', { extension: 'pdf' });
  const placeholders = placeholdersOnly(plan.files, '.pdf');
  assert.ok(placeholders.length > 0);
  for (const f of placeholders) {
    assert.ok(f.path.endsWith('.pdf'));
  }
});

test('wrapInEventFolder=false drops the <eventName> wrapper segment', () => {
  // The editor passes this flag so output lands directly in the folder
  // containing the .eventSchedule (which IS the event root). CLI keeps
  // the wrapper by default.
  const { plan } = planFor('room-major', { wrapInEventFolder: false });
  assert.equal(plan.eventRoot, '/tmp/x', 'no event-name suffix appended');
  // Every emitted dir + file starts at outRoot directly.
  for (const dir of plan.directories) {
    assert.ok(dir.startsWith('/tmp/x/'), `dir under outRoot: ${dir}`);
    assert.ok(!dir.includes('/TestEvent/'),
      `no event-name segment in ${dir}`);
  }
  for (const f of plan.files) {
    assert.ok(f.path.startsWith('/tmp/x/'), `file under outRoot: ${f.path}`);
    assert.ok(!f.path.includes('/TestEvent/'),
      `no event-name segment in ${f.path}`);
  }
});

test('wrapInEventFolder=true (default) keeps the wrapper — CLI behaviour preserved', () => {
  const { plan } = planFor('room-major');   // omits the option → defaults to true
  assert.equal(plan.eventRoot, '/tmp/x/TestEvent',
    'eventRoot keeps the <eventName> wrapper under outRoot');
});

// ───── .roomSync template emission (workspace-root variant) ──────────────

test('emits one <roomId>.roomSync template per unique room in the schedule', () => {
  const { schedule, plan } = planFor('room-major');
  // The schedule should list plenary + at least one breakout — every
  // room that hosts a session needs its own template.
  const expectedRoomIds = new Set(schedule.sessions.map((s) => s.roomId));
  const roomSyncFiles = roomSyncFilesOnly(plan.files);
  const emittedRoomIds = new Set(
    roomSyncFiles.map((f) => {
      const base = f.path.split('/').pop()!;
      return base.replace(/\.roomSync$/, '');
    }),
  );
  assert.deepEqual(
    [...emittedRoomIds].sort(),
    [...expectedRoomIds].sort(),
    'every roomId appearing in sessions should get a .roomSync template',
  );
});

test('.roomSync templates land at the event root, not nested under rooms', () => {
  // Workspace-root variant per M3 of room-sync-format-v1-plan.md: the
  // operator opens <eventRoot> as a workspace folder, and ${roomSync}
  // resolves to the filename prefix. Nested files would break that.
  const { plan } = planFor('room-major');
  for (const f of roomSyncFilesOnly(plan.files)) {
    const tail = f.path.slice(plan.eventRoot.length);
    // Expected shape: "/<roomId>.roomSync" — exactly one path segment.
    assert.match(tail, /^\/[^/]+\.roomSync$/, `unexpected nesting for ${f.path}`);
  }
});

test('.roomSync template parses cleanly with the relaxed empty-destinations rule', () => {
  // The generator emits `destinations: []` — the parser relaxation in
  // configParse.ts must accept this (it's the same parser the editor +
  // loader use). Round-tripping the bytes verifies the surface contract.
  const { plan } = planFor('room-major');
  const sample = roomSyncFilesOnly(plan.files)[0];
  const text = new TextDecoder().decode(sample.bytes);
  const parsed = parseSyncConfigText(text);
  assert.equal(parsed.kind, 'ok', `expected ok parse, got ${parsed.kind === 'error' ? parsed.error : '?'}`);
  if (parsed.kind === 'ok') {
    assert.deepEqual(parsed.config.destinations, []);
  }
});

test('.roomSync template preserves the ${roomSync} variable literally', () => {
  // The form editor reads the document text literally — the generator
  // must NOT pre-substitute ${roomSync}, otherwise the template would be
  // baked per-file and the operator couldn't see the variable in context.
  const { plan } = planFor('room-major');
  const sample = roomSyncFilesOnly(plan.files)[0];
  const text = new TextDecoder().decode(sample.bytes);
  assert.match(text, /\$\{roomSync\}/, 'template must contain a literal ${roomSync} token');
});

test('.roomSync template path-aliases resolve to **/<roomId> via expandRoomSyncVariable', () => {
  // End-to-end shape: pre-parse expansion (which is what the wired
  // loader does) replaces ${roomSync} with the roomId, producing the
  // resolved alias map the planner ultimately sees.
  const { plan } = planFor('room-major');
  for (const f of roomSyncFilesOnly(plan.files)) {
    const roomId = f.path.split('/').pop()!.replace(/\.roomSync$/, '');
    const rawText = new TextDecoder().decode(f.bytes);
    const expanded = expandRoomSyncVariable(rawText, roomId);
    const parsed = parseSyncConfigText(expanded);
    assert.equal(parsed.kind, 'ok');
    if (parsed.kind === 'ok') {
      assert.deepEqual(parsed.config.pathAliases, { [`**/${roomId}`]: '**' });
    }
  }
});

test('.roomSync emission is the same shape regardless of layout', () => {
  // Workspace-root templates aren't layout-dependent: they describe the
  // *destination*, not the source tree. Both room-major and day-major
  // runs should produce the same set of .roomSync files.
  const roomMajor = planFor('room-major');
  const dayMajor = planFor('day-major');
  const names = (p: typeof roomMajor.plan) =>
    roomSyncFilesOnly(p.files).map((f) => f.path.split('/').pop()!).sort();
  assert.deepEqual(names(roomMajor.plan), names(dayMajor.plan));
});

test('roomSyncTemplate body has empty destinations and the **/${roomSync} alias', () => {
  // Direct test of the helper — covers the case where someone needs the
  // template body outside the planEventFolders flow (e.g. a future CLI
  // that prints the template stdout-side).
  const body = roomSyncTemplate('breakout-7');
  // The string should mention the roomId in the operator-facing comment
  // (the variable resolution happens at load time, not in the template).
  assert.match(body, /breakout-7/);
  // Parser round-trip confirms the JSONC is valid and empty.
  const parsed = parseSyncConfigText(body);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind === 'ok') {
    assert.deepEqual(parsed.config.destinations, []);
    // Literal alias key is preserved (no pre-substitution).
    assert.ok('**/${roomSync}' in parsed.config.pathAliases);
    assert.equal(parsed.config.pathAliases['**/${roomSync}'], '**');
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
