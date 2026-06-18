// Pure parse + validation pipeline for the .sync.jsonc schema.
//
// No vscode import — runnable under plain Node via tsx (see test/sync-jsonc.test.ts).
// The vscode-wired side (file I/O) lives in config.ts and delegates the
// text-level work back to parseSyncConfigText.
//
// JSONC = JSON with `//` and `/* */` comments and trailing commas — same
// dialect VS Code uses for settings.json, tasks.json, launch.json. The
// `jsonc-parser` package is the same parser VS Code ships internally; a
// bundled JSON Schema gives the user IntelliSense + validation in a plain
// text editor (see contributes.jsonValidation in package.json).

import { parse as parseJsonc, type ParseError, printParseErrorCode } from 'jsonc-parser';
import { normaliseAliasPath } from './aliasResolve';

/**
 * Replace `${roomSync}` tokens in raw JSONC text with the supplied handle.
 * Pure pre-parse pass — the substituted text is then fed to
 * `parseSyncConfigText`. Used by the wired loaders (`config.ts` /
 * `planner.ts`) so the planner + executor see resolved values; the editor
 * skips this pass so users author the template literally and the form
 * surfaces a separate "resolves to" preview.
 *
 * v1 follow-up of [[room-sync-format-v1-plan]]: lets a generator emit one
 * verbatim template per logical destination (e.g. `breakout-1.roomSync` +
 * `breakout-2.roomSync` both shipping identical bytes) and have the
 * handle resolve from the filename at load time.
 *
 * An empty handle (no meaningful identifier available — defensive only;
 * `roomSyncHandle` covers every layout) means "leave tokens literal"; the
 * parser then surfaces the unresolved token as a path-resolution miss
 * downstream, giving a clear signal rather than silently substituting empty.
 */
export function expandRoomSyncVariable(text: string, handle: string): string {
  if (handle === '') return text;
  return text.replace(/\$\{roomSync\}/g, handle);
}

export interface SyncDestination {
  /**
   * URI of the destination workspace folder, exactly as it appears in
   * `.admin-sync.jsonc` (e.g. `file:///handle/...` in the web extension host).
   *
   * Identifying destinations by URI rather than by display name makes the
   * configuration stable across folder renames — the admin editor's Rename
   * button changes the display name but not the URI. The live display name
   * is read from the matched workspace folder at resolve time.
   */
  uri: string;
  /** Optional subpath within the destination workspace folder. */
  path?: string;
}

export interface SyncConfig {
  destinations: SyncDestination[];
  /** Glob patterns excluded in addition to built-in ignores. */
  exclude: string[];
  /** Glob patterns to include (default behaviour: everything not excluded). */
  include: string[];
  /**
   * Source-rewrite layer (M2 of room-sync-format-v1-plan.md). Each entry
   * maps a source-relative LHS directory to a destination-relative RHS
   * directory. When non-empty, the walker emits one stream per LHS instead
   * of treating the source folder as a single root — files outside every
   * LHS are not synced (no implicit catch-all; users opting into aliases
   * pick exactly what flows through them).
   *
   * Authoring order matters: aliases resolve first-match-wins. JSON object
   * iteration is the authoring order in every parser we use, so the
   * record-of-strings form on disk is preserved as an ordered list here.
   *
   * Both sides have leading/trailing slashes stripped and repeats collapsed
   * — same rules as `destinations[].path`.
   */
  pathAliases: Record<string, string>;
}

export type ParseResult =
  | { kind: 'ok'; config: SyncConfig }
  | { kind: 'error'; error: string };

/**
 * Parse a JSONC document into a validated SyncConfig.
 *
 * Tolerant on input shape (unknown top-level keys are ignored — forward-compat
 * with later schema versions). Strict on the known shape: any malformed known
 * field surfaces as a precise error message rather than being silently dropped.
 */
