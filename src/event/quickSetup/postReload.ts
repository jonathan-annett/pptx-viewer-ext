// Post-reload handoff for the Quick Setup New Event wizard.
//
// The M3 wizard writes a handoff record to globalState immediately
// before invoking `vscode.openFolder`, which reloads the extension
// host into the freshly-created workspace. On that next activation,
// this module:
//
//   1. Reads the handoff record. No record → no-op.
//   2. Validates that workspaceFolders[0] matches the URI the wizard
//      created. Mismatch → clear the flag and bail. (The user may
//      have opened a different folder before activation completed,
//      or vscode.dev may have routed the openFolder somewhere else.
//      Either way we don't want to auto-open something at random.)
//   3. Clears the flag immediately so subsequent reloads don't
//      re-fire the auto-open + toast.
//   4. Defers the auto-open + toast until the rest of `activate()`
//      has had a chance to register the event editor provider. The
//      handler is called early in activation; the editor is
//      registered partway through. setTimeout(..., 0) yields the
//      event loop so the registration lands first.
//
// The handler is fire-and-forget from `activate()`'s perspective —
// no caller awaits it. Failures (the .eventSchedule somehow doesn't
// exist, the openWith command rejects) are logged but never bubble
// up; activation completes regardless.

import * as vscode from 'vscode';
import { log } from '../../log';
import {
  QUICK_SETUP_HANDOFF_KEY,
  type QuickSetupHandoff,
} from './wizard';

const EVENT_EDITOR_VIEW_TYPE = 'pptxViewer.eventEditor';

/** ms to defer the auto-open after activation finishes its synchronous tail. */
const DEFER_MS = 250;

/**
 * Drive the post-reload handoff. Called from `extension.ts:activate()`
 * before any other initialisation so the flag read can't race against
 * a future `globalState.update` from elsewhere.
 *
 * The function is intentionally synchronous in its globalState
 * inspection — we want to make the keep/clear decision before
 * yielding control. The actual deferred work (auto-open, toast) is
 * scheduled via setTimeout and fire-and-forget.
 */
export async function handleQuickSetupPostReload(
  context: vscode.ExtensionContext,
): Promise<void> {
  const handoff = context.globalState.get<QuickSetupHandoff>(
    QUICK_SETUP_HANDOFF_KEY,
  );
  if (!handoff) return;

  log(
    `quickSetup-postReload: handoff present for "${handoff.eventName}" ` +
      `at ${handoff.folderUri} (completed ${handoff.completedAt})`,
  );

  const wsFolders = vscode.workspace.workspaceFolders ?? [];
  const firstFolderUri = wsFolders[0]?.uri.toString();
  if (firstFolderUri !== handoff.folderUri) {
    // The workspace that came up after the openFolder reload doesn't
    // match what the wizard created. Don't fire the auto-open at a
    // mismatched folder — clear the flag and move on.
    log(
      `quickSetup-postReload: workspace mismatch ` +
        `(expected ${handoff.folderUri}, got ${firstFolderUri ?? 'none'}) — ` +
        `clearing flag, skipping auto-open`,
    );
    await context.globalState.update(QUICK_SETUP_HANDOFF_KEY, undefined);
    return;
  }

  // Match — clear the flag immediately so a subsequent reload
  // (PWA refresh, user reopens the same folder later) doesn't
  // re-fire the toast.
  await context.globalState.update(QUICK_SETUP_HANDOFF_KEY, undefined);
  log('quickSetup-postReload: flag cleared, scheduling auto-open');

  // Defer the auto-open. The event editor provider is registered
  // partway through activate(); calling vscode.openWith before that
  // races the registration. setTimeout yields the event loop, then
  // a small additional delay covers the rest of the synchronous
  // initialisation that happens after this handler returns.
  setTimeout(() => {
    void runAutoOpen(handoff);
  }, DEFER_MS);
}

async function runAutoOpen(handoff: QuickSetupHandoff): Promise<void> {
  const folderUri = vscode.Uri.parse(handoff.folderUri);
  const scheduleUri = vscode.Uri.joinPath(folderUri, '.eventSchedule');
  log(`quickSetup-postReload: opening ${scheduleUri.toString()}`);
  try {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      scheduleUri,
      EVENT_EDITOR_VIEW_TYPE,
    );
    log('quickSetup-postReload: .eventSchedule opened in event editor');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`quickSetup-postReload: openWith FAILED — ${msg}`);
    // Fall through — the toast still fires so the user knows the
    // setup succeeded even if the auto-open hit a snag.
  }
  void vscode.window.showInformationMessage(
    `Event "${handoff.eventName}" created. Open any <room>.roomSync to wire destinations.`,
  );
}
