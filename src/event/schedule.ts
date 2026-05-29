// Pure event-schedule data model + deterministic generator. No Node imports
// so this module is safe to bundle into the web extension worker.
//
// Why this is pure: the same types + generator are consumed by
//   - `scripts/generate-event-schedule.ts` — CLI wrapper that writes JSON
//   - `scripts/generate-event-folders.ts` — folder-tree builder
//   - `src/event/eventEditor.ts` — the .eventSchedule custom editor
//   - `test/generate-event-schedule.test.ts` — determinism contract
//
// All FS / argv code lives in the script wrappers; this file only knows about
// the data shape and the deterministic random walk that produces it.

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
  /**
   * Optional default timeslot labels for newly-added days. When the user
   * adds a day to `days` (via the comma-separated input or a hand-edit),
   * the new day's `timeslotsByDay` entry is seeded with this list.
   * Absent / empty → fall through to the deterministic per-day list
   * `timeslotsForDay(config, dayIndex)` computes from the breakout knobs.
   *
   * Does NOT affect the generator's behaviour — `generateEventSchedule`
   * still produces its A-onward sequence based on the slot count.
   */
  defaultTimeslots?: string[];
  /**
   * Folder-tree shape for both Generate folders + Generate title slides.
   * Locked into the schedule because every downstream artifact (placeholder
   * paths, title-deck paths, hyperlink targets) depends on this choice
   * being stable. Default `'day-major'` for legacy files without the
   * field; the UI dropdown surfaces the resolved value.
   *
   *   - `day-major`: `<day>/<room>/<timeslot>/` — one day's rooms together.
   *   - `room-major`: `<room>/<day>/<timeslot>/` — one room's whole event.
   */
  layout?: 'day-major' | 'room-major';
  /**
   * Title-slide template binding. Set by the "Bind title-slide template"
   * action in the event editor; consumed by `buildTitleDeck` in
   * `titleSlides/pptxBuild.ts`. Absent means no template has been bound
   * for this event yet — the generate button is disabled in that state.
   */
  titleSlides?: TitleSlidesBinding;
}

/**
 * One-per-event template binding describing how to populate per-(room, day)
 * title decks. Lives under `EventConfig.titleSlides`.
 */
export interface TitleSlidesBinding {
  /** Path to the template `.pptx`, relative to the `.eventSchedule` file. */
  templatePath: string;
  /** Ordered field bindings. `role: 'speaker'` entries determine the
   *  per-slide speaker capacity — see `titleSlideCapacity` helper. */
  fields: TitleSlideFieldBinding[];
  /** Pagination behaviour when a session's speaker count exceeds capacity.
   *  `false` (default): fill to capacity, last page takes remainder.
   *  `true`: distribute as evenly as possible across pages. */
  distributeEvenly?: boolean;
}

/**
 * One binding from a role to a text frame on the template slide.
 * `frame` is the zero-based index into `TemplateInspectResult.textFrames`
 * (document order). Speaker bindings additionally carry:
 *   - `position`: required, 1-based slot index. Speaker positions
 *     determine which session speaker (speakers[0], speakers[1], …)
 *     lands in this frame, independent of document order. The binding
 *     UI enforces contiguity (Speaker N+1 unavailable until Speaker N
 *     is assigned).
 *   - `line`: optional, zero-based line within a multi-line frame.
 *     v1 substitutes line text but doesn't hyperlink line-bound
 *     speakers (per-line overlay deferred — see `pptxBuild.ts`).
 */
export type TitleSlideFieldBinding =
  | { role: 'sessionTitle'; frame: number }
  | { role: 'roomName';     frame: number }
  | { role: 'timeslot';     frame: number }
  | { role: 'day';          frame: number }
  | { role: 'speaker';      frame: number; position: number; line?: number };

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
   * Optional free-form meeting title. When empty / missing the editor
   * displays `kind` in its place — see `displayTitleForSession` in
   * scheduleData.ts. The field is preserved as-is on the file.
   */
  title?: string;
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
  /**
   * Per-day ordered timeslot labels. Authoritative for grid rendering and
   * for downstream tools that need a day's actual slot order (which may
   * diverge from `timeslotsForDay(config)` once the user adds / renames /
   * reorders labels). Optional on the type for back-compat with files
   * generated before this field existed; `ensureTimeslotsByDay` populates
   * it at parse time so the editor never sees the undefined case.
   */
  timeslotsByDay?: Record<string, string[]>;
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
export function timeslotsForDay(config: EventConfig, dayIndex: number): string[] {
  const isLast = dayIndex === config.days.length - 1;
  const sessionsAfterOpening = isLast ? config.breakoutSessionsLastDay : config.breakoutSessionsPerDay;
  // A = opener, then n breakout slots, then (on last day) the closing slot.
  const slotCount = 1 + sessionsAfterOpening + (isLast ? 1 : 0);
  const out: string[] = [];
  for (let i = 0; i < slotCount; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export function allTimeslotLetters(config: EventConfig): string[] {
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

  // Per-day timeslot labels. Each day's list is the deterministic set the
  // generator just used to lay out the sessions — the editor uses this same
  // list as the row order for the grid, and the user can later add / rename
  // / reorder per-day labels independently.
  const timeslotsByDay: Record<string, string[]> = {};
  for (let dayIdx = 0; dayIdx < config.days.length; dayIdx++) {
    timeslotsByDay[config.days[dayIdx]] = timeslotsForDay(config, dayIdx);
  }

  return {
    generatedAt: new Date().toISOString(),
    config,
    timeslotsByDay,
    speakers,
    rooms,
    sessions,
    vacancies,
  };
}
