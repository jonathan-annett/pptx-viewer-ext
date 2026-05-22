// IndexedDB-backed parse cache (M5.3 Phase B).
//
// Write-through over an in-memory LRU. On lookup:
//   1. In-memory map (fast).
//   2. IDB — two parallel fetches:
//      - parseResults[sha]  → content-determined fields (no thumbnail)
//      - thumbnails[sha]    → thumbnail data URL, if present
//      Reassembled into CachedParseResult and warmed into the in-memory tier.
//
// On record: insert in-memory, then write the parseResult (sans thumbnail)
// and the thumbnail (if any) to their respective IDB stores. Best-effort:
// IDB failures (quota, transient disconnect) are logged-and-swallowed.
//
// Schema rationale — two object stores:
//
//   parseResults: dense metadata. Cheap to enumerate, no megabyte-scale
//   payloads. The Phase D identity store will piggyback on this — every
//   sha256 known to the cache is "content we've seen", regardless of
//   whether it carried a thumbnail.
//
//   thumbnails: heavy data URLs (up to ~200KB). Split out so future
//   memory-pressure handling can drop just the thumbnail and keep the
//   cheap metadata/validation results hot. Today's behaviour is dumb-
//   simple: always fetch both on lookup; always write both on record.
//
// An absent thumbnails[sha] when parseResults[sha] is present means
// "this content has no thumbnail" (e.g. the Pfleger sample). It does
// not mean "thumbnail evicted" — there's no eviction in the IDB tier.
//
// Falls back to plain in-memory if IDB is unavailable, via openParseCache.

import {
  DEFAULT_MAX_ENTRIES,
  InMemoryParseCache,
  lruGet,
  lruPut,
  type CachedParseResult,
  type ParseCacheStats,
  type ParseResultCache,
} from './parseCache';
import {
  isIdbAvailable,
  openIdbStore,
  type IdbStore,
} from './idbAdapter';
import type { Thumbnail } from '../pptx';

const DB_NAME = 'folderSync.parseCache';
const RESULTS_STORE = 'parseResults';
const THUMBNAILS_STORE = 'thumbnails';
const DB_VERSION = 1;

/**
 * IDB payload for the parseResults store. Identical to CachedParseResult
 * minus the thumbnail (which lives in the thumbnails store). Exported so
 * tests can construct fake IdbStores with the correct value type.
 */
export type ParseResultRecord = Omit<CachedParseResult, 'thumbnail'>;

export interface IdbParseCacheOptions {
  /** Soft cap on the in-memory tier. IDB tier is bounded by browser quota. */
  maxEntries?: number;
  /**
   * Injectable for tests — defaults to opening real IDB stores via
   * {@link openIdbStore}. Test seam: pass a fake-returning factory to
   * exercise lookup/record paths without a real IndexedDB.
   */
  openResults?: () => Promise<IdbStore<ParseResultRecord>>;
  openThumbnails?: () => Promise<IdbStore<Thumbnail>>;
}

export class IndexedDbParseCache implements ParseResultCache {
  private readonly map = new Map<string, CachedParseResult>();
  private hits = 0;
  private misses = 0;
  private readonly maxEntries: number;
  private readonly resultsStore: IdbStore<ParseResultRecord>;
  private readonly thumbnailsStore: IdbStore<Thumbnail>;

  private constructor(
    resultsStore: IdbStore<ParseResultRecord>,
    thumbnailsStore: IdbStore<Thumbnail>,
    maxEntries: number,
  ) {
    this.resultsStore = resultsStore;
    this.thumbnailsStore = thumbnailsStore;
    this.maxEntries = maxEntries;
  }

