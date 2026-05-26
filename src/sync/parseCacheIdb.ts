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
// Schema rationale — one DB, two object stores (opened via openIdbStores
// so the upgrade transaction creates both atomically):
//
//   parseResults: dense metadata. Cheap to enumerate, no megabyte-scale
//   payloads. Doubles as the Phase D identity index — every record carries
//   an optional `knownAt: string[]` of rel-paths where this sha256 has
//   been observed. A record with `flags` set is "fully parsed" (cache hit
//   for validation); a record with only `knownAt` is "identity-only" (we
//   saw these bytes at a destination but never parsed them). The single
//   store doubles as both indexes because identity and parse data are
//   keyed by the same sha256 — no third store needed.
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
  openIdbStores,
  type IdbStore,
} from './idbAdapter';
import type { Thumbnail } from '../pptx';

const DB_NAME = 'folderSync.parseCache';
const RESULTS_STORE = 'parseResults';
const THUMBNAILS_STORE = 'thumbnails';
// Bumped from 1 to 2 because v0.0.3 first-released a broken open path that
// created the DB at version 1 with only the parseResults store. Bumping
// triggers onupgradeneeded against stale-state users; the loop in
// openIdbStores creates whatever stores are missing (thumbnails here).
//
// Bumped 2 → 3 for M5.3 Phase D: the parseResults record gained an optional
// `knownAt: string[]` identity field. No schema change is required for IDB
// itself (records are JSON-shaped), but the version bump is the contract
// signal that existing entries may now grow the new field on write. Old v2
// entries without `knownAt` continue to read correctly (treated as
// "identity-only=absent" until a recordIdentity call lights them up).
//
// Bumped 3 → 4 for M-VE-2 (embedded media extract): the parseResults record
// gained an optional `mediaFiles: MediaFileEntry[]` field — the per-file
// media→slides join consumed by the viewer's Extract media UI. Like
// `knownAt`, this is purely an additive record-shape change (no IDB schema
// touch); the version bump is the signal. Old v3 entries without
// `mediaFiles` hydrate to `[]` so the Extract UI simply stays hidden for
// content that was cached before the upgrade — a fresh parse repopulates.
//
// Bumped 4 → 5 for M-VE-3 (synthesised fallback thumbnails): two additive
// record-shape changes — `synthesisHint?: SynthesisHint` on the
// parseResults record (set when the file has no in-file thumbnail, so the
// webview knows to render a fallback), and `synthesised?: boolean` on the
// thumbnails store entry (diagnostic flag distinguishing a synthesised
// fallback from a real extracted thumbnail). Both are optional. Old v4
// entries without synthesisHint will render without a fallback thumbnail
// until the LRU rotates them out and the next miss re-parses; the webview
// uses synthesisHint's *presence* as the signal that fallback synthesis is
// wanted, so absence is the safe default. Same for synthesised — old
// records hydrate without the flag (treated as real, which is correct
// since pre-M-VE-3 we never wrote synthesised entries).
//
// Bumped 5 → 6 for pptx-search-v1 M2: additive `firstVisibleSlideText:
// string` field on the parseResults record. Holds the concatenated
// `<a:t>` text from the first non-hidden slide for the search projection.
// Old v5 entries hydrate to '' (no slideText to index for that sha until
// it rotates out and re-parses) — same additive pattern as mediaFiles.
const DB_VERSION = 6;

/**
 * IDB payload for the parseResults store. All parse fields are optional so
 * an "identity-only" record — one populated by a destination walk that
 * observed the bytes but never parsed them — is a valid shape. The
 * discriminator is `flags`: present iff we have fully-parsed data; absent
 * iff the record is identity-only. `knownAt` carries the M5.3 Phase D
 * identity index, an array of rel-paths where this sha256 has been seen.
 *
 * Exported so tests can construct fake IdbStores with the correct value
 * type.
 */
