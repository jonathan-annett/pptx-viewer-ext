// Web extension entrypoint.
// Runs inside a web worker in vscode.dev — no Node APIs available.
import * as vscode from 'vscode';
import { PptxEditorProvider } from './provider';
import { PdfEditorProvider } from './pdfViewer';
import { initLog, log } from './log';
import { isWebHost } from './host';
import { SyncManager } from './sync/manager';
import { createStatusBarItem } from './sync/statusBar';
import { buildDryRunPlan, formatDryRunPlan } from './sync/planner';
import { openPlanPanel } from './sync/planView';
import type { ResolvedSource, ResolvedTopology } from './sync/topology';
import { SyncConfigEditorProvider } from './sync/configEditor';
import { AdminEditorProvider } from './sync/adminEditor';
import { ManifestEditorProvider } from './sync/manifestEditor';
import {
  activateDestinationOnlyContextKey,
  maybeAutoOpenOperatorManifest,
} from './sync/destinationOnlyWired';
import {
  attachConflictNotifier,
  registerConfigConflictCommand,
} from './sync/configConflict';
import {
  attachSnapshotConflictNotifier,
  registerSnapshotConflictCommand,
} from './sync/snapshotConflict';
import { EventEditorProvider } from './event/eventEditor';
import { setHashCacheSingleton } from './sync/hashCache';
import { openHashCache } from './sync/hashCacheIdb';
import { setParseCacheSingleton } from './sync/parseCache';
import { openParseCache } from './sync/parseCacheIdb';
import { SnapshotStore, resolveSnapshotUri } from './sync/snapshotStore';
import {
  clearSnapshotCommand,
  maybeRestore,
  showSnapshotCommand,
  startSnapshotWriter,
} from './sync/restoreFlow';
import {
  activatePlaceholderRegistry,
  getActivePlaceholderSet,
} from './sync/placeholderRegistry';
import { createSearchEngine } from './search/searchEngine';
import { openSearchIndexStore } from './search/indexStore';
import { startSearchIndexer } from './search/indexer';
import { openSearchPanel } from './search/searchPanel';
import { registerResetState } from './resetState';
import { registerQuickSetupCommand } from './event/quickSetup';

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
  context.subscriptions.push(PdfEditorProvider.register());
  log('activate: custom editor registered for *.pdf');

  // Re-open the last-active tab. vscode.dev does not preserve open editor
  // tabs across PWA refresh — workspace folders come back (via maybeRestore
  // above) but the focused file is replaced by the welcome page regardless
  // of its editor type. The tracker (started further below) writes the
  // active tab's URI + viewType to globalState whenever the active tab
  // changes; here we replay it. Handles .pptx (custom), .sync.jsonc / .admin-
  // sync.jsonc (custom), plain text, and notebooks; diffs / terminals /
  // webviews are not restorable. Fire-and-forget — failures (file
  // moved/deleted, view-type gone) surface only in the log.
  //
  // Desktop VS Code persists open editor tabs natively across restarts, so
  // replaying our captured tab there would race the native restore and
  // potentially re-open a file the user closed last session. The tracker
  // (startActiveTabTracker, started further below) still runs on desktop
  // so the captured tab stays current — that way a user moving a
  // workspace from desktop into vscode.dev still has a fresh marker to
  // replay from.
  migrateLegacyActiveTabKey(context);
  // Capture marker presence BEFORE the restorer fires so the M3 auto-
  // open can race-freely decide whether to defer (marker present, the
  // restorer will reopen something) or take focus (marker absent, the
  // restorer is a no-op, so the user lands cold). See
  // `maybeAutoOpenOperatorManifest` for the rationale.
  const hadActiveTabMarker = isWebHost()
    ? !!context.globalState.get<SavedActiveTab>(ACTIVE_TAB_KEY)?.uri
    : false;
  if (isWebHost()) {
    void restoreLastActiveTab(context);
  } else {
    log('restore: desktop host — last-active-tab replay skipped (native tab persistence)');
  }

  // Lock-settings seeding (`files.readonlyInclude` / `readonlyExclude`)
  // used to run here at activation, gated on destination-only detection.
  // It's now deferred to the snapshot writer's `tryWrite` so it only
  // fires when source intent is actually present (≥1 `.sync.jsonc`),
  // avoiding the false-positive where a cold destination folder
  // (no manifest yet, looks indistinguishable from a fresh source) got
  // its workspaceFolders[0] erroneously locked. See restoreFlow.ts.

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

  // Placeholder registry — workspace-wide cache of "is this sha a placeholder?".
  // Reads .admin-sync.jsonc's `placeholders: string[]` (plus the implicit
  // empty-file default), invalidates on file change or workspace topology
  // change. Consumers: planner classifier, viewer banner, scoped plans.
  context.subscriptions.push(activatePlaceholderRegistry(context));
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

  // Destination-only mode detection — context key
  // `folderSync.destinationOnlyWorkspace` flips true when the workspace has
  // zero sources and at least one workspace folder carries a manifest at
  // its root. M2+ gates source-side UI on its negation; M1 is just the
  // detector + a probe palette command for verification.
  activateDestinationOnlyContextKey(context, manager);

  // Source-config filename conflict surface — when a folder ends up
  // carrying both `.sync.jsonc` and `.roomSync`, SyncManager records the
  // pair on topology.conflicts. The notifier keeps the
  // `folderSync.hasConfigConflict` context key in sync and pops a one-shot
  // toast on first detection; the command lets the user pick a winner.
  context.subscriptions.push(attachConflictNotifier(manager));
  context.subscriptions.push(registerConfigConflictCommand(manager));

  // Workspace-snapshot filename conflict surface — the parallel of the
  // source-config conflict above, but for `.admin-sync.jsonc` ↔ `.eventSync`
  // at workspaceFolders[0]. Auto-migrates empty `.eventSync` → contents of
  // legacy file (silent rename intent); toasts once on a genuine conflict;
  // the resolve command lets the user pick a winner.
  context.subscriptions.push(attachSnapshotConflictNotifier());
  context.subscriptions.push(registerSnapshotConflictCommand());

  context.subscriptions.push(SyncConfigEditorProvider.register(manager));
  log('activate: source-config custom editor registered (.sync.jsonc + .roomSync)');
  context.subscriptions.push(AdminEditorProvider.register(snapshotStore, manager));
  log('activate: .admin-sync.jsonc custom editor registered');
  context.subscriptions.push(ManifestEditorProvider.register());
  log('activate: .foldersync-manifest.json custom editor registered');
  context.subscriptions.push(EventEditorProvider.register());
  log('activate: .eventSchedule custom editor registered');
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
        const placeholders = await getActivePlaceholderSet();
        const plans = await buildDryRunPlan(manager.getTopology(), { placeholders });
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
      // lives where it was). Fall back to whichever snapshot filename
      // actually exists at workspaceFolders[0] — preferred (`.eventSync`)
      // when neither does.
      const pointer = snapshotStore.getPointer();
      const target = pointer
        ? vscode.Uri.parse(pointer.uri)
        : (await resolveSnapshotUri(folders[0].uri)).uri;
      await vscode.commands.executeCommand(
        'vscode.openWith',
        target,
        'folderSync.adminEditor',
      );
    }),
    registerResetState(context),
    registerQuickSetupCommand(context),
  );
  log('activate: folder sync manager initialised');

  // Search subsystem — M4. The IDB store opens lazily (returns undefined
  // when IndexedDB isn't reachable; indexer + engine still work in-memory).
  // The engine is hydrated from the store before the indexer starts so a
  // warm-load can serve hits immediately while the background pass walks
  // the disk for new/changed/deleted files. M5 will register the command
  // + webview panel that calls `engine.search(query)`.
  try {
    const engine = createSearchEngine();
    const store = await openSearchIndexStore();
    if (store) {
      const warm = await store.getAll();
      engine.load(warm);
      log(`search-index: idb=available warm-entries=${warm.length}`);
    } else {
      log('search-index: idb=unavailable (in-memory only)');
    }
    const indexer = startSearchIndexer({ engine, store, manager });
    context.subscriptions.push(indexer);
    if (store) {
      context.subscriptions.push({ dispose: () => store.close() });
    }
    log(`search-index: scope folders=${indexer.getScope().folderUris.length}`);

    // Search commands — only register when the search subsystem started cleanly.
    // If init throws above, the catch branch logs and we skip these so the
    // user doesn't see "search: open" wired to nothing.
    context.subscriptions.push(
      vscode.commands.registerCommand('pptxSearch.openPanel', () => {
        openSearchPanel({ engine, indexer });
      }),
    );
  } catch (err) {
    log(
      `search-index: init failed — ${err instanceof Error ? err.message : String(err)} (search disabled this session)`,
    );
  }

  // M3 — auto-open the canonical manifest in operator mode. Fire-and-
  // forget: the helper checks operator-mode + canonical-manifest
  // presence + defers when the active-tab restorer is going to open
  // something. Web-only — desktop persists tabs natively, so the user
  // gets whatever they had focused last session without our help.
  if (isWebHost()) {
    void maybeAutoOpenOperatorManifest(hadActiveTabMarker);
  }
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
// the arg is undefined and we fall back to the first workspace folder.
//
// Resolution order (each click maps to at most one scoped plan; we never
// open multiple panels at once because the right-clicked folder is a single
// physical location and there's a unique source/destination mapping for it):
//
//   1. Topology has any sources at all → otherwise "no .sync.jsonc anywhere".
//
//   2. **Destination-side click** — the target sits inside some
//      `dest.destRootUri` subtree. The user wants the plan that *would
//      write* to this exact location, so we walk the mapping backwards: the
//      relative path from `destRootUri` to the target is the same relative
//      path from the source's `sourceFolderUri` to its mirror on the source
//      side. We open the scoped plan against the source with that mapped
//      path as the filter. If two destinations could match (deeper subpath
//      nests inside a shallower one) we take the deeper — same nearest-
//      ancestor rule as source resolution below.
//
//   3. **Source-side click** — the target sits inside a `sourceFolderUri`.
//      Open the scoped plan against that source, filter = the target itself.
//      Nearest-source rule when multiple sources nest.
//
//   4. Neither — info message. Covers "inside a destination workspace folder
//      but outside every destination's subpath" and "no .sync.jsonc anywhere
//      that covers this folder".

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
  const rel = vscode.workspace.asRelativePath(target, false) || target.toString();

  // Destination-side click: map back to the source's mirror path and open
  // the scoped plan from there. The user gets the same plan they'd see by
  // right-clicking the matching source folder.
  const destHit = findDestinationContaining(topology, target);
  if (destHit) {
    log(
      `sync: syncThisFolder invoked (destination-side) — target=${target.toString()} ` +
        `source=${destHit.source.configUri.toString()} ` +
        `mapped=${destHit.mappedSourceUri.toString()}`,
    );
    await openPlanPanel(topology, {
      scope: {
        sourceConfigUri: destHit.source.configUri,
        pathFilter: destHit.mappedSourceUri,
        pathFilterIsFile: false,
      },
      title: `Folder Sync — ${rel} (via ${destHit.source.workspaceFolderName})`,
    });
    return;
  }

  const source = findNearestSourceForPath(topology, target);
  if (!source) {
    void vscode.window.showInformationMessage(
      'Folder Sync: no .sync.jsonc covers this folder. Add one at this folder or an ancestor.',
    );
    return;
  }
  log(
    `sync: syncThisFolder invoked (source-side) — target=${target.toString()} ` +
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
 * Find the (source, destination) pair whose resolved `destRootUri` contains
 * `target`, and compute the equivalent URI on the source side. Used to
 * reverse-map a destination-side right-click to the scoped plan that would
 * have written to that exact location.
 *
 * "Deepest match wins" — when one destination's subpath nests inside another
 * (legal as long as they belong to different sources; same-source overlap is
 * caught by topology diagnostics). The longer `destRootUri.path` is the
 * tighter match.
 *
 * We check `destRootUri` (subpath-resolved) rather than `workspaceFolderUri`
 * because a click outside the subpath isn't actually written by any source —
 * for those cases the caller falls through to nearest-source resolution.
 */
function findDestinationContaining(
  topology: ResolvedTopology,
  target: vscode.Uri,
): { source: ResolvedSource; mappedSourceUri: vscode.Uri } | undefined {
  let best: { source: ResolvedSource; mappedSourceUri: vscode.Uri } | undefined;
  let bestLen = -1;
  for (const src of topology.sources) {
    for (const dest of src.destinations) {
      const root = dest.destRootUri;
      if (!root) continue;
      if (!sameSchemeAuthority(root, target)) continue;
      if (!isPathAtOrUnder(root.path, target.path)) continue;
      const rootPath = stripTrailingSlash(root.path);
      const rel = target.path === rootPath ? '' : target.path.slice(rootPath.length + 1);
      const srcPath = stripTrailingSlash(src.sourceFolderUri.path);
      const mappedPath = rel === '' ? srcPath : `${srcPath}/${rel}`;
      if (rootPath.length > bestLen) {
        best = { source: src, mappedSourceUri: src.sourceFolderUri.with({ path: mappedPath }) };
        bestLen = rootPath.length;
      }
    }
  }
  return best;
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
