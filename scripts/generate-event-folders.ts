// Materialise a folder tree + placeholder files from an event schedule JSON.
//
// Reads the output of `generate-event-schedule.ts` and writes a directory
// per (room, day, timeslot) — or (day, room, timeslot), depending on the
// `--layout` flag — with one placeholder file per speaker slot inside.
//
// Also emits one `<roomId>.roomSync` template per unique room at the event
// root. Each template ships with an empty `destinations: []` so the
// operator can drag the per-room destination folder(s) into the workspace
// and wire them up via the form editor. The `path-aliases` block uses the
// `${roomSync}` template variable + the `**` wildcard so the same alias
// rule covers both layouts: `**/${roomSync}` → `**` matches whether the
// room sits at depth 1 (room-major: <event>/<room>/<day>/…) or depth 2
// (day-major: <event>/<day>/<room>/…), and the captured prefix preserves
// the per-day grouping at the destination.
//
// Why two layouts: organisers usually think day-major (what's happening
// today, in every room), while distribution to a destination room is
// naturally room-major (one room's whole deck across the event). Different
// events suit different layouts; this tool lets the user pick rather than
// baking in an opinion.
//
// File naming convention: "DAY ROOM TIME # SPEAKER.ext" — alpha-sorts
// stably into speaker order within a session because every field except
// the slot number is constant in a given directory. Capital DAY/ROOM/TIME
// matches the conference-circuit convention; ROOM is compact-upper
// (e.g. "BREAKOUT1" from id "breakout-1") so it survives transit through
// systems that dislike hyphens in filename tokens.
//
// CLI:
//   node --import tsx scripts/generate-event-folders.ts \
//        --input event-schedule.json \
//        --out ./events \
//        --layout room-major | day-major \
//        [--placeholder path/to/template.pptx] \
//        [--ext .pptx] \
//        [--name "Override Event Name"]
//
// Placeholder behaviour: with `--placeholder PATH`, the bytes of that file
// are copied to every speaker slot. Without it, every speaker slot is a
// zero-byte file. Zero-byte files are recognised as placeholders by the
// pptx viewer's empty-file short-circuit, so they're a useful default.
//
// The planner is pure (`planEventFolders`) so it's testable. The CLI
// wrapper just walks the plan and writes.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type {
  EventSchedule,
  EventSession,
  SessionSpeakerSlot,
} from './generate-event-schedule';

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
}

export interface FolderGenPlan {
  /** Absolute-ish path to the event root (outRoot/eventName). */
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
 * Pure: turn a schedule + layout choice into a list of dirs + files to
 * create. Doesn't touch the filesystem. The materialiser below walks this
 * plan exactly — so what the tests verify here is what the CLI writes.
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

  const eventRoot = join(input.outRoot, eventName);
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
      files.push({ path: join(dir, filename), bytes });
    }
  }

  // Append the per-room `.roomSync` templates last so the placeholder
  // file count assertions in existing tests stay valid regardless of
  // ordering — the new files are appended, never interleaved.
  for (const roomId of roomIds) {
    files.push({
      path: join(eventRoot, `${roomId}.roomSync`),
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
    ? join(eventRoot, room, day, timeslot)
    : join(eventRoot, day, room, timeslot);
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

function normaliseExtension(ext: string): string {
  if (!ext) return '';
  return ext.startsWith('.') ? ext : `.${ext}`;
}

// ───── Materialiser ──────────────────────────────────────────────────────

export interface MaterialiseResult {
  directoriesCreated: number;
  filesWritten: number;
}

/**
 * Walk a plan and write to disk. Creates directories with `recursive: true`
 * (mkdir is idempotent — re-running into an existing tree is fine) and
 * overwrites placeholder files (they're test fixtures, fresh runs should
 * win). The caller is responsible for cleaning the output dir if they want
 * a strictly fresh layout.
 */
export function materialisePlan(plan: FolderGenPlan): MaterialiseResult {
  for (const dir of plan.directories) {
    mkdirSync(dir, { recursive: true });
  }
  for (const f of plan.files) {
    writeFileSync(f.path, f.bytes);
  }
  return {
    directoriesCreated: plan.directories.length,
    filesWritten: plan.files.length,
  };
}

// ───── CLI ───────────────────────────────────────────────────────────────

interface CliArgs {
  input: string;
  out: string;
  layout: Layout;
  placeholder?: string;
  extension: string;
  eventName?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let input = 'event-schedule.json';
  let out = '.';
  let layout: Layout = 'room-major';
  let placeholder: string | undefined;
  let extension = '.pptx';
  let eventName: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') {
      input = mustValue(argv, ++i, '--input');
    } else if (a === '--out') {
      out = mustValue(argv, ++i, '--out');
    } else if (a === '--layout') {
      const v = mustValue(argv, ++i, '--layout');
      if (v !== 'room-major' && v !== 'day-major') {
        throw new Error(`--layout must be "room-major" or "day-major", got "${v}"`);
      }
      layout = v;
    } else if (a === '--placeholder') {
      placeholder = mustValue(argv, ++i, '--placeholder');
    } else if (a === '--ext') {
      extension = mustValue(argv, ++i, '--ext');
    } else if (a === '--name') {
      eventName = mustValue(argv, ++i, '--name');
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: generate-event-folders --layout room-major|day-major [options]\n' +
          '  --input PATH        event schedule JSON (default: event-schedule.json)\n' +
          '  --out DIR           base directory for the event folder (default: .)\n' +
          '  --layout MODE       "room-major" (default) or "day-major"\n' +
          '  --placeholder PATH  copy this file as every speaker placeholder\n' +
          '                      (default: zero-byte files)\n' +
          '  --ext .EXT          extension for speaker files (default: .pptx)\n' +
          '  --name STR          override the event folder name (default: from JSON)',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { input, out, layout, placeholder, extension, eventName };
}

function mustValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (!v) throw new Error(`${flag} needs a value`);
  return v;
}

function loadSchedule(path: string): EventSchedule {
  const text = readFileSync(resolve(path), 'utf8');
  const parsed = JSON.parse(text) as EventSchedule;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
    throw new Error(`${path}: not a valid event schedule (missing sessions[])`);
  }
  return parsed;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const schedule = loadSchedule(args.input);
  const placeholderBytes = args.placeholder
    ? new Uint8Array(readFileSync(resolve(args.placeholder)))
    : EMPTY_BYTES;
  const plan = planEventFolders({
    schedule,
    layout: args.layout,
    outRoot: resolve(args.out),
    eventName: args.eventName,
    extension: args.extension,
    placeholderBytes,
  });
  const result = materialisePlan(plan);
  console.error(
    `Wrote ${result.filesWritten} placeholder(s) across ${result.directoriesCreated} ` +
      `directory(ies) under ${plan.eventRoot} (layout: ${args.layout}, ` +
      `placeholder: ${args.placeholder ? `${placeholderBytes.length} bytes` : 'zero-byte'}).`,
  );
}
