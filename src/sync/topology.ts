// Resolves a set of SyncConfigs against the current workspace folders,
// producing a ResolvedTopology that the rest of the sync engine consumes.
//
// Responsibilities:
// - Match each destination's `name` against an open workspace folder
// - Detect subpath collisions (two sources writing to the same dest subpath)
// - Surface load-time diagnostics (warnings + errors) for the Output Channel
//
// This module does no filesystem I/O. It is a pure transform from
// SourceLoad[] + workspaceFolders[] to ResolvedTopology.

import { getHost, type WorkspaceRoot } from './host';
import type { SourceLoad } from './config';

export interface ResolvedDestination<U> {
  /**
   * URI of the destination workspace folder, exactly as written in the
   * config. Stable across folder renames and authoritative for matching.
   */
  uri: string;
  /**
   * Display name of the matched workspace folder, looked up at resolve time
   * from `vscode.workspace.workspaceFolders`. For unresolved URIs we fall
   * back to the last path segment so the UI/logs still print something
   * recognisable. **Display only** — never used for matching.
   */
  name: string;
  /** Subpath within the destination workspace folder (already normalised). */
  subpath: string;
  /** Resolved workspace folder URI, or null if no workspace folder matches the URI. */
  workspaceFolderUri: U | null;
  /** Final URI of the destination root (workspaceFolderUri + subpath), or null if unresolved. */
  destRootUri: U | null;
}

export interface ResolvedSource<U> {
  configUri: U;
  sourceFolderUri: U;
  workspaceFolderUri: U;
  /** Name of the source's enclosing workspace folder. Used as the source
   * identifier in manifest keys. */
  workspaceFolderName: string;
  destinations: ResolvedDestination<U>[];
}

export interface Diagnostic<U> {
  severity: 'error' | 'warning';
  message: string;
  /** Config file the diagnostic is attached to, when applicable. */
  configUri?: U;
}

/**
 * One source folder carrying both `.sync.jsonc` AND `.roomSync` —
 * the room-sync v1 alias landed (see room-sync-format-v1-plan.md M1) but
 * two files of the same logical config can't coexist in one folder. The
 * manager picks `.roomSync` as the deterministic winner so the topology
 * still loads, and records the pair here for the resolve-conflict command
 * to walk.
 */
export interface SyncConfigConflict<U> {
  /** Parent folder both files live in. */
  sourceFolderUri: U;
  /** URI of the `.sync.jsonc` file. */
  legacyUri: U;
  /** URI of the `.roomSync` file. */
  roomSyncUri: U;
}

export interface ResolvedTopology<U> {
  sources: ResolvedSource<U>[];
  /** Sources that failed to load. Kept for diagnostic display. */
  failed: SourceLoad<U>[];
  diagnostics: Diagnostic<U>[];
  /** Folders with both `.sync.jsonc` and `.roomSync`. Populated by the manager. */
  conflicts: SyncConfigConflict<U>[];
}

