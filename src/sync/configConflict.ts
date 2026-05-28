// Wired surface for the `.sync.jsonc` ↔ `.roomSync` filename-pair conflict.
//
// Pieces ride on top of `topology.conflicts` (populated by SyncManager —
// see room-sync-format-v1-plan.md M1):
//
//   1. `registerConfigConflictCommand` — the `folderSync.resolveConfigConflict`
//      palette command. Walks every pending conflict, asks the user which file
//      to keep, deletes the loser. Re-reads the topology after each deletion
//      so a follow-up conflict in the same folder isn't missed.
//
//   2. `attachConflictNotifier` — auto-migration + one-shot toast. When the
//      user creates an empty `.roomSync` alongside a populated `.sync.jsonc`
//      (which is what "New File → .roomSync" produces), we silently copy
//      the legacy contents over and delete the legacy file — the user's
//      intent is unambiguously "rename". Genuine conflicts (both files
//      have content) fall through to a single warning toast per detection.
//      The toast is suppressed until the user resolves an existing
//      conflict (so a `.sync.jsonc` save doesn't re-pester them).
//
// A `folderSync.hasConfigConflict` context key gates the command's palette
// visibility (see package.json `menus.commandPalette`). Kept in sync with
// `topology.conflicts.length > 0` on every manager emit.
//
// Deletion goes through `deleteWithTrashFallback` everywhere. vscode.dev's
// FSA-backed file:// provider rejects `{useTrash: true}` outright, so we
// catch the well-known failure mode and retry without trash — the user
// loses recoverability there (no system trash to restore from anyway),
// but the operation succeeds.

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
    await deleteWithTrashFallback(pick.target);
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
 * Auto-migration + first-time toast pump for new conflicts. Subscribes
 * once at activation and rides the manager's emits.
 *
 * Two kinds of "new" conflict can show up on an emit:
 *   - **Empty-`.roomSync` conflict** — user just created `.roomSync` via
 *     "New File"; it's zero bytes and the `.sync.jsonc` is populated.
 *     We treat this as "rename the legacy to the new format": copy the
 *     legacy bytes into `.roomSync`, delete `.sync.jsonc`. Silent — no
 *     toast, only an Output Channel log line.
 *   - **Real content conflict** — both files have content. The user
 *     deliberately authored both at some point. We toast once and the
 *     resolve command runs the quick-pick.
 *
 * `seen` tracks folders we've already toasted-or-migrated about, so a
 * stable conflict doesn't re-toast on every reload. Entries are cleared
 * when the conflict goes away (any-cause resolution — auto-migrate,
 * manual resolve, external delete), so a resolve-then-recreate cycle
 * re-runs the auto-migrate / re-toasts as appropriate.
 *
 * `inFlight` guards against an emit that lands while an async migration
 * is still running (e.g. the user saves the legacy file mid-migration,
 * triggering a follow-up reload). Without this, a second migration could
 * fire on the same pair.
 */
