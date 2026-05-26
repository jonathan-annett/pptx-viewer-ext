// Wired side of destination-only mode detection.
//
// Owns the runtime context-key writer for `folderSync.destinationOnlyWorkspace`.
// Mirrors the structure of `activatePlaceholderRegistry`: factored out of
// extension.ts so the side-effect surface (watcher, listeners, scan) sits
// in one cohesive module. extension.ts calls `activateDestinationOnlyContextKey`
// once during activation and pushes the returned disposable onto the
// subscription list.
//
// State drivers:
//   1. FileSystemWatcher on `**/.foldersync-manifest.json` — create/delete
//      events update the presence map for the matching root-manifest URI.
//      Non-root matches (deeper paths) are ignored — only manifests at the
//      root of a workspace folder count as the operator-mode signal.
//   2. `vscode.workspace.onDidChangeWorkspaceFolders` — re-scan + recompute
//      so a freshly-added folder gets its presence stat resolved.
//   3. `manager.onDidChange` — recompute on topology shifts (a `.sync.jsonc`
//      created or deleted flips the source count).
//
// The pure decision lives in `./destinationOnly.ts`. This module is the
// thin vscode adapter around it.

import * as vscode from 'vscode';
import { log } from '../log';
import { isDestinationOnlyTopology } from './destinationOnly';
import type { SyncManager } from './manager';
import { readManifest } from './manifest';
import type { ManifestSummary } from './statusBarOperator';

const MANIFEST_FILENAME = '.foldersync-manifest.json';
const MANIFEST_GLOB = '**/.foldersync-manifest.json';
const CONTEXT_KEY = 'folderSync.destinationOnlyWorkspace';

interface State {
  manifestPresence: Map<string, boolean>;
  manager: SyncManager;
  /** Last value passed to subscribers — used to seed late subscribers. */
  lastState: DestinationOnlyState;
}

let current: State | undefined;

/**
 * State broadcast to subscribers (currently just the status bar). Contains
 * both the boolean (mirrors the context key) and the canonical manifest
 * summary so consumers don't have to re-read the manifest themselves.
 *
 * `canonicalManifest` is the manifest at the root of `workspaceFolders[0]`
 * — undefined when destination-only is false, or when destination-only is
 * true but the canonical folder doesn't carry a manifest (the destination
 * lives at a non-canonical folder, or no sync has written one yet).
 */
export interface DestinationOnlyState {
  isDestinationOnly: boolean;
  canonicalManifest?: ManifestSummary;
}

const stateEmitter = new vscode.EventEmitter<DestinationOnlyState>();

/**
 * Fires every time the destination-only state recomputes (manifest
 * created/deleted, workspace folders changed, sync topology changed, or
 * the canonical manifest's contents changed). Subscribers receive a
 * fresh state object each time.
 *
 * Late subscribers can call `getDestinationOnlyState()` to read the
 * current state synchronously without waiting for the next event.
 */
export const onDidChangeDestinationOnlyState = stateEmitter.event;

export function getDestinationOnlyState(): DestinationOnlyState {
  return current?.lastState ?? { isDestinationOnly: false };
}

function manifestUriForFolder(folderUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(folderUri, MANIFEST_FILENAME);
}

/**
 * Synchronous(-ish, async) FS-driven detect for "are we currently in
 * destination-only mode?". Uses `vscode.workspace.findFiles` for source
 * presence and `fs.stat` for manifest presence — doesn't require the
 * `SyncManager` or the wired layer's presence map, so it's safe to call
 * before either of those exists.
 *
 * Used as a fire-time gate by source-side machinery that needs to skip
 * work in operator mode but runs before the wired layer's initial scan
 * completes (the snapshot writer's first fire) or before activation has
 * even built the manager (the workspace-lock-settings seeder).
 *
 * Same semantics as `isDestinationOnlyTopology`:
 *   - zero workspace folders → false (no signal)
 *   - any `.sync.jsonc` anywhere → false (workspace has sources)
 *   - otherwise → true iff at least one workspace folder has a
 *     `.foldersync-manifest.json` at its root.
 */
