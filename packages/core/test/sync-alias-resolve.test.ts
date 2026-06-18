// Tests for the pure path-alias resolver — M2 (literal LHS/RHS) and M4
// (glob LHS with positional RHS substitution) of room-sync-format-v1-plan.md.
//
// Runs under plain Node via tsx — no VS Code needed.

import { strict as assert } from 'node:assert';
import {
  aliasesFromRecord,
  compileAlias,
  compileAliases,
  detectAliasCollisions,
  normaliseAliasPath,
  resolveAlias,
  type CompiledAlias,
  type PathAlias,
} from '../src/sync/aliasResolve';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

/**
 * Test helper — compile a literal PathAlias[] into matcher form. Used by
 * every test that wants to drive the resolver with a hand-rolled alias
 * list. Throws if any alias fails to compile, so a test that's surprised
 * by a compile error fails loudly instead of silently producing an empty
 * alias list.
 */
function compile(aliases: readonly PathAlias[]): CompiledAlias[] {
  const { compiled, errors } = compileAliases(aliases);
  if (errors.length > 0) {
    throw new Error(`unexpected compile errors: ${errors.map((e) => e.message).join('; ')}`);
  }
  return compiled;
}

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
  const got = resolveAlias('MON/room1/keynote.pptx', compile(aliases));
  assert.deepEqual(got, {
    alias: aliases[0],
    destRelPath: 'MON/keynote.pptx',
  });
});

test('resolveAlias rewrites nested files inside the LHS', () => {
  const aliases: PathAlias[] = [{ from: 'MON/room1', to: 'MON' }];
  const got = resolveAlias('MON/room1/talks/intro.pptx', compile(aliases));
  assert.deepEqual(got, {
    alias: aliases[0],
    destRelPath: 'MON/talks/intro.pptx',
  });
});

test('resolveAlias returns null when no alias matches', () => {
  const aliases: PathAlias[] = [{ from: 'MON/room1', to: 'MON' }];
  assert.equal(resolveAlias('MON/room2/keynote.pptx', compile(aliases)), null);
  assert.equal(resolveAlias('TUE/room1/keynote.pptx', compile(aliases)), null);
  assert.equal(resolveAlias('elsewhere.pptx', compile(aliases)), null);
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
  const got = resolveAlias('MON/room1/foo.pptx', compile(aliases));
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
  const got = resolveAlias('MON/room2/foo.pptx', compile(aliases));
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
  const got = resolveAlias('foo/bar.pptx', compile(aliases));
  assert.deepEqual(got, {
    alias: aliases[0],
    destRelPath: 'all/foo/bar.pptx',
  });
});

