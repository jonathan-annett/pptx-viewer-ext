// In-memory search engine.
//
// Holds the full projection set in three coordinated maps, keyed by an
// internal "index key" (see keyFor):
//   - key → SearchProjection   (the content index; one entry per unique
//                               key, even if many URIs reference it)
//   - uri → key                (reverse map: which key does this URI map to)
//   - key → Set<uri>           (forward map: which URIs reference this key;
//                               used to dedupe hits and to decide when a
//                               projection can be dropped on removal)
//
// The index key is normally the content sha256 — so identical content at
// many paths dedupes to ONE hit with many URIs. The EXCEPTION is
// placeholder files (zero-byte stubs and any registered placeholder
// hashes): these are byte-identical by design but their meaningful
// identity is their FILENAME, not their content. Deduping them by sha
// would collapse every placeholder into one entry and lose all but one
// filename. So a placeholder is keyed per-URI (`sha\0uri`) — each keeps
// its own projection + filename and surfaces as its own hit. The active
// placeholder sha-set is injected via `setPlaceholderShas` (keeps this
// module vscode/IDB-free; the wired indexer feeds it from the registry).
//
// The three maps move together. `addOrUpdate` is the only path that
// *adds* a key→projection entry; `removeUri` is the only path that
// *drops* one (and only when the last URI referencing the key is
// removed). Both maintain the invariants:
//   I1.  Every uri in uriToKey has a corresponding key in projections.
//   I2.  Every key in keyToUris has a corresponding key in projections.
//   I3.  keyToUris.get(key).has(uri)  iff  uriToKey.get(uri) === key.
//
// Pure module — no vscode, no IDB, no I/O. tsx-testable. The wired
// layer (indexer.ts) converts vscode.Uri → string before calling in.
//
// Why an in-memory engine rather than IDB-backed search:
//   - Latency. A keystroke fires a search; touching IDB per keystroke
//     would be sluggish even on a warm cache. In-memory linear scan
//     over 3000 entries is sub-millisecond.
//   - Simplicity. The projection set is small enough to materialise
//     in full at activation (one IDB getAll call). No streaming, no
//     incremental query plumbing.
//
// IDB is the persistence tier behind this engine, not part of search.
// The indexer wires the two together.

import type {
  SearchField,
  SearchHit,
  SearchOp,
  SearchProjection,
  SearchQuery,
} from './index-types';
import { fold } from './fold';
import { scoreProjection } from './score';
import { tokenize } from './tokenize';

export interface SearchEngine {
  /** Replace the entire engine state. Used at activation to hydrate from
   *  IDB. Subsequent loads after the first are also supported (e.g. on
   *  the user clearing + re-indexing) and the existing in-memory state
   *  is discarded. */
  load(projections: SearchProjection[]): void;
  /** Set the active placeholder sha-set. Files whose content sha is in
   *  this set are indexed per-URI (not content-deduped) so each keeps its
   *  own filename. Injected by the wired indexer from the placeholder
   *  registry; re-callable when the registry changes (the indexer re-walks
   *  to re-key affected files). Defaults to empty (everything deduped). */
  setPlaceholderShas(shas: ReadonlySet<string>): void;
  /** Upsert a projection for `uri`. If `uri` previously mapped to a
   *  different key, the old key's URI set drops `uri` and — if that was
   *  the last URI for the old key — the old projection is dropped too. */
  addOrUpdate(uri: string, projection: SearchProjection): void;
  /** Remove `uri` from the engine. When that was the last URI mapped to
   *  the underlying sha, the projection is dropped as well. */
  removeUri(uri: string): void;
  /** Lookup helper for tests + diagnostics. Returns the projection
   *  stored for `sha256`, or undefined when not present. */
  getProjection(sha256: string): SearchProjection | undefined;
  /** Lookup helper for tests + diagnostics. Returns the URI set
   *  (as a freshly-copied array) for `sha256`, or undefined when not
   *  present. */
  getUrisForSha(sha256: string): string[] | undefined;
  /** Lookup helper for the wired indexer. Returns the sha currently
   *  mapped to `uri`, or undefined when the URI isn't tracked. Used to
   *  mirror engine evictions into the IDB index store: after a removeUri
   *  that empties the sha's URI set, the indexer drops the IDB record. */
  getShaForUri(uri: string): string | undefined;
  /** Snapshot of every tracked URI. Used by the indexer to compute
   *  evictions when topology changes shrink the source-folder scope.
   *  Returns a freshly-copied array so callers can iterate without
   *  worrying about concurrent mutations during a walk. */
  getAllUris(): string[];
  /** Run a search. Empty input → empty array (the panel chooses what to
   *  render for an empty input box; we don't dump the whole index).
   *  `op` defaults to 'and'; pass 'or' to widen the search. */
  search(query: string, op?: SearchOp): SearchHit[];
  /** Diagnostic: counts for the activation log + probe command. */
  stats(): SearchEngineStats;
}

