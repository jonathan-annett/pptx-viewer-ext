// Build a SearchProjection from a ParseResult + filename.
//
// Pure module — no vscode, no I/O. The wired indexer reads file bytes,
// calls parsePptxCached, then hands the result here to derive the
// projection. By design this is decoupled from how the ParseResult was
// produced: the search engine doesn't care whether we parsed on miss or
// hydrated from the M5.3 cache.
//
// Inputs come in two flavours:
//   - `projectFromParseResult` — the full ParseResult from
//     parsePptx/parsePptxCached, including display fields.
//   - `projectFromCached` — a CachedParseResult straight from
//     parseCache.lookup, paired with the FileInfo carrying mtime + size.
//
// Both wind up calling the same internal builder; the two entry points
// exist to make callsites read clearly and to avoid forcing the cached
// path to synthesise a FileInfo for fields the cache already drops.

import type { CachedParseResult } from '../sync/parseCache';
import type { FileInfo, ParseResult } from '../pptx';
import { fold } from './fold';
import {
  SEARCH_PROJECTION_SCHEMA_VERSION,
  type SearchProjection,
} from './index-types';
import { tokenize } from './tokenize';

/**
 * Strip the basename out of a URI string. We deliberately don't import
 * vscode here, so we accept whatever string the wired layer gives us
 * (uri.toString() in practice). Handles trailing slashes and bare names.
 */
export function basenameOf(uriOrPath: string): string {
  if (!uriOrPath) return '';
  // Drop query/fragment, then split on `/`.
  const noQuery = uriOrPath.split(/[?#]/)[0];
  const trimmed = noQuery.replace(/\/+$/, '');
  const last = trimmed.lastIndexOf('/');
  return last >= 0 ? trimmed.slice(last + 1) : trimmed;
}

/**
 * Best-effort URI-decode for display. `decodeURIComponent` throws on
 * malformed sequences (e.g. a literal `%` not followed by two hex digits);
 * we fall back to the raw input rather than blow up the projection build.
 * Used to turn `WED%20206%201720.pptx` into `WED 206 1720.pptx` for the
 * results panel without losing the folded form used for matching.
 */
export function decodeUriDisplay(s: string): string {
  if (!s) return '';
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Internal builder: takes raw strings and metadata, returns a folded +
 * tokenised projection. Used by both public entry points below.
 */
function buildProjection(opts: {
  sha256: string;
  filename: string;
  author: string;
  slideText: string;
  sizeBytes: number;
  mtime: number;
}): SearchProjection {
  // Display fields preserve the original case but URI-decode the filename
  // so `%20` etc. render as the spaces the user expects. Match fields stay
  // folded so search is case + accent insensitive.
  const displayFilename = decodeUriDisplay(opts.filename);
  const displayAuthor = opts.author;
  const filename = fold(displayFilename);
  const author = fold(opts.author);
  const slideText = fold(opts.slideText);
  return {
    sha256: opts.sha256,
    filename,
    displayFilename,
    author,
    displayAuthor,
    slideText,
    // Tokenise from the display form (i.e. post-decode for the filename)
    // so camelCase / snake_case splits work on the human name, not on the
    // percent-encoded URI bytes.
    filenameTokens: tokenize(displayFilename),
    authorTokens: tokenize(opts.author),
    slideTextTokens: tokenize(opts.slideText),
    sizeBytes: opts.sizeBytes,
    mtime: opts.mtime,
    schemaVersion: SEARCH_PROJECTION_SCHEMA_VERSION,
  };
}

/**
 * Project a freshly-parsed ParseResult. The filename argument overrides
 * `result.fileName` when supplied — useful when the URI's basename
 * differs from what the parser saw (rare in practice; the parser is
 * given the basename via FileInfo). Mtime and size come from the
 * ParseResult directly.
 *
 * The `author` field on ParseResult is the string 'unknown' when missing
 * (see the UNKNOWN sentinel in src/pptx.ts). We treat that as "no
 * author" for search purposes — folding "unknown" would make every
 * author-less deck match a query for "unknown", which isn't what users
 * want. The projection's author becomes '' in that case.
 */
export function projectFromParseResult(
  result: ParseResult,
  filenameOverride?: string,
): SearchProjection {
  return buildProjection({
    sha256: result.sha256,
    filename: filenameOverride ?? result.fileName,
    author: result.author === 'unknown' ? '' : result.author,
    slideText: result.firstVisibleSlideText,
    sizeBytes: result.size,
    mtime: result.mtime,
  });
}

/**
 * Project a cached payload. Display fields (filename, size, mtime) come
 * from the FileInfo accompanying the cache hit since the cache itself
 * drops them. `info.fileName` is expected to be the basename — the
 * indexer derives it from the URI before passing in.
 */
export function projectFromCached(
  cached: CachedParseResult,
  info: FileInfo,
): SearchProjection {
  return buildProjection({
    sha256: cached.sha256,
    filename: info.fileName,
    author: cached.author === 'unknown' ? '' : cached.author,
    slideText: cached.firstVisibleSlideText,
    sizeBytes: info.size,
    mtime: info.mtime,
  });
}

/**
 * Project a file we know nothing about beyond its bytes-hash + basename.
 * Used for `.pdf` files, which the search subsystem doesn't open or
 * parse — the indexer skips the pptx parse path entirely for PDFs and
 * surfaces them as filename-only hits. Author and slide-text fields
 * stay empty, so OR-mode queries can still hit on a filename fragment
 * while AND-mode queries with non-filename terms naturally exclude PDFs.
 */
export function projectFilenameOnly(opts: {
  sha256: string;
  fileName: string;
  sizeBytes: number;
  mtime: number;
}): SearchProjection {
  return buildProjection({
    sha256: opts.sha256,
    filename: opts.fileName,
    author: '',
    slideText: '',
    sizeBytes: opts.sizeBytes,
    mtime: opts.mtime,
  });
}
