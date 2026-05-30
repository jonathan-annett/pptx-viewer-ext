// Factory-reset command. Clears all extension-owned persistent state:
// IDB databases (search index, hash cache, parse cache) + globalState keys
// (saved tabs, snapshot pointer, operator-restore capture, pending-settings
// flag, autoSyncAfterDrop preference).
//
// Workspace files (.sync.jsonc, .admin-sync.jsonc, .foldersync-manifest.json,
// .eventSchedule, .roomSync, the on-disk snapshot files) are user data and
// are NOT touched.
//
// Open IDB connections from the running extension block deleteDatabase until
// they close — the actual drop completes on window reload. The request is
// queued either way, so the UI prompts the user to reload after the command
// finishes.

import * as vscode from 'vscode';
import { log } from './log';

// IDB database names. Cross-reference each owner so a rename here is caught
// by the same grep that finds the owning module's DB_NAME constant.
const IDB_DATABASES = [
  'pptxSearch.index',      // src/search/indexStore.ts
  'folderSync.hashCache',  // src/sync/hashCacheIdb.ts
  'folderSync.parseCache', // src/sync/parseCacheIdb.ts
];

// All globalState keys this extension writes to. The grep
// `context\.globalState\.update|this\.context\.globalState\.update` is the
// authoritative source — keep this list in sync.
const GLOBAL_STATE_KEYS = [
  'pptxViewer.lastActiveTab',           // src/extension.ts
  'pptxViewer.lastActiveUri',           // src/extension.ts (legacy migration marker)
  'pptxViewer.autoSyncAfterDrop',       // src/provider.ts
  'folderSync.snapshotPointer',         // src/sync/snapshotStore.ts
  'folderSync.operatorRestore',         // src/sync/destinationOnlyWired.ts
  'folderSync.snapshotPendingSettings', // src/sync/restoreFlow.ts
];

// deleteDatabase can fire none of success/error/blocked when IDB itself is
// unavailable (worker context without an FS provider, etc.). Bound each
// request so the command always terminates.
const DELETE_TIMEOUT_MS = 1500;

export function registerResetState(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'pptxViewer.resetExtensionState',
    async () => {
      const choice = await vscode.window.showWarningMessage(
        'Reset Pptx Info extension state?',
        {
          modal: true,
          detail:
            'Clears all extension-managed caches and saved tabs. ' +
            'Workspace files (.sync.jsonc, manifests, .eventSchedule, etc.) ' +
            'are NOT touched. A window reload is required to complete.',
        },
        'Reset',
      );
      if (choice !== 'Reset') {
        log('reset: cancelled by user');
        return;
      }

      log('--- reset: extension state ---');

      for (const key of GLOBAL_STATE_KEYS) {
        const had = context.globalState.get(key) !== undefined;
        await context.globalState.update(key, undefined);
        log(`reset: globalState[${key}] ${had ? 'cleared' : 'absent'}`);
      }

      for (const name of IDB_DATABASES) {
        await deleteIdbDatabase(name);
      }

      log('--- reset: complete (reload window to finalise IDB deletes) ---');
      void vscode.commands.executeCommand('workbench.action.output.toggleOutput');

      const reload = await vscode.window.showInformationMessage(
        'Extension state cleared. Reload the window to complete the reset.',
        'Reload Window',
      );
      if (reload === 'Reload Window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    },
  );
}

async function deleteIdbDatabase(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let resolved = false;
    const done = (label: string): void => {
      if (resolved) return;
      resolved = true;
      log(`reset: idb[${name}] ${label}`);
      resolve();
    };
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.deleteDatabase(name);
    } catch (err) {
      done(`request failed — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    req.onsuccess = (): void => done('deleted');
    req.onerror = (): void =>
      done(`error — ${req.error?.message ?? 'unknown'}`);
    req.onblocked = (): void =>
      done('blocked by open connection (will complete on window reload)');
    setTimeout(() => done('timeout (delete queued)'), DELETE_TIMEOUT_MS);
  });
}
