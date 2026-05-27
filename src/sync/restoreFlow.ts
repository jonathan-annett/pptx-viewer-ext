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
import { isWebHost } from '../host';
import {
  captureCurrent,
  emptySnapshot,
  readPlaceholdersFromDisk,
  SnapshotStore,
  snapshotsEqual,
  snapshotUri,
  type Snapshot,
} from './snapshotStore';
import { KNOWN_WORKSPACE_KEYS } from './snapshot';
import {
  getOperatorRestoreCapture,
  type OperatorRestoreCapture,
} from './destinationOnlyWired';
import { SYNC_CONFIG_GLOB } from './configFilenames';

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
  // Desktop VS Code persists workspace folders natively across restarts, so
  // re-mounting from the snapshot would either be redundant (folders are
  // already there) or actively surprising (re-adding folders the user
  // removed last session). The capture side — startSnapshotWriter — keeps
  // running on desktop so the .admin-sync.jsonc file stays current; that
  // way a user can switch a workspace from desktop to vscode.dev (where the
  // restore IS needed) and find their snapshot intact. Defensively clear
  // any leftover pending-settings flag from a previous web session in case
  // this workspace gets moved between hosts.
  if (!isWebHost()) {
    if (context.globalState.get<boolean>(PENDING_SETTINGS_KEY)) {
      await context.globalState.update(PENDING_SETTINGS_KEY, undefined);
      log('snapshot: desktop host — cleared stale pending-settings flag');
    }
    log('snapshot: desktop host — restore skipped (workspace persistence is native here)');
    return;
  }
  const pointer = store.getPointer();
  const opCapture = getOperatorRestoreCapture(context);

  if (!pointer && !opCapture) {
    log('snapshot: no pointer, no operator capture, no restore');
    return;
  }
  if (pointer) {
    log(`snapshot: pointer present uri=${pointer.uri} writtenAt=${pointer.lastWriteAt}`);
  }
  if (opCapture) {
    log(`operator-restore: capture present folders=${opCapture.folders.length} capturedAt=${opCapture.capturedAt}`);
  }

  // Give VS Code a tick to finish any in-flight folder add. Without this
  // we could race a user-initiated "Open Folder" still settling.
  await new Promise((r) => setTimeout(r, 0));

  const populated = (vscode.workspace.workspaceFolders ?? []).length > 0;
  const pending = context.globalState.get<boolean>(PENDING_SETTINGS_KEY) ?? false;

  if (populated && pending && pointer) {
    await finishPostRestart(context, store, pointer.uri);
    return;
  }
  if (populated) {
    log('snapshot: workspace already populated, no restore');
    return;
  }

  // Cold start — folderless tab.
  //
  // Prefer the operator-mode capture when present: destination-only
  // workspaces don't write `.admin-sync.jsonc`, so the file-based pointer
  // (if any) is left over from a prior main-user session and would
  // re-mount source folders the user no longer wants. The operator
  // capture is cleared when the user transitions back to main-user mode,
  // so this preference reliably reflects the latest intentional state.
  if (opCapture) {
    await operatorColdRestore(opCapture);
    return;
  }
  if (pointer) {
    await coldRestore(context, store, pointer.uri);
  }
}

/**
 * Cold restore for destination-only workspaces. Simpler than the main-
 * user `coldRestore`: no settings to apply (operator mode skips
 * `ensureWorkspaceLockSettings`), no decisions, no pending-flag handoff.
 * Just re-mount the captured workspace folders so the active-tab
 * restorer downstream has a folder for the file to live in.
 */
async function operatorColdRestore(capture: OperatorRestoreCapture): Promise<void> {
  if (capture.folders.length === 0) {
    log('operator-restore: capture has no folders');
    return;
  }
  const folderArgs = capture.folders.map((f) => ({
    uri: vscode.Uri.parse(f.uri),
    name: f.name,
  }));
  const ok = vscode.workspace.updateWorkspaceFolders(0, 0, ...folderArgs);
  log(`operator-restore: updateWorkspaceFolders(0, 0, ${folderArgs.length}) returned ${ok}`);
  if (!ok) {
    log('operator-restore: updateWorkspaceFolders failed — leaving workspace alone');
    return;
  }
  log(`operator-restore: re-mounted ${folderArgs.length} folder(s)`);
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
 * Seed the workspace's read-only lock settings if they aren't already set.
 *
 * Convention: workspaceFolders[0] is the writable source/operator folder; all
 * other open folders are destinations (sync writes to them, the user does not
 * edit them in this workspace). The two `files.readonly*` settings express
 * that intent — `**` is read-only by default, with the source folder's path
 * excluded.
 *
 * Seed-if-missing only — once a workspace-scope value is present we leave it
 * alone, so a user who customises the lock keeps their customisation across
 * activations. The snapshot system captures these keys as part of
 * KNOWN_WORKSPACE_KEYS, so restored workspaces already arrive with the user's
 * chosen values and this function then becomes a no-op.
 *
 * The pattern uses the workspace folder's display `name` because that's what
 * VS Code's `files.readonly*` glob matches against (matching the user's
 * verified working example: `/Speakers Prep/**`).
 */
