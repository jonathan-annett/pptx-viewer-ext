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
import type { FileInfo, PlanItem, PlanWarning } from './plan';
import { classifyFiles, summarisePlan, type PlanSummary } from './plan';
import { walkTree } from './walker';
import { hashFileAtUri } from './hash';
import { getHashCacheSingleton, type UriHashCache } from './hashCache';
import { getParseCacheSingleton, type ParseResultCache } from './parseCache';
import { vscodeFs } from './vscodeFs';
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
import { isPptxPath, validatePptxBytes } from './validators';
import { log } from '../log';

export interface PlanForDestination {
  source: ResolvedSource;
  destination: ResolvedDestination;
  items: PlanItem[];
  summary: PlanSummary;
  /** Sources that couldn't be walked (e.g. destination root URI absent). */
  skippedReason?: string;
  /**
   * URI hash cache diagnostics for this plan build (M5.2.5). Counted across
   * the source walk + destination walk for this pair. `bytesSaved` is the
   * sum of file sizes for which we got a cache hit and skipped the read
   * entirely (destination walk only — source-walk hits still read for
   * validation).
   */
  hashCacheStats?: PlanHashCacheStats;
  /**
   * Parse cache diagnostics for this plan build (M5.3 Phase C). Counted across
   * the source walk only — the destination walk skips validation and so never
   * touches the parse cache. Same delta is reported on every destination row
   * derived from the same source walk (the cost is paid once, surfaced N).
   */
  parseCacheStats?: PlanParseCacheStats;
}

export interface PlanHashCacheStats {
  /** Total files inspected across source + destination walks. */
  walked: number;
  /** Number where the cache served the sha256 (read or hash skipped). */
  hits: number;
  /** Number where the cache had to be populated (read + hash). */
  misses: number;
  /** Sum of `size` for files where the cache made the read unnecessary. */
  bytesSaved: number;
}

export interface PlanParseCacheStats {
  /** Cache hits served during this walk (no unzip + scan). */
  hits: number;
  /** Misses: validator parsed and recorded into the cache. */
  misses: number;
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

  // One cache instance shared across source + destination walks — the
  // singleton is initialised at activation; tests / no-cache contexts get
  // undefined and walkAndHash degrades to stat+read+hash.
  const cache = getHashCacheSingleton() as UriHashCache<vscode.Uri> | undefined;

  // Parse cache (M5.3 Phase C): only the source walk validates, so this is
  // only consulted there. Stats are deltas of the cache's own counters around
  // the walk — same pattern used by the URI hash cache, but at coarser scope
  // because parse-cache hits are pptx-only and per-pair source walk is paid
  // once. Singleton may be undefined in tests / unavailable IDB contexts;
  // validators degrade to plain parsePptx.
  const parseCache = getParseCacheSingleton();
  const parseBefore = snapshotParseStats(parseCache);

  let sourceFiles: FileInfo[] = [];
  const sourceStats = freshStats();
  try {
    sourceFiles = await walkAndHash(
      source.sourceFolderUri,
      {
        exclude: sourceExclude,
        include: sourceInclude,
        // Source walk validates each known file type from the same bytes used
        // for hashing — one read per source file, validators see the same content
        // we will (or won't) sync.
        validate: true,
      },
      cache,
      sourceStats,
      parseCache,
    );
  } catch (err) {
    log(`sync: source walk failed for ${source.configUri.toString()} — ${errMsg(err)}`);
  }
  const scopedSourceFiles = filterFilesToScope(sourceFiles, scope);

  // Compute per-source-walk parse-cache delta. Logged once per source (the
  // source walk happens once even when fanning out to multiple destinations);
  // the same numbers are attached to every PlanForDestination derived from
  // this walk so the webview can surface them per row.
  const parseStats = deltaParseStats(parseBefore, snapshotParseStats(parseCache));
  if (parseCache && parseStats.hits + parseStats.misses > 0) {
    const total = parseStats.hits + parseStats.misses;
    const sourceLabel = source.workspaceFolderName;
    log(`sync: parse-cache: ${parseStats.hits}/${total} on ${sourceLabel}`);
  }

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
    const destStats = freshStats();
    try {
      destFiles = await walkAndHash(
        dest.destRootUri,
        {
          exclude: destExclude,
          include: destInclude,
        },
        cache,
        destStats,
      );
    } catch (err) {
      log(`sync: destination walk failed for ${dest.destRootUri.toString()} — ${errMsg(err)}`);
    }
    const scopedDestFiles = filterFilesToScope(destFiles, scope);

    // The manifest lives at the destination workspace folder root, not at
    // the subpath. A single workspace-folder destination shares one manifest
    // even when multiple sources write into different subpaths under it.
    const manifestResult = await readManifest(dest.workspaceFolderUri);
    if (manifestResult.kind === 'version-mismatch') {
      // Refuse to plan this destination — sync would overwrite an unknown
      // schema. Surface as a skipped row so the plan webview / Output
      // Channel reports it; runSync skips the destination too (it re-reads
      // the manifest there for the same reason).
      results.push({
        source,
        destination: dest,
        items: [],
        summary: summarisePlan([]),
        skippedReason:
          `manifest at ${dest.workspaceFolderUri.toString()} has unsupported version ` +
          `${String(manifestResult.actual)} (extension supports version 1)`,
      });
      continue;
    }
    const manifest = manifestResult.manifest;
    const scopedManifest = filterManifestToScope(manifest, source.workspaceFolderName, scope);

