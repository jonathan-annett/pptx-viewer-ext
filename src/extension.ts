// Web extension entrypoint.
// Runs inside a web worker in vscode.dev — no Node APIs available.
import * as vscode from 'vscode';
import { PptxEditorProvider } from './provider';
import { initLog, log } from './log';
import { SyncManager } from './sync/manager';
import { createStatusBarItem } from './sync/statusBar';
import { buildDryRunPlan, formatDryRunPlan } from './sync/planner';
import { openPlanPanel } from './sync/planView';
import type { ResolvedSource, ResolvedTopology } from './sync/topology';
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

  // Re-open the last-active tab. vscode.dev does not preserve open editor
  // tabs across PWA refresh — workspace folders come back (via maybeRestore
  // above) but the focused file is replaced by the welcome page regardless
  // of its editor type. The tracker (started further below) writes the
  // active tab's URI + viewType to globalState whenever the active tab
  // changes; here we replay it. Handles .pptx (custom), .sync.jsonc / .admin-
  // sync.jsonc (custom), plain text, and notebooks; diffs / terminals /
  // webviews are not restorable. Fire-and-forget — failures (file
  // moved/deleted, view-type gone) surface only in the log.
  migrateLegacyActiveTabKey(context);
  void restoreLastActiveTab(context);

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

  // Active-tab tracker for the PWA-refresh-restore loop above. Started after
  // manager resolution so the initial capture sees whatever tab the restore
  // just opened (rather than the welcome page during the brief window before).
  context.subscriptions.push(startActiveTabTracker(context));

  // Snapshot writer subscribes to topology changes — every config edit or
  // workspace folder add/remove recaptures and rewrites .admin-sync.jsonc
  // if anything actually changed. Skip-on-equal handled inside.
  context.subscriptions.push(
    startSnapshotWriter(snapshotStore, (listener) => manager.onDidChange(listener)),
  );
  createStatusBarItem(context, manager);
  // M6 — context key drives the Explorer context-menu visibility for
  // "Sync This Folder". We grey the menu entry out (via a `when` clause in
  // package.json) whenever the workspace has zero sources, so the user
  // never sees an unusable menu item. Per-selection greying (e.g. "this
  // selection is inside a destination") would require VS Code APIs that
  // don't exist for explorer right-click; we handle that at click-time
  // with an information message instead.
  const writeHasAnySource = (topology: ResolvedTopology): void => {
    void vscode.commands.executeCommand(
      'setContext',
      'folderSync.hasAnySource',
      topology.sources.length > 0,
    );
  };
  writeHasAnySource(manager.getTopology());
  context.subscriptions.push(manager.onDidChange(writeHasAnySource));
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
    vscode.commands.registerCommand(
      'folderSync.syncThisFolder',
      async (uriArg?: vscode.Uri) => {
        await runSyncThisFolder(manager, uriArg);
      },
    ),
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

// ───── active-tab tracker / restorer ───────────────────────────────────────
//
// vscode.dev does not persist open editor tabs across PWA refresh. M4.6's
// snapshot covers workspace folders + selected settings; this covers the
// focused tab, whatever its editor type:
//   - TabInputText        plain text editors (.sync.jsonc raw, .ts, .md, …)
//   - TabInputCustom      our .pptx viewer, folderSync config + admin editors
//   - TabInputNotebook    .ipynb and friends
// Diff editors, terminals, and ad-hoc webview tabs are not restorable from
// just a URI + viewType, so they fall through (no save → no restore).

interface SavedActiveTab {
  uri: string;
  /** Set for custom editors and notebooks; absent for plain text. */
  viewType?: string;
}

const ACTIVE_TAB_KEY = 'pptxViewer.lastActiveTab';
const LEGACY_PPTX_KEY = 'pptxViewer.lastActiveUri';

function tabInputToSaved(input: unknown): SavedActiveTab | null {
  if (input instanceof vscode.TabInputText) {
    return { uri: input.uri.toString() };
  }
  if (input instanceof vscode.TabInputCustom) {
    return { uri: input.uri.toString(), viewType: input.viewType };
  }
  if (input instanceof vscode.TabInputNotebook) {
    return { uri: input.uri.toString(), viewType: input.notebookType };
  }
  return null;
}

function startActiveTabTracker(context: vscode.ExtensionContext): vscode.Disposable {
  const write = (): void => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!tab) {
      // No active tab (welcome page, empty group) — clear the marker so a
      // refresh into a deliberately-empty workspace doesn't re-open stale
      // state from a previous session.
      void context.globalState.update(ACTIVE_TAB_KEY, undefined);
      return;
    }
    const saved = tabInputToSaved(tab.input);
    if (saved) {
      void context.globalState.update(ACTIVE_TAB_KEY, saved);
    }
    // Unrestorable tab types (diff, terminal, webview): leave the marker as-is
    // so refreshing on top of one still restores the last restorable tab the
    // user had focused.
  };
  // Capture once now in case the user never switches tabs before the next
  // refresh — onDidChangeTabs only fires on changes.
  write();
  return vscode.Disposable.from(
    vscode.window.tabGroups.onDidChangeTabs(write),
    vscode.window.tabGroups.onDidChangeTabGroups(write),
  );
}

/**
 * One-shot migration from the .pptx-only `pptxViewer.lastActiveUri` key
 * (introduced one revision earlier) to the new generic
 * `pptxViewer.lastActiveTab` shape. Idempotent and safe to call on every
 * activate: when there's nothing to migrate it's a no-op.
 */
