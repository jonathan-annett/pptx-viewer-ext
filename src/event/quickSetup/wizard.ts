// vscode-wired wizard UI for the Quick Setup New Event command.
// Five sequential `showInputBox` calls — each threads its raw input
// through one of the pure validators in `./tokenize` via the
// `validateInput` callback, so users see errors inline before they
// can advance.
//
// Cancellation (Esc / dismiss) at any step returns `undefined`
// from `runQuickSetupWizard`. There is no back-navigation —
// `showInputBox` doesn't support it — but `ignoreFocusOut: true`
// keeps each prompt alive across focus changes so a stray click
// doesn't dismiss the in-progress wizard.

import * as vscode from 'vscode';
import {
  validateCommaList,
  validateEventName,
  validateSpeakerNames,
} from './tokenize';

const TOTAL_STEPS = 5;

export interface QuickSetupCollected {
  /** Sanitized event-name token. Becomes the workspace folder name + config.name. */
  eventName: string;
  /** Sanitized day labels, in user-entered order. */
  days: string[];
  /** Sanitized timeslot labels — shared across every day at creation time. */
  timeslots: string[];
  /** Sanitized room tokens. All emitted as kind:'breakout'. */
  rooms: string[];
  /** Raw speaker display names (verbatim — no sanitization). Empty array when skipped. */
  speakerNames: string[];
}

/**
 * Drive the five-step input chain. Resolves to the collected inputs
 * on success; resolves to `undefined` when the user cancels any step
 * (including the first). M3 will pick the parent folder + write
 * files; M4 will hand off across the openFolder reload.
 */
export async function runQuickSetupWizard(): Promise<
  QuickSetupCollected | undefined
> {
  // Step 1 — event name. Distinct shape (single token, not a list)
  // so it doesn't use the collectCommaList helper.
  const eventNameRaw = await vscode.window.showInputBox({
    title: `Quick Setup (1/${TOTAL_STEPS}) — Event Name`,
    prompt: 'Name of the event. Becomes the new workspace folder name.',
    placeHolder: 'TechConf2026',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const r = validateEventName(value);
      return r.ok ? undefined : r.reason;
    },
  });
  if (eventNameRaw === undefined) return undefined;
  const eventNameResult = validateEventName(eventNameRaw);
  // validateInput already passed, so this branch is defensive only.
  if (!eventNameResult.ok) return undefined;
  const eventName = eventNameResult.token;

  // Steps 2-4 — comma-separated token lists. Same UX shape, only
  // the prompt copy + validator-kind differ.
  const days = await collectCommaList(
    2,
    'Day Labels',
    'Day labels, comma-separated. Short equal-length tokens (MON, TUE, WED) work best — they become parts of filenames. Embedded spaces are camelCased.',
    'MON, TUE, WED',
    'day',
  );
  if (days === undefined) return undefined;

  const timeslots = await collectCommaList(
    3,
    'Default Timeslot Labels',
    "Default timeslot labels, comma-separated. Must alpha-sort chronologically — '0900,1300,1600' ok, '9am,1pm,4pm' wrong. ':' isn't allowed; use '0930' or '09_30'.",
    '0900, 1300, 1600',
    'timeslot',
  );
  if (timeslots === undefined) return undefined;

  const rooms = await collectCommaList(
    4,
    'Room Names',
    'Room names, comma-separated. Short tokens (RM001, PLENARY) work best — they become parts of filenames.',
    'RM001, RM002, PLENARY',
    'room',
  );
  if (rooms === undefined) return undefined;

  // Step 5 — speakers. Optional (empty input is fine) and the
  // values are NOT tokenized — the raw display name is preserved.
  const speakersRaw = await vscode.window.showInputBox({
    title: `Quick Setup (5/${TOTAL_STEPS}) — Speakers (optional)`,
    prompt:
      'Speaker names, comma-separated. Optional — leave blank to skip. Names are preserved verbatim (no sanitization).',
    placeHolder: 'Jane Doe, John Smith, A. B. Singh',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const r = validateSpeakerNames(value);
      return r.ok ? undefined : r.reason;
    },
  });
  if (speakersRaw === undefined) return undefined;
  const speakersResult = validateSpeakerNames(speakersRaw);
  if (!speakersResult.ok) return undefined;
  const speakerNames = speakersResult.names;

  return { eventName, days, timeslots, rooms, speakerNames };
}

/**
 * One step of the comma-separated-token-list UX. Resolves to the
 * sanitized tokens array on submit, `undefined` on cancel.
 */
async function collectCommaList(
  step: number,
  title: string,
  prompt: string,
  placeHolder: string,
  kind: 'day' | 'timeslot' | 'room',
): Promise<string[] | undefined> {
  const raw = await vscode.window.showInputBox({
    title: `Quick Setup (${step}/${TOTAL_STEPS}) — ${title}`,
    prompt,
    placeHolder,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const r = validateCommaList(value, kind);
      return r.ok ? undefined : r.reason;
    },
  });
  if (raw === undefined) return undefined;
  const r = validateCommaList(raw, kind);
  return r.ok ? r.tokens : undefined;
}
