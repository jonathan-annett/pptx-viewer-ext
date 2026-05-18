// SyncManager — owns the lifecycle of the resolved topology.
//
// Responsibilities:
// - Discover all .sync.yaml files across the workspace at activation
// - Watch for create/change/delete of .sync.yaml files
// - Watch for workspace-folder changes (add/remove)
// - Recompute the topology when either kind of change fires
// - Expose the current topology to commands and UI surfaces
//
// Recomputation is async and serialized — overlapping requests coalesce so
// fast bursts of edits don't queue redundant work.

import * as vscode from 'vscode';
import { loadSyncYaml, type SourceLoad } from './config';
import {
  resolveTopology,
  formatTopology,
  type ResolvedTopology,
} from './topology';
import { log } from '../log';

type Listener = (topology: ResolvedTopology) => void;

export class SyncManager implements vscode.Disposable {
  private topology: ResolvedTopology = {
    sources: [],
    failed: [],
    diagnostics: [],
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
    this.watcher = vscode.workspace.createFileSystemWatcher('**/.sync.yaml');
    const trigger = (uri: vscode.Uri, kind: string): void => {
      log(`sync: ${kind} ${uri.toString()} — scheduling topology reload`);
      void this.reload();
    };
    this.watcher.onDidCreate((u) => trigger(u, 'yaml created'));
    this.watcher.onDidChange((u) => trigger(u, 'yaml changed'));
    this.watcher.onDidDelete((u) => trigger(u, 'yaml deleted'));

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
      this.topology = { sources: [], failed: [], diagnostics: [] };
      log('sync: no workspace folders — topology is empty');
      this.emit();
      return;
    }

    // Find all .sync.yaml files. findFiles respects the user's files.exclude
    // settings but ignores .gitignore by default — fine for our purposes.
    const yamlUris = await vscode.workspace.findFiles('**/.sync.yaml');
    const loads: SourceLoad[] = [];
    for (const yamlUri of yamlUris) {
      const owner = workspaceFolderOf(yamlUri, folders);
      if (!owner) {
        // Shouldn't happen — findFiles searches within workspace folders.
        // Guard anyway so an oddly-scoped result doesn't crash the load.
        log(`sync: ignoring yaml outside any workspace folder: ${yamlUri.toString()}`);
        continue;
      }
      loads.push(await loadSyncYaml(yamlUri, owner.uri));
    }

    this.topology = resolveTopology(loads, folders);
    log(
      `sync: topology resolved — ${this.topology.sources.length} source(s), ` +
        `${this.topology.failed.length} failed, ${this.topology.diagnostics.length} diagnostic(s)`,
    );
    for (const d of this.topology.diagnostics) {
      log(`sync: [${d.severity}] ${d.message}`);
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

function workspaceFolderOf(
  uri: vscode.Uri,
  folders: readonly vscode.WorkspaceFolder[],
): vscode.WorkspaceFolder | undefined {
  // A yaml belongs to the workspace folder whose URI is a prefix of its URI.
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
