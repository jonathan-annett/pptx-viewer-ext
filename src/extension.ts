// Web extension entrypoint.
// Runs inside a web worker in vscode.dev — no Node APIs available.
import * as vscode from 'vscode';
import { PptxEditorProvider } from './provider';
import { initLog, log } from './log';
import { SyncManager } from './sync/manager';
import { createStatusBarItem } from './sync/statusBar';
import { buildDryRunPlan, formatDryRunPlan } from './sync/planner';
import { openPlanPanel } from './sync/planView';
import { SyncConfigEditorProvider } from './sync/configEditor';
import { AdminEditorProvider } from './sync/adminEditor';
import { registerProbe } from './sync/probe';
import { setHashCacheSingleton } from './sync/hashCache';
import { openHashCache } from './sync/hashCacheIdb';
import { setParseCacheSingleton } from './sync/parseCache';
import { openParseCache } from './sync/parseCacheIdb';
import { SnapshotStore, snapshotUri } from './sync/snapshotStore';
import {
  clearSnapshotCommand,
  ensureWorkspaceLockSettings,
  maybeRestore,
  showSnapshotCommand,
  startSnapshotWriter,
} from './sync/restoreFlow';

// The literal "__PPTX_BUILD_INFO_PLACEHOLDER__" is rewritten in the emitted
// bundle by esbuild's post-build plugin (see esbuild.config.js) into a JSON
// payload like '{"buildTime":"...","gitSha":"..."}' — different on every
// (re)build. We parse it once at activation. Using a placeholder string
// rather than esbuild `define` because `define` is cached at watch-mode
// context creation and would freeze the values at watcher start.
const BUILD_INFO_RAW = '__PPTX_BUILD_INFO_PLACEHOLDER__';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLog(context);
  log(`activate: pptx-viewer ${packageVersion(context)} loaded`);
  logBuildInfo();

  // M4.6 — silent restore must run BEFORE SyncManager.create so the
  // manager's initial reload sees the just-restored folders. If the
  // restore triggers a host restart (first folder added to a folderless
  // workspace), this activation tears down and re-runs with folders in
  // place; the post-restart branch finishes settings application + toast.
  const snapshotStore = new SnapshotStore(context);
  try {
    await maybeRestore(context, snapshotStore);
  } catch (err) {
    log(`snapshot: maybeRestore threw — ${err instanceof Error ? err.message : String(err)}`);
  }

  // Register the pptx custom editor BEFORE the rest of activation. On PWA
  // refresh VS Code restores .pptx editor tabs as soon as workspace folders
  // are mounted (just above, by maybeRestore). If the provider isn't
  // registered by then, VS Code drops the tab and shows the welcome page —
  // user has to click the file in the explorer to re-open it. Previously
  // this registration sat after ensureWorkspaceLockSettings + cache opens +
  // SyncManager.create, far enough into activate() for VS Code to give up.
  //
  // The provider needs SyncManager for the "Sync target" section but
  // nothing else, so we hand it a Promise and resolve it later.
  let resolveManager!: (m: SyncManager) => void;
  const managerPromise = new Promise<SyncManager>((res) => {
    resolveManager = res;
  });
  context.subscriptions.push(
    PptxEditorProvider.register(managerPromise, context.globalState),
  );
  log('activate: custom editor registered for *.pptx');

  // Re-open the last-active .pptx file. vscode.dev does not preserve custom
  // editor tabs across PWA refresh — workspace folders come back (via
  // maybeRestore above) but the focused .pptx tab is replaced by the welcome
  // page. The provider writes the active panel's URI to globalState whenever
  // it gains focus; here we replay it. Fire-and-forget — resolveCustomEditor
  // awaits the managerPromise internally, so the panel populates as the rest
  // of activation finishes. Failures (file moved/deleted since last session)
  // surface only in the log.
  const lastActivePptx = context.globalState.get<string>('pptxViewer.lastActiveUri');
  if (lastActivePptx) {
    log(`restore: re-opening last-active pptx — ${lastActivePptx}`);
    void vscode.commands
      .executeCommand(
        'vscode.openWith',
        vscode.Uri.parse(lastActivePptx),
        PptxEditorProvider.viewType,
      )
      .then(
        () => {},
        (err: unknown) => {
          log(
            `restore: re-open last-active failed — ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
  }

  // Seed read-only lock settings (files.readonlyInclude / readonlyExclude)
  // if missing — destinations are read-only by default; the source folder
  // (workspaceFolders[0]) is the writable carve-out. No-op when the user has
  // already set these at workspace scope or when the snapshot just restored
  // them. Must run AFTER maybeRestore (snapshot wins) and BEFORE the manager
  // first emits (so the snapshot writer's initial state captures them).
  try {
    await ensureWorkspaceLockSettings();
  } catch (err) {
    log(`snapshot: ensureWorkspaceLockSettings threw — ${err instanceof Error ? err.message : String(err)}`);
  }

  // M5.2.5 — URI hash cache. Initialised once at activation and parked on a
  // module singleton (planner.ts + runSync.ts read it via getHashCacheSingleton).
  // Falls back to in-memory when IndexedDB is unavailable. Cold-restore of
  // warm entries via IDB is silent — the user just sees faster plan builds.
  try {
    const { cache, idb, warmEntries } = await openHashCache<vscode.Uri>();
    setHashCacheSingleton(cache);
    log(`hash-cache: idb=${idb ? 'available' : 'unavailable'} warm-entries=${warmEntries}`);
  } catch (err) {
    log(
      `hash-cache: init failed — ${err instanceof Error ? err.message : String(err)} (continuing without cache)`,
    );
  }

  // M5.3 Phase B — content-hashed parse cache (sha256 → ParseResult) with
  // IDB persistence. Two object stores: parseResults (metadata, no thumb)
  // and thumbnails (data URLs). Falls back to in-memory if IDB is unreachable.
  // Wired into the pptx viewer's three parse sites (open/ingest/refresh) via
  // getParseCacheSingleton. Phase C will plug the same singleton into the
  // planner's source-walk validator pass.
  try {
    const { cache, idb, warmEntries } = await openParseCache();
    setParseCacheSingleton(cache);
    log(`parse-cache: idb=${idb ? 'available' : 'unavailable'} warm-entries=${warmEntries}`);
  } catch (err) {
    log(
      `parse-cache: init failed — ${err instanceof Error ? err.message : String(err)} (continuing without cache)`,
    );
  }

  // Sync feature — M1: config layer + diagnostics. The manager owns config
  // discovery, hot-reload, and topology resolution. The status bar and the
  // showTopology command are surface layers over the manager's state.
  const manager = await SyncManager.create(context);
  // Unblock any resolveCustomEditor calls that landed during activation —
  // they've been awaiting this since the provider was registered above.
  resolveManager(manager);

  // Snapshot writer subscribes to topology changes — every config edit or
  // workspace folder add/remove recaptures and rewrites .admin-sync.jsonc
  // if anything actually changed. Skip-on-equal handled inside.
  context.subscriptions.push(
    startSnapshotWriter(snapshotStore, (listener) => manager.onDidChange(listener)),
  );
  createStatusBarItem(context, manager);
  context.subscriptions.push(SyncConfigEditorProvider.register(manager));
  log('activate: .sync.jsonc custom editor registered');
  context.subscriptions.push(AdminEditorProvider.register(snapshotStore, manager));
  log('activate: .admin-sync.jsonc custom editor registered');
  context.subscriptions.push(
    vscode.commands.registerCommand('folderSync.showTopology', () => {
      log('sync: showTopology invoked');
      log('--- topology ---');
      for (const line of manager.dumpTopology().split('\n')) log(line);
      log('--- end topology ---');
      // Surface the Output Channel so the user can read what just printed.
      void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
    }),
    vscode.commands.registerCommand('folderSync.dryRunPlan', async () => {
      log('sync: dryRunPlan invoked');
      try {
        const plans = await buildDryRunPlan(manager.getTopology());
        for (const line of formatDryRunPlan(plans).split('\n')) log(line);
      } catch (err) {
        log(`sync: dryRunPlan failed — ${err instanceof Error ? err.message : String(err)}`);
      }
      void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
    }),
    vscode.commands.registerCommand('folderSync.openPlan', async () => {
      await openPlanPanel(manager.getTopology());
    }),
    registerProbe(context),
    vscode.commands.registerCommand('folderSync.showSnapshot', async () => {
      log('snapshot: showSnapshot invoked');
      await showSnapshotCommand(snapshotStore);
      void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
    }),
    vscode.commands.registerCommand('folderSync.clearSnapshot', async () => {
      log('snapshot: clearSnapshot invoked');
      await clearSnapshotCommand(context, snapshotStore);
    }),
    vscode.commands.registerCommand('folderSync.openAdminConfig', async () => {
      log('admin-editor: openAdminConfig invoked');
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        void vscode.window.showWarningMessage(
          'Cannot open admin config — no workspace folders are open.',
        );
        return;
      }
      // Prefer the pointer's URI if present (handles the case where the
      // user has moved/renamed workspaceFolders[0] but the snapshot still
      // lives where it was). Fall back to workspaceFolders[0]/.admin-sync.jsonc.
      const pointer = snapshotStore.getPointer();
      const target = pointer
        ? vscode.Uri.parse(pointer.uri)
        : snapshotUri(folders[0].uri);
      await vscode.commands.executeCommand(
        'vscode.openWith',
        target,
        'folderSync.adminEditor',
      );
    }),
  );
  log('activate: folder sync manager initialised');
}

export function deactivate(): void {
  log('deactivate');
}

function packageVersion(context: vscode.ExtensionContext): string {
  // context.extension is set when the activation context is fully wired up.
  // Fall back to "?" if it's not available (older API surfaces).
  return (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '?';
}

function logBuildInfo(): void {
  // The unprocessed placeholder is not valid JSON, so JSON.parse will throw
  // and the catch branch surfaces the misconfiguration. After a successful
  // build the value is a JSON object string and parses cleanly.
  try {
    const info = JSON.parse(BUILD_INFO_RAW) as { buildTime?: string; gitSha?: string };
    log(`build: ${info.buildTime ?? '?'} sha=${info.gitSha ?? '?'}`);
  } catch (err) {
    log(`build: info unparseable raw=${BUILD_INFO_RAW.slice(0, 60)} (${err instanceof Error ? err.message : String(err)})`);
  }
}
