// vscode-wired half of the .admin-sync.jsonc custom text editor.
//
// Pairs with the pure renderer in adminEditorHtml.ts. This module:
//   - Registers the CustomTextEditorProvider for .admin-sync.jsonc
//   - Builds the view model by parsing the document text + asking the store
//     for pointer info
//   - Handles command messages: renameFolder, refreshSnapshot, clearSnapshot,
//     openAsText, refreshPlan, runSync
//   - Maintains an embedded **workspace-wide** dry-run plan. Auto-runs on
//     open, on topology changes, on workspace-folder add/remove, and when the
//     user clicks Refresh on the plan card or "Refresh from current
//     workspace". Run Sync calls the same machinery as
//     `folderSync.openPlan` → Proceed, with the same green/orange/red gate
//     logic so collisions block execution.
//
// Folder renames re-apply through vscode.workspace.updateWorkspaceFolders;
// the snapshot writer (in restoreFlow) reacts to that topology event and
// rewrites the file. We don't write the file ourselves from this editor —
// that would race the writer and bypass its diff-check.

import * as vscode from 'vscode';
import { log } from '../log';
import {
  renderAdminEditorHtml,
  type AdminEditorSettingSummary,
  type AdminEditorViewModel,
  type PlaceholderRow,
} from './adminEditorHtml';
import {
  EMPTY_FILE_SHA256,
  KNOWN_WORKSPACE_KEYS,
  parseSnapshot,
  type Snapshot,
} from './snapshot';
import { SnapshotStore } from './snapshotStore';
import { hashFileAtUri } from './hash';
import { vscodeFs } from './vscodeFs';
import { captureAndWriteSnapshot } from './restoreFlow';
import { getActivePlaceholderSet } from './placeholderRegistry';
import {
  renderPlanChips,
  renderPlanPairs,
  toViewModel,
  type PlanTotals,
} from './planHtml';
import type { PlanForDestination } from './planner';
import { buildDryRunPlan } from './planner';
import { runSync, formatRunSummary } from './runSync';
import {
  countAccepted,
  handleDecisionMessage,
  seedRememberedDecisions,
  type RowDecision,
} from './decisions';
import type { SyncManager } from './manager';

const VIEW_TYPE = 'folderSync.adminEditor';

/** Debounce window for plan rebuilds after workspace/topology changes. */
const PLAN_DEBOUNCE_MS = 500;

export class AdminEditorProvider implements vscode.CustomTextEditorProvider {
  static register(store: SnapshotStore, manager: SyncManager): vscode.Disposable {
    const provider = new AdminEditorProvider(store, manager);
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      // Keep edit-state across hide/show; the form has per-row "Rename" mode
      // we don't want to lose when the user switches tabs.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  constructor(
    private readonly store: SnapshotStore,
    private readonly manager: SyncManager,
  ) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = this.renderFor(document);
    log(`admin-editor: opened ${document.uri.toString()}`);

    // ───── plan state + scheduler ─────────────────────────────────────
    // Same pattern as src/sync/configEditor.ts: per-editor debounced rebuild
    // + monotonic run-token so a burst of triggers can't let an older walk's
    // result overwrite a newer one. The most recent plan is also retained so
    // Run Sync can hand it to runSync() without re-walking.
    let planTimer: ReturnType<typeof setTimeout> | undefined;
    let planRunToken = 0;
    let lastPlans: PlanForDestination[] = [];
    let lastPlanHasWork = false;
    let disposed = false;
    let syncInFlight = false;

    // M5.1: per-row decisions captured from the embedded plan. Cleared on
    // each rebuild because decision ids are positional (pairIndex-based) and
    // a topology change can shuffle which pairs are present. Rows whose
    // manifest already records a remembered decision come back pre-checked
    // via the renderer's `withDecision({ checked: true })`; we seed the Map
    // from the plan's `remembered.accepted` items after every rebuild so the
    // executor sees the same arming the user sees (pre-checked DOM boxes
    // don't fire change events on load).
    const decisions = new Map<string, RowDecision>();

