// Pure planner for the title-slide generator.
//
// Takes a schedule + binding + layout choice, returns one DeckPlanEntry
// per (room, day) that has at least one session. Each entry carries:
//   - The output filename + path (layout-specific, forward-slash form)
//   - Sessions sorted in timeslot order with pre-paginated speakers
//   - Room + day display values (for substitution + thumbnail labels)
//
// No vscode imports. The wired generator (M4.4) walks the returned
// entries and turns them into `buildTitleDeck` inputs + filesystem
// writes.

import type { Layout } from '../eventFolders';
import type { EventSchedule, EventSession, EventRoom, TitleSlidesBinding } from '../schedule';
import { timeslotsForDayResolved } from '../scheduleData';
import { titleSlideCapacity } from './binding';
import { splitSpeakers } from './pagination';
import type { SessionForDeck } from './pptxBuild';

// ───── Types ─────────────────────────────────────────────────────────────

export interface DeckGenerationPlan {
  /** One entry per (room, day) with at least one session. Document-order
   *  is room-major or day-major depending on `layout`. */
  decks: DeckPlanEntry[];
  /** Speakers-per-slide capacity from the binding. Zero when no speaker
   *  bindings — caller surfaces this as an error before walking the plan. */
  capacity: number;
  /** distributeEvenly value used for pagination — exposed for the caller's
   *  result modal / log line. */
  distributeEvenly: boolean;
}

export interface DeckPlanEntry {
  /** Display key for status messages: e.g. "MON / Room 1". */
  displayKey: string;
  /** Forward-slash path relative to the event root, e.g.
   *  `room-1/MON/MON Room 1 Title Slides.pptx`. Caller joins with the
   *  user-picked destination URI. */
  outputPath: string;
  /** Day token (`session.day`). */
  day: string;
  /** Room display name (`EventRoom.name`). */
  roomName: string;
  /** Room id (kebab-case, for hyperlink-target filename composition
   *  via `eventFolders.sessionSpeakerFilename`). */
  roomId: string;
  /** Sessions for this (room, day) in timeslot order, pre-paginated. */
  sessions: SessionForDeck[];
}

export interface PlanInput {
  schedule: EventSchedule;
  binding: TitleSlidesBinding;
  layout: Layout;
  /** Extension for hyperlink target filenames (default `.pptx`). Matches
   *  what `eventFolders.planEventFolders` used to lay out placeholders. */
  extension?: string;
  /** Display-title resolver. Plumbed from `scheduleData.displayTitleForSession`
   *  so this module stays free of scheduleData's vscode-adjacent helpers
   *  (none today, but keeps the dependency arrow clean). */
  resolveSessionTitle: (session: EventSession) => string;
}

// ───── Public entry point ────────────────────────────────────────────────

export function planTitleSlideDecks(input: PlanInput): DeckGenerationPlan {
  const { schedule, binding, layout } = input;
  const distributeEvenly = binding.distributeEvenly === true;
  const capacity = titleSlideCapacity(binding);

  const roomById = new Map<string, EventRoom>();
  for (const r of schedule.rooms) roomById.set(r.id, r);

  // Group sessions by (roomId, day) preserving first-seen order.
  type Key = string;
  const groups = new Map<Key, { roomId: string; day: string; sessions: EventSession[] }>();
  const keyOf = (roomId: string, day: string) => `${roomId}\x1f${day}`;
  for (const s of schedule.sessions) {
    const k = keyOf(s.roomId, s.day);
    let g = groups.get(k);
    if (!g) {
      g = { roomId: s.roomId, day: s.day, sessions: [] };
      groups.set(k, g);
    }
    g.sessions.push(s);
  }

  // Order group iteration by the chosen layout. We materialise the iteration
  // order so the caller's result modal lists decks in a predictable order.
  const orderedKeys = orderGroupKeys(groups, schedule, layout);

  const decks: DeckPlanEntry[] = [];
  for (const k of orderedKeys) {
    const g = groups.get(k)!;
    const room = roomById.get(g.roomId);
    const roomName = room?.name ?? g.roomId;   // fall back to id if room was deleted but session remains
    // Sort sessions within this (room, day) by the day's timeslot order.
    const slotOrder = timeslotIndex(schedule, g.day);
    const sortedSessions = [...g.sessions].sort(
      (a, b) => (slotOrder.get(a.timeslot) ?? 9999) - (slotOrder.get(b.timeslot) ?? 9999),
    );
    const sessionsForDeck: SessionForDeck[] = sortedSessions.map((session) => ({
      title: input.resolveSessionTitle(session),
      timeslot: session.timeslot,
      speakerPages: splitSpeakers(session.speakers, capacity, distributeEvenly),
      session,
    }));
    decks.push({
      displayKey: `${g.day} / ${roomName}`,
      outputPath: composeOutputPath(layout, g.roomId, g.day, roomName),
      day: g.day,
      roomName,
      roomId: g.roomId,
      sessions: sessionsForDeck,
    });
  }

  return { decks, capacity, distributeEvenly };
}

// ───── Path composition ──────────────────────────────────────────────────

/**
 * Forward-slash path RELATIVE to the destination root (the folder
 * containing the `.eventSchedule`). Mirrors `eventFolders.sessionDirectory`
 * so the title deck lands in the parent folder of the timeslot
 * directories — where the hyperlinks resolve relative to.
 *
 *   room-major: <roomId>/<day>/<DAY> <ROOM> Title Slides.pptx
 *   day-major:  <day>/<roomId>/<DAY> <ROOM> Title Slides.pptx
 */
function composeOutputPath(
  layout: Layout,
  roomId: string,
  day: string,
  roomName: string,
): string {
  const filename = `${day} ${filenameSafe(roomName)} Title Slides.pptx`;
  return layout === 'room-major'
    ? `${roomId}/${day}/${filename}`
    : `${day}/${roomId}/${filename}`;
}

/** Replace filesystem-unsafe characters with underscores; trim. */
function filenameSafe(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

// ───── Group ordering + timeslot index ──────────────────────────────────

function orderGroupKeys(
  groups: Map<string, { roomId: string; day: string }>,
  schedule: EventSchedule,
  layout: Layout,
): string[] {
  const dayOrder = new Map<string, number>();
  for (let i = 0; i < schedule.config.days.length; i++) {
    dayOrder.set(schedule.config.days[i], i);
  }
  const roomOrder = new Map<string, number>();
  for (let i = 0; i < schedule.rooms.length; i++) {
    roomOrder.set(schedule.rooms[i].id, i);
  }
  const keys = [...groups.keys()];
  keys.sort((ka, kb) => {
    const a = groups.get(ka)!;
    const b = groups.get(kb)!;
    const da = dayOrder.get(a.day) ?? 9999;
    const db = dayOrder.get(b.day) ?? 9999;
    const ra = roomOrder.get(a.roomId) ?? 9999;
    const rb = roomOrder.get(b.roomId) ?? 9999;
    if (layout === 'day-major') {
      if (da !== db) return da - db;
      return ra - rb;
    }
    if (ra !== rb) return ra - rb;
    return da - db;
  });
  return keys;
}

function timeslotIndex(schedule: EventSchedule, day: string): Map<string, number> {
  const slots = timeslotsForDayResolved(schedule, day);
  const idx = new Map<string, number>();
  slots.forEach((s, i) => idx.set(s, i));
  return idx;
}
