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
  if (!Array.isArray(destinationsRaw) || destinationsRaw.length === 0) {
    return {
      kind: 'error',
      error: '`destinations` is required and must be a non-empty array',
    };
  }

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