export function attachConflictNotifier(manager: SyncManager): vscode.Disposable {
  const seen = new Set<string>();
  const inFlight = new Set<string>();
  let toastInFlight = false;
  return manager.onDidChange((topology) => {
    const current = new Set<string>();
    for (const c of topology.conflicts) current.add(c.sourceFolderUri.toString());

    // Forget conflicts that have gone away — covers any resolution path,
    // including the auto-migration we may have fired on a prior emit.
    for (const key of seen) if (!current.has(key)) seen.delete(key);

    void vscode.commands.executeCommand(
      'setContext',
      CONFLICT_CONTEXT_KEY,
      topology.conflicts.length > 0,
    );

    // Filter to conflicts we haven't acted on yet.
    const newConflicts: SyncConfigConflict[] = [];
    for (const c of topology.conflicts) {
      const key = c.sourceFolderUri.toString();
      if (seen.has(key) || inFlight.has(key)) continue;
      newConflicts.push(c);
    }
    if (newConflicts.length === 0) return;
    for (const c of newConflicts) inFlight.add(c.sourceFolderUri.toString());

    // Async pass: try auto-migration first; collect what remains.
    void (async () => {
      const unresolved: SyncConfigConflict[] = [];
      let migratedCount = 0;
      for (const c of newConflicts) {
        const key = c.sourceFolderUri.toString();
        let migrated = false;
        try {
          migrated = await tryAutoMigrateEmptyRoomSync(c);
        } catch (err) {
          // tryAutoMigrate already logs its own failures, but a thrown
          // error here would leak the conflict — log defensively.
          log(
            `sync: auto-migrate threw for ${key} — ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
        inFlight.delete(key);
        if (migrated) {
          migratedCount++;
          // Don't add to `seen` — the topology reload from the delete
          // will clear this conflict and the natural cleanup loop above
          // takes care of the rest.
          continue;
        }
        seen.add(key);
        unresolved.push(c);
      }
      if (migratedCount > 0) {
        log(`sync: auto-migrated ${migratedCount} empty .roomSync file(s) to legacy contents`);
      }
      if (unresolved.length === 0 || toastInFlight) return;
      toastInFlight = true;
      const message =
        unresolved.length === 1
          ? 'Folder Sync: a folder contains both .sync.jsonc and .roomSync. Resolve?'
          : `Folder Sync: ${unresolved.length} folders contain both .sync.jsonc and .roomSync. Resolve?`;
      void vscode.window
        .showWarningMessage(message, 'Resolve…')
        .then((choice) => {
          toastInFlight = false;
          if (choice === 'Resolve…') {
            void vscode.commands.executeCommand('folderSync.resolveConfigConflict');
          }
        });
    })();
  });
}

/**
 * Silent migration for the "user created `.roomSync` as an empty file"
 * case. Stats `.roomSync`; if size is non-zero, returns false (the user
 * has authored content that we shouldn't overwrite). Otherwise:
 *
 *   1. Read `.sync.jsonc` bytes.
 *   2. Write them to `.roomSync` (overwrites the empty file).
 *   3. Delete `.sync.jsonc` via trash-fallback.
 *
 * Steps 1 and 2 can race against a user edit on `.roomSync` between
 * the stat and the write. The window is tiny (microseconds) and the
 * worst-case outcome is that a fast-typing user's blank-file edits get
 * overwritten by the legacy contents — which is the desired direction
 * anyway. Step 3's failure leaves both files populated identically;
 * that re-surfaces as a real conflict on the next reload and the
 * normal toast path handles it.
 */
async function tryAutoMigrateEmptyRoomSync(c: SyncConfigConflict): Promise<boolean> {
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(c.roomSyncUri);
  } catch {
    return false; // file vanished between detection and migration
  }
  if (stat.size !== 0) return false;

  let legacyBytes: Uint8Array;
  try {
    legacyBytes = await vscode.workspace.fs.readFile(c.legacyUri);
  } catch (err) {
    log(
      `sync: auto-migrate read failed for ${c.legacyUri.toString()} — ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }
  // No-op when the legacy file is also empty — keep the .roomSync file
  // empty too, and still drop the legacy so the conflict goes away.
  if (legacyBytes.length > 0) {
    try {
      await vscode.workspace.fs.writeFile(c.roomSyncUri, legacyBytes);
    } catch (err) {
      log(
        `sync: auto-migrate write failed for ${c.roomSyncUri.toString()} — ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return false;
    }
  }
  try {
    await deleteWithTrashFallback(c.legacyUri);
  } catch (err) {
    log(
      `sync: auto-migrate delete failed for ${c.legacyUri.toString()} — ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }
  log(
    `sync: auto-migrated ${c.legacyUri.toString()} → ${c.roomSyncUri.toString()} ` +
      `(${legacyBytes.length} bytes)`,
  );
  return true;
}

/**
 * Delete with `useTrash: true` when supported, fall back to a direct
 * delete when the provider rejects the option. vscode.dev's FSA-backed
 * `file://` provider surfaces "Unable to delete … because provider does
 * not support it"; web-FS-only environments simply can't move to trash.
 *
 * The detection is by error message because vscode doesn't expose a
 * stable error code for this case — the message text is stable across
 * recent VS Code versions and contains the literal "trash" plus
 * "does not support". Both must appear (the lone word "trash" can
 * happen in unrelated FS errors).
 */
async function deleteWithTrashFallback(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { useTrash: true });
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/trash/i.test(message) || !/does not support/i.test(message)) {
      throw err;
    }
    log(`sync: trash unavailable for ${uri.toString()} — falling back to direct delete`);
    await vscode.workspace.fs.delete(uri);
  }
}
