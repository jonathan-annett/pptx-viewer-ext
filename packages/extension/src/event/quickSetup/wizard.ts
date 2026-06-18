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
import { log } from 'pptx-tools-core/log';
import { buildArtifacts } from 'pptx-tools-core/event/quickSetup/buildArtifacts';
import {
  validateCommaList,
  validateEventName,
  validateSpeakerNames,
} from 'pptx-tools-core/event/quickSetup/tokenize';

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
 * GlobalState key for the post-openFolder handoff record. M4's
 * post-reload handler reads this and (a) auto-opens the new
 * `.eventSchedule`, (b) shows a success toast, (c) clears the key.
 *
 * Exported so the M4 module imports the same constant — no
 * stringly-typed key drift across the wizard/reload boundary.
 */
export const QUICK_SETUP_HANDOFF_KEY = 'eventQuickSetup.justCompleted';

export interface QuickSetupHandoff {
  /** Target folder URI as a string, ready for vscode.Uri.parse. */
  folderUri: string;
  /** Sanitized event-name token — used as the success toast subject. */
  eventName: string;
  /** ISO timestamp; primarily a diagnostic. */
  completedAt: string;
}

/**
 * Post-collection orchestration: pick parent folder, check for
 * collision, modal-confirm, write artifacts, hand off via
 * globalState, trigger the workspace replace via vscode.openFolder.
 *
 * Resolves `true` once the openFolder command has been dispatched
 * (the extension host reload immediately follows; the success-toast
 * fires from M4's post-reload handler, not here). Resolves `false`
 * for any cancellation or write failure; the wizard logs which.
 *
 * Does NOT roll back partial writes — leaving them in place is
 * easier to inspect than silently-deleted state. The user can
 * re-run the wizard with a different name (the existing folder
 * triggers the collision-check refuse) or delete the partial
 * folder manually.
 */
export async function executeQuickSetup(
  context: vscode.ExtensionContext,
  collected: QuickSetupCollected,
): Promise<boolean> {
  // 1. Pick parent folder. The new event folder will be created
  // inside whatever the user selects.
  const parentSelection = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Choose Parent Folder',
    title: `Choose where to create '${collected.eventName}'`,
  });
  if (!parentSelection || parentSelection.length === 0) {
    log('quickSetup: parent-folder picker cancelled');
    return false;
  }
  const parentUri = parentSelection[0];
  const targetUri = vscode.Uri.joinPath(parentUri, collected.eventName);
  log(`quickSetup: target = ${targetUri.toString()}`);

  // 2. Collision check. Race-safe: if something exists at the target
  // we bail rather than risk merging into unknown state. Standard
  // pattern from sync/adminEditor.ts:331 — stat-succeeds-means-exists,
  // stat-throws-means-OK-to-create.
  let exists = false;
  try {
    await vscode.workspace.fs.stat(targetUri);
    exists = true;
  } catch {
    // Not found — good.
  }
  if (exists) {
    void vscode.window.showErrorMessage(
      `'${collected.eventName}' already exists in ${parentUri.toString()}. ` +
        'Re-run Quick Setup with a different event name, or delete the ' +
        'existing folder first.',
    );
    log(`quickSetup: collision at ${targetUri.toString()} — aborting`);
    return false;
  }

  // 3. Modal confirmation. User reviews the summary before the
  // workspace gets replaced via openFolder.
  const choice = await vscode.window.showWarningMessage(
    `Create event '${collected.eventName}'?`,
    {
      modal: true,
      detail:
        `Folder: ${targetUri.toString()}\n\n` +
        `Days: ${collected.days.length} · ` +
        `Timeslots: ${collected.timeslots.length}/day · ` +
        `Rooms: ${collected.rooms.length} · ` +
        `Speakers: ${collected.speakerNames.length}\n\n` +
        'The current workspace will close and the new one will open.',
    },
    'Create',
  );
  if (choice !== 'Create') {
    log('quickSetup: confirmation cancelled');
    return false;
  }

  // 4. Build artifact bytes + write each file. M1's pure builder
  // produces the three file types from the collected inputs + an
  // injected ISO timestamp.
  const generatedAt = new Date().toISOString();
  const artifacts = buildArtifacts({ ...collected, generatedAt });
  try {
    await vscode.workspace.fs.createDirectory(targetUri);
    log(`quickSetup: created directory ${targetUri.toString()}`);

    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(targetUri, '.eventSchedule'),
      artifacts.eventScheduleBytes,
    );
    log('quickSetup: wrote .eventSchedule');

    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(targetUri, '.eventSync'),
      artifacts.eventSyncBytes,
    );
    log('quickSetup: wrote .eventSync');

    for (const f of artifacts.roomSyncFiles) {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(targetUri, f.filename),
        f.bytes,
      );
      log(`quickSetup: wrote ${f.filename}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      `Quick Setup failed while writing files: ${msg}`,
    );
    log(`quickSetup: write FAILED — ${msg}`);
    return false;
  }

  // 5. Stash handoff state for the post-reload activation to pick up.
  // M4's postReload handler reads this key, validates the URI matches
  // workspaceFolders[0], auto-opens the .eventSchedule, shows a
  // success toast, then clears the key.
  const handoff: QuickSetupHandoff = {
    folderUri: targetUri.toString(),
    eventName: collected.eventName,
    completedAt: new Date().toISOString(),
  };
  await context.globalState.update(QUICK_SETUP_HANDOFF_KEY, handoff);
  log(`quickSetup: handoff stashed under ${QUICK_SETUP_HANDOFF_KEY}`);

  // 6. Trigger the workspace replace. Per the plan risk list:
  // vscode.openFolder on web is unverified — hand-test on the VPS.
  // If it fails or has unexpected behaviour, the fallback is
  // updateWorkspaceFolders(0, allFolders.length, ...). The handoff
  // record is already on disk so M4 will recover either way.
  log(`quickSetup: invoking vscode.openFolder ${targetUri.toString()}`);
  await vscode.commands.executeCommand('vscode.openFolder', targetUri);
  return true;
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
