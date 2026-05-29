// Pure parse / marshal / mutate helpers for an `.eventSchedule` document.
//
// The schedule shape lives in `./schedule.ts` — this module owns *editing*:
// the operations the custom editor invokes when the user adds a speaker,
// renames a room, or rewires a session. Every helper is total: invalid input
// surfaces as a parse error result rather than throwing, so the editor can
// render a clear diagnostic banner instead of crashing.
//
// All mutators are *immutable* — they return a new EventSchedule. Lets the
// editor diff old vs. new for undo / change-tracking later without retaining
// the input.

import {
  DEFAULT_CONFIG,
  generateEventSchedule,
  timeslotsForDay,
  type EventConfig,
  type EventRoom,
  type EventSchedule,
  type EventSession,
  type EventSpeaker,
  type EventVacancy,
  type SessionKind,
  type SessionSpeakerSlot,
  type TitleSlidesBinding,
} from './schedule';

export interface ScheduleParseResult {
  schedule: EventSchedule;
  errors: string[];
}

/**
 * Parse JSON text into an EventSchedule. On any structural error returns
 * `emptySchedule()` plus a list of human-readable error messages — the
 * caller surfaces them in a banner rather than failing the open.
 */
export function parseSchedule(text: string): ScheduleParseResult {
  if (text.trim() === '') {
    return { schedule: emptySchedule(), errors: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      schedule: emptySchedule(),
      errors: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      schedule: emptySchedule(),
      errors: ['top-level value must be an object'],
    };
  }
  const errors: string[] = [];
  const obj = raw as Record<string, unknown>;

  const config = parseConfig(obj.config, errors);
  const speakers = parseSpeakers(obj.speakers, errors);
  const rooms = parseRooms(obj.rooms, errors);
  const sessions = parseSessions(obj.sessions, errors);
  const vacancies = parseVacancies(obj.vacancies, errors);
  const timeslotsByDay = parseTimeslotsByDay(obj.timeslotsByDay, errors);
  const generatedAt =
    typeof obj.generatedAt === 'string' ? obj.generatedAt : new Date().toISOString();

  // Drop any legacy top-level `timeslots` field if the file carried one —
  // the per-day list is authoritative now. The renderer never reads the
  // legacy field, the marshaler never emits it. Old files round-trip with
  // it silently stripped.
  return {
    schedule: ensureTimeslotsByDay({
      generatedAt,
      config,
      timeslotsByDay,
      speakers,
      rooms,
      sessions,
      vacancies,
    }),
    errors,
  };
}

/**
 * Marshal a schedule back to pretty-printed JSON text with trailing newline.
 *
 * Sessions with an empty / undefined `title` are emitted without the field,
 * so files generated before titles existed (and untouched files in the
 * test corpus) keep their minimal shape. `timeslotsByDay` is always
 * emitted once populated — `parseSchedule` populates it via
 * `ensureTimeslotsByDay`, so the first save of a legacy file does write
 * the per-day list out, and subsequent reads see it directly.
 */
export function marshalSchedule(schedule: EventSchedule): string {
  // Filter undefined / empty-string titles out of session entries so the
  // serialised form stays clean.
  const sessions = schedule.sessions.map((sess) => {
    const trimmed = sess.title?.trim();
    if (!trimmed) {
      const { title: _omit, ...rest } = sess;
      return rest;
    }
    return { ...sess, title: trimmed };
  });
  const out: Record<string, unknown> = {
    generatedAt: schedule.generatedAt,
    config: schedule.config,
  };
  if (schedule.timeslotsByDay) out.timeslotsByDay = schedule.timeslotsByDay;
  out.speakers = schedule.speakers;
  out.rooms = schedule.rooms;
  out.sessions = sessions;
  out.vacancies = schedule.vacancies;
  return JSON.stringify(out, null, 2) + '\n';
}

/**
 * Build an empty-but-valid schedule. Used as the initial document for a
 * freshly-created `.eventSchedule` file, and as the parse-failure fallback.
 * Speakers/rooms/sessions all empty; config inherits DEFAULT_CONFIG.
 */
export function emptySchedule(): EventSchedule {
  const config: EventConfig = { ...DEFAULT_CONFIG };
  return ensureTimeslotsByDay({
    generatedAt: new Date().toISOString(),
    config,
    speakers: [],
    rooms: [],
    sessions: [],
    vacancies: [],
  });
}

// ───── Mutators ──────────────────────────────────────────────────────────

/** Update the human-readable event name (also stored on `config.name`). */
export function setEventName(schedule: EventSchedule, name: string): EventSchedule {
  return { ...schedule, config: { ...schedule.config, name } };
}

/**
 * Resolve the layout used by both generators. Default `'day-major'` for
 * schedules that don't carry the field (legacy + freshly-created files).
 */
export function resolveLayout(schedule: EventSchedule): 'day-major' | 'room-major' {
  return schedule.config.layout ?? 'day-major';
}

/** Set the folder-tree layout (`day-major` or `room-major`) on the config. */
export function setEventLayout(
  schedule: EventSchedule,
  layout: 'day-major' | 'room-major',
): EventSchedule {
  return { ...schedule, config: { ...schedule.config, layout } };
}

/**
 * Write or clear the title-slide template binding on the event config.
 * Pass `undefined` to remove the binding entirely (the field becomes
 * absent from the serialised JSON rather than `null`).
 */
export function setTitleSlidesBinding(
  schedule: EventSchedule,
  binding: TitleSlidesBinding | undefined,
): EventSchedule {
  const nextConfig: EventConfig = { ...schedule.config };
  if (binding) {
    nextConfig.titleSlides = binding;
  } else {
    delete nextConfig.titleSlides;
  }
  return { ...schedule, config: nextConfig };
}

