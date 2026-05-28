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
 * Discovery glob — matches every honoured source-config filename anywhere
 * in the tree:
 *  - `.sync.jsonc`         (legacy folder-level)
 *  - `.roomSync`           (forward folder-level alias, M1)
 *  - `<dest>.roomSync`     (workspace-root logical-destination handle, M3)
 *
 * Minimatch's `*` doesn't cross a leading dot, so `*.roomSync` matches
 * `Room1.roomSync` etc. but not the bare `.roomSync` (which the explicit
 * alternative covers). The M3 *workspace-root-only* semantics for named
 * `.roomSync` files are enforced in the manager's post-discovery filter,
 * not at the glob layer — a named `.roomSync` deep in a sub-folder is
 * still matched here, then logged + dropped before it reaches the loader.
 *
 * Used by `workspace.findFiles`, `createFileSystemWatcher`, the
 * source-intent probes in destinationOnlyWired/restoreFlow, and the
 * schema-registration `fileMatch` (which gets a tree-rooted form so the
 * IntelliSense surface is identical for both variants).
 */
export const SYNC_CONFIG_GLOB = '**/{.sync.jsonc,.roomSync,*.roomSync}';

/** True when the given filename (no path) is a recognised source-config name. */
export function isSyncConfigFilename(name: string): name is SyncConfigFilename {
  return (SYNC_CONFIG_FILENAMES as readonly string[]).includes(name);
}

/**
 * True iff `filename` is a workspace-root **named** `.roomSync` config —
 * i.e. ends with `.roomSync` AND has a non-empty prefix. The bare
 * `.roomSync` (a folder-level config that happens to sit at the workspace
 * root) returns false: its semantics are the legacy "this folder is a
 * source", not the M3 "logical destination handle".
 *
 * `Room1.roomSync` → true; `.roomSync` → false; `.sync.jsonc` → false;
 * `roomSync` (no dot prefix) → false.
 */
export function isNamedRoomSyncFilename(filename: string): boolean {
  const idx = filename.lastIndexOf('.roomSync');
  // Must end with `.roomSync` AND have at least one prefix char.
  return idx > 0 && filename.slice(idx) === '.roomSync';
}

/**
 * Derive the `${roomSync}` template-variable value for a config file
 * (v1 follow-up — see room-sync-format-v1-plan.md). The variable lets a
 * generator emit one verbatim template that resolves at load time:
 *
 *   "path-aliases": { "${roomSync}/foo": "${roomSync}" }
 *
 * Resolution rules:
 *  - Workspace-root named `<handle>.roomSync` → `<handle>` (filename prefix
 *    minus the extension; M3 logical-destination handle case).
 *  - Folder-level config (`.sync.jsonc` or bare `.roomSync` anywhere below
 *    the workspace folder root) → enclosing folder's basename.
 *  - Bare workspace-root config (`.sync.jsonc` or `.roomSync` directly at
 *    the workspace folder root) → workspace folder's basename.
 *
 * Returns an empty string when nothing meaningful is available (defensive;
 * the rules above cover every path supplied by the discovery + loader).
 * The wired loader passes the empty string to `expandRoomSyncVariable`,
 * which then leaves `${roomSync}` literal — surfaces as a clear error
 * downstream rather than silently substituting empty.
 */
export function roomSyncHandle(configPath: string, workspaceFolderPath: string): string {
  const wsf = workspaceFolderPath.endsWith('/') && workspaceFolderPath.length > 1
    ? workspaceFolderPath.slice(0, -1)
    : workspaceFolderPath;
  const filename = configFilenameFromUri({ path: configPath });
  const parent = parentPathOf({ path: configPath });

  // Workspace-root named: filename prefix is the handle.
  if (parent === wsf && isNamedRoomSyncFilename(filename)) {
    return filename.slice(0, filename.lastIndexOf('.roomSync'));
  }

  // Otherwise: enclosing folder's basename. Falls through to the workspace
  // folder name when the config sits directly at the workspace root with a
  // bare-name filename (`.sync.jsonc` / `.roomSync`).
  const enclosingBasename = parent === '/' || parent === ''
    ? ''
    : parent.slice(parent.lastIndexOf('/') + 1);
  return enclosingBasename;
}

/**
 * True iff the config at `configPath` is a workspace-root named-`.roomSync`
 * config: it sits directly under `workspaceFolderPath` AND its filename is
 * a named variant ({@link isNamedRoomSyncFilename}).
 *
 * Both arguments are `.path`-style strings — caller passes `vscode.Uri.path`
 * fields. Keeping the helper string-typed (vs. taking `vscode.Uri`) is what
 * makes this module testable under plain Node.
 *
 * Returns false for folder-level configs at the workspace root (`.roomSync`,
 * `.sync.jsonc`) and for any config nested below the root — those use the
 * legacy semantics, where `path-aliases` is optional and the source folder
 * is the file's containing directory.
 */
export function isWorkspaceRootNamedConfig(
  configPath: string,
  workspaceFolderPath: string,
): boolean {
  const parent = parentPathOf({ path: configPath });
  const wsf = workspaceFolderPath.endsWith('/') && workspaceFolderPath.length > 1
    ? workspaceFolderPath.slice(0, -1)
    : workspaceFolderPath;
  if (parent !== wsf) return false;
  const filename = configFilenameFromUri({ path: configPath });
  return isNamedRoomSyncFilename(filename);
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
