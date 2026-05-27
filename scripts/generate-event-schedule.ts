// Generate a randomised event schedule JSON for folder-sync testing.
//
// Why a generator: real conference layouts vary wildly (one event has clean
// per-room source folders; the next has a "by speaker" or "by day"
// structure), and we want a stable corpus of plausible-but-messy events to
// stress the folder-builder + sync engine against. This tool emits the
// abstract schedule only — a separate tool reads the JSON and materialises
// folders + files in whatever layout we want to exercise.
//
// Output shape is designed to be schedule-shaped, not folder-shaped: a flat
// `sessions[]` enumeration plus a flat `vacancies[]` for breakout rooms
// emptied by "popular elective" relocations. Speakers and rooms are kept
// separate so the folder tool can route by either dimension.
//
// CLI:
//   node --import tsx scripts/generate-event-schedule.ts [--seed N] [--out PATH]
//
// Run with `--out -` to emit to stdout. Otherwise writes a pretty-printed
// JSON file (default: event-schedule.json in cwd).
//
// Pure-function entry point `generateEventSchedule(config)` is exported so a
// future test under tsx can pin the determinism contract.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ───── Types ─────────────────────────────────────────────────────────────

export interface EventConfig {
  /** Reproducibility — same seed + config → same output. */
  seed: number;
  /** Human-readable event name; downstream tools use it as the top-level folder name. */
  name: string;
  /** Three-letter day labels, in order. */
  days: string[];
  /** Number of breakout rooms (plenary is implicit, +1 to this). */
  breakoutRoomCount: number;
  /** Speakers per opening-plenary session. */
  plenaryOpenSpeakers: number;
  /** Speakers in the final closing-plenary session. */
  closingSpeakers: number;
  /** Breakout sessions per day on days other than the last. */
  breakoutSessionsPerDay: number;
  /** Breakout sessions on the last day (one slot is closing plenary). */
  breakoutSessionsLastDay: number;
  /** Speaker pool size — number of unique people in the event. */
  speakerPoolSize: number;
  /** Inclusive min/max speakers in a single breakout session. */
  speakersPerBreakoutMin: number;
  speakersPerBreakoutMax: number;
  /**
   * Number of breakouts to randomly relocate into the plenary room ("popular
   * electives"). Each relocation vacates the originating breakout room for
   * that one timeslot. Capped at the number of eligible (day, timeslot) slots
   * available.
   */
  relocations: number;
}

export interface EventSpeaker {
  id: string;
  name: string;
}

export interface EventRoom {
  id: string;
  name: string;
  kind: 'plenary' | 'breakout';
}

export interface SessionSpeakerSlot {
  slot: number;
  speakerId: string;
  speakerName: string;
}

export type SessionKind =
  | 'plenary-open'
  | 'plenary-close'
  | 'breakout'
  | 'breakout-relocated';

export interface EventSession {
  /** Stable id: `${day}-${timeslot}-${roomId}` (post-relocation roomId). */
  id: string;
  day: string;
  timeslot: string;
  roomId: string;
  kind: SessionKind;
  /**
   * For relocated breakouts, the original breakout room id this session
   * "belongs to" in the schedule. Lets the folder tool route by source
   * room (e.g. "Breakout 3's deck even though it played in the plenary").
   */
  relocatedFromRoomId: string | null;
  speakers: SessionSpeakerSlot[];
}

export interface EventVacancy {
  day: string;
  timeslot: string;
  roomId: string;
  reason: 'relocated-to-plenary';
}

export interface EventSchedule {
  generatedAt: string;
  config: EventConfig;
  /** All days × timeslots, for tools that want to iterate the grid. */
  timeslots: string[];
  speakers: EventSpeaker[];
  rooms: EventRoom[];
  sessions: EventSession[];
  /** Breakout rooms made empty by a relocation. */
  vacancies: EventVacancy[];
}

// ───── Defaults ──────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: EventConfig = {
  seed: 1,
  name: 'Sample Conference',
  days: ['MON', 'TUE', 'WED'],
  breakoutRoomCount: 5,
  plenaryOpenSpeakers: 3,
  closingSpeakers: 3,
  breakoutSessionsPerDay: 3,
  breakoutSessionsLastDay: 2,
  speakerPoolSize: 25,
  speakersPerBreakoutMin: 1,
  speakersPerBreakoutMax: 3,
  relocations: 3,
};