export async function ensureWorkspaceLockSettings(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return;
  const config = vscode.workspace.getConfiguration();

  const includeInspect = config.inspect('files.readonlyInclude');
  if (includeInspect?.workspaceValue === undefined) {
    await config.update(
      'files.readonlyInclude',
      { '**': true },
      vscode.ConfigurationTarget.Workspace,
    );
    log('snapshot: seeded files.readonlyInclude = { "**": true }');
  }

  const excludeInspect = config.inspect('files.readonlyExclude');
  if (excludeInspect?.workspaceValue === undefined) {
    const writableFolder = folders[0].name;
    await config.update(
      'files.readonlyExclude',
      { [`/${writableFolder}/**`]: true },
      vscode.ConfigurationTarget.Workspace,
    );
    log(`snapshot: seeded files.readonlyExclude — writable: /${writableFolder}/**`);
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
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    log('snapshot: captureAndWriteSnapshot — no workspace folders, nothing to capture');
    return undefined;
  }
  const targetUri = folders[0].uri;
  // Preserve any user-added placeholder hashes; they're not derivable from
  // vscode state and would otherwise be wiped on every Refresh.
  const existingPlaceholders = await readPlaceholdersFromDisk(targetUri);
  const captured = captureCurrent(existingPlaceholders);
  if (!captured) {
    log('snapshot: captureAndWriteSnapshot — no workspace folders, nothing to capture');
    return undefined;
  }
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
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      log('snapshot: no workspace folders — skipping write');
      return;
    }
    // Gate on source presence rather than manifest presence. Without any
    // source config (`.sync.jsonc` or `.roomSync`) in the workspace,
    // there's no source intent expressed yet — the folder might be a
    // destination-in-waiting (manifest will arrive later), a fresh code
    // folder, or anything else. Writing .admin-sync.jsonc pre-emptively
    // would litter destination folders with a source-only artifact. When
    // sources eventually appear, the next manager.onDidChange fires this
    // listener and writes normally.
    const sources = await vscode.workspace.findFiles(SYNC_CONFIG_GLOB, undefined, 1);
    if (sources.length === 0) {
      log('snapshot: workspace has no sources — skipping write');
      return;
    }
    // Now that we've confirmed source intent, seed read-only lock
    // settings. Idempotent (`ensureWorkspaceLockSettings` is seed-if-
    // missing), so no harm calling it on every write. Runs BEFORE
    // captureCurrent so the snapshot includes the freshly-seeded values.
    try {
      await ensureWorkspaceLockSettings();
    } catch (err) {
      log(`snapshot: ensureWorkspaceLockSettings threw — ${errMsg(err)}`);
    }
    const target = folders[0].uri;
    // Preserve any user-added placeholder hashes across recapture; they live
    // only on disk and are not derivable from vscode state.
    const existingPlaceholders = await readPlaceholdersFromDisk(target);
    const captured = captureCurrent(existingPlaceholders);
    if (!captured) {
      log('snapshot: no workspace folders — skipping write');
      return;
    }

    if (lastWritten === undefined) {
      // First fire post-activation. Read on-disk so we can skip a no-op
      // rewrite if nothing actually changed.
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
  const message = isWebHost()
    ? 'Clear workspace snapshot? The .admin-sync.jsonc file will be deleted, ' +
      'and the next browser refresh will land in a folderless tab.'
    : 'Clear workspace snapshot? The .admin-sync.jsonc file will be deleted. ' +
      'Your currently open folders are unaffected — desktop VS Code persists ' +
      'them natively. The snapshot will be re-captured on the next topology change.';
  const choice = await vscode.window.showWarningMessage(
    message,
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
