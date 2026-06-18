// Recursive directory walker for sync sources and destinations.
//
// File access goes through the injected `SyncFs` host seam (the VS Code host
// binds it to `vscode.workspace.fs`). Returns a flat list of file entries with
// their relative paths, sizes, and mtimes — hashing is deferred to the plan
// engine so we can short-circuit on size mismatch later without paying for
// hashes we don't need.
//
// Excluded directories are pruned at the walk so we don't pay the cost of
// listing into e.g. node_modules just to discard every entry.

import { FileType, type FsEntry, type FsStat, type SyncFs } from './host';
import { GlobSet } from './glob';

export interface WalkEntry<U> {
  /** Forward-slash path relative to the walk root. */
  relPath: string;
  /** Absolute URI of the file. */
  uri: U;
  /** Size in bytes. */
  size: number;
  /** Modification time in ms since epoch (0 if filesystem doesn't supply it). */
  mtime: number;
}

export interface WalkOptions {
  /** Patterns that prune directories and files. Combine built-ins + user excludes. */
  exclude: GlobSet;
  /** If non-empty, only files matching at least one pattern are included. */
  include: GlobSet;
}

/**
 * Walk a directory tree under `root`, returning every file that survives
 * the exclude/include filters. Returns an empty array if the root doesn't
 * exist (treating "no files" and "no folder" as the same outcome — the
 * planner doesn't care).
 */
export async function walkTree<U>(
  fs: SyncFs<U>,
  root: U,
  options: WalkOptions,
): Promise<WalkEntry<U>[]> {
  const out: WalkEntry<U>[] = [];
  await walkInto(fs, root, '', options, out);
  return out;
}

async function walkInto<U>(
  fs: SyncFs<U>,
  root: U,
  relDir: string,
  options: WalkOptions,
  out: WalkEntry<U>[],
): Promise<void> {
  const dirUri = relDir === '' ? root : fs.joinPath(root, relDir);

  let entries: FsEntry[];
  try {
    entries = await fs.readDirectory(dirUri);
  } catch {
    // Directory may not exist — that's expected when planning a destination
    // that hasn't been written to yet.
    return;
  }

  for (const [name, fileType] of entries) {
    // Forward-slash relative path. Always use '/' regardless of host OS.
    const childRel = relDir === '' ? name : `${relDir}/${name}`;

    if (fileType & FileType.Directory) {
      // Prune excluded directories. The glob `node_modules/**` matches both
      // the directory and its contents, so the dir itself is pruned here.
      if (options.exclude.matches(childRel)) continue;
      await walkInto(fs, root, childRel, options, out);
      continue;
    }

    if (!(fileType & FileType.File)) {
      // SymbolicLink, Unknown, or any other type — skip. The web FS surface
      // resolves symlinks transparently when readable.
      continue;
    }

    if (options.exclude.matches(childRel)) continue;
    if (!options.include.isEmpty() && !options.include.matches(childRel)) continue;

    // Stat once per file. We need size for the plan summary; mtime is for
    // diagnostics only at this stage.
    let stat: FsStat | undefined;
    try {
      stat = await fs.stat(fs.joinPath(root, childRel));
    } catch {
      continue;
    }

    out.push({
      relPath: childRel,
      uri: fs.joinPath(root, childRel),
      size: stat.size,
      mtime: stat.mtime,
    });
  }
}
