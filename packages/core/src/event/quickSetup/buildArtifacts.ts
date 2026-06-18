// Pure artifact builder for the Quick Setup New Event wizard.
// Inputs → encoded bytes for `.eventSchedule`, `.eventSync`, and one
// `<roomId>.roomSync` per user-entered room. Zero vscode imports so the
// output is byte-for-byte testable under Node (see test/quickSetup-
// buildArtifacts.test.ts).
//
// All three artifact shapes reuse the canonical serializers from their
// respective owning modules:
//   - `.eventSchedule`  → `marshalSchedule` (src/event/scheduleData.ts)
//   - `.eventSync`      → `marshalSnapshot` (src/sync/snapshot.ts)
//   - `.roomSync`       → `roomSyncTemplate` (src/event/eventFolders.ts)
//
// The wizard never invents file content — it composes existing pure
// helpers. Anything new (full-grid session generation, config-knob
// derivation) lives here so refactors in the owning modules drift
// these artifacts in lockstep with the rest of the codebase.

import { marshalSchedule } from '../scheduleData';
import { roomSyncTemplate } from '../eventFolders';
import {
  DEFAULT_CONFIG,
  type EventConfig,
  type EventRoom,
  type EventSchedule,
  type EventSession,
  type EventSpeaker,
} from '../schedule';
import { emptySnapshot, marshalSnapshot, type Snapshot } from '../../sync/snapshot';

export interface QuickSetupInputs {
  /** Sanitized event-name token. Becomes the workspace folder name and `config.name`. */
  eventName: string;
  /** Sanitized day labels, in order. */
  days: string[];
  /** Sanitized timeslot labels, shared across every day at creation time. */
  timeslots: string[];
  /** Sanitized room tokens. All rooms emit as kind:'breakout'. */
  rooms: string[];
  /** Raw speaker display names (NOT sanitized — preserved verbatim). */
  speakerNames: string[];
  /**
   * ISO timestamp stamped into `.eventSchedule.generatedAt` and
   * `.eventSync.capturedAt`. Injected (rather than read from `Date.now()`)
   * so tests can pin a fixed timestamp and assert byte-for-byte equality
   * against a golden fixture.
   */
  generatedAt: string;
}

export interface RoomSyncArtifact {
  /** Filename relative to the workspace root, e.g. `RM001.roomSync`. */
  filename: string;
  bytes: Uint8Array;
}

export interface QuickSetupArtifacts {
  eventScheduleBytes: Uint8Array;
  eventSyncBytes: Uint8Array;
  roomSyncFiles: RoomSyncArtifact[];
}

/**
 * Compose the file bytes the wizard will write to disk via
 * `vscode.workspace.fs.writeFile`. Pure — no I/O, no vscode imports.
 *
 * Determinism contract: identical inputs (including `generatedAt`)
 * produce byte-identical outputs. The golden-fixture tests rely on
 * this; if you change the build, update the fixture in the same
 * commit.
 */
export function buildArtifacts(input: QuickSetupInputs): QuickSetupArtifacts {
  const encoder = new TextEncoder();
  const schedule = buildEventSchedule(input);
  const snapshot = buildInitialSnapshot(input.generatedAt);
  const roomSyncFiles: RoomSyncArtifact[] = input.rooms.map((roomId) => ({
    filename: `${roomId}.roomSync`,
    bytes: encoder.encode(roomSyncTemplate(roomId)),
  }));
  return {
    eventScheduleBytes: encoder.encode(marshalSchedule(schedule)),
    eventSyncBytes: encoder.encode(marshalSnapshot(snapshot)),
    roomSyncFiles,
  };
}

/**
 * Compose the `EventSchedule` payload. Days + timeslots populate
 * `timeslotsByDay` directly so the editor renders the full grid at
 * first open; sessions are emitted as one empty cell per (day,
 * timeslot, room) trio with `speakers: []`.
 */
export function buildEventSchedule(input: QuickSetupInputs): EventSchedule {
  const config = buildEventConfig(input);
  const timeslotsByDay: Record<string, string[]> = {};
  for (const d of input.days) timeslotsByDay[d] = [...input.timeslots];

  const speakers: EventSpeaker[] = input.speakerNames.map((name, i) => ({
    id: `spk-${String(i + 1).padStart(2, '0')}`,
    name,
  }));

  // All wizard-entered rooms are kind:'breakout'. The user flips one
  // to 'plenary' later in the editor if their event has a plenary
  // track. Per plan tokenization rules, id === name (both = the
  // sanitized token) — diverges from the sample generator's
  // breakout-N IDs but matches the user's mental model of the room.
  const rooms: EventRoom[] = input.rooms.map((roomId) => ({
    id: roomId,
    name: roomId,
    kind: 'breakout',
  }));

  const sessions: EventSession[] = [];
  for (const day of input.days) {
    for (const timeslot of input.timeslots) {
      for (const roomId of input.rooms) {
        sessions.push({
          id: `${day}-${timeslot}-${roomId}`,
          day,
          timeslot,
          roomId,
          kind: 'breakout',
          relocatedFromRoomId: null,
          speakers: [],
        });
      }
    }
  }

  return {
    generatedAt: input.generatedAt,
    config,
    timeslotsByDay,
    speakers,
    rooms,
    sessions,
    vacancies: [],
  };
}

/**
 * Compose the `EventConfig` knobs. Wizard-derived where the input
 * provides a meaningful value (name, days, defaultTimeslots, layout,
 * speakerPoolSize, sample-generator slot counts); inherit
 * `DEFAULT_CONFIG` for everything else (seed, plenary/closing
 * counts, speakersPerBreakoutMin/Max, relocations).
 *
 * The sample-generator-related counts (`breakoutSessionsPerDay`,
 * `breakoutSessionsLastDay`) are sized so a future click of the
 * editor's "Generate sample schedule" button produces a slot count
 * matching the user's `timeslots` length — i.e. T total slots maps
 * to (T-1) breakouts on non-last days and (T-2) on the last day
 * (because the closer takes one slot back). Clamped at 0 for
 * very short events.
 */
function buildEventConfig(input: QuickSetupInputs): EventConfig {
  const T = input.timeslots.length;
  const breakoutSessionsPerDay = Math.max(T - 1, 0);
  const breakoutSessionsLastDay = Math.max(T - 2, 0);
  return {
    ...DEFAULT_CONFIG,
    name: input.eventName,
    days: [...input.days],
    breakoutRoomCount: input.rooms.length,
    breakoutSessionsPerDay,
    breakoutSessionsLastDay,
    speakerPoolSize: Math.max(input.speakerNames.length, 1),
    relocations: 0,
    defaultTimeslots: [...input.timeslots],
    layout: 'day-major',
  };
}

/**
 * Compose the initial `.eventSync` payload. The snapshot's `folders`,
 * `settings`, and `placeholders` are all empty — the snapshot writer
 * fills them on its first post-activation pass. Only `capturedAt` is
 * threaded from `generatedAt` for parity with the schedule file's
 * timestamp.
 */
function buildInitialSnapshot(capturedAt: string): Snapshot {
  return { ...emptySnapshot(), capturedAt };
}
