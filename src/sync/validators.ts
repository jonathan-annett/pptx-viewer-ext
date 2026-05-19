// Per-file validators for the sync plan.
//
// v1 ships with pptx validators only — the same three checks the pptx viewer
// surfaces. The plan engine attaches the warnings produced here to source-side
// PlanItems; the plan webview renders them as a Validation warnings section.
//
// No vscode import. `parsePptx` is platform-clean (fflate + crypto.subtle), so
// this module runs under tsx tests against synthetic in-memory zips.

import { parsePptx } from '../pptx';
import type { PlanWarning } from './plan';

/** True for paths the pptx validator should run against. */
export function isPptxPath(relPath: string): boolean {
  return /\.pptx$/i.test(relPath);
}

/**
 * Run the pptx flag checks against a file's bytes. Returns one warning per
 * failing flag, empty when the file passes. A corrupt zip (`parseError` set)
 * produces no warnings — there's no useful flag state to report on bytes the
 * parser couldn't open. The pptx viewer surfaces the corrupt-file case via the
 * red error banner; the sync plan's job is just to flag *valid* files whose
 * settings would misbehave in a kiosk slideshow.
 */
export async function validatePptxBytes(
  relPath: string,
  bytes: Uint8Array,
): Promise<PlanWarning[]> {
  // parsePptx wants a FileInfo for display fields we don't use here. mtime=0
  // and size=byteLength keep it self-consistent without a stat round-trip.
  const result = await parsePptx(bytes, {
    fileName: relPath,
    size: bytes.byteLength,
    mtime: 0,
  });
  if (result.parseError) return [];

  const warnings: PlanWarning[] = [];
  if (!result.flags.linkedMedia.ok) {
    warnings.push({
      severity: 'warn',
      code: 'linked-media',
      message: result.flags.linkedMedia.detail,
    });
  }
  if (!result.flags.showType.ok) {
    warnings.push({
      severity: 'warn',
      code: 'show-type',
      message: result.flags.showType.detail,
    });
  }
  if (!result.flags.showMediaControls.ok) {
    warnings.push({
      severity: 'warn',
      code: 'media-controls',
      message: result.flags.showMediaControls.detail,
    });
  }
  return warnings;
}