/** Replace the days list (preserves session day labels even if they vanish — caller's responsibility to cascade if desired). */
export function setDays(schedule: EventSchedule, days: string[]): EventSchedule {
  return { ...schedule, config: { ...schedule.config, days: [...days] } };
}

/**
 * Apply `config.defaultTimeslots` to every day in `config.days` by
 * positional rename. Pure relabeling — no sessions or vacancies are ever
 * dropped:
 *
 *   - At position i: if old and new differ, rename old → new (sessions
 *     and vacancies at that label get rewritten).
 *   - Slots past the new list's length: kept as-is on the day. The
 *     intent is "rename the slots", not "trim the day".
 *   - Slots past the old list's length: appended onto the day's list
 *     (no session cascade needed — they're new empty rows).
 *
 * No-op when `defaultTimeslots` is empty / missing — leaves existing
 * days alone.
 */
export function applyDefaultTimeslotsToAllDays(schedule: EventSchedule): EventSchedule {
  const defaults = schedule.config.defaultTimeslots;
  if (!Array.isArray(defaults) || defaults.length === 0) return schedule;
  const work = ensureTimeslotsByDay(schedule);
  const newByDay: Record<string, string[]> = { ...work.timeslotsByDay };
  const remapByDay = new Map<string, Map<string, string>>();
  for (const day of work.config.days) {
    const oldList = newByDay[day] ?? [];
    const { newList, remap } = applyPositionalRename(oldList, defaults);
    newByDay[day] = newList;
    remapByDay.set(day, remap);
  }
  const nextSessions = work.sessions.map((s) => {
    const remap = remapByDay.get(s.day);
    if (!remap) return s;
    const target = remap.get(s.timeslot);
    if (!target) return s;
    return { ...s, timeslot: target, id: `${s.day}-${target}-${s.roomId}` };
  });
  const nextVacancies = work.vacancies.map((v) => {
    const remap = remapByDay.get(v.day);
    if (!remap) return v;
    const target = remap.get(v.timeslot);
    if (!target) return v;
    return { ...v, timeslot: target };
  });
  return {
    ...work,
    timeslotsByDay: newByDay,
    sessions: nextSessions,
    vacancies: nextVacancies,
  };
}

/**
 * Walk old + new lists position-by-position; produce the day's new
 * label list and the rename map that cascades into sessions.
 *
 *   - Both lists carry a label at position i: keep newList[i] as the
 *     day's label; if it differs from oldList[i], record the rename.
 *   - oldList has a label at position i, newList doesn't: keep the old
 *     label (extras at the tail of an existing day stay put).
 *   - newList has a label at position i, oldList doesn't: append it.
 *
 * The remap only contains positions where labels actually change, so a
 * caller iterating sessions can detect "no change" by an absent key.
 */
function applyPositionalRename(
  oldList: readonly string[],
  newList: readonly string[],
): { newList: string[]; remap: Map<string, string> } {
  const out: string[] = [];
  const remap = new Map<string, string>();
  const maxLen = Math.max(oldList.length, newList.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLabel = oldList[i];
    const newLabel = newList[i];
    if (oldLabel && newLabel) {
      out.push(newLabel);
      if (oldLabel !== newLabel) remap.set(oldLabel, newLabel);
    } else if (oldLabel) {
      out.push(oldLabel);
    } else if (newLabel) {
      out.push(newLabel);
    }
  }
  return { newList: out, remap };
}

/**
 * Set the default timeslot labels used when ensureTimeslotsByDay seeds a
 * newly-added day. Each label is trimmed; empties + duplicates dropped;
 * invalid labels (filename-hostile chars) silently no-op the whole call
 * to keep a stale-tab post from corrupting the field. Empty cleaned list
 * clears the field (so the helper falls back to config-derived seeding).
 */
export function setDefaultTimeslots(
  schedule: EventSchedule,
  labels: string[],
): EventSchedule {
  const cleaned = labels.map((l) => l.trim()).filter((l) => l.length > 0);
  for (const l of cleaned) {
    if (!isValidTimeslotLabel(l)) return schedule;
  }
  const seen = new Set<string>();
  const unique = cleaned.filter((l) => {
    if (seen.has(l)) return false;
    seen.add(l);
    return true;
  });
  return {
    ...schedule,
    config: {
      ...schedule.config,
      defaultTimeslots: unique.length > 0 ? unique : undefined,
    },
  };
}

export function addSpeaker(schedule: EventSchedule, name: string): EventSchedule {
  const trimmed = name.trim();
  if (!trimmed) return schedule;
  const id = nextSpeakerId(schedule.speakers);
  const next: EventSpeaker = { id, name: trimmed };
  return { ...schedule, speakers: [...schedule.speakers, next] };
}

/**
 * Bulk-add speakers — typically driven by a multi-line paste into the
 * "add speaker" input. Each name flows through `addSpeaker` so trimming,
 * empty-skip, and sequential id assignment all carry through in a single
 * round-trip. The caller doesn't pay the per-line write+refresh cost,
 * which avoids a parse→mutate→write race against the in-memory document.
 */
export function addSpeakers(schedule: EventSchedule, names: readonly string[]): EventSchedule {
  return names.reduce((acc, name) => addSpeaker(acc, name), schedule);
}

