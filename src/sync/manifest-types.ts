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

/**
 * A "Don't ask again" decision the user persisted from the plan webview.
 * Exactly one of the three intent fields is true per record; the manifest
 * stores them as a flat record so a single decision file can co-mingle the
 * different categories without a kind discriminator.
 */
export interface ManifestDecision {
  /** User accepted destination-only deletion for this rel-path. */
  destOnlyDelete: boolean;
  /** User accepted overwriting a collision for this rel-path. */
  collisionOverwrite: boolean;
  /**
   * User accepted shipping a file with override-severity warnings (e.g.
   * media-controls visible over embedded video). Doesn't apply to block-
   * severity warnings — those have no per-file override. Decoupled from
   * collisionOverwrite because a row may carry both kinds of decision over
   * its lifetime (and we want to remember each one independently).
   */
  warningOverride: boolean;
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
