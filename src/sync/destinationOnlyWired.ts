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
import { readManifest, resolveManifestUri } from './manifest';
import type { ManifestSummary } from './statusBarOperator';
import { SYNC_CONFIG_GLOB } from './configFilenames';
import {
  MANIFEST_GLOB,
  PREFERRED_MANIFEST_FILENAME,
  pathEndsWithManifestFilename,
} from './manifestFilenames';

const CONTEXT_KEY = 'folderSync.destinationOnlyWorkspace';

/**
 * globalState key for the operator-mode restore capture — the
 * destination-mode equivalent of the file-based `.admin-sync.jsonc`
 * snapshot. Lives in globalState because operator mode deliberately
 * doesn't write artifacts into the destination folder.
 */
const OPERATOR_RESTORE_KEY = 'folderSync.operatorRestore';

export interface OperatorRestoreCapture {
  /** Workspace folders to re-mount on cold restore. */
  folders: { uri: string; name: string }[];
  capturedAt: string;
}

interface State {
  manifestPresence: Map<string, boolean>;
  manager: SyncManager;
  /** Last value passed to subscribers — used to seed late subscribers. */
  lastState: DestinationOnlyState;
  context: vscode.ExtensionContext;
  /**
   * Last value we wrote to the folder-restore capture (true = "wrote a
   * capture because workspace has no sources"). Undefined until the
   * first recompute. Used to suppress redundant globalState writes —
   * we only touch it on transitions, same idea as the file-based
   * snapshot writer's skip-on-equal.
   */
  lastWroteFolderRestore: boolean | undefined;
  /**
   * Whether the canonical manifest was present at the previous recompute.
   * `undefined` until the first recompute completes — that initial value
   * keeps the M3 activation auto-open the only entry point at startup; the
   * mid-session "manifest just arrived" trigger fires only on a `false →
   * true` transition, never on `undefined → true`.
   */
  lastCanonicalManifestPresent: boolean | undefined;
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

/**
 * URI of any manifest file that exists at the root of `folderUri`. Tries
 * the preferred filename first, falls back to the legacy. Returns undefined
 * when neither exists — the caller treats that as "no manifest here".
 */
async function findManifestAtFolder(folderUri: vscode.Uri): Promise<vscode.Uri | undefined> {
  const resolved = await resolveManifestUri(folderUri);
  return resolved.existed ? resolved.uri : undefined;
}

/**
 * The canonical place we'd put a *new* manifest at this folder — used for
 * display, watcher comparisons, and auto-open targets. The actual file on
 * disk may live under either honoured filename; see {@link findManifestAtFolder}.
 */
function canonicalManifestUriForFolder(folderUri: vscode.Uri): vscode.Uri {
  // The preferred filename is the right canonical for new destinations.
  // For an existing legacy-named manifest, callers that need the on-disk
  // URI go through findManifestAtFolder; this helper is only used for
  // "open the manifest at this folder" flows where opening either filename
  // is correct (VS Code dispatches to the same custom editor either way).
  return vscode.Uri.joinPath(folderUri, PREFERRED_MANIFEST_FILENAME);
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
 *   - any source config (`.sync.jsonc` or `.roomSync`) anywhere → false
 *     (workspace has source intent)
 *   - otherwise → true iff at least one workspace folder has a
 *     `.foldersync-manifest.json` at its root.
 */
export async function detectDestinationOnlyFromFs(): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return false;
  // `maxResults: 1` short-circuits the glob as soon as one source config
  // is found anywhere in the workspace — we only need the boolean.
  const sources = await vscode.workspace.findFiles(SYNC_CONFIG_GLOB, undefined, 1);
  if (sources.length > 0) return false;
  for (const folder of folders) {
    const hit = await findManifestAtFolder(folder.uri);
    if (hit) return true;
  }
  return false;
}

async function scanAll(): Promise<void> {
  if (!current) return;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const next = new Map<string, boolean>();
  for (const folder of folders) {
    const hit = await findManifestAtFolder(folder.uri);
    next.set(folder.uri.toString(), hit !== undefined);
  }
  current.manifestPresence = next;
}

async function recompute(): Promise<void> {
  if (!current) return;
  const folders = vscode.workspace.workspaceFolders ?? [];
  // Re-stat presence at the top of every recompute. The FileSystemWatcher's
  // onDidCreate / onDidDelete events are FS-provider-specific — on FSA-
  // backed local filesystems in vscode.dev, certain create flows
  // (explorer "New File" via rename, atomic tmp+rename writes, etc.) can
  // miss the right event. Always restating means watcher events are
  // advisory triggers; the FS is the source of truth.
  await scanAll();
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

  // M5 — canonical-manifest-arrival auto-open. Fires only on a true
  // false→true transition (the operator was running in a manifest-less
  // workspace and the main user just ran their first sync). The
  // undefined→true case on first recompute is deliberately NOT a
  // trigger here — that path belongs to the M3 activation auto-open,
  // which already runs from extension.ts with proper active-tab-marker
  // race resolution.
  const isCanonicalPresent = canonicalManifest !== undefined;
  const wasCanonicalPresent = current.lastCanonicalManifestPresent;
  current.lastCanonicalManifestPresent = isCanonicalPresent;
  if (result && isCanonicalPresent && wasCanonicalPresent === false) {
    void autoOpenCanonicalManifestOnArrival();
  }

  // Folder-restore capture: maintain a globalState entry mirroring the
  // current workspace folders so PWA refresh can re-mount them. Fires
  // whenever the workspace has *no sources* — covers operator mode
  // proper (no sources + manifest present) AND the cold-folder case
  // (no sources + no manifest yet; could be a destination-in-waiting).
  // The .admin-sync.jsonc pointer is the authoritative restore when
  // sources exist; this globalState capture covers everything else.
  const noSources = current.manager.getTopology().sources.length === 0 && folders.length > 0;
  if (noSources !== current.lastWroteFolderRestore) {
    if (noSources) {
      await writeOperatorRestoreCapture(current.context, folders);
    } else {
      await clearOperatorRestoreCapture(current.context);
    }
    current.lastWroteFolderRestore = noSources;
  }

  log(
    `destination-only: setContext ${CONTEXT_KEY}=${result} ` +
      `(sources=${current.manager.getTopology().sources.length}, ` +
      `folders=${folders.length}, ` +
      `manifestsPresent=${countTrue(current.manifestPresence)}, ` +
      `canonicalManifest=${canonicalManifest ? `lastSync=${canonicalManifest.lastSync ?? 'null'}` : 'none'})`,
  );
}

async function writeOperatorRestoreCapture(
  context: vscode.ExtensionContext,
  folders: readonly vscode.WorkspaceFolder[],
): Promise<void> {
  const capture: OperatorRestoreCapture = {
    folders: folders.map((f) => ({ uri: f.uri.toString(), name: f.name })),
    capturedAt: new Date().toISOString(),
  };
  await context.globalState.update(OPERATOR_RESTORE_KEY, capture);
  log(`destination-only: wrote operator-restore capture (${capture.folders.length} folder(s))`);
}

async function clearOperatorRestoreCapture(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (context.globalState.get<OperatorRestoreCapture>(OPERATOR_RESTORE_KEY) === undefined) {
    return;
  }
  await context.globalState.update(OPERATOR_RESTORE_KEY, undefined);
  log('destination-only: cleared operator-restore capture (no longer in operator mode)');
}

/**
 * Read the operator-restore capture from globalState. Used by
 * `maybeRestore` in restoreFlow.ts to cold-restore destination-only
 * workspaces on PWA refresh. Returns undefined when no capture exists.
 */
export function getOperatorRestoreCapture(
  context: vscode.ExtensionContext,
): OperatorRestoreCapture | undefined {
  return context.globalState.get<OperatorRestoreCapture>(OPERATOR_RESTORE_KEY);
}

/**
 * M3 — auto-open the canonical manifest on activation when the
 * workspace is in operator mode, *unless* the active-tab restorer is
 * about to open a tab (in which case it would steal focus from the
 * user's last-focused file).
 *
 * Caller passes `hadActiveTabMarker` — captured in extension.ts BEFORE
 * the restorer fires so the check is race-free. If the marker was set,
 * the restorer will re-open something and we should defer to it. If
 * the marker was unset, the restorer is a no-op and we're free to
 * land the user on the manifest inspector (the operator's primary
 * surface).
 *
 * Detection is FS-driven: stat `workspaceFolders[0]/.foldersync-manifest.json`
 * for the canonical-manifest existence, then findFiles for source
 * presence. We don't go through the wired layer's state event because
 * the initial scan may not have completed by the time we want to
 * auto-open — the FS check is the authoritative source either way.
 *
 * Fire-and-forget from `activate()`; errors are logged and swallowed.
 */
export async function maybeAutoOpenOperatorManifest(
  hadActiveTabMarker: boolean,
): Promise<void> {
  if (hadActiveTabMarker) {
    log('manifest-auto-open: active-tab marker present, deferring to active-tab restorer');
    return;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    log('manifest-auto-open: no workspace folders, skipping');
    return;
  }
  // Canonical-manifest check first — workspaceFolders[0] is the
  // operator's entry point, and its root manifest is what the M2 status
  // bar's click target also opens. If folder[0] doesn't have a manifest
  // we don't auto-open even when a *non-canonical* folder does — the
  // operator might be inspecting two destinations side-by-side and we
  // shouldn't pick one arbitrarily. Accepts either honoured filename.
  const canonicalUri = await findManifestAtFolder(folders[0].uri);
  if (!canonicalUri) {
    log(`manifest-auto-open: no canonical manifest at ${folders[0].uri.toString()}, skipping`);
    return;
  }
  // Operator mode requires *zero* sources in the workspace — same gate
  // as `detectDestinationOnlyFromFs`, inlined here so we short-circuit
  // the second FS call when the canonical check already fails.
  const sources = await vscode.workspace.findFiles(SYNC_CONFIG_GLOB, undefined, 1);
  if (sources.length > 0) {
    log('manifest-auto-open: workspace has source(s), not in operator mode, skipping');
    return;
  }
  log(`manifest-auto-open: opening canonical manifest ${canonicalUri.toString()}`);
  try {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      canonicalUri,
      'folderSync.manifestEditor',
    );
  } catch (err) {
    log(`manifest-auto-open: openWith failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * M5 — mid-session counterpart to `maybeAutoOpenOperatorManifest`. Fires
 * from `recompute` when the canonical manifest transitions from absent
 * to present (the main user just ran their first sync into a previously
 * empty destination). Only opens when no editor tabs are currently open
 * — if the operator has been doing something else in the workspace
 * (file exploration, viewing a different file), don't steal focus.
 *
 * The activation case is handled by M3's helper. This one is strictly
 * for the workspace-was-already-open-when-the-manifest-arrived path.
 */
async function autoOpenCanonicalManifestOnArrival(): Promise<void> {
  if (anyEditorTabOpen()) {
    log('manifest-auto-open: tabs already open mid-session, skipping arrival auto-open');
    return;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return;
  // Defensive re-resolve — recompute may have computed canonicalManifest
  // from a stale presence entry, or the file may have been deleted between
  // the stat and this trigger. Accepts either honoured filename.
  const canonicalUri = await findManifestAtFolder(folders[0].uri);
  if (!canonicalUri) {
    log('manifest-auto-open: canonical manifest disappeared before arrival auto-open');
    return;
  }
  log(`manifest-auto-open: canonical manifest just arrived, opening ${canonicalUri.toString()}`);
  try {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      canonicalUri,
      'folderSync.manifestEditor',
    );
  } catch (err) {
    log(`manifest-auto-open: arrival openWith failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * True when any tab in any tab group carries an editor input (text,
 * custom, notebook, or otherwise). We intentionally count "any input"
 * rather than "input matching a specific URI" — the predicate exists
 * so we never steal focus from work-in-progress.
 */
function anyEditorTabOpen(): boolean {
  return vscode.window.tabGroups.all.some(
    (g) => g.tabs.some((t) => t.input !== undefined),
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
  // The on-disk manifest may be either honoured filename; use the existing
  // file's URI when one is there, otherwise fall back to the canonical
  // (preferred) URI for display purposes.
  const existing = await findManifestAtFolder(folderUri);
  return {
    manifestUri: existing ?? canonicalManifestUriForFolder(folderUri),
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
  // The event URI carries whichever filename actually changed. Match it to
  // a folder by checking that its parent equals a workspace folder and the
  // basename is one of the honoured manifest names. The presence map is
  // keyed by folder, not by filename — either file's create/delete flips
  // the same boolean. recompute() re-stats both forms via scanAll, so a
  // delete of one when the other still exists keeps presence true.
  if (!pathEndsWithManifestFilename(uri.path)) return;
  const parentPath = uri.path.slice(0, uri.path.lastIndexOf('/'));
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const folderPath = folder.uri.path.endsWith('/')
      ? folder.uri.path.slice(0, -1)
      : folder.uri.path;
    if (folderPath === parentPath) {
      // Optimistic update; recompute() restats so a wrong guess corrects.
      if (kind === 'create') {
        current.manifestPresence.set(folder.uri.toString(), true);
      }
      void recompute();
      return;
    }
  }
}

/**
 * Manifest content changed (edit, not create/delete). Presence doesn't
 * flip, but the canonical manifest's `lastSync` may have just rolled
 * forward, so the status bar's relative-time copy needs to update.
 * Filtered to the canonical folder's root manifest (either honoured
 * filename) — edits to manifests elsewhere don't drive the status bar.
 */
function handleManifestChange(uri: vscode.Uri): void {
  if (!current) return;
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return;
  if (!pathEndsWithManifestFilename(uri.path)) return;
  const parentPath = uri.path.slice(0, uri.path.lastIndexOf('/'));
  const canonicalFolderPath = folders[0].uri.path.endsWith('/')
    ? folders[0].uri.path.slice(0, -1)
    : folders[0].uri.path;
  if (parentPath === canonicalFolderPath) {
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
    context,
    lastWroteFolderRestore: undefined,
    lastCanonicalManifestPresent: undefined,
  };

  const watcher = vscode.workspace.createFileSystemWatcher(MANIFEST_GLOB);
  watcher.onDidCreate((u) => handleManifestEvent(u, 'create'));
  watcher.onDidDelete((u) => handleManifestEvent(u, 'delete'));
  // onDidChange drives the operator status bar's relative-time refresh —
  // an edit to the canonical manifest may have just rolled lastSync forward.
  // Presence stays unchanged; recompute re-reads + re-fires the state event.
  watcher.onDidChange((u) => handleManifestChange(u));

  const foldersSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void recompute();
  });

  const managerSub = manager.onDidChange(() => {
    void recompute();
  });

  // Backup trigger — FSA-backed filesystems can skip onDidCreate when a
  // file is created via rename (the "New File" flow in the explorer is a
  // documented example). If a manifest opens in any editor and the
  // wired layer hadn't yet seen it, this kicks a recompute. recompute()
  // re-stats from scratch via scanAll() so the missed event is recovered.
  const docOpenSub = vscode.workspace.onDidOpenTextDocument((doc) => {
    if (pathEndsWithManifestFilename(doc.uri.path)) {
      void recompute();
    }
  });

  // Initial recompute. recompute() now stats fresh at the top so the
  // initial empty presence map is repopulated immediately rather than
  // requiring two passes (manager.onDidChange then scan-completes).
  void recompute();

  const disposable: vscode.Disposable = {
    dispose(): void {
      watcher.dispose();
      foldersSub.dispose();
      managerSub.dispose();
      docOpenSub.dispose();
      current = undefined;
    },
  };
  context.subscriptions.push(disposable);
  return disposable;
}

