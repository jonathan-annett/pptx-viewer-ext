// Misfile guard for source-side files (M5.3 Phase D).
//
// Consults the parse cache's identity index to detect content that has
// been observed at one or more rel-paths different from the source file's
// own path. Returns a single `misfiled-content` PlanWarning when that's
// the case; undefined otherwise.
//
// Severity 'override' — rides the existing warningOverride manifest
// plumbing, so the user can persist "Sync anyway" decisions per file the
// same way they do for media-controls warnings.
//
// Pure module: no vscode import. The planner threads the cache + rel-path
// through; tests construct an in-memory cache directly.

import type { ParseResultCache } from './parseCache';
import type { PlanWarning } from './plan';

/**
 * Build a misfile warning when the cache has recorded `sha256` at any
 * rel-path other than `relPath`. The warning's message lists up to three
 * alternate paths (sorted as-recorded) with a "+N more" suffix when the
 * list is longer.
 *
 * Returns undefined when:
 *   - the cache has no identity record for this sha (cold case)
 *   - every recorded path matches the current rel-path (file is exactly
 *     where it's expected to be)
 */
export async function checkMisfile(
  relPath: string,
  sha256: string,
  parseCache: ParseResultCache,
): Promise<PlanWarning | undefined> {
  const knownAt = await parseCache.lookupIdentity(sha256);
  if (!knownAt || knownAt.length === 0) return undefined;
  const others = knownAt.filter((p) => p !== relPath);
  if (others.length === 0) return undefined;
  const list = others.slice(0, 3).join(', ');
  const ellipsis = others.length > 3 ? `, … (+${others.length - 3} more)` : '';
  return {
    severity: 'override',
    code: 'misfiled-content',
    message: `Same content also at: ${list}${ellipsis}`,
  };
}
