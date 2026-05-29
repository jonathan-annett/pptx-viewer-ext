// Pure folder-tree planner for an event schedule. Web-extension-safe:
// no `node:fs`, no `node:path` — joins paths via a local forward-slash
// helper that works equally for POSIX filesystems and vscode URIs.
//
// Sits alongside ./schedule.ts (data model) and ./scheduleData.ts (parse /
// mutate) so the .eventSchedule custom editor can emit the folder tree
// in-browser, without shelling out to scripts/generate-event-folders.ts.
//
// The Node CLI at scripts/generate-event-folders.ts re-exports these
// symbols + adds the readFileSync / writeFileSync materialiser. Tests
// continue to import from the CLI module for backwards compatibility.

import type {
  EventSchedule,
  EventSession,
  SessionSpeakerSlot,
} from './schedule';

// ───── Types ─────────────────────────────────────────────────────────────

export type Layout = 'room-major' | 'day-major';

export interface FolderGenInput {
  schedule: EventSchedule;
  layout: Layout;
  /** Directory the event folder is created inside (e.g. "./events"). */
  outRoot: string;
  /** Optional override; falls back to schedule.config.name when undefined. */
  eventName?: string;
  /** File extension for speaker placeholders (default ".pptx"). */
  extension?: string;
  /** Bytes copied into every speaker placeholder. Empty buffer → zero-byte files. */
  placeholderBytes?: Uint8Array;
  /**
   * When true (default) the plan paths include the event name as a wrapper
   * segment under `outRoot` — natural for the CLI which writes to a shared
   * parent dir (`./events/<event>/<room>/<day>/`). When false, the wrapper
   * is omitted — the editor passes false so output lands directly in the
   * folder containing the `.eventSchedule` file (which IS the event root).
   */
  wrapInEventFolder?: boolean;
}

export interface FolderGenPlan {
  /** Path to the event root (outRoot/eventName). */
  eventRoot: string;
  /** Directories that need to exist before any file is written. Sorted. */
  directories: string[];
  /** Files to write. Order matches sessions × speaker slot. */
  files: Array<{ path: string; bytes: Uint8Array }>;
}

// ───── Pure planner ──────────────────────────────────────────────────────

const EMPTY_BYTES = new Uint8Array(0);
const UTF8 = new TextEncoder();

/**
 * Forward-slash path joiner. Skips empty parts (lets a caller pass `""`
 * as the root when it wants relative-segment output). Collapses runs
 * of slashes that would otherwise sneak in via concatenation. Works
 * for POSIX filesystems and for vscode URIs (which require `/`); the
 * Node CLI passes absolute roots like `/Users/foo/events` and gets
 * absolute paths back.
 */
function joinPath(...parts: string[]): string {
  const filtered = parts.filter((p) => p.length > 0);
  if (filtered.length === 0) return '';
  return filtered.join('/').replace(/\/+/g, '/');
}

/**
 * Pure: turn a schedule + layout choice into a list of dirs + files to
 * create. Doesn't touch the filesystem. The materialiser walks this plan
 * exactly — so what the tests verify here is what the CLI (or the
 * editor's Generate-folders button) writes.
 *
 * Output includes:
 *  - One directory per (room, day, timeslot) — see `sessionDirectory`.
 *  - One placeholder file per speaker slot inside that directory.
 *  - One `<roomId>.roomSync` template at the event root per unique room
 *    that appears in `schedule.sessions` (post-relocation roomId — so a
 *    relocated breakout shows up under the plenary's template).
 */
export function planEventFolders(input: FolderGenInput): FolderGenPlan {
  const { schedule, layout } = input;
  const eventName = input.eventName ?? schedule.config.name;
  const ext = normaliseExtension(input.extension ?? '.pptx');
  const bytes = input.placeholderBytes ?? EMPTY_BYTES;
  const wrap = input.wrapInEventFolder !== false;   // default true

  const eventRoot = wrap ? joinPath(input.outRoot, eventName) : input.outRoot;
  const dirs = new Set<string>();
  const files: FolderGenPlan['files'] = [];

  // Unique room ids — preserves first-seen order so the .roomSync files
  // sort the same way the schedule introduces them (typically plenary
  // first, breakout-1, breakout-2, …). Set-iteration order is insertion
  // order in JS, so a plain Set works.
  const roomIds = new Set<string>();

  for (const session of schedule.sessions) {
    const dir = sessionDirectory(eventRoot, layout, session);
    dirs.add(dir);
    roomIds.add(session.roomId);
    for (const sp of session.speakers) {
      const filename = sessionSpeakerFilename(session, sp, ext);
      files.push({ path: joinPath(dir, filename), bytes });
    }
  }

  // Append the per-room `.roomSync` templates last so the placeholder
  // file count assertions in existing tests stay valid regardless of
  // ordering — the new files are appended, never interleaved.
  for (const roomId of roomIds) {
    files.push({
      path: joinPath(eventRoot, `${roomId}.roomSync`),
      bytes: UTF8.encode(roomSyncTemplate(roomId)),
    });
  }

  return {
    eventRoot,
    directories: Array.from(dirs).sort(),
    files,
  };
}

