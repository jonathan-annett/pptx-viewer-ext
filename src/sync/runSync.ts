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
import {
  countExecutableItems,
  executePlan,
  type ExecuteProgressEvent,
  type ExecuteResult,
  type OperationResult,
} from './executor';
import type { RowDecision } from './decisions';
import { manifestKey } from './manifest-types';
import { sha256Hex } from './hash';
import { nowMs, fmtMs } from './timing';
import { getHashCacheSingleton } from './hashCache';
import { vscodeFs } from './vscodeFs';
import { sweepOrphanTmpFiles } from './orphanSweep';
import { vscodeSweepFs } from './orphanSweepWired';
import { withTimeout } from './timeout';
import { log } from '../log';

// Reachability-probe budget for a destination workspace folder before we sync
// into it. A live folder answers `stat` in well under this; an unavailable
// web-FSA folder hangs and is skipped once it elapses, so one dead destination
// can't block the reachable ones — multiple destinations exist for redundancy.
const DEST_PROBE_TIMEOUT_MS = 4000;

export interface RunSummary {
  ok: number;
  failed: number;
  perPlan: PlanSummary[];
  manifestWriteFailures: string[];
  /**
   * Destination workspace folders whose existing `.foldersync-manifest.json`
   * declared an unsupported `version`. Sync refuses these destinations
   * entirely (no writes, no manifest overwrite) — the user has to update the
   * extension before this destination can be synced again. The shape is
   * carried separately so the caller can surface a distinct toast and offer
   * an "Open Manifest" action.
   */
  manifestVersionMismatches: ManifestVersionMismatch[];
}

export interface ManifestVersionMismatch {
  destWorkspaceFolderUri: vscode.Uri;
  /** The unsupported `version` field as read from the file. */
  actual: unknown;
}

export interface PlanSummary {
  sourceLabel: string;
  destLabel: string;
  results: OperationResult[];
  counts: ExecuteResult['counts'];
}

/**
 * Aggregated per-operation progress event emitted by {@link runSync}. The
 * `done` counter increments across every plan in the run; `total` is fixed
 * at the start (pre-computed from the dispatch predicate, so it matches
 * what the executor will actually run). Skipped items (placeholders,
 * blocked-warning rows, unarmed orange-path rows) are not counted.
 */
export interface SyncProgressEvent extends ExecuteProgressEvent {
  /** 1-indexed count of items completed so far (this op included). */
  done: number;
  /** Total executable items across every plan in this run. */
  total: number;
  /** Workspace-relative label of the destination this op landed in. */
  destLabel: string;
  /** Workspace-relative label of the source this op came from. */
  sourceLabel: string;
}

