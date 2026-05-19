// vscode-wired half of the .sync.jsonc custom text editor.
//
// Pairs with the pure renderer in configEditorHtml.ts. This module:
//   - Registers the CustomTextEditorProvider
//   - Maintains the webview ↔ TextDocument loop
//   - Serialises form edits back into the document via jsonc-parser's
//     modification API (preserves comments + formatting)
//   - Builds and posts an embedded, room-scoped dry-run plan into the
//     panel — auto-runs on open, on document save (via the manager's
//     reload), and on file-tree changes inside the source folder. The
//     "Open workspace-wide plan" button stays so the user can still
//     escape to the full plan panel.
//
// The user can still open the file as raw text via the "Reopen with…" command,
// which is why the editor has a `Reopen as text` button — handy when the
// form's affordances aren't enough.

import * as vscode from 'vscode';
import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser';
import { parseSyncConfigText, type SyncConfig } from './configParse';
import { renderConfigEditorHtml } from './configEditorHtml';
import {
  renderPlanChips,
  renderPlanPairs,
  toViewModel,
  type PlanTotals,
} from './planHtml';
import type { PlanForDestination } from './planner';
import { buildScopedDryRunPlan } from './planner';
import { runSync, formatRunSummary } from './runSync';
import type { SyncManager } from './manager';
import { log } from '../log';

const VIEW_TYPE = 'folderSync.configEditor';

const FORMATTING: FormattingOptions = {
  tabSize: 2,
  insertSpaces: true,
  eol: '\n',
};

/** Debounce window for plan rebuilds after document or file-tree edits. */
const PLAN_DEBOUNCE_MS = 500;