export function renameSpeaker(
  schedule: EventSchedule,
  speakerId: string,
  newName: string,
): EventSchedule {
  const trimmed = newName.trim();
  if (!trimmed) return schedule;
  const speakers = schedule.speakers.map((s) =>
    s.id === speakerId ? { ...s, name: trimmed } : s,
  );
  // Cascade name into every session-slot that references this id so the
  // file stays self-consistent without forcing the editor to denormalise.
  const sessions = schedule.sessions.map((session) => ({
    ...session,
    speakers: session.speakers.map((slot) =>
      slot.speakerId === speakerId ? { ...slot, speakerName: trimmed } : slot,
    ),
  }));
  return { ...schedule, speakers, sessions };
}

export function removeSpeaker(schedule: EventSchedule, speakerId: string): EventSchedule {
  const speakers = schedule.speakers.filter((s) => s.id !== speakerId);
  // Drop the speaker from every session they were in. Slot numbers stay
  // intact (gaps are fine; the renderer doesn't rely on contiguity).
  const sessions = schedule.sessions.map((session) => ({
    ...session,
    speakers: session.speakers.filter((slot) => slot.speakerId !== speakerId),
  }));
  return { ...schedule, speakers, sessions };
}

export function addRoom(
  schedule: EventSchedule,
  args: { name: string; kind?: 'breakout' | 'plenary' },
): EventSchedule {
  const trimmed = args.name.trim();
  if (!trimmed) return schedule;
  const kind = args.kind ?? 'breakout';
  const id = nextRoomId(schedule.rooms, kind);
  const next: EventRoom = { id, name: trimmed, kind };
  return { ...schedule, rooms: [...schedule.rooms, next] };
}

/**
 * Bulk-add rooms — same shape as addSpeakers. All entries share the
 * given `kind` (the "add room" UI surfaces one dropdown per paste).
 * Each name flows through `addRoom`, so trimming + empty-skip +
 * sequential id assignment carry through.
 */
export function addRooms(
  schedule: EventSchedule,
  args: { names: readonly string[]; kind?: 'breakout' | 'plenary' },
): EventSchedule {
  const kind = args.kind ?? 'breakout';
  return args.names.reduce((acc, name) => addRoom(acc, { name, kind }), schedule);
}

export function renameRoom(
  schedule: EventSchedule,
  roomId: string,
  newName: string,
): EventSchedule {
  const trimmed = newName.trim();
  if (!trimmed) return schedule;
  const rooms = schedule.rooms.map((r) =>
    r.id === roomId ? { ...r, name: trimmed } : r,
  );
  return { ...schedule, rooms };
}

export function removeRoom(schedule: EventSchedule, roomId: string): EventSchedule {
  const rooms = schedule.rooms.filter((r) => r.id !== roomId);
  // Drop every session that was hosted in this room. Manifest-style cascade
  // would be friendlier (e.g. mark sessions orphaned) but adds UI surface;
  // v1 keeps it simple.
  const sessions = schedule.sessions.filter((s) => s.roomId !== roomId);
  // Vacancies referencing this room are no longer meaningful.
  const vacancies = schedule.vacancies.filter((v) => v.roomId !== roomId);
  return { ...schedule, rooms, sessions, vacancies };
}

export interface AddSessionInput {
  day: string;
  timeslot: string;
  roomId: string;
  kind: SessionKind;
  speakerIds?: string[];
}

export function addSession(
  schedule: EventSchedule,
  input: AddSessionInput,
): EventSchedule {
  // Refuse if a session already occupies that (day, timeslot, room).
  const occupied = schedule.sessions.some(
    (s) => s.day === input.day && s.timeslot === input.timeslot && s.roomId === input.roomId,
  );
  if (occupied) return schedule;
  const speakerById = new Map(schedule.speakers.map((s) => [s.id, s]));
  const speakers: SessionSpeakerSlot[] = (input.speakerIds ?? []).map((speakerId, i) => ({
    slot: i + 1,
    speakerId,
    speakerName: speakerById.get(speakerId)?.name ?? speakerId,
  }));
  const next: EventSession = {
    id: `${input.day}-${input.timeslot}-${input.roomId}`,
    day: input.day,
    timeslot: input.timeslot,
    roomId: input.roomId,
    kind: input.kind,
    relocatedFromRoomId: null,
    speakers,
  };
  return { ...schedule, sessions: sortSessions(schedule, [...schedule.sessions, next]) };
}

export function removeSession(schedule: EventSchedule, sessionId: string): EventSchedule {
  return { ...schedule, sessions: schedule.sessions.filter((s) => s.id !== sessionId) };
}

export function setSessionSpeakers(
  schedule: EventSchedule,
  sessionId: string,
  speakerIds: string[],
): EventSchedule {
  const speakerById = new Map(schedule.speakers.map((s) => [s.id, s]));
  // Drop duplicates defensively — the chip UI prevents this, but a hand-edit
  // or a stale postMessage could land an id twice. First occurrence wins so
  // a user-visible reorder is honoured.
  const seen = new Set<string>();
  const unique = speakerIds.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const sessions = schedule.sessions.map((s) => {
    if (s.id !== sessionId) return s;
    const speakers: SessionSpeakerSlot[] = unique.map((speakerId, i) => ({
      slot: i + 1,
      speakerId,
      speakerName: speakerById.get(speakerId)?.name ?? speakerId,
    }));
    return { ...s, speakers };
  });
  return { ...schedule, sessions };
}

// ───── Bulk replace via name paste ──────────────────────────────────────

/**
 * A single side-effect of `replaceSessionSpeakersByNames`: a speaker who
 * used to be in another session at the same (day, timeslot) and had to
 * move because the paste claimed them. The wired layer surfaces these in
 * a modal so the operator sees what just happened.
 */
