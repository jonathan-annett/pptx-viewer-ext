// IndexedDB-backed store for SearchProjection records.
//
// Each projection is keyed by its `sha256` (also a field inside the
// stored value). Identical content at multiple URIs shares a single
// IDB record — the URI ↔ sha mapping lives in the in-memory engine,
// not here. That keeps writes small (one record per unique content,
// not per URI) and reads fast (warm-load is N projections, not N URIs).
//
// Why a dedicated DB rather than a third store inside the parseCache DB:
//   - Independent lifecycle. A user clearing the search index shouldn't
//     wipe the validation cache that took 30 seconds to populate.
//   - Independent schema bump cadence. The search schema changes when
//     tokenisation rules change; the parse schema changes when fields
//     are added or removed. Coupling forces version bumps to coordinate.
//   - Matches the hashCache / parseCache pattern of one DB per concern.
//
// Schema-version drift is handled at *read* time: `getAll()` filters out
// any record whose `schemaVersion` doesn't match the current literal in
// `index-types.ts`. The dropped entries get re-projected on the next
// indexer pass — same additive pattern as parseCacheIdb but more
// aggressive because the projection is content-determined and cheap to
// rebuild (~ms per file once bytes are in hand). Bumping `DB_VERSION`
// below is reserved for changes to the IDB schema itself (new stores,
// indexes); a tokenisation tweak only needs to bump
// SEARCH_PROJECTION_SCHEMA_VERSION in `index-types.ts`.
//
// Tolerates IDB being unavailable: `openSearchIndexStore` returns
// `undefined` and callers degrade to in-memory-only operation (which
// is correct — the engine carries the session even with no persistence).

import {
  isIdbAvailable,
  openIdbStore,
  type IdbStore,
} from '../sync/idbAdapter';
import {
  SEARCH_PROJECTION_SCHEMA_VERSION,
  type SearchProjection,
} from './index-types';

const DB_NAME = 'pptxSearch.index';
const STORE_NAME = 'projections';
// Start at 1. Bump only when the IDB schema needs to change (a new store,
// an index, etc). The projection's *content* schema is versioned
// separately via SEARCH_PROJECTION_SCHEMA_VERSION and enforced at read.
const DB_VERSION = 1;

export interface SearchIndexStore {
  /** Lookup by content hash. Returns the stored projection, or undefined
   *  when the sha is absent OR the stored record's schemaVersion doesn't
   *  match the current value. The mismatch case is treated as a miss so
   *  the indexer re-projects on its next pass. */
  getBySha(sha256: string): Promise<SearchProjection | undefined>;
  /** Insert/replace the projection for this sha. */
  putProjection(projection: SearchProjection): Promise<void>;
  /** Drop the record for this sha. No-op when absent. */
  deleteBySha(sha256: string): Promise<void>;
  /** Read every projection in the store, filtering out any whose
   *  schemaVersion is stale. Used by the engine at activation to warm
   *  the in-memory map in one pass. */
  getAll(): Promise<SearchProjection[]>;
  /** Drop every entry. Used by a future "Reset search index" command
   *  and by tests. */
  clear(): Promise<void>;
  /** Diagnostic entry count. Includes any stale-version entries. */
  count(): Promise<number>;
  /** Release the IDB connection. Idempotent. */
  close(): void;
}

export interface SearchIndexOpenOptions {
  /** Injectable for tests — defaults to opening the real IDB store. */
  open?: () => Promise<IdbStore<SearchProjection>>;
}

/**
 * Open the projection store. Returns undefined when IndexedDB isn't
 * reachable from the host (test environments, locked-down browsers) —
 * the engine then operates in pure in-memory mode and the indexer
 * still works for the current session.
 *
 * The optional `open` factory is the test seam: pass a fake-returning
 * function to exercise the store wrapper without a real IDB.
 */
export async function openSearchIndexStore(
  opts: SearchIndexOpenOptions = {},
): Promise<SearchIndexStore | undefined> {
  if (!opts.open && !isIdbAvailable()) return undefined;
  let raw: IdbStore<SearchProjection>;
  try {
    raw = opts.open
      ? await opts.open()
      : await openIdbStore<SearchProjection>({
          dbName: DB_NAME,
          storeName: STORE_NAME,
          version: DB_VERSION,
        });
  } catch {
    return undefined;
  }
  return wrap(raw);
}

function wrap(raw: IdbStore<SearchProjection>): SearchIndexStore {
  return {
    async getBySha(sha256) {
      let v: SearchProjection | undefined;
      try {
        v = await raw.get(sha256);
      } catch {
        return undefined;
      }
      if (!v) return undefined;
      if (v.schemaVersion !== SEARCH_PROJECTION_SCHEMA_VERSION) return undefined;
      return v;
    },
    async putProjection(projection) {
      try {
        await raw.put(projection.sha256, projection);
      } catch {
        // Tolerate IDB write failure — in-memory engine still has it.
      }
    },
    async deleteBySha(sha256) {
      try {
        await raw.delete(sha256);
      } catch {
        /* ignore */
      }
    },
    async getAll() {
      let all: SearchProjection[];
      try {
        all = await raw.getAll();
      } catch {
        return [];
      }
      // Drop stale-version entries silently. They'll be re-projected on
      // the next indexer pass over the corresponding URI.
      return all.filter(
        (p) => p && p.schemaVersion === SEARCH_PROJECTION_SCHEMA_VERSION,
      );
    },
    async clear() {
      try {
        await raw.clear();
      } catch {
        /* ignore */
      }
    },
    async count() {
      try {
        return await raw.count();
      } catch {
        return 0;
      }
    },
    close() {
      raw.close();
    },
  };
}
