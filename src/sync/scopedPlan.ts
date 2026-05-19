// Pure helpers for scope-restricted dry-run plans.
//
// A "scope" narrows a workspace-wide plan to a single source plus an optional
// path filter — either a subdirectory of that source, or one specific file.
// The vscode-wired planner (planner.ts) walks full source/destination trees
// and then filters through these helpers; the classifier (plan.ts) stays
// unchanged. Keeping the predicates and manifest filtering pure means the
// scoping logic is unit-testable under tsx without a vscode shim.
//
// Performance note: when scope is a single file we still walk the full tree
// and filter, which is wasteful for the per-file pptx preview. That's
// accepted for v1 (see folder-sync-v1-plan.md M4.7 "Open design questions").
// The optimisation lives in planner.ts when revisited.

import type { FileInfo } from './plan';
import type { Manifest, ManifestEntry } from './manifest-types';
import { emptyManifest } from './manifest-types';

export type Scope =
  | { kind: 'none' }
  /** Files at-or-below relPrefix participate. relPrefix is forward-slash, no
   *  leading or trailing slash, never empty (use { kind: 'none' } for root). */
  | { kind: 'directory'; relPrefix: string }
  /** Exactly one file participates. relPath is forward-slash, relative to the
   *  source folder root. */
  | { kind: 'file'; relPath: string };

/** Predicate: does `relPath` fall within `scope`? */
export function inScope(relPath: string, scope: Scope): boolean {
  switch (scope.kind) {
    case 'none':
      return true;
    case 'directory':
      return relPath === scope.relPrefix || relPath.startsWith(`${scope.relPrefix}/`);
    case 'file':
      return relPath === scope.relPath;
  }
}

/**
 * Compute a forward-slash relative path from `basePath` to `targetPath`, or
 * null if `targetPath` is not at or below `basePath`. Operates on the URI
 * `.path` component only — caller is responsible for ensuring both paths
 * come from the same URI scheme/authority.
 *
 * Returns '' when target equals base (i.e. the scope is the source root).
 */
export function relPathFromBase(basePath: string, targetPath: string): string | null {
  const b = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const t = targetPath.endsWith('/') ? targetPath.slice(0, -1) : targetPath;
  if (t === b) return '';
  if (t.startsWith(`${b}/`)) return t.slice(b.length + 1);
  return null;
}

/**
 * Turn a source-relative path (empty string = source root, plus optional
 * `isFile` discriminator) into a Scope. Use this from the vscode-wired side
 * after resolving a pathFilter URI against the source folder URI.
 */
export function scopeFromRelPath(relPath: string, isFile: boolean): Scope {
  if (relPath === '') return { kind: 'none' };
  if (isFile) return { kind: 'file', relPath };
  return { kind: 'directory', relPrefix: relPath };
}

/** Filter a flat FileInfo list to only entries inside `scope`. */
export function filterFilesToScope(files: readonly FileInfo[], scope: Scope): FileInfo[] {
  if (scope.kind === 'none') return [...files];
  return files.filter((f) => inScope(f.relPath, scope));
}

/**
 * Filter a manifest to only the entries that fall within `scope` *for the
 * given source*. Entries owned by other sources pass through unchanged so
 * downstream collision detection still sees them; the classifier already
 * ignores foreign-source entries via its prefix check.
 *
 * Out-of-scope entries from the named source are dropped so the classifier
 * does not surface delete-tracked operations for files outside the scope.
 */
export function filterManifestToScope(
  manifest: Manifest,
  sourceWorkspaceFolderName: string,
  scope: Scope,
): Manifest {
  if (scope.kind === 'none') return manifest;
  const out = emptyManifest();
  out.version = manifest.version;
  out.lastSync = manifest.lastSync;
  const prefix = `${sourceWorkspaceFolderName}:`;
  for (const [key, entry] of Object.entries(manifest.entries) as Array<[string, ManifestEntry]>) {
    if (key.startsWith(prefix)) {
      const rel = key.slice(prefix.length);
      if (inScope(rel, scope)) out.entries[key] = entry;
    } else {
      // Foreign-source entry; preserved verbatim.
      out.entries[key] = entry;
    }
  }
  // Decisions are keyed the same way as entries; apply the same scope rule.
  for (const [key, decision] of Object.entries(manifest.decisions)) {
    if (key.startsWith(prefix)) {
      const rel = key.slice(prefix.length);
      if (inScope(rel, scope)) out.decisions[key] = decision;
    } else {
      out.decisions[key] = decision;
    }
  }
  return out;
}
