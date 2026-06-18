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

import { getHost, FileType } from './host';
import type { ResolvedSource, ResolvedDestination, ResolvedTopology } from './topology';
import type { AliasOrigin, FileInfo, PlanItem, PlanWarning } from './plan';
import { classifyFiles, summarisePlan, type PlanSummary } from './plan';
import { walkTree, type WalkEntry } from './walker';
import { hashFileAtUri } from './hash';
import {
  aliasesFromRecord,
  compileAliases,
  detectAliasCollisions,
  resolveAlias,
  type CompiledAlias,
} from './aliasResolve';
import {
  getHashCacheSingleton,
  type HashCacheEntry,
  type UriHashCache,
} from './hashCache';
import {
  getParseCacheSingleton,
  type CachedParseResult,
  type ParseResultCache,
} from './parseCache';
import { GlobSet, BUILT_IN_IGNORES } from './glob';
import { readManifest } from './manifest';
import { parseSyncConfigText } from './config';
import { expandRoomSyncVariable } from './configParse';
import { roomSyncHandle } from './configFilenames';
import {
  type Scope,
  filterFilesToScope,
  filterManifestToScope,
  relPathFromBase,
  scopeFromRelPath,
} from './scopedPlan';
import { isPptxPath, validatePptxBytes } from './validators';
import { log } from '../log';

export interface PlanForDestination<U> {
  source: ResolvedSource<U>;
  destination: ResolvedDestination<U>;
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
export async function buildDryRunPlan<U extends { toString(): string }>(
  topology: ResolvedTopology<U>,
  opts: BuildPlanOptions = {},
): Promise<PlanForDestination<U>[]> {
  const placeholders = opts.placeholders ?? new Set<string>();
  const results: PlanForDestination<U>[] = [];
  for (const source of topology.sources) {
    const planned = await planForSource(source, { kind: 'none' }, placeholders);
    results.push(...planned);
  }
  return results;
}

/**
 * Workspace-level options shared by the workspace-wide and scoped builders.
 *
 * `placeholders` is the effective set from the placeholder registry (default
 * empty-file sha + user entries from `.admin-sync.jsonc`). When omitted the
 * classifier annotates nothing — convenient for tests and callers that don't
 * care about the flag.
 */
export interface BuildPlanOptions {
  placeholders?: Set<string>;
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
export interface ScopedPlanOptions<U> {
  sourceConfigUri: U;
  pathFilter?: U;
  pathFilterIsFile?: boolean;
  /** See {@link BuildPlanOptions.placeholders}. */
  placeholders?: Set<string>;
}

/**
 * Build a dry-run plan for a single source, optionally restricted to files
 * at or below a path filter. Returns an empty list when the source is not
 * found in the topology; returns a per-destination row with `skippedReason`
 * when the path filter doesn't fall within the source folder.
 */
export async function buildScopedDryRunPlan<U extends { toString(): string }>(
  topology: ResolvedTopology<U>,
  opts: ScopedPlanOptions<U>,
): Promise<PlanForDestination<U>[]> {
  const source = topology.sources.find(
    (s) => s.configUri.toString() === opts.sourceConfigUri.toString(),
  );
  if (!source) return [];

  let scope: Scope = { kind: 'none' };
  if (opts.pathFilter) {
    const uri = getHost<U>().uri;
    const rel = relPathFromBase(uri.path(source.sourceFolderUri), uri.path(opts.pathFilter));
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

  return planForSource(source, scope, opts.placeholders ?? new Set<string>());
}

/**
 * Per-source plan body shared by the workspace-wide and scoped entry points.
 * Walks once for the source, once per destination, then applies the optional
 * scope filter to source/destination/manifest before classifying.
 */
async function planForSource<U extends { toString(): string }>(
  source: ResolvedSource<U>,
  scope: Scope,
  placeholders: Set<string>,
): Promise<PlanForDestination<U>[]> {
  // The yaml's include/exclude only ever apply to the source tree —
  // the destination walk uses built-ins plus the same user excludes so
  // we don't surface destination-only entries the user has chosen to
  // ignore.
  const yamlConfig = await loadConfigForSource(source);
  const sourceExclude = new GlobSet([...BUILT_IN_IGNORES, ...(yamlConfig?.exclude ?? [])]);
  const sourceInclude = new GlobSet(yamlConfig?.include ?? []);
  const destExclude = new GlobSet([...BUILT_IN_IGNORES, ...(yamlConfig?.exclude ?? [])]);
  const destInclude = new GlobSet([]); // include filter only meaningful on source

  // Path-aliases (M2 + M4 of room-sync-format-v1-plan.md): when present,
  // every source file's source-relative path goes through `resolveAlias` to
  // derive its destination-relative path. Files outside every LHS are
  // dropped (no implicit catch-all — opting into aliases is opting into
  // explicit sub-tree mapping). Empty record = legacy behaviour, file
  // relpaths flow through unchanged.
  //
  // M4: glob LHS patterns get compiled to anchored regexes with capture
  // groups; per-alias compile errors (e.g. RHS references more captures
  // than LHS provides) are logged and the offending alias is skipped —
  // other aliases in the same config keep working.
  let compiledAliases: CompiledAlias[] = [];
  if (yamlConfig?.pathAliases) {
    const rawAliases = aliasesFromRecord(yamlConfig.pathAliases);
    if (rawAliases.length > 0) {
      const { compiled, errors } = compileAliases(rawAliases);
      compiledAliases = compiled;
      for (const err of errors) {
        log(
          `sync: [alias-compile-error] ${displayConfigUri(source.configUri)}: ` +
            `"${err.alias.from}" → "${err.alias.to}" — ${err.message}`,
        );
      }
    }
  }

  // One cache instance shared across source + destination walks — the
  // singleton is initialised at activation; tests / no-cache contexts get
  // undefined and walkAndHash degrades to stat+read+hash.
  const cache = getHashCacheSingleton() as UriHashCache<U> | undefined;
  // Walk-scoped hash-cache snapshot. One IDB `getAllEntries()` here replaces
  // up to N+M per-file `lookup()` calls (N source files + M files per
  // destination, summed across destinations). The snapshot is frozen at
  // this moment; record() calls from per-file cache misses still go to the
  // underlying cache and are picked up by snapshotHashLookup's fallthrough.
  const hashSnapshot = cache ? await cache.snapshot() : undefined;
  if (hashSnapshot) {
    log(`sync: hash-cache snapshot: ${hashSnapshot.size} entr${hashSnapshot.size === 1 ? 'y' : 'ies'}`);
  }

  // Parse cache (M5.3 Phase C): only the source walk validates, so this is
  // only consulted there. Stats are deltas of the cache's own counters around
  // the walk — same pattern used by the URI hash cache, but at coarser scope
  // because parse-cache hits are pptx-only and per-pair source walk is paid
  // once. Singleton may be undefined in tests / unavailable IDB contexts;
  // validators degrade to plain parsePptx.
  const parseCache = getParseCacheSingleton();
  const parseBefore = snapshotParseStats(parseCache);

  // Walk-scoped snapshot of the parse cache. One IDB `getAll()` here replaces
  // up to N per-file `lookup()` round-trips inside the validator pass below.
  // On a 24-file source with all hits warm this was the 2.5s bottleneck;
  // snapshot collapses it to a single IDB op + N sync `Map.get` calls. The
  // snapshot is frozen at this moment — record() calls from validators on
  // misses still go to the underlying cache and are picked up by the
  // fallthrough in snapshotLookup.
  const parseSnapshot = parseCache ? await parseCache.snapshot() : undefined;
  if (parseSnapshot) {
    log(`sync: parse-cache snapshot: ${parseSnapshot.size} entr${parseSnapshot.size === 1 ? 'y' : 'ies'}`);
  }

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
        aliases: compiledAliases,
      },
      cache,
      sourceStats,
      parseCache,
      parseSnapshot,
      hashSnapshot,
    );
  } catch (err) {
    log(`sync: source walk failed for ${source.configUri.toString()} — ${errMsg(err)}`);
  }

