// Pure path-alias resolver for the .roomSync `path-aliases` field.
//
// No vscode import — pairs with the wired walker in planner.ts. M2 introduced
// literal-string LHS/RHS pairs; M4 of [[room-sync-format-v1-plan]] extends
// this module to glob LHS patterns with positional capture substitution on
// the RHS:
//
//   "*/room1"  →  "*"     // captures the first segment, e.g. MON, TUE, WED
//   "**/talks" →  "talks-out"  // captures everything before "talks"
//
// Wildcards:
//   *   matches exactly one path segment (one or more non-slash chars)
//   **  matches zero or more path segments (including slashes between them)
//   ?   matches a single non-slash char (does NOT capture; legacy glob)
//
// The n-th wildcard on the LHS captures one value; the n-th wildcard on the
// RHS receives that capture. RHS wildcards beyond the LHS capture count are
// a compile-time error — the caller drops the offending alias and logs.
//
// Model: each alias is an LHS → RHS pair. The walker walks the source folder
// as one tree, then maps each source-relative path through the resolver:
// first-match wins; non-matches are dropped (no implicit catch-all). The
// on-disk shape is `Record<string, string>` (terse, JSONC-friendly); the
// resolver works in terms of an ordered list so precedence is explicit —
// `aliasesFromRecord` does the conversion and JSON property iteration order
// is preserved by every parser we use.

/** One LHS → RHS pair, normalised but not yet compiled. */
export interface PathAlias {
  /**
   * Source-relative directory or glob. Forward-slash, no leading or trailing
   * slash. Empty string ('') means "the source folder root" — an alias that
   * re-roots the walk at a different RHS without restricting to a sub-tree.
   * May contain `*` / `**` / `?` wildcards (M4) — see module docstring.
   */
  from: string;
  /**
   * Destination-relative directory or template. Forward-slash, no leading
   * or trailing slash. Empty string ('') means "lift files to the destination
   * root" — strip the LHS prefix when planting. Wildcards in the RHS are
   * substitution markers, not glob matchers — the n-th `*`/`**` is replaced
   * with the n-th LHS capture (M4).
   */
  to: string;
}

/**
 * Pre-compiled form of a `PathAlias`. Built once per source walk; reused
 * for every walked file. Carries the original `alias` strings for
 * diagnostics (the plan-view tooltip surfaces them unchanged).
 *
 * `literal` is true when neither side contains wildcards — the resolver
 * skips regex entirely and uses string compares, matching the M2 fast path
 * byte-for-byte.
 */
export interface CompiledAlias {
  alias: PathAlias;
  literal: boolean;
  /** Present when `literal` is false. Anchored at start; lookahead `/|$` at end. */
  regex?: RegExp;
  /** Present when `literal` is false. Number of capture groups in the LHS regex. */
  captureCount?: number;
  /** Present when `literal` is false. RHS broken into alternating literal/capture parts. */
  toTemplate?: TemplatePart[];
}

/** RHS template fragment — either a literal run or a back-reference to the n-th LHS capture. */
export type TemplatePart =
  | { kind: 'literal'; text: string }
  | { kind: 'capture'; index: number };

export interface AliasMatch {
  /** Which alias produced this resolution (so callers can surface the originating pair). */
  alias: PathAlias;
  /** Destination-relative path the source-relative `relPath` maps to. */
  destRelPath: string;
}

/** Per-alias compile error — caller logs and drops the offending alias. */
export interface AliasCompileError {
  alias: PathAlias;
  message: string;
}

/**
 * Convert the on-disk `Record<string, string>` into an ordered `PathAlias[]`.
 * Normalises both sides (strip leading/trailing slashes, collapse repeats —
 * same rules as destination subpaths in configParse).
 *
 * JSON property iteration order is preserved by every parser we use (V8 /
 * jsonc-parser); the array's order matches the user's authoring order, which
 * is the first-match-wins precedence the resolver applies.
 */
export function aliasesFromRecord(record: Record<string, string>): PathAlias[] {
  const out: PathAlias[] = [];
  for (const [from, to] of Object.entries(record)) {
    out.push({ from: normaliseAliasPath(from), to: normaliseAliasPath(to) });
  }
  return out;
}

