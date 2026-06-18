// Pure URI algebra the engine needs but that the filesystem seam doesn't cover.
//
// Kept separate from `SyncFs` (async FS ops) and `WorkspaceProvider` (roots).
// The implementation fully owns the URI shape `U`; the engine calls these
// instead of reaching into `vscode.Uri` (`.path`, `.with(...)`, `Uri.parse`).
// Phase 2 reconciles this with the core host contract.

export interface UriHelper<U> {
  /** Resolve a POSIX-style relative path under a root (mirrors `SyncFs.joinPath`). */
  join(root: U, relPath: string): U;
  /** Parent "directory" URI. Robust to trailing slashes. */
  dirname(uri: U): U;
  /** POSIX-style path component, for relative-path math (was `uri.path`). */
  path(uri: U): string;
  /** Parse a stored URI string back into `U` (was `vscode.Uri.parse`). */
  parse(text: string): U;
}