export interface ReplaceByNamesConflict {
  speakerId: string;
  speakerName: string;
  fromRoomId: string;
  fromRoomName: string;
  day: string;
  timeslot: string;
}

export interface ReplaceSessionSpeakersByNamesResult {
  schedule: EventSchedule;
  conflicts: ReplaceByNamesConflict[];
  /** Speakers created by this paste (names that didn't match the pool). */
  addedSpeakers: EventSpeaker[];
}

/**
 * Replace a session's speakers with a list of names. Names are matched
 * case-insensitively against the existing pool; unknown names are
 * appended to the pool as new speakers (so the operator can build a
 * schedule from a roster paste without first populating the speaker
 * list). Duplicates within the paste are coalesced to one assignment.
 *
 * Same-timeslot conflicts: if any resolved speaker is currently in
 * another session sharing (this.day, this.timeslot), they're removed
 * from that other session — the paste wins. The displaced
 * (speaker × old session × old room) tuples are returned so the
 * wired layer can show a "John Smith was removed from Breakout 1 at
 * MON A" modal.
 *
 * Returns the original schedule + empty conflicts when the sessionId
 * doesn't match (defensive against stale messages).
 */
export function replaceSessionSpeakersByNames(
  schedule: EventSchedule,
  sessionId: string,
  names: readonly string[],
): ReplaceSessionSpeakersByNamesResult {
  const session = schedule.sessions.find((s) => s.id === sessionId);
  if (!session) {
    return { schedule, conflicts: [], addedSpeakers: [] };
  }

  const cleanedNames = names.map((n) => n.trim()).filter((n) => n.length > 0);
  if (cleanedNames.length === 0) {
    return { schedule, conflicts: [], addedSpeakers: [] };
  }

  // Case-insensitive lookup against the current pool. Lower-case key.
  const speakerByLowerName = new Map<string, EventSpeaker>();
  for (const sp of schedule.speakers) {
    speakerByLowerName.set(sp.name.trim().toLowerCase(), sp);
  }

  // Resolve each pasted name to a speaker id, threading through addSpeaker
  // so newly-added ones get sequential ids consistent with the rest of the
  // pool. Dedup within the paste — first occurrence wins.
  let work = schedule;
  const addedSpeakers: EventSpeaker[] = [];
  const resolvedIds: string[] = [];
  const seenIds = new Set<string>();

  for (const name of cleanedNames) {
    const key = name.toLowerCase();
    let speaker = speakerByLowerName.get(key);
    if (!speaker) {
      // Unknown name → add to pool. addSpeaker handles the sequential
      // spk-NN id and the trim. Pick the newest entry off the result.
      const before = work.speakers.length;
      work = addSpeaker(work, name);
      if (work.speakers.length > before) {
        speaker = work.speakers[work.speakers.length - 1];
        speakerByLowerName.set(key, speaker);
        addedSpeakers.push(speaker);
      }
    }
    if (speaker && !seenIds.has(speaker.id)) {
      resolvedIds.push(speaker.id);
      seenIds.add(speaker.id);
    }
  }

  // Build conflicts + new sessions in one pass. A "conflict" is a speaker
  // assignment in another session at the same (day, timeslot) that we're
  // about to break to satisfy the paste.
  const roomById = new Map(work.rooms.map((r) => [r.id, r]));
  const speakerById = new Map(work.speakers.map((s) => [s.id, s]));
  const conflicts: ReplaceByNamesConflict[] = [];

  const nextSessions = work.sessions.map((s) => {
    if (s.id === sessionId) {
      // Target session — replace speakers with the resolved list in
      // paste order. Slot numbers re-number from 1.
      return {
        ...s,
        speakers: resolvedIds.map((id, i) => ({
          slot: i + 1,
          speakerId: id,
          speakerName: speakerById.get(id)?.name ?? id,
        })),
      };
    }
    if (s.day !== session.day || s.timeslot !== session.timeslot) {
      return s;
    }
    // Sibling session at the same (day, timeslot): drop any conflicting
    // ids, record the displacement.
    let displaced = false;
    const filtered = s.speakers.filter((slot) => {
      if (!seenIds.has(slot.speakerId)) return true;
      displaced = true;
      const room = roomById.get(s.roomId);
      conflicts.push({
        speakerId: slot.speakerId,
        speakerName: slot.speakerName,
        fromRoomId: s.roomId,
        fromRoomName: room?.name ?? s.roomId,
        day: s.day,
        timeslot: s.timeslot,
      });
      return false;
    });
    if (!displaced) return s;
    // Slot numbers: keep their original slot indices intact — gaps are
    // fine, matching the existing removeSpeaker convention.
    return { ...s, speakers: filtered };
  });

  return {
    schedule: { ...work, sessions: nextSessions },
    conflicts,
    addedSpeakers,
  };
}

/**
 * Speaker IDs that may be added to the session at `(day, timeslot)` without
 * double-booking. A speaker is *eligible* iff they're not already assigned
 * to any OTHER session sharing the same (day, timeslot). The current
 * session's existing speakers are still eligible — they're already there,
 * and we don't want to filter them out of their own roster.
 *
 * Returns speaker IDs (not names) in pool order, so the renderer can decide
 * how to display them.
 */
export function eligibleSpeakersForSession(
  schedule: EventSchedule,
  day: string,
  timeslot: string,
  currentSessionId?: string,
): string[] {
  const blocked = new Set<string>();
  for (const sess of schedule.sessions) {
    if (sess.day !== day || sess.timeslot !== timeslot) continue;
    if (currentSessionId && sess.id === currentSessionId) continue;
    for (const slot of sess.speakers) blocked.add(slot.speakerId);
  }
  return schedule.speakers
    .filter((sp) => !blocked.has(sp.id))
    .map((sp) => sp.id);
}

