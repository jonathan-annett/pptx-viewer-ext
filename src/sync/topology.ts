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

import * as vscode from 'vscode';
import type { SourceLoad } from './config';

export interface ResolvedDestination {
  /** Original name as written in the config. */
  name: string;
  /** Subpath within the destination workspace folder (already normalised). */
  subpath: string;
  /** Resolved workspace folder URI, or null if no workspace folder matches the name. */
  workspaceFolderUri: vscode.Uri | null;
  /** Final URI of the destination root (workspaceFolderUri + subpath), or null if unresolved. */
  destRootUri: vscode.Uri | null;
}

export interface ResolvedSource {
  configUri: vscode.Uri;
  sourceFolderUri: vscode.Uri;
  workspaceFolderUri: vscode.Uri;
  /** Name of the source's enclosing workspace folder. Used as the source
   * identifier in manifest keys. */
  workspaceFolderName: string;
  destinations: ResolvedDestination[];
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  /** Config file the diagnostic is attached to, when applicable. */
  configUri?: vscode.Uri;
}

export interface ResolvedTopology {
  sources: ResolvedSource[];
  /** Sources that failed to load. Kept for diagnostic display. */
  failed: SourceLoad[];
  diagnostics: Diagnostic[];
}

export function resolveTopology(
  loads: SourceLoad[],
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): ResolvedTopology {
  const diagnostics: Diagnostic[] = [];
  const failed: SourceLoad[] = [];
  const sources: ResolvedSource[] = [];

  const byName = new Map<string, vscode.WorkspaceFolder>();
  const byUri = new Map<string, vscode.WorkspaceFolder>();
  for (const f of workspaceFolders) {
    byName.set(f.name, f);
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

    const resolved: ResolvedDestination[] = [];
    const seenSubpaths = new Set<string>();
    for (const dest of load.config.destinations) {
      const folder = byName.get(dest.name);
      const subpath = dest.path ?? '';
      const dupeKey = `${dest.name}::${subpath}`;
      if (seenSubpaths.has(dupeKey)) {
        diagnostics.push({
          severity: 'error',
          message: `${displayUri(load.configUri)}: duplicate destination '${dest.name}'${subpath ? ` at '${subpath}'` : ''}`,
          configUri: load.configUri,
        });
        continue;
      }
      seenSubpaths.add(dupeKey);

      if (!folder) {
        diagnostics.push({
          severity: 'warning',
          message: `${displayUri(load.configUri)}: destination '${dest.name}' is not currently in the workspace`,
          configUri: load.configUri,
        });
        resolved.push({
          name: dest.name,
          subpath,
          workspaceFolderUri: null,
          destRootUri: null,
        });
        continue;
      }

      resolved.push({
        name: dest.name,
        subpath,
        workspaceFolderUri: folder.uri,
        destRootUri: subpath === '' ? folder.uri : appendPath(folder.uri, subpath),
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

  // Cross-source collision detection: two distinct sources targeting the
  // same final destination root URI.
  const claimants = new Map<string, ResolvedSource[]>();
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

  return { sources, failed, diagnostics };
}

/** Render a topology as multi-line text for the Output Channel. */
export function formatTopology(topology: ResolvedTopology): string {
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
        : `<unresolved: workspace folder "${dest.name}" not open>`;
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

function appendPath(base: vscode.Uri, subpath: string): vscode.Uri {
  // Subpath has already been normalised (no leading/trailing slash, no doubles).
  const joined = base.path.endsWith('/') ? `${base.path}${subpath}` : `${base.path}/${subpath}`;
  return base.with({ path: joined });
}

function displayUri(uri: vscode.Uri): string {
  // Workspace-relative path is more useful than the full URI in diagnostics.
  // Falls back to fsPath / toString() when there's no workspace folder match.
  const rel = vscode.workspace.asRelativePath(uri, false);
  return rel || uri.toString();
}
