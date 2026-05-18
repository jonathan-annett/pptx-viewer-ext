// Parses .sync.yaml files into validated SyncConfig records.
//
// Defensive on bad input: a malformed yaml file produces a SourceLoad with
// config=null and a descriptive error string. Callers surface these via the
// Output Channel rather than throwing.
//
// The parsed shape is intentionally narrow — the v1 schema is just
// destinations / exclude / include. Unknown top-level keys are ignored
// (forward-compat with later versions), but shape errors on known keys are
// reported.

import * as vscode from 'vscode';
import { parseYamlMini } from './yaml-mini';

export interface SyncDestination {
  name: string;
  /** Optional subpath within the destination workspace folder. */
  path?: string;
}

export interface SyncConfig {
  destinations: SyncDestination[];
  /** Glob patterns excluded in addition to built-in ignores. */
  exclude: string[];
  /** Glob patterns to include (default behaviour: everything not excluded). */
  include: string[];
}

/** Result of loading one .sync.yaml file. */
export interface SourceLoad {
  /** URI of the .sync.yaml file itself. */
  yamlUri: vscode.Uri;
  /** URI of the folder containing the yaml — the source root. */
  sourceFolderUri: vscode.Uri;
  /** URI of the workspace folder this source lives inside. */
  workspaceFolderUri: vscode.Uri;
  /** Parsed and validated config, or null if the yaml could not be loaded. */
  config: SyncConfig | null;
  /** Populated when config is null. Human-readable. */
  error?: string;
}

/**
 * Read a .sync.yaml at the given URI and return a SourceLoad describing
 * either the parsed config or the failure reason. Never throws — yaml
 * parse errors and read errors are both converted to error strings.
 */
export async function loadSyncYaml(
  yamlUri: vscode.Uri,
  workspaceFolderUri: vscode.Uri,
): Promise<SourceLoad> {
  const sourceFolderUri = parentUri(yamlUri);
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(yamlUri);
  } catch (err) {
    return {
      yamlUri,
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
      yamlUri,
      sourceFolderUri,
      workspaceFolderUri,
      config: null,
      error: `not valid utf-8: ${errMsg(err)}`,
    };
  }

  let raw: unknown;
  try {
    raw = parseYamlMini(text);
  } catch (err) {
    return {
      yamlUri,
      sourceFolderUri,
      workspaceFolderUri,
      config: null,
      error: `yaml parse error: ${errMsg(err)}`,
    };
  }

  const parsed = validateSchema(raw);
  if (parsed.kind === 'error') {
    return {
      yamlUri,
      sourceFolderUri,
      workspaceFolderUri,
      config: null,
      error: parsed.error,
    };
  }

  return {
    yamlUri,
    sourceFolderUri,
    workspaceFolderUri,
    config: parsed.config,
  };
}

type SchemaResult = { kind: 'ok'; config: SyncConfig } | { kind: 'error'; error: string };

function validateSchema(raw: unknown): SchemaResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'error', error: 'top-level value must be a yaml mapping' };
  }
  const obj = raw as Record<string, unknown>;

  const destinationsRaw = obj.destinations;
  if (!Array.isArray(destinationsRaw) || destinationsRaw.length === 0) {
    return {
      kind: 'error',
      error: '`destinations` is required and must be a non-empty list',
    };
  }

  const destinations: SyncDestination[] = [];
  for (let i = 0; i < destinationsRaw.length; i++) {
    const entry = destinationsRaw[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { kind: 'error', error: `destinations[${i}] must be a mapping` };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string' || e.name.length === 0) {
      return {
        kind: 'error',
        error: `destinations[${i}].name is required and must be a non-empty string`,
      };
    }
    if (e.path !== undefined && typeof e.path !== 'string') {
      return { kind: 'error', error: `destinations[${i}].path must be a string if set` };
    }
    destinations.push({
      name: e.name,
      ...(typeof e.path === 'string' ? { path: normaliseSubpath(e.path) } : {}),
    });
  }

  const exclude = toStringArray(obj.exclude, 'exclude');
  if (exclude.kind === 'error') return exclude;
  const include = toStringArray(obj.include, 'include');
  if (include.kind === 'error') return include;

  return {
    kind: 'ok',
    config: {
      destinations,
      exclude: exclude.value,
      include: include.value,
    },
  };
}

function toStringArray(
  raw: unknown,
  fieldName: string,
): { kind: 'ok'; value: string[] } | { kind: 'error'; error: string } {
  if (raw === undefined || raw === null) return { kind: 'ok', value: [] };
  if (!Array.isArray(raw)) {
    return { kind: 'error', error: `\`${fieldName}\` must be a list of strings if set` };
  }
  for (let i = 0; i < raw.length; i++) {
    if (typeof raw[i] !== 'string') {
      return { kind: 'error', error: `\`${fieldName}\`[${i}] must be a string` };
    }
  }
  return { kind: 'ok', value: raw as string[] };
}

/** Strip leading/trailing slashes; collapse repeats. Empty stays empty. */
function normaliseSubpath(p: string): string {
  return p.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
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
