// Pure types + classifier for the manifest drift badge (M4).
//
// "Drift" is the mismatch between an entry's `sha256` in the manifest
// (the hash at sync-placement time) and the actual hash of the file on
// disk *as of the last drift pass*. The classifier is the boundary
// between FS observations (does the file exist? what's its current
// hash?) and the four UI states the manifest editor renders.
//
// Pairs with `manifestDriftWired.ts` (vscode-driven stat + hash loop)
// per the project's pure/wired split convention. tsx-testable.

/**
 * Four UI states a manifest row can be in:
 *
 *   - `matches`   — on-disk hash equals the manifest's sha256.
 *   - `drifted`   — on-disk hash differs (hand-edit, partial overwrite,
 *                   interrupted sync, etc.).
 *   - `missing`   — file not present at the entry's destPath.
 *   - `computing` — drift not yet calculated. Initial render state; also
 *                   surfaces while a recompute is in flight.
 */
export type DriftStatus = 'matches' | 'drifted' | 'missing' | 'computing';

export interface DriftRecord {
  status: DriftStatus;
  /**
   * On-disk sha256 at the time of classification. Present for the
   * terminal states `matches` and `drifted`; absent for `missing` and
   * `computing`. The renderer uses it to populate the drifted-row
   * tooltip (`expected <a> vs on-disk <b>`).
   */
  actualSha256?: string;
}

export type ManifestDriftMap = Map<string /* manifest entry key */, DriftRecord>;

/**
 * Classify a single manifest row against an FS observation. Pure — the
 * wired layer is responsible for the stat + hash calls and translates
 * their results into the four-argument shape this function consumes.
 *
 * The `entryKey` argument is forwarded by the caller for context (it's
 * useful in log lines, and keeps the per-row API symmetric with the
 * `ManifestDriftMap` key shape). It does not affect classification.
 *
 *   fileExists=false                            → missing
 *   fileExists=true,  actualSha undefined       → computing  (defensive;
 *                                                  callers should only
 *                                                  pass undefined while
 *                                                  the hash is in flight)
 *   fileExists=true,  actualSha === expected    → matches
 *   fileExists=true,  actualSha !== expected    → drifted
 */
export function computeDriftRow(
  entryKey: string,
  expectedSha: string,
  actualSha: string | undefined,
  fileExists: boolean,
): DriftRecord {
  void entryKey;
  if (!fileExists) return { status: 'missing' };
  if (actualSha === undefined) return { status: 'computing' };
  if (actualSha === expectedSha) return { status: 'matches', actualSha256: actualSha };
  return { status: 'drifted', actualSha256: actualSha };
}
