// Pure path-alias resolver for the .roomSync `path-aliases` field (M2 of
// room-sync-format-v1-plan.md).
//
// No vscode import — pairs with the wired walker in planner.ts. Literal
// strings only at M2; M4 extends the same module to globs.
//
// Model: each alias is an LHS → RHS pair. LHS is a source-relative directory
// path; RHS is the destination-relative directory path the LHS sub-tree maps
// to. Aliases combine additively — every alias's LHS is walked independently
// under the source folder, and each file's destination relpath is the alias's
// RHS joined with the relpath inside the LHS.
//
// The on-disk shape is `Record<string, string>` (terse, JSONC-friendly,
// matches the original plan example). The resolver works in terms of an
// ordered list so precedence ("first-match wins") is explicit — manager.ts /
// configParse.ts converts the record into this shape, preserving JSON
// property order (every JSONC parser we use does).

/** One literal LHS → RHS pair. Both fields are already normalised. */
export interface PathAlias {
  /**
   * Source-relative directory path. Forward-slash, no leading or trailing
   * slash. Empty string ('') means "the source folder root" — i.e. an alias
   * that re-roots the walk at a different RHS without restricting to a
   * sub-tree.
   */
  from: string;
  /**
   * Destination-relative directory path. Forward-slash, no leading or
   * trailing slash. Empty string ('') means "lift files to the destination
   * root" — i.e. strip the LHS prefix when planting.
   */
  to: string;
}

export interface AliasMatch {
  /** Which alias produced this resolution (so callers can surface the originating pair). */
  alias: PathAlias;
  /** Destination-relative path the source-relative `relPath` maps to. */
  destRelPath: string;
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
 * Resolve a source-relative path through the alias list. Returns the first
 * alias whose LHS contains `relPath`, plus the rewritten destination-relative
 * path. Returns `null` when no alias matches (the file should not be synced).
 *
 * "LHS contains relPath" means either:
 *  - `relPath` equals `from` (an LHS that names a file directly — rare but
 *    legal), or
 *  - `relPath` starts with `from + '/'` (the usual sub-tree case), or
 *  - `from === ''` (the LHS is the source folder root — every relpath matches).
 */
export function resolveAlias(
  relPath: string,
  aliases: readonly PathAlias[],
): AliasMatch | null {
  for (const alias of aliases) {
    const tail = relativeToAlias(relPath, alias.from);
    if (tail === null) continue;
    const destRelPath = joinAliasParts(alias.to, tail);
    return { alias, destRelPath };
  }
  return null;
}

/**
 * Return the portion of `relPath` that sits inside `from`, or null when
 * `relPath` is outside the LHS. Empty `from` matches everything (the whole
 * tree). Empty tail (when `relPath` equals `from`) returns ''.
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
