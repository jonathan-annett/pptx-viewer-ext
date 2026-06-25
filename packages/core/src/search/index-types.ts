// Shared types for the pptx-search subsystem.
//
// Pure module — no vscode import. The wired layer (indexer.ts,
// searchPanel.ts) converts between vscode.Uri and the `string` form used
// here so the engine + projection layer stays tsx-testable.
//
// SCHEMA VERSIONING — bump `SEARCH_PROJECTION_SCHEMA_VERSION` and the
// `schemaVersion` literal type below whenever the projection shape or its
// tokenisation rules change in a way that would invalidate cached
// projections in IDB. The indexStore drops entries with a mismatched
// version on read.

// Bumped to 2 when display fields (displayFilename, displayAuthor) were
// added so the panel could render human-readable strings without losing
// case (folded forms are still kept for matching). Old v1 entries get
// dropped by indexStore.getAll() on read and re-projected on the next
// indexer pass.
export const SEARCH_PROJECTION_SCHEMA_VERSION = 2;

/**
 * Per-file projection stored in the `pptxSearchIndex` IDB store and held
 * in memory by the search engine. Sha256-keyed: identical content at
 * multiple paths shares one entry. The URI mapping lives outside the
 * projection (in the engine's reverse index).
 *
 * All three "raw" string fields (filename, author, slideText) are
 * pre-folded (lowercased + NFD + combining-marks stripped) once at index
 * time so search-time comparison is a plain `includes()` against the
 * already-folded query. The matching token arrays are derived from the
 * same folded strings.
 */
export interface SearchProjection {
  /** Primary key. Lowercase hex sha256 of the original pptx bytes. */
  sha256: string;
  /** Basename of the file URI, folded. */
  filename: string;
  /** Human-readable basename for display — URI-decoded, case preserved.
   *  Derived from the URI at index time. Used by the search panel; the
   *  folded `filename` field above stays the match target. */
  displayFilename: string;
  /** dc:creator from docProps/core.xml, folded. Empty string when absent. */
  author: string;
  /** Case-preserved author string for display. Empty when no author. */
  displayAuthor: string;
  /** Concatenated <a:t> text from the first non-hidden slide, folded.
   *  Empty string when the deck has no visible text on its first slide
   *  (image-only intro, or no visible slides at all). */
  slideText: string;
  filenameTokens: string[];
  authorTokens: string[];
  slideTextTokens: string[];
  /** Raw byte size of the pptx file at index time. Informational; the
   *  engine doesn't use it for matching. */
  sizeBytes: number;
  /** Last-modified mtime in epoch-ms at index time. Informational. */
  mtime: number;
  schemaVersion: typeof SEARCH_PROJECTION_SCHEMA_VERSION;
}

/** Which field a query term matched on. Drives the result-list badge
 *  rendering ("filename", "author", "slide text") and feeds the ranker. */
export type SearchField = 'filename' | 'author' | 'slideText';

export interface SearchHit {
  sha256: string;
  /** Stringified URIs (uri.toString()) of every file mapped to this sha.
   *  Multiple entries when identical content lives at multiple paths. */
  uris: string[];
  /** Folded filename of the first URI mapped to the projection — same
   *  value as `SearchProjection.filename`, surfaced here so the UI can
   *  render without consulting the projection separately. */
  filename: string;
  /** Display-friendly basename (URI-decoded, original case). */
  displayFilename: string;
  author: string;
  /** Display-friendly author (original case). */
  displayAuthor: string;
  score: number;
  matchedFields: SearchField[];
  /** True when this hit's content sha is in the active placeholder set
   *  (zero-byte stubs + any registered placeholder hashes). Placeholder
   *  files are indexed per-URI rather than deduped by content, so each
   *  keeps its own filename; the panel marks them so they're
   *  distinguishable from real decks. Absent/false for normal content. */
  isPlaceholder?: boolean;
}

/** Combinator across query terms. Default 'and' (every term must hit
 *  somewhere); 'or' widens the search so a single hitting term qualifies
 *  the file. OR mode is useful for fishing out a specific deck by a
 *  filename fragment when the metadata is unhelpful. */
export type SearchOp = 'and' | 'or';

/** Tokenised, folded query. Built by the engine from a raw input string;
 *  exported as a type so the scorer can be unit-tested without going
 *  through the engine. */
export interface SearchQuery {
  /** Original input, kept for display. Not folded. */
  raw: string;
  /** Folded + tokenised query terms. Empty array ↔ "no query". */
  terms: string[];
  /** AND across terms by default; OR widens the match. */
  op: SearchOp;
}