    const rebuildPlan = async (): Promise<void> => {
      if (disposed) return;
      const myToken = ++planRunToken;
      void panel.webview.postMessage({ type: 'planStatus', status: 'scanning' });
      try {
        const placeholders = await getActivePlaceholderSet();
        const plans = await buildDryRunPlan(this.manager.getTopology(), { placeholders });
        if (disposed || myToken !== planRunToken) return; // stale
        lastPlans = plans;
        // Per the comment on `decisions` above: plan IDs may have shifted, so
        // start from empty. The webview's checkboxes re-arm any remembered
        // rows on render; seed the Map to match.
        decisions.clear();
        const seeded = seedRememberedDecisions(plans, decisions);
        if (seeded > 0) {
          log(`admin-editor: seeded ${seeded} remembered decision(s) from plan`);
        }
        void postPlanResult(panel, plans, (_totals, hasWork) => {
          lastPlanHasWork = hasWork;
        });
      } catch (err) {
        if (disposed || myToken !== planRunToken) return;
        const message = err instanceof Error ? err.message : String(err);
        log(`admin-editor: plan build failed — ${message}`);
        void panel.webview.postMessage({
          type: 'planStatus',
          status: 'error',
          error: message,
        });
      }
    };

    const schedulePlan = (): void => {
      if (planTimer) clearTimeout(planTimer);
      planTimer = setTimeout(() => {
        planTimer = undefined;
        void rebuildPlan();
      }, PLAN_DEBOUNCE_MS);
    };

    schedulePlan();

