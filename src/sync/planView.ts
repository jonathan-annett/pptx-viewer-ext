// Webview panel lifecycle for the M3 plan view.
//
// The pure rendering half lives in `planHtml.ts` so it can be smoke-tested
// under plain Node alongside the other sync tests. This module is the
// vscode-touching wrapper: it builds the plan, opens a panel, wires Cancel.

import * as vscode from 'vscode';
import type { PlanForDestination, ScopedPlanOptions } from './planner';
import { buildDryRunPlan, buildScopedDryRunPlan } from './planner';
import type { ResolvedTopology } from './topology';
import { renderPlanHtml, toViewModel } from './planHtml';
import { runSync, formatRunSummary, type RunSummary } from './runSync';
import { manifestUri, resolveManifestUri, readManifest, writeManifest, manifestKey } from './manifest';
import {
  countAccepted,
  handleDecisionMessage,
  seedRememberedDecisions,
  type RowDecision,
} from './decisions';
import { copyDestToSource } from './reverseFlow';
import { vscodeFs } from './vscodeFs';
import { sha256Hex } from './hash';
import { getActivePlaceholderSet } from './placeholderRegistry';
import { log } from '../log';

/** A validated `reverse-copy` message from the plan webview. */
interface ReverseCopyRequest {
  kind: 'promote' | 'copy';
  pairIndex: number;
  relPath: string;
}

function parseReverseCopyMessage(msg: unknown): ReverseCopyRequest | undefined {
  if (!msg || typeof msg !== 'object') return undefined;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'reverse-copy') return undefined;
  const kind = m.kind === 'promote' || m.kind === 'copy' ? m.kind : undefined;
  const pairIndex =
    typeof m.pairIndex === 'number' && Number.isInteger(m.pairIndex) && m.pairIndex >= 0
      ? m.pairIndex
      : undefined;
  const relPath = typeof m.relPath === 'string' ? m.relPath : undefined;
  if (!kind || pairIndex === undefined || !relPath) return undefined;
  return { kind, pairIndex, relPath };
}

/**
 * Optional scope + title for `openPlanPanel`. When `scope` is set, the panel
 * shows a single-source (and optionally path-filtered) plan via
 * `buildScopedDryRunPlan`; otherwise it falls back to the workspace-wide
 * `buildDryRunPlan`. `title` overrides the panel title — useful so the user
 * can tell "this folder" plans apart from the workspace-wide one when both
 * are open in adjacent tabs.
 */
export interface OpenPlanOptions {
  scope?: ScopedPlanOptions;
  title?: string;
}

/**
 * Open the plan webview against the current topology. Builds the dry-run
 * plan, opens a single column-active webview panel, wires Cancel to dispose.
 * The panel is recreated on each invocation — there's no caching for v1, the
 * plan is cheap to rebuild and the user benefits from the freshest state.
 *
 * M6: optional `opts.scope` routes through `buildScopedDryRunPlan` for the
 * "Sync This Folder" Explorer context-menu invocation; `opts.title` lets the
 * caller distinguish scoped panels from the workspace-wide one in the tab bar.
 */