  static async open(opts: IdbParseCacheOptions = {}): Promise<IndexedDbParseCache> {
    const openResults =
      opts.openResults ??
      (() =>
        openIdbStore<ParseResultRecord>({
          dbName: DB_NAME,
          storeName: RESULTS_STORE,
          version: DB_VERSION,
        }));
    const openThumbnails =
      opts.openThumbnails ??
      (() =>
        openIdbStore<Thumbnail>({
          dbName: DB_NAME,
          storeName: THUMBNAILS_STORE,
          version: DB_VERSION,
        }));
    // Two opens against the same DB at the same version. The first open
    // creates the database with both stores via onupgradeneeded; the second
    // sees the existing version. Sequenced rather than parallel because
    // running two concurrent open requests at the same DB_VERSION can race
    // the upgrade transaction in some browsers (Safari has been observed
    // to reject the second one as "blocked").
    const results = await openResults();
    const thumbnails = await openThumbnails();
    return new IndexedDbParseCache(results, thumbnails, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  async lookup(sha256: string): Promise<CachedParseResult | undefined> {
    const memHit = lruGet(this.map, sha256);
    if (memHit) {
      this.hits++;
      return memHit;
    }
    // Cross the IDB boundary. We fetch both stores in parallel — a hit on
    // parseResults but a miss on thumbnails is the "content has no
    // thumbnail" case (not an error). A miss on parseResults means we
    // never cached this sha — ignore any orphan thumbnail entry.
    let result: ParseResultRecord | undefined;
    let thumbnail: Thumbnail | undefined;
    try {
      [result, thumbnail] = await Promise.all([
        this.resultsStore.get(sha256),
        this.thumbnailsStore.get(sha256),
      ]);
    } catch {
      result = undefined;
      thumbnail = undefined;
    }
    if (!result) {
      this.misses++;
      return undefined;
    }
    const cached: CachedParseResult = { ...result, thumbnail };
    // Warm the in-memory tier so subsequent same-session lookups skip IDB.
    lruPut(this.map, sha256, cached, this.maxEntries);
    this.hits++;
    return cached;
  }

  async record(sha256: string, value: CachedParseResult): Promise<void> {
    lruPut(this.map, sha256, value, this.maxEntries);
    const { thumbnail, ...rest } = value;
    try {
      // Two writes; parallel is fine because they target different stores
      // and the IDB adapter creates one transaction per call.
      await Promise.all([
        this.resultsStore.put(sha256, rest),
        thumbnail ? this.thumbnailsStore.put(sha256, thumbnail) : Promise.resolve(),
      ]);
    } catch {
      // Tolerate IDB write failure. In-memory tier carries this session;
      // next session cold-rebuilds. Acceptable for a pure perf cache.
    }
  }

  async forget(sha256: string): Promise<void> {
    this.map.delete(sha256);
    try {
      await Promise.all([
        this.resultsStore.delete(sha256),
        this.thumbnailsStore.delete(sha256),
      ]);
    } catch {
      /* ignore */
    }
  }

  stats(): ParseCacheStats {
    return { entries: this.map.size, hits: this.hits, misses: this.misses, idb: true };
  }

  /**
   * Diagnostic: count of entries currently in the parseResults IDB store.
   * Reported at activation so the user sees "warmed cache picks up where
   * last session left off". Thumbnails store is not counted — it's a
   * by-product, not a primary index. Best-effort; returns 0 on failure.
   */
  async idbEntryCount(): Promise<number> {
    try {
      return await this.resultsStore.count();
    } catch {
      return 0;
    }
  }
}

/**
 * Factory used at activation. Returns an IDB-backed cache when IndexedDB
 * is reachable; falls back to in-memory when it isn't (or when opening the
 * stores fails). Either way the caller gets a working `ParseResultCache`.
 */
export async function openParseCache(maxEntries?: number): Promise<{
  cache: ParseResultCache;
  idb: boolean;
  warmEntries: number;
}> {
  if (!isIdbAvailable()) {
    return {
      cache: new InMemoryParseCache({ maxEntries }),
      idb: false,
      warmEntries: 0,
    };
  }
  try {
    const idb = await IndexedDbParseCache.open({ maxEntries });
    const warm = await idb.idbEntryCount();
    return { cache: idb, idb: true, warmEntries: warm };
  } catch {
    return {
      cache: new InMemoryParseCache({ maxEntries }),
      idb: false,
      warmEntries: 0,
    };
  }
}