test('resolveAlias treats empty `to` as a strip-prefix rewrite', () => {
  // Lift files out of MON/room1/ to the destination root.
  const aliases: PathAlias[] = [{ from: 'MON/room1', to: '' }];
  const got = resolveAlias('MON/room1/keynote.pptx', compile(aliases));
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
  const got = resolveAlias('MON/room1', compile(aliases));
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
  assert.equal(resolveAlias('MON/room10/foo.pptx', compile(aliases)), null);
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

// ───── glob LHS / RHS substitution (M4) ──────────────────────────────────

test('single * captures one path segment and substitutes into RHS', () => {
  // The plan's load-bearing example: { "*/room1": "*" } unifies MON/room1,
  // TUE/room1, WED/room1 into MON/, TUE/, WED/ without naming each day.
  const aliases: PathAlias[] = [{ from: '*/room1', to: '*' }];
  const got = resolveAlias('MON/room1/keynote.pptx', compile(aliases));
  assert.deepEqual(got, {
    alias: aliases[0],
    destRelPath: 'MON/keynote.pptx',
  });
});

test('single * is path-segment-aware (no false MON/room10 match)', () => {
  // The glob LHS must not slip into the same trap the literal version
  // explicitly avoids — segment boundaries are anchored via the (?=/|$)
  // lookahead in the compiled regex.
  const aliases: PathAlias[] = [{ from: '*/room1', to: '*' }];
  assert.equal(resolveAlias('MON/room10/foo.pptx', compile(aliases)), null);
});

test('multiple days unify under the same destination via one glob alias', () => {
  // The full event-organiser flow: three days, one alias, three rewrites
  // all keyed by the captured day prefix.
  const aliases: PathAlias[] = [{ from: '*/room1', to: '*' }];
  const compiled = compile(aliases);
  const got = ['MON/room1/a.pptx', 'TUE/room1/b.pptx', 'WED/room1/c.pptx'].map((p) =>
    resolveAlias(p, compiled),
  );
  assert.deepEqual(
    got.map((m) => m?.destRelPath),
    ['MON/a.pptx', 'TUE/b.pptx', 'WED/c.pptx'],
  );
});

test('** captures multi-segment prefixes', () => {
  // The double-wildcard captures arbitrary depth — useful when the
  // day-major prefix may itself have nested folders before the room dir.
  const aliases: PathAlias[] = [{ from: '**/room1', to: 'archive/**' }];
  const got = resolveAlias('events/2026/MON/room1/keynote.pptx', compile(aliases));
  assert.equal(got?.destRelPath, 'archive/events/2026/MON/keynote.pptx');
});

test('** also matches with no preceding segments', () => {
  // `**/room1` at the source root: MON before `room1` is absent — the
  // optional capture group resolves to empty, and the destination drops
  // straight into the archive root.
  const aliases: PathAlias[] = [{ from: '**/room1', to: 'archive/**' }];
  const got = resolveAlias('room1/keynote.pptx', compile(aliases));
  assert.equal(got?.destRelPath, 'archive/keynote.pptx');
});

test('multiple wildcards on both sides are substituted in order', () => {
  // The n-th wildcard on the LHS feeds the n-th wildcard on the RHS.
  // Useful for swapping captured segments — here: day captured first,
  // room captured second; RHS swaps room/day order.
  const aliases: PathAlias[] = [{ from: '*/*/notes.txt', to: '*-*/notes.txt' }];
  const got = resolveAlias('MON/room1/notes.txt', compile(aliases));
  assert.equal(got?.destRelPath, 'MON-room1/notes.txt');
});

test('RHS may reference fewer captures than LHS provides (drops extras)', () => {
  // Not an error — the user might capture only to constrain the LHS shape
  // without using the value. Excess captures are silently dropped.
  const aliases: PathAlias[] = [{ from: '*/*/notes.txt', to: 'all/*/notes.txt' }];
  const got = resolveAlias('MON/room1/notes.txt', compile(aliases));
  assert.equal(got?.destRelPath, 'all/MON/notes.txt');
});

test('RHS referencing more captures than LHS provides is a compile error', () => {
  // Caller (planner) logs the message and drops the offending alias —
  // never reaches resolveAlias. compileAlias surfaces the error directly.
  const result = compileAlias({ from: '*/room1', to: '*/*' });
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') {
    assert.match(result.message, /references 2 wildcards but LHS .* only captures 1/);
  }
});

test('compileAliases drops invalid aliases and reports per-alias errors', () => {
  const { compiled, errors } = compileAliases([
    { from: '*/room1', to: '*' },       // ok
    { from: '*/room1', to: '*/*' },     // bad — RHS exceeds LHS
    { from: 'MON/room1', to: 'MON' },   // ok (literal)
  ]);
  assert.equal(compiled.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].alias.from, '*/room1');
  assert.equal(errors[0].alias.to, '*/*');
});

test('glob and literal aliases coexist with first-match-wins precedence', () => {
  // A narrow literal alias can pre-empt a broad glob — the user controls
  // precedence by ordering.
  const aliases: PathAlias[] = [
    { from: 'MON/room1', to: 'monday-r1' },
    { from: '*/room1', to: '*' },
  ];
  const compiled = compile(aliases);
  // MON/room1 hits the literal first.
  const monday = resolveAlias('MON/room1/foo.pptx', compiled);
  assert.equal(monday?.destRelPath, 'monday-r1/foo.pptx');
  // TUE/room1 falls through to the glob.
  const tuesday = resolveAlias('TUE/room1/foo.pptx', compiled);
  assert.equal(tuesday?.destRelPath, 'TUE/foo.pptx');
});

test('mixed literal + wildcard segments compile correctly', () => {
  // The LHS is a literal prefix + wildcard suffix. Both halves of the
  // match must work: literal portion is escaped, wildcard portion captures.
  const aliases: PathAlias[] = [{ from: 'events/*/room1', to: 'archive/*' }];
  const got = resolveAlias('events/2026/room1/keynote.pptx', compile(aliases));
  assert.equal(got?.destRelPath, 'archive/2026/keynote.pptx');
});

test('glob alias matched on the LHS root (no tail) still produces a clean dest', () => {
  // Edge case: the file's relpath IS the matched LHS, no nested file
  // beneath. Common when a tool drops a single sentinel file at the
  // matched directory level.
  const aliases: PathAlias[] = [{ from: '*/room1', to: 'archive/*' }];
  const got = resolveAlias('MON/room1', compile(aliases));
  assert.equal(got?.destRelPath, 'archive/MON');
});

test('glob alias on a file that does not match falls through to literal aliases', () => {
  // Combining glob + literal: if the glob doesn't apply, the next literal
  // still gets a chance.
  const aliases: PathAlias[] = [
    { from: '*/room1', to: '*' },
    { from: 'shared/assets', to: 'shared' },
  ];
  const compiled = compile(aliases);
  // No /room1/ segment → glob misses → falls through to literal.
  const got = resolveAlias('shared/assets/logo.png', compiled);
  assert.equal(got?.destRelPath, 'shared/logo.png');
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