/**
 * Compose the JSONC body of a generated `<roomId>.roomSync` template.
 *
 * The file ships with `destinations: []` so the operator can wire it up
 * after dragging the per-room destination folder(s) into the workspace.
 * The `${roomSync}` template variable is preserved as a literal — the
 * extension's wired loader resolves it from the filename at load time
 * (resolves to `<roomId>` for a file named `<roomId>.roomSync`), so the
 * same template body could be copied verbatim to a different room and
 * still do the right thing.
 *
 * The `**` glob on both sides handles every reasonable source layout:
 *   - room-major (<event>/<room>/<day>/<timeslot>/) → captures empty
 *     for the room-at-root case; tail flows through unchanged.
 *   - day-major (<event>/<day>/<room>/<timeslot>/) → captures the day
 *     prefix; substituted into the destination path so the per-day
 *     grouping survives the rewrite.
 */
export function roomSyncTemplate(roomId: string): string {
  return [
    `{`,
    `  // Generated by generate-event-folders. The operator drags the`,
    `  // destination folder(s) for "${roomId}" into the workspace, then`,
    `  // uses the form editor to add their URIs here.`,
    `  //`,
    `  // \${roomSync} resolves to "${roomId}" at load time (from the`,
    `  // filename of this file). The **/\${roomSync} alias matches the`,
    `  // room folder at any depth — works for room-major + day-major`,
    `  // layouts and any nesting the operator chooses to add later.`,
    `  "destinations": [],`,
    `  "path-aliases": {`,
    `    "**/\${roomSync}": "**"`,
    `  }`,
    `}`,
    ``,
  ].join('\n');
}

/** Path components by layout. Relocated sessions follow the post-move roomId. */
function sessionDirectory(
  eventRoot: string,
  layout: Layout,
  session: EventSession,
): string {
  const room = roomFolderToken(session.roomId);
  const day = session.day;
  const timeslot = session.timeslot;
  return layout === 'room-major'
    ? joinPath(eventRoot, room, day, timeslot)
    : joinPath(eventRoot, day, room, timeslot);
}

/** Folder token: lowercase room id straight from the JSON (e.g. "breakout-1"). */
function roomFolderToken(roomId: string): string {
  return roomId;
}

/**
 * Filename room token: uppercase, no hyphens (e.g. "BREAKOUT1"). Matches the
 * conference convention of "MON BREAKOUT1 A 1 John Smith.pptx". Kept distinct
 * from the folder token because filenames travel further than folder names
 * (email, USB sticks, AV-control software) and the compact form is what
 * organisers tend to write by hand.
 */
function roomFilenameToken(roomId: string): string {
  return roomId.replace(/-/g, '').toUpperCase();
}

/**
 * Speaker placeholder filename. Format: `DAY ROOM TIME # SPEAKER.ext`.
 * Within a single directory every field except `#` is constant, so alpha
 * sort puts speakers in their assigned slot order. Speaker names are
 * inserted verbatim — typical "Firstname Lastname" plays well with most
 * filesystems; the rare apostrophe (e.g. "O'Connell") is fine on POSIX
 * and ok on modern Windows.
 */
export function sessionSpeakerFilename(
  session: EventSession,
  speaker: SessionSpeakerSlot,
  extension: string,
): string {
  return (
    `${session.day} ` +
    `${roomFilenameToken(session.roomId)} ` +
    `${session.timeslot} ` +
    `${speaker.slot} ` +
    `${speaker.speakerName}` +
    `${extension}`
  );
}

export function normaliseExtension(ext: string): string {
  if (!ext) return '';
  return ext.startsWith('.') ? ext : `.${ext}`;
}