/** Strip leading/trailing slashes; collapse repeats. Empty stays empty. */
export function normaliseAliasPath(p: string): string {
  return p.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

/**
 * Pre-compile a list of aliases into matcher-ready form. Glob LHS patterns
 * become anchored regexes with capture groups; glob RHS patterns become
 * template-substitution plans. Aliases without wildcards stay on the
 * literal-compare fast path (no regex cost).
 *
 * Returns `{ compiled, errors }`. Errors are per-alias — e.g. an RHS that
 * references more captures than its LHS provides. The caller drops offending
 * aliases (they're excluded from `compiled`) and logs the errors via the
 * Output Channel diagnostic surface.
 */
export function compileAliases(
  aliases: readonly PathAlias[],
): { compiled: CompiledAlias[]; errors: AliasCompileError[] } {
  const compiled: CompiledAlias[] = [];
  const errors: AliasCompileError[] = [];
  for (const alias of aliases) {
    const result = compileAlias(alias);
    if (result.kind === 'error') {
      errors.push({ alias, message: result.message });
      continue;
    }
    compiled.push(result.compiled);
  }
  return { compiled, errors };
}

/**
 * Compile one alias. Returns either a compiled form or an error sentinel.
 * Exposed for tests that want to assert error messages without going
 * through the per-alias list machinery.
 */
export function compileAlias(
  alias: PathAlias,
): { kind: 'ok'; compiled: CompiledAlias } | { kind: 'error'; message: string } {
  const fromIsLiteral = !containsWildcard(alias.from);
  const toIsLiteral = !containsWildcard(alias.to);
  if (fromIsLiteral && toIsLiteral) {
    return { kind: 'ok', compiled: { alias, literal: true } };
  }
  const { regex, captureCount } = compileGlobLHS(alias.from);
  const toTemplate = compileRHSTemplate(alias.to);
  const rhsRefs = toTemplate.reduce(
    (n, p) => n + (p.kind === 'capture' ? 1 : 0),
    0,
  );
  if (rhsRefs > captureCount) {
    return {
      kind: 'error',
      message:
        `RHS "${alias.to}" references ${rhsRefs} wildcard${rhsRefs === 1 ? '' : 's'} ` +
        `but LHS "${alias.from}" only captures ${captureCount} — ` +
        `each \`*\`/\`**\` in the destination must have a matching wildcard in the source.`,
    };
  }
  return {
    kind: 'ok',
    compiled: { alias, literal: false, regex, captureCount, toTemplate },
  };
}

/**
 * Resolve a source-relative path through the alias list. Returns the first
 * alias whose LHS contains `relPath`, plus the rewritten destination-relative
 * path. Returns `null` when no alias matches (the file should not be synced).
 *
 * For literal aliases, matching is path-segment-aware: `MON/room1` matches
 * `MON/room1/foo.pptx` but not `MON/room10/foo.pptx`. For glob aliases, the
 * compiled regex enforces the same segment-boundary semantics via a `/|$`
 * lookahead — see `compileGlobLHS`.
 */
export function resolveAlias(
  relPath: string,
  aliases: readonly CompiledAlias[],
): AliasMatch | null {
  for (const c of aliases) {
    const match = c.literal ? matchLiteral(relPath, c) : matchGlob(relPath, c);
    if (match) return match;
  }
  return null;
}

/** Literal LHS path — matches when relPath equals or is nested under `from`. */
function matchLiteral(relPath: string, c: CompiledAlias): AliasMatch | null {
  const tail = relativeToAlias(relPath, c.alias.from);
  if (tail === null) return null;
  return { alias: c.alias, destRelPath: joinAliasParts(c.alias.to, tail) };
}

/** Glob LHS — runs the compiled regex; on hit, substitutes RHS template + appends tail. */
function matchGlob(relPath: string, c: CompiledAlias): AliasMatch | null {
  const m = c.regex!.exec(relPath);
  if (!m) return null;
  const captures: string[] = [];
  for (let i = 1; i < m.length; i++) {
    // Optional capture groups (e.g. `(?:(.*)/)?` for `**/`) may be undefined
    // when their alternative didn't match — normalise to empty so template
    // substitution doesn't surface "undefined" in the destination path.
    captures.push(m[i] ?? '');
  }
  const matchEnd = m[0].length;
  // Strip the leading slash from the tail if any — `/foo/bar` → `foo/bar`.
  const tail = relPath.slice(matchEnd).replace(/^\//, '');
  const destBase = substituteRHS(c.toTemplate!, captures);
  return { alias: c.alias, destRelPath: joinAliasParts(destBase, tail) };
}

function substituteRHS(parts: readonly TemplatePart[], captures: readonly string[]): string {
  let out = '';
  for (const part of parts) {
    if (part.kind === 'literal') {
      out += part.text;
    } else {
      out += captures[part.index] ?? '';
    }
  }
  // The template-built RHS may produce empty segments when a capture was
  // empty (e.g. the `**` in `**/talks` captures '' for a top-level `talks`).
  // Normalise so the joined dest path doesn't carry double-slashes.
  return normaliseAliasPath(out);
}

/**
 * Compile a glob LHS into an anchored regex with capture groups.
 *
 * Translation table (using `STAR` and `DOUBLESTAR` to dodge the JSDoc
 * comment-terminator trap — see CLAUDE.md dead-ends):
 *   STAR             → `([^/]+)` (capture one path segment, non-empty)
 *   DOUBLESTAR       → `(.*)` (capture multiple segments, possibly empty)
 *   DOUBLESTAR-slash → `(?:(.*)/)?` (capture multiple segments with optional
 *                     trailing slash; the whole group is optional so
 *                     `DOUBLESTAR/foo` matches `foo` too)
 *   ?                → `[^/]` (single non-slash char, NOT captured — matches
 *                     the existing glob.ts convention; never seen in M4
 *                     examples but kept for completeness)
 *
 * The regex is anchored at the start (`^`) and ends with a `(?=/|$)`
 * lookahead so the LHS only matches at a segment boundary — preserves the
 * literal mode's "MON/room1 does not match MON/room10" guarantee.
 */
function compileGlobLHS(from: string): { regex: RegExp; captureCount: number } {
  let re = '';
  let captureCount = 0;
  let i = 0;
  while (i < from.length) {
    if (from.startsWith('**/', i)) {
      re += '(?:(.*)/)?';
      captureCount++;
      i += 3;
      continue;
    }
    if (from.startsWith('**', i)) {
      re += '(.*)';
      captureCount++;
      i += 2;
      continue;
    }
    if (from[i] === '*') {
      re += '([^/]+)';
      captureCount++;
      i++;
      continue;
    }
    if (from[i] === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    const ch = from[i];
    re += REGEX_META.has(ch) ? `\\${ch}` : ch;
    i++;
  }
  // Empty from with wildcards is degenerate — falls through to literal path,
  // but cover it: anchor + lookahead still works.
  return {
    regex: new RegExp(`^${re}(?=/|$)`),
    captureCount,
  };
}

/**
 * Parse an RHS pattern into a template — alternating literal runs and
 * capture references. `*` and `**` are both single-position substitutions
 * in the destination template (there's no segment-vs-multi distinction at
 * the substitution site; the LHS already decided what each capture means).
 */
function compileRHSTemplate(to: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let buf = '';
  let captureIdx = 0;
  let i = 0;
  const flush = (): void => {
    if (buf !== '') {
      parts.push({ kind: 'literal', text: buf });
      buf = '';
    }
  };
  while (i < to.length) {
    if (to.startsWith('**', i)) {
      flush();
      parts.push({ kind: 'capture', index: captureIdx++ });
      i += 2;
      continue;
    }
    if (to[i] === '*') {
      flush();
      parts.push({ kind: 'capture', index: captureIdx++ });
      i++;
      continue;
    }
    buf += to[i];
    i++;
  }
  flush();
  return parts;
}

function containsWildcard(s: string): boolean {
  // `?` is a wildcard in LHS only; on RHS it's a literal char. The detection
  // here is shared by both sides, so include `?` — an RHS that happens to
  // contain a literal `?` will compile as a glob alias and pass through with
  // the `?` preserved as a literal char. No user-visible difference.
  return s.includes('*') || s.includes('?');
}

const REGEX_META = new Set('.+^$()|{}[]\\'.split(''));

/**
 * Return the portion of `relPath` that sits inside `from`, or null when
 * `relPath` is outside the LHS. Empty `from` matches everything (the whole
 * tree). Empty tail (when `relPath` equals `from`) returns ''.
 *
 * Literal-mode only — glob LHSes use `compileGlobLHS` + regex.exec.
 */
function relativeToAlias(relPath: string, from: string): string | null {
  if (from === '') return relPath;
  if (relPath === from) return '';
  if (relPath.startsWith(`${from}/`)) return relPath.slice(from.length + 1);
  return null;
}

/** Join two normalised parts with a single '/', preserving empties. */
function joinAliasParts(left: string, right: string): string {
  if (left === '') return right;
  if (right === '') return left;
  return `${left}/${right}`;
}

/**
 * Detect a destination-relpath collision across a set of rewrites. Two source
 * files producing the same destination relpath is an error — the planner
 * surfaces it as a diagnostic before any sync runs. Returns one entry per
 * collision; `sourceRelPaths` is the deduplicated list of inputs that landed
 * at the same destination.
 *
 * Aliases with overlapping LHS values are not by themselves an error: the
 * error is when two resolutions land at the same destination relpath for
 * different source files. (The resolver's first-match-wins means overlap
 * never produces two rewrites for the same source file in the first place.)
 */
export interface AliasCollision {
  destRelPath: string;
  sourceRelPaths: string[];
}

export function detectAliasCollisions(
  rewrites: ReadonlyArray<{ sourceRelPath: string; destRelPath: string }>,
): AliasCollision[] {
  const byDest = new Map<string, Set<string>>();
  for (const r of rewrites) {
    const set = byDest.get(r.destRelPath) ?? new Set<string>();
    set.add(r.sourceRelPath);
    byDest.set(r.destRelPath, set);
  }
  const collisions: AliasCollision[] = [];
  for (const [destRelPath, sources] of byDest) {
    if (sources.size > 1) {
      collisions.push({ destRelPath, sourceRelPaths: [...sources].sort() });
    }
  }
  return collisions;
}
