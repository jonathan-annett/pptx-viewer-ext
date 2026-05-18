// Orchestrates a dry-run plan across the resolved topology.
//
// For each (source, destination) pair:
//   1. Walk the source tree, applying built-in ignores + the yaml's
//      include/exclude filters. Hash each file.
//   2. Walk the destination subpath subtree, applying the same filters.
//      Hash each file.
//   3. Read the destination's manifest (missing → empty).
//   4. Classify each file via the pure plan engine.
//
// The result is a list of PlanForDestination — one per (source × destination)
// pair. The dry-run command formats this for the Output Channel; M3 will
// feed the same structure into the plan webview.

import * as vscode from 'vscode';
import type { ResolvedSource, ResolvedDestination, ResolvedTopology } from './topology';
import type { FileInfo, PlanItem } from './plan';
import { classifyFiles, summarisePlan, type PlanSummary } from './plan';
import { walkTree } from './walker';
import { sha256Hex } from './hash';
import { GlobSet, BUILT_IN_IGNORES } from './glob';
import { readManifest } from './manifest';
import { log } from '../log';

export interface PlanForDestination {
  source: ResolvedSource;
  destination: ResolvedDestination;
  items: PlanItem[];
  summary: PlanSummary;
  /** Sources that couldn't be walked (e.g. destination root URI absent). */
  skippedReason?: string;
}

/**
 * Build a workspace-wide dry-run plan.
 *
 * Unresolved destinations are still surfaced as PlanForDestination entries
 * with skippedReason set, so the formatter can report them rather than
 * silently dropping the configuration.
 */
export async function buildDryRunPlan(
  topology: ResolvedTopology,
): Promise<PlanForDestination[]> {
  const results: PlanForDestination[] = [];

  for (const source of topology.sources) {
    // The yaml's include/exclude only ever apply to the source tree —
    // the destination walk uses built-ins plus the same user excludes so
    // we don't surface destination-only entries the user has chosen to
    // ignore.
    const yamlConfig = await loadConfigForSource(source);
    const sourceExclude = new GlobSet([...BUILT_IN_IGNORES, ...(yamlConfig?.exclude ?? [])]);
    const sourceInclude = new GlobSet(yamlConfig?.include ?? []);
    const destExclude = new GlobSet([...BUILT_IN_IGNORES, ...(yamlConfig?.exclude ?? [])]);
    const destInclude = new GlobSet([]); // include filter only meaningful on source

    let sourceFiles: FileInfo[] = [];
    try {
      sourceFiles = await walkAndHash(source.sourceFolderUri, {
        exclude: sourceExclude,
        include: sourceInclude,
      });
    } catch (err) {
      log(`sync: source walk failed for ${source.yamlUri.toString()} — ${errMsg(err)}`);
    }

    for (const dest of source.destinations) {
      if (!dest.destRootUri || !dest.workspaceFolderUri) {
        results.push({
          source,
          destination: dest,
          items: [],
          summary: summarisePlan([]),
          skippedReason: `destination '${dest.name}' is not in the workspace`,
        });
        continue;
      }

      let destFiles: FileInfo[] = [];
      try {
        destFiles = await walkAndHash(dest.destRootUri, {
          exclude: destExclude,
          include: destInclude,
        });
      } catch (err) {
        log(`sync: destination walk failed for ${dest.destRootUri.toString()} — ${errMsg(err)}`);
      }

      // The manifest lives at the destination workspace folder root, not at
      // the subpath. A single workspace-folder destination shares one manifest
      // even when multiple sources write into different subpaths under it.
      const manifest = await readManifest(dest.workspaceFolderUri);

      const items = classifyFiles(
        source.workspaceFolderName,
        sourceFiles,
        destFiles,
        manifest,
      );
      const summary = summarisePlan(items);
      results.push({ source, destination: dest, items, summary });
    }
  }

  return results;
}

/**
 * Re-read the yaml so the planner can apply include/exclude. The manager
 * already validated it; here we just need the filter lists. Keeping this
 * inline avoids threading the parsed config through the topology type — the
 * source folder URI is stable and the file is small.
 */
async function loadConfigForSource(
  source: ResolvedSource,
): Promise<{ include: string[]; exclude: string[] } | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(source.yamlUri);
    const text = new TextDecoder().decode(bytes);
    // Dynamic import keeps the yaml-mini code path out of the cold start;
    // the import resolves to the bundled module at build time.
    const { parseYamlMini } = await import('./yaml-mini');
    const parsed = parseYamlMini(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const p = parsed as Record<string, unknown>;
    const include = Array.isArray(p.include)
      ? (p.include.filter((x): x is string => typeof x === 'string'))
      : [];
    const exclude = Array.isArray(p.exclude)
      ? (p.exclude.filter((x): x is string => typeof x === 'string'))
      : [];
    return { include, exclude };
  } catch {
    return null;
  }
}

