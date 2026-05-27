// Wired surface for the `.sync.jsonc` ↔ `.roomSync` filename-pair conflict.
//
// Two pieces ride on top of `topology.conflicts` (populated by SyncManager
// — see room-sync-format-v1-plan.md M1):
//
//   1. `registerConfigConflictCommand` — the `folderSync.resolveConfigConflict`
//      palette command. Walks every pending conflict, asks the user which file
//      to keep, deletes the loser. Re-reads the topology after each deletion
//      so a follow-up conflict in the same folder (pathological, but
//      possible if files race in) isn't missed.
//
//   2. `attachConflictNotifier` — a one-shot toast per detected conflict.
//      Tracks seen pairs in memory so the user isn't re-prompted on every
//      topology reload (a `.sync.jsonc` save fires a reload but the
//      conflict already exists; pestering on each save is noise). Cleared
//      when a conflict's source folder leaves the conflict set, so a
//      resolve-then-re-create cycle does re-toast.
//
// A `folderSync.hasConfigConflict` context key gates the command's palette
// visibility (see package.json `menus.commandPalette`). Kept in sync with
// `topology.conflicts.length > 0` on every manager emit.

import * as vscode from 'vscode';
import { log } from '../log';
import type { SyncManager } from './manager';
import type { SyncConfigConflict } from './topology';

const CONFLICT_CONTEXT_KEY = 'folderSync.hasConfigConflict';

export function registerConfigConflictCommand(
  manager: SyncManager,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'folderSync.resolveConfigConflict',
    async () => {
      let conflicts = manager.getTopology().conflicts;
      if (conflicts.length === 0) {
        void vscode.window.showInformationMessage(
          'Folder Sync: no config-filename conflicts to resolve.',
        );
        return;
      }
      log(`sync: resolveConfigConflict — ${conflicts.length} pending`);
      // Iterate by index rather than for-of: every reload may shuffle
      // the conflicts array, so we always re-read after a delete.
      while (conflicts.length > 0) {
        const next = conflicts[0];
        const resolved = await resolveOne(next);
        if (!resolved) {
          // User cancelled the quick-pick — stop the loop so we don't
          // re-prompt for the same conflict on the next iteration.
          log('sync: resolveConfigConflict — user cancelled');
          return;
        }
        await manager.reload();
        conflicts = manager.getTopology().conflicts;
      }
      void vscode.window.showInformationMessage(
        'Folder Sync: all config-filename conflicts resolved.',
      );
    },
  );
}

interface ResolvePick extends vscode.QuickPickItem {
  target: vscode.Uri;
  keptLabel: string;
}

async function resolveOne(c: SyncConfigConflict): Promise<boolean> {
  const folderRel =
    vscode.workspace.asRelativePath(c.sourceFolderUri, false) ||
    c.sourceFolderUri.toString();
  const items: ResolvePick[] = [
    {
      label: 'Keep .roomSync, delete .sync.jsonc',
      description: c.legacyUri.toString(),
      target: c.legacyUri,
      keptLabel: '.roomSync',
    },
    {
      label: 'Keep .sync.jsonc, delete .roomSync',
      description: c.roomSyncUri.toString(),
      target: c.roomSyncUri,
      keptLabel: '.sync.jsonc',
    },
  ];
  const pick = await vscode.window.showQuickPick<ResolvePick>(items, {
    title: `Folder Sync config conflict in "${folderRel}"`,
    placeHolder: 'Choose which file to keep — the other will be deleted',
    ignoreFocusOut: true,
  });
  if (!pick) return false;
  try {
    // useTrash: true gives the user a recovery path if they second-guess
    // the choice — the deletion is reversible until the trash is emptied.
    await vscode.workspace.fs.delete(pick.target, { useTrash: true });
    log(
      `sync: resolveConfigConflict — deleted ${pick.target.toString()} ` +
        `(kept ${pick.keptLabel})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`sync: resolveConfigConflict — delete failed: ${message}`);
    void vscode.window.showErrorMessage(
      `Could not delete ${pick.target.toString()}: ${message}`,
    );
    return false;
  }
  return true;
}

/**
 * One-shot toast per newly-detected conflict + context-key maintenance.
 * Subscribes to `manager.onDidChange` (which fires once immediately on
 * subscribe — that first call seeds `seen` without toasting since the
 * conflict counter starts at zero, then re-fires after the initial
 * reload populates the real data).
 */
export function attachConflictNotifier(manager: SyncManager): vscode.Disposable {
  const seen = new Set<string>();
  let toastInFlight = false;
  return manager.onDidChange((topology) => {
    const current = new Set<string>();
    let firstTimeCount = 0;
    for (const c of topology.conflicts) {
      const key = c.sourceFolderUri.toString();
      current.add(key);
      if (!seen.has(key)) {
        seen.add(key);
        firstTimeCount++;
      }
    }
    // Forget resolved conflicts so a resolve-then-re-create cycle does
    // re-toast (e.g. user undoes a delete, both files exist again).
    for (const key of seen) if (!current.has(key)) seen.delete(key);

    // Context key stays in sync with the live count regardless of
    // first-time-ness — the palette gate needs current state, not
    // whether we've toasted.
    void vscode.commands.executeCommand(
      'setContext',
      CONFLICT_CONTEXT_KEY,
      topology.conflicts.length > 0,
    );

    if (firstTimeCount === 0 || toastInFlight) return;
    toastInFlight = true;
    const message =
      firstTimeCount === 1
        ? 'Folder Sync: a folder contains both .sync.jsonc and .roomSync. Resolve?'
        : `Folder Sync: ${firstTimeCount} folders contain both .sync.jsonc and .roomSync. Resolve?`;
    void vscode.window
      .showWarningMessage(message, 'Resolve…')
      .then((choice) => {
        toastInFlight = false;
        if (choice === 'Resolve…') {
          void vscode.commands.executeCommand('folderSync.resolveConfigConflict');
        }
      });
  });
}
