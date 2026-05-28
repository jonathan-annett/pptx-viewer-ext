// Tests for the pure path-alias resolver — M2 of room-sync-format-v1-plan.md.
//
// Runs under plain Node via tsx — no VS Code needed.

import { strict as assert } from 'node:assert';
import {
  aliasesFromRecord,
  detectAliasCollisions,
  normaliseAliasPath,
  resolveAlias,
  type PathAlias,
} from '../src/sync/aliasResolve';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

// ───── normaliseAliasPath ───────────────────────────────────────────────

test('normaliseAliasPath strips leading + trailing slashes', () => {
  assert.equal(normaliseAliasPath('/MON/room1/'), 'MON/room1');
});

test('normaliseAliasPath collapses repeated slashes', () => {
  assert.equal(normaliseAliasPath('a//b///c'), 'a/b/c');
});

test('normaliseAliasPath leaves empty string empty', () => {
  assert.equal(normaliseAliasPath(''), '');
});

test('normaliseAliasPath leaves an already-clean path unchanged', () => {
  assert.equal(normaliseAliasPath('a/b'), 'a/b');
});

// ───── aliasesFromRecord — order preservation ────────────────────────────

test('aliasesFromRecord preserves authoring order', () => {
  const aliases = aliasesFromRecord({
    'MON/room1': 'MON',
    'TUE/room1': 'TUE',
    'WED/room1': 'WED',
  });
  assert.deepEqual(aliases, [
    { from: 'MON/room1', to: 'MON' },
    { from: 'TUE/room1', to: 'TUE' },
    { from: 'WED/room1', to: 'WED' },
  ]);
});

test('aliasesFromRecord normalises both LHS and RHS', () => {
  const aliases = aliasesFromRecord({
    '/MON/room1/': '/MON/',
    'TUE//room1': 'TUE',
  });
  assert.deepEqual(aliases, [
    { from: 'MON/room1', to: 'MON' },
    { from: 'TUE/room1', to: 'TUE' },
  ]);
});

// ───── resolveAlias — basic matching ─────────────────────────────────────

test('resolveAlias rewrites a file inside the LHS', () => {
  const aliases: PathAlias[] = [{ from: 'MON/room1', to: 'MON' }];
  const got = resolveAlias('MON/room1/keynote.pptx', aliases);
  assert.deepEqual(got, {
    alias: aliases[0],
    destRelPath: 'MON/keynote.pptx',
  });
});

test('resolveAlias rewrites nested files inside the LHS', () => {
  const aliases: PathAlias[] = [{ from: 'MON/room1', to: 'MON' }];
  const got = resolveAlias('MON/room1/talks/intro.pptx', aliases);
  assert.deepEqual(got, {
    alias: aliases[0],
    destRelPath: 'MON/talks/intro.pptx',
  });
});

test('resolveAlias returns null when no alias matches', () => {
  const aliases: PathAlias[] = [{ from: 'MON/room1', to: 'MON' }];
  assert.equal(resolveAlias('MON/room2/keynote.pptx', aliases), null);
  assert.equal(resolveAlias('TUE/room1/keynote.pptx', aliases), null);
  assert.equal(resolveAlias('elsewhere.pptx', aliases), null);
});

test('resolveAlias returns null on empty alias list', () => {
  assert.equal(resolveAlias('any/path.pptx', []), null);
});

// ───── resolveAlias — first-match wins ──────────────────────────────────

test('resolveAlias uses first-match-wins when LHS values overlap', () => {
  // The user-authored order is the precedence. Even though both aliases
  // match `MON/room1/foo.pptx`, only the first one is applied.
  const aliases: PathAlias[] = [
    { from: 'MON/room1', to: 'first' },
    { from: 'MON', to: 'second' },
  ];
  const got = resolveAlias('MON/room1/foo.pptx', aliases);
  assert.deepEqual(got, {
    alias: aliases[0],
    destRelPath: 'first/foo.pptx',
  });
});

