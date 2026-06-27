// Tests for src/sync/timeout.ts (withTimeout + TimeoutError).
// Run with: npm run test:sync-timeout

import { strict as assert } from 'node:assert';
import { withTimeout, TimeoutError } from '../src/sync/timeout';

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>): void => {
  tests.push([name, fn]);
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('resolves with the value when the promise settles in time', async () => {
  const v = await withTimeout(Promise.resolve('ok'), 1000, 'fast');
  assert.equal(v, 'ok');
});

test('resolves a slightly-slow promise that still beats the deadline', async () => {
  const v = await withTimeout(delay(20).then(() => 42), 1000, 'slow-ish');
  assert.equal(v, 42);
});

test('rejects with TimeoutError when the deadline passes first', async () => {
  await assert.rejects(
    withTimeout(delay(1000).then(() => 'late'), 20, 'hang'),
    (err: unknown) => {
      assert.ok(err instanceof TimeoutError, 'is a TimeoutError');
      assert.equal((err as TimeoutError).label, 'hang');
      assert.equal((err as TimeoutError).ms, 20);
      assert.match((err as Error).message, /timed out after 20ms: hang/);
      return true;
    },
  );
});

test('propagates the underlying rejection when it loses the race by erroring fast', async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error('boom')), 1000, 'errs'),
    /boom/,
  );
});

async function main(): Promise<void> {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok: ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL: ${name}`);
      console.error(`    ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log('all sync-timeout tests passed');
}

void main();
