// Host binding + service locator, generic over the URI shape `U`.
//
// The engine modules obtain their host implementations through `getHost<U>()`
// instead of importing `vscode`. A host calls `initHost()` once at startup with
// its implementations — the VS Code extension binds `U = vscode.Uri`; a later
// PWA host binds `U` to a File System Access cursor. This mirrors the codebase's
// existing activation-initialised singleton pattern (`getHashCacheSingleton`,
// `getParseCacheSingleton`). No `vscode` dependency — this lives in core.

import type { SyncFs } from './fs';
import type { UriHelper } from './uri';
import type { WorkspaceProvider } from './workspace';

/** The bundle of host implementations the engine depends on. */
export interface Host<U> {
  readonly fs: SyncFs<U>;
  readonly uri: UriHelper<U>;
  readonly workspace: WorkspaceProvider<U>;
}

// Stored type-erased; the composition root guarantees the installed host's `U`
// matches the `U` every `getHost<U>()` caller asks for.
let current: Host<unknown> | undefined;

/** Install the host implementations. Call once at host startup. */
export function initHost<U>(host: Host<U>): void {
  current = host as Host<unknown>;
}

/** The installed host. Throws if used before `initHost()` (a wiring bug). */
export function getHost<U = unknown>(): Host<U> {
  if (!current) {
    throw new Error(
      'sync host not initialised — call initHost() at activation before using the sync engine',
    );
  }
  return current as Host<U>;
}
