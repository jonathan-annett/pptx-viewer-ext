// M4.6 — silent restore flow.
//
// Orchestrates the cold-activation path: read pointer → read snapshot →
// re-mount folders → apply known settings → toast. Also owns the
// topology-change subscriber that re-captures and writes the snapshot
// whenever the workspace shape changes.
//
// Per-file flow split from snapshotStore.ts (which is I/O) and
// snapshot.ts (which is pure data shaping) so the activation orchestration
// is in one place and the commands can also pull bits out cheaply.

import * as vscode from 'vscode';
import { log } from '../log';
import {
  captureCurrent,
  emptySnapshot,
  SnapshotStore,
  snapshotsEqual,
  snapshotUri,
  type Snapshot,
} from './snapshotStore';
import { KNOWN_WORKSPACE_KEYS } from './snapshot';

const PENDING_SETTINGS_KEY = 'folderSync.snapshotPendingSettings';

/**
 * Run on activation, before SyncManager.create, to attempt silent restore
 * of the workspace shape from a prior session. Two entry conditions:
 *
 *   1. Cold start (folderless tab) with a pointer present → read the
 *      snapshot, call updateWorkspaceFolders. First-folder-add triggers a
 *      host restart per VS Code API docs, so we set a `pending settings`
 *      flag in globalState before the call and finish the job (settings +
 *      toast) on the post-restart activation.
 *
 *   2. Hot start (workspace already populated) with `pending settings`
 *      flag set → this is the post-restart leg of a prior cold restore;
 *      apply settings, show the toast, clear the flag.
 *
 * Any failure logs and returns without disturbing the workspace.
 */
export async function maybeRestore(
  context: vscode.ExtensionContext,
  store: SnapshotStore,
): Promise<void> {
  const pointer = store.getPointer();
  if (!pointer) {
    log('snapshot: no pointer, no restore');
    return;
  }
  log(`snapshot: pointer present uri=${pointer.uri} writtenAt=${pointer.lastWriteAt}`);

  // Give VS Code a tick to finish any in-flight folder add. Without this
  // we could race a user-initiated "Open Folder" still settling.
  await new Promise((r) => setTimeout(r, 0));

  const populated = (vscode.workspace.workspaceFolders ?? []).length > 0;
  const pending = context.globalState.get<boolean>(PENDING_SETTINGS_KEY) ?? false;

  if (populated && pending) {
    await finishPostRestart(context, store, pointer.uri);
    return;
  }
  if (populated) {
    log('snapshot: workspace already populated, no restore');
    return;
  }
  // Cold start — folderless tab + pointer present.
  await coldRestore(context, store, pointer.uri);
}

async function coldRestore(
  context: vscode.ExtensionContext,
  store: SnapshotStore,
  pointerUriString: string,
): Promise<void> {
  let pointerUri: vscode.Uri;
  try {
    pointerUri = vscode.Uri.parse(pointerUriString);
  } catch (err) {
    log(`snapshot: pointer URI is not parseable (${errMsg(err)}); leaving workspace alone`);
    return;
  }
  const snapshot = await store.readSnapshot(pointerUri);
  if (!snapshot) {
    log('snapshot: pointer present but file unreadable; leaving workspace alone');
    return;
  }
  if (snapshot.folders.length === 0) {
    log('snapshot: snapshot has no folders; nothing to restore');
    return;
  }

  // Mark pending so the post-host-restart leg can finish the job. Set
  // before the updateWorkspaceFolders call because the host may terminate
  // synchronously-ish after the call returns.
  await context.globalState.update(PENDING_SETTINGS_KEY, true);

  const folderArgs = snapshot.folders.map((f) => ({
    uri: vscode.Uri.parse(f.uri),
    name: f.name,
  }));
  const ok = vscode.workspace.updateWorkspaceFolders(0, 0, ...folderArgs);
  log(`snapshot: updateWorkspaceFolders(0, 0, ${folderArgs.length} folder(s)) returned ${ok}`);
  if (!ok) {
    // Call failed without mutating. No host restart will happen — clear
    // the pending flag so we don't show a misleading toast next time.
    await context.globalState.update(PENDING_SETTINGS_KEY, undefined);
    log('snapshot: restore aborted (updateWorkspaceFolders returned false)');
    return;
  }

  // If we survive the call (no host restart), finish in this activation.
  // First-folder-add usually restarts the host, but it's not documented
  // as synchronous — defensively complete here too.
  await new Promise((r) => setTimeout(r, 50));
  const nowPopulated = (vscode.workspace.workspaceFolders ?? []).length > 0;
  if (nowPopulated) {
    await applySettings(snapshot);
    await context.globalState.update(PENDING_SETTINGS_KEY, undefined);
    showRestoreToast(context, store, snapshot);
    log('snapshot: restore completed in same activation (no host restart observed)');
  } else {
    log('snapshot: folders added; expecting host restart, settings will apply post-restart');
  }
}

