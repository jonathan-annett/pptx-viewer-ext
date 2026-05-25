// Placeholder registry — workspace-wide cache of "is this sha a placeholder?".
//
// The planner, scoped plan builders, viewer, and search panel all need to
// answer that question without each re-parsing `.admin-sync.jsonc` on every
// call. This module owns the cached Set<string> and invalidates on file or
// workspace changes.
//
// Single-module wired layer with a sibling pure helper. Activated once by
// extension.ts; consumers reach in via `getActivePlaceholderSet()` (async,
// always correct) or `getActivePlaceholderSetSync()` (render-time paths).

import * as vscode from 'vscode';
import { log } from '../log';
import {
  EMPTY_FILE_SHA256,
  computeEffectiveSetFromText,
} from './snapshot';

const SNAPSHOT_FILENAME = '.admin-sync.jsonc';

let cached: Set<string> | undefined;
/** Active load promise — shared so concurrent callers don't trigger duplicate reads. */
let inFlight: Promise<Set<string>> | undefined;
let watchedFolderUri: vscode.Uri | undefined;
let watcher: vscode.FileSystemWatcher | undefined;
const changeEmitter = new vscode.EventEmitter<Set<string>>();

/**
 * The current active set, kicking off a read if the cache is cold. Safe to
 * call from any context — the read is async but the function never throws
 * (errors degrade to the empty-default set).
 */
export async function getActivePlaceholderSet(): Promise<Set<string>> {
  if (cached) return cached;
  if (inFlight) return inFlight;
  inFlight = loadFromDisk().then((set) => {
    cached = set;
    inFlight = undefined;
    return set;
  });
  return inFlight;
}

/**
 * Sync read for paths that can't await — renderers that must return HTML
 * inline. Returns the current cache if available, or just the empty-default
 * set when cold. Callers that need correctness should prefer the async
 * variant; this one is fine when "missing one custom hash for one render"
 * is acceptable (the next render after the load lands picks it up).
 */
export function getActivePlaceholderSetSync(): Set<string> {
  if (cached) return cached;
  return new Set<string>([EMPTY_FILE_SHA256]);
}

/** Fires whenever the cache transitions to a new set. */
export const onDidChangePlaceholderSet: vscode.Event<Set<string>> = changeEmitter.event;

/** Test-only: reset the module state so a fresh test can start clean. */
export function _resetForTesting(): void {
  cached = undefined;
  inFlight = undefined;
  watchedFolderUri = undefined;
  watcher?.dispose();
  watcher = undefined;
}

/**
 * Wire the registry up to the workspace. Sets up a FileSystemWatcher on the
 * `.admin-sync.jsonc` at `workspaceFolders[0]`, re-creates it when the
 * workspace topology changes, and seeds the cache by reading the file once.
 *
 * Returns a Disposable that tears down the watcher + workspace-folder
 * subscription. Push it onto `context.subscriptions` from `extension.ts`.
 */
export function activatePlaceholderRegistry(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  void context; // currently unused; reserved for future per-workspace state.

  refreshWatcher();
  // Seed once on activation so the first synchronous consumer (typically a
  // viewer render in a restored tab) has a usable cache.
  void getActivePlaceholderSet();

  const foldersSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    refreshWatcher();
    invalidate();
  });

  return {
    dispose(): void {
      watcher?.dispose();
      watcher = undefined;
      foldersSub.dispose();
      changeEmitter.dispose();
    },
  };
}

/** Drop the cache and kick off a fresh load. Notifies subscribers when it lands. */
function invalidate(): void {
  cached = undefined;
  inFlight = undefined;
  void getActivePlaceholderSet().then((set) => {
    changeEmitter.fire(set);
  });
}

/**
 * Recreate the FileSystemWatcher targeting the current workspaceFolders[0].
 * No-op when the target hasn't changed (avoids tearing down a working
 * watcher just because some other folder was added at index > 0).
 */
function refreshWatcher(): void {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const target = folders[0]?.uri;
  if (target?.toString() === watchedFolderUri?.toString()) return;
  watcher?.dispose();
  watcher = undefined;
  watchedFolderUri = target;
  if (!target) return;
  const pattern = new vscode.RelativePattern(target, SNAPSHOT_FILENAME);
  watcher = vscode.workspace.createFileSystemWatcher(pattern);
  watcher.onDidCreate(() => invalidate());
  watcher.onDidChange(() => invalidate());
  watcher.onDidDelete(() => invalidate());
}

async function loadFromDisk(): Promise<Set<string>> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    // Folderless tab — only the empty-file default is in scope. The viewer
    // can still open .pptx files in this state; they just won't match any
    // user-added placeholder hash.
    return new Set<string>([EMPTY_FILE_SHA256]);
  }
  const target = snapshotPath(folders[0].uri);
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(target);
  } catch {
    // No .admin-sync.jsonc yet (fresh workspace, or pre-M4.6 layout).
    return new Set<string>([EMPTY_FILE_SHA256]);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    log(`placeholder-registry: ${target.toString()} is not utf-8 (${errMsg(err)})`);
    return new Set<string>([EMPTY_FILE_SHA256]);
  }
  return computeEffectiveSetFromText(text);
}

function snapshotPath(folderUri: vscode.Uri): vscode.Uri {
  const base = folderUri.path.endsWith('/') ? folderUri.path.slice(0, -1) : folderUri.path;
  return folderUri.with({ path: `${base}/${SNAPSHOT_FILENAME}` });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
