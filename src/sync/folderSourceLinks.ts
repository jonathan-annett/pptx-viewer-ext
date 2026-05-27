// Pure helper: given the resolved topology, find sources that target a
// particular destination folder URI. The admin editor's Folders section uses
// this to render a hyperlink back to each source folder for any destination
// workspace folder that's already wired up.
//
// Lives outside topology.ts so it stays pure (no vscode import) and is
// tsx-runnable from test/sync-folder-source-links.test.ts. Topology entries
// carry vscode.Uri fields, but we only need .toString() — the structural
// types below let callers pass ResolvedSource[] directly.

/** Structural shape of a resolved source we care about for this lookup. */
export interface FolderSourceLinkInputSource {
  configUri: { toString(): string };
  sourceFolderUri: { toString(): string };
  destinations: ReadonlyArray<{
    /** Destination workspace-folder URI as written in `.sync.jsonc`. */
    uri: string;
    /** Already-normalised subpath inside the destination folder. */
    subpath: string;
  }>;
}

/** One matched source pointing at the queried destination folder. */
export interface FolderSourceLink {
  configUri: string;
  sourceFolderUri: string;
  /** Empty string when the source targets the destination root. */
  subpath: string;
}

/**
 * Return every source whose destinations point at `folderUri`. Order matches
 * the input — stable so the renderer's output is deterministic. Multiple
 * subpaths from the same source surface as separate links so the user can see
 * each binding individually.
 */
export function findSourceLinksForFolder(
  sources: ReadonlyArray<FolderSourceLinkInputSource>,
  folderUri: string,
): FolderSourceLink[] {
  const links: FolderSourceLink[] = [];
  for (const src of sources) {
    for (const dest of src.destinations) {
      if (dest.uri === folderUri) {
        links.push({
          configUri: src.configUri.toString(),
          sourceFolderUri: src.sourceFolderUri.toString(),
          subpath: dest.subpath,
        });
      }
    }
  }
  return links;
}
