// URI hash cache (M5.2.5).
//
// Caches sha256 keyed by (uri, size, mtime). Two consumers benefit:
//   - The sync planner's destination walk avoids `readFile` entirely on
//     unchanged files: stat → cache lookup → done. 5–60× cheaper than read
//     on the FSA adapter, per the M5.2.5 probe results.
//   - The sync planner's source walk and the executor's pre-write verify
//     still read the bytes (validators / writes need them) but skip the
//     sha256 compute on cache hit — saves ~73% of the parse cost on the
//     137 MB deck per M5.2 timings.
//
// Two implementations share one interface:
//   - InMemoryHashCache (this file): bounded LRU map. Session-scoped.
//   - IndexedDbHashCache (./hashCacheIdb.ts): write-through over the
//     in-memory layer; survives browser refresh. Falls back to in-memory
//     only when IndexedDB isn't exposed in this host.
//
// Pure module: no vscode import, no Node import. Production passes
// `vscode.Uri` (whose `.toString()` is the de-facto canonical id);
// tests pass plain string URIs.

export interface UriHashCache<U = { toString(): string }> {
  lookup(uri: U, size: number, mtime: number): Promise<string | undefined>;
  record(uri: U, size: number, mtime: number, sha256: string): Promise<void>;
  forget(uri: U): Promise<void>;
  /** Diagnostics: entry count + hits/misses since construction. */
  stats(): HashCacheStats;

  /**
   * Walk-scoped batch read. Returns a synchronous Map<uriString, HashCacheEntry>
   * of every currently-cached entry.
   *
   * Callers that walk a known set of files should call snapshot() once at
   * walk start, consult the map per file via {@link snapshotHashLookup},
   * and fall through to {@link lookup} on snapshot miss. The entry's
   * size/mtime still need validation per-file (file may have changed since
   * snapshot was taken) — the lookup helper does that.
   *
   * Implementation cost:
   *   - In-memory tier: shallow copy of the internal map.
   *   - IDB tier: one `getAllEntries()` op — O(1) IDB op regardless of
   *     file count, vs O(N) for N per-file lookups.
   *
   * Snapshots are frozen at the moment they're returned. Discard at walk end.
   */
  snapshot(): Promise<Map<string, HashCacheEntry>>;
}

export interface HashCacheStats {
  entries: number;
  hits: number;
  misses: number;
  /** True when the cache is backed by IndexedDB (vs in-memory only). */
  idb: boolean;
}

/**
 * Cache entry. Size and mtime are part of the key, not the value; they're
 * also stored alongside the sha256 so the IDB tier can validate them on
 * lookup without a second lookup hop.
 */
export interface HashCacheEntry {
  size: number;
  mtime: number;
  sha256: string;
}

/**
 * Default upper bound on entry count. Tuned for "a few hundred decks" — the
 * dogfood workspace has ~30 .pptx, M5 design contemplates rooms up to ~100
 * files per destination, times ~5 destinations = 500. 5000 leaves headroom
 * without unbounded growth. Eviction is LRU on the in-memory map; the IDB
 * tier doesn't bound itself (browsers manage quota).
 */
export const DEFAULT_MAX_ENTRIES = 5_000;

// ───── LRU helpers (shared between in-memory and IDB-backed cache) ───────

/**
 * Look up an entry and bump it to MRU position. Returns undefined when the
 * key is missing OR when size/mtime don't match — both indicate "not the
 * same bytes" from the caller's perspective. The size guard catches the
 * rare mtime collision (e.g. atomic replace that preserves mtime).
 */
export function lruGet(
  map: Map<string, HashCacheEntry>,
  key: string,
  size: number,
  mtime: number,
): HashCacheEntry | undefined {
  const e = map.get(key);
  if (!e || e.size !== size || e.mtime !== mtime) return undefined;
  map.delete(key);
  map.set(key, e);
  return e;
}

/**
 * Insert or refresh an entry, evicting oldest entries until size is within
 * `maxEntries`. Map iteration order = insertion order (MRU last), so the
 * first key is the LRU.
 */
export function lruPut(
  map: Map<string, HashCacheEntry>,
  key: string,
  entry: HashCacheEntry,
  maxEntries: number,
): void {
  map.delete(key);
  map.set(key, entry);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

// ───── in-memory implementation ──────────────────────────────────────────

export interface InMemoryHashCacheOptions {
  /** Soft cap on entries. Defaults to {@link DEFAULT_MAX_ENTRIES}. */
  maxEntries?: number;
}

export class InMemoryHashCache<U extends { toString(): string } = { toString(): string }>
  implements UriHashCache<U>
{
  private readonly map = new Map<string, HashCacheEntry>();
  private hits = 0;
  private misses = 0;
  private readonly maxEntries: number;

  constructor(opts: InMemoryHashCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async lookup(uri: U, size: number, mtime: number): Promise<string | undefined> {
    const hit = lruGet(this.map, uri.toString(), size, mtime);
    if (hit) {
      this.hits++;
      return hit.sha256;
    }
    this.misses++;
    return undefined;
  }

  async record(uri: U, size: number, mtime: number, sha256: string): Promise<void> {
    lruPut(this.map, uri.toString(), { size, mtime, sha256 }, this.maxEntries);
  }

  async forget(uri: U): Promise<void> {
    this.map.delete(uri.toString());
  }

  async snapshot(): Promise<Map<string, HashCacheEntry>> {
    return new Map(this.map);
  }

  stats(): HashCacheStats {
    return {
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      idb: false,
    };
  }
}

// ───── snapshot-aware lookup helper ──────────────────────────────────────

/**
 * Walk-scoped lookup: consult the snapshot map first (validating
 * size/mtime — a snapshot entry with stale stat is treated as a miss).
 * On miss, fall through to the cache's per-call lookup so concurrent
 * additions mid-walk are observed.
 *
 * Hits served from the snapshot bypass `cache.stats().hits` — callers
 * tracking per-walk wins should compare elapsed wall-clock instead.
 */
export async function snapshotHashLookup<U extends { toString(): string }>(
  snapshot: Map<string, HashCacheEntry> | undefined,
  cache: UriHashCache<U> | undefined,
  uri: U,
  size: number,
  mtime: number,
): Promise<string | undefined> {
  if (snapshot) {
    const e = snapshot.get(uri.toString());
    if (e && e.size === size && e.mtime === mtime) return e.sha256;
  }
  if (cache) return cache.lookup(uri, size, mtime);
  return undefined;
}

// ───── module singleton ──────────────────────────────────────────────────
//
// Set at activation (extension.ts) once the cache is constructed (with or
// without an IDB tier). Read by planner.ts and runSync.ts to avoid
// threading the cache through every call site.
//
// Tests don't touch this — they construct `InMemoryHashCache` directly and
// pass it as an explicit argument to the cache-aware code under test.

let SINGLETON: UriHashCache | undefined;

export function setHashCacheSingleton(cache: UriHashCache | undefined): void {
  SINGLETON = cache;
}

export function getHashCacheSingleton(): UriHashCache | undefined {
  return SINGLETON;
}
