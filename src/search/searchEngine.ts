// In-memory search engine.
//
// Holds the full projection set in three coordinated maps:
//   - sha → SearchProjection   (the content index; one entry per unique
//                               content, even if many URIs reference it)
//   - uri → sha                (reverse map: which sha does this URI's
//                               bytes hash to right now)
//   - sha → Set<uri>           (forward map: which URIs reference this
//                               sha; used to dedupe hits and to decide
//                               when a projection can be dropped on
//                               removal)
//
// The three maps move together. `addOrUpdate` is the only path that
// *adds* a sha→projection entry; `removeUri` is the only path that
// *drops* one (and only when the last URI referencing the sha is
// removed). Both maintain the invariants:
//   I1.  Every uri in uriToSha has a corresponding sha in projections.
//   I2.  Every sha in shaToUris has a corresponding sha in projections.
//   I3.  shaToUris.get(sha).has(uri)  iff  uriToSha.get(uri) === sha.
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
  /** Upsert a projection for `uri`. If `uri` previously mapped to a
   *  different sha, the old sha's URI set drops `uri` and — if that was
   *  the last URI for the old sha — the old projection is dropped too. */
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
   *  render for an empty input box; we don't dump the whole index). */
  search(query: string): SearchHit[];
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
export function parseQuery(raw: string): SearchQuery {
  const trimmed = raw.trim();
  if (!trimmed) return { raw, terms: [] };
  // The tokeniser folds internally; using it directly on the raw input
  // gives us the same camelCase / snake_case / punctuation handling we
  // apply at index time. `fold(raw)` would lowercase but not split —
  // and a query like "weeklyPlan" should match the same tokens that
  // got indexed from a filename "WeeklyPlan.pptx".
  return { raw, terms: tokenize(trimmed) };
}

export function createSearchEngine(): SearchEngine {
  // Three coordinated maps — see invariants I1/I2/I3 in the module header.
  const projections = new Map<string, SearchProjection>();
  const uriToSha = new Map<string, string>();
  const shaToUris = new Map<string, Set<string>>();

  function getOrCreateUriSet(sha: string): Set<string> {
    let s = shaToUris.get(sha);
    if (!s) {
      s = new Set<string>();
      shaToUris.set(sha, s);
    }
    return s;
  }

  function dropUriFromSha(uri: string, sha: string): void {
    const set = shaToUris.get(sha);
    if (!set) return;
    set.delete(uri);
    if (set.size === 0) {
      // Last URI for this sha went away — projection is no longer
      // referenced by anything in the engine, so drop it. This is the
      // "removal cascade" the M3 DoD calls out: the projection map only
      // shrinks here.
      shaToUris.delete(sha);
      projections.delete(sha);
    }
  }

  return {
    load(initial) {
      projections.clear();
      uriToSha.clear();
      shaToUris.clear();
      // Loading from IDB doesn't tell us which URIs back each sha — the
      // engine learns those as the indexer hands them in via
      // `addOrUpdate`. Until then we keep the projection set seeded so
      // a search across a freshly-restored session can already match;
      // hits will surface with an empty `uris[]` until the indexer
      // catches up. The indexer is expected to run on every activation,
      // so this transient state is short-lived.
      for (const p of initial) {
        if (!p || !p.sha256) continue;
        projections.set(p.sha256, p);
      }
    },

    addOrUpdate(uri, projection) {
      const newSha = projection.sha256;
      const oldSha = uriToSha.get(uri);
      if (oldSha && oldSha !== newSha) {
        // URI's content changed — detach from the old sha (potentially
        // dropping its projection if it was the last URI).
        dropUriFromSha(uri, oldSha);
      }
      // Set/replace the projection. Replacing is intentional: a re-parse
      // with a tokeniser bump or a new author can land an updated
      // projection for the same sha (unlikely but cheap to handle).
      projections.set(newSha, projection);
      uriToSha.set(uri, newSha);
      getOrCreateUriSet(newSha).add(uri);
    },

    removeUri(uri) {
      const sha = uriToSha.get(uri);
      if (!sha) return;
      uriToSha.delete(uri);
      dropUriFromSha(uri, sha);
    },

    getProjection(sha256) {
      return projections.get(sha256);
    },

    getUrisForSha(sha256) {
      const set = shaToUris.get(sha256);
      if (!set) return undefined;
      return [...set];
    },

    getShaForUri(uri) {
      return uriToSha.get(uri);
    },

    getAllUris() {
      return [...uriToSha.keys()];
    },

    search(rawQuery) {
      const query = parseQuery(rawQuery);
      if (query.terms.length === 0) return [];
      // Folded raw query — useful for whole-string matches against the
      // projection's pre-folded fields if we ever want them; not used
      // by the current scorer but cheap to keep parsed.
      void fold(rawQuery);

      const hits: SearchHit[] = [];
      for (const projection of projections.values()) {
        const { score, matchedFields } = scoreProjection(projection, query);
        if (score <= 0) continue;
        const uriSet = shaToUris.get(projection.sha256);
        // Sort URIs deterministically so two engines holding the same
        // state produce identical hit objects (test stability). Set
        // insertion order is otherwise stable but depends on the order
        // the indexer fed URIs in.
        const uris = uriSet ? [...uriSet].sort() : [];
        hits.push({
          sha256: projection.sha256,
          uris,
          filename: projection.filename,
          author: projection.author,
          score,
          matchedFields: matchedFields.slice() as SearchField[],
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
      return { projections: projections.size, uris: uriToSha.size };
    },
  };
}
