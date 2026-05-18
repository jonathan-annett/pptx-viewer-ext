// Pure data types and helpers for the sync manifest.
//
// Split out from manifest.ts so the plan engine (which only needs the types
// and the key helper) can be unit-tested under plain Node without pulling
// in the vscode import.

export interface ManifestEntry {
  destPath: string;
  size: number;
  sha256: string;
  syncedAt: string;
}

export interface ManifestDecision {
  destOnlyDelete: boolean;
  collisionOverwrite: boolean;
  decidedAt: string;
}

export interface Manifest {
  version: 1;
  lastSync: string | null;
  entries: { [key: string]: ManifestEntry };
  decisions: { [key: string]: ManifestDecision };
}

export function emptyManifest(): Manifest {
  return { version: 1, lastSync: null, entries: {}, decisions: {} };
}

/**
 * Build the manifest key for a given source identity + relative path.
 * The source identity is the source workspace folder name (per plan).
 */
export function manifestKey(sourceWorkspaceFolder: string, relPath: string): string {
  return `${sourceWorkspaceFolder}:${relPath}`;
}
