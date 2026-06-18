// Phase-1 host binding + service locator.
//
// The engine modules obtain their host implementations through `getHost()`
// instead of importing `vscode`. `extension.ts` calls `initHost()` once at
// activation with the VS Code implementations; a later PWA host will call it
// with File System Access implementations. This mirrors the existing
// activation-initialised singleton pattern in the codebase
// (`getHashCacheSingleton`, `getParseCacheSingleton`).
//
// `Uri` is the Phase-1 binding of the engine's URI type to `vscode.Uri`. It is
// the single place that names the concrete host URI shape, so the engine files
// stay free of `import 'vscode'`. Phase 2 makes the engine generic over `U`
// and removes this alias.

import type { Uri as VscodeUri } from 'vscode';
import type { SyncFs } from './fs';
import type { UriHelper } from './uri';
import type { WorkspaceProvider } from './workspace';

/** The engine's URI type. Phase-1 binding to `vscode.Uri`. */
export type Uri = VscodeUri;

/** The bundle of host implementations the engine depends on. */
export interface Host {
  readonly fs: SyncFs<Uri>;
  readonly uri: UriHelper<Uri>;
  readonly workspace: WorkspaceProvider<Uri>;
}

let current: Host | undefined;

/** Install the host implementations. Call once at host startup. */
export function initHost(host: Host): void {
  current = host;
}

/** The installed host. Throws if used before `initHost()` (a wiring bug). */
export function getHost(): Host {
  if (!current) {
    throw new Error(
      'sync host not initialised — call initHost() at activation before using the sync engine',
    );
  }
  return current;
}