    // Re-render when the document text changes (the snapshot writer rewrites
    // the file on every topology event). We never edit the document from
    // this editor, so there's no own-edit to suppress.
    const docSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      const vm = buildViewModel(document, this.store);
      void panel.webview.postMessage({ type: 'docChanged', payload: vm });
    });

    // Workspace folder changes — affect both the folder list AND the plan
    // (new destinations become reachable, removed sources stop appearing).
    const folderSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      schedulePlan();
    });

    // Topology changes (manager reload after a .sync.jsonc edit, workspace
    // folder changes). The manager fires once on subscribe — suppress that
    // first emit so we don't duplicate the schedulePlan() call above.
    let firstTopologyEmit = true;
    const topologySub = this.manager.onDidChange(() => {
      if (firstTopologyEmit) {
        firstTopologyEmit = false;
        return;
      }
      schedulePlan();
    });

    panel.onDidDispose(() => {
      disposed = true;
      if (planTimer) clearTimeout(planTimer);
      docSub.dispose();
      folderSub.dispose();
      topologySub.dispose();
    });

    panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      try {
        if (msg.type === 'decision') {
          // Validate + apply via the shared pure helper. Log lines use the
          // admin-editor prefix so the channel makes the source obvious.
          handleDecisionMessage(msg, decisions, (line) =>
            log(`admin-editor: ${line}`),
          );
          return;
        }
        if (msg.type === 'renameFolder') {
          await this.renameFolder(msg.index, msg.name);
        } else if (msg.type === 'addPlaceholderFromSample') {
          await this.addPlaceholderFromSample(document);
        } else if (msg.type === 'removePlaceholder') {
          await this.removePlaceholder(document, msg.sha256);
        } else if (msg.type === 'refreshSnapshot') {
          await this.refreshSnapshot(panel, document);
          // Also kick off a plan rebuild — the snapshot capture itself doesn't
          // change topology, but the user clicking Refresh signals they want
          // the most current view of everything on the page.
          schedulePlan();
        } else if (msg.type === 'clearSnapshot') {
          await vscode.commands.executeCommand('folderSync.clearSnapshot');
        } else if (msg.type === 'openAsText') {
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
        } else if (msg.type === 'refreshPlan') {
          // Bypass the debounce — user-initiated refresh.
          if (planTimer) {
            clearTimeout(planTimer);
            planTimer = undefined;
          }
          void rebuildPlan();
        } else if (msg.type === 'runSync') {
          if (syncInFlight) return;
          // No blocking-guard: when collisions/warnings are present the
          // webview only enables the orange "safe items only" button, which
          // posts the same `runSync` message. The executor honours whatever
          // decisions the user has armed; un-armed collisions, warned items,
          // and destination-only files skip naturally. Green path + orange
          // path land here identically — the only difference is what's in
          // the `decisions` map at this point.
          if (!lastPlanHasWork) {
            log('admin-editor: runSync ignored — nothing to do');
            return;
          }
          syncInFlight = true;
          try {
            log(
              `admin-editor: runSync — ${countAccepted(decisions)} armed override(s)`,
            );
            await runSyncFromAdmin(panel, lastPlans, decisions);
          } finally {
            syncInFlight = false;
            // Refresh the plan post-run — the manifest changes mean the next
            // plan will show "Skip (unchanged)" for things we just placed.
            schedulePlan();
          }
        }
      } catch (err) {
        log(
          `admin-editor: message handler failed (${msg.type}) — ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    });
  }

  private renderFor(document: vscode.TextDocument): string {
    const vm = buildViewModel(document, this.store);
    return renderAdminEditorHtml(vm, makeNonce());
  }

  private async renameFolder(index: number, newName: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (index < 0 || index >= folders.length) {
      log(`admin-editor: renameFolder index=${index} out of range (n=${folders.length})`);
      return;
    }
    const folder = folders[index];
    if (folder.name === newName) {
      log(`admin-editor: renameFolder index=${index} no-op (name unchanged)`);
      return;
    }
    log(`admin-editor: renameFolder index=${index} "${folder.name}" → "${newName}"`);
    // updateWorkspaceFolders with the replace overload: (start, deleteCount, ...newFolders)
    const ok = vscode.workspace.updateWorkspaceFolders(index, 1, {
      uri: folder.uri,
      name: newName,
    });
    log(`admin-editor: updateWorkspaceFolders(${index}, 1, …) returned ${ok}`);
    // The snapshot writer fires off the resulting onDidChangeWorkspaceFolders
    // event and rewrites the file. The doc change then posts `docChanged` to
    // the webview through our docSub above.
  }

  private async refreshSnapshot(
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument,
  ): Promise<void> {
    log('admin-editor: refresh requested');
    const captured = await captureAndWriteSnapshot(this.store);
    if (!captured) {
      void vscode.window.showWarningMessage(
        'Cannot refresh snapshot — no workspace folders open.',
      );
      return;
    }
    void vscode.window.showInformationMessage(
      `Snapshot refreshed — ${captured.folders.length} folder(s).`,
    );
    // The atomic write fires onDidChangeTextDocument which re-posts the VM.
    // Also push a fresh VM directly in case the doc-change event lags.
    const vm = buildViewModel(document, this.store);
    void panel.webview.postMessage({ type: 'docChanged', payload: vm });
  }

  /**
   * Pick a sample file via showOpenDialog, hash it, and append its sha256 to
   * the placeholders array (deduped, lowercase). The empty-file sha is
   * already implicit so we surface a hint and bail when the picked file is
   * zero bytes.
   */
  private async addPlaceholderFromSample(document: vscode.TextDocument): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Pick placeholder sample',
      filters: { 'PowerPoint': ['pptx', 'ppt'], 'All files': ['*'] },
    });
    if (!picked || picked.length === 0) return;
    const uri = picked[0];
    log(`admin-editor: hashing placeholder sample ${uri.toString()}`);

    let sha256: string;
    try {
      const result = await hashFileAtUri(vscodeFs(), uri, undefined, { needBytes: false });
      sha256 = result.sha256;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`admin-editor: hash failed — ${message}`);
      void vscode.window.showErrorMessage(`Could not hash sample: ${message}`);
      return;
    }

    if (sha256 === EMPTY_FILE_SHA256) {
      void vscode.window.showInformationMessage(
        'Zero-byte files are placeholders by default; no entry needed.',
      );
      return;
    }

    await this.mutatePlaceholders(document, (current) => {
      const next = new Set(current.map((s) => s.toLowerCase()));
      next.add(sha256.toLowerCase());
      return [...next];
    }, `added ${sha256.slice(0, 12)}…`);
  }

  /**
   * Remove a sha from the placeholders array. The locked default sha is not
   * in the on-disk array, so an attempt to remove it just doesn't find a
   * match (no-op) — the lock is a UI property only.
   */
  private async removePlaceholder(
    document: vscode.TextDocument,
    sha256: string,
  ): Promise<void> {
    const target = sha256.toLowerCase();
    await this.mutatePlaceholders(document, (current) => {
      return current.filter((s) => s.toLowerCase() !== target);
    }, `removed ${target.slice(0, 12)}…`);
  }

  /**
   * Read the current document text, run a mutation on the placeholders
   * array, marshal a fresh snapshot, and write through the store. Routes
   * through writeSnapshot's open-document path (applyEdit + save) so this
   * editor panel stays alive across the rewrite.
   */
  private async mutatePlaceholders(
    document: vscode.TextDocument,
    mutate: (current: string[]) => string[],
    logSummary: string,
  ): Promise<void> {
    const text = document.getText();
    const { snapshot, errors } = parseSnapshot(text);
    for (const e of errors) log(`admin-editor: parse warning during placeholder mutation — ${e}`);
    const next: Snapshot = {
      ...snapshot,
      placeholders: mutate(snapshot.placeholders),
      capturedAt: new Date().toISOString(),
    };
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showWarningMessage('No workspace folders open — cannot write snapshot.');
      return;
    }
    const targetFolderUri = folders[0].uri;
    try {
      const finalUri = await this.store.writeSnapshot(targetFolderUri, next);
      await this.store.setPointer({
        uri: finalUri.toString(),
        lastWriteAt: next.capturedAt,
      });
      log(`admin-editor: placeholders ${logSummary} (now ${next.placeholders.length} entr${next.placeholders.length === 1 ? 'y' : 'ies'})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`admin-editor: placeholder write FAILED — ${message}`);
      void vscode.window.showErrorMessage(`Could not write snapshot: ${message}`);
    }
  }
}