export function parseSyncConfigText(text: string): ParseResult {
  const errors: ParseError[] = [];
  const raw: unknown = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    // Report the first error verbatim — jsonc-parser carries an offset, but
    // the user already has red squiggles in the editor; the Output Channel
    // just needs to say "something's wrong" with enough detail to find it.
    const first = errors[0];
    return {
      kind: 'error',
      error: `jsonc parse error: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    };
  }
  return validateSchema(raw);
}

function validateSchema(raw: unknown): ParseResult {
  if (raw === null || raw === undefined) {
    return { kind: 'error', error: 'top-level value must be a JSON object' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'error', error: 'top-level value must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;

  const destinationsRaw = obj.destinations;
  if (!Array.isArray(destinationsRaw)) {
    return {
      kind: 'error',
      error: '`destinations` is required and must be an array',
    };
  }
  // Empty `destinations: []` is allowed — represents a "not yet wired up"
  // config. Common for generator-emitted templates (see
  // `scripts/generate-event-folders.ts`): the file is authored ahead of
  // time, the operator drags the destination folder(s) into the workspace
  // and uses the form editor to add the URIs. The topology resolver
  // tolerates zero destinations (the loop is a no-op) and the planner
  // emits no per-destination entries for such a source.

  const destinations: SyncDestination[] = [];
  for (let i = 0; i < destinationsRaw.length; i++) {
    const entry = destinationsRaw[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { kind: 'error', error: `destinations[${i}] must be an object` };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.uri !== 'string' || e.uri.length === 0) {
      return {
        kind: 'error',
        error: `destinations[${i}].uri is required and must be a non-empty string`,
      };
    }
    if (e.path !== undefined && typeof e.path !== 'string') {
      return { kind: 'error', error: `destinations[${i}].path must be a string if set` };
    }
    destinations.push({
      uri: e.uri,
      ...(typeof e.path === 'string' ? { path: normaliseSubpath(e.path) } : {}),
    });
  }

  const exclude = toStringArray(obj.exclude, 'exclude');
  if (exclude.kind === 'error') return exclude;
  const include = toStringArray(obj.include, 'include');
  if (include.kind === 'error') return include;

  // path-aliases can be `path-aliases` (the spec spelling — hyphens read
  // naturally in JSONC and match the field name in the JSON Schema) or
  // `pathAliases` (camelCase, what TypeScript callers see). Accept either
  // so a user typing one form by reflex doesn't get a silent miss.
  const aliasesRaw = obj['path-aliases'] ?? obj.pathAliases;
  const pathAliases = toAliasRecord(aliasesRaw);
  if (pathAliases.kind === 'error') return pathAliases;

  return {
    kind: 'ok',
    config: {
      destinations,
      exclude: exclude.value,
      include: include.value,
      pathAliases: pathAliases.value,
    },
  };
}

/**
 * Validation pass that runs after the generic schema parse for configs at
 * the workspace-root location (`<dest>.roomSync`, M3 of
 * [[room-sync-format-v1-plan]]). The on-disk shape is the same as a
 * folder-level config — same parser — but the workspace-root variant has
 * tighter requirements: `path-aliases` is mandatory, because the source
 * folder is the workspace root and without aliases the engine would have
 * no signal for what to walk under it.
 *
 * Pure function: takes a parsed config + the filename (for the error
 * message's UX context) and returns an error sentinel or null on success.
 * Caller decides how to surface — the wired loader converts to a
 * SourceLoad error string.
 */
export function validateWorkspaceRootConfig(
  config: SyncConfig,
  filename: string,
): { error: string } | null {
  if (Object.keys(config.pathAliases).length === 0) {
    return {
      error:
        `${filename} sits at the workspace folder root and must declare a ` +
        `non-empty \`path-aliases\` field — without aliases the sync engine ` +
        `has no signal for which sub-trees to walk under the workspace root. ` +
        `Add at least one "<source-dir>": "<dest-dir>" pair, or move this ` +
        `file into a sub-folder to use the legacy "this folder is the source" ` +
        `semantics.`,
    };
  }
  return null;
}

function toAliasRecord(
  raw: unknown,
): { kind: 'ok'; value: Record<string, string> } | { kind: 'error'; error: string } {
  if (raw === undefined || raw === null) return { kind: 'ok', value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'error', error: '`path-aliases` must be an object of string→string' };
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      return {
        kind: 'error',
        error: `\`path-aliases\`["${key}"] must be a string`,
      };
    }
    // Normalise both sides — same rules as destination subpaths. The empty
    // string is preserved as a "whole-tree" LHS or "strip-prefix" RHS marker
    // (see aliasResolve.ts).
    out[normaliseAliasPath(key)] = normaliseAliasPath(value);
  }
  return { kind: 'ok', value: out };
}

function toStringArray(
  raw: unknown,
  fieldName: string,
): { kind: 'ok'; value: string[] } | { kind: 'error'; error: string } {
  if (raw === undefined || raw === null) return { kind: 'ok', value: [] };
  if (!Array.isArray(raw)) {
    return { kind: 'error', error: `\`${fieldName}\` must be an array of strings if set` };
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
