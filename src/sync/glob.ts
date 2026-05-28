// Glob matcher for include/exclude patterns in .sync.jsonc.
//
// What's supported:
//   *       → any sequence of non-slash characters
//   ?       → a single non-slash character
//   **      → any sequence of characters (crosses slashes)
//   **/     → any number of leading directory components (including zero)
//   <X>/**  → matches the directory <X> itself, and anything underneath it
//             (so the walker can prune the dir without losing the semantics)
//
// What's NOT supported (no use case in the schema yet):
//   - Character classes  [abc]
//   - Brace expansion   {a,b}
//   - Negation prefixes  !pattern  (handled at a higher level if needed)
//
// Patterns operate on relative paths separated by forward slashes — the
// walker normalises before testing.

const REGEX_META = new Set('.+^$()|{}[]\\'.split(''));

/** Compile a glob pattern to an anchored RegExp. */
export function compileGlob(glob: string): RegExp {
  // Special case: a trailing `/**` should match both the directory itself
  // and anything under it. Strip it here and append an optional suffix
  // after the main translation pass.
  let pattern = glob;
  let trailingDoubleStar = false;
  if (pattern.endsWith('/**')) {
    pattern = pattern.slice(0, -3);
    trailingDoubleStar = true;
  }

  let re = '';
  let i = 0;
  while (i < pattern.length) {
    // Leading or interior `**/` → zero-or-more directory components.
    if (pattern.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 3;
      continue;
    }
    // Bare `**` (no following slash) → match anything, including separators.
    if (pattern.startsWith('**', i)) {
      re += '.*';
      i += 2;
      continue;
    }
    if (pattern[i] === '*') {
      re += '[^/]*';
      i++;
      continue;
    }
    if (pattern[i] === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    const ch = pattern[i];
    re += REGEX_META.has(ch) ? `\\${ch}` : ch;
    i++;
  }

  if (trailingDoubleStar) re += '(?:/.*)?';
  return new RegExp(`^${re}$`);
}

/**
 * A compiled set of glob patterns. `matches(relPath)` returns true if any
 * pattern in the set matches the path.
 */
export class GlobSet {
  private readonly regexes: RegExp[];

  constructor(patterns: readonly string[]) {
    this.regexes = patterns.map(compileGlob);
  }

  matches(relPath: string): boolean {
    for (const re of this.regexes) {
      if (re.test(relPath)) return true;
    }
    return false;
  }

  /** True when the set contains no patterns. Used to skip the test entirely. */
  isEmpty(): boolean {
    return this.regexes.length === 0;
  }
}

/**
 * Built-in ignore patterns — applied to every source walk regardless of
 * what the source config says. Mirrors the list in folder-sync-v1-plan.md.
 *
 * Source-config aliases (see configFilenames.ts):
 *   `.sync.jsonc`, `.roomSync` (bare folder-level)
 *   `<handle>.roomSync` (named workspace-root variant — M3 + generator)
 *
 * Workspace snapshot aliases (see snapshotFilenames.ts):
 *   `.admin-sync.jsonc` (legacy), `.eventSync` (preferred)
 *
 * Manifest aliases (see manifestFilenames.ts):
 *   `.foldersync-manifest.json` (legacy), `.syncManifest` (preferred)
 *
 * The walker matches these by basename, so a deeply nested config (e.g.
 * for a nested source) is still excluded from its parent's sync correctly
 * — and a generator-emitted `breakout-1.roomSync` is never copied to a
 * destination as if it were content.
 */
export const BUILT_IN_IGNORES: readonly string[] = [
  '**/.git',
  '**/.git/**',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/~$*',
  '**/.sync.jsonc',
  '**/.roomSync',
  '**/*.roomSync',
  '**/.admin-sync.jsonc',
  '**/.eventSync',
  '**/.foldersync-manifest.json',
  '**/.syncManifest',
  '**/*.tmp',
];
