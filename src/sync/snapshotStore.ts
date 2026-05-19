// M4.6 — workspace snapshot, wired layer.
//
// This is the vscode-touching half of the snapshot system. It owns:
//   - The globalState pointer (read/write)
//   - The .admin-sync.jsonc file on disk (atomic read/write/delete)
//   - Capturing a Snapshot from the current vscode.workspace state
//
// Pure data shaping (marshal/unmarshal, equality, types) lives in
// ./snapshot.ts so the parse/serialise logic can be unit-tested under
// plain Node via tsx.

import * as vscode from 'vscode';
import { log } from '../log';
import {
  emptySnapshot,
  KNOWN_WORKSPACE_KEYS,
  marshalSnapshot,
  parseSnapshot,
  snapshotsEqual,
  type Snapshot,
  type SnapshotFolder,
  type SnapshotPointer,
  type SnapshotSettings,
} from './snapshot';

const POINTER_KEY = 'folderSync.snapshotPointer';
const SNAPSHOT_FILENAME = '.admin-sync.jsonc';

export {
  emptySnapshot,
  snapshotsEqual,
  type Snapshot,
  type SnapshotFolder,
  type SnapshotPointer,
};

/** Owns the globalState pointer and the on-disk snapshot file. */
export class SnapshotStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  // --- pointer ---

  getPointer(): SnapshotPointer | undefined {
    return this.context.globalState.get<SnapshotPointer>(POINTER_KEY);
  }

  async setPointer(pointer: SnapshotPointer): Promise<void> {
    await this.context.globalState.update(POINTER_KEY, pointer);
  }

  async clearPointer(): Promise<void> {
    await this.context.globalState.update(POINTER_KEY, undefined);
  }

  // --- snapshot file I/O ---

  /**
   * Read and parse the snapshot at the given URI. Returns undefined for
   * any failure mode (missing file, invalid utf-8, unparseable JSONC).
   * Parse-tolerance warnings are logged but don't suppress the returned
   * snapshot — that's the caller's call.
   */
  async readSnapshot(uri: vscode.Uri): Promise<Snapshot | undefined> {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (err) {
      log(`snapshot: read FAILED at ${uri.toString()} — ${errMsg(err)}`);
      return undefined;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (err) {
      log(`snapshot: file at ${uri.toString()} is not valid utf-8 (${errMsg(err)})`);
      return undefined;
    }
    const result = parseSnapshot(text);
    for (const e of result.errors) {
      log(`snapshot: parse warning — ${e}`);
    }
    return result.snapshot;
  }

  /**
   * Write the snapshot to disk. Two paths:
   *
   * 1. If a TextDocument is currently open on the target URI (typically
   *    because the admin custom editor is showing the file), route the
   *    write through `vscode.workspace.applyEdit` + `TextDocument.save()`.
   *    The atomic tmp+rename pattern below replaces the file on disk,
   *    which VS Code surfaces as a delete-and-recreate — the backing
   *    document is disposed and any custom editor bound to it closes.
   *    applyEdit goes through the document model, so the editor stays
   *    alive and receives `onDidChangeTextDocument`.
   *
   * 2. Otherwise, atomic write: tmp + rename. Mirrors `writeManifest`
   *    exactly so the two paths share a failure model.
   *
   * Returns the final URI on success; throws on failure so the caller
   * can decide whether to surface or swallow.
   */
  async writeSnapshot(folderUri: vscode.Uri, snapshot: Snapshot): Promise<vscode.Uri> {
    const finalUri = snapshotUri(folderUri);
    const text = marshalSnapshot(snapshot);

    const openDoc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === finalUri.toString(),
    );
    if (openDoc) {
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        openDoc.positionAt(0),
        openDoc.positionAt(openDoc.getText().length),
      );
      edit.replace(finalUri, fullRange, text);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) throw new Error('applyEdit rejected for snapshot file');
      // Persist to disk so a cold-start activation can read it without
      // depending on the document still being open.
      await openDoc.save();
      return finalUri;
    }

    const tmpUri = folderUri.with({ path: `${finalUri.path}.tmp` });
    const bytes = new TextEncoder().encode(text);
    await vscode.workspace.fs.writeFile(tmpUri, bytes);
    try {
      await vscode.workspace.fs.rename(tmpUri, finalUri, { overwrite: true });
    } catch (err) {
      // Best-effort tmp cleanup; rethrow regardless so the caller logs.
      try { await vscode.workspace.fs.delete(tmpUri); } catch { /* ignore */ }
      throw err;
    }
    return finalUri;
  }

  async deleteSnapshot(uri: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.delete(uri);
  }
}

/** URI of the snapshot file at the root of a given workspace folder. */
export function snapshotUri(folderUri: vscode.Uri): vscode.Uri {
  const base = folderUri.path.endsWith('/') ? folderUri.path.slice(0, -1) : folderUri.path;
  return folderUri.with({ path: `${base}/${SNAPSHOT_FILENAME}` });
}

/**
 * Build a Snapshot from the current vscode.workspace state. Returns
 * undefined if there are no workspace folders (nothing to capture, no
 * target folder for the file).
 *
 * Settings capture is currently restricted to KNOWN_WORKSPACE_KEYS. See
 * the comment on that constant in ./snapshot.ts for why.
 */
export function captureCurrent(): Snapshot | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return undefined;

  const snapFolders: SnapshotFolder[] = folders.map((f) => ({
    uri: f.uri.toString(),
    name: f.name,
  }));

  const settings: SnapshotSettings = {};
  const config = vscode.workspace.getConfiguration();
  for (const key of KNOWN_WORKSPACE_KEYS) {
    const inspected = config.inspect(key);
    if (inspected && inspected.workspaceValue !== undefined) {
      settings[key] = inspected.workspaceValue;
    }
  }

  return {
    folders: snapFolders,
    settings,
    capturedAt: new Date().toISOString(),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
