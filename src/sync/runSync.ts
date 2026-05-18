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
import { readManifest, writeManifest } from './manifest';
import { executePlan, type ExecuteResult, type OperationResult, type SyncFs } from './executor';
import { sha256Hex } from './hash';
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
 * Execute the green-path subset (create / update-tracked / delete-tracked)
 * across all plans. Plans that were already skipped at plan time
 * (unresolved destination, etc.) are dropped silently — they had no
 * operations to begin with.
 */
export async function runSync(plans: readonly PlanForDestination[]): Promise<RunSummary> {
  const fs = vscodeFs();
  const summary: RunSummary = { ok: 0, failed: 0, perPlan: [], manifestWriteFailures: [] };

  // Group by destination workspace folder URI. A single manifest is shared
  // across all sources writing into the same workspace folder; reading and
  // writing it once per group keeps the I/O bounded.
  const groups = groupByDestWorkspaceFolder(plans);

  for (const group of groups) {
    const manifest = await readManifest(group.destWorkspaceFolderUri);

    for (const plan of group.plans) {
      if (plan.skippedReason || !plan.destination.destRootUri) {
        log(`sync: execute — skipping ${labelPair(plan)} (${plan.skippedReason ?? 'unresolved'})`);
        continue;
      }

      const result = await executePlan({
        sourceWorkspaceFolderName: plan.source.workspaceFolderName,
        sourceRootUri: plan.source.sourceFolderUri,
        destRootUri: plan.destination.destRootUri,
        destSubpath: plan.destination.subpath,
        items: plan.items,
        manifest,
        fs,
        hash: sha256Hex,
      });

      for (const r of result.results) {
        if (r.status === 'ok') summary.ok++;
        else summary.failed++;
      }

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

// ───── adapters ──────────────────────────────────────────────────────────

function vscodeFs(): SyncFs<vscode.Uri> {
  // The web-extension host's vscode.workspace.fs is the only filesystem
  // primitive available. URIs are opaque to the executor — we just need
  // joinPath to produce a child URI under a root.
  return {
    joinPath(root, relPath) {
      const base = root.path.endsWith('/') ? root.path.slice(0, -1) : root.path;
      const sep = relPath.startsWith('/') ? '' : '/';
      return root.with({ path: `${base}${sep}${relPath}` });
    },
    readFile: (uri) => Promise.resolve(vscode.workspace.fs.readFile(uri)).then(toUint8),
    writeFile: (uri, bytes) => Promise.resolve(vscode.workspace.fs.writeFile(uri, bytes)).then(noop),
    rename: (src, dst) =>
      Promise.resolve(vscode.workspace.fs.rename(src, dst, { overwrite: true })).then(noop),
    delete: (uri) => Promise.resolve(vscode.workspace.fs.delete(uri)).then(noop),
  };
}

function toUint8(x: Uint8Array): Uint8Array { return x; }
function noop(): void { /* discard return */ }

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
        `delete ${c.deleteTracked.ok}/${c.deleteTracked.ok + c.deleteTracked.failed}`,
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
