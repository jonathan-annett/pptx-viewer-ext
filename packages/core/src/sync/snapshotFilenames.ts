// Filenames the extension recognises as a workspace-snapshot file. Both
// share the JSONC format and identical semantics — `.eventSync` is a
// forward-compatible alias for `.admin-sync.jsonc`. Mirrors the pattern in
// `configFilenames.ts` (which aliases `.sync.jsonc` ↔ `.roomSync`).
//
// Centralised here so the watcher pattern, custom-editor selector, conflict
// detection, and probe paths share a single source of truth.
//
// Unlike source configs (which can sit in any folder), the workspace
// snapshot is always written at `workspaceFolders[0]/`. There's no
// "workspace-root-named" variant analogous to `<dest>.roomSync` — the
// snapshot is a singleton per workspace and the alias is purely cosmetic.

export const SNAPSHOT_FILENAMES = ['.admin-sync.jsonc', '.eventSync'] as const;
export type SnapshotFilename = (typeof SNAPSHOT_FILENAMES)[number];

/**
 * Preferred filename for newly-written snapshots. When no snapshot file
 * exists at the target folder yet, the writer uses this. When one of the
 * legacy/alias filenames is already on disk, the writer keeps using it (the
 * conflict surface migrates legacy → preferred when the user explicitly
 * creates the new file).
 */
export const PREFERRED_SNAPSHOT_FILENAME: SnapshotFilename = '.eventSync';

/**
 * Legacy filename that the preferred alias replaces. Kept as a named
 * constant so call sites that need to distinguish the two ends of the
 * migration (conflict resolver, auto-migrate) don't repeat the literal.
 */
export const LEGACY_SNAPSHOT_FILENAME: SnapshotFilename = '.admin-sync.jsonc';

/**
 * Discovery glob — matches every honoured snapshot filename anywhere in the
 * tree. In practice the snapshot lives at `workspaceFolders[0]/`, but the
 * glob form lets it ride the same `findFiles`/`createFileSystemWatcher`
 * APIs used by the source-config side.
 */
export const SNAPSHOT_GLOB = '**/{.admin-sync.jsonc,.eventSync}';

/**
 * Brace-expansion form of the snapshot filenames, suitable for a
 * `RelativePattern` watcher pinned to a specific folder.
 */
export const SNAPSHOT_FILE_PATTERN = '{.admin-sync.jsonc,.eventSync}';

/** True when the given filename (no path) is a recognised snapshot name. */
export function isSnapshotFilename(name: string): name is SnapshotFilename {
  return (SNAPSHOT_FILENAMES as readonly string[]).includes(name);
}

/**
 * Strip the path-prefix of a URI and return the bare filename. Mirrors
 * `configFilenameFromUri` in configFilenames.ts. Works on any object with
 * a `.path: string` so it accepts `vscode.Uri` without importing vscode.
 */
export function snapshotFilenameFromUri(uri: { path: string }): SnapshotFilename | undefined {
  const path = uri.path;
  const idx = path.lastIndexOf('/');
  const name = idx >= 0 ? path.slice(idx + 1) : path;
  return isSnapshotFilename(name) ? name : undefined;
}

/**
 * Return the parent-folder path of a URI's `.path` field. Used as a stable
 * grouping key for conflict detection. Mirrors `parentPathOf` in
 * configFilenames.ts — the duplication is intentional, keeps each pure
 * module independently testable.
 */
export function parentPathOf(uri: { path: string }): string {
  const path = uri.path;
  const idx = path.lastIndexOf('/');
  if (idx < 0) return path;
  return idx === 0 ? '/' : path.slice(0, idx);
}

/** One detected snapshot filename-pair conflict at a single folder root. */
export interface SnapshotConflictPair<T> {
  parentPath: string;
  /** The `.admin-sync.jsonc` member of the pair. */
  legacy: T;
  /** The `.eventSync` member of the pair. */
  eventSync: T;
}

export interface SnapshotPartition<T> {
  /** URIs to consume — at most one per parent folder. */
  keep: T[];
  /** Same-folder pairs to surface as conflicts. */
  conflicts: SnapshotConflictPair<T>[];
}

/**
 * Pure: group URIs by parent folder, picking the preferred filename
 * (`.eventSync`) when both names appear in the same folder. Mirrors
 * `partitionConfigUris` exactly — see that helper's comment for why the
 * pathological branches keep every URI rather than discarding.
 *
 * In normal operation the only folder this will ever see is
 * `workspaceFolders[0]`, but the helper is folder-agnostic for symmetry
 * with the source-config side and to keep test fixtures simple.
 */
export function partitionSnapshotUris<T extends { path: string }>(
  uris: readonly T[],
): SnapshotPartition<T> {
  const byParent = new Map<string, T[]>();
  for (const u of uris) {
    const key = parentPathOf(u);
    const list = byParent.get(key) ?? [];
    list.push(u);
    byParent.set(key, list);
  }
  const keep: T[] = [];
  const conflicts: SnapshotConflictPair<T>[] = [];
  for (const [parentPath, group] of byParent) {
    if (group.length === 1) {
      keep.push(group[0]);
      continue;
    }
    const legacy = group.find((u) => snapshotFilenameFromUri(u) === LEGACY_SNAPSHOT_FILENAME);
    const eventSync = group.find((u) => snapshotFilenameFromUri(u) === PREFERRED_SNAPSHOT_FILENAME);
    if (group.length === 2 && legacy && eventSync) {
      conflicts.push({ parentPath, legacy, eventSync });
      keep.push(eventSync);
    } else {
      keep.push(...group);
    }
  }
  return { keep, conflicts };
}
