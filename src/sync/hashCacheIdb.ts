// IndexedDB-backed URI hash cache (M5.2.5).
//
// Write-through over an in-memory LRU. On lookup:
//   1. In-memory map (fast).
//   2. IDB (one round-trip; warms the in-memory tier on hit).
//
// On record: insert into in-memory + put into IDB. Best-effort: IDB
// failures (quota, transient disconnect) are logged-and-swallowed so the
// sync run keeps going — the in-memory tier is the source of truth for
// the rest of the session.
//
// Falls back to plain in-memory if IDB is unavailable, via openHashCache.

import {
  DEFAULT_MAX_ENTRIES,
  InMemoryHashCache,
  lruGet,
  lruPut,
  type HashCacheEntry,
  type HashCacheStats,
  type UriHashCache,
} from './hashCache';
import {
  isIdbAvailable,
  openIdbStore,
  type IdbStore,
} from './idbAdapter';

const DB_NAME = 'folderSync.hashCache';
const STORE_NAME = 'uriHash';
const DB_VERSION = 1;

export interface IdbHashCacheOptions {
  /** Soft cap on the in-memory tier. IDB tier is bounded by browser quota. */
  maxEntries?: number;
  /**
   * Injectable for tests — defaults to {@link openIdbStore}. Test seam:
   * pass a fake IdbStore-returning factory to exercise the lookup/record
   * paths without a real IndexedDB.
   */
  open?: () => Promise<IdbStore<HashCacheEntry>>;
}

export class IndexedDbHashCache<U extends { toString(): string } = { toString(): string }>
  implements UriHashCache<U>
{
  private readonly map = new Map<string, HashCacheEntry>();
  private hits = 0;
  private misses = 0;
  private readonly maxEntries: number;
  private readonly store: IdbStore<HashCacheEntry>;

  private constructor(store: IdbStore<HashCacheEntry>, maxEntries: number) {
    this.store = store;
    this.maxEntries = maxEntries;
  }

  static async open<U extends { toString(): string }>(
    opts: IdbHashCacheOptions = {},
  ): Promise<IndexedDbHashCache<U>> {
    const opener =
      opts.open ??
      (() =>
        openIdbStore<HashCacheEntry>({
          dbName: DB_NAME,
          storeName: STORE_NAME,
          version: DB_VERSION,
        }));
    const store = await opener();
    return new IndexedDbHashCache<U>(store, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  async lookup(uri: U, size: number, mtime: number): Promise<string | undefined> {
    const key = uri.toString();
    const memHit = lruGet(this.map, key, size, mtime);
    if (memHit) {
      this.hits++;
      return memHit.sha256;
    }
    // Cross the IDB boundary. A miss here is a real "we don't have it"; we
    // count the miss only after both tiers have been consulted, so the
    // stats line tells the user where the second-tier wins land.
    let stored: HashCacheEntry | undefined;
    try {
      stored = await this.store.get(key);
    } catch {
      stored = undefined;
    }
    if (stored && stored.size === size && stored.mtime === mtime) {
      // Warm the in-memory tier so subsequent same-session lookups skip IDB.
      lruPut(this.map, key, stored, this.maxEntries);
      this.hits++;
      return stored.sha256;
    }
    this.misses++;
    return undefined;
  }

  async record(uri: U, size: number, mtime: number, sha256: string): Promise<void> {
    const key = uri.toString();
    const entry: HashCacheEntry = { size, mtime, sha256 };
    lruPut(this.map, key, entry, this.maxEntries);
    try {
      await this.store.put(key, entry);
    } catch {
      // Tolerate IDB write failure. The in-memory tier carries us for this
      // session; the next session does a cold rebuild. Acceptable given
      // this is purely a perf optimization.
    }
  }

  async forget(uri: U): Promise<void> {
    const key = uri.toString();
    this.map.delete(key);
    try {
      await this.store.delete(key);
    } catch {
      /* ignore */
    }
  }

  /**
   * Single getAllEntries() snapshot. Bypasses the in-memory LRU tier on
   * both read and write: we don't want a 5000-entry snapshot to evict
   * useful tenants from the bounded LRU. The snapshot map is the bounded
   * structure for the duration of the walk.
   */
  async snapshot(): Promise<Map<string, HashCacheEntry>> {
    let entries: Array<[string, HashCacheEntry]>;
    try {
      entries = await this.store.getAllEntries();
    } catch {
      // IDB failure — return whatever the in-memory tier knows. Better than
      // throwing; per-call lookup() still works for snapshot misses.
      return new Map(this.map);
    }
    const out = new Map<string, HashCacheEntry>();
    for (const [k, v] of entries) out.set(k, v);
    return out;
  }

  stats(): HashCacheStats {
    return {
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      idb: true,
    };
  }

  /**
   * Diagnostic: count of entries currently in the IDB store. Used by the
   * activation log to surface "warmed cache picks up where last session
   * left off". Best-effort — returns 0 on failure rather than rejecting.
   */
  async idbEntryCount(): Promise<number> {
    try {
      return await this.store.count();
    } catch {
      return 0;
    }
  }
}

/**
 * Factory used at activation. Returns an IDB-backed cache when IndexedDB
 * is reachable; falls back to in-memory when it isn't (or when opening the
 * database fails). Either way the caller gets a working `UriHashCache`.
 */
export async function openHashCache<U extends { toString(): string } = { toString(): string }>(
  maxEntries?: number,
): Promise<{
  cache: UriHashCache<U>;
  idb: boolean;
  warmEntries: number;
}> {
  if (!isIdbAvailable()) {
    return {
      cache: new InMemoryHashCache<U>({ maxEntries }),
      idb: false,
      warmEntries: 0,
    };
  }
  try {
    const idb = await IndexedDbHashCache.open<U>({ maxEntries });
    const warm = await idb.idbEntryCount();
    return { cache: idb, idb: true, warmEntries: warm };
  } catch {
    return {
      cache: new InMemoryHashCache<U>({ maxEntries }),
      idb: false,
      warmEntries: 0,
    };
  }
}
