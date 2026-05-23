// vscode-wired orchestrator for sync execution.
//
// Given a list of plans (one per source × destination pair), this module:
//   1. Builds a SyncFs adapter over vscode.workspace.fs.
//   2. Groups plans by destination workspace folder so the manifest is
//      shared across multiple sources writing into the same destination.
//   3. Calls the pure executor (executor.ts) per plan, accumulating
//      mutations into the in-memory manifest for that group.
//   4. Persists each group's manifest once at the end via writeManifest
//      (tmp+rename, same pattern as the executor's per-file writes).
//
// Per-file errors are isolated by the executor; this module rolls them up
// into a single summary for the Output Channel + a VS Code notification.

import * as vscode from 'vscode';
import type { PlanForDestination } from './planner';
import type { PlanItem } from './plan';
import { readManifest, writeManifest } from './manifest';
import { executePlan, type ExecuteResult, type OperationResult } from './executor';
import type { RowDecision } from './decisions';
import { manifestKey } from './manifest-types';
import { sha256Hex } from './hash';
import { getHashCacheSingleton } from './hashCache';
import { vscodeFs } from './vscodeFs';
import { sweepOrphanTmpFiles } from './orphanSweep';
import { vscodeSweepFs } from './orphanSweepWired';
import { log } from '../log';

export interface RunSummary {
  ok: number;
  failed: number;
  perPlan: PlanSummary[];
  manifestWriteFailures: string[];
}

export interface PlanSummary {
  sourceLabel: string;
  destLabel: string;
  results: OperationResult[];
  counts: ExecuteResult['counts'];
}

/**
 * Execute the green-path subset (create / update-tracked / delete-tracked),
 * plus any orange-path rows (update-collision / destination-only) the user
 * armed via the plan webview's per-row checkboxes.
 *
 * `decisions` carries the in-memory map from the plan panel — id → RowDecision
 * where the id is `${pairIndex}:${kind}:${relPath}` matching the order of
 * `plans` (the panel built its decision ids from the same iteration that
 * produced this list). Items in the map with `accepted: true` get dispatched
 * to the executor; `remember: true` additions are persisted to the manifest's
 * `decisions` block; rows that had `remembered.accepted` on the original
 * PlanItem but no current map entry are treated as "user unticked" and the
 * matching manifest decision is cleared.
 *
 * Plans that were already skipped at plan time (unresolved destination, etc.)
 * are dropped silently — they had no operations to begin with.
 */