interface WalkAndHashOpts {
  exclude: GlobSet;
  include: GlobSet;
}

async function walkAndHash(root: vscode.Uri, opts: WalkAndHashOpts): Promise<FileInfo[]> {
  const entries = await walkTree(root, opts);
  const out: FileInfo[] = [];
  for (const e of entries) {
    try {
      const bytes = await vscode.workspace.fs.readFile(e.uri);
      const sha256 = await sha256Hex(bytes);
      out.push({ relPath: e.relPath, size: e.size, sha256 });
    } catch (err) {
      log(`sync: failed to read ${e.uri.toString()} — ${errMsg(err)} (skipping)`);
    }
  }
  return out;
}

// ───── formatting ────────────────────────────────────────────────────────

/**
 * Render the plan list as multi-line text for the Output Channel.
 * Includes per-file size and hash fragments so the diff is visible.
 */
export function formatDryRunPlan(plans: readonly PlanForDestination[]): string {
  const lines: string[] = [];
  lines.push(`--- Folder Sync: dry-run plan ---`);
  lines.push(`Pairs: ${plans.length}`);

  let createTotal = 0;
  let updateTrackedTotal = 0;
  let updateCollisionTotal = 0;
  let skipTotal = 0;
  let deleteTrackedTotal = 0;
  let destOnlyTotal = 0;

  for (const plan of plans) {
    lines.push('');
    const srcPath = vscode.workspace.asRelativePath(plan.source.sourceFolderUri, false);
    const destLabel = plan.destination.destRootUri
      ? plan.destination.destRootUri.toString()
      : `<unresolved: ${plan.destination.name}>`;
    lines.push(`Source: ${srcPath || plan.source.sourceFolderUri.toString()}`);
    lines.push(`  → ${plan.destination.name}${plan.destination.subpath ? ` /${plan.destination.subpath}` : ''}`);
    lines.push(`    ${destLabel}`);

    if (plan.skippedReason) {
      lines.push(`    SKIPPED: ${plan.skippedReason}`);
      continue;
    }

    const s = plan.summary;
    createTotal += s.create.length;
    updateTrackedTotal += s.updateTracked.length;
    updateCollisionTotal += s.updateCollision.length;
    skipTotal += s.skip.length;
    deleteTrackedTotal += s.deleteTracked.length;
    destOnlyTotal += s.destinationOnly.length;

    section(lines, 'Create', s.create);
    section(lines, 'Update (tracked)', s.updateTracked);
    section(lines, 'Update (collision — manual confirm)', s.updateCollision);
    section(lines, 'Skip (unchanged)', s.skip);
    section(lines, 'Delete (source removed)', s.deleteTracked);
    section(lines, 'Destination-only', s.destinationOnly);
  }

  lines.push('');
  lines.push(
    `Totals — create ${createTotal}, update-tracked ${updateTrackedTotal}, ` +
      `collisions ${updateCollisionTotal}, skip ${skipTotal}, delete ${deleteTrackedTotal}, ` +
      `destination-only ${destOnlyTotal}`,
  );
  lines.push(`--- end plan ---`);
  return lines.join('\n');
}

function section(lines: string[], label: string, items: PlanItem[]): void {
  if (items.length === 0) return;
  lines.push(`    ${label}: ${items.length}`);
  for (const item of items) {
    lines.push(`      ${describeItem(item)}`);
  }
}

function describeItem(item: PlanItem): string {
  // 8-char hash prefixes keep the line short while remaining useful for
  // spotting "yes that's the same hash on both sides".
  const hashes: string[] = [];
  if (item.sourceHash) hashes.push(`src=${item.sourceHash.slice(0, 8)}`);
  if (item.destHash) hashes.push(`dst=${item.destHash.slice(0, 8)}`);
  if (item.manifestHash) hashes.push(`man=${item.manifestHash.slice(0, 8)}`);
  const sizeBit =
    item.sourceSize !== undefined
      ? `${item.sourceSize}b`
      : item.destSize !== undefined
        ? `${item.destSize}b`
        : '?';
  const tail = hashes.length > 0 ? ` (${hashes.join(' ')})` : '';
  return `${item.relPath} — ${sizeBit}${tail}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
