// Content-hashed parse cache (M5.3 Phase A — in-memory tier).
//
// Sits behind the URI hash cache (M5.2.5): a caller that already has the
// bytes can compute sha256 once and skip the unzip + scan + validator work
// on a hit. Cache hits return a hydrated ParseResult — content-determined
// fields come from the cache, per-open display fields (fileName, mtime,
// sizeHuman, mtimeHuman) are composed fresh from the caller's FileInfo so
// the same bytes opened under a different name render correctly.
//
// Three primary consumers planned for M5.3:
//   - Pptx viewer open / ingest / refresh (Phase A — this commit).
//   - Sync source validator pass in planner.ts (Phase C).
//   - Sync destination identity check, enabled by the identity store
//     populated from destination walks (Phase D).
//
// Pure module: no vscode import. Tests pass synthetic bytes + the cache
// directly under tsx.

import { formatTime, humanSize, parsePptx, type FileInfo, type ParseResult } from '../pptx';
import { sha256Hex } from './hash';

/**
 * The subset of ParseResult that is purely a function of the input bytes.
 * Same bytes → same value, forever — that's what makes this safe to cache
 * by sha256 with no invalidation.
 *
 * Excluded from cache (composed fresh per call from FileInfo):
 *   - fileName, size, sizeHuman, mtime, mtimeHuman
 *   - timings (informational; absent on a cache hit is the truthful answer —
 *     "this call didn't parse")
 */
export type CachedParseResult = Omit<
  ParseResult,
  'fileName' | 'size' | 'sizeHuman' | 'mtime' | 'mtimeHuman' | 'timings'
>;

export interface ParseResultCache {
  lookup(sha256: string): Promise<CachedParseResult | undefined>;
  record(sha256: string, value: CachedParseResult): Promise<void>;
  forget(sha256: string): Promise<void>;
  stats(): ParseCacheStats;

  /**
   * Walk-scoped batch read. Returns a synchronous Map<sha, CachedParseResult>
   * with every currently-cached parse-data entry.
   *
   * Callers that walk a known set of files should call snapshot() once at
   * walk start, consult the map per file via {@link snapshotLookup}, and
   * fall through to {@link lookup} on snapshot miss so concurrent additions
   * by another caller mid-walk are still observed.
   *
   * Implementation cost:
   *   - In-memory tier: shallow copy of the internal map.
   *   - IDB tier: one `getAll()` per store (results + thumbnails), then
   *     join — O(2) IDB ops regardless of file count, vs O(2N) for N
   *     per-file lookups under the old pattern.
   *
   * Snapshots are frozen at the moment they're returned — record()/forget()
   * after snapshot() do not retroactively update the map. Discard at walk
   * end. Identity-only records (no `flags`) are excluded; this snapshot is
   * for full parse-data hits, mirroring lookup()'s contract.
   *
   * **Thumbnails are omitted from IDB-backed snapshots.** The thumbnail
   * store is keyed externally and joining it would require a separate read.
   * Callers that need thumbnails (viewer-open path) should use
   * {@link lookup} instead — they're not part of any walk hot path. Snapshot
   * consumers (validators) only read `flags` and `parseError`. In-memory
   * snapshots include whatever thumbnails are present in the map (free
   * because they're already in memory).
   */
  snapshot(): Promise<Map<string, CachedParseResult>>;

  /**
   * Identity index lookup (M5.3 Phase D). Returns the list of rel-paths
   * where this content (sha256) has been observed via `recordIdentity`,
   * or undefined when no observations are recorded. Independent of the
   * parse-data cache: an "identity-only" record (no full parse data
   * cached) still resolves here.
   *
   * The planner uses this on source walks to detect misfiled content —
   * when bytes appear at a rel-path different from one or more known
   * rel-paths in the same destination, the file gets a
   * `misfiled-content` warning.
   */
  lookupIdentity(sha256: string): Promise<string[] | undefined>;

  /**
   * Record that `sha256` was observed at `relPath` (M5.3 Phase D).
   * Idempotent: repeated calls with the same (sha, relPath) don't add
   * duplicates. Implementations preserve any existing parse data for the
   * sha; this is purely an identity-index update.
   *
   * Called by destination walks for content-addressed filetypes (.pptx
   * today) to build the index that source walks consult for misfile
   * detection.
   */
  recordIdentity(sha256: string, relPath: string): Promise<void>;
}

export interface ParseCacheStats {
  entries: number;
  hits: number;
  misses: number;
  /** True when the cache is IDB-backed (Phase B); false for plain in-memory. */
  idb: boolean;
}