export function setSessionKind(
  schedule: EventSchedule,
  sessionId: string,
  kind: SessionKind,
): EventSchedule {
  const sessions = schedule.sessions.map((s) =>
    s.id === sessionId ? { ...s, kind } : s,
  );
  return { ...schedule, sessions };
}

/**
 * Replace the schedule's generator config + regenerate. Used by the
 * Regenerate Tools section. Caller is responsible for the placeholder
 * guard — this helper never refuses to overwrite.
 */
export function regenerateFromConfig(
  config: Partial<EventConfig>,
): EventSchedule {
  return generateEventSchedule(config);
}

// ───── helpers ──────────────────────────────────────────────────────────

function nextSpeakerId(existing: EventSpeaker[]): string {
  let max = 0;
  for (const s of existing) {
    const m = /^spk-(\d+)$/.exec(s.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `spk-${String(max + 1).padStart(2, '0')}`;
}

function nextRoomId(existing: EventRoom[], kind: 'breakout' | 'plenary'): string {
  if (kind === 'plenary') {
    // Plenary is conventionally a singleton with id 'plenary'. If one
    // already exists, fall back to a numbered alternative.
    if (!existing.some((r) => r.id === 'plenary')) return 'plenary';
    let n = 2;
    while (existing.some((r) => r.id === `plenary-${n}`)) n++;
    return `plenary-${n}`;
  }
  let n = 1;
  while (existing.some((r) => r.id === `breakout-${n}`)) n++;
  return `breakout-${n}`;
}

function sortSessions(schedule: EventSchedule, sessions: EventSession[]): EventSession[] {
  const dayRank = new Map(schedule.config.days.map((d, i) => [d, i]));
  return [...sessions].sort((a, b) => {
    const da = dayRank.get(a.day) ?? 999;
    const db = dayRank.get(b.day) ?? 999;
    if (da !== db) return da - db;
    if (a.timeslot !== b.timeslot) return a.timeslot < b.timeslot ? -1 : 1;
    return a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0;
  });
}

// ───── per-field parsers ────────────────────────────────────────────────

function parseConfig(raw: unknown, errors: string[]): EventConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) errors.push('config must be an object — using defaults');
    return { ...DEFAULT_CONFIG };
  }
  const c = raw as Record<string, unknown>;
  const result: EventConfig = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(DEFAULT_CONFIG) as (keyof EventConfig)[]) {
    const v = c[k];
    if (v === undefined) continue;
    if (k === 'name' && typeof v === 'string') {
      result.name = v;
    } else if (k === 'days' && Array.isArray(v)) {
      result.days = v.filter((d): d is string => typeof d === 'string');
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      // All non-string config fields are numbers — assignment is type-safe
      // because the `keyof EventConfig` walks the canonical default shape.
      (result as unknown as Record<string, unknown>)[k] = v;
    }
  }
  // `defaultTimeslots` is optional → not in DEFAULT_CONFIG, so the loop
  // above doesn't see it. Pick it up separately. Only adopt the value
  // when it's a non-empty array of strings; empty / malformed leaves
  // the field undefined so ensureTimeslotsByDay falls through to the
  // config-derived list.
  if (Array.isArray(c.defaultTimeslots)) {
    const arr = c.defaultTimeslots.filter((v): v is string => typeof v === 'string');
    if (arr.length > 0) result.defaultTimeslots = arr;
  }
  // `layout` is optional with a 'day-major' fallback applied at use-time
  // (see `resolveLayout`). Pick up only valid values here so a corrupt
  // string in the file doesn't poison downstream code.
  if (c.layout === 'day-major' || c.layout === 'room-major') {
    result.layout = c.layout;
  }
  // `titleSlides` is also optional + not in DEFAULT_CONFIG. Pick it up
  // verbatim when shape-valid; bail to undefined otherwise. The wired
  // binding flow rebuilds the binding on each save so a corrupted
  // value here is recoverable via re-binding.
  const ts = parseTitleSlidesBinding(c.titleSlides, errors);
  if (ts) result.titleSlides = ts;
  return result;
}

function parseTitleSlidesBinding(raw: unknown, errors: string[]): TitleSlidesBinding | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('config.titleSlides must be an object — ignoring');
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.templatePath !== 'string' || !Array.isArray(r.fields)) {
    errors.push('config.titleSlides needs templatePath (string) and fields (array) — ignoring');
    return undefined;
  }
  const validRoles = new Set(['sessionTitle', 'roomName', 'timeslot', 'day', 'speaker']);
  const fields: TitleSlidesBinding['fields'] = [];
  for (const entry of r.fields) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.role !== 'string' || !validRoles.has(e.role)) continue;
    if (typeof e.frame !== 'number' || !Number.isFinite(e.frame) || e.frame < 0) continue;
    if (e.role === 'speaker') {
      // `position` is required for speaker bindings — drop entries that
      // lack a valid value. The binding UI always writes a position; the
      // only way to land here without one is a hand-edit, in which case
      // dropping is safer than silently inventing an order.
      if (typeof e.position !== 'number' || !Number.isFinite(e.position) || e.position < 1) {
        continue;
      }
      const f: TitleSlidesBinding['fields'][number] = {
        role: 'speaker',
        frame: e.frame,
        position: e.position,
      };
      if (typeof e.line === 'number' && Number.isFinite(e.line) && e.line >= 0) {
        f.line = e.line;
      }
      fields.push(f);
    } else {
      fields.push({ role: e.role as 'sessionTitle' | 'roomName' | 'timeslot' | 'day', frame: e.frame });
    }
  }
  const binding: TitleSlidesBinding = { templatePath: r.templatePath, fields };
  if (r.distributeEvenly === true) binding.distributeEvenly = true;
  return binding;
}

