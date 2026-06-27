// Explorer decoration for workspace-folder availability.
//
// Each connected workspace folder (the "remote PCs" that sync destinations
// live on) gets a badge in the Explorer reflecting whether it's currently
// reachable:
//   - available   ✓  the folder answered a top-level read within the budget
//   - unavailable  ⚠  the read hung/failed (offline, disconnected, no permission)
//   - unknown      ?  not probed yet (briefly, at startup / for a new folder)
//
// Why this exists: on web (File System Access) a folder handle can go dead with
// no event, and the sync/plan paths then have to time out around it. Surfacing
// the state up front lets an operator SEE which destination is down rather than
// inferring it from a stalled sync.
//
// Probe = `readDirectory` (a top-level listing), the same honest reachability
// test the planner/executor use — a dead handle can still answer `stat` from
// VS Code's cached folder entry while the real read path hangs. Probes are
// bounded by a timeout, run in parallel, and re-run on a slow poll so a folder
// going offline OR coming back is reflected without a manual refresh. The
// `folderSync.refreshFolderAvailability` command forces an immediate re-probe.

import * as vscode from 'vscode';
import { withTimeout } from './timeout';
import { log } from '../log';

type FolderState = 'available' | 'unavailable' | 'unknown';

// A live folder lists its top level in well under this. An unavailable web-FSA
// handle hangs and is treated as unavailable once it elapses.
const PROBE_TIMEOUT_MS = 4000;
// Re-probe cadence — catches a folder going offline or recovering without an
// explicit refresh. Cheap: one bounded top-level listing per folder.
const POLL_INTERVAL_MS = 30_000;

const DECORATIONS: Record<FolderState, vscode.FileDecoration> = {
  available: {
    badge: '✓',
    tooltip: 'Folder available',
    color: new vscode.ThemeColor('charts.green'),
  },
  unavailable: {
    badge: '⚠',
    tooltip: 'Folder unavailable — offline, disconnected, or permission not granted',
    color: new vscode.ThemeColor('list.errorForeground'),
  },
  unknown: {
    badge: '?',
    tooltip: 'Checking folder availability…',
    color: new vscode.ThemeColor('descriptionForeground'),
  },
};

/**
 * Register the workspace-folder availability decoration provider + its poller.
 * Returns a Disposable that tears everything down; push it onto
 * `context.subscriptions`. Activation never blocks on a probe.
 */
export function registerFolderStateDecorations(): vscode.Disposable {
  const changeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  // folder-root uri string → current state.
  const states = new Map<string, FolderState>();
  let disposed = false;
  let probing = false;

  const provider: vscode.FileDecorationProvider = {
    onDidChangeFileDecorations: changeEmitter.event,
    provideFileDecoration(uri) {
      const state = states.get(uri.toString());
      return state ? DECORATIONS[state] : undefined;
    },
  };
  const registration = vscode.window.registerFileDecorationProvider(provider);

  async function probe(folderUri: vscode.Uri): Promise<FolderState> {
    try {
      await withTimeout(
        Promise.resolve(vscode.workspace.fs.readDirectory(folderUri)),
        PROBE_TIMEOUT_MS,
        `readdir ${folderUri.toString()}`,
      );
      return 'available';
    } catch {
      return 'unavailable';
    }
  }

  function setState(uri: vscode.Uri, state: FolderState): void {
    if (states.get(uri.toString()) === state) return;
    states.set(uri.toString(), state);
    changeEmitter.fire(uri);
  }

  /** Probe every workspace folder. Keeps the last-known state visible during a
   *  re-probe (no flicker); brand-new folders show 'unknown' until resolved. */
  async function probeAll(): Promise<void> {
    if (disposed || probing) return;
    probing = true;
    try {
      const folders = vscode.workspace.workspaceFolders ?? [];
      // Drop folders no longer in the workspace.
      const present = new Set(folders.map((f) => f.uri.toString()));
      for (const key of [...states.keys()]) {
        if (!present.has(key)) {
          states.delete(key);
          changeEmitter.fire(vscode.Uri.parse(key));
        }
      }
      // Seed 'unknown' for folders we've never probed so they badge immediately.
      for (const f of folders) {
        if (!states.has(f.uri.toString())) setState(f.uri, 'unknown');
      }
      // Probe in parallel; update each as it resolves (one slow/dead folder
      // doesn't hold up the others' state updates beyond the shared timeout).
      await Promise.all(
        folders.map(async (f) => {
          const state = await probe(f.uri);
          if (!disposed) setState(f.uri, state);
        }),
      );
      const down = [...states.values()].filter((s) => s === 'unavailable').length;
      log(`folder-state: probed ${folders.length} folder(s) — ${down} unavailable`);
    } finally {
      probing = false;
    }
  }

  const foldersSub = vscode.workspace.onDidChangeWorkspaceFolders(() => void probeAll());
  const timer = setInterval(() => void probeAll(), POLL_INTERVAL_MS);
  const cmd = vscode.commands.registerCommand(
    'folderSync.refreshFolderAvailability',
    () => void probeAll(),
  );

  // Initial probe in the background; activation doesn't block on it.
  void probeAll();

  return new vscode.Disposable(() => {
    disposed = true;
    registration.dispose();
    foldersSub.dispose();
    clearInterval(timer);
    cmd.dispose();
    changeEmitter.dispose();
  });
}
