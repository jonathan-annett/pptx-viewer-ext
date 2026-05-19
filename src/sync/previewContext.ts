// Pure classifier for the pptx viewer's "Sync target" section.
//
// Given the URI of the file open in the preview, plus the resolved topology
// (flattened to strings here for purity) plus the manifest of the containing
// workspace folder, decide which of four contexts applies:
//
//   - source: the file lives inside a folder covered by a .sync.jsonc.
//             Caller runs buildScopedDryRunPlan with sourceConfigUri +
//             pathFilter=documentUri and renders the result.
//
//   - uncovered: the file is in workspaceFolders[0] (or any source-eligible
//                folder) but no .sync.jsonc covers it. Caller shows an
//                informational hint.
//
//   - destinationMapped: the file lives in a destination workspace folder,
//                        and the manifest at that folder records "this file
//                        was placed by source X / relPath Y". Caller renders
//                        a scoped plan against source X with attribution.
//
//   - destinationOrphan: the file lives in a destination folder but the
//                        manifest doesn't claim it. Caller shows the
//                        "unique to destination" hint.
//
//   - outsideWorkspace: the file isn't inside any workspace folder. Caller
//                       shows nothing (or falls back to a neutral message).
//
// No vscode import — inputs are strings; the vscode-wired caller marshals
// from ResolvedTopology / vscode.WorkspaceFolder before calling.

import type { Manifest } from './manifest-types';

// ───── input shape ──────────────────────────────────────────────────────

export interface PreviewWorkspaceFolder {
  /** Full URI string (e.g. `file:///foo`). Authoritative; never compared by name. */
  uri: string;
  /** URI `.path` component. Used for ancestor checks against documentPath. */
  path: string;
  /** Display name. Used only for human-readable attribution. */
  name: string;
}

export interface PreviewSource {
  /** `ResolvedSource.configUri.toString()`. Identifies the source uniquely. */
  configUri: string;
  /** URI `.path` of the source's enclosing folder (always equals the
   *  workspace folder path for a top-level .sync.jsonc; deeper for nested). */
  sourceFolderPath: string;
  /** `ResolvedSource.workspaceFolderName`. Used to scope manifest keys. */
  workspaceFolderName: string;
  /** Resolved destinations for this source. Subpath is the prefix the source
   *  writes into within the destination workspace folder root. */
  destinations: ReadonlyArray<{ uri: string; subpath: string }>;
}

export interface PreviewInput {
  /** Full document URI (e.g. `file:///foo/bar.pptx`). */
  documentUri: string;
  /** Document URI `.path` component. */
  documentPath: string;
  workspaceFolders: ReadonlyArray<PreviewWorkspaceFolder>;
  sources: ReadonlyArray<PreviewSource>;
  /** Manifest at the containing workspace folder root, or null when unknown
   *  (the caller can skip the read for source/uncovered contexts). */
  manifest: Manifest | null;
}

// ───── output shape ─────────────────────────────────────────────────────

export type PreviewContext =
  | { kind: 'outsideWorkspace' }
  | {
      kind: 'source';
      /** Hand straight to buildScopedDryRunPlan. */
      sourceConfigUri: string;
      /** Source-relative path of the document. Display only. */
      relPath: string;
      /** Display name of the workspace folder containing the source. */
      workspaceFolderName: string;
    }
  | {
      kind: 'uncovered';
      workspaceFolderName: string;
      /** Path of the document relative to its workspace folder root. */
      relPath: string;
    }
  | {
      kind: 'destinationMapped';
      /** Workspace folder housing the file (the destination). */
      destinationWorkspaceFolderName: string;
      /** configUri of the source that placed the file here. */
      sourceConfigUri: string;
      /** workspaceFolderName of the source — for human-readable attribution
       *  and for naming the source in the per-file plan. */
      sourceWorkspaceFolderName: string;
      /** Path of the file as it appears inside the source tree (the
       *  manifest key's tail). Used to build the scoped plan filter. */
      sourceRelPath: string;
    }
  | {
      kind: 'destinationOrphan';
      destinationWorkspaceFolderName: string;
      /** Path of the document relative to the destination workspace folder
       *  root. Useful in the "unique to destination" hint. */
      relPath: string;
    };

// ───── classifier ───────────────────────────────────────────────────────