export type ParseResultRecord = Partial<Omit<CachedParseResult, 'thumbnail'>> & {
  /**
   * Rel-paths where this content (sha256) has been observed. Populated by
   * destination walks via `recordIdentity`; consulted by source walks to
   * surface a `misfiled-content` warning when bytes appear at multiple
   * paths. De-duplicated by the writer; order is insertion order.
   */
  knownAt?: string[];
};

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
  /**
   * In-memory warm tier for the Phase D identity index. Populated by
   * lookup (on a record-with-knownAt read), lookupIdentity, and
   * recordIdentity. Lives alongside `map` rather than baked into it
   * because the two indexes have different lifetimes — identity hits are
   * cheap and useful even when full parse data is unavailable.
   */
  private readonly identityMap = new Map<string, string[]>();
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
    let results: IdbStore<ParseResultRecord>;
    let thumbnails: IdbStore<Thumbnail>;
    if (opts.openResults || opts.openThumbnails) {
      // Test path: explicit factories. Both must be provided together —
      // partial injection isn't supported (and isn't used by any test).
      if (!opts.openResults || !opts.openThumbnails) {
        throw new Error('parseCacheIdb: provide both openResults and openThumbnails, or neither');
      }
      results = await opts.openResults();
      thumbnails = await opts.openThumbnails();
    } else {
      // Production path: one DB open creates BOTH stores in a single
      // onupgradeneeded transaction. Opening the same DB twice for
      // different store names at the same version doesn't work — the
      // second open sees an existing DB, skips the upgrade, and can't
      // find its store. (That was the v0.0.3 first-cut bug — fixed by
      // routing through openIdbStores.)
      const multi = await openIdbStores({
        dbName: DB_NAME,
        storeNames: [RESULTS_STORE, THUMBNAILS_STORE],
        version: DB_VERSION,
      });
      results = multi.store<ParseResultRecord>(RESULTS_STORE);
      thumbnails = multi.store<Thumbnail>(THUMBNAILS_STORE);
    }
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
    // Side-effect: warm the identity index from any knownAt the record
    // carries. Cheap and means a subsequent lookupIdentity() avoids IDB.
    if (result.knownAt && result.knownAt.length > 0) {
      this.identityMap.set(sha256, [...result.knownAt]);
    }
    // Identity-only records (no `flags`) are not full parse data — return
    // undefined so the caller falls through to parsing. Count as a miss
    // for parse-data stats, matching the no-record case.
    if (!result.flags) {
      this.misses++;
      return undefined;
    }
    const cached: CachedParseResult = hydrateCached(result, thumbnail);
    // Warm the in-memory tier so subsequent same-session lookups skip IDB.
    lruPut(this.map, sha256, cached, this.maxEntries);
    this.hits++;
    return cached;
  }

  async record(sha256: string, value: CachedParseResult): Promise<void> {
    lruPut(this.map, sha256, value, this.maxEntries);
    const { thumbnail, ...rest } = value;
    try {
      // Read-modify-write the parseResults record so we don't trample any
      // identity-only knownAt left by an earlier destination walk. The
      // thumbnail store is independent and writes in parallel.
      const existingKnownAt = await this.readKnownAt(sha256);
      const merged: ParseResultRecord = { ...rest };
      if (existingKnownAt && existingKnownAt.length > 0) {
        merged.knownAt = existingKnownAt;
      }
      await Promise.all([
        this.resultsStore.put(sha256, merged),
        thumbnail ? this.thumbnailsStore.put(sha256, thumbnail) : Promise.resolve(),
      ]);
    } catch {
      // Tolerate IDB write failure. In-memory tier carries this session;
      // next session cold-rebuilds. Acceptable for a pure perf cache.
    }
  }

  /**
   * Single-getAll() snapshot of the parseResults store. Joins nothing — the
   * thumbnails store is excluded by design (see ParseResultCache.snapshot
   * JSDoc). Identity-only records (no `flags`) are skipped, matching
   * lookup()'s "full parse data only" contract. The returned map is
   * caller-owned — mutate freely.
   *
   * Bypasses the in-memory LRU tier on both read and write: we don't want
   * a snapshot for a 1000-file workspace to evict 800 useful entries from
   * a 200-entry LRU. The snapshot map is the bounded structure for the
   * duration of the walk; the LRU keeps serving its existing tenants for
   * non-walk callers (viewer-open).
   */
  async snapshot(): Promise<Map<string, CachedParseResult>> {
    let records: ParseResultRecord[];
    try {
      records = await this.resultsStore.getAll();
    } catch {
      // IDB failure — return whatever the in-memory tier knows. Better than
      // throwing; callers fall through to per-call lookup() on snapshot miss.
      return new Map(this.map);
    }
    const out = new Map<string, CachedParseResult>();
    for (const record of records) {
      // sha256 is the IDB key; the record carries it too as the canonical
      // discriminator. Skip records without a sha (shouldn't happen — but
      // defensive against partial writes from older versions).
      if (!record.sha256) continue;
      // Identity-only records have no `flags` — exclude from snapshot per
      // the lookup() contract.
      if (!record.flags) continue;
      // hydrateCached with thumbnail=undefined; see snapshot() contract.
      out.set(record.sha256, hydrateCached(record, undefined));
    }
    return out;
  }

  async forget(sha256: string): Promise<void> {
    this.map.delete(sha256);
    this.identityMap.delete(sha256);
    try {
      await Promise.all([
        this.resultsStore.delete(sha256),
        this.thumbnailsStore.delete(sha256),
      ]);
    } catch {
      /* ignore */
    }
  }

  /**
   * Identity index lookup. Returns the list of rel-paths where these
   * bytes have been observed, or undefined if none. Independent of the
   * parse-data cache: an identity-only IDB record yields a hit here even
   * though `lookup()` returns undefined for it.
   *
   * In-memory tier first; on a miss, probe IDB and warm the identity map.
   */
  async lookupIdentity(sha256: string): Promise<string[] | undefined> {
    const memHit = this.identityMap.get(sha256);
    if (memHit) return memHit.length > 0 ? [...memHit] : undefined;
    let record: ParseResultRecord | undefined;
    try {
      record = await this.resultsStore.get(sha256);
    } catch {
      record = undefined;
    }
    const knownAt = record?.knownAt;
    if (!knownAt || knownAt.length === 0) return undefined;
    this.identityMap.set(sha256, [...knownAt]);
    return [...knownAt];
  }

  /**
   * Record that we observed `sha256` at `relPath`. Read-modify-write to
   * preserve any existing parse data and to de-duplicate the rel-path. If
   * `relPath` is already in the knownAt list, this is a no-op (we don't
   * even issue the put, to avoid burning IDB write quota on redundant
   * data). Tolerates IDB failures — in-memory identityMap still warms.
   */
  async recordIdentity(sha256: string, relPath: string): Promise<void> {
    // In-memory first so a subsequent lookupIdentity in the same session
    // sees the update even if the IDB put below fails.
    const memCurrent = this.identityMap.get(sha256) ?? [];
    if (!memCurrent.includes(relPath)) {
      this.identityMap.set(sha256, [...memCurrent, relPath]);
    }
    try {
      const existing = await this.resultsStore.get(sha256);
      const existingKnownAt = existing?.knownAt ?? [];
      if (existingKnownAt.includes(relPath)) {
        // Already recorded at this path in IDB — nothing to do.
        return;
      }
      const merged: ParseResultRecord = {
        ...(existing ?? {}),
        knownAt: [...existingKnownAt, relPath],
      };
      await this.resultsStore.put(sha256, merged);
    } catch {
      /* ignore */
    }
  }

  private async readKnownAt(sha256: string): Promise<string[] | undefined> {
    const mem = this.identityMap.get(sha256);
    if (mem) return mem;
    try {
      const record = await this.resultsStore.get(sha256);
      return record?.knownAt;
    } catch {
      return undefined;
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
 * Reassemble a CachedParseResult from a `flags`-bearing record. Only valid
 * when `record.flags` is present — callers must check before calling. The
 * `knownAt` identity field is dropped here; it lives on the in-memory
 * identityMap, not on CachedParseResult.
 */
function hydrateCached(record: ParseResultRecord, thumbnail: Thumbnail | undefined): CachedParseResult {
  // `flags` presence is the "fully parsed" discriminator. We assert at the
  // call site so the cast below is safe.
  return {
    sha256: record.sha256!,
    slideCount: record.slideCount!,
    hiddenSlideCount: record.hiddenSlideCount!,
    author: record.author!,
    lastModifiedBy: record.lastModifiedBy!,
    embeddedMedia: record.embeddedMedia!,
    // v3 → v4 added mediaFiles. Old records without it hydrate to an empty
    // array; the Extract UI gates on length > 0 so a v3 cache hit just
    // silently lacks the affordance until that bytes' next miss-and-reparse.
    mediaFiles: record.mediaFiles ?? [],
    thumbnail,
    // v4 → v5 added synthesisHint. Optional — old records hydrate without
    // it (no fallback thumbnail until they rotate out and re-parse).
    synthesisHint: record.synthesisHint,
    // v5 → v6 added firstVisibleSlideText. Defaults to '' for old records
    // so the search projection's slideText is just empty until that sha
    // rotates out and re-parses.
    firstVisibleSlideText: record.firstVisibleSlideText ?? '',
    flags: record.flags!,
    parseError: record.parseError,
  };
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
