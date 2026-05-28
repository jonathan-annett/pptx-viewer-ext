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
  allTimeslotLetters,
  generateEventSchedule,
  type EventConfig,
  type EventRoom,
  type EventSchedule,
  type EventSession,
  type EventSpeaker,
  type EventVacancy,
  type SessionKind,
  type SessionSpeakerSlot,
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
  const generatedAt =
    typeof obj.generatedAt === 'string' ? obj.generatedAt : new Date().toISOString();

  return {
    schedule: {
      generatedAt,
      config,
      timeslots: Array.isArray(obj.timeslots)
        ? (obj.timeslots as unknown[]).filter((t): t is string => typeof t === 'string')
        : allTimeslotLetters(config),
      speakers,
      rooms,
      sessions,
      vacancies,
    },
    errors,
  };
}

/** Marshal a schedule back to pretty-printed JSON text with trailing newline. */
export function marshalSchedule(schedule: EventSchedule): string {
  return JSON.stringify(schedule, null, 2) + '\n';
}

/**
 * Build an empty-but-valid schedule. Used as the initial document for a
 * freshly-created `.eventSchedule` file, and as the parse-failure fallback.
 * Speakers/rooms/sessions all empty; config inherits DEFAULT_CONFIG.
 */
export function emptySchedule(): EventSchedule {
  const config: EventConfig = { ...DEFAULT_CONFIG };
  return {
    generatedAt: new Date().toISOString(),
    config,
    timeslots: allTimeslotLetters(config),
    speakers: [],
    rooms: [],
    sessions: [],
    vacancies: [],
  };
}

// ───── Mutators ──────────────────────────────────────────────────────────

/** Update the human-readable event name (also stored on `config.name`). */
export function setEventName(schedule: EventSchedule, name: string): EventSchedule {
  return { ...schedule, config: { ...schedule.config, name } };
}

/** Replace the days list (preserves session day labels even if they vanish — caller's responsibility to cascade if desired). */
export function setDays(schedule: EventSchedule, days: string[]): EventSchedule {
  return { ...schedule, config: { ...schedule.config, days: [...days] } };
}

export function addSpeaker(schedule: EventSchedule, name: string): EventSchedule {
  const trimmed = name.trim();
  if (!trimmed) return schedule;
  const id = nextSpeakerId(schedule.speakers);
  const next: EventSpeaker = { id, name: trimmed };
  return { ...schedule, speakers: [...schedule.speakers, next] };
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
  return result;
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
    out.push({
      id: e.id,
      day: e.day,
      timeslot: e.timeslot,
      roomId: e.roomId,
      kind,
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
