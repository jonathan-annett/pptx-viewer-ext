// SyncManager — owns the lifecycle of the resolved topology.
//
// Responsibilities:
// - Discover all .sync.jsonc files across the workspace at activation
// - Watch for create/change/delete of .sync.jsonc files
// - Watch for workspace-folder changes (add/remove)
// - Recompute the topology when either kind of change fires
// - Expose the current topology to commands and UI surfaces
//
// Recomputation is async and serialized — overlapping requests coalesce so
// fast bursts of edits don't queue redundant work.

import * as vscode from 'vscode';
import { loadSyncConfig, type SourceLoad } from './config';
import {
  resolveTopology,
  formatTopology,
  type ResolvedTopology,
  type SyncConfigConflict,
} from './topology';
import {
  SYNC_CONFIG_GLOB,
  configFilenameFromUri,
  isNamedRoomSyncFilename,
  isWorkspaceRootNamedConfig,
  partitionConfigUris,
} from './configFilenames';
import { log } from '../log';

type Listener = (topology: ResolvedTopology) => void;

const CONFIG_GLOB = SYNC_CONFIG_GLOB;

// Per-folder config-discovery budget. A reachable folder's filename-glob search
// returns in well under a second; an unavailable web-FSA folder otherwise hangs
// until VS Code's much longer internal timeout. Cap it so the topology builds
// from the reachable folders promptly. Generous enough not to cancel a slow-but-
// reachable folder mid-search.
const CONFIG_DISCOVERY_TIMEOUT_MS = 5000;

/**
 * Discover config files across every workspace folder, tolerating an
 * unavailable one. Searches each folder independently and in parallel, each
 * bounded by {@link CONFIG_DISCOVERY_TIMEOUT_MS}; a folder that times out (or
 * errors) contributes nothing instead of stalling the whole discovery.
 */
async function discoverConfigUris(
  folders: readonly vscode.WorkspaceFolder[],
): Promise<vscode.Uri[]> {
  const perFolder = await Promise.all(
    folders.map((folder) =>
      findFilesWithTimeout(
        new vscode.RelativePattern(folder, CONFIG_GLOB),
        CONFIG_DISCOVERY_TIMEOUT_MS,
        `config discovery in "${folder.name}"`,
      ),
    ),
  );
  return perFolder.flat();
}

/**
 * findFiles bounded by a timeout. On expiry the underlying search is cancelled
 * (best effort) and we resolve to `[]` — and we race the timeout directly so a
 * search that ignores cancellation still can't hang the caller.
 */
