// Wired surface for the `.admin-sync.jsonc` ↔ `.eventSync` filename-pair
// conflict. Mirrors `configConflict.ts` (which handles `.sync.jsonc` ↔
// `.roomSync`) but operates on the workspace-snapshot singleton instead of
// per-source-folder configs.
//
// Pieces:
//
//   1. `registerSnapshotConflictCommand` — the
//      `folderSync.resolveSnapshotConflict` palette command. Detects the
//      pair at `workspaceFolders[0]`, asks the user which file to keep,
//      deletes the loser. Idempotent — re-running after a successful
//      resolve is a no-op.
//
//   2. `attachSnapshotConflictNotifier` — auto-migration + one-shot toast.
//      When the user creates an empty `.eventSync` alongside a populated
//      `.admin-sync.jsonc` (which is what "New File → .eventSync"
//      produces), we silently copy the legacy contents over and delete the
//      legacy file — the user's intent is unambiguously "rename". Genuine
//      conflicts (both files have content) fall through to a single warning
//      toast per detection.
//
// A `folderSync.hasSnapshotConflict` context key gates the command's
// palette visibility (see package.json `menus.commandPalette`). Kept in
// sync with the presence-or-absence of the pair on every workspace event.
//
// Deletion goes through `deleteWithTrashFallback` everywhere — vscode.dev's
// FSA-backed `file://` provider rejects `{useTrash: true}` outright, so we
// catch the well-known failure mode and retry without trash.

import * as vscode from 'vscode';
import { log } from '../log';
import {
  LEGACY_SNAPSHOT_FILENAME,
  PREFERRED_SNAPSHOT_FILENAME,
  SNAPSHOT_FILE_PATTERN,
} from './snapshotFilenames';

const CONFLICT_CONTEXT_KEY = 'folderSync.hasSnapshotConflict';

interface DetectedConflict {
  /** Workspace folder root the pair lives in (always `workspaceFolders[0]`). */
  folderUri: vscode.Uri;
  /** `.admin-sync.jsonc` */
  legacyUri: vscode.Uri;
  /** `.eventSync` */
  eventSyncUri: vscode.Uri;
}

/**
 * Probe `workspaceFolders[0]` for a snapshot filename conflict. Returns
 * undefined when no workspace folder is open, or when at most one of the
 * two filenames exists. Stats run in parallel — at most two FS calls.
 */
async function detectConflict(): Promise<DetectedConflict | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return undefined;
  const folderUri = folders[0].uri;
  const base = folderUri.path.endsWith('/') ? folderUri.path.slice(0, -1) : folderUri.path;
  const legacyUri = folderUri.with({ path: `${base}/${LEGACY_SNAPSHOT_FILENAME}` });
  const eventSyncUri = folderUri.with({ path: `${base}/${PREFERRED_SNAPSHOT_FILENAME}` });
  const [legacyExists, eventSyncExists] = await Promise.all([
    statExists(legacyUri),
    statExists(eventSyncUri),
  ]);
  if (!(legacyExists && eventSyncExists)) return undefined;
  return { folderUri, legacyUri, eventSyncUri };
}

async function statExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export function registerSnapshotConflictCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(
    'folderSync.resolveSnapshotConflict',
    async () => {
      const c = await detectConflict();
      if (!c) {
        void vscode.window.showInformationMessage(
          'Folder Sync: no workspace-snapshot filename conflicts to resolve.',
        );
        return;
      }
      log(`sync: resolveSnapshotConflict — pair at ${c.folderUri.toString()}`);
      const resolved = await resolveOne(c);
      if (resolved) {
        // Re-evaluate so the context key flips to false.
        await refreshContextKey();
        void vscode.window.showInformationMessage(
          'Folder Sync: workspace-snapshot conflict resolved.',
        );
      }
    },
  );
}

interface ResolvePick extends vscode.QuickPickItem {
  target: vscode.Uri;
  keptLabel: string;
}