async function finishPostRestart(
  context: vscode.ExtensionContext,
  store: SnapshotStore,
  pointerUriString: string,
): Promise<void> {
  let pointerUri: vscode.Uri;
  try {
    pointerUri = vscode.Uri.parse(pointerUriString);
  } catch (err) {
    log(`snapshot: post-restart pointer URI unparseable (${errMsg(err)})`);
    await context.globalState.update(PENDING_SETTINGS_KEY, undefined);
    return;
  }
  const snapshot = await store.readSnapshot(pointerUri);
  if (!snapshot) {
    log('snapshot: post-restart — file unreadable; clearing pending flag');
    await context.globalState.update(PENDING_SETTINGS_KEY, undefined);
    return;
  }
  await applySettings(snapshot);
  await context.globalState.update(PENDING_SETTINGS_KEY, undefined);
  showRestoreToast(context, store, snapshot);
  log('snapshot: post-restart settings application complete');
}

async function applySettings(snapshot: Snapshot): Promise<void> {
  const keys = Object.keys(snapshot.settings);
  if (keys.length === 0) {
    log('snapshot: no settings to apply');
    return;
  }
  const config = vscode.workspace.getConfiguration();
  let applied = 0;
  for (const key of keys) {
    const value = snapshot.settings[key];
    const known = KNOWN_WORKSPACE_KEYS.includes(key);
    if (!known) {
      // Per spec: still restore, but log so we can grow KNOWN_WORKSPACE_KEYS.
      log(`snapshot: restoring unknown setting ${key} = ${valueSummary(value)}`);
    }
    try {
      await config.update(key, value, vscode.ConfigurationTarget.Workspace);
      applied++;
    } catch (err) {
      log(`snapshot: failed to apply ${key} — ${errMsg(err)}`);
    }
  }
  log(`snapshot: applied ${applied}/${keys.length} setting(s)`);
}

function showRestoreToast(
  context: vscode.ExtensionContext,
  store: SnapshotStore,
  snapshot: Snapshot,
): void {
  const folderCount = snapshot.folders.length;
  const settingCount = Object.keys(snapshot.settings).length;
  const msg = `Workspace restored from snapshot — ${folderCount} folder(s)${
    settingCount > 0 ? `, ${settingCount} setting(s)` : ''
  }`;
  // Fire-and-forget: don't block activation on the user's response.
  void vscode.window.showInformationMessage(msg, 'Undo').then(async (choice) => {
    if (choice !== 'Undo') return;
    await undoRestore(context, store, snapshot);
  });
}

async function undoRestore(
  context: vscode.ExtensionContext,
  store: SnapshotStore,
  snapshot: Snapshot,
): Promise<void> {
  log('snapshot: Undo requested — removing restored folders and clearing snapshot');
  const pointer = store.getPointer();
  // Clear pointer first so a host-restart triggered by folder removal
  // doesn't re-restore on the next activation.
  await store.clearPointer();
  await context.globalState.update(PENDING_SETTINGS_KEY, undefined);
  if (pointer) {
    try {
      await store.deleteSnapshot(vscode.Uri.parse(pointer.uri));
      log('snapshot: deleted .admin-sync.jsonc on undo');
    } catch (err) {
      log(`snapshot: failed to delete snapshot file on undo — ${errMsg(err)}`);
    }
  }
  // Remove the folders we just added. They sit at the front of
  // workspaceFolders because we inserted at index 0.
  const current = vscode.workspace.workspaceFolders ?? [];
  const toRemove = Math.min(snapshot.folders.length, current.length);
  if (toRemove > 0) {
    const ok = vscode.workspace.updateWorkspaceFolders(0, toRemove);
    log(`snapshot: undo updateWorkspaceFolders(0, ${toRemove}) returned ${ok}`);
  }
}

/**
 * Capture current workspace state and write it through `store`, bypassing
 * any diff-against-last-write. Used by the admin editor's "Refresh from
 * current workspace" button and reusable from commands. Returns the
 * captured snapshot on success, undefined when there are no folders to
 * capture, throws on write failure.
 */
export async function captureAndWriteSnapshot(store: SnapshotStore): Promise<Snapshot | undefined> {
  const captured = captureCurrent();
  if (!captured) {
    log('snapshot: captureAndWriteSnapshot — no workspace folders, nothing to capture');
    return undefined;
  }
  const targetUri = vscode.workspace.workspaceFolders![0].uri;
  const finalUri = await store.writeSnapshot(targetUri, captured);
  await store.setPointer({
    uri: finalUri.toString(),
    lastWriteAt: captured.capturedAt,
  });
  log(
    `snapshot: force-captured to ${finalUri.toString()} — ` +
      `${captured.folders.length} folder(s), ${Object.keys(captured.settings).length} setting(s)`,
  );
  return captured;
}

/**
 * Subscribe to topology changes and rewrite the snapshot when the captured
 * shape differs from what's on disk. Initial state is read from disk so
 * the first event after activation doesn't blindly rewrite.
 */
