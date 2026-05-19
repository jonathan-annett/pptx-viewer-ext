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
import { parseSyncConfigText } from './config';
import {
  type Scope,
  filterFilesToScope,
  filterManifestToScope,
  relPathFromBase,
  scopeFromRelPath,
} from './scopedPlan';
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
    const planned = await planForSource(source, { kind: 'none' });
    results.push(...planned);
  }
  return results;
}

/**
 * Options for scoped (single-source, optionally path-filtered) dry-run.
 *
 * `pathFilter` is interpreted relative to the source folder root. A directory
 * filter restricts the plan to files at or below that directory; a file
 * filter restricts it to that single file. When `pathFilter` is omitted (or
 * is the source folder itself), the result matches `buildDryRunPlan` for
 * just that source — useful for the admin editor's "all sources" rendering
 * which loops over each source independently.
 *
 * `pathFilterIsFile` lets the caller skip the stat round-trip when the kind
 * is already known (e.g. the pptx viewer always passes a regular file URI).
 */
export interface ScopedPlanOptions {
  sourceConfigUri: vscode.Uri;
  pathFilter?: vscode.Uri;
  pathFilterIsFile?: boolean;
}

/**
 * Build a dry-run plan for a single source, optionally restricted to files
 * at or below a path filter. Returns an empty list when the source is not
 * found in the topology; returns a per-destination row with `skippedReason`
 * when the path filter doesn't fall within the source folder.
 */
export async function buildScopedDryRunPlan(
  topology: ResolvedTopology,
  opts: ScopedPlanOptions,
): Promise<PlanForDestination[]> {
  const source = topology.sources.find(
    (s) => s.configUri.toString() === opts.sourceConfigUri.toString(),
  );
  if (!source) return [];

  let scope: Scope = { kind: 'none' };
  if (opts.pathFilter) {
    const rel = relPathFromBase(source.sourceFolderUri.path, opts.pathFilter.path);
    if (rel === null) {
      // Path filter is outside the source folder — surface as skipped on
      // every destination row so the caller can render a clear message.
      return source.destinations.map((dest) => ({
        source,
        destination: dest,
        items: [],
        summary: summarisePlan([]),
        skippedReason: `path filter ${opts.pathFilter!.toString()} is not within source folder`,
      }));
    }
    const isFile = opts.pathFilterIsFile ?? (await pathIsFile(opts.pathFilter));
    scope = scopeFromRelPath(rel, isFile);
  }

  return planForSource(source, scope);
}

/**
 * Per-source plan body shared by the workspace-wide and scoped entry points.
 * Walks once for the source, once per destination, then applies the optional
 * scope filter to source/destination/manifest before classifying.
 */
async function planForSource(
  source: ResolvedSource,
  scope: Scope,
): Promise<PlanForDestination[]> {
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
    log(`sync: source walk failed for ${source.configUri.toString()} — ${errMsg(err)}`);
  }
  const scopedSourceFiles = filterFilesToScope(sourceFiles, scope);

  const results: PlanForDestination[] = [];
  for (const dest of source.destinations) {
    if (!dest.destRootUri || !dest.workspaceFolderUri) {
      results.push({
        source,
        destination: dest,
        items: [],
        summary: summarisePlan([]),
        skippedReason: `destination '${dest.name}' (${dest.uri}) is not in the workspace`,
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
    const scopedDestFiles = filterFilesToScope(destFiles, scope);

    // The manifest lives at the destination workspace folder root, not at
    // the subpath. A single workspace-folder destination shares one manifest
    // even when multiple sources write into different subpaths under it.
    const manifest = await readManifest(dest.workspaceFolderUri);
    const scopedManifest = filterManifestToScope(manifest, source.workspaceFolderName, scope);

    const items = classifyFiles(
      source.workspaceFolderName,
      scopedSourceFiles,
      scopedDestFiles,
      scopedManifest,
    );
    const summary = summarisePlan(items);
    results.push({ source, destination: dest, items, summary });
  }

  return results;
}

async function pathIsFile(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return !!(stat.type & vscode.FileType.File);
  } catch {
    return false;
  }
}

/**
 * Re-read the config so the planner can apply include/exclude. The manager
 * already validated it; here we just need the filter lists. Keeping this
 * inline avoids threading the parsed config through the topology type — the
 * source folder URI is stable and the file is small.
 */
async function loadConfigForSource(
  source: ResolvedSource,
): Promise<{ include: string[]; exclude: string[] } | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(source.configUri);
    const text = new TextDecoder().decode(bytes);
    const parsed = parseSyncConfigText(text);
    if (parsed.kind !== 'ok') return null;
    return { include: parsed.config.include, exclude: parsed.config.exclude };
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