    const items = classifyFiles(
      source.workspaceFolderName,
      scopedSourceFiles,
      scopedDestFiles,
      scopedManifest,
    );
    const summary = summarisePlan(items);
    // Diagnostics: merge the source-walk stats (paid once for this pair) with
    // this destination's walk stats. The destination walk is the multiplier;
    // surfacing it per-destination lets the user see where the wins land.
    const pairStats: PlanHashCacheStats = mergeStats(sourceStats, destStats);
    if (cache) {
      log(
        `sync: hash-cache: ${destStats.hits}/${destStats.walked} on ` +
          `${dest.name}${dest.subpath ? `/${dest.subpath}` : ''}` +
          (destStats.bytesSaved > 0 ? ` (saved ${destStats.bytesSaved} bytes)` : ''),
      );
    }
    results.push({
      source,
      destination: dest,
      items,
      summary,
      hashCacheStats: pairStats,
      parseCacheStats: parseCache ? { ...parseStats } : undefined,
    });
  }

  return results;
}

function freshStats(): PlanHashCacheStats {
  return { walked: 0, hits: 0, misses: 0, bytesSaved: 0 };
}

function snapshotParseStats(cache: ParseResultCache | undefined): { hits: number; misses: number } {
  if (!cache) return { hits: 0, misses: 0 };
  const s = cache.stats();
  return { hits: s.hits, misses: s.misses };
}

function deltaParseStats(
  before: { hits: number; misses: number },
  after: { hits: number; misses: number },
): PlanParseCacheStats {
  return {
    hits: after.hits - before.hits,
    misses: after.misses - before.misses,
  };
}

function mergeStats(a: PlanHashCacheStats, b: PlanHashCacheStats): PlanHashCacheStats {
  return {
    walked: a.walked + b.walked,
    hits: a.hits + b.hits,
    misses: a.misses + b.misses,
    bytesSaved: a.bytesSaved + b.bytesSaved,
  };
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
  /**
   * When true, run per-filetype validators against each file's bytes during
   * the walk. Reuses the bytes already in scope for hashing — no second read.
   * Only meaningful on the source walk; the destination walk leaves this off.
   */
  validate?: boolean;
}

async function walkAndHash(
  root: vscode.Uri,
  opts: WalkAndHashOpts,
  cache: UriHashCache<vscode.Uri> | undefined,
  stats: PlanHashCacheStats,
  parseCache?: ParseResultCache,
): Promise<FileInfo[]> {
  const entries = await walkTree(root, opts);
  const out: FileInfo[] = [];
  const fs = vscodeFs();
  for (const e of entries) {
    try {
      // Source walk needs bytes for the per-filetype validator pass; the
      // destination walk doesn't, so passing needBytes=opts.validate gives
      // the read-skip win on the destination side without sacrificing
      // validation coverage on the source side.
      //
      // Even with needBytes=true, a cache hit still skips the sha256
      // compute — that's a non-trivial saving on big decks (~73% of the
      // parse cost on the 137MB sample per M5.2 timings).
      const needBytes = !!opts.validate;
      // Snapshot cache stats before the call so we can tell hit vs miss.
      // hashFileAtUri internally bumps the cache's hit/miss counter — but
      // we want our own per-walk accounting that includes "no cache"
      // calls (which never count as hits). Use a simple before/after
      // delta on the cache's stats when one is present.
      const beforeHits = cache?.stats().hits ?? 0;
      const result = await hashFileAtUri(fs, e.uri, cache, { needBytes });
      const afterHits = cache?.stats().hits ?? 0;
      const wasHit = afterHits > beforeHits;
      stats.walked++;
      if (wasHit) {
        stats.hits++;
        if (!needBytes) stats.bytesSaved += result.size;
      } else {
        stats.misses++;
      }
      const info: FileInfo = { relPath: e.relPath, size: e.size, sha256: result.sha256 };
      if (opts.validate && result.bytes) {
        // Pass sha256 + parseCache through so the pptx validator can use the
        // content-hashed cache instead of re-parsing on every plan build.
        const warnings = await runValidators(e.relPath, result.bytes, result.sha256, parseCache);
        if (warnings.length > 0) info.warnings = warnings;
      }
      out.push(info);
    } catch (err) {
      log(`sync: failed to read ${e.uri.toString()} — ${errMsg(err)} (skipping)`);
    }
  }
  return out;
}

/**
 * Dispatch a file to its validator(s) based on path. Today this is pptx-only;
 * future filetype validators slot in here. Validation errors are swallowed —
 * a validator that itself fails should not block the plan, only its warnings
 * are missing. Logged for diagnostics.
 */
async function runValidators(
  relPath: string,
  bytes: Uint8Array,
  sha256: string,
  parseCache: ParseResultCache | undefined,
): Promise<PlanWarning[]> {
  if (isPptxPath(relPath)) {
    try {
      return await validatePptxBytes(relPath, bytes, { sha256, cache: parseCache });
    } catch (err) {
      log(`sync: validator failed for ${relPath} — ${errMsg(err)} (continuing without warnings)`);
      return [];
    }
  }
  return [];
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
