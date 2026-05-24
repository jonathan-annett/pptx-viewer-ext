// Pure helpers for deciding which workspace folders the search indexer
// should walk, and which URIs (already indexed) should be evicted when
// the topology changes.
//
// The rule from the plan:
//   Searchable scope = workspace folders that are NOT destinations in
//   any active .sync.jsonc. A folder can be both source and destination
//   across different configs; if a folder is *anywhere* a destination,
//   it's excluded.
//
// This module deals in URI strings only — the wired layer converts to/
// from vscode.Uri before calling in. That keeps the helper tsx-testable
// and identical to the SearchProjection / SearchEngine convention.

import type { SearchHit } from './index-types';
import { basenameOf, decodeUriDisplay } from './projection';

/**
 * Inputs derived from `vscode.workspace.workspaceFolders` + the resolved
 * topology. All URIs are `vscode.Uri.toString()` values.
 */
export interface ScopeInputs {
  /** Every workspace folder URI currently mounted. */
  workspaceFolderUris: readonly string[];
  /**
   * Workspace-folder URIs claimed as a destination by at least one
   * `.sync.jsonc`. The wired layer assembles this by walking the
   * topology and collecting `dest.workspaceFolderUri` for every dest
   * whose URI resolved to an open workspace folder (unresolved
   * destinations don't exclude anything — they're not present).
   */
  destinationWorkspaceFolderUris: readonly string[];
}

export interface SearchScope {
  /**
   * Workspace folder URI strings the indexer should walk. Order is
   * preserved from `workspaceFolderUris` for stable iteration.
   */
  folderUris: readonly string[];
}

/**
 * Compute the set of folders to index. Pure — no I/O, no vscode import.
 */
export function computeSearchScope(input: ScopeInputs): SearchScope {
  const excluded = new Set(input.destinationWorkspaceFolderUris);
  const folderUris = input.workspaceFolderUris.filter((u) => !excluded.has(u));
  return { folderUris };
}

/**
 * True when `fileUri` is at or under one of the scope's folder URIs.
 * Comparison is path-prefix on the URI string, with a trailing-slash
 * guard so `/work/foo/file` doesn't match a scope folder `/work/foobar`.
 *
 * Identity case: a file URI that exactly equals a folder URI shouldn't
 * really happen (folders aren't files), but we return true so the caller
 * doesn't drop a legitimate entry on the corner case.
 */
