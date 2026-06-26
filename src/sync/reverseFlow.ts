// Reverse-flow copy: push a destination's version of a file back to the
// source, making the destination-side edit canonical so the next dry run
// replicates it to the other destinations.
//
// Two callers in the plan webview (see planView.ts):
//   - "Promote to source" on an `update-collision` row — the destination
//     edited a tracked file; copy that edit back over the source.
//   - "Copy to source" on a `destination-only` row — a file was created in
//     the destination with no source counterpart; copy it to the source.
//
// Both are the same byte copy (dest → source); only the caller's manifest
// bookkeeping differs (promote rewrites the dest manifest entry so the file
// reads as in-sync afterwards; copy leaves it for the next sync to track).
//
// Pure module, no vscode import — the FS work goes through the same injected
// `SyncFs<U>` contract the executor uses, so it's unit-testable under plain
// Node with a fake fs (see test/sync-reverse-flow.test.ts). The vscode-wired
// caller plugs `vscodeFs()` in.
//
// Atomic write contract mirrors the executor: write `<source>.tmp` then
// rename over the final source path, so the source file is never left
// half-written. A failed rename cleans up the tmp and surfaces the error.

import type { SyncFs } from './executor';

const TMP_SUFFIX = '.tmp';

export interface ReverseCopyOptions<U> {
  /** Source-folder root the file is copied *into*. */
  sourceRootUri: U;
  /**
   * Source-relative path to write. For an alias-rewritten collision this is
   * the pre-rewrite on-disk source path (`item.aliasOrigin.sourceRelPath`);
   * otherwise it coincides with the destination relpath.
   */
  sourceRelPath: string;
  /** Destination-folder root the file is copied *from* (includes any subpath). */
  destRootUri: U;
  /** Destination-relative path of the file to promote/copy. */
  destRelPath: string;
  fs: SyncFs<U>;
  /** Per-bytes hash; in production sha256Hex via crypto.subtle. */
  hash: (bytes: Uint8Array) => Promise<string>;
}

export interface ReverseCopyResult {
  status: 'ok' | 'failed';
  /** sha256 of the copied bytes — the caller uses it to update the manifest. */
  sha256?: string;
  /** Byte length of the copied file. */
  size?: number;
  /** Present iff status='failed'. */
  error?: string;
}

/**
 * Copy the destination's bytes for one file back over the source, atomically.
 * Returns the copied bytes' hash + size on success so the caller can record a
 * manifest entry; never throws — failures land in `result.error`.
 */
export async function copyDestToSource<U extends { toString(): string }>(
  opts: ReverseCopyOptions<U>,
): Promise<ReverseCopyResult> {
  const { fs } = opts;
  const destUri = fs.joinPath(opts.destRootUri, opts.destRelPath);
  const sourceUri = fs.joinPath(opts.sourceRootUri, opts.sourceRelPath);
  const tmpUri = fs.joinPath(opts.sourceRootUri, opts.sourceRelPath + TMP_SUFFIX);

  try {
    const bytes = await fs.readFile(destUri);
    const sha256 = await opts.hash(bytes);

    await fs.writeFile(tmpUri, bytes);
    try {
      await fs.rename(tmpUri, sourceUri);
    } catch (err) {
      // Best-effort cleanup so a failed promote leaves no <source>.tmp behind.
      try { await fs.delete(tmpUri); } catch { /* ignore */ }
      throw err;
    }

    return { status: 'ok', sha256, size: bytes.byteLength };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}
