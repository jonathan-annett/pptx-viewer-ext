// Host-agnostic "what folders are open + where am I running" seam.
//
// Phase 1 absorbs topology.ts's direct calls to
// `vscode.workspace.workspaceFolders`, `vscode.workspace.asRelativePath`, and
// host detection. VS Code host: wraps the `vscode.workspace.*` APIs. PWA host
// (Phase 6): backs roots with persisted FileSystemDirectoryHandles + the File
// System Access permission cache.
//
// Phase 1 scope note: `listRoots`/`restore` are synchronous here because the
// VS Code host exposes `workspaceFolders` synchronously and `resolveTopology`
// consumes the roots synchronously. The PWA impl (Phase 6) reads handles from
// IndexedDB and will need the async form the core skeleton anticipates — that
// async-ification is deferred to the phase that introduces the PWA provider.

/** Permission/availability state of a root (drives the PWA reconnect UI later). */
export type RootStatus =
  | 'ready' // permission granted, usable now
  | 'needs-reconnect' // handle persisted but permission needs a user gesture
  | 'missing'; // handle gone (e.g. cleared storage)

export interface WorkspaceRoot<U> {
  /** Stable id for the slot (used as the IndexedDB key on the PWA). */
  readonly id: string;
  /** Human label (folder name) for chrome/status bar and diagnostics. */
  readonly name: string;
  /** The engine's root URI for this folder, fed into `SyncFs.joinPath`. */
  readonly uri: U;
  readonly status: RootStatus;
}

export interface WorkspaceProvider<U> {
  /** Roots currently known. */
  listRoots(): ReadonlyArray<WorkspaceRoot<U>>;
  /** Compute a display-relative path for a uri (was `asRelativePath`). */
  asRelativePath(uri: U): string;
  /** True on browser/web hosts (vscode.dev or the PWA); gates web-only paths. */
  isWebHost(): boolean;
  /** Restore previously-open roots at startup (VS Code: native; PWA: persisted handles). */
  restore(): ReadonlyArray<WorkspaceRoot<U>>;
}
