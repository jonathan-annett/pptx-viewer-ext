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
    // builds when a fresh trigger arrives mid-walk.
    let planTimer: ReturnType<typeof setTimeout> | undefined;
    let planRunToken = 0;
    let disposed = false;

    const rebuildPlan = async (): Promise<void> => {
      if (disposed) return;
      const myToken = ++planRunToken;
      void panel.webview.postMessage({ type: 'planStatus', status: 'scanning' });
      try {
        const plans = await buildScopedDryRunPlan(this.manager.getTopology(), {
          sourceConfigUri: document.uri,
        });
        if (disposed || myToken !== planRunToken) return; // stale
        void postPlanResult(panel, plans);
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

    // Workspace folder changes affect the dropdown options.
    const folderSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void panel.webview.postMessage({
        type: 'folderNamesChanged',
        workspaceFolderNames: currentFolderNames(),
      });
      schedulePlan();
    });

    // Topology changes (manager reload after save, workspace folder changes,
    // .sync.jsonc on disk changes). The manager fires once on subscribe so
    // we get the initial build for free — but we already scheduled above,
    // so suppress the synchronous first call to avoid a duplicate run.
    let firstTopologyEmit = true;
    const topologySub = this.manager.onDidChange(() => {
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
        workspaceFolderNames: currentFolderNames(),
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
  | { type: 'openAsText' };

function emptyConfig(): SyncConfig {
  return { destinations: [], include: [], exclude: [] };
}

function currentFolderNames(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.name);
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
 */
function postPlanResult(panel: vscode.WebviewPanel, plans: PlanForDestination[]): Thenable<boolean> {
  const vm = toViewModel(plans, (plan) => {
    const rel = vscode.workspace.asRelativePath(plan.source.sourceFolderUri, false);
    return rel || plan.source.sourceFolderUri.toString();
  });
  const totals: PlanTotals = vm.totals;
  const chipsHtml = renderPlanChips(totals);
  const pairsHtml = renderPlanPairs(vm);
  // The "empty" condition is meaningfully different in the room-scoped view:
  // an unresolved or unconfigured source produces zero pairs. The webview
  // renders this state with a hint, so let it know explicitly.
  const empty = vm.pairs.length === 0;
  return panel.webview.postMessage({
    type: 'planStatus',
    status: 'ready',
    chipsHtml,
    pairsHtml,
    empty,
    totals,
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