function migrateLegacyActiveTabKey(context: vscode.ExtensionContext): void {
  if (context.globalState.get<SavedActiveTab>(ACTIVE_TAB_KEY)) return;
  const legacy = context.globalState.get<string>(LEGACY_PPTX_KEY);
  if (!legacy) return;
  void context.globalState.update(ACTIVE_TAB_KEY, {
    uri: legacy,
    viewType: PptxEditorProvider.viewType,
  });
  void context.globalState.update(LEGACY_PPTX_KEY, undefined);
  log(`restore: migrated legacy active-pptx key → lastActiveTab`);
}

async function restoreLastActiveTab(context: vscode.ExtensionContext): Promise<void> {
  const saved = context.globalState.get<SavedActiveTab>(ACTIVE_TAB_KEY);
  if (!saved?.uri) return;
  try {
    const uri = vscode.Uri.parse(saved.uri);
    if (saved.viewType) {
      log(`restore: re-opening last-active tab — ${saved.uri} (viewType=${saved.viewType})`);
      await vscode.commands.executeCommand('vscode.openWith', uri, saved.viewType);
    } else {
      log(`restore: re-opening last-active tab — ${saved.uri} (text)`);
      await vscode.commands.executeCommand('vscode.open', uri);
    }
  } catch (err) {
    log(
      `restore: re-open last-active failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ───── M6 — folder-scoped invocation ───────────────────────────────────────
//
// Explorer right-click → "Folder Sync: Sync This Folder" routes here. The
// arg is the URI of the right-clicked folder (vscode passes it positionally
// for explorer/context menu items). When invoked from the command palette
// the arg is undefined and we fall back to the first workspace folder so
// the command still does something useful.
//
// Validation order (each branch surfaces a distinct info message so the
// user understands why nothing opened):
//   1. Topology has any sources at all → otherwise "no .sync.jsonc anywhere"
//   2. Target is not inside a destination → destinations are read-only and
//      can't be a sync *source*; common confusion when the user right-clicks
//      a destination tree
//   3. Find the nearest enclosing source by walking up from the target URI;
//      none → "no source covers this folder"
//   4. Open the scoped plan webview with a descriptive title

async function runSyncThisFolder(
  manager: SyncManager,
  uriArg?: vscode.Uri,
): Promise<void> {
  const target = uriArg ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!target) {
    void vscode.window.showInformationMessage(
      'Folder Sync: no folder selected and no workspace folders are open.',
    );
    return;
  }
  const topology = manager.getTopology();
  if (topology.sources.length === 0) {
    void vscode.window.showInformationMessage(
      'Folder Sync: no .sync.jsonc found in the workspace. Add one to a source folder first.',
    );
    return;
  }
  if (isInsideAnyDestination(topology, target)) {
    void vscode.window.showInformationMessage(
      'Folder Sync: that folder is inside a destination — destinations are read-only and cannot be synced from.',
    );
    return;
  }
  const source = findNearestSourceForPath(topology, target);
  if (!source) {
    void vscode.window.showInformationMessage(
      'Folder Sync: no .sync.jsonc covers this folder. Add one at this folder or an ancestor.',
    );
    return;
  }
  const rel = vscode.workspace.asRelativePath(target, false) || target.toString();
  log(
    `sync: syncThisFolder invoked — target=${target.toString()} ` +
      `source=${source.configUri.toString()}`,
  );
  await openPlanPanel(topology, {
    scope: {
      sourceConfigUri: source.configUri,
      // Skip the stat round-trip — the explorer/context entry's `when`
      // clause is `explorerResourceIsFolder`, and command-palette fallback
      // uses workspaceFolders[0] which is always a folder.
      pathFilter: target,
      pathFilterIsFile: false,
    },
    title: `Folder Sync — ${rel}`,
  });
}

/**
 * Find the source whose `sourceFolderUri` is the closest ancestor of `target`
 * (or equal to it). Returns the deepest match when multiple sources nest —
 * that's the "nearest yaml" rule from the plan. URI comparison is by path
 * after normalising trailing slashes; same scheme/authority required.
 */
function findNearestSourceForPath(
  topology: ResolvedTopology,
  target: vscode.Uri,
): ResolvedSource | undefined {
  let best: ResolvedSource | undefined;
  let bestLen = -1;
  for (const src of topology.sources) {
    if (!sameSchemeAuthority(src.sourceFolderUri, target)) continue;
    if (!isPathAtOrUnder(src.sourceFolderUri.path, target.path)) continue;
    const len = stripTrailingSlash(src.sourceFolderUri.path).length;
    if (len > bestLen) {
      best = src;
      bestLen = len;
    }
  }
  return best;
}

/**
 * True when `target` is inside any destination's workspace folder — the user
 * right-clicked something on the read-only side. We check the workspace
 * folder root rather than the `destRootUri` so that a subpath-scoped
 * destination still flags every file under the whole folder (the entire
 * folder is treated as read-only in the snapshot's lock settings).
 */
function isInsideAnyDestination(
  topology: ResolvedTopology,
  target: vscode.Uri,
): boolean {
  for (const src of topology.sources) {
    for (const dest of src.destinations) {
      const root = dest.workspaceFolderUri;
      if (!root) continue;
      if (!sameSchemeAuthority(root, target)) continue;
      if (isPathAtOrUnder(root.path, target.path)) return true;
    }
  }
  return false;
}

function sameSchemeAuthority(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.scheme === b.scheme && a.authority === b.authority;
}

/** True when `childPath` is equal to `basePath` or sits below it. Path strings
 *  only — caller has already matched scheme/authority. */
function isPathAtOrUnder(basePath: string, childPath: string): boolean {
  const base = stripTrailingSlash(basePath);
  if (childPath === base) return true;
  return childPath.startsWith(base + '/');
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
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
