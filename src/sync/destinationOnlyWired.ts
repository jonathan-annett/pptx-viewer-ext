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

const MANIFEST_FILENAME = '.foldersync-manifest.json';
const MANIFEST_GLOB = '**/.foldersync-manifest.json';
const CONTEXT_KEY = 'folderSync.destinationOnlyWorkspace';

interface State {
  manifestPresence: Map<string, boolean>;
  manager: SyncManager;
}

let current: State | undefined;

function manifestUriForFolder(folderUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(folderUri, MANIFEST_FILENAME);
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

function recompute(): void {
  if (!current) return;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const result = isDestinationOnlyTopology(
    current.manager.getTopology(),
    folders,
    current.manifestPresence,
  );
  void vscode.commands.executeCommand('setContext', CONTEXT_KEY, result);
  log(
    `destination-only: setContext ${CONTEXT_KEY}=${result} ` +
      `(sources=${current.manager.getTopology().sources.length}, ` +
      `folders=${folders.length}, ` +
      `manifestsPresent=${countTrue(current.manifestPresence)})`,
  );
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
      recompute();
      return;
    }
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
  current = { manifestPresence: new Map(), manager };

  const watcher = vscode.workspace.createFileSystemWatcher(MANIFEST_GLOB);
  watcher.onDidCreate((u) => handleManifestEvent(u, 'create'));
  watcher.onDidDelete((u) => handleManifestEvent(u, 'delete'));
  // onDidChange not subscribed — presence is binary (file exists?), and
  // edits to a manifest don't change that.

  const foldersSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void scanAll().then(recompute);
  });

  const managerSub = manager.onDidChange(() => {
    recompute();
  });

  // Initial scan + recompute. The managerSub above already fired one
  // recompute with the empty presence map; this second pass picks up
  // whatever manifests are sitting at workspace folder roots.
  void scanAll().then(recompute);

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