/**
 * In-memory LRU bound. ParseResults are heavier than UriHashCache entries
 * because of the thumbnail data URL, so the default is more conservative.
 * Phase B's IDB tier doesn't bound itself (browser quota wins).
 *
 * Rough sizing: the M5.2 timing run showed thumbnails up to ~200 KB as data
 * URLs. 200 entries × 200 KB ≈ 40 MB worst case. Tuneable via the
 * InMemoryParseCache constructor.
 */
export const DEFAULT_MAX_ENTRIES = 200;

// ───── LRU helpers (mirror hashCache.ts shape so the IDB tier in Phase B
// can reuse them across both caches). Stored separately from hashCache's
// helpers because the entry type differs.

export function lruGet<V>(
  map: Map<string, V>,
  key: string,
): V | undefined {
  const e = map.get(key);
  if (!e) return undefined;
  // Bump to MRU position.
  map.delete(key);
  map.set(key, e);
  return e;
}

export function lruPut<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  maxEntries: number,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

// ───── in-memory implementation ──────────────────────────────────────────

export interface InMemoryParseCacheOptions {
  maxEntries?: number;
}

export class InMemoryParseCache implements ParseResultCache {
  private readonly map = new Map<string, CachedParseResult>();
  /**
   * Identity index (M5.3 Phase D): rel-paths where each sha has been
   * observed. Lives alongside `map` rather than baked into CachedParseResult
   * because identity entries can exist for content that has never been
   * fully parsed (destination-walk observations).
   */
  private readonly identityMap = new Map<string, string[]>();
  private hits = 0;
  private misses = 0;
  private readonly maxEntries: number;

