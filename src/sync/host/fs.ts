// Host-agnostic filesystem seam for the sync engine.
//
// Phase 1 home for the `SyncFs<U>` contract (previously inline in
// `executor.ts`), extended with `readDirectory` + a `FileType` enum — the only
// raw `vscode.workspace.fs.readDirectory` / `vscode.FileType` uses that lived
// in `walker.ts`/`planner.ts`. Phase 2 moves this whole `src/sync/host/` dir to
// `pptx-tools-core/src/host/`.
//
// The engine never imports `vscode`; it is parameterised over the URI shape
// `U`. The VS Code host binds `U = vscode.Uri` (see `../vscodeFs.ts` +
// `./vscodeHost.ts`); a later PWA host binds `U` to a File System Access
// cursor. `U` is opaque to the engine — it is only ever obtained from
// `joinPath`/`UriHelper` and passed back into these methods.
//
// `stat` MUST return a real byte size and a real mtime (ms since epoch): the
// URI hash cache uses them to decide whether a cached hash is still valid.
// Returning 0 silently disables the cache.

/**
 * Bitmask matching `vscode.FileType` so the values carry over unchanged when
 * `walker.ts` is decoupled. Deliberately identical to VS Code's enum.
 */
export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

/** A single directory entry — the `[name, FileType]` tuple `walker` consumes. */
export type FsEntry = readonly [name: string, type: FileType];

/** Minimal stat shape the engine relies on (a `vscode.FileStat` subset). */
export interface FsStat {
  /** Size in bytes. Must be real for the hash cache to function. */
  readonly size: number;
  /** Last-modified time, ms since epoch. Must be real and stable across reload. */
  readonly mtime: number;
  /**
   * Entry type, when the host can supply it cheaply (`vscode.FileStat` always
   * does). The planner uses it to tell a file from a directory. Optional so a
   * minimal fake can omit it; production hosts should populate it.
   */
  readonly type?: FileType;
}

/**
 * Error shape the engine recognises for a missing entry. `delete()`/`stat()`
 * implementations throw something with `.code === 'FileNotFound'`; the
 * planner/executor branch on it (see {@link isFileNotFound}).
 */
export class FileNotFoundError extends Error {
  readonly code = 'FileNotFound' as const;
  constructor(path?: string) {
    super(path ? `FileNotFound: ${path}` : 'FileNotFound');
    this.name = 'FileNotFoundError';
  }
}

export function isFileNotFound(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'FileNotFound';
}

/** Abstract FS contract — production wires `vscode.workspace.fs`, tests fake. */
export interface SyncFs<U> {
  /** Resolve a POSIX-style relative path under a root. Implementation owns shape. */
  joinPath(root: U, relPath: string): U;
  /** Cheap metadata lookup used by the URI hash cache. See file header re: real values. */
  stat(uri: U): Promise<FsStat>;
  /** List one directory level. Phase 1 addition (was raw vscode in `walker.ts`). */
  readDirectory(uri: U): Promise<FsEntry[]>;
  readFile(uri: U): Promise<Uint8Array>;
  writeFile(uri: U, bytes: Uint8Array): Promise<void>;
  /** Move `src` onto `dst`, overwriting. The engine's atomic-commit primitive. */
  rename(src: U, dst: U): Promise<void>;
  /** Throw a `FileNotFound`-coded error for a missing target. */
  delete(uri: U): Promise<void>;
}
