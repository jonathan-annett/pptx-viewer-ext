// Generate a randomised event schedule JSON for folder-sync testing.
//
// Pure data model + deterministic generator live in `src/event/schedule.ts`
// — this file is just the CLI wrapper that wires the function to argv +
// the filesystem. The pure half is also imported by the .eventSchedule
// custom editor (web-extension worker context, no Node FS available there)
// and by the test under `test/generate-event-schedule.test.ts`.
//
// CLI:
//   node --import tsx scripts/generate-event-schedule.ts [--seed N] [--name STR] [--out PATH]
//
// Run with `--out -` to emit to stdout. Otherwise writes a pretty-printed
// JSON file (default: event-schedule.json in cwd).

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_CONFIG,
  generateEventSchedule,
  type EventConfig,
  type EventSchedule,
} from '../src/event/schedule';

// Re-export the public surface so existing call-sites that imported from
// this script keep working without churn.
export {
  DEFAULT_CONFIG,
  generateEventSchedule,
  timeslotsForDay,
  allTimeslotLetters,
  type EventConfig,
  type EventSchedule,
  type EventSpeaker,
  type EventRoom,
  type EventSession,
  type EventVacancy,
  type SessionKind,
  type SessionSpeakerSlot,
} from '../src/event/schedule';

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
  void DEFAULT_CONFIG; // keep referenced so a future arg-default tweak doesn't drop the import
  const { seed, name, out } = parseArgs(process.argv.slice(2));
  const overrides: Partial<EventConfig> = {};
  if (seed !== undefined) overrides.seed = seed;
  if (name !== undefined) overrides.name = name;
  const schedule: EventSchedule = generateEventSchedule(overrides);
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