export function resolveTopology<U extends { toString(): string }>(
  loads: SourceLoad<U>[],
  roots: ReadonlyArray<WorkspaceRoot<U>>,
): ResolvedTopology<U> {
  const { uri } = getHost<U>();
  const diagnostics: Diagnostic<U>[] = [];
  const failed: SourceLoad<U>[] = [];
  const sources: ResolvedSource<U>[] = [];

  const byUri = new Map<string, WorkspaceRoot<U>>();
  for (const f of roots) {
    byUri.set(f.uri.toString(), f);
  }

  for (const load of loads) {
    if (load.config === null) {
      failed.push(load);
      diagnostics.push({
        severity: 'error',
        message: `${displayUri(load.configUri)}: ${load.error ?? 'unknown error'}`,
        configUri: load.configUri,
      });
      continue;
    }

    const resolved: ResolvedDestination<U>[] = [];
    const seenSubpaths = new Set<string>();
    for (const dest of load.config.destinations) {
      const folder = byUri.get(dest.uri);
      const subpath = dest.path ?? '';
      // Dedupe key is `uri::subpath` — two distinct entries with the same URI
      // and subpath collapse, but the same URI with different subpaths are
      // legitimate (one source writing into two child folders of the same
      // workspace folder).
      const dupeKey = `${dest.uri}::${subpath}`;
      const displayName = folder?.name ?? fallbackNameFromUri(dest.uri);
      if (seenSubpaths.has(dupeKey)) {
        diagnostics.push({
          severity: 'error',
          message: `${displayUri(load.configUri)}: duplicate destination '${displayName}'${subpath ? ` at '${subpath}'` : ''}`,
          configUri: load.configUri,
        });
        continue;
      }
      seenSubpaths.add(dupeKey);

      if (!folder) {
        diagnostics.push({
          severity: 'warning',
          message: `${displayUri(load.configUri)}: destination URI '${dest.uri}' is not currently in the workspace`,
          configUri: load.configUri,
        });
        resolved.push({
          uri: dest.uri,
          name: displayName,
          subpath,
          workspaceFolderUri: null,
          destRootUri: null,
        });
        continue;
      }

      resolved.push({
        uri: dest.uri,
        name: displayName,
        subpath,
        workspaceFolderUri: folder.uri,
        destRootUri: subpath === '' ? folder.uri : uri.join(folder.uri, subpath),
      });
    }

    const sourceWsFolder = byUri.get(load.workspaceFolderUri.toString());
    sources.push({
      configUri: load.configUri,
      sourceFolderUri: load.sourceFolderUri,
      workspaceFolderUri: load.workspaceFolderUri,
      workspaceFolderName: sourceWsFolder?.name ?? '<unknown>',
      destinations: resolved,
    });
  }

  // Cross-source destination-URI uniqueness: a workspace folder may be
  // claimed as a destination by at most one .sync.jsonc file. Sharing a
  // destination would make manifest ownership ambiguous (which source's
  // manifest tracks which file?) and lets two sources race writes on the
  // same tree. The room editor's dropdown also filters URIs claimed
  // elsewhere — this diagnostic catches the case where a stale value is
  // already on disk or two configs were edited as raw text.
  const sourcesByDestUri = new Map<string, ResolvedSource<U>[]>();
  for (const src of sources) {
    // De-duplicate within a single source — same URI with different
    // subpaths is already caught by the intra-source check above, and we
    // don't want to count one source twice here.
    const seenInSrc = new Set<string>();
    for (const dest of src.destinations) {
      if (seenInSrc.has(dest.uri)) continue;
      seenInSrc.add(dest.uri);
      const list = sourcesByDestUri.get(dest.uri) ?? [];
      list.push(src);
      sourcesByDestUri.set(dest.uri, list);
    }
  }
  for (const [uri, list] of sourcesByDestUri) {
    if (list.length > 1) {
      const where = list.map((s) => displayUri(s.configUri)).join(', ');
      diagnostics.push({
        severity: 'error',
        message: `destination URI ${uri} is claimed by multiple sources (${where}); each destination can be owned by only one .sync.jsonc`,
      });
    }
  }

  // Subpath-overlap collision: two distinct sources writing into the same
  // resolved destRootUri (URI + subpath). Useful even when the
  // destination-URI uniqueness check above has fired, because the operator
  // wants to see exactly where the collision lands.
  const claimants = new Map<string, ResolvedSource<U>[]>();
  for (const src of sources) {
    for (const dest of src.destinations) {
      if (!dest.destRootUri) continue;
      const key = dest.destRootUri.toString();
      const list = claimants.get(key) ?? [];
      list.push(src);
      claimants.set(key, list);
    }
  }
  for (const [key, list] of claimants) {
    if (list.length > 1) {
      const where = list.map((s) => displayUri(s.configUri)).join(', ');
      diagnostics.push({
        severity: 'error',
        message: `subpath collision at ${key}: claimed by multiple sources (${where})`,
      });
    }
  }

  return { sources, failed, diagnostics, conflicts: [] };
}

/** Render a topology as multi-line text for the Output Channel. */
export function formatTopology<U extends { toString(): string }>(
  topology: ResolvedTopology<U>,
): string {
  const lines: string[] = [];
  lines.push(`Sources: ${topology.sources.length}, failed: ${topology.failed.length}`);
  for (const src of topology.sources) {
    lines.push(`  ${displayUri(src.configUri)}`);
    if (src.destinations.length === 0) {
      lines.push('    (no destinations)');
    }
    for (const dest of src.destinations) {
      const target = dest.destRootUri
        ? dest.destRootUri.toString()
        : `<unresolved: ${dest.uri} not in workspace>`;
      const subpathNote = dest.subpath ? ` path="${dest.subpath}"` : '';
      lines.push(`    → ${dest.name}${subpathNote}  ${target}`);
    }
  }
  if (topology.failed.length > 0) {
    lines.push('Failed sources:');
    for (const f of topology.failed) {
      lines.push(`  ${displayUri(f.configUri)}: ${f.error ?? '?'}`);
    }
  }
  if (topology.diagnostics.length > 0) {
    lines.push('Diagnostics:');
    for (const d of topology.diagnostics) {
      lines.push(`  [${d.severity}] ${d.message}`);
    }
  }
  return lines.join('\n');
}

function displayUri<U extends { toString(): string }>(target: U): string {
  // Workspace-relative path is more useful than the full URI in diagnostics.
  // Falls back to the full URI string when there's no workspace folder match.
  const rel = getHost<U>().workspace.asRelativePath(target);
  return rel || target.toString();
}

/**
 * Derive a short display name from a destination URI when no live workspace
 * folder matches it. The last non-empty path segment is the conventional
 * "folder name" for filesystem-style URIs (`file://`, `vscode-vfs://`, …),
 * and is what vscode.dev defaults to when adding a folder to a workspace.
 */
function fallbackNameFromUri(uriString: string): string {
  try {
    const parsed = getHost().uri.parse(uriString);
    const path = getHost().uri.path(parsed).replace(/\/+$/, '');
    const idx = path.lastIndexOf('/');
    const segment = idx >= 0 ? path.slice(idx + 1) : path;
    const decoded = decodeURIComponent(segment);
    return decoded || uriString;
  } catch {
    return uriString;
  }
}