export async function openPlanPanel(
  topology: ResolvedTopology,
  opts?: OpenPlanOptions,
): Promise<void> {
  log(
    opts?.scope
      ? `sync: openPlan invoked (scoped — source=${opts.scope.sourceConfigUri.toString()}` +
          (opts.scope.pathFilter ? `, filter=${opts.scope.pathFilter.toString()}` : '') +
          ')'
      : 'sync: openPlan invoked',
  );
  const buildPlans = async (): Promise<PlanForDestination[]> => {
    const placeholders = await getActivePlaceholderSet();
    return opts?.scope
      ? await buildScopedDryRunPlan(topology, { ...opts.scope, placeholders })
      : await buildDryRunPlan(topology, { placeholders });
  };

  // `plans` is reassigned by `refresh()` after a reverse-flow copy mutates a
  // source file — the message handler closes over the variable, so the
  // refreshed list is what Proceed/decision/reverse handlers see.
  let plans: PlanForDestination[];
  try {
    plans = await buildPlans();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`sync: openPlan failed to build plan — ${message}`);
    void vscode.window.showErrorMessage(`Folder Sync: could not build plan — ${message}`);
    return;
  }

  const labelSource = (plan: PlanForDestination): string => {
    const rel = vscode.workspace.asRelativePath(plan.source.sourceFolderUri, false);
    return rel || plan.source.sourceFolderUri.toString();
  };

  const panel = vscode.window.createWebviewPanel(
    'folderSync.plan',
    opts?.title ?? 'Folder Sync — plan',
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
  // Feature B: ids (`${pairIndex}:${relPath}`) the user opted out of via the
  // include checkboxes. Empty = include everything. Reset on every refresh.
  const excluded = new Set<string>();

  const seedDecisions = (): void => {
    decisions.clear();
    const seeded = seedRememberedDecisions(plans, decisions);
    if (seeded > 0) log(`sync: seeded ${seeded} remembered decision(s) from plan`);
  };

  // Every include-checkbox id in the current plan — the green (default-run)
  // rows. Used by the select-none master toggle to exclude them all at once.
  const allIncludableIds = (): string[] => {
    const ids: string[] = [];
    plans.forEach((plan, i) => {
      if (plan.skippedReason) return;
      for (const item of plan.items) {
        if (
          item.kind === 'create' ||
          item.kind === 'update-tracked' ||
          item.kind === 'delete-tracked'
        ) {
          ids.push(`${i}:${item.relPath}`);
        }
      }
    });
    return ids;
  };

  const render = (): void => {
    const vm = toViewModel(plans, labelSource);
    const nonce = makeNonce();
    panel.webview.html = renderPlanHtml(vm, nonce);
    log(
      `sync: plan rendered — ${vm.pairs.length} pair(s), ` +
        `create ${vm.totals.create}, update-tracked ${vm.totals.updateTracked}, ` +
        `collisions ${vm.totals.updateCollision}, skip ${vm.totals.skip}, ` +
        `delete-tracked ${vm.totals.deleteTracked}, destination-only ${vm.totals.destinationOnly}, ` +
        `warnings ${vm.totals.warnings}, skipped-pairs ${vm.totals.skipped}`,
    );
  };

  // Re-plan from disk and re-render after a reverse-flow copy changed a source
  // file. The copy made a destination's version canonical; the fresh plan
  // reclassifies the other destinations against it. Decisions + exclusions are
  // reset — the row ids may no longer mean the same thing post-reclassification.
  const refresh = async (): Promise<void> => {
    try {
      plans = await buildPlans();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`sync: re-plan after reverse-copy failed — ${message}`);
      void vscode.window.showErrorMessage(`Folder Sync: could not rebuild plan — ${message}`);
      return;
    }
    excluded.clear();
    seedDecisions();
    render();
  };

  seedDecisions();

  panel.webview.onDidReceiveMessage(async (msg: unknown) => {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: unknown; id?: unknown; included?: unknown };
    if (m.type === 'cancel') {
      if (inFlight) return;
      log('sync: plan cancelled by user');
      panel.dispose();
      return;
    }
    if (m.type === 'proceed') {
      if (inFlight) return;
      inFlight = true;
      await runProceed(panel, plans, decisions, excluded);
      return;
    }
    if (m.type === 'decision') {
      handleDecisionMessage(msg, decisions, (line) => log(`sync: ${line}`));
      return;
    }
    if (m.type === 'include') {
      // Single row toggled: maintain the excluded set (checked = included).
      const id = typeof m.id === 'string' ? m.id : undefined;
      const included = typeof m.included === 'boolean' ? m.included : undefined;
      if (id !== undefined && included !== undefined) {
        if (included) excluded.delete(id);
        else excluded.add(id);
      }
      return;
    }
    if (m.type === 'include-all') {
      const included = typeof m.included === 'boolean' ? m.included : true;
      excluded.clear();
      if (!included) for (const id of allIncludableIds()) excluded.add(id);
      log(`sync: include-all ${included ? 'selected' : 'cleared'} (${excluded.size} excluded)`);
      return;
    }
    if (m.type === 'reverse-copy') {
      if (inFlight) return;
      const rc = parseReverseCopyMessage(msg);
      if (!rc) {
        log('sync: reverse-copy message rejected (malformed)');
        return;
      }
      inFlight = true;
      try {
        await performReverseCopy(plans, rc);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`sync: reverse-copy failed — ${message}`);
        void vscode.window.showErrorMessage(`Folder Sync: copy to source failed — ${message}`);
      }
      inFlight = false;
      await refresh();
      return;
    }
  });

  render();
}

/**
 * Copy a destination's version of one file back over the source (Feature A).
 * 'promote' overwrites an edited source from an `update-collision` row and
 * rewrites the destination's manifest entry so the file reads as in-sync;
 * 'copy' seeds a brand-new source from a `destination-only` row (no manifest
 * change — the next plan classifies it as a skip at the origin destination and
 * a create everywhere else). Throws on failure; the caller re-plans regardless.
 */