// ───── PRNG (mulberry32, deterministic) ──────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, minIncl: number, maxIncl: number): number {
  return Math.floor(rng() * (maxIncl - minIncl + 1)) + minIncl;
}

function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickWithout<T>(pool: T[], excluded: Set<T>, count: number, rng: () => number): T[] {
  // Deterministic sampling without replacement that also avoids items the
  // caller has reserved for the timeslot. Returns up to `count` items —
  // fewer if the eligible pool is short (caller's problem to size things).
  const eligible = pool.filter((p) => !excluded.has(p));
  shuffleInPlace(eligible, rng);
  return eligible.slice(0, count);
}

// ───── Name pool ─────────────────────────────────────────────────────────
//
// First × last gives plenty of unique combinations from a small list. We
// keep it small enough that ~25 speakers always succeeds without picking the
// same first+last pair twice.

const FIRST_NAMES = [
  'Alex', 'Priya', 'Marcus', 'Yuki', 'Sofia', 'Daniel', 'Aisha', 'Ravi',
  'Elena', 'Tomás', 'Mei', 'Henrik', 'Zara', 'Kwame', 'Ingrid', 'Diego',
  'Naledi', 'Jasper', 'Olusola', 'Anya', 'Felix', 'Catalina', 'Idris',
  'Hana', 'Mohammed', 'Imani', 'Linus', 'Beatriz', 'Aarav', 'Saoirse',
  'Theo', 'Lina', 'Ezekiel', 'Wren', 'Nikolai',
];

const LAST_NAMES = [
  'Okafor', 'Lindberg', 'Patel', 'Ramirez', 'Nakamura', 'Volkov', 'Singh',
  'Mendez', 'Hassan', 'Schreiber', 'Tanaka', 'Adebayo', 'Ortiz', 'Dvorak',
  'Khoury', 'Salinas', 'Bauer', 'O’Connell', 'Andersson', 'Reyes',
  'Demir', 'Costa', 'Iwasaki', 'Bellamy', 'Cavalcanti', 'Holm', 'Sato',
  'Munro', 'Quintero', 'Yilmaz', 'Mwangi', 'Park', 'Vidal', 'Brennan',
];

function buildSpeakerPool(rng: () => number, count: number): EventSpeaker[] {
  const used = new Set<string>();
  const speakers: EventSpeaker[] = [];
  let safety = 10000;
  while (speakers.length < count && safety-- > 0) {
    const first = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)];
    const last = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)];
    const name = `${first} ${last}`;
    if (used.has(name)) continue;
    used.add(name);
    speakers.push({ id: `spk-${String(speakers.length + 1).padStart(2, '0')}`, name });
  }
  if (speakers.length < count) {
    throw new Error(
      `name pool too small to draw ${count} unique speakers ` +
        `(have ${FIRST_NAMES.length}×${LAST_NAMES.length} combos but ran the safety loop out)`,
    );
  }
  return speakers;
}

// ───── Schedule builder ──────────────────────────────────────────────────

/**
 * Each day's timeslots are global per day (not per room): A is the morning
 * opener for everyone, then B/C/D are concurrent breakout slots. On the
 * last day D is reused for the closing plenary, with one fewer breakout
 * slot to make room.
 */
