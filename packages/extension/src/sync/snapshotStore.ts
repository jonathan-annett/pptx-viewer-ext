// M4.6 — workspace snapshot, wired layer.
//
// This is the vscode-touching half of the snapshot system. It owns:
//   - The globalState pointer (read/write)
//   - The on-disk snapshot file (atomic read/write/delete); recognised
//     filenames live in ./snapshotFilenames.ts — `.eventSync` is the
//     preferred new name, `.admin-sync.jsonc` is the legacy alias kept for
//     backward compat (existing workspaces keep their file).
//   - Capturing a Snapshot from the current vscode.workspace state
//
// Pure data shaping (marshal/unmarshal, equality, types) lives in
// ./snapshot.ts so the parse/serialise logic can be unit-tested under
// plain Node via tsx.

import * as vscode from 'vscode';
import { log } from 'pptx-tools-core/log';
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
} from 'pptx-tools-core/sync/snapshot';
import {
  PREFERRED_SNAPSHOT_FILENAME,
  SNAPSHOT_FILENAMES,
  type SnapshotFilename,
} from 'pptx-tools-core/sync/snapshotFilenames';

const POINTER_KEY = 'folderSync.snapshotPointer';

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
    // Write to whichever snapshot filename already exists at this folder, or
    // to the preferred new filename (`.eventSync`) when neither does. This
    // way an in-place edit doesn't migrate the legacy `.admin-sync.jsonc`
    // out from under a user who's chosen to keep it; the rename happens
    // only when the user explicitly creates the alias file (handled by the
    // conflict surface in `snapshotConflict.ts`).
    const resolved = await resolveSnapshotUri(folderUri);
    const finalUri = resolved.uri;
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

/**
 * URI of the *preferred* snapshot filename at the root of a given
 * workspace folder. Used when we need a single canonical URI without
 * touching the filesystem (cold-restore fallback, openAdminConfig when no
 * pointer is set). For paths where "which file is actually on disk" matters,
 * call {@link resolveSnapshotUri} instead.
 */
export function snapshotUri(folderUri: vscode.Uri): vscode.Uri {
  return snapshotUriAt(folderUri, PREFERRED_SNAPSHOT_FILENAME);
}

function snapshotUriAt(folderUri: vscode.Uri, filename: SnapshotFilename): vscode.Uri {
  const base = folderUri.path.endsWith('/') ? folderUri.path.slice(0, -1) : folderUri.path;
  return folderUri.with({ path: `${base}/${filename}` });
}

/**
 * Resolve which snapshot file to use at `folderUri`. Checks the preferred
 * filename first (`.eventSync`); falls back to the legacy `.admin-sync.jsonc`
 * if only that one exists; returns the preferred URI with `existed: false`
 * when neither does (ready for a fresh write).
 *
 * The preferred-first probe means a workspace that's already migrated takes
 * one stat. The legacy-fallback probe adds a second stat only on workspaces
 * still carrying the original filename.
 */
export async function resolveSnapshotUri(
  folderUri: vscode.Uri,
): Promise<{ uri: vscode.Uri; filename: SnapshotFilename; existed: boolean }> {
  const preferred = snapshotUriAt(folderUri, PREFERRED_SNAPSHOT_FILENAME);
  try {
    await vscode.workspace.fs.stat(preferred);
    return { uri: preferred, filename: PREFERRED_SNAPSHOT_FILENAME, existed: true };
  } catch { /* fall through to legacy probe */ }
  for (const filename of SNAPSHOT_FILENAMES) {
    if (filename === PREFERRED_SNAPSHOT_FILENAME) continue;
    const candidate = snapshotUriAt(folderUri, filename);
    try {
      await vscode.workspace.fs.stat(candidate);
      return { uri: candidate, filename, existed: true };
    } catch { /* try next */ }
  }
  return { uri: preferred, filename: PREFERRED_SNAPSHOT_FILENAME, existed: false };
}

/**
 * Build a Snapshot from the current vscode.workspace state. Returns
 * undefined if there are no workspace folders (nothing to capture, no
 * target folder for the file).
 *
 * Settings capture is currently restricted to KNOWN_WORKSPACE_KEYS. See
 * the comment on that constant in ./snapshot.ts for why.
 *
 * `existingPlaceholders` is copied verbatim into the returned snapshot.
 * Placeholders are not derived from vscode state — they live only on disk
 * and need to round-trip through recapture (topology writer, Refresh
 * button) without being wiped. The callers in restoreFlow.ts read the
 * current array off disk via `readPlaceholdersFromDisk` and pass it here.
 */
export function captureCurrent(existingPlaceholders: string[] = []): Snapshot | undefined {
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
    placeholders: [...existingPlaceholders],
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Read the `placeholders` array off the on-disk snapshot file (whichever
 * of the honoured filenames exists). Returns an empty array if neither
 * file exists or parsing fails. Used by the recapture callers so that
 * rebuilding a snapshot from vscode state doesn't silently drop the user's
 * placeholder entries (vscode doesn't model them at all — they live only
 * on disk).
 */
export async function readPlaceholdersFromDisk(folderUri: vscode.Uri): Promise<string[]> {
  const { uri: target, existed } = await resolveSnapshotUri(folderUri);
  if (!existed) return [];
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(target);
  } catch {
    return [];
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return [];
  }
  const { snapshot } = parseSnapshot(text);
  return [...snapshot.placeholders];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