function parseSpeakers(raw: unknown, errors: string[]): EventSpeaker[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) errors.push('speakers must be an array — using empty list');
    return [];
  }
  const out: EventSpeaker[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || typeof e.name !== 'string') continue;
    out.push({ id: e.id, name: e.name });
  }
  return out;
}

function parseRooms(raw: unknown, errors: string[]): EventRoom[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) errors.push('rooms must be an array — using empty list');
    return [];
  }
  const out: EventRoom[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || typeof e.name !== 'string') continue;
    const kind = e.kind === 'plenary' ? 'plenary' : 'breakout';
    out.push({ id: e.id, name: e.name, kind });
  }
  return out;
}

function parseSessions(raw: unknown, errors: string[]): EventSession[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) errors.push('sessions must be an array — using empty list');
    return [];
  }
  const out: EventSession[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.id !== 'string' ||
      typeof e.day !== 'string' ||
      typeof e.timeslot !== 'string' ||
      typeof e.roomId !== 'string'
    )
      continue;
    const kind: SessionKind = isSessionKind(e.kind) ? e.kind : 'breakout';
    const relocatedFromRoomId =
      typeof e.relocatedFromRoomId === 'string' ? e.relocatedFromRoomId : null;
    const speakers = Array.isArray(e.speakers)
      ? (e.speakers as unknown[])
          .map((s, i) => {
            if (!s || typeof s !== 'object') return null;
            const sl = s as Record<string, unknown>;
            if (typeof sl.speakerId !== 'string') return null;
            return {
              slot: typeof sl.slot === 'number' ? sl.slot : i + 1,
              speakerId: sl.speakerId,
              speakerName: typeof sl.speakerName === 'string' ? sl.speakerName : sl.speakerId,
            } satisfies SessionSpeakerSlot;
          })
          .filter((x): x is SessionSpeakerSlot => x !== null)
      : [];
    const title = typeof e.title === 'string' && e.title.trim() !== '' ? e.title : undefined;
    out.push({
      id: e.id,
      day: e.day,
      timeslot: e.timeslot,
      roomId: e.roomId,
      kind,
      ...(title !== undefined ? { title } : {}),
      relocatedFromRoomId,
      speakers,
    });
  }
  return out;
}

function parseVacancies(raw: unknown, errors: string[]): EventVacancy[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) errors.push('vacancies must be an array — using empty list');
    return [];
  }
  const out: EventVacancy[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.day !== 'string' ||
      typeof e.timeslot !== 'string' ||
      typeof e.roomId !== 'string'
    )
      continue;
    out.push({
      day: e.day,
      timeslot: e.timeslot,
      roomId: e.roomId,
      reason: 'relocated-to-plenary',
    });
  }
  return out;
}

function isSessionKind(v: unknown): v is SessionKind {
  return (
    v === 'plenary-open' ||
    v === 'plenary-close' ||
    v === 'breakout' ||
    v === 'breakout-relocated'
  );
}

function parseTimeslotsByDay(
  raw: unknown,
  errors: string[],
): Record<string, string[]> | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('timeslotsByDay must be an object mapping day → label list — ignoring');
    return undefined;
  }
  const out: Record<string, string[]> = {};
  for (const [day, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      errors.push(`timeslotsByDay.${day} must be an array — ignoring`);
      continue;
    }
    out[day] = list.filter((v): v is string => typeof v === 'string');
  }
  return out;
}

// ───── Timeslot / title helpers (M1: pure, called by renderer + mutators)─

/**
 * Characters that would make a label unusable as a folder segment on any
 * of the platforms the sync engine writes to (Windows, macOS, Linux).
 * Also catches the empty-string and whitespace-only cases — every label
 * has to be a non-empty token the user typed.
 */
