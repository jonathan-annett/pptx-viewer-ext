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

  panel.webview.onDidReceiveMessage((msg: unknown) => {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: unknown };
    if (m.type === 'cancel') {
      log('sync: plan cancelled by user');
      panel.dispose();
    }
  });

  const nonce = makeNonce();
  panel.webview.html = renderPlanHtml(vm, nonce);
  log(
    `sync: plan rendered — ${vm.pairs.length} pair(s), ` +
      `create ${vm.totals.create}, update-tracked ${vm.totals.updateTracked}, ` +
      `collisions ${vm.totals.updateCollision}, skip ${vm.totals.skip}, ` +
      `delete-tracked ${vm.totals.deleteTracked}, destination-only ${vm.totals.destinationOnly}, ` +
      `skipped-pairs ${vm.totals.skipped}`,
  );
}

function makeNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
