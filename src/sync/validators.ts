// Per-file validators for the sync plan.
//
// v1 ships with pptx validators only — the same three checks the pptx viewer
// surfaces. The plan engine attaches the warnings produced here to source-side
// PlanItems; the plan webview renders them as a Validation warnings section.
//
// No vscode import. `parsePptx` is platform-clean (fflate + crypto.subtle), so
// this module runs under tsx tests against synthetic in-memory zips.
//
// M5.3 Phase C — optional cache. When the caller supplies a pre-computed
// sha256 + ParseResultCache, the validator consults the cache first and skips
// the unzip + scan on a hit. On a miss it parses, records, and proceeds.
// The cache is content-addressed so there's no invalidation concern.

import { parsePptx } from '../pptx';
import {
  project,
  snapshotLookup,
  type CachedParseResult,
  type ParseResultCache,
} from './parseCache';
import type { PlanWarning } from './plan';

/** True for paths the pptx validator should run against. */
export function isPptxPath(relPath: string): boolean {
  return /\.pptx$/i.test(relPath);
}

/**
 * Optional cache hookup. When the caller supplies both, the validator looks
 * up `sha256` in the cache; on a hit it reads flags + parseError from the
 * cached record and skips the unzip + scan entirely. On a miss it parses
 * (`parsePptx`) and records the projection into the cache, so the next plan
 * build sees a hit. Both fields together — caller must hand us the sha256 of
 * the bytes (the planner already has it from `hashFileAtUri`).
 */
export interface ValidatePptxOptions {
  sha256?: string;
  cache?: ParseResultCache;
  /**
   * Walk-scoped snapshot of the parse cache, consulted before {@link cache}.
   * Callers walking many files should call `cache.snapshot()` once before
   * the walk and thread the resulting map through every per-file validator
   * call. Snapshot hits skip the IDB round-trip the cache's `lookup()`
   * would otherwise incur — the headline win for a 24-file source walk
   * with all hits warm is ~2.5s → sub-100ms.
   */
  snapshot?: Map<string, CachedParseResult>;
}

/**
 * Run the pptx flag checks against a file's bytes. Returns one warning per
 * failing flag, empty when the file passes. A corrupt zip (`parseError` set)
 * produces no warnings — there's no useful flag state to report on bytes the
 * parser couldn't open. The pptx viewer surfaces the corrupt-file case via the
 * red error banner; the sync plan's job is just to flag *valid* files whose
 * settings would misbehave in a kiosk slideshow.
 *
 * When `opts.sha256` + `opts.cache` are provided, the cache is consulted first
 * and populated on miss. The cache tracks its own hit/miss counters via
 * `stats()` — callers that want per-walk accounting snapshot stats around the
 * call (same pattern as the URI hash cache in walkAndHash).
 */
export async function validatePptxBytes(
  relPath: string,
  bytes: Uint8Array,
  opts: ValidatePptxOptions = {},
): Promise<PlanWarning[]> {
  // Cache fast-path: a hit means we've parsed these exact bytes before and
  // can skip the unzip + scan. Content-addressed, no invalidation needed.
  // snapshotLookup consults opts.snapshot first (sync Map.get — no IDB) then
  // falls through to opts.cache.lookup on miss so any record() that landed
  // mid-walk from another caller is still seen.
  if (opts.sha256 && (opts.snapshot || opts.cache)) {
    const cached = await snapshotLookup(opts.snapshot, opts.cache, opts.sha256);
    if (cached) return warningsFromCachedFlags(cached);
  }

  // parsePptx wants a FileInfo for display fields we don't use here. mtime=0
  // and size=byteLength keep it self-consistent without a stat round-trip.
  const result = await parsePptx(bytes, {
    fileName: relPath,
    size: bytes.byteLength,
    mtime: 0,
  });

  // Populate the cache before deciding on warnings — the result is content-
  // determined, so caching the parseError case is correct (same bytes, same
  // failure, no point re-parsing next time). Cache writes are best-effort
  // inside the IDB tier; failures don't propagate up.
  if (opts.cache) {
    await opts.cache.record(result.sha256, project(result));
  }

  if (result.parseError) return [];

  // Severity per code (see PlanWarning JSDoc for the full rationale):
  //  - linked-media: 'block' — externally-linked media won't play at the
  //    destination; transferring deploys a known-broken file.
  //  - show-type:    'block' — kiosk/browse modes are show-stoppers in a
  //    presentation context; deploy in this state is never desired.
  //  - media-controls: 'override' — controls render a subtle progress bar
  //    over embedded video at playback; ugly at a conference but the file
  //    plays. The user can opt in per file via the plan webview's "Sync
  //    anyway" affordance.
  return buildWarnings(result.flags);
}

/**
 * Same warning shape as the parsed path, but reading flags off the cached
 * record. parseError survives `project()` so corrupt-bytes results round-trip
 * correctly — a cached parseError continues to produce no warnings, matching
 * the fresh-parse path.
 */
function warningsFromCachedFlags(cached: CachedParseResult): PlanWarning[] {
  if (cached.parseError) return [];
  return buildWarnings(cached.flags);
}

function buildWarnings(flags: CachedParseResult['flags']): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  if (!flags.linkedMedia.ok) {
    warnings.push({
      severity: 'block',
      code: 'linked-media',
      message: flags.linkedMedia.detail,
    });
  }
  if (!flags.showType.ok) {
    warnings.push({
      severity: 'block',
      code: 'show-type',
      message: flags.showType.detail,
    });
  }
  if (!flags.showMediaControls.ok) {
    warnings.push({
      severity: 'override',
      code: 'media-controls',
      message: flags.showMediaControls.detail,
    });
  }
  return warnings;
}