  constructor(opts: InMemoryParseCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async lookup(sha256: string): Promise<CachedParseResult | undefined> {
    const hit = lruGet(this.map, sha256);
    if (hit) {
      this.hits++;
      return hit;
    }
    this.misses++;
    return undefined;
  }

  async record(sha256: string, value: CachedParseResult): Promise<void> {
    lruPut(this.map, sha256, value, this.maxEntries);
  }

  async forget(sha256: string): Promise<void> {
    this.map.delete(sha256);
    this.identityMap.delete(sha256);
  }

  async snapshot(): Promise<Map<string, CachedParseResult>> {
    // Shallow copy — frozen at call time per the interface contract.
    return new Map(this.map);
  }

  stats(): ParseCacheStats {
    return { entries: this.map.size, hits: this.hits, misses: this.misses, idb: false };
  }

  async lookupIdentity(sha256: string): Promise<string[] | undefined> {
    const list = this.identityMap.get(sha256);
    if (!list || list.length === 0) return undefined;
    return [...list];
  }

  async recordIdentity(sha256: string, relPath: string): Promise<void> {
    const current = this.identityMap.get(sha256);
    if (!current) {
      this.identityMap.set(sha256, [relPath]);
      return;
    }
    if (current.includes(relPath)) return;
    current.push(relPath);
  }
}

// ───── parsePptxCached — public wrapper ─────────────────────────────────

/**
 * Result of a cached parse. `cacheHit` is informational — useful for the
 * per-file log line ("(cached)" suffix) and per-phase diagnostics.
 */
export interface CachedParseOutcome {
  result: ParseResult;
  cacheHit: boolean;
  /** Wall-clock ms spent inside the wrapper. Includes sha256 + lookup time
   *  on hits; includes the underlying parsePptx call on misses. */
  totalMs: number;
}

/**
 * Cache-aware parse entrypoint. Behaviour:
 *
 *   - No cache supplied: fall through to parsePptx unchanged.
 *   - Cache supplied + hit: hydrate the cached content-determined fields
 *     with per-open display fields from `info`. No unzip, no scan.
 *   - Cache supplied + miss: call parsePptx, record the content fields,
 *     return the full ParseResult.
 *
 * The sha256 paid on a miss is also computed inside parsePptx as its first
 * phase. We accept the double-hash on miss to keep parsePptx unchanged;
 * the hit path (where the cache earns its keep) hashes once and returns.
 */
export async function parsePptxCached(
  bytes: Uint8Array,
  info: FileInfo,
  cache?: ParseResultCache,
): Promise<CachedParseOutcome> {
  const t0 = performance.now();
  // Zero-byte short-circuit. parsePptx handles this in O(1) without any
  // hash compute; we route around the IDB lookup entirely so the placeholder
  // viewer-open path doesn't wait on a backing store at all. cacheHit is
  // reported as true because no work was done in the wrapper — the result
  // is constant-folded from `info`.
  if (bytes.length === 0) {
    const result = await parsePptx(bytes, info);
    return { result, cacheHit: true, totalMs: performance.now() - t0 };
  }
  if (!cache) {
    const result = await parsePptx(bytes, info);
    return { result, cacheHit: false, totalMs: performance.now() - t0 };
  }
  const sha = await sha256Hex(bytes);
  const cached = await cache.lookup(sha);
  if (cached) {
    return {
      result: hydrate(cached, info),
      cacheHit: true,
      totalMs: performance.now() - t0,
    };
  }
  const result = await parsePptx(bytes, info);
  // parsePptx computes its own sha256; we just confirmed they agree by
  // construction (same bytes), so use result.sha256 as the canonical key.
  await cache.record(result.sha256, project(result));
  return { result, cacheHit: false, totalMs: performance.now() - t0 };
}

/**
 * Build the in-cache payload from a fresh ParseResult. Drops the per-open
 * display fields and the timings (informational; absent on hit is correct).
 */
export function project(r: ParseResult): CachedParseResult {
  return {
    sha256: r.sha256,
    slideCount: r.slideCount,
    hiddenSlideCount: r.hiddenSlideCount,
    author: r.author,
    lastModifiedBy: r.lastModifiedBy,
    embeddedMedia: r.embeddedMedia,
    mediaFiles: r.mediaFiles,
    thumbnail: r.thumbnail,
    // synthesisHint is content-determined (same bytes → same hint) so it
    // belongs in the cache alongside the rest of the parsed fields. The
    // webview reads it to decide whether to render a fallback thumbnail.
    synthesisHint: r.synthesisHint,
    // firstVisibleSlideText is content-determined too (same bytes → same
    // text). Lands in the cache so search-index population on a cache
    // hit doesn't have to re-unzip + re-scan to recover this field.
    firstVisibleSlideText: r.firstVisibleSlideText,
    flags: r.flags,
    parseError: r.parseError,
  };
}

/**
 * Compose a ParseResult from a cached payload + per-open FileInfo. Display
 * fields (fileName, size/sizeHuman, mtime/mtimeHuman) come from `info`;
 * everything content-determined comes from the cache.
 */
export function hydrate(c: CachedParseResult, info: FileInfo): ParseResult {
  return {
    fileName: info.fileName,
    size: info.size,
    sizeHuman: humanSize(info.size),
    mtime: info.mtime,
    mtimeHuman: formatTime(info.mtime),
    sha256: c.sha256,
    slideCount: c.slideCount,
    hiddenSlideCount: c.hiddenSlideCount,
    author: c.author,
    lastModifiedBy: c.lastModifiedBy,
    embeddedMedia: c.embeddedMedia,
    mediaFiles: c.mediaFiles,
    thumbnail: c.thumbnail,
    synthesisHint: c.synthesisHint,
    firstVisibleSlideText: c.firstVisibleSlideText,
    flags: c.flags,
    parseError: c.parseError,
    // timings deliberately omitted on a cache hit — see CachedParseResult.
  };
}

// ───── snapshot-aware lookup helper ──────────────────────────────────────

/**
 * Walk-scoped lookup: consult the snapshot map first; on miss, fall through
 * to the cache's per-call lookup so concurrent additions mid-walk are still
 * observed. Pass `cache: undefined` to disable the fallback (snapshot-only).
 *
 * Hits served from the snapshot bypass `cache.stats().hits` — they didn't
 * touch the underlying tier. Callers tracking per-walk wins should compare
 * elapsed wall-clock instead.
 *
 * `snapshot: undefined` degenerates to plain `cache.lookup(sha)` — useful
 * for callers that share a code path between walks (snapshot known) and
 * one-off lookups (snapshot unavailable).
 */
export async function snapshotLookup(
  snapshot: Map<string, CachedParseResult> | undefined,
  cache: ParseResultCache | undefined,
  sha256: string,
): Promise<CachedParseResult | undefined> {
  if (snapshot) {
    const hit = snapshot.get(sha256);
    if (hit) return hit;
  }
  if (cache) return cache.lookup(sha256);
  return undefined;
}

// ───── module singleton ──────────────────────────────────────────────────

let SINGLETON: ParseResultCache | undefined;

export function setParseCacheSingleton(cache: ParseResultCache | undefined): void {
  SINGLETON = cache;
}

export function getParseCacheSingleton(): ParseResultCache | undefined {
  return SINGLETON;
}
