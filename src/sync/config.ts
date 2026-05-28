// vscode-wired loader for .sync.jsonc files.
//
// Pairs with the pure parser in configParse.ts (see the pure/wired split
// convention in CLAUDE.md): config.ts handles I/O and Uri types; the parse +
// schema validation lives in configParse.ts so it's runnable under plain Node
// for tests.
//
// Never throws — read errors and parse errors are converted to a SourceLoad
// with config=null and a human-readable `error` string. Callers surface these
// via the Output Channel.

import * as vscode from 'vscode';
import {
  expandRoomSyncVariable,
  parseSyncConfigText,
  validateWorkspaceRootConfig,
  type SyncConfig,
} from './configParse';
import {
  configFilenameFromUri,
  isWorkspaceRootNamedConfig,
  roomSyncHandle,
} from './configFilenames';

export type { SyncConfig, SyncDestination } from './configParse';
export { parseSyncConfigText } from './configParse';

/** Result of loading one .sync.jsonc file. */
export interface SourceLoad {
  /** URI of the .sync.jsonc file itself. */
  configUri: vscode.Uri;
  /** URI of the folder containing the config — the source root. */
  sourceFolderUri: vscode.Uri;
  /** URI of the workspace folder this source lives inside. */
  workspaceFolderUri: vscode.Uri;
  /** Parsed and validated config, or null if the file could not be loaded. */
  config: SyncConfig | null;
  /** Populated when config is null. Human-readable. */
  error?: string;
}

/**
 * Read a .sync.jsonc at the given URI and return a SourceLoad describing
 * either the parsed config or the failure reason.
 */
export async function loadSyncConfig(
  configUri: vscode.Uri,
  workspaceFolderUri: vscode.Uri,
): Promise<SourceLoad> {
  const sourceFolderUri = parentUri(configUri);
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(configUri);
  } catch (err) {
    return {
      configUri,
      sourceFolderUri,
      workspaceFolderUri,
      config: null,
      error: `read failed: ${errMsg(err)}`,
    };
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    return {
      configUri,
      sourceFolderUri,
      workspaceFolderUri,
      config: null,
      error: `not valid utf-8: ${errMsg(err)}`,
    };
  }

  // Expand `${roomSync}` template tokens (v1 follow-up). Handle resolution:
  // workspace-root named .roomSync → filename prefix; folder-level config →
  // enclosing folder basename. Lets a generator emit one verbatim template
  // per logical destination; the editor still sees the raw text via the
  // form's own renderFor path (which bypasses this expansion on purpose).
  const handle = roomSyncHandle(configUri.path, workspaceFolderUri.path);
  text = expandRoomSyncVariable(text, handle);

  const parsed = parseSyncConfigText(text);
  if (parsed.kind === 'error') {
    return {
      configUri,
      sourceFolderUri,
      workspaceFolderUri,
      config: null,
      error: parsed.error,
    };
  }

  // M3 (room-sync-format-v1-plan.md): workspace-root named `.roomSync`
  // configs require a non-empty `path-aliases` field. The bare `.roomSync`
  // and `.sync.jsonc` at any depth — including workspace root — keep the
  // legacy "this folder is the source" semantics where aliases are
  // optional, so the validator is gated by name + location.
  if (isWorkspaceRootNamedConfig(configUri.path, workspaceFolderUri.path)) {
    const filename = configFilenameFromUri(configUri);
    const validation = validateWorkspaceRootConfig(parsed.config, filename);
    if (validation) {
      return {
        configUri,
        sourceFolderUri,
        workspaceFolderUri,
        config: null,
        error: validation.error,
      };
    }
  }

  return {
    configUri,
    sourceFolderUri,
    workspaceFolderUri,
    config: parsed.config,
  };
}

function parentUri(uri: vscode.Uri): vscode.Uri {
  // Robust to trailing slashes. URI path is always forward-slash, even on Windows.
  const path = uri.path;
  const idx = path.lastIndexOf('/');
  const parent = idx <= 0 ? '/' : path.slice(0, idx);
  return uri.with({ path: parent });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
