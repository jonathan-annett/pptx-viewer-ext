// Filenames the extension recognises as a source-config file. Both share
// the JSONC format and (today) identical semantics — `.roomSync` is a
// forward-compatible alias for `.sync.jsonc`. Future fields (M2's
// `path-aliases` and beyond — see room-sync-format-v1-plan.md) will be
// readable from either filename; the alias exists so users can adopt the
// new name now without losing compatibility.
//
// Centralised here so the glob, schema registration, conflict detection,
// and source-intent probes share a single source of truth — adding a third
// honoured name in future means editing one constant, not eight call sites.

export const SYNC_CONFIG_FILENAMES = ['.sync.jsonc', '.roomSync'] as const;
export type SyncConfigFilename = (typeof SYNC_CONFIG_FILENAMES)[number];

/**
 * Glob matching every recognised source-config filename, anywhere in the
 * tree. Brace expansion is part of vscode's glob dialect (and minimatch's),
 * so this works in both `workspace.findFiles` and `createFileSystemWatcher`.
 */
export const SYNC_CONFIG_GLOB = '**/{.sync.jsonc,.roomSync}';

/** True when the given filename (no path) is a recognised source-config name. */
export function isSyncConfigFilename(name: string): name is SyncConfigFilename {
  return (SYNC_CONFIG_FILENAMES as readonly string[]).includes(name);
}

/**
 * Strip the path-prefix of a URI and return the bare filename. Used by
 * conflict detection to group two configs that live in the same source
 * folder. Works on any object with a `.path: string` (so it accepts
 * `vscode.Uri` without importing vscode here).
 */
export function configFilenameFromUri(uri: { path: string }): string {
  const path = uri.path;
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/**
 * Return the parent-folder path of a URI's `.path` field (everything up
 * to, but not including, the last `/`). Returns `/` for a top-level
 * resource and the input itself when there is no `/`. Used as a stable
 * grouping key for conflict detection.
 */
export function parentPathOf(uri: { path: string }): string {
  const path = uri.path;
  const idx = path.lastIndexOf('/');
  if (idx < 0) return path;
  return idx === 0 ? '/' : path.slice(0, idx);
}

/** One detected filename-pair conflict, keyed structurally. */
export interface ConfigConflictPair<T> {
  /** Parent-folder path the pair shares. */
  parentPath: string;
  /** The `.sync.jsonc` member of the pair. */
  legacy: T;
  /** The `.roomSync` member of the pair. */
  roomSync: T;
}

export interface ConfigPartition<T> {
  /** URIs to feed into the loader — at most one per parent folder. */
  keep: T[];
  /** Same-folder pairs to surface as conflicts. */
  conflicts: ConfigConflictPair<T>[];
}

/**
 * Pure: group URIs by parent folder, picking `.roomSync` as the winner
 * when both filenames appear in the same folder. Pathological cases
 * (three+ matches in one folder, or a 2-file group that isn't the
 * expected legacy/roomSync split) fall through with every URI kept — the
 * glob only matches the two honoured names today, so this branch is
 * effectively dead but defensive for future glob extensions.
 *
 * Generic over the URI type so the wired layer can pass `vscode.Uri[]`
 * unchanged, and tests can pass `{ path: string }` literals.
 */
export function partitionConfigUris<T extends { path: string }>(
  uris: readonly T[],
): ConfigPartition<T> {
  const byParent = new Map<string, T[]>();
  for (const u of uris) {
    const key = parentPathOf(u);
    const list = byParent.get(key) ?? [];
    list.push(u);
    byParent.set(key, list);
  }
  const keep: T[] = [];
  const conflicts: ConfigConflictPair<T>[] = [];
  for (const [parentPath, group] of byParent) {
    if (group.length === 1) {
      keep.push(group[0]);
      continue;
    }
    const legacy = group.find((u) => configFilenameFromUri(u) === '.sync.jsonc');
    const roomSync = group.find((u) => configFilenameFromUri(u) === '.roomSync');
    if (group.length === 2 && legacy && roomSync) {
      conflicts.push({ parentPath, legacy, roomSync });
      keep.push(roomSync);
    } else {
      keep.push(...group);
    }
  }
  return { keep, conflicts };
}
