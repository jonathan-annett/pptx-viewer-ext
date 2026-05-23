// Pre-execute sweep for orphan `.tmp` files left behind by an interrupted
// executor write.
//
// Background: `executor.ts` writes every file as `<path>.tmp` + `rename` for
// atomicity. If the extension host or the browser tab dies between the
// writeFile and the rename, the `.tmp` is left on disk. The destination walk
// would then surface it as a destination-only entry the next time the plan
// is rebuilt — which is misleading (the user never placed it) and visually
// noisy in the plan view.
//
// M6.A added `**/*.tmp` to the planner's BUILT_IN_IGNORES, so orphans no
// longer pollute the plan. This module is the second half: before a run
// executes, sweep each destination subtree and delete any orphaned `.tmp`
// files we can find. Best-effort — failures are logged and don't abort.
//
// This file is the pure half (no vscode import — tsx-testable). The wired
// `vscodeSweepFs()` adapter lives in `orphanSweepWired.ts`.

/** Suffix matched as an orphan tmp file. Mirrors executor.ts TMP_SUFFIX. */
export const ORPHAN_TMP_SUFFIX = '.tmp';

/** Minimum fs surface needed by the sweep. */
export interface SweepFs<U> {
  joinPath(root: U, relPath: string): U;
  readDirectory(uri: U): Promise<Array<[string, FileTypeBits]>>;
  delete(uri: U): Promise<void>;
}

/**
 * Bitset matching `vscode.FileType` — Unknown=0, File=1, Directory=2,
 * SymbolicLink=64. Used as bitwise ops so SymbolicLink|File still counts as
 * file. We only inspect File + Directory; everything else is skipped.
 */
export type FileTypeBits = number;

export interface SweepResult {
  /** Relative paths (forward-slash) of `.tmp` files successfully deleted. */
  deleted: string[];
  /** Relative paths whose delete attempt failed, with the error message. */
  errors: Array<{ relPath: string; message: string }>;
}

/**
 * Walk `root` recursively and delete any file whose basename ends in `.tmp`.
 *
 * Errors reading a directory or deleting a single file are caught and
 * reported in the result — the sweep keeps going. A missing root (e.g. a
 * destination that hasn't been written to yet) returns an empty result, not
 * an error: the executor will create it on first write.
 */
export async function sweepOrphanTmpFiles<U>(
  fs: SweepFs<U>,
  root: U,
): Promise<SweepResult> {
  const deleted: string[] = [];
  const errors: Array<{ relPath: string; message: string }> = [];
  await sweepInto(fs, root, '', deleted, errors);
  return { deleted, errors };
}

async function sweepInto<U>(
  fs: SweepFs<U>,
  root: U,
  relDir: string,
  deleted: string[],
  errors: Array<{ relPath: string; message: string }>,
): Promise<void> {
  const dirUri = relDir === '' ? root : fs.joinPath(root, relDir);

  let entries: Array<[string, FileTypeBits]>;
  try {
    entries = await fs.readDirectory(dirUri);
  } catch {
    // Destination subpath doesn't exist yet — nothing to sweep.
    return;
  }

  for (const [name, fileType] of entries) {
    const childRel = relDir === '' ? name : `${relDir}/${name}`;

    // Bit 2 = Directory in vscode.FileType. Recurse before checking the file
    // case so we sweep into nested layouts (e.g. `subdir/foo.pptx.tmp`).
    if (fileType & 2) {
      await sweepInto(fs, root, childRel, deleted, errors);
      continue;
    }

    // Bit 1 = File. Anything else (Unknown, SymbolicLink without File) — skip.
    if (!(fileType & 1)) continue;
    if (!name.endsWith(ORPHAN_TMP_SUFFIX)) continue;

    const target = fs.joinPath(root, childRel);
    try {
      await fs.delete(target);
      deleted.push(childRel);
    } catch (err) {
      errors.push({
        relPath: childRel,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

