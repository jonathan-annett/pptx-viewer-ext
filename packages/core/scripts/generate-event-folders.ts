// Materialise a folder tree + placeholder files from an event schedule JSON.
//
// CLI wrapper around the pure planner in src/event/eventFolders.ts. The
// planner is now web-extension-safe (no node:fs / no node:path) so the
// .eventSchedule custom editor can call it directly from the browser.
// This file is the Node entrypoint that wires the planner to argv + the
// real filesystem.
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

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  planEventFolders,
  type FolderGenPlan,
  type Layout,
} from '../src/event/eventFolders';
import type { EventSchedule } from '../src/event/schedule';

// Re-export the planner surface so existing imports
// (`from '../scripts/generate-event-folders'`) keep working without churn.
export {
  planEventFolders,
  roomSyncTemplate,
  sessionSpeakerFilename,
  normaliseExtension,
  type FolderGenInput,
  type FolderGenPlan,
  type Layout,
} from '../src/event/eventFolders';

const EMPTY_BYTES = new Uint8Array(0);

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