test('resolveAlias falls through to a broader alias when the narrow one misses', () => {
  const aliases: PathAlias[] = [
    { from: 'MON/room1', to: 'r1' },
    { from: 'MON', to: 'mon' },
  ];
  const got = resolveAlias('MON/room2/foo.pptx', aliases);
  assert.deepEqual(got, {
    alias: aliases[1],
    destRelPath: 'mon/room2/foo.pptx',
  });
});

// ───── resolveAlias — empty LHS / RHS edge cases ────────────────────────

test('resolveAlias treats empty `from` as a whole-tree alias', () => {
  // An empty LHS is "everything under the source folder root" — equivalent
  // to "implicit catch-all" if it appears last. The plan deliberately omits
  // a built-in catch-all (out-of-scope files don't sync), but the user can
  // construct one by hand.
  const aliases: PathAlias[] = [{ from: '', to: 'all' }];
  const got = resolveAlias('foo/bar.pptx', aliases);
  assert.deepEqual(got, {
    alias: aliases[0],
    destRelPath: 'all/foo/bar.pptx',
  });
});

test('resolveAlias treats empty `to` as a strip-prefix rewrite', () => {
  // Lift files out of MON/room1/ to the destination root.
  const aliases: PathAlias[] = [{ from: 'MON/room1', to: '' }];
  const got = resolveAlias('MON/room1/keynote.pptx', aliases);
  assert.deepEqual(got, {
    alias: aliases[0],
    destRelPath: 'keynote.pptx',
  });
});

test('resolveAlias rewrites the LHS root when source equals from', () => {
  // The relpath `MON/room1` itself is the LHS root — vanishingly rare in
  // practice (filesystems don't carry zero-byte directory-as-file entries
  // through the walker), but the resolver shouldn't crash.
  const aliases: PathAlias[] = [{ from: 'MON/room1', to: 'MON' }];
  const got = resolveAlias('MON/room1', aliases);
  assert.deepEqual(got, {
    alias: aliases[0],
    destRelPath: 'MON',
  });
});

test('resolveAlias does NOT match a sibling sharing a prefix string', () => {
  // `MON/room10` is not inside `MON/room1`; alias matching is path-segment-
  // aware, so a string-level prefix collision must not produce a false
  // positive.
  const aliases: PathAlias[] = [{ from: 'MON/room1', to: 'MON' }];
  assert.equal(resolveAlias('MON/room10/foo.pptx', aliases), null);
});

// ───── detectAliasCollisions ────────────────────────────────────────────

test('detectAliasCollisions reports a single dest path claimed by two sources', () => {
  const collisions = detectAliasCollisions([
    { sourceRelPath: 'MON/room1/foo.pptx', destRelPath: 'foo.pptx' },
    { sourceRelPath: 'TUE/room1/foo.pptx', destRelPath: 'foo.pptx' },
  ]);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].destRelPath, 'foo.pptx');
  assert.deepEqual(collisions[0].sourceRelPaths, [
    'MON/room1/foo.pptx',
    'TUE/room1/foo.pptx',
  ]);
});

test('detectAliasCollisions returns empty when destinations are all distinct', () => {
  const collisions = detectAliasCollisions([
    { sourceRelPath: 'MON/room1/a.pptx', destRelPath: 'MON/a.pptx' },
    { sourceRelPath: 'TUE/room1/a.pptx', destRelPath: 'TUE/a.pptx' },
  ]);
  assert.deepEqual(collisions, []);
});

test('detectAliasCollisions dedupes identical source paths', () => {
  // The same source contributing twice (e.g. via two aliases that resolve to
  // the same place) is not itself a collision — but the first-match-wins
  // rule means the resolver only emits one rewrite per source path anyway.
  // Defensive: dedupe at the collision-detection level too.
  const collisions = detectAliasCollisions([
    { sourceRelPath: 'MON/room1/foo.pptx', destRelPath: 'foo.pptx' },
    { sourceRelPath: 'MON/room1/foo.pptx', destRelPath: 'foo.pptx' },
  ]);
  assert.deepEqual(collisions, []);
});

// ───── run ──────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok: ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('all tests passed');