async function performReverseCopy(
  plans: readonly PlanForDestination[],
  rc: ReverseCopyRequest,
): Promise<void> {
  const plan = plans[rc.pairIndex];
  if (!plan) throw new Error(`no plan at index ${rc.pairIndex}`);
  const destRootUri = plan.destination.destRootUri;
  if (!destRootUri) throw new Error('destination is unresolved');

  const wantKind = rc.kind === 'promote' ? 'update-collision' : 'destination-only';
  const item = plan.items.find((it) => it.relPath === rc.relPath && it.kind === wantKind);
  if (!item) throw new Error(`no ${wantKind} row for ${rc.relPath}`);

  // For an alias-rewritten collision the on-disk source path is the pre-rewrite
  // path; otherwise it coincides with the destination relpath.
  const sourceRelPath = item.aliasOrigin?.sourceRelPath ?? item.relPath;
  const result = await copyDestToSource({
    sourceRootUri: plan.source.sourceFolderUri,
    sourceRelPath,
    destRootUri,
    destRelPath: item.relPath,
    fs: vscodeFs(),
    hash: sha256Hex,
  });
  if (result.status !== 'ok') throw new Error(result.error ?? 'copy failed');

  log(
    `sync: reverse-copy ${rc.kind} — ${item.relPath} ` +
      `(${plan.destination.name} → ${vscode.workspace.asRelativePath(plan.source.sourceFolderUri, false)})`,
  );

  if (rc.kind !== 'promote') return;

  // Promote: the destination's edit is now canonical. Rewrite the destination's
  // manifest entry to the promoted hash so this file reads as in-sync on the
  // re-plan, and so future syncs classify the other destinations against the
  // new source correctly rather than re-flagging this one as a collision.
  const destWsUri = plan.destination.workspaceFolderUri ?? destRootUri;
  const mr = await readManifest(destWsUri);
  if (mr.kind !== 'ok') {
    log(`sync: reverse-copy promote — skipping manifest update (manifest ${mr.kind})`);
    return;
  }
  const key = manifestKey(plan.source.workspaceFolderName, item.relPath);
  const now = new Date().toISOString();
  mr.manifest.entries[key] = {
    destPath: plan.destination.subpath
      ? `${plan.destination.subpath}/${item.relPath}`
      : item.relPath,
    size: result.size ?? 0,
    sha256: result.sha256 ?? '',
    syncedAt: now,
  };
  mr.manifest.lastSync = now;
  await writeManifest(destWsUri, mr.manifest);
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
  excluded: ReadonlySet<string>,
): Promise<void> {
  const armedCount = countAccepted(decisions);
  log(
    `sync: proceed — starting execution (${armedCount} armed override(s), ` +
      `${excluded.size} file(s) excluded)`,
  );
  void panel.webview.postMessage({ type: 'status', label: 'Syncing\u2026' });

  let summary;
  try {
    summary = await runSync(plans, {
      decisions,
      excluded,
      onProgress: (e) => {
        void panel.webview.postMessage({
          type: 'progress',
          done: e.done,
          total: e.total,
          relPath: e.relPath,
          destLabel: e.destLabel,
          status: e.status,
        });
      },
    });
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

  // Manifest version-mismatch is a distinct condition that can co-occur with
  // any of the above (a multi-destination sync where one destination has a
  // bad version and the others succeed). Surface it as a second toast so the
  // user sees both signals.
  surfaceManifestVersionMismatches(summary);

  panel.dispose();
}

/**
 * Show a warning toast for destinations whose manifests had unsupported
 * versions. The toast carries an "Open Manifest" action that opens the
 * first (or only) mismatched manifest file so the user can inspect it.
 *
 * Exported so the per-file Run Sync path in `provider.ts` can use the same
 * surface — keeps the messaging consistent across every Run Sync entry
 * point.
 */
export function surfaceManifestVersionMismatches(summary: RunSummary): void {
  const mismatches = summary.manifestVersionMismatches;
  if (mismatches.length === 0) return;

  // Resolve to the actually-existing manifest filename (the toast's
  // "Open Manifest" action needs the on-disk URI, not the canonical one);
  // fall back to the canonical URI if the file vanished between the read
  // that surfaced the mismatch and this toast.
  const message =
    mismatches.length === 1
      ? `Folder Sync: skipped a destination — its manifest declares ` +
        `version ${String(mismatches[0].actual)}, which this extension doesn't ` +
        `support. Update the extension or remove the manifest to re-enable sync.`
      : `Folder Sync: skipped ${mismatches.length} destinations due to ` +
        `unsupported manifest versions. See the Output Channel for the list.`;

  void vscode.window
    .showWarningMessage(message, 'Open Manifest', 'Show Details')
    .then(async (choice) => {
      if (choice === 'Open Manifest') {
        const resolved = await resolveManifestUri(mismatches[0].destWorkspaceFolderUri);
        const firstManifestUri = resolved.existed
          ? resolved.uri
          : manifestUri(mismatches[0].destWorkspaceFolderUri);
        void vscode.commands.executeCommand('vscode.open', firstManifestUri);
      } else if (choice === 'Show Details') {
        void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
      }
    });
}
