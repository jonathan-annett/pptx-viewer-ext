// Abstract filesystem contract shared by the hash + fs helpers.
//
// Extracted from the (removed) sync executor so the surviving hash/vscodeFs
// helpers keep a single FS abstraction without dragging the sync engine along.

/** Abstract FS contract — production wires vscode.workspace.fs, tests fake. */
export interface SyncFs<U> {
  /** Resolve a relative path under a root URI. Implementation owns URI shape. */
  joinPath(root: U, relPath: string): U;
  /**
   * Cheap metadata lookup used by the URI hash cache to decide whether a
   * previous hash for this file is still valid. `mtime` is ms since epoch
   * (vscode.FileStat shape); fake implementations may return 0.
   */
  stat(uri: U): Promise<{ size: number; mtime: number }>;
  readFile(uri: U): Promise<Uint8Array>;
  writeFile(uri: U, bytes: Uint8Array): Promise<void>;
  rename(src: U, dst: U): Promise<void>;
  /** Throw a FileSystemError-shaped object (.code='FileNotFound') for missing. */
  delete(uri: U): Promise<void>;
}
