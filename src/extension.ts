// Web extension entrypoint.
// Runs inside a web worker in vscode.dev — no Node APIs available.
import * as vscode from 'vscode';
import { PptxEditorProvider } from './provider';
import { PdfEditorProvider } from './pdfViewer';
import { initLog, log } from './log';
import { isWebHost } from './host';
import { setHashCacheSingleton } from './shared/hashCache';
import { openHashCache } from './shared/hashCacheIdb';
import { setParseCacheSingleton } from './shared/parseCache';
import { openParseCache } from './shared/parseCacheIdb';
import {
  activatePlaceholderRegistry,
  getActivePlaceholderSet,
} from './shared/placeholderRegistry';
import { createSearchEngine } from './search/searchEngine';
import { openSearchIndexStore } from './search/indexStore';
import { startSearchIndexer } from './search/indexer';
import { registerPlaceholderDecorations } from './search/placeholderDecorations';
import { openSearchPanel } from './search/searchPanel';
import { registerResetState } from './resetState';

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

  // Register the pptx custom editor BEFORE the rest of activation. On PWA
  // refresh VS Code restores .pptx editor tabs as soon as workspace folders
  // are mounted. If the provider isn't registered by then, VS Code drops the
  // tab and shows the welcome page — user has to click the file in the
  // explorer to re-open it.
  context.subscriptions.push(
    PptxEditorProvider.register(),
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
  if (isWebHost()) {
    void restoreLastActiveTab(context);
  } else {
    log('restore: desktop host — last-active-tab replay skipped (native tab persistence)');
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

  // Active-tab tracker for the PWA-refresh-restore loop above.
  context.subscriptions.push(startActiveTabTracker(context));

  // Placeholder registry — answers "is this sha a placeholder?" from the
  // `pptxViewer.placeholderHashes` setting (+ the implicit empty-file default).
  // Consumers: viewer placeholder banner, search per-URI placeholder indexing.
  context.subscriptions.push(activatePlaceholderRegistry(context));

  // Factory-reset command.
  context.subscriptions.push(registerResetState(context));

  // Search subsystem — M4. The IDB store opens lazily (returns undefined
  // when IndexedDB isn't reachable; indexer + engine still work in-memory).
  // The engine is hydrated from the store before the indexer starts so a
  // warm-load can serve hits immediately while the background pass walks
  // the disk for new/changed/deleted files. M5 will register the command
  // + webview panel that calls `engine.search(query)`.
  try {
    const engine = createSearchEngine();
    // Register placeholder shas BEFORE load() so the warm-load correctly skips
    // seeding placeholder-sha projections (they're re-asserted per-URI by the
    // indexer's first pass). Without this, load() seeds a stale bare-sha entry
    // for the empty-file sha — harmless (the pass cleans it up) but it's the
    // tested invariant, so do it in the right order.
    engine.setPlaceholderShas(await getActivePlaceholderSet());
    const store = await openSearchIndexStore();
    if (store) {
      const warm = await store.getAll();
      engine.load(warm);
      log(`search-index: idb=available warm-entries=${warm.length}`);
    } else {
      log('search-index: idb=unavailable (in-memory only)');
    }
    const indexer = startSearchIndexer({ engine, store });
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

  // Explorer placeholder badges — independent of the search index (its own
  // crawler), so it runs even when the search IDB is unavailable.
  context.subscriptions.push(registerPlaceholderDecorations());
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

// Only DECK viewers are re-opened on restore. Re-opening the folder-sync admin
// / config / manifest custom editors kicks off heavy per-folder I/O (full plan
// build, view-model stats) that — on web FSA, right after a refresh — risks
// deadlocking activation before the workspace has settled. A deck viewer just
// renders one file, so it's safe. A non-deck last tab is simply not restored.
const RESTORABLE_VIEW_TYPES = new Set(['pptxViewer.viewer', 'pptxViewer.pdfViewer']);

async function restoreLastActiveTab(context: vscode.ExtensionContext): Promise<void> {
  const saved = context.globalState.get<SavedActiveTab>(ACTIVE_TAB_KEY);
  if (!saved?.uri) return;
  if (!saved.viewType || !RESTORABLE_VIEW_TYPES.has(saved.viewType)) {
    log(
      `restore: skipping last-active tab — not a deck viewer ` +
        `(viewType=${saved.viewType ?? 'text'}, ${saved.uri})`,
    );
    return;
  }
  try {
    const uri = vscode.Uri.parse(saved.uri);
    log(`restore: re-opening last-active tab — ${saved.uri} (viewType=${saved.viewType})`);
    await vscode.commands.executeCommand('vscode.openWith', uri, saved.viewType);
  } catch (err) {
    log(
      `restore: re-open last-active failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