const FORBIDDEN_LABEL_CHARS = /[\\/:*?"<>|]/;

export function isValidTimeslotLabel(label: unknown): boolean {
  if (typeof label !== 'string') return false;
  if (label.length === 0) return false;
  if (label !== label.trim()) return false; // no leading/trailing whitespace
  if (FORBIDDEN_LABEL_CHARS.test(label)) return false;
  return true;
}

/**
 * Display string for a session header. Falls back to `kind` when the
 * authored `title` is empty / missing — the editor renders this in the
 * cell summary and uses it as the placeholder hint on the edit form's
 * title input.
 */
export function displayTitleForSession(session: EventSession): string {
  const trimmed = session.title?.trim();
  return trimmed || session.kind;
}

/**
 * True iff the schedule carries no authored content — no speakers, no
 * rooms, no sessions, no vacancies. Config, days, and per-day timeslot
 * labels are NOT considered authored content for this purpose: the user
 * may have customised them and still want Regenerate available (Clear
 * deliberately preserves them precisely so Regenerate becomes safe).
 *
 * Used by the editor to decide whether the Regenerate Tools section is
 * safe to surface — and by the wired layer as its belt-and-braces refusal
 * if a stale tab tries to regenerate a populated schedule.
 */
export function isStructurallyEmpty(schedule: EventSchedule): boolean {
  return (
    schedule.speakers.length === 0 &&
    schedule.rooms.length === 0 &&
    schedule.sessions.length === 0 &&
    schedule.vacancies.length === 0
  );
}

/**
 * The ordered timeslot list for a single day. Reads from
 * `schedule.timeslotsByDay[day]` when present; otherwise falls back to
 * the deterministic list `timeslotsForDay(config, dayIndex)` produces.
 * The renderer always calls this — never `schedule.timeslotsByDay[day]`
 * directly — so a parse failure that drops the field doesn't leave the
 * grid empty.
 */
export function timeslotsForDayResolved(
  schedule: EventSchedule,
  day: string,
): string[] {
  const list = schedule.timeslotsByDay?.[day];
  if (Array.isArray(list)) return list;
  const idx = schedule.config.days.indexOf(day);
  if (idx === -1) return [];
  return timeslotsForDay(schedule.config, idx);
}

/**
 * Return a schedule whose `timeslotsByDay` has an entry for every
 * configured day. Existing entries are preserved as-is; days the file
 * didn't pin (the legacy case, before this field existed) get the
 * deterministic generator-derived list. Idempotent — running on a
 * schedule that already has every day filled returns an equivalent
 * value with the same per-day arrays.
 */
export function ensureTimeslotsByDay(schedule: EventSchedule): EventSchedule {
  const current = schedule.timeslotsByDay ?? {};
  const next: Record<string, string[]> = {};
  let changed = false;
  for (let i = 0; i < schedule.config.days.length; i++) {
    const day = schedule.config.days[i];
    if (Array.isArray(current[day])) {
      next[day] = current[day];
    } else {
      // Seed a missing day from config.defaultTimeslots if the user has
      // set one (lets them name the slots once and have new days inherit
      // those labels); otherwise fall through to the deterministic
      // per-config list timeslotsForDay produces from the breakout knobs.
      const defaults = schedule.config.defaultTimeslots;
      if (Array.isArray(defaults) && defaults.length > 0) {
        next[day] = [...defaults];
      } else {
        next[day] = timeslotsForDay(schedule.config, i);
      }
      changed = true;
    }
  }
  // Preserve any user-pinned days that aren't in config.days (e.g. the
  // user removed a day from config but the per-day list hasn't been
  // cleaned up yet). Cheap, and avoids losing user intent.
  for (const [day, list] of Object.entries(current)) {
    if (!(day in next) && Array.isArray(list)) {
      next[day] = list;
    }
  }
  if (!changed && schedule.timeslotsByDay && sameKeys(schedule.timeslotsByDay, next)) {
    return schedule;
  }
  return { ...schedule, timeslotsByDay: next };
}

function sameKeys(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) if (!(k in b)) return false;
  return true;
}

// ───── M1 mutators (pure, return new EventSchedule) ─────────────────────

/**
 * Wipe authored content. Preserves config (so the user keeps their event
 * name + day list + generator knobs) and per-day timeslot labels (the
 * user's authored structure of the schedule grid stays). Speakers, rooms,
 * sessions, and the vacancies derived from session relocations all go.
 *
 * After a Clear the file becomes a placeholder-shaped document the
 * Regenerate tool can fill back in.
 */
export function clearAll(schedule: EventSchedule): EventSchedule {
  return {
    ...schedule,
    speakers: [],
    rooms: [],
    sessions: [],
    vacancies: [],
  };
}

/**
 * Append a timeslot to a day's list.
 *
 *  - `label` provided: validated via `isValidTimeslotLabel`; refused
 *    silently if invalid or already present in the day.
 *  - `label` omitted: picks the next uppercase letter *after* the highest
 *    letter currently used in that day's list (so [A, C] → D, matching
 *    the "add to end" UX you specified). Falls back to `slot-N` when the
 *    alphabet runs out.
 *
 * No-op if the day isn't in `config.days` — adding labels to a
 * non-existent day would create orphan grid rows.
 */
export function addTimeslot(
  schedule: EventSchedule,
  day: string,
  label?: string,
): EventSchedule {
  if (!schedule.config.days.includes(day)) return schedule;
  const withByDay = ensureTimeslotsByDay(schedule);
  const current = withByDay.timeslotsByDay![day] ?? [];
  let chosen: string;
  if (label !== undefined) {
    if (!isValidTimeslotLabel(label)) return schedule;
    if (current.includes(label)) return schedule;
    chosen = label;
  } else {
    chosen = nextDefaultTimeslotLabel(current);
    if (current.includes(chosen)) return schedule; // defensive: nextDefault should never collide
  }
  return {
    ...withByDay,
    timeslotsByDay: { ...withByDay.timeslotsByDay, [day]: [...current, chosen] },
  };
}

/**
 * Drop a timeslot from a day's list. Cascades into sessions and vacancies
 * that referenced the (day, label) pair so the grid stays consistent.
 * No-op if the label isn't present.
 */
export function removeTimeslot(
  schedule: EventSchedule,
  day: string,
  label: string,
): EventSchedule {
  const withByDay = ensureTimeslotsByDay(schedule);
  const current = withByDay.timeslotsByDay![day];
  if (!Array.isArray(current) || !current.includes(label)) return schedule;
  const nextList = current.filter((l) => l !== label);
  const sessions = withByDay.sessions.filter(
    (s) => !(s.day === day && s.timeslot === label),
  );
  const vacancies = withByDay.vacancies.filter(
    (v) => !(v.day === day && v.timeslot === label),
  );
  return {
    ...withByDay,
    timeslotsByDay: { ...withByDay.timeslotsByDay, [day]: nextList },
    sessions,
    vacancies,
  };
}

/**
 * Replace a timeslot's label within one day. Refused silently if the new
 * label is invalid (`isValidTimeslotLabel`), unchanged, or already used
 * within the day. Cascades into sessions + vacancies at (day, oldLabel) —
 * their `timeslot` field is rewritten and their canonical id rebuilt.
 */