async function resolveOne(c: DetectedConflict): Promise<boolean> {
  const folderRel =
    vscode.workspace.asRelativePath(c.folderUri, false) || c.folderUri.toString();
  const items: ResolvePick[] = [
    {
      label: `Keep ${PREFERRED_SNAPSHOT_FILENAME}, delete ${LEGACY_SNAPSHOT_FILENAME}`,
      description: c.legacyUri.toString(),
      target: c.legacyUri,
      keptLabel: PREFERRED_SNAPSHOT_FILENAME,
    },
    {
      label: `Keep ${LEGACY_SNAPSHOT_FILENAME}, delete ${PREFERRED_SNAPSHOT_FILENAME}`,
      description: c.eventSyncUri.toString(),
      target: c.eventSyncUri,
      keptLabel: LEGACY_SNAPSHOT_FILENAME,
    },
  ];
  const pick = await vscode.window.showQuickPick<ResolvePick>(items, {
    title: `Folder Sync workspace-snapshot conflict in "${folderRel}"`,
    placeHolder: 'Choose which file to keep — the other will be deleted',
    ignoreFocusOut: true,
  });
  if (!pick) return false;
  try {
    await deleteWithTrashFallback(pick.target);
    log(
      `sync: resolveSnapshotConflict — deleted ${pick.target.toString()} ` +
        `(kept ${pick.keptLabel})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`sync: resolveSnapshotConflict — delete failed: ${message}`);
    void vscode.window.showErrorMessage(
      `Could not delete ${pick.target.toString()}: ${message}`,
    );
    return false;
  }
  return true;
}

async function refreshContextKey(): Promise<void> {
  const c = await detectConflict();
  void vscode.commands.executeCommand(
    'setContext',
    CONFLICT_CONTEXT_KEY,
    c !== undefined,
  );
}

/**
 * Auto-migration + first-time toast pump. Subscribes once at activation;
 * watches the snapshot filename pair at `workspaceFolders[0]` and reacts
 * on every create/change/delete event.
 *
 * Two kinds of "new" conflict can show up:
 *   - **Empty-`.eventSync` conflict** — user just created `.eventSync` via
 *     "New File"; it's zero bytes and the `.admin-sync.jsonc` is populated.
 *     We treat this as "rename the legacy to the new format": copy the
 *     legacy bytes into `.eventSync`, delete `.admin-sync.jsonc`. Silent —
 *     no toast, only an Output Channel log line.
 *   - **Real content conflict** — both files have content. The user
 *     deliberately authored both. We toast once and the resolve command
 *     runs the quick-pick.
 *
 * `seen` tracks whether we've already toasted-or-migrated about the
 * current pair so a stable conflict doesn't re-toast on every reload.
 * Cleared when the conflict goes away (any resolution path).
 *
 * `inFlight` guards against an event that lands while an async migration
 * is still running.
 */
export function attachSnapshotConflictNotifier(): vscode.Disposable {
  let seen = false;
  let inFlight = false;
  let toastInFlight = false;
  let folderWatcher: vscode.FileSystemWatcher | undefined;
  let watchedFolderUri: vscode.Uri | undefined;

  const checkAndReact = async (): Promise<void> => {
    const c = await detectConflict();
    void vscode.commands.executeCommand(
      'setContext',
      CONFLICT_CONTEXT_KEY,
      c !== undefined,
    );
    if (!c) {
      seen = false;
      return;
    }
    if (seen || inFlight) return;
    inFlight = true;
    try {
      const migrated = await tryAutoMigrateEmptyEventSync(c);
      if (migrated) {
        log(`sync: auto-migrated ${c.legacyUri.toString()} → ${c.eventSyncUri.toString()}`);
        // The delete fires another watcher event; the follow-up check finds
        // no conflict and clears `seen` automatically.
        return;
      }
    } catch (err) {
      log(
        `sync: snapshot auto-migrate threw — ` +
          (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      inFlight = false;
    }
    seen = true;
    if (toastInFlight) return;
    toastInFlight = true;
    void vscode.window
      .showWarningMessage(
        `Folder Sync: workspace has both ${LEGACY_SNAPSHOT_FILENAME} and ` +
          `${PREFERRED_SNAPSHOT_FILENAME}. Resolve?`,
        'Resolve…',
      )
      .then((choice) => {
        toastInFlight = false;
        if (choice === 'Resolve…') {
          void vscode.commands.executeCommand('folderSync.resolveSnapshotConflict');
        }
      });
  };

  const rewireWatcher = (): void => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const target = folders[0]?.uri;
    if (target?.toString() === watchedFolderUri?.toString()) return;
    folderWatcher?.dispose();
    folderWatcher = undefined;
    watchedFolderUri = target;
    if (!target) {
      // No folder — nothing to watch; clear stale state.
      seen = false;
      void vscode.commands.executeCommand('setContext', CONFLICT_CONTEXT_KEY, false);
      return;
    }
    const pattern = new vscode.RelativePattern(target, SNAPSHOT_FILE_PATTERN);
    folderWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    folderWatcher.onDidCreate(() => void checkAndReact());
    folderWatcher.onDidChange(() => void checkAndReact());
    folderWatcher.onDidDelete(() => void checkAndReact());
  };

  rewireWatcher();
  // Initial check at activation.
  void checkAndReact();

  const foldersSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    rewireWatcher();
    void checkAndReact();
  });

  return {
    dispose(): void {
      folderWatcher?.dispose();
      folderWatcher = undefined;
      foldersSub.dispose();
    },
  };
}

/**
 * Silent migration for the "user created `.eventSync` as an empty file"
 * case. Mirrors `tryAutoMigrateEmptyRoomSync` in configConflict.ts.
 *
 *   1. Stat `.eventSync`. If size > 0, the user has authored content —
 *      bail (false).
 *   2. Read `.admin-sync.jsonc` bytes; copy to `.eventSync`.
 *   3. Delete `.admin-sync.jsonc` via trash-fallback.
 */
async function tryAutoMigrateEmptyEventSync(c: DetectedConflict): Promise<boolean> {
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(c.eventSyncUri);
  } catch {
    return false;
  }
  if (stat.size !== 0) return false;

  let legacyBytes: Uint8Array;
  try {
    legacyBytes = await vscode.workspace.fs.readFile(c.legacyUri);
  } catch (err) {
    log(
      `sync: snapshot auto-migrate read failed for ${c.legacyUri.toString()} — ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }
  if (legacyBytes.length > 0) {
    try {
      await vscode.workspace.fs.writeFile(c.eventSyncUri, legacyBytes);
    } catch (err) {
      log(
        `sync: snapshot auto-migrate write failed for ${c.eventSyncUri.toString()} — ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return false;
    }
  }
  try {
    await deleteWithTrashFallback(c.legacyUri);
  } catch (err) {
    log(
      `sync: snapshot auto-migrate delete failed for ${c.legacyUri.toString()} — ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }
  return true;
}

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