export function classifyPreviewContext(input: PreviewInput): PreviewContext {
  const containing = findContainingFolder(input.documentPath, input.workspaceFolders);
  if (!containing) return { kind: 'outsideWorkspace' };

  // 1. Source case wins when applicable. Nearest-config rule: the deepest
  //    source whose sourceFolderPath is an ancestor of documentPath.
  const candidates = input.sources
    .map((s) => ({ source: s, rel: relFromAncestor(s.sourceFolderPath, input.documentPath) }))
    .filter((c): c is { source: PreviewSource; rel: string } => c.rel !== null);
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.source.sourceFolderPath.length - a.source.sourceFolderPath.length);
    const nearest = candidates[0];
    return {
      kind: 'source',
      sourceConfigUri: nearest.source.configUri,
      relPath: nearest.rel,
      workspaceFolderName: containing.name,
    };
  }

  // 2. Destination case: any source claiming this workspace folder as a dest.
  const destinationClaims = collectDestinationClaims(containing.uri, input.sources);
  if (destinationClaims.length > 0) {
    const relInFolder = relFromAncestor(containing.path, input.documentPath);
    if (relInFolder === null) {
      // Shouldn't happen — containing was found by ancestry — but be tolerant.
      return { kind: 'outsideWorkspace' };
    }

    // Manifest lookup: which source's entry has destPath === relInFolder?
    if (input.manifest) {
      for (const claim of destinationClaims) {
        const hit = findManifestEntryByDestPath(input.manifest, claim.workspaceFolderName, relInFolder);
        if (hit) {
          return {
            kind: 'destinationMapped',
            destinationWorkspaceFolderName: containing.name,
            sourceConfigUri: claim.configUri,
            sourceWorkspaceFolderName: claim.workspaceFolderName,
            sourceRelPath: hit.relPath,
          };
        }
      }
    }

    return {
      kind: 'destinationOrphan',
      destinationWorkspaceFolderName: containing.name,
      relPath: relInFolder,
    };
  }

  // 3. Uncovered: in a workspace folder but neither source nor destination.
  const relInFolder = relFromAncestor(containing.path, input.documentPath) ?? '';
  return {
    kind: 'uncovered',
    workspaceFolderName: containing.name,
    relPath: relInFolder,
  };
}

// ───── helpers ──────────────────────────────────────────────────────────

/**
 * Pick the longest workspace folder whose path is an ancestor of (or equal
 * to) documentPath. Returns null when documentPath is outside every folder.
 */
function findContainingFolder(
  documentPath: string,
  folders: ReadonlyArray<PreviewWorkspaceFolder>,
): PreviewWorkspaceFolder | null {
  let best: PreviewWorkspaceFolder | null = null;
  let bestLen = -1;
  for (const f of folders) {
    if (isAncestorOrEqual(f.path, documentPath) && f.path.length > bestLen) {
      best = f;
      bestLen = f.path.length;
    }
  }
  return best;
}

/**
 * Forward-slash relative path from `ancestorPath` down to `targetPath`, or
 * null when `targetPath` is not at or below `ancestorPath`. Matches the
 * convention used by `relPathFromBase` in scopedPlan.ts — kept independent
 * here so this module has no inter-pure-module dependency beyond types.
 */
function relFromAncestor(ancestorPath: string, targetPath: string): string | null {
  const a = stripTrailingSlash(ancestorPath);
  const t = stripTrailingSlash(targetPath);
  if (t === a) return '';
  if (t.startsWith(`${a}/`)) return t.slice(a.length + 1);
  return null;
}

function isAncestorOrEqual(ancestorPath: string, targetPath: string): boolean {
  return relFromAncestor(ancestorPath, targetPath) !== null;
}

function stripTrailingSlash(p: string): string {
  return p.endsWith('/') ? p.slice(0, -1) : p;
}

interface DestinationClaim {
  configUri: string;
  workspaceFolderName: string;
  subpath: string;
}

function collectDestinationClaims(
  destinationFolderUri: string,
  sources: ReadonlyArray<PreviewSource>,
): DestinationClaim[] {
  const claims: DestinationClaim[] = [];
  for (const src of sources) {
    for (const dest of src.destinations) {
      if (dest.uri === destinationFolderUri) {
        claims.push({
          configUri: src.configUri,
          workspaceFolderName: src.workspaceFolderName,
          subpath: dest.subpath,
        });
      }
    }
  }
  return claims;
}

/**
 * Find the manifest entry that this source placed at `destPath` (path under
 * the destination workspace folder root). Returns the source-relative path
 * extracted from the manifest key, or null when no entry matches.
 */
function findManifestEntryByDestPath(
  manifest: Manifest,
  sourceWorkspaceFolderName: string,
  destPath: string,
): { relPath: string } | null {
  const prefix = `${sourceWorkspaceFolderName}:`;
  for (const [key, entry] of Object.entries(manifest.entries)) {
    if (!key.startsWith(prefix)) continue;
    if (entry.destPath !== destPath) continue;
    return { relPath: key.slice(prefix.length) };
  }
  return null;
}
