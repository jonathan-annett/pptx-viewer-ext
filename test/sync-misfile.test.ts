// Tests for the misfile guard (M5.3 Phase D).
//
// The guard itself is pure (src/sync/misfile.ts); the planner threads the
// cache + rel-path through during the source walk. These tests cover:
//   - cold cache → no warning
//   - same-path-only identity → no warning
//   - one other path → warning with that path in the message
//   - many other paths → message lists the first three with "+N more"
//
// Run with: npm run test:sync-misfile

import { strict as assert } from 'node:assert';
import { InMemoryParseCache } from '../src/sync/parseCache';
import { checkMisfile } from '../src/sync/misfile';

async function run(): Promise<void> {
  // ---------- cold cache → undefined ----------
  {
    const cache = new InMemoryParseCache();
    const w = await checkMisfile('mine.pptx', 'aaa', cache);
    assert.equal(w, undefined, 'no identity record → no warning');
    console.log('  ok: cold cache returns no warning');
  }

  // ---------- identity records only this rel-path → undefined ----------
  {
    const cache = new InMemoryParseCache();
    await cache.recordIdentity('aaa', 'mine.pptx');
    const w = await checkMisfile('mine.pptx', 'aaa', cache);
    assert.equal(w, undefined, 'only own path recorded → no warning');
    console.log('  ok: own path only returns no warning');
  }

  // ---------- one other rel-path → override warning ----------
  {
    const cache = new InMemoryParseCache();
    await cache.recordIdentity('aaa', 'other.pptx');
    const w = await checkMisfile('mine.pptx', 'aaa', cache);
    assert.ok(w, 'one other path produces a warning');
    assert.equal(w!.severity, 'override', 'misfile severity is override');
    assert.equal(w!.code, 'misfiled-content');
    assert.ok(
      w!.message.includes('other.pptx'),
      `message should list the other path: ${w!.message}`,
    );
    console.log('  ok: single other path produces override-severity warning with path');
  }

  // ---------- multiple other rel-paths → list capped at 3 + "+N more" ----------
  {
    const cache = new InMemoryParseCache();
    for (const p of ['p1.pptx', 'p2.pptx', 'p3.pptx', 'p4.pptx', 'p5.pptx']) {
      await cache.recordIdentity('bbb', p);
    }
    const w = await checkMisfile('mine.pptx', 'bbb', cache);
    assert.ok(w);
    // First three paths listed, the rest summarised.
    assert.ok(w!.message.includes('p1.pptx'));
    assert.ok(w!.message.includes('p2.pptx'));
    assert.ok(w!.message.includes('p3.pptx'));
    assert.ok(!w!.message.includes('p4.pptx'), 'fourth path is summarised, not listed');
    assert.ok(w!.message.includes('+2 more'), `message should include "+2 more": ${w!.message}`);
    console.log('  ok: many other paths caps list at 3 with "+N more" tail');
  }

  // ---------- own path is filtered out of the message ----------
  {
    const cache = new InMemoryParseCache();
    await cache.recordIdentity('ccc', 'mine.pptx');
    await cache.recordIdentity('ccc', 'other.pptx');
    const w = await checkMisfile('mine.pptx', 'ccc', cache);
    assert.ok(w, 'one other path produces a warning even with own path also recorded');
    assert.ok(w!.message.includes('other.pptx'));
    assert.ok(
      !w!.message.includes('mine.pptx'),
      `own rel-path must not appear in misfile message: ${w!.message}`,
    );
    console.log('  ok: own path filtered out of warning message');
  }

  console.log('all tests passed');
}

run().catch((err) => {
  console.error('test run failed:', err);
  process.exit(1);
});