async function findFilesWithTimeout(
  pattern: vscode.RelativePattern,
  ms: number,
  label: string,
): Promise<vscode.Uri[]> {
  const cts = new vscode.CancellationTokenSource();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<vscode.Uri[]>((resolve) => {
    timer = setTimeout(() => {
      cts.cancel();
      log(`sync: ${label} timed out after ${ms}ms — proceeding without it`);
      resolve([]);
    }, ms);
  });
  const search = Promise.resolve(
    vscode.workspace.findFiles(pattern, undefined, undefined, cts.token),
  )
    .then((uris) => uris)
    .catch((err) => {
      log(`sync: ${label} failed — ${err instanceof Error ? err.message : String(err)}`);
      return [] as vscode.Uri[];
    });
  try {
    return await Promise.race([search, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    cts.dispose();
  }
}

export class SyncManager implements vscode.Disposable {
  private topology: ResolvedTopology = {
    sources: [],
    failed: [],
    diagnostics: [],
    conflicts: [],
  };
  private listeners = new Set<Listener>();
  private watcher: vscode.FileSystemWatcher | undefined;
  private folderListener: vscode.Disposable | undefined;
  private reloading = false;
  private reloadPending = false;

  /** Create, start watching, and run the first load. */
  static async create(context: vscode.ExtensionContext): Promise<SyncManager> {
    const mgr = new SyncManager();
    mgr.start(context);
    await mgr.reload();
    return mgr;
  }

  private start(context: vscode.ExtensionContext): void {
    this.watcher = vscode.workspace.createFileSystemWatcher(CONFIG_GLOB);
    const trigger = (uri: vscode.Uri, kind: string): void => {
      log(`sync: ${kind} ${uri.toString()} — scheduling topology reload`);
      void this.reload();
    };
    this.watcher.onDidCreate((u) => trigger(u, 'config created'));
    this.watcher.onDidChange((u) => trigger(u, 'config changed'));
    this.watcher.onDidDelete((u) => trigger(u, 'config deleted'));

    this.folderListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      log('sync: workspace folders changed — scheduling topology reload');
      void this.reload();
    });

    context.subscriptions.push(this);
  }

  /** Coalescing reload. If a reload is already in flight, mark pending and exit. */
  async reload(): Promise<void> {
    if (this.reloading) {
      this.reloadPending = true;
      return;
    }
    this.reloading = true;
    try {
      do {
        this.reloadPending = false;
        await this.doReload();
      } while (this.reloadPending);
    } finally {
      this.reloading = false;
    }
  }

  private async doReload(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.topology = { sources: [], failed: [], diagnostics: [], conflicts: [] };
      log('sync: no workspace folders — topology is empty');
      this.emit();
      return;
    }

    // Find every recognised source-config file. We search each workspace
    // folder INDEPENDENTLY (not one findFiles across all folders) so an
    // unavailable folder — a web FSA handle whose permission was revoked or
    // whose drive is disconnected — can't stall discovery: a single combined
    // findFiles blocks on the dead folder until VS Code's long internal
    // timeout, leaving the whole topology (and every command/context-key that
    // gates on it) dead until then. Per-folder + a short cancel-on-timeout
    // lets the dead folder fall out in seconds while the reachable folders'
    // configs still land. The glob honours `.sync.jsonc`, `.roomSync`, and
    // named `<dest>.roomSync` (M3). Named variants are workspace-root only;
    // the post-discovery filter below drops nested ones with a log line so a
    // stray file deep in the tree doesn't silently become a ghost source.
    const allConfigUris = await discoverConfigUris(folders);
    const configUris: vscode.Uri[] = [];
    for (const u of allConfigUris) {
      const filename = configFilenameFromUri(u);
      if (isNamedRoomSyncFilename(filename)) {
        const owner = workspaceFolderOf(u, folders);
        if (!owner || !isWorkspaceRootNamedConfig(u.path, owner.uri.path)) {
          log(
            `sync: ignoring named .roomSync outside a workspace folder root: ` +
              u.toString() +
              ` (M3 logical-destination handles only apply at the workspace root)`,
          );
          continue;
        }
      }
      configUris.push(u);
    }
    const { keep, conflicts: rawConflicts } = partitionConfigUris(configUris);
    // Marshal the pure-helper output into vscode.Uri-shaped conflict
    // records that the rest of the extension consumes.
    const conflicts: SyncConfigConflict[] = rawConflicts.map((c) => ({
      sourceFolderUri: c.roomSync.with({ path: c.parentPath }),
      legacyUri: c.legacy,
      roomSyncUri: c.roomSync,
    }));
    // Load the kept configs in parallel (order preserved). Each load only
    // reads its own config file — which lives in a reachable folder, since
    // discovery above already dropped any dead-folder results — so this can't
    // re-introduce the stall. loadSyncConfig never throws (it returns an
    // error-bearing SourceLoad), so one bad config doesn't sink the rest.
    const loads: SourceLoad[] = (
      await Promise.all(
        keep.map(async (configUri) => {
          const owner = workspaceFolderOf(configUri, folders);
          if (!owner) {
            // Shouldn't happen — discovery searches within workspace folders.
            // Guard anyway so an oddly-scoped result doesn't crash the load.
            log(`sync: ignoring config outside any workspace folder: ${configUri.toString()}`);
            return null;
          }
          return await loadSyncConfig(configUri, owner.uri);
        }),
      )
    ).filter((load): load is SourceLoad => load !== null);

    this.topology = resolveTopology(loads, folders);
    this.topology.conflicts = conflicts;
    log(
      `sync: topology resolved — ${this.topology.sources.length} source(s), ` +
        `${this.topology.failed.length} failed, ` +
        `${this.topology.diagnostics.length} diagnostic(s), ` +
        `${conflicts.length} config conflict(s)`,
    );
    for (const d of this.topology.diagnostics) {
      log(`sync: [${d.severity}] ${d.message}`);
    }
    for (const c of conflicts) {
      log(
        `sync: [conflict] ${displayFolder(c.sourceFolderUri)} contains both ` +
          `.sync.jsonc and .roomSync — using .roomSync; ` +
          `run "Folder Sync: Resolve Config Conflict" to fix`,
      );
    }
    this.emit();
  }

  getTopology(): ResolvedTopology {
    return this.topology;
  }

  dumpTopology(): string {
    return formatTopology(this.topology);
  }

  /** Subscribe to topology changes. Returns a disposable. */
  onDidChange(listener: Listener): vscode.Disposable {
    this.listeners.add(listener);
    // Fire once immediately so subscribers can render initial state.
    listener(this.topology);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.topology);
      } catch (err) {
        log(`sync: listener threw — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  dispose(): void {
    this.watcher?.dispose();
    this.folderListener?.dispose();
    this.listeners.clear();
  }
}

function displayFolder(uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri, false);
  return rel || uri.toString();
}

function workspaceFolderOf(
  uri: vscode.Uri,
  folders: readonly vscode.WorkspaceFolder[],
): vscode.WorkspaceFolder | undefined {
  // A config belongs to the workspace folder whose URI is a prefix of its URI.
  // Compare on `toString()` of the folder URI with a trailing slash to avoid
  // false matches between e.g. /work/foo and /work/foobar.
  const target = uri.toString();
  let best: vscode.WorkspaceFolder | undefined;
  let bestLen = -1;
  for (const folder of folders) {
    const prefix = folder.uri.toString().replace(/\/+$/, '') + '/';
    if (target.startsWith(prefix) && prefix.length > bestLen) {
      best = folder;
      bestLen = prefix.length;
    }
  }
  return best;
}