export async function runSync(
  plans: readonly PlanForDestination[],
  decisions?: ReadonlyMap<string, RowDecision>,
): Promise<RunSummary> {
  const fs = vscodeFs();
  // Cache is set at activation. Treated as optional so tests / partial setups
  // still work; production always has one (in-memory at minimum).
  const cache = getHashCacheSingleton() as
    | undefined
    | import('./hashCache').UriHashCache<vscode.Uri>;
  const summary: RunSummary = { ok: 0, failed: 0, perPlan: [], manifestWriteFailures: [] };

  // Group by destination workspace folder URI. A single manifest is shared
  // across all sources writing into the same workspace folder; reading and
  // writing it once per group keeps the I/O bounded.
  const groups = groupByDestWorkspaceFolder(plans);
  // pairIndex matches the renderer's iteration over `plans` (same input
  // array), so decision ids are interpretable here without re-deriving them.
  const pairIndices = new Map<PlanForDestination, number>();
  plans.forEach((p, i) => pairIndices.set(p, i));

  // Pre-execute orphan .tmp sweep. An interrupted executor write (browser
  // tab closed mid-rename, host crash) leaves <file>.tmp behind. The planner
  // already ignores **/*.tmp (M6.A); this sweep removes them from disk so a
  // re-run doesn't pile up on the previous attempt's debris. Best-effort:
  // failures are logged and never abort the run.
  const sweepFs = vscodeSweepFs();
  const sweptRoots = new Set<string>();
  for (const plan of plans) {
    const destRoot = plan.destination.destRootUri;
    if (!destRoot) continue;
    const key = destRoot.toString();
    if (sweptRoots.has(key)) continue;
    sweptRoots.add(key);
    try {
      const result = await sweepOrphanTmpFiles(sweepFs, destRoot);
      if (result.deleted.length > 0 || result.errors.length > 0) {
        log(
          `sync: orphan-tmp sweep on ${key} — ` +
            `deleted ${result.deleted.length}, failed ${result.errors.length}`,
        );
        for (const path of result.deleted) {
          log(`  swept: ${path}`);
        }
        for (const err of result.errors) {
          log(`  sweep FAILED: ${err.relPath} — ${err.message}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`sync: orphan-tmp sweep FAILED for ${key} — ${message}`);
    }
  }

  for (const group of groups) {
    const manifest = await readManifest(group.destWorkspaceFolderUri);

    for (const plan of group.plans) {
      if (plan.skippedReason || !plan.destination.destRootUri) {
        log(`sync: execute — skipping ${labelPair(plan)} (${plan.skippedReason ?? 'unresolved'})`);
        continue;
      }

      const pairIndex = pairIndices.get(plan) ?? 0;
      const armed = pickArmedDecisions(decisions, pairIndex);

      const result = await executePlan({
        sourceWorkspaceFolderName: plan.source.workspaceFolderName,
        sourceRootUri: plan.source.sourceFolderUri,
        destRootUri: plan.destination.destRootUri,
        destSubpath: plan.destination.subpath,
        items: plan.items,
        manifest,
        fs,
        hash: sha256Hex,
        cache,
        decidedOverwrites: armed.decidedOverwrites,
        decidedDeletes: armed.decidedDeletes,
        decidedWarningOverrides: armed.decidedWarningOverrides,
      });

      for (const r of result.results) {
        if (r.status === 'ok') summary.ok++;
        else summary.failed++;
      }

      // Persist the manifest-level decision diffs for this plan. Successful
      // ops only: a failed overwrite shouldn't leave behind a "remember yes"
      // for a file that didn't actually get written.
      const okPaths = new Set(
        result.results.filter((r) => r.status === 'ok').map((r) => r.relPath),
      );
      applyDecisionPersistence(plan, decisions, manifest, okPaths);

      summary.perPlan.push({
        sourceLabel: relPath(plan.source.sourceFolderUri),
        destLabel: pairDestLabel(plan),
        results: result.results,
        counts: result.counts,
      });
    }

    // Persist the manifest once per destination workspace folder. If this
    // write fails, the in-memory mutations are lost — the user will see
    // the same plan next run. That's acceptable; manifests are recoverable
    // (the destination files are still there) but we surface the failure.
    try {
      await writeManifest(group.destWorkspaceFolderUri, manifest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`sync: manifest write FAILED for ${group.destWorkspaceFolderUri.toString()} — ${message}`);
      summary.manifestWriteFailures.push(`${group.destWorkspaceFolderUri.toString()}: ${message}`);
    }
  }

  return summary;
}

// ───── decisions ─────────────────────────────────────────────────────────

interface ArmedDecisions {
  decidedOverwrites: Set<string>;
  decidedDeletes: Set<string>;
  decidedWarningOverrides: Set<string>;
}

/**
 * Filter the panel's decision map down to the rows armed for one plan pair.
 * Decision ids are formed as `${pairIndex}:${kind}:${relPath}` by the
 * renderer, which keeps the partitioning trivial here.
 */
function pickArmedDecisions(
  decisions: ReadonlyMap<string, RowDecision> | undefined,
  pairIndex: number,
): ArmedDecisions {
  const out: ArmedDecisions = {
    decidedOverwrites: new Set<string>(),
    decidedDeletes: new Set<string>(),
    decidedWarningOverrides: new Set<string>(),
  };
  if (!decisions) return out;
  const prefix = `${pairIndex}:`;
  for (const [id, d] of decisions) {
    if (!id.startsWith(prefix)) continue;
    if (!d.accepted) continue;
    if (d.kind === 'overwrite') out.decidedOverwrites.add(d.relPath);
    else if (d.kind === 'delete') out.decidedDeletes.add(d.relPath);
    else out.decidedWarningOverrides.add(d.relPath);
  }
  return out;
}

/**
 * Mutate `manifest.decisions` in place to reflect this run's persistence
 * intents:
 *
 *  - Successful armed rows with `remember: true` → write a ManifestDecision.
 *  - Original PlanItems that carried `remembered.accepted: true` but had no
 *    current armed entry → user unticked. Delete the manifest decision so
 *    the next run renders the row fresh.
 *
 * `okPaths` filters to rows that actually completed — a failed overwrite
 * shouldn't pretend the user's "remember" applied. Manifest decisions for
 * the cleared (unticked) case are pruned regardless of the operation result
 * because the user's intent is explicit.
 */
function applyDecisionPersistence(
  plan: PlanForDestination,
  decisions: ReadonlyMap<string, RowDecision> | undefined,
  manifest: {
    decisions: {
      [key: string]: {
        destOnlyDelete: boolean;
        collisionOverwrite: boolean;
        warningOverride: boolean;
        decidedAt: string;
      };
    };
  },
  okPaths: ReadonlySet<string>,
): void {
  const source = plan.source.workspaceFolderName;
  // First pass: clear any previously-remembered decision on plan items that
  // exposed a remembered choice this run. We'll re-add below if the user
  // kept it ticked; clearing unconditionally first lets an opted-out row be
  // forgotten without per-kind tracking.
  for (const item of plan.items) {
    const hadRemembered = !!item.remembered?.accepted;
    if (!hadRemembered) continue;
    // Items where remembered may apply: collisions (collisionOverwrite),
    // destination-only (destOnlyDelete), and green-path rows with override-
    // only warnings (warningOverride).
    if (
      item.kind !== 'update-collision' &&
      item.kind !== 'destination-only' &&
      item.kind !== 'create' &&
      item.kind !== 'update-tracked'
    ) {
      continue;
    }
    const key = manifestKey(source, item.relPath);
    delete manifest.decisions[key];
  }

  if (!decisions) return;
  const now = new Date().toISOString();
  for (const d of decisions.values()) {
    if (!d.accepted || !d.remember) continue;
    if (!okPaths.has(d.relPath)) continue;
    // The decision map is panel-wide; only persist entries that belong to
    // this plan. We can tell by checking whether the plan has an item that
    // matches the decision's kind + relPath.
    const matches = plan.items.find((it) => decisionMatchesItem(d, it));
    if (!matches) continue;
    const key = manifestKey(source, d.relPath);
    manifest.decisions[key] = {
      destOnlyDelete: d.kind === 'delete',
      collisionOverwrite: d.kind === 'overwrite',
      warningOverride: d.kind === 'warning-override',
      decidedAt: now,
    };
  }
}

function decisionMatchesItem(d: RowDecision, it: PlanItem): boolean {
  if (d.relPath !== it.relPath) return false;
  if (d.kind === 'overwrite') return it.kind === 'update-collision';
  if (d.kind === 'delete') return it.kind === 'destination-only';
  // warning-override: only attached to green-path rows that aren't collisions
  // (collision rows fold warning arming into the overwrite decision).
  return it.kind === 'create' || it.kind === 'update-tracked';
}

// ───── grouping ──────────────────────────────────────────────────────────

interface DestGroup {
  destWorkspaceFolderUri: vscode.Uri;
  plans: PlanForDestination[];
}

function groupByDestWorkspaceFolder(plans: readonly PlanForDestination[]): DestGroup[] {
  const groups = new Map<string, DestGroup>();
  for (const plan of plans) {
    const wsUri = plan.destination.workspaceFolderUri;
    if (!wsUri) continue; // unresolved; skipped by the runner above
    const key = wsUri.toString();
    let group = groups.get(key);
    if (!group) {
      group = { destWorkspaceFolderUri: wsUri, plans: [] };
      groups.set(key, group);
    }
    group.plans.push(plan);
  }
  return [...groups.values()];
}

// ───── formatting ────────────────────────────────────────────────────────

export function formatRunSummary(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push('--- Folder Sync: execution summary ---');
  lines.push(`Total: ${summary.ok} succeeded, ${summary.failed} failed`);
  for (const plan of summary.perPlan) {
    lines.push('');
    lines.push(`${plan.sourceLabel} → ${plan.destLabel}`);
    const c = plan.counts;
    lines.push(
      `  create ${c.create.ok}/${c.create.ok + c.create.failed} • ` +
        `update ${c.updateTracked.ok}/${c.updateTracked.ok + c.updateTracked.failed} • ` +
        `delete ${c.deleteTracked.ok}/${c.deleteTracked.ok + c.deleteTracked.failed} • ` +
        `overwrite ${c.updateCollision.ok}/${c.updateCollision.ok + c.updateCollision.failed} • ` +
        `dest-delete ${c.destinationOnly.ok}/${c.destinationOnly.ok + c.destinationOnly.failed}`,
    );
    const failures = plan.results.filter((r) => r.status === 'failed');
    for (const f of failures) {
      lines.push(`  FAILED [${f.kind}] ${f.relPath} — ${f.error ?? '?'}`);
    }
  }
  if (summary.manifestWriteFailures.length > 0) {
    lines.push('');
    lines.push('Manifest write failures:');
    for (const m of summary.manifestWriteFailures) {
      lines.push(`  ${m}`);
    }
  }
  lines.push('--- end ---');
  return lines.join('\n');
}

// ───── label helpers ─────────────────────────────────────────────────────

function relPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false) || uri.toString();
}

function labelPair(plan: PlanForDestination): string {
  return `${relPath(plan.source.sourceFolderUri)} → ${pairDestLabel(plan)}`;
}

function pairDestLabel(plan: PlanForDestination): string {
  return plan.destination.subpath
    ? `${plan.destination.name} /${plan.destination.subpath}`
    : plan.destination.name;
}