export class SyncConfigEditorProvider implements vscode.CustomTextEditorProvider {
  static register(manager: SyncManager): vscode.Disposable {
    const provider = new SyncConfigEditorProvider(manager);
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      // Keep the form's local state across hide/show so the user doesn't lose
      // unfocused-but-typed input. The form is cheap; this is mostly defensive.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  constructor(private readonly manager: SyncManager) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = this.renderFor(document);
    log(`sync-config-editor: opened ${document.uri.toString()}`);

    // ───── plan state + scheduler ─────────────────────────────────────
    // Each editor instance owns its own debounced rebuild + in-flight token
    // so two open editors don't fight each other. The token cancels stale
    // builds when a fresh trigger arrives mid-walk. The most recent plan is
    // stashed so Run Sync can hand it to runSync() without re-walking — same
    // pattern as the admin editor (which uses the workspace-wide plan).
    let planTimer: ReturnType<typeof setTimeout> | undefined;
    let planRunToken = 0;
    let lastPlans: PlanForDestination[] = [];
    let lastPlanHasWork = false;
    let disposed = false;
    let syncInFlight = false;

    const rebuildPlan = async (): Promise<void> => {
      if (disposed) return;
      const myToken = ++planRunToken;
      void panel.webview.postMessage({ type: 'planStatus', status: 'scanning' });
      try {
        const plans = await buildScopedDryRunPlan(this.manager.getTopology(), {
          sourceConfigUri: document.uri,
        });
        if (disposed || myToken !== planRunToken) return; // stale
        lastPlans = plans;
        void postPlanResult(panel, plans, (_totals, hasWork) => {
          lastPlanHasWork = hasWork;
        });
      } catch (err) {
        if (disposed || myToken !== planRunToken) return;
        const message = err instanceof Error ? err.message : String(err);
        log(`sync-config-editor: plan build failed — ${message}`);
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

    // Kick off the initial plan after the webview has had a chance to
    // initialise (otherwise the postMessage races the page script). The
    // small delay is the same debounce we use for edits — happy coincidence.
    schedulePlan();

    // ───── change subscriptions ───────────────────────────────────────
    // Re-render the webview when the document changes from another source
    // (raw-text edit in a split, external write). We DO NOT re-render after
    // our own edits — the form already reflects them.
    let suppressNextDocChange = false;
    const docSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (suppressNextDocChange) {
        suppressNextDocChange = false;
      } else {
        const parsed = parseSyncConfigText(document.getText());
        void panel.webview.postMessage({
          type: 'docChanged',
          config: parsed.kind === 'ok' ? parsed.config : emptyConfig(),
          parseError: parsed.kind === 'error' ? parsed.error : null,
        });
      }
      // Either way, the user's intent may affect the plan once the doc
      // is saved (or via the in-memory topology if we wire that later).
      // For v1 the trigger that matters is save → manager reloads → topology
      // changes → rebuildPlan via the manager subscription below. Debounced
      // doc-change re-runs are a no-op for plans pre-save but cost nothing.
      schedulePlan();
    });

    // Shared posting of dropdown-eligibility state — used by both the
    // workspace-folders change and the topology change subscriptions, since
    // either can shift what's a legal destination for this room.
    const postEligibility = (): void => {
      void panel.webview.postMessage({
        type: 'workspaceFoldersChanged',
        workspaceFolders: currentFolderEntries(),
        sourceFolderUri: sourceFolderUriFor(document.uri),
        claimedElsewhere: claimedByOtherSources(this.manager, document.uri),
      });
    };

    // Workspace folder changes affect the dropdown options.
    const folderSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      postEligibility();
      schedulePlan();
    });

    // Topology changes (manager reload after save, workspace folder changes,
    // .sync.jsonc on disk changes). The manager fires once on subscribe so
    // we get the initial build for free — but we already scheduled above,
    // so suppress the synchronous first call to avoid a duplicate run.
    //
    // We DO post eligibility on every topology change though (including the
    // first emit), because a sibling .sync.jsonc just being created or
    // edited can shift `claimedElsewhere` for this room.
    let firstTopologyEmit = true;
    const topologySub = this.manager.onDidChange(() => {
      postEligibility();
      if (firstTopologyEmit) {
        firstTopologyEmit = false;
        return;
      }
      schedulePlan();
    });

    // File-tree watcher inside the source folder — picks up drops, adds,
    // deletes, renames. Pattern is `**/*` so we catch nested changes too.
    // RelativePattern accepts a URI directly (per the API docs); workspace
    // folder URIs work the same way. Watcher coverage over FSA folders in
    // vscode.dev has historically been spotty (see folder-sync-v1-plan.md
    // open design questions) — the Refresh button is the always-works
    // backstop.
    const sourceFolderUri = parentUri(document.uri);
    const fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(sourceFolderUri, '**/*'),
    );
    const fileTrigger = (uri: vscode.Uri): void => {
      // Ignore self — the doc-change subscription already handles config
      // edits, and the manifest live-write must not loop us.
      const s = uri.toString();
      if (s === document.uri.toString()) return;
      if (s.endsWith('/.foldersync-manifest.json')) return;
      schedulePlan();
    };
    fileWatcher.onDidCreate(fileTrigger);
    fileWatcher.onDidChange(fileTrigger);
    fileWatcher.onDidDelete(fileTrigger);

    panel.onDidDispose(() => {
      disposed = true;
      if (planTimer) clearTimeout(planTimer);
      docSub.dispose();
      folderSub.dispose();
      topologySub.dispose();
      fileWatcher.dispose();
    });

    panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      try {
        if (msg.type === 'setConfig') {
          const newText = serialiseConfig(document.getText(), msg.config);
          if (newText === document.getText()) return;
          suppressNextDocChange = true;
          const edit = new vscode.WorkspaceEdit();
          const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length),
          );
          edit.replace(document.uri, fullRange, newText);
          const applied = await vscode.workspace.applyEdit(edit);
          if (!applied) {
            suppressNextDocChange = false;
            log('sync-config-editor: applyEdit rejected');
          }
        } else if (msg.type === 'openWorkspacePlan') {
          // Open the workspace-wide plan in a separate panel — the embedded
          // section above is room-scoped. Relabelled from "Dry run" so the
          // scope distinction is explicit.
          void vscode.commands.executeCommand('folderSync.openPlan');
        } else if (msg.type === 'refreshPlan') {
          // Manual refresh — bypasses the debounce in case the user wants
          // an immediate rebuild after a change the watcher missed.
          if (planTimer) {
            clearTimeout(planTimer);
            planTimer = undefined;
          }
          void rebuildPlan();
        } else if (msg.type === 'openAsText') {
          // Reopen the same document with the default text editor.
          await vscode.commands.executeCommand(
            'vscode.openWith',
            document.uri,
            'default',
          );
        } else if (msg.type === 'runSync') {
          // Room-scoped Run Sync — same machinery as the admin editor's, but
          // the stashed `lastPlans` is the room's plan (filtered to this
          // .sync.jsonc's destinations), so only this room's work runs.
          //
          // No blocking-guard: when collisions/warnings are present the
          // webview only enables the orange "safe items only" button, which
          // posts the same `runSync` message. `runSyncFromConfig` calls
          // `executePlan` with no decided overwrites/deletes, so the
          // executor naturally skips collisions, destination-only, and
          // warned items. Green path + orange path land here identically.
          if (syncInFlight) return;
          if (!lastPlanHasWork) {
            log('sync-config-editor: runSync ignored — nothing to do');
            return;
          }
          syncInFlight = true;
          try {
            await runSyncFromConfig(panel, lastPlans);
          } finally {
            syncInFlight = false;
            // Refresh the plan post-run — the manifest changes mean the next
            // plan will show "Skip (unchanged)" for things we just placed.
            schedulePlan();
          }
        }
      } catch (err) {
        log(
          `sync-config-editor: message handler failed (${msg.type}) — ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    });
  }

  private renderFor(document: vscode.TextDocument): string {
    const parsed = parseSyncConfigText(document.getText());
    const config = parsed.kind === 'ok' ? parsed.config : emptyConfig();
    const parseError = parsed.kind === 'error' ? parsed.error : null;
    return renderConfigEditorHtml(
      {
        initialConfig: config,
        workspaceFolders: currentFolderEntries(),
        sourceFolderUri: sourceFolderUriFor(document.uri),
        claimedElsewhere: claimedByOtherSources(this.manager, document.uri),
        parseError,
      },
      makeNonce(),
    );
  }
}

// ───── helpers ─────────────────────────────────────────────────────────

type WebviewMessage =
  | { type: 'setConfig'; config: SyncConfig }
  | { type: 'openWorkspacePlan' }
  | { type: 'refreshPlan' }
  | { type: 'openAsText' }
  | { type: 'runSync' };

function emptyConfig(): SyncConfig {
  return { destinations: [], include: [], exclude: [] };
}

function currentFolderEntries(): Array<{ uri: string; name: string }> {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => ({
    uri: f.uri.toString(),
    name: f.name,
  }));
}

/**
 * URI of the workspace folder containing `documentUri`, as a string. Returns
 * null when the document isn't inside any open workspace folder (the editor
 * was opened on a detached URI, or the folder was just removed). The room
 * editor uses this to filter the source folder out of its destination
 * dropdown — a source cannot be its own destination.
 */
function sourceFolderUriFor(documentUri: vscode.Uri): string | null {
  const folder = vscode.workspace.getWorkspaceFolder(documentUri);
  return folder ? folder.uri.toString() : null;
}

/**
 * Set of destination URIs already claimed by sources OTHER than the one
 * whose document URI is `currentDocUri`. Used to filter the room editor's
 * destination dropdown so two `.sync.jsonc` files can't claim the same
 * workspace folder (the cross-source-uniqueness invariant enforced by
 * topology.ts at load time).
 */
function claimedByOtherSources(
  manager: SyncManager,
  currentDocUri: vscode.Uri,
): string[] {
  const claimed = new Set<string>();
  const self = currentDocUri.toString();
  for (const src of manager.getTopology().sources) {
    if (src.configUri.toString() === self) continue;
    for (const dest of src.destinations) claimed.add(dest.uri);
  }
  return Array.from(claimed);
}

function parentUri(uri: vscode.Uri): vscode.Uri {
  const path = uri.path;
  const idx = path.lastIndexOf('/');
  const parent = idx <= 0 ? '/' : path.slice(0, idx);
  return uri.with({ path: parent });
}

/**
 * Build the totals + pairs HTML from the planner output and post it to the
 * webview. The webview side swaps the chip/pair containers' innerHTML — the
 * CSP allows HTML insertion without script execution.
 *
 * The `gate` callback receives totals + a hasWork flag so the caller can stash
 * them for Run Sync's eligibility check — same shape as the admin editor's
 * postPlanResult so the two stay symmetric.
 */
function postPlanResult(
  panel: vscode.WebviewPanel,
  plans: PlanForDestination[],
  gate: (totals: PlanTotals, hasWork: boolean) => void,
): Thenable<boolean> {
  // Embedded read-only view: no message channel back from this panel to
  // collect per-row decisions, so suppress the decision checkboxes that
  // the standalone plan webview emits.
  const vm = toViewModel(
    plans,
    (plan) => {
      const rel = vscode.workspace.asRelativePath(plan.source.sourceFolderUri, false);
      return rel || plan.source.sourceFolderUri.toString();
    },
    { interactive: false },
  );
  const totals: PlanTotals = vm.totals;
  const chipsHtml = renderPlanChips(totals);
  const pairsHtml = renderPlanPairs(vm);
  // The "empty" condition is meaningfully different in the room-scoped view:
  // an unresolved or unconfigured source produces zero pairs. The webview
  // renders this state with a hint, so let it know explicitly.
  const empty = vm.pairs.length === 0;
  const hasWork =
    totals.create + totals.updateTracked + totals.deleteTracked + totals.updateCollision > 0;
  const blocking = totals.updateCollision + totals.warnings;
  gate(totals, hasWork);
  return panel.webview.postMessage({
    type: 'planStatus',
    status: 'ready',
    chipsHtml,
    pairsHtml,
    empty,
    totals,
    hasWork,
    blocking,
  });
}

/**
 * Run the green-path sync from inside the room editor. Mirrors the admin
 * editor's runSyncFromAdmin — same notification UX, same lifecycle messages
 * to the webview — but scoped to this room's plans only.
 */
async function runSyncFromConfig(
  panel: vscode.WebviewPanel,
  plans: PlanForDestination[],
): Promise<void> {
  log('sync-config-editor: runSync — starting execution');
  void panel.webview.postMessage({ type: 'syncStatus', status: 'running' });

  let summary;
  try {
    summary = await runSync(plans);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`sync-config-editor: sync execution threw — ${message}`);
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
      void vscode.window.showInformationMessage(
        `Folder Sync: ${summary.ok} operation(s) completed.`,
      );
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

/**
 * Apply form values back into the JSONC text using jsonc-parser's `modify`
 * API. Each top-level key is rewritten as a whole — comments + formatting
 * around other keys (and unknown keys) are preserved.
 *
 * When the original document is empty or unparseable, we fall back to writing
 * a fresh canonical JSON document.
 */
function serialiseConfig(originalText: string, config: SyncConfig): string {
  // If the document is empty or whitespace-only, start from a clean template.
  if (originalText.trim() === '') {
    return canonicalSerialise(config) + '\n';
  }

  let text = originalText;
  text = applyEdits(text, modify(text, ['destinations'], config.destinations, {
    formattingOptions: FORMATTING,
  }));

  // For include/exclude, modify against an empty array means "remove the key"
  // if it's already empty — actually no: jsonc-parser writes the empty array.
  // We want a slightly cleaner behaviour: if the array is empty AND the key
  // wasn't present originally, don't add it. Detect via a quick parse.
  text = setOrRemoveArray(text, 'include', config.include);
  text = setOrRemoveArray(text, 'exclude', config.exclude);

  return text;
}

function setOrRemoveArray(text: string, key: string, value: string[]): string {
  if (value.length === 0) {
    // If the key exists in the doc, write [] so the user sees the field. If
    // it doesn't exist, leave it absent. parseSyncConfigText treats missing
    // and [] the same.
    const parsed = parseSyncConfigText(text);
    const hadKey = parsed.kind === 'ok' && currentlyHasKey(text, key);
    if (!hadKey) return text;
  }
  return applyEdits(text, modify(text, [key], value, { formattingOptions: FORMATTING }));
}

/**
 * Cheap check for whether a top-level key is present in the doc. Uses the
 * jsonc parser's text-level output rather than re-parsing into a tree; good
 * enough for the v1 shape (no nested keys with the same name to worry about).
 */
function currentlyHasKey(text: string, key: string): boolean {
  // Match `"key"` followed by `:` allowing whitespace. Anchored to a position
  // that's not preceded by a `\` (defensive against escaped quotes — not
  // strictly possible for the keys we care about, but safe).
  const re = new RegExp(`(^|[^\\\\])"${escapeRegex(key)}"\\s*:`, 'm');
  return re.test(text);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canonicalSerialise(config: SyncConfig): string {
  // Compact-ish JSON with the canonical key order used in samples.
  const out: Record<string, unknown> = { destinations: config.destinations };
  if (config.include.length > 0) out.include = config.include;
  if (config.exclude.length > 0) out.exclude = config.exclude;
  return JSON.stringify(out, null, 2);
}

function makeNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