function timeslotsForDay(config: EventConfig, dayIndex: number): string[] {
  const isLast = dayIndex === config.days.length - 1;
  const sessionsAfterOpening = isLast ? config.breakoutSessionsLastDay : config.breakoutSessionsPerDay;
  // A = opener, then n breakout slots, then (on last day) the closing slot.
  const slotCount = 1 + sessionsAfterOpening + (isLast ? 1 : 0);
  const out: string[] = [];
  for (let i = 0; i < slotCount; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

function allTimeslotLetters(config: EventConfig): string[] {
  // Union of every day's slot letters (the longest day determines this).
  const set = new Set<string>();
  for (let d = 0; d < config.days.length; d++) {
    for (const t of timeslotsForDay(config, d)) set.add(t);
  }
  return Array.from(set).sort();
}

/**
 * Pure generator — given a config, returns a fully-populated schedule.
 * Deterministic for a given seed. Validates speaker non-double-booking
 * within each (day, timeslot) at assignment time.
 */
export function generateEventSchedule(input: Partial<EventConfig> = {}): EventSchedule {
  const config: EventConfig = { ...DEFAULT_CONFIG, ...input };
  const rng = mulberry32(config.seed);

  // ── speakers
  const speakers = buildSpeakerPool(rng, config.speakerPoolSize);
  const speakerIds = speakers.map((s) => s.id);
  const speakerById = new Map(speakers.map((s) => [s.id, s]));

  // ── rooms
  const rooms: EventRoom[] = [{ id: 'plenary', name: 'Plenary Hall', kind: 'plenary' }];
  for (let i = 1; i <= config.breakoutRoomCount; i++) {
    rooms.push({ id: `breakout-${i}`, name: `Breakout Room ${i}`, kind: 'breakout' });
  }
  const breakoutRoomIds = rooms.filter((r) => r.kind === 'breakout').map((r) => r.id);

  // ── pre-relocation schedule: every breakout slot in its own breakout room
  //
  // Build sessions per (day, timeslot), tracking per-timeslot speaker
  // assignments so the same person can't be scheduled into two concurrent
  // rooms. A speaker has no overall cap — pool size < total slots, so the
  // same names recur across the event.
  const sessions: EventSession[] = [];
  for (let dayIdx = 0; dayIdx < config.days.length; dayIdx++) {
    const day = config.days[dayIdx];
    const isLastDay = dayIdx === config.days.length - 1;
    const slots = timeslotsForDay(config, dayIdx);

    for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
      const timeslot = slots[slotIdx];
      const isOpener = slotIdx === 0;
      const isCloser = isLastDay && slotIdx === slots.length - 1;
      const usedAtThisTimeslot = new Set<string>();

      if (isOpener) {
        const picks = pickWithout(speakerIds, usedAtThisTimeslot, config.plenaryOpenSpeakers, rng);
        for (const id of picks) usedAtThisTimeslot.add(id);
        sessions.push({
          id: `${day}-${timeslot}-plenary`,
          day,
          timeslot,
          roomId: 'plenary',
          kind: 'plenary-open',
          relocatedFromRoomId: null,
          speakers: picks.map((id, i) => ({
            slot: i + 1,
            speakerId: id,
            speakerName: speakerById.get(id)!.name,
          })),
        });
        continue;
      }

      if (isCloser) {
        const picks = pickWithout(speakerIds, usedAtThisTimeslot, config.closingSpeakers, rng);
        for (const id of picks) usedAtThisTimeslot.add(id);
        sessions.push({
          id: `${day}-${timeslot}-plenary`,
          day,
          timeslot,
          roomId: 'plenary',
          kind: 'plenary-close',
          relocatedFromRoomId: null,
          speakers: picks.map((id, i) => ({
            slot: i + 1,
            speakerId: id,
            speakerName: speakerById.get(id)!.name,
          })),
        });
        continue;
      }

      // Breakout slot — every breakout room runs a session. Order matters
      // for determinism: iterate rooms in id-order.
      for (const roomId of breakoutRoomIds) {
        const speakerCount = randInt(rng, config.speakersPerBreakoutMin, config.speakersPerBreakoutMax);
        const picks = pickWithout(speakerIds, usedAtThisTimeslot, speakerCount, rng);
        for (const id of picks) usedAtThisTimeslot.add(id);
        sessions.push({
          id: `${day}-${timeslot}-${roomId}`,
          day,
          timeslot,
          roomId,
          kind: 'breakout',
          relocatedFromRoomId: null,
          speakers: picks.map((id, i) => ({
            slot: i + 1,
            speakerId: id,
            speakerName: speakerById.get(id)!.name,
          })),
        });
      }
    }
  }

  // ── relocations: pull some breakout sessions into the plenary room
  //
  // Eligible candidates: any breakout session whose (day, timeslot) doesn't
  // already host a plenary session. Pick `config.relocations` at random
  // without replacement. The relocated session takes over the plenary
  // room for that one timeslot; the original breakout room becomes vacant.
  const plenaryOccupied = new Set<string>(); // `${day}-${timeslot}`
  for (const s of sessions) {
    if (s.roomId === 'plenary') plenaryOccupied.add(`${s.day}-${s.timeslot}`);
  }
  const relocationCandidates = sessions.filter(
    (s) => s.kind === 'breakout' && !plenaryOccupied.has(`${s.day}-${s.timeslot}`),
  );
  // Dedupe candidates by (day, timeslot) — only one breakout per (day, timeslot)
  // can move into the plenary (it's one room). Random per-timeslot pick.
  const byTimeslot = new Map<string, EventSession[]>();
  for (const c of relocationCandidates) {
    const key = `${c.day}-${c.timeslot}`;
    const list = byTimeslot.get(key) ?? [];
    list.push(c);
    byTimeslot.set(key, list);
  }
  const timeslotKeys = shuffleInPlace(Array.from(byTimeslot.keys()), rng);
  const requested = Math.min(config.relocations, timeslotKeys.length);
  const vacancies: EventVacancy[] = [];
  for (let i = 0; i < requested; i++) {
    const key = timeslotKeys[i];
    const candidates = byTimeslot.get(key)!;
    const chosen = candidates[Math.floor(rng() * candidates.length)];
    vacancies.push({
      day: chosen.day,
      timeslot: chosen.timeslot,
      roomId: chosen.roomId,
      reason: 'relocated-to-plenary',
    });
    chosen.relocatedFromRoomId = chosen.roomId;
    chosen.roomId = 'plenary';
    chosen.kind = 'breakout-relocated';
    chosen.id = `${chosen.day}-${chosen.timeslot}-plenary`;
  }

  // Sort sessions canonically: by day order, timeslot, then roomId.
  const dayRank = new Map(config.days.map((d, i) => [d, i]));
  sessions.sort((a, b) => {
    const da = dayRank.get(a.day) ?? 0;
    const db = dayRank.get(b.day) ?? 0;
    if (da !== db) return da - db;
    if (a.timeslot !== b.timeslot) return a.timeslot < b.timeslot ? -1 : 1;
    return a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0;
  });

  return {
    generatedAt: new Date().toISOString(),
    config,
    timeslots: allTimeslotLetters(config),
    speakers,
    rooms,
    sessions,
    vacancies,
  };
}

// ───── CLI ───────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { seed?: number; name?: string; out: string } {
  let seed: number | undefined;
  let name: string | undefined;
  let out = 'event-schedule.json';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed') {
      const v = argv[++i];
      if (!v) throw new Error('--seed needs a number');
      seed = Number(v);
      if (!Number.isFinite(seed)) throw new Error(`--seed must be numeric, got ${v}`);
    } else if (a === '--name') {
      const v = argv[++i];
      if (!v) throw new Error('--name needs a value');
      name = v;
    } else if (a === '--out') {
      const v = argv[++i];
      if (!v) throw new Error('--out needs a path (or "-" for stdout)');
      out = v;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: generate-event-schedule [--seed N] [--name STR] [--out PATH|-]\n' +
          '  --seed N    deterministic PRNG seed (default: 1)\n' +
          '  --name STR  event name (default: "Sample Conference")\n' +
          '  --out PATH  output file, or "-" for stdout (default: event-schedule.json)',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { seed, name, out };
}

// Only run the CLI when this file is the entry point — keeps the module
// safely importable from tests.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { seed, name, out } = parseArgs(process.argv.slice(2));
  const overrides: Partial<EventConfig> = {};
  if (seed !== undefined) overrides.seed = seed;
  if (name !== undefined) overrides.name = name;
  const schedule = generateEventSchedule(overrides);
  const json = JSON.stringify(schedule, null, 2) + '\n';
  if (out === '-') {
    process.stdout.write(json);
  } else {
    const abs = resolve(out);
    writeFileSync(abs, json, 'utf8');
    console.error(
      `Wrote ${schedule.sessions.length} session(s), ${schedule.speakers.length} speaker(s), ` +
        `${schedule.vacancies.length} vacanc${schedule.vacancies.length === 1 ? 'y' : 'ies'} → ${abs}`,
    );
  }
}