export function renameTimeslot(
  schedule: EventSchedule,
  day: string,
  oldLabel: string,
  newLabel: string,
): EventSchedule {
  if (!isValidTimeslotLabel(newLabel)) return schedule;
  if (oldLabel === newLabel) return schedule;
  const withByDay = ensureTimeslotsByDay(schedule);
  const current = withByDay.timeslotsByDay![day];
  if (!Array.isArray(current) || !current.includes(oldLabel)) return schedule;
  if (current.includes(newLabel)) return schedule;
  const nextList = current.map((l) => (l === oldLabel ? newLabel : l));
  const sessions = withByDay.sessions.map((s) =>
    s.day === day && s.timeslot === oldLabel
      ? { ...s, timeslot: newLabel, id: `${s.day}-${newLabel}-${s.roomId}` }
      : s,
  );
  const vacancies = withByDay.vacancies.map((v) =>
    v.day === day && v.timeslot === oldLabel ? { ...v, timeslot: newLabel } : v,
  );
  return {
    ...withByDay,
    timeslotsByDay: { ...withByDay.timeslotsByDay, [day]: nextList },
    sessions,
    vacancies,
  };
}

/**
 * Set or clear a session's free-form title. Empty / whitespace-only input
 * clears the field (stored as undefined so the marshaler omits it from
 * the file).
 */
export function setSessionTitle(
  schedule: EventSchedule,
  sessionId: string,
  title: string,
): EventSchedule {
  const trimmed = title.trim();
  const sessions = schedule.sessions.map((s) => {
    if (s.id !== sessionId) return s;
    if (trimmed === '') {
      const { title: _omit, ...rest } = s;
      return rest;
    }
    return { ...s, title: trimmed };
  });
  return { ...schedule, sessions };
}

/**
 * Replace a day's timeslot order. `newOrder` must be a permutation of
 * the day's existing list — same set of labels, possibly reshuffled.
 * Sessions stay at their (day, label) coordinates; only the grid's row
 * order changes, which the renderer picks up via `timeslotsForDayResolved`.
 *
 * Refused silently when `newOrder` isn't a permutation. The wired layer
 * should compute `newOrder` from a swap-by-index — the constraint is
 * defensive against a stale-tab message.
 */
export function reorderTimeslots(
  schedule: EventSchedule,
  day: string,
  newOrder: string[],
): EventSchedule {
  const withByDay = ensureTimeslotsByDay(schedule);
  const current = withByDay.timeslotsByDay![day];
  if (!Array.isArray(current)) return schedule;
  if (newOrder.length !== current.length) return schedule;
  const currentSet = new Set(current);
  const newSet = new Set(newOrder);
  if (newSet.size !== newOrder.length) return schedule; // duplicates
  for (const label of newOrder) {
    if (!currentSet.has(label)) return schedule;
  }
  return {
    ...withByDay,
    timeslotsByDay: { ...withByDay.timeslotsByDay, [day]: [...newOrder] },
  };
}

/**
 * Trade the session contents of two timeslots within one room on one day.
 * Three cases:
 *
 *   - Both filled: the two sessions swap timeslots. Each session's `id`
 *     is rebuilt from its new (day, timeslot, roomId) triple.
 *   - One filled, one empty: the filled session moves to the empty slot.
 *   - Both empty: no-op.
 *
 * The mutator does not enforce speaker-double-booking constraints — a
 * swap can in principle place a speaker in two rooms at the same
 * timeslot. The UI is expected to surface that out-of-band (out of scope
 * for v2; the existing eligibility filter only gates additions).
 */
export function swapSessionsInRoom(
  schedule: EventSchedule,
  day: string,
  roomId: string,
  labelA: string,
  labelB: string,
): EventSchedule {
  if (labelA === labelB) return schedule;
  const sessionA = schedule.sessions.find(
    (s) => s.day === day && s.roomId === roomId && s.timeslot === labelA,
  );
  const sessionB = schedule.sessions.find(
    (s) => s.day === day && s.roomId === roomId && s.timeslot === labelB,
  );
  if (!sessionA && !sessionB) return schedule;
  const sessions = schedule.sessions.map((s) => {
    if (sessionA && s.id === sessionA.id) {
      return { ...s, timeslot: labelB, id: `${day}-${labelB}-${roomId}` };
    }
    if (sessionB && s.id === sessionB.id) {
      return { ...s, timeslot: labelA, id: `${day}-${labelA}-${roomId}` };
    }
    return s;
  });
  return { ...schedule, sessions: sortSessions(schedule, sessions) };
}

// ───── default-label picker ─────────────────────────────────────────────

/**
 * Pick the next uppercase letter past the highest letter already in
 * `current`. Empty list → 'A'. [A, C] → 'D' (one past max, not the gap),
 * matching the "add to end" choice. Falls back to `slot-N` once the
 * alphabet runs out — N starts at the current list length + 1 and
 * advances until a free name is found, so the suffix is stable for the
 * common-case append-twice-in-a-row flow.
 */
function nextDefaultTimeslotLabel(current: readonly string[]): string {
  let maxCode = 64; // one less than 'A' (65) so empty → A
  for (const label of current) {
    if (label.length === 1) {
      const code = label.charCodeAt(0);
      if (code >= 65 && code <= 90 && code > maxCode) maxCode = code;
    }
  }
  if (maxCode < 90) {
    const candidate = String.fromCharCode(maxCode + 1);
    if (!current.includes(candidate)) return candidate;
  }
  let n = current.length + 1;
  while (current.includes(`slot-${n}`)) n++;
  return `slot-${n}`;
}