export function startSnapshotWriter(
  store: SnapshotStore,
  onChange: (listener: () => void) => vscode.Disposable,
): vscode.Disposable {
  let lastWritten: Snapshot | undefined;
  // Serialise writes — topology events can burst.
  let writing = false;
  let pending = false;

  const runWrite = async (): Promise<void> => {
    if (writing) {
      pending = true;
      return;
    }
    writing = true;
    try {
      do {
        pending = false;
        await tryWrite();
      } while (pending);
    } finally {
      writing = false;
    }
  };

  const tryWrite = async (): Promise<void> => {
    const captured = captureCurrent();
    if (!captured) {
      log('snapshot: no workspace folders — skipping write');
      return;
    }

    if (lastWritten === undefined) {
      // First fire post-activation. Read on-disk so we can skip a no-op
      // rewrite if nothing actually changed.
      const target = vscode.workspace.workspaceFolders![0].uri;
      const onDiskUri = snapshotUri(target);
      const onDisk = await store.readSnapshot(onDiskUri).catch(() => undefined);
      if (onDisk && snapshotsEqual(onDisk, captured)) {
        lastWritten = onDisk;
        // Refresh pointer (in case it was missing/stale).
        await store.setPointer({
          uri: onDiskUri.toString(),
          lastWriteAt: onDisk.capturedAt || captured.capturedAt,
        });
        log('snapshot: on-disk matches current state — no write needed');
        return;
      }
    } else if (snapshotsEqual(lastWritten, captured)) {
      log('snapshot: state unchanged since last write — skipping');
      return;
    }

    const target = vscode.workspace.workspaceFolders![0].uri;
    try {
      const finalUri = await store.writeSnapshot(target, captured);
      await store.setPointer({
        uri: finalUri.toString(),
        lastWriteAt: captured.capturedAt,
      });
      lastWritten = captured;
      log(
        `snapshot: wrote ${finalUri.toString()} — ` +
          `${captured.folders.length} folder(s), ${Object.keys(captured.settings).length} setting(s)`,
      );
    } catch (err) {
      log(`snapshot: write FAILED — ${errMsg(err)}`);
    }
  };

  return onChange(() => {
    void runWrite();
  });
}

/** Dump the current snapshot (on-disk) to the Output Channel. */
export async function showSnapshotCommand(store: SnapshotStore): Promise<void> {
  const pointer = store.getPointer();
  if (!pointer) {
    log('snapshot: no pointer, nothing to show');
    return;
  }
  log(`snapshot: pointer uri=${pointer.uri} writtenAt=${pointer.lastWriteAt}`);
  let snapshot: Snapshot | undefined;
  try {
    snapshot = await store.readSnapshot(vscode.Uri.parse(pointer.uri));
  } catch (err) {
    log(`snapshot: read failed — ${errMsg(err)}`);
    return;
  }
  if (!snapshot) {
    log('snapshot: file at pointer is unreadable');
    return;
  }
  log(`snapshot: capturedAt=${snapshot.capturedAt}`);
  log(`snapshot: ${snapshot.folders.length} folder(s):`);
  for (const f of snapshot.folders) {
    log(`  - ${f.name} → ${f.uri}`);
  }
  const keys = Object.keys(snapshot.settings);
  log(`snapshot: ${keys.length} setting(s):`);
  for (const k of keys) {
    log(`  - ${k} = ${valueSummary(snapshot.settings[k])}`);
  }
}

/** Clear pointer + delete .admin-sync.jsonc. Confirmation prompt before destructive action. */
export async function clearSnapshotCommand(
  context: vscode.ExtensionContext,
  store: SnapshotStore,
): Promise<void> {
  const pointer = store.getPointer();
  if (!pointer) {
    log('snapshot: nothing to clear (no pointer)');
    void vscode.window.showInformationMessage('No workspace snapshot to clear.');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    'Clear workspace snapshot? The .admin-sync.jsonc file will be deleted, ' +
      'and the next browser refresh will land in a folderless tab.',
    { modal: true },
    'Clear',
  );
  if (choice !== 'Clear') {
    log('snapshot: clear cancelled by user');
    return;
  }
  await store.clearPointer();
  await context.globalState.update(PENDING_SETTINGS_KEY, undefined);
  try {
    await store.deleteSnapshot(vscode.Uri.parse(pointer.uri));
    log('snapshot: cleared — pointer removed, file deleted');
  } catch (err) {
    log(`snapshot: file delete failed (${errMsg(err)}) — pointer cleared anyway`);
  }
  void vscode.window.showInformationMessage('Workspace snapshot cleared.');
}

// --- utility helpers ---

function valueSummary(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length} item(s)]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).length} key(s)}`;
  return JSON.stringify(v);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Tiny helper used by tests / debug only; falls out of imports cleanly otherwise. */
export const _internal = { emptySnapshot };
