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