// ───── helpers ─────────────────────────────────────────────────────────

type WebviewMessage =
  | { type: 'renameFolder'; index: number; name: string }
  | { type: 'refreshSnapshot' }
  | { type: 'clearSnapshot' }
  | { type: 'openAsText' }
  | { type: 'refreshPlan' }
  | { type: 'runSync' }
  | { type: 'addPlaceholderFromSample' }
  | { type: 'removePlaceholder'; sha256: string }
  | { type: 'decision'; id?: unknown; kind?: unknown; relPath?: unknown; accepted?: unknown; remember?: unknown };

function buildViewModel(document: vscode.TextDocument, store: SnapshotStore): AdminEditorViewModel {
  const text = document.getText();
  const { snapshot, errors } = parseSnapshot(text);
  const pointer = store.getPointer();
  return {
    folders: snapshot.folders.map((f) => ({ uri: f.uri, name: f.name })),
    settings: summariseSettings(snapshot),
    placeholders: buildPlaceholderRows(snapshot),
    capturedAt: snapshot.capturedAt,
    pointerInfo: pointer ? { uri: pointer.uri, lastWriteAt: pointer.lastWriteAt } : null,
    parseError: errors.length > 0 ? errors.join('; ') : null,
  };
}

/**
 * Locked default first, then user entries. The locked row is a UI property
 * only — the empty-file sha is not stored in `snapshot.placeholders`, which
 * means a stray remove of EMPTY_FILE_SHA256 naturally no-ops (the filter
 * doesn't find it on disk).
 */
function buildPlaceholderRows(snapshot: Snapshot): PlaceholderRow[] {
  const rows: PlaceholderRow[] = [
    { sha256: EMPTY_FILE_SHA256, locked: true, label: '(default — zero-byte file)' },
  ];
  for (const sha of snapshot.placeholders) {
    rows.push({ sha256: sha.toLowerCase(), locked: false });
  }
  return rows;
}

