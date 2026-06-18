// The host-shell contract for the sync engine. Each host (VS Code extension
// today, PWA later) implements these against its platform; the engine modules
// depend only on these interfaces, never on a concrete host.
//
// Phase 2 moves this directory to `pptx-tools-core/src/host/`.

export { FileType, FileNotFoundError, isFileNotFound } from './fs';
export type { SyncFs, FsEntry, FsStat } from './fs';

export type { UriHelper } from './uri';

export type { WorkspaceProvider, WorkspaceRoot, RootStatus } from './workspace';

export { initHost, getHost } from './current';
export type { Host } from './current';
