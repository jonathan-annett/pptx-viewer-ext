// Recursive directory walker for sync sources and destinations.
//
// Uses vscode.workspace.fs (the only file-access surface available in the
// web-extension host). Returns a flat list of file entries with their
// relative paths, sizes, and mtimes — hashing is deferred to the plan engine
// so we can short-circuit on size mismatch later without paying for hashes
// we don't need.
//
// Excluded directories are pruned at the walk so we don't pay the cost of
// listing into e.g. node_modules just to discard every entry.

import * as vscode from 'vscode';
import { GlobSet } from './glob';

export interface WalkEntry {
  /** Forward-slash path relative to the walk root. */
  relPath: string;
  /** Absolute URI of the file. */
  uri: vscode.Uri;
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
export async function walkTree(
  root: vscode.Uri,
  options: WalkOptions,
): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  await walkInto(root, '', options, out);
  return out;
}

async function walkInto(
  root: vscode.Uri,
  relDir: string,
  options: WalkOptions,
  out: WalkEntry[],
): Promise<void> {
  const dirUri = relDir === '' ? root : joinRel(root, relDir);

  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dirUri);
  } catch {
    // Directory may not exist — that's expected when planning a destination
    // that hasn't been written to yet.
    return;
  }

  for (const [name, fileType] of entries) {
    // Forward-slash relative path. Always use '/' regardless of host OS.
    const childRel = relDir === '' ? name : `${relDir}/${name}`;

    if (fileType & vscode.FileType.Directory) {
      // Prune excluded directories. The glob `node_modules/**` matches both
      // the directory and its contents, so the dir itself is pruned here.
      if (options.exclude.matches(childRel)) continue;
      await walkInto(root, childRel, options, out);
      continue;
    }

    if (!(fileType & vscode.FileType.File)) {
      // SymbolicLink, Unknown, or any other type — skip. The web FS surface
      // resolves symlinks transparently when readable.
      continue;
    }

    if (options.exclude.matches(childRel)) continue;
    if (!options.include.isEmpty() && !options.include.matches(childRel)) continue;

    // Stat once per file. We need size for the plan summary; mtime is for
    // diagnostics only at this stage.
    let stat: vscode.FileStat | undefined;
    try {
      stat = await vscode.workspace.fs.stat(joinRel(root, childRel));
    } catch {
      continue;
    }

    out.push({
      relPath: childRel,
      uri: joinRel(root, childRel),
      size: stat.size,
      mtime: stat.mtime,
    });
  }
}

function joinRel(base: vscode.Uri, relPath: string): vscode.Uri {
  if (relPath === '') return base;
  const basePath = base.path.endsWith('/') ? base.path.slice(0, -1) : base.path;
  return base.with({ path: `${basePath}/${relPath}` });
}