  // Surface alias-driven dest-relpath collisions to the Output Channel.
  // Logged once per source walk (the rewrite is paid once, before fanning
  // out to destinations) — collisions are a config-level issue, not a
  // per-destination one. The user fixes them in `.roomSync`'s `path-aliases`.
  if (compiledAliases.length > 0) {
    const aliasCollisions = detectAliasCollisions(
      sourceFiles.map((f) => ({
        sourceRelPath: f.aliasOrigin?.sourceRelPath ?? f.relPath,
        destRelPath: f.relPath,
      })),
    );
    for (const c of aliasCollisions) {
      log(
        `sync: [alias-collision] ${displayConfigUri(source.configUri)}: ` +
          `multiple source files rewrite to "${c.destRelPath}" — ` +
          c.sourceRelPaths.join(', '),
      );
    }
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

  const results: PlanForDestination<U>[] = [];
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
        undefined, // destination walk doesn't validate, so no parse cache
        undefined, // ...and no parse snapshot either
        hashSnapshot,
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
      placeholders,
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

async function pathIsFile<U>(uri: U): Promise<boolean> {
  try {
    const stat = await getHost<U>().fs.stat(uri);
    return !!((stat.type ?? FileType.Unknown) & FileType.File);
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
async function loadConfigForSource<U>(
  source: ResolvedSource<U>,
): Promise<{ include: string[]; exclude: string[]; pathAliases: Record<string, string> } | null> {
  try {
    const { fs, uri } = getHost<U>();
    const bytes = await fs.readFile(source.configUri);
    let text = new TextDecoder().decode(bytes);
    // Resolve `${roomSync}` template tokens before parsing — same pre-parse
    // pass the manager-side loader applies. Keeps the planner's view
    // consistent with the topology already in scope.
    const handle = roomSyncHandle(uri.path(source.configUri), uri.path(source.workspaceFolderUri));
    text = expandRoomSyncVariable(text, handle);
    const parsed = parseSyncConfigText(text);
    if (parsed.kind !== 'ok') return null;
    return {
      include: parsed.config.include,
      exclude: parsed.config.exclude,
      pathAliases: parsed.config.pathAliases,
    };
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
  /**
   * Source-rewrite aliases, pre-compiled. When non-empty, each walked
   * entry's relpath is resolved through the alias list: matches are
   * rewritten with the alias provenance attached as `aliasOrigin`;
   * non-matches are dropped before hashing (no I/O cost for files outside
   * every LHS). Only meaningful on the source walk; the destination walk
   * leaves this empty.
   *
   * Compiled once per source by the planner (literal aliases stay on a
   * fast-path string compare; glob aliases use anchored regexes) and
   * reused for every walked file.
   */
  aliases?: readonly CompiledAlias[];
}

/** A walked entry, optionally with its source-rewrite provenance attached. */
interface WalkAlias<U> extends WalkEntry<U> {
  aliasOrigin?: AliasOrigin;
}

/**
 * Apply the alias rewrite to a freshly walked entry list. Empty alias list →
 * passthrough (legacy behaviour); non-empty list → drop entries with no match
 * and rewrite the surviving entries' relpath + aliasOrigin.
 */
function applyAliases<U>(
  entries: readonly WalkEntry<U>[],
  aliases: readonly CompiledAlias[],
): WalkAlias<U>[] {
  if (aliases.length === 0) return entries.slice();
  const out: WalkAlias<U>[] = [];
  for (const e of entries) {
    const match = resolveAlias(e.relPath, aliases);
    if (!match) continue;
    out.push({
      ...e,
      relPath: match.destRelPath,
      aliasOrigin: {
        sourceRelPath: e.relPath,
        from: match.alias.from,
        to: match.alias.to,
      },
    });
  }
  return out;
}

function displayConfigUri<U extends { toString(): string }>(configUri: U): string {
  const rel = getHost<U>().workspace.asRelativePath(configUri);
  return rel || configUri.toString();
}

async function walkAndHash<U extends { toString(): string }>(
  root: U,
  opts: WalkAndHashOpts,
  cache: UriHashCache<U> | undefined,
  stats: PlanHashCacheStats,
  parseCache?: ParseResultCache,
  parseSnapshot?: Map<string, CachedParseResult>,
  hashSnapshot?: Map<string, HashCacheEntry>,
): Promise<FileInfo[]> {
  const fs = getHost<U>().fs;
  const rawEntries = await walkTree(fs, root, opts);
  // Apply path-alias rewrite before we read any bytes — files outside every
  // LHS drop here, saving the read+hash for paths the user didn't opt in for.
  // Rewrite preserves URI (the file lives at its on-disk location); only the
  // relpath changes, and aliasOrigin carries the pre-rewrite path for the
  // plan-view tooltip.
  const entries: WalkAlias<U>[] = applyAliases(rawEntries, opts.aliases ?? []);
  const out: FileInfo[] = [];
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
      // Per-walk hit accounting: hashFileAtUri bumps the underlying cache's
      // stats on lookup-tier hits but a snapshot hit bypasses lookup, so
      // before/after delta on cache.stats wouldn't catch snapshot hits.
      // Diff our own counter against the path the call returned: if we
      // didn't have to read bytes (or we did, but the byte size matches
      // the cache key shape), we know we got a sha out without re-hashing.
      // Approximation: `bytes` undefined when needBytes=false and cache hit;
      // any other shape means a fresh hash compute happened.
      const beforeHits = cache?.stats().hits ?? 0;
      const result = await hashFileAtUri(fs, e.uri, cache, {
        needBytes,
        snapshot: hashSnapshot,
      });
      const afterHits = cache?.stats().hits ?? 0;
      const cacheHit = afterHits > beforeHits;
      const snapshotHit =
        !!hashSnapshot && hashSnapshot.get(e.uri.toString())?.sha256 === result.sha256;
      const wasHit = cacheHit || snapshotHit;
      stats.walked++;
      if (wasHit) {
        stats.hits++;
        if (!needBytes) stats.bytesSaved += result.size;
      } else {
        stats.misses++;
      }
      const info: FileInfo = {
        relPath: e.relPath,
        size: e.size,
        sha256: result.sha256,
        ...(e.aliasOrigin ? { aliasOrigin: e.aliasOrigin } : {}),
      };
      if (opts.validate && result.bytes) {
        // Pass sha256 + parseCache + parseSnapshot through. The snapshot
        // (when present) serves snapshot hits without an IDB round-trip;
        // parseCache is the per-file fallback for snapshot misses.
        const warnings = await runValidators(
          e.relPath,
          result.bytes,
          result.sha256,
          parseCache,
          parseSnapshot,
        );
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
  parseSnapshot: Map<string, CachedParseResult> | undefined,
): Promise<PlanWarning[]> {
  if (isPptxPath(relPath)) {
    try {
      return await validatePptxBytes(relPath, bytes, {
        sha256,
        cache: parseCache,
        snapshot: parseSnapshot,
      });
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
export function formatDryRunPlan<U extends { toString(): string }>(
  plans: readonly PlanForDestination<U>[],
): string {
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
    const srcPath = getHost().workspace.asRelativePath(plan.source.sourceFolderUri);
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