export interface SearchEngineStats {
  /** Number of unique-content projections in memory. */
  projections: number;
  /** Number of URIs mapped (≥ projections; equal when there's no
   *  duplicate-content overlap). */
  uris: number;
}

/**
 * Parse a raw user query into a SearchQuery. Folds + tokenises so the
 * scorer can do plain substring/prefix comparisons against
 * already-folded projection fields. Empty input → empty terms.
 *
 * Exported because the eventual webview / probe command may want to
 * inspect the parsed form independently of running a search.
 */
export function parseQuery(raw: string, op: SearchOp = 'and'): SearchQuery {
  const trimmed = raw.trim();
  if (!trimmed) return { raw, terms: [], op };
  // The tokeniser folds internally; using it directly on the raw input
  // gives us the same camelCase / snake_case / punctuation handling we
  // apply at index time. `fold(raw)` would lowercase but not split —
  // and a query like "weeklyPlan" should match the same tokens that
  // got indexed from a filename "WeeklyPlan.pptx".
  return { raw, terms: tokenize(trimmed), op };
}

export function createSearchEngine(): SearchEngine {
  // Three coordinated maps — see invariants I1/I2/I3 in the module header.
  // Keyed by the internal index key (sha for normal content, `sha\0uri`
  // for placeholders), NOT the raw sha.
  const projections = new Map<string, SearchProjection>();
  const uriToKey = new Map<string, string>();
  const keyToUris = new Map<string, Set<string>>();
  let placeholderShas: ReadonlySet<string> = new Set<string>();

  // The per-URI key separator. NUL never appears in a sha (hex) or a URI,
  // so `sha\0uri` can't collide with a bare sha or another file's key.
  const KEY_SEP = String.fromCharCode(0); // NUL — engine-internal

  /** The index key for a (uri, sha) pair: per-URI for placeholders so each
   *  keeps its own projection; the bare sha otherwise so identical real
   *  content dedupes. */
  function keyFor(uri: string, sha: string): string {
    return placeholderShas.has(sha) ? `${sha}${KEY_SEP}${uri}` : sha;
  }

  function getOrCreateUriSet(key: string): Set<string> {
    let s = keyToUris.get(key);
    if (!s) {
      s = new Set<string>();
      keyToUris.set(key, s);
    }
    return s;
  }

  function dropUriFromKey(uri: string, key: string): void {
    const set = keyToUris.get(key);
    if (!set) return;
    set.delete(uri);
    if (set.size === 0) {
      // Last URI for this key went away — projection is no longer
      // referenced by anything in the engine, so drop it. This is the
      // "removal cascade" the M3 DoD calls out: the projection map only
      // shrinks here.
      keyToUris.delete(key);
      projections.delete(key);
    }
  }

  return {
    load(initial) {
      projections.clear();
      uriToKey.clear();
      keyToUris.clear();
      // Loading from IDB doesn't tell us which URIs back each sha — the
      // engine learns those as the indexer hands them in via
      // `addOrUpdate`. Until then we keep the projection set seeded so
      // a search across a freshly-restored session can already match;
      // hits will surface with an empty `uris[]` until the indexer
      // catches up. The indexer is expected to run on every activation,
      // so this transient state is short-lived.
      //
      // Placeholder projections can't be keyed per-URI here (no URIs yet),
      // and the indexer re-walks on every activation and re-keys them via
      // addOrUpdate — so we skip seeding placeholders to avoid a stale
      // bare-sha entry that would surface as an empty-`uris[]` hit.
      for (const p of initial) {
        if (!p || !p.sha256) continue;
        if (placeholderShas.has(p.sha256)) continue;
        projections.set(p.sha256, p);
      }
    },

    setPlaceholderShas(shas) {
      placeholderShas = new Set(shas);
    },

    addOrUpdate(uri, projection) {
      const newKey = keyFor(uri, projection.sha256);
      const oldKey = uriToKey.get(uri);
      if (oldKey && oldKey !== newKey) {
        // URI's content (or placeholder-ness) changed — detach from the
        // old key (potentially dropping its projection if it was the last
        // URI).
        dropUriFromKey(uri, oldKey);
      }
      // If this is a placeholder (composite key) clean up any stale
      // bare-sha projection that `load()` may have seeded before the set
      // was known, but only when no URIs reference it (a real deck sharing
      // the sha would be keyed by sha and keep its URI set).
      if (newKey !== projection.sha256 && !keyToUris.has(projection.sha256)) {
        projections.delete(projection.sha256);
      }
      // Set/replace the projection. Replacing is intentional: a re-parse
      // with a tokeniser bump or a new author can land an updated
      // projection for the same key (unlikely but cheap to handle).
      projections.set(newKey, projection);
      uriToKey.set(uri, newKey);
      getOrCreateUriSet(newKey).add(uri);
    },

    removeUri(uri) {
      const key = uriToKey.get(uri);
      if (!key) return;
      uriToKey.delete(uri);
      dropUriFromKey(uri, key);
    },

    getProjection(sha256) {
      // Exact (non-placeholder) key first; else find any projection whose
      // content sha matches (placeholders are keyed `sha\0uri`). Callers
      // use this as "does ANY projection with this sha still exist?" — e.g.
      // the indexer's IDB-record-retention check after a removeUri.
      const direct = projections.get(sha256);
      if (direct) return direct;
      for (const p of projections.values()) {
        if (p.sha256 === sha256) return p;
      }
      return undefined;
    },

    getUrisForSha(sha256) {
      // Union of URIs across every key carrying this content sha (one key
      // for normal content; N per-URI keys for placeholders).
      const out: string[] = [];
      for (const [key, set] of keyToUris) {
        if (key === sha256 || key.startsWith(`${sha256}${KEY_SEP}`)) {
          for (const u of set) out.push(u);
        }
      }
      return out.length > 0 ? out : undefined;
    },

    getShaForUri(uri) {
      const p = projections.get(uriToKey.get(uri) ?? '');
      return p?.sha256;
    },

    getAllUris() {
      return [...uriToKey.keys()];
    },

    search(rawQuery, op) {
      const query = parseQuery(rawQuery, op);
      if (query.terms.length === 0) return [];
      // Folded raw query — useful for whole-string matches against the
      // projection's pre-folded fields if we ever want them; not used
      // by the current scorer but cheap to keep parsed.
      void fold(rawQuery);

      const hits: SearchHit[] = [];
      for (const [key, projection] of projections) {
        const { score, matchedFields } = scoreProjection(projection, query);
        if (score <= 0) continue;
        const uriSet = keyToUris.get(key);
        // Sort URIs deterministically so two engines holding the same
        // state produce identical hit objects (test stability). Set
        // insertion order is otherwise stable but depends on the order
        // the indexer fed URIs in.
        const uris = uriSet ? [...uriSet].sort() : [];
        hits.push({
          sha256: projection.sha256,
          uris,
          filename: projection.filename,
          displayFilename: projection.displayFilename,
          author: projection.author,
          displayAuthor: projection.displayAuthor,
          score,
          matchedFields: matchedFields.slice() as SearchField[],
          isPlaceholder: placeholderShas.has(projection.sha256),
        });
      }

      // Sort: score desc, then filename asc as a stable tiebreaker so
      // identical-score hits don't shuffle between renders.
      hits.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.filename < b.filename) return -1;
        if (a.filename > b.filename) return 1;
        // Final tiebreak: sha. Guarantees a total order.
        if (a.sha256 < b.sha256) return -1;
        if (a.sha256 > b.sha256) return 1;
        return 0;
      });
      return hits;
    },

    stats() {
      return { projections: projections.size, uris: uriToKey.size };
    },
  };
}
