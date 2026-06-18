// Destination-only workspace detection — pure helper.
//
// "Destination-only mode" is the workspace state where the user opened
// what is functionally a sync destination (one or more workspace folders
// each carrying a `.foldersync-manifest.json` at its root) without
// opening any of the source folders that wrote to them. In that mode
// the source-side UI (Run Sync, Open Admin Config, Show Plan, …) makes
// no sense — there's nothing to sync *from* — so we hide it and promote
// the manifest editor instead. See `destination-operator-view-v1-plan.md`.
//
// This module is the pure decision boundary: it takes the already-
// resolved sync topology, the current workspace folders, and a presence
// map (workspaceFolderUri → has-manifest-at-root?) maintained by the
// wired layer, and returns a boolean. No vscode import; tsx-testable
// under plain Node.

import type { ResolvedTopology } from './topology';

/**
 * Minimal structural shape we need from a workspace folder — just its
 * URI as a string-keyable identity. The wired layer can pass
 * `vscode.workspace.workspaceFolders` directly without any conversion.
 */
export interface WorkspaceFolderLike {
  uri: { toString(): string };
}

/**
 * True when the workspace is exactly one (or more) destination folders
 * with no source `.sync.jsonc` files anywhere. Specifically:
 *
 *   - the resolved topology has zero sources, AND
 *   - at least one currently-open workspace folder has a manifest at
 *     its root (according to `manifestPresence`).
 *
 * `manifestPresence` keys are `WorkspaceFolder.uri.toString()`. Entries
 * for URIs not in `workspaceFolders` are ignored — that way a stale
 * map entry from a just-removed folder can't keep the mode latched on
 * while the wired layer's next rescan is in flight.
 *
 * Returns false when the workspace has no folders at all (no signal to
 * act on).
 */
export function isDestinationOnlyTopology<U>(
  topology: Pick<ResolvedTopology<U>, 'sources'>,
  workspaceFolders: readonly WorkspaceFolderLike[],
  manifestPresence: ReadonlyMap<string, boolean>,
): boolean {
  if (topology.sources.length > 0) return false;
  if (workspaceFolders.length === 0) return false;
  for (const folder of workspaceFolders) {
    if (manifestPresence.get(folder.uri.toString()) === true) {
      return true;
    }
  }
  return false;
}