function summariseSettings(snapshot: Snapshot): AdminEditorSettingSummary[] {
  return Object.keys(snapshot.settings)
    .sort()
    .map((key) => ({
      key,
      valueSummary: valueSummary(snapshot.settings[key]),
      unknown: !KNOWN_WORKSPACE_KEYS.includes(key),
    }));
}

function valueSummary(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length} item(s)]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).length} key(s)}`;
  return JSON.stringify(v);
}

/**
 * Build the totals + pairs HTML from the planner output and post it to the
 * webview. The `gate` callback receives the totals and a hasWork flag so the
 * caller can stash them for Run Sync's eligibility check.
 */
function postPlanResult(
  panel: vscode.WebviewPanel,
  plans: PlanForDestination[],
  gate: (totals: PlanTotals, hasWork: boolean) => void,
): Thenable<boolean> {
  // M5.1: this editor now collects per-row decisions over the existing
  // panel message channel (the webview posts {type:'decision', ...}; the
  // wired side stores them and threads them into runSync). The standalone
  // plan webview remains the place for bulk review, but routine
  // overwrite / delete / "Sync anyway" arming works here too.
  const vm = toViewModel(
    plans,
    (plan) => {
      const rel = vscode.workspace.asRelativePath(plan.source.sourceFolderUri, false);
      return rel || plan.source.sourceFolderUri.toString();
    },
    { interactive: true },
  );
  const t = vm.totals;
  const chipsHtml = renderPlanChips(t);
  const pairsHtml = renderPlanPairs(vm);
  const empty = vm.pairs.length === 0;
  const hasWork = t.create + t.updateTracked + t.deleteTracked + t.updateCollision > 0;
  const blocking = t.updateCollision + t.warnings;
  gate(t, hasWork);
  return panel.webview.postMessage({
    type: 'planStatus',
    status: 'ready',
    chipsHtml,
    pairsHtml,
    empty,
    totals: t,
    hasWork,
    blocking,
  });
}

/**
 * Run the green-path sync from inside the admin editor. Mirrors planView's
 * `runProceed` notification UX — total success / partial / manifest-failure
 * messages — but keeps the panel open so the user can continue working.
 */
async function runSyncFromAdmin(
  panel: vscode.WebviewPanel,
  plans: PlanForDestination[],
  decisions: ReadonlyMap<string, RowDecision>,
): Promise<void> {
  log('admin-editor: runSync — starting execution');
  void panel.webview.postMessage({ type: 'syncStatus', status: 'running' });

  let summary;
  try {
    summary = await runSync(plans, decisions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`admin-editor: sync execution threw — ${message}`);
    void vscode.window.showErrorMessage(`Folder Sync: execution failed — ${message}`);
    void panel.webview.postMessage({ type: 'syncStatus', status: 'error', error: message });
    return;
  }

  for (const line of formatRunSummary(summary).split('\n')) log(line);

  const total = summary.ok + summary.failed;
  if (summary.failed === 0 && summary.manifestWriteFailures.length === 0) {
    if (total === 0) {
      void vscode.window.showInformationMessage('Folder Sync: nothing to do.');
    } else {
      void vscode.window.showInformationMessage(`Folder Sync: ${summary.ok} operation(s) completed.`);
    }
  } else if (summary.failed > 0) {
    void vscode.window
      .showWarningMessage(
        `Folder Sync: ${summary.ok} succeeded, ${summary.failed} failed.`,
        'Show details',
      )
      .then((choice) => {
        if (choice === 'Show details') {
          void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
        }
      });
  } else {
    void vscode.window.showWarningMessage(
      `Folder Sync: files placed, but ${summary.manifestWriteFailures.length} manifest write(s) failed. ` +
        `Re-run will re-detect these as already-placed-but-untracked files.`,
    );
  }

  void panel.webview.postMessage({
    type: 'syncStatus',
    status: 'done',
    ok: summary.ok,
    failed: summary.failed,
    manifestFailures: summary.manifestWriteFailures.length,
  });
}

function makeNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
