// Webview panel lifecycle for the M3 plan view.
//
// The pure rendering half lives in `planHtml.ts` so it can be smoke-tested
// under plain Node alongside the other sync tests. This module is the
// vscode-touching wrapper: it builds the plan, opens a panel, wires Cancel.

import * as vscode from 'vscode';
import type { PlanForDestination } from './planner';
import { buildDryRunPlan } from './planner';
import type { ResolvedTopology } from './topology';
import { renderPlanHtml, toViewModel } from './planHtml';
import { runSync, formatRunSummary } from './runSync';
import {
  countAccepted,
  handleDecisionMessage,
  seedRememberedDecisions,
  type RowDecision,
} from './decisions';
import { log } from '../log';

/**
 * Open the plan webview against the current topology. Builds the dry-run
 * plan, opens a single column-active webview panel, wires Cancel to dispose.
 * The panel is recreated on each invocation — there's no caching for v1, the
 * plan is cheap to rebuild and the user benefits from the freshest state.
 */
export async function openPlanPanel(topology: ResolvedTopology): Promise<void> {
  log('sync: openPlan invoked');
  let plans: PlanForDestination[] = [];
  try {
    plans = await buildDryRunPlan(topology);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`sync: openPlan failed to build plan — ${message}`);
    void vscode.window.showErrorMessage(`Folder Sync: could not build plan — ${message}`);
    return;
  }

  const vm = toViewModel(plans, (plan) => {
    const rel = vscode.workspace.asRelativePath(plan.source.sourceFolderUri, false);
    return rel || plan.source.sourceFolderUri.toString();
  });

  const panel = vscode.window.createWebviewPanel(
    'folderSync.plan',
    'Folder Sync — plan',
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    {
      enableScripts: true,
      // The plan webview holds no persistent state worth retaining — the
      // user re-opens it when they want a fresh plan.
      retainContextWhenHidden: false,
    },
  );

  // Lock prevents double-proceed if the user clicks fast or the webview
  // misbehaves. Once a proceed is in flight, we ignore subsequent messages.
  let inFlight = false;

  // M5 Phase B: per-row decisions captured in-memory as the user toggles
  // checkboxes. The key is the decision id emitted by the renderer
  // (`${pairIndex}:${kind}:${relPath}`), which is stable for the lifetime
  // of this panel — exactly what we need for an in-memory map. Phase C
  // reads from here when wiring decisions into the executor + manifest.
  // Seed from `remembered.accepted` items so pre-checked DOM checkboxes
  // (which don't fire change events on load) still appear as armed when
  // Proceed runs the executor.
  const decisions = new Map<string, RowDecision>();
  const seeded = seedRememberedDecisions(plans, decisions);
  if (seeded > 0) log(`sync: seeded ${seeded} remembered decision(s) from plan`);

  panel.webview.onDidReceiveMessage(async (msg: unknown) => {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: unknown };
    if (m.type === 'cancel') {
      if (inFlight) return;
      log('sync: plan cancelled by user');
      panel.dispose();
      return;
    }
    if (m.type === 'proceed') {
      if (inFlight) return;
      inFlight = true;
      await runProceed(panel, plans, decisions);
      return;
    }
    if (m.type === 'decision') {
      handleDecisionMessage(msg, decisions, (line) => log(`sync: ${line}`));
      return;
    }
  });

  const nonce = makeNonce();
  panel.webview.html = renderPlanHtml(vm, nonce);
  log(
    `sync: plan rendered — ${vm.pairs.length} pair(s), ` +
      `create ${vm.totals.create}, update-tracked ${vm.totals.updateTracked}, ` +
      `collisions ${vm.totals.updateCollision}, skip ${vm.totals.skip}, ` +
      `delete-tracked ${vm.totals.deleteTracked}, destination-only ${vm.totals.destinationOnly}, ` +
      `warnings ${vm.totals.warnings}, skipped-pairs ${vm.totals.skipped}`,
  );
}

function makeNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Run the green-path sync, surface results to the user, and dispose the
 * panel. The webview footer's script disables both buttons as soon as
 * proceed is clicked, so this function doesn't need to push interim UI
 * state — a single status post just before sync begins is plenty.
 */
async function runProceed(
  panel: vscode.WebviewPanel,
  plans: PlanForDestination[],
  decisions: ReadonlyMap<string, RowDecision>,
): Promise<void> {
  const armedCount = countAccepted(decisions);
  log(`sync: proceed — starting execution (${armedCount} armed override(s))`);
  void panel.webview.postMessage({ type: 'status', label: 'Syncing\u2026' });

  let summary;
  try {
    summary = await runSync(plans, decisions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`sync: execution threw — ${message}`);
    void vscode.window.showErrorMessage(`Folder Sync: execution failed — ${message}`);
    panel.dispose();
    return;
  }

  for (const line of formatRunSummary(summary).split('\n')) log(line);

  // Notification phrasing tracks the three outcomes the user cares about:
  // total success, partial success (some failures), or manifest-only trouble
  // (files placed but tracking failed). Manifest failures are surfaced
  // separately because they have a different remediation path.
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

  panel.dispose();
}