export async function detectDestinationOnlyFromFs(): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return false;
  // `maxResults: 1` short-circuits the glob as soon as one .sync.jsonc is
  // found anywhere in the workspace — we only need the boolean.
  const sources = await vscode.workspace.findFiles('**/.sync.jsonc', undefined, 1);
  if (sources.length > 0) return false;
  for (const folder of folders) {
    try {
      await vscode.workspace.fs.stat(manifestUriForFolder(folder.uri));
      return true;
    } catch {
      // No manifest at this folder's root — keep looking.
    }
  }
  return false;
}

async function statManifest(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function scanAll(): Promise<void> {
  if (!current) return;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const next = new Map<string, boolean>();
  for (const folder of folders) {
    const has = await statManifest(manifestUriForFolder(folder.uri));
    next.set(folder.uri.toString(), has);
  }
  current.manifestPresence = next;
}

async function recompute(): Promise<void> {
  if (!current) return;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const result = isDestinationOnlyTopology(
    current.manager.getTopology(),
    folders,
    current.manifestPresence,
  );
  void vscode.commands.executeCommand('setContext', CONTEXT_KEY, result);

  // Read the canonical manifest when operator mode is active AND the
  // canonical folder (workspaceFolders[0]) carries a root manifest. Skipping
  // the read in the other branches keeps the wired layer side-effect-free
  // when nothing about the operator surface needs it.
  let canonicalManifest: ManifestSummary | undefined;
  if (result && folders.length > 0) {
    const canonicalFolder = folders[0];
    const present = current.manifestPresence.get(canonicalFolder.uri.toString()) === true;
    if (present) {
      canonicalManifest = await readCanonicalManifestSummary(canonicalFolder.uri);
    }
  }

  const state: DestinationOnlyState = { isDestinationOnly: result, canonicalManifest };
  current.lastState = state;
  stateEmitter.fire(state);

  log(
    `destination-only: setContext ${CONTEXT_KEY}=${result} ` +
      `(sources=${current.manager.getTopology().sources.length}, ` +
      `folders=${folders.length}, ` +
      `manifestsPresent=${countTrue(current.manifestPresence)}, ` +
      `canonicalManifest=${canonicalManifest ? `lastSync=${canonicalManifest.lastSync ?? 'null'}` : 'none'})`,
  );
}

async function readCanonicalManifestSummary(
  folderUri: vscode.Uri,
): Promise<ManifestSummary | undefined> {
  // readManifest already folds missing/corrupt/bad-utf8 into ok+empty, and
  // surfaces only version-mismatch as the non-ok branch. For M2 we treat
  // version-mismatch as "no usable summary" — the status bar drops back to
  // the no-manifest-yet copy. M5 specifies an operator-appropriate copy
  // for version-mismatch and will branch on that case explicitly.
  const result = await readManifest(folderUri);
  if (result.kind !== 'ok') return undefined;
  return {
    manifestUri: manifestUriForFolder(folderUri),
    folderUri,
    lastSync: result.manifest.lastSync,
  };
}

function countTrue(map: ReadonlyMap<string, boolean>): number {
  let n = 0;
  for (const v of map.values()) if (v) n += 1;
  return n;
}

function handleManifestEvent(uri: vscode.Uri, kind: 'create' | 'delete'): void {
  if (!current) return;
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    if (manifestUriForFolder(folder.uri).toString() === uri.toString()) {
      current.manifestPresence.set(folder.uri.toString(), kind === 'create');
      void recompute();
      return;
    }
  }
}

/**
 * Manifest content changed (edit, not create/delete). Presence doesn't
 * flip, but the canonical manifest's `lastSync` may have just rolled
 * forward, so the status bar's relative-time copy needs to update.
 * Filtered to the canonical folder's root manifest — edits to manifests
 * elsewhere don't drive the status bar.
 */
function handleManifestChange(uri: vscode.Uri): void {
  if (!current) return;
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return;
  const canonicalUri = manifestUriForFolder(folders[0].uri).toString();
  if (uri.toString() === canonicalUri) {
    void recompute();
  }
}