export interface RunSyncOptions {
  decisions?: ReadonlyMap<string, RowDecision>;
  /**
   * Feature B: per-row "skip this file" set from the plan webview's include
   * checkboxes. Ids are `${pairIndex}:${relPath}` (same pairIndex basis as
   * `decisions`). Any plan item whose id is in this set is filtered out
   * before the executor's dispatch logic runs — so excluding a row skips it
   * regardless of its kind or any armed decision. Empty/absent = include
   * everything (the pre-Feature-B behaviour).
   */
  excluded?: ReadonlySet<string>;
  /**
   * Fires after each dispatched item completes. Used by the webviews to
   * drive a progress bar. The event carries running `done` + fixed `total`
   * so callers can render `${done}/${total}` or a percentage directly.
   * Leave undefined for non-UI callers (tests, palette dry-runs).
   */
  onProgress?: (event: SyncProgressEvent) => void;
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
  decisionsOrOptions?: ReadonlyMap<string, RowDecision> | RunSyncOptions,
): Promise<RunSummary> {
  // Back-compat: callers used to pass `(plans, decisions)`. The new
  // options-object form carries `onProgress` for the progress-bar wiring.
  // Detect by shape — a Map has `.get`; an options object doesn't.
  const isMap =
    decisionsOrOptions !== undefined &&
    typeof (decisionsOrOptions as ReadonlyMap<string, RowDecision>).get === 'function';
  const decisions: ReadonlyMap<string, RowDecision> | undefined = isMap
    ? (decisionsOrOptions as ReadonlyMap<string, RowDecision>)
    : (decisionsOrOptions as RunSyncOptions | undefined)?.decisions;
  const onProgress: ((event: SyncProgressEvent) => void) | undefined = isMap
    ? undefined
    : (decisionsOrOptions as RunSyncOptions | undefined)?.onProgress;
  // Feature B: the include-checkbox exclusion set (only carried on the
  // options-object form; the legacy Map form never excludes anything).
  const excluded: ReadonlySet<string> | undefined = isMap
    ? undefined
    : (decisionsOrOptions as RunSyncOptions | undefined)?.excluded;

  const fs = vscodeFs();
  // Cache is set at activation. Treated as optional so tests / partial setups
  // still work; production always has one (in-memory at minimum).
  const cache = getHashCacheSingleton() as
    | undefined
    | import('./hashCache').UriHashCache<vscode.Uri>;
  const summary: RunSummary = {
    ok: 0,
    failed: 0,
    perPlan: [],
    manifestWriteFailures: [],
    manifestVersionMismatches: [],
  };

  // sync-timing accumulators (execute phase). Separates the actual file copy
  // (executePlan) from the manifest read/write IO so a slow run points at the
  // right culprit. The plan-build walk is timed separately in planner.ts.
  const runStart = nowMs();
  let manifestReadMs = 0;
  let execMs = 0;
  let manifestWriteMs = 0;

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

  // Pre-compute the total number of items the executor will actually
  // dispatch across every plan in this run. Uses the same predicate the
  // executor will use, so the progress bar's denominator matches the
  // numerator's eventual ceiling exactly — no surprise jumps when the
  // executor decides to skip something the UI was counting on. Skipped
  // plans (unresolved destinations, version-mismatch groups) contribute 0.
  let progressTotal = 0;
  if (onProgress) {
    for (const group of groups) {
      for (const plan of group.plans) {
        if (plan.skippedReason || !plan.destination.destRootUri) continue;
        const pairIndex = pairIndices.get(plan) ?? 0;
        const armed = pickArmedDecisions(decisions, pairIndex);
        progressTotal += countExecutableItems(includedItems(plan.items, pairIndex, excluded), {
          decidedOverwrites: armed.decidedOverwrites,
          decidedDeletes: armed.decidedDeletes,
          decidedWarningOverrides: armed.decidedWarningOverrides,
        });
      }
    }
    // Fire one zero-progress event up front so the webview can render the
    // initial "0 / N" state before the first file finishes.
    onProgress({
      done: 0,
      total: progressTotal,
      kind: 'create',
      relPath: '',
      status: 'ok',
      destLabel: '',
      sourceLabel: '',
    });
  }
  let progressDone = 0;

  for (const group of groups) {
    // Reachability probe before we touch this destination. An unavailable
    // folder (revoked web-FSA permission / offline PC) otherwise hangs the
    // manifest read or the writes and blocks every reachable destination behind
    // it. Skip it instead — its files simply aren't synced this run; the
    // reachable destinations still get theirs (redundancy). The would-be ops
    // count as failed so the summary/toast reflects the incomplete sync.
    try {
      await withTimeout(
        Promise.resolve(fs.stat(group.destWorkspaceFolderUri)),
        DEST_PROBE_TIMEOUT_MS,
        `stat destination ${group.destWorkspaceFolderUri.toString()}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let skipped = 0;
      for (const plan of group.plans) {
        if (plan.skippedReason || !plan.destination.destRootUri) continue;
        const pairIndex = pairIndices.get(plan) ?? 0;
        const armed = pickArmedDecisions(decisions, pairIndex);
        skipped += countExecutableItems(includedItems(plan.items, pairIndex, excluded), {
          decidedOverwrites: armed.decidedOverwrites,
          decidedDeletes: armed.decidedDeletes,
          decidedWarningOverrides: armed.decidedWarningOverrides,
        });
        log(`sync: execute — destination unreachable, skipping ${labelPair(plan)} (${message})`);
      }
      summary.failed += skipped;
      continue;
    }

    const manifestReadStart = nowMs();
    const manifestResult = await readManifest(group.destWorkspaceFolderUri);
    manifestReadMs += nowMs() - manifestReadStart;
    if (manifestResult.kind === 'version-mismatch') {
      // Refuse the whole group. Writing v1 over an unknown version would
      // clobber the user's prior tracking. The planner already surfaced the
      // same condition as a per-pair skippedReason, but we re-check here
      // because (a) a stale plan could be replayed after the file was edited
      // out-of-band, and (b) the runSync API contract is "safe regardless of
      // plan provenance". Skip every plan in the group; record the mismatch
      // for the caller's toast.
      summary.manifestVersionMismatches.push({
        destWorkspaceFolderUri: group.destWorkspaceFolderUri,
        actual: manifestResult.actual,
      });
      for (const plan of group.plans) {
        log(
          `sync: execute — skipping ${labelPair(plan)} ` +
            `(manifest version mismatch: ${String(manifestResult.actual)})`,
        );
      }
      continue;
    }
    const manifest = manifestResult.manifest;

    for (const plan of group.plans) {
      if (plan.skippedReason || !plan.destination.destRootUri) {
        log(`sync: execute — skipping ${labelPair(plan)} (${plan.skippedReason ?? 'unresolved'})`);
        continue;
      }

      const pairIndex = pairIndices.get(plan) ?? 0;
      const armed = pickArmedDecisions(decisions, pairIndex);
      const planSourceLabel = relPath(plan.source.sourceFolderUri);
      const planDestLabel = pairDestLabel(plan);
      // Feature B: drop any rows the user opted out of via the include
      // checkboxes before the executor sees them.
      const items = includedItems(plan.items, pairIndex, excluded);

      const execStart = nowMs();
      const result = await executePlan({
        sourceWorkspaceFolderName: plan.source.workspaceFolderName,
        sourceRootUri: plan.source.sourceFolderUri,
        destRootUri: plan.destination.destRootUri,
        destSubpath: plan.destination.subpath,
        items,
        manifest,
        fs,
        hash: sha256Hex,
        cache,
        decidedOverwrites: armed.decidedOverwrites,
        decidedDeletes: armed.decidedDeletes,
        decidedWarningOverrides: armed.decidedWarningOverrides,
        onProgress: onProgress
          ? (e) => {
              progressDone++;
              onProgress({
                ...e,
                done: progressDone,
                total: progressTotal,
                destLabel: planDestLabel,
                sourceLabel: planSourceLabel,
              });
            }
          : undefined,
      });
      execMs += nowMs() - execStart;

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
      // Pass the included items only: an excluded row must not have its
      // remembered decision cleared just because the user skipped it this run.
      applyDecisionPersistence(plan.source.workspaceFolderName, items, decisions, manifest, okPaths);

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
    const manifestWriteStart = nowMs();
    try {
      await writeManifest(group.destWorkspaceFolderUri, manifest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`sync: manifest write FAILED for ${group.destWorkspaceFolderUri.toString()} — ${message}`);
      summary.manifestWriteFailures.push(`${group.destWorkspaceFolderUri.toString()}: ${message}`);
    }
    manifestWriteMs += nowMs() - manifestWriteStart;
  }

  // sync-timing: execute phase. total is the whole runSync wall time; exec is
  // the actual file copies (executePlan), the rest is manifest IO + the
  // pre-run orphan-tmp sweep. Compare against the planner's plan-build timing
  // to see whether a slow sync is the walk or the copy.
  const totalMs = nowMs() - runStart;
  log(
    `sync-timing: execute — total=${fmtMs(totalMs)} ` +
      `manifestRead=${fmtMs(manifestReadMs)} exec=${fmtMs(execMs)} manifestWrite=${fmtMs(manifestWriteMs)} ` +
      `(${summary.ok} ok / ${summary.failed} failed across ${plans.length} pair(s))`,
  );

  return summary;
}

// ───── inclusion (Feature B) ───────────────────────────────────────────────

/**
 * Drop plan items the user opted out of via the include checkboxes. The
 * exclusion id is `${pairIndex}:${relPath}`, matching the include-checkbox id
 * the renderer emits. No exclusions (the common case) returns the list as-is.
 */
function includedItems(
  items: readonly PlanItem[],
  pairIndex: number,
  excluded: ReadonlySet<string> | undefined,
): readonly PlanItem[] {
  if (!excluded || excluded.size === 0) return items;
  return items.filter((it) => !excluded.has(`${pairIndex}:${it.relPath}`));
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
  source: string,
  items: readonly PlanItem[],
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
  // First pass: clear any previously-remembered decision on plan items that
  // exposed a remembered choice this run. We'll re-add below if the user
  // kept it ticked; clearing unconditionally first lets an opted-out row be
  // forgotten without per-kind tracking.
  for (const item of items) {
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
    const matches = items.find((it) => decisionMatchesItem(d, it));
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
  if (summary.manifestVersionMismatches.length > 0) {
    lines.push('');
    lines.push('Skipped destinations (unsupported manifest version):');
    for (const m of summary.manifestVersionMismatches) {
      lines.push(`  ${m.destWorkspaceFolderUri.toString()} — version ${String(m.actual)}`);
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