export function isUnderScope(scope: SearchScope, fileUri: string): boolean {
  if (!fileUri) return false;
  for (const folder of scope.folderUris) {
    if (fileUri === folder) return true;
    const prefix = folder.endsWith('/') ? folder : `${folder}/`;
    if (fileUri.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * True when `fileUri` sits under the first scope folder (the canonical
 * workspace folder by declaration order).
 *
 * Used by the indexer to exclude PDFs from the canonical folder: search
 * surfaces PDFs as sources for a PDF → PPTX update, and the update flow
 * only supports the canonical folder as the *target* (a PPTX). Letting
 * PDFs into the canonical group would offer the user a primed pair that
 * the update flow can't act on.
 *
 * Empty-scope guard: returns false so callers don't accidentally treat a
 * file as "in the first folder" when there is no first folder.
 */
export function isUnderFirstScopeFolder(scope: SearchScope, fileUri: string): boolean {
  if (!fileUri) return false;
  if (scope.folderUris.length === 0) return false;
  const first = scope.folderUris[0];
  if (fileUri === first) return true;
  const prefix = first.endsWith('/') ? first : `${first}/`;
  return fileUri.startsWith(prefix);
}

/**
 * Given an old scope and a new scope, return URIs from `currentUris`
 * that are in the old scope but not the new — i.e. files the engine
 * holds entries for that should be evicted on a topology change.
 *
 * The wired layer calls this with `engine.stats()`-equivalent listing
 * of URIs (from `uriToSha` keys). Pure: takes plain string arrays.
 */
export function urisLeavingScope(
  newScope: SearchScope,
  currentUris: readonly string[],
): string[] {
  const evictions: string[] = [];
  for (const uri of currentUris) {
    if (!isUnderScope(newScope, uri)) evictions.push(uri);
  }
  return evictions;
}

/**
 * Bucketed search results, one bucket per top-level scope folder.
 * Empty buckets are omitted (no header for "no hits in this folder").
 *
 * `folderUri` is the workspace-folder URI string the panel keys on; the
 * panel can reorder if it ever needs to, though `groupHitsByFolder`
 * already returns buckets in scope order.
 *
 * `folderLabel` is the human-readable form — the basename of the folder
 * URI, percent-decoded. The wired layer could swap this for an explicit
 * `vscode.workspace.asRelativePath` if/when we want the workspace-name
 * instead of the URL basename, but for now the basename matches what the
 * VS Code Explorer shows in the title bar.
 */
export interface HitGroup {
  folderUri: string;
  folderLabel: string;
  hits: SearchHit[];
}

/**
 * Group hits by the scope folder their URIs live under.
 *
 * Same-content / multiple-URI handling: the search engine deduplicates by
 * sha, so a deck that's literally copied into two source folders comes
 * back as ONE hit with two URIs. The user expects to see that file under
 * BOTH folder headers, not just whichever URI happened to be first — the
 * point of grouping is to answer "what's in this folder," and the answer
 * for a duplicated file is "this file is in both." So we fan the hit out
 * into per-folder copies, each carrying only the URIs that belong to that
 * folder. The hit's identity fields (sha, filename, score, matchedFields)
 * are shared across the copies; only `uris` is sliced.
 *
 * Ordering rules:
 *   - Buckets appear in the same order as `scope.folderUris` — the indexer
 *     preserves workspace-folder declaration order, so the user sees their
 *     top folder first.
 *   - Hits inside each bucket keep the input order (the engine has already
 *     sorted by score + filename).
 *   - Empty buckets are dropped so the panel doesn't render a header with
 *     no rows under it.
 *
 * URIs that don't fall under any scope folder land in a synthetic group
 * with `folderUri: ''` and `folderLabel: '(other)'`. This shouldn't happen
 * in normal flow (the indexer only adds in-scope URIs), but the engine's
 * load-from-IDB phase can briefly hold projections whose URIs haven't been
 * re-asserted by the indexer yet — keep the bucket as a defensive fallback
 * rather than silently dropping rows.
 */
export function groupHitsByFolder(
  hits: readonly SearchHit[],
  scope: SearchScope,
): HitGroup[] {
  // Pre-compute trailing-slash variants once. Same rule as `isUnderScope`:
  // a URI matches a folder if it equals it or starts with `folder + '/'`.
  // We prefer the longest matching folder so that nested workspace folders
  // (rare but possible) bucket correctly.
  const folderPrefixes = scope.folderUris.map((folder) => ({
    uri: folder,
    prefix: folder.endsWith('/') ? folder : `${folder}/`,
  }));

  // One bucket per scope folder, in order. Map keeps insertion order so a
  // single pass over `scope.folderUris` is enough.
  const buckets = new Map<string, HitGroup>();
  for (const folder of scope.folderUris) {
    buckets.set(folder, {
      folderUri: folder,
      folderLabel: folderLabelFor(folder),
      hits: [],
    });
  }

  let other: HitGroup | undefined;

  for (const hit of hits) {
    // Partition this hit's URIs by which scope folder each belongs to.
    // Keys are folder URIs; values are URIs from the hit that go there.
    const byFolder = new Map<string, string[]>();
    const orphans: string[] = [];
    for (const uri of hit.uris || []) {
      let bestFolder = '';
      let bestLen = -1;
      for (const { uri: folderUri, prefix } of folderPrefixes) {
        const matches = uri === folderUri || uri.startsWith(prefix);
        if (matches && folderUri.length > bestLen) {
          bestFolder = folderUri;
          bestLen = folderUri.length;
        }
      }
      if (bestFolder) {
        let arr = byFolder.get(bestFolder);
        if (!arr) {
          arr = [];
          byFolder.set(bestFolder, arr);
        }
        arr.push(uri);
      } else {
        orphans.push(uri);
      }
    }

    // Emit one per-folder copy of the hit per non-empty partition. Each
    // copy carries only the URIs that live in that folder so the panel
    // doesn't show "this folder's results contain a path in another folder".
    for (const [folderUri, uris] of byFolder) {
      buckets.get(folderUri)!.hits.push({ ...hit, uris });
    }
    if (orphans.length > 0) {
      if (!other) other = { folderUri: '', folderLabel: '(other)', hits: [] };
      other.hits.push({ ...hit, uris: orphans });
    }
  }

  const out: HitGroup[] = [];
  for (const group of buckets.values()) {
    if (group.hits.length > 0) out.push(group);
  }
  if (other) out.push(other);
  return out;
}

/**
 * Display label for a workspace-folder URI. Decoded basename of the URI,
 * with a fall-back to the URI itself when there's no meaningful basename
 * (e.g. a root URI like `vscode-vfs://github`).
 */
export function folderLabelFor(folderUri: string): string {
  const base = basenameOf(folderUri);
  const decoded = decodeUriDisplay(base);
  if (decoded) return decoded;
  return decodeUriDisplay(folderUri);
}