/**
 * Wire the context-key writer to the live workspace. Returns a disposable
 * that tears down the watcher + subscriptions. extension.ts pushes it onto
 * `context.subscriptions`.
 *
 * The manager.onDidChange subscription fires once immediately with the
 * current topology — this drives the very first setContext call (before
 * any scan runs, the presence map is empty so the key starts as false,
 * which is the safe default).
 */
export function activateDestinationOnlyContextKey(
  context: vscode.ExtensionContext,
  manager: SyncManager,
): vscode.Disposable {
  current = {
    manifestPresence: new Map(),
    manager,
    lastState: { isDestinationOnly: false },
  };

  const watcher = vscode.workspace.createFileSystemWatcher(MANIFEST_GLOB);
  watcher.onDidCreate((u) => handleManifestEvent(u, 'create'));
  watcher.onDidDelete((u) => handleManifestEvent(u, 'delete'));
  // onDidChange drives the operator status bar's relative-time refresh —
  // an edit to the canonical manifest may have just rolled lastSync forward.
  // Presence stays unchanged; recompute re-reads + re-fires the state event.
  watcher.onDidChange((u) => handleManifestChange(u));

  const foldersSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void scanAll().then(() => recompute());
  });

  const managerSub = manager.onDidChange(() => {
    void recompute();
  });

  // Initial scan + recompute. The managerSub above already fired one
  // recompute with the empty presence map; this second pass picks up
  // whatever manifests are sitting at workspace folder roots.
  void scanAll().then(() => recompute());

  const disposable: vscode.Disposable = {
    dispose(): void {
      watcher.dispose();
      foldersSub.dispose();
      managerSub.dispose();
      current = undefined;
    },
  };
  context.subscriptions.push(disposable);
  return disposable;
}

/**
 * Diagnostic snapshot used by the M1 probe command. Returns undefined when
 * the wired layer is not active (shouldn't happen in normal activation,
 * but defensive against the probe firing before activation completes).
 */
export interface DestinationOnlyProbeState {
  workspaceFolders: { uri: string; name: string }[];
  manifestPresence: { folderUri: string; hasManifest: boolean }[];
  sourceCount: number;
  isDestinationOnly: boolean;
}

export function snapshotDestinationOnlyState(): DestinationOnlyProbeState | undefined {
  if (!current) return undefined;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const topology = current.manager.getTopology();
  return {
    workspaceFolders: folders.map((f) => ({ uri: f.uri.toString(), name: f.name })),
    manifestPresence: Array.from(current.manifestPresence.entries()).map(
      ([folderUri, hasManifest]) => ({ folderUri, hasManifest }),
    ),
    sourceCount: topology.sources.length,
    isDestinationOnly: isDestinationOnlyTopology(topology, folders, current.manifestPresence),
  };
}

/**
 * `folderSync.probeDestinationOnly` — temporary diagnostic command for M1.
 * Dumps the current detection state to the Output Channel. Removed at M6
 * sign-off (same lifecycle as the M4.6 cold-read probe and the M5.2.5
 * cache probes).
 */
export function registerDestinationOnlyProbe(): vscode.Disposable {
  return vscode.commands.registerCommand('folderSync.probeDestinationOnly', () => {
    log('--- probe: destination-only state ---');
    const snap = snapshotDestinationOnlyState();
    if (!snap) {
      log('probe: wired layer not active (activation not complete?)');
      log('--- probe: end ---');
      void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
      return;
    }
    log(`probe: sources=${snap.sourceCount}`);
    log(`probe: workspaceFolders=${snap.workspaceFolders.length}`);
    for (const f of snap.workspaceFolders) {
      log(`  - ${f.name}  ${f.uri}`);
    }
    log(`probe: manifestPresence entries=${snap.manifestPresence.length}`);
    for (const entry of snap.manifestPresence) {
      log(`  - ${entry.hasManifest ? '✓' : '✗'} ${entry.folderUri}`);
    }
    log(`probe: isDestinationOnly=${snap.isDestinationOnly}`);
    log(`probe: context key folderSync.destinationOnlyWorkspace should = ${snap.isDestinationOnly}`);
    log('--- probe: end ---');
    void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
  });
}
