// Tests for the pure UriHashCache + hashFileAtUri (M5.2.5).
//
// Runs under plain Node via tsx — neither the cache nor hashFileAtUri import
// vscode, so we feed them a fake SyncFs keyed by string URIs and assert on
// the operation log + cache stats. The IndexedDB-backed cache is tested
// behind a small fake adapter (see ./sync-hash-cache-idb.test.ts below in
// the same module — kept inline because the IDB cache is essentially a thin
// shim over an IdbStore).
//
// Run with: npm run test:sync-hash-cache

import { strict as assert } from 'node:assert';
import { webcrypto } from 'node:crypto';
import { hashFileAtUri, sha256Hex } from '../src/sync/hash';
import {
  InMemoryHashCache,
  lruGet,
  lruPut,
  type HashCacheEntry,
  type UriHashCache,
} from '../src/sync/hashCache';
import { IndexedDbHashCache } from '../src/sync/hashCacheIdb';
import type { IdbStore } from '../src/sync/idbAdapter';
import type { SyncFs } from '../src/sync/executor';

// crypto.subtle is required by sha256Hex; Node 20+ exposes it under
// `webcrypto`. globalThis.crypto may already exist on Node 21+ but assigning
// is idempotent under that case.
if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto?: unknown }).crypto = webcrypto;
}

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void): void => {
  tests.push([name, fn]);
};

// ───── fake fs ───────────────────────────────────────────────────────────

interface Stat {
  size: number;
  mtime: number;
}

interface FakeFs extends SyncFs<string> {
  files: Map<string, { bytes: Uint8Array; mtime: number }>;
  ops: string[];
}

function makeFakeFs(): FakeFs {
  const files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  const ops: string[] = [];
  return {
    files,
    ops,
    joinPath(root, relPath) {
      const base = root.endsWith('/') ? root.slice(0, -1) : root;
      const sep = relPath.startsWith('/') ? '' : '/';
      return `${base}${sep}${relPath}`;
    },
    async stat(uri): Promise<Stat> {
      ops.push(`stat ${uri}`);
      const entry = files.get(uri);
      if (!entry) {
        const e = new Error(`fake: file not found at ${uri}`);
        (e as { code?: string }).code = 'FileNotFound';
        throw e;
      }
      return { size: entry.bytes.byteLength, mtime: entry.mtime };
    },
    async readFile(uri) {
      ops.push(`read ${uri}`);
      const entry = files.get(uri);
      if (!entry) {
        const e = new Error(`fake: file not found at ${uri}`);
        (e as { code?: string }).code = 'FileNotFound';
        throw e;
      }
      return entry.bytes;
    },
    async writeFile(uri, bytes) {
      ops.push(`write ${uri}`);
      files.set(uri, { bytes, mtime: Date.now() });
    },
    async rename(src, dst) {
      ops.push(`rename ${src} ${dst}`);
      const entry = files.get(src);
      if (!entry) throw new Error(`fake: no source ${src}`);
      files.set(dst, entry);
      files.delete(src);
    },
    async delete(uri) {
      ops.push(`delete ${uri}`);
      files.delete(uri);
    },
  };
}

function putFile(fs: FakeFs, uri: string, bytes: Uint8Array, mtime: number): void {
  fs.files.set(uri, { bytes, mtime });
}

const enc = new TextEncoder();

// ───── LRU helpers ───────────────────────────────────────────────────────

test('lruGet returns undefined when key missing', () => {
  const m = new Map<string, HashCacheEntry>();
  assert.equal(lruGet(m, 'x', 0, 0), undefined);
});

test('lruGet returns undefined when size differs', () => {
  const m = new Map<string, HashCacheEntry>();
  m.set('x', { size: 10, mtime: 100, sha256: 'aa' });
  assert.equal(lruGet(m, 'x', 11, 100), undefined);
});

test('lruGet returns undefined when mtime differs', () => {
  const m = new Map<string, HashCacheEntry>();
  m.set('x', { size: 10, mtime: 100, sha256: 'aa' });
  assert.equal(lruGet(m, 'x', 10, 101), undefined);
});

test('lruGet returns the entry and bumps it to MRU', () => {
  const m = new Map<string, HashCacheEntry>();
  m.set('a', { size: 1, mtime: 1, sha256: 'a' });
  m.set('b', { size: 1, mtime: 1, sha256: 'b' });
  // a is currently LRU; touching it should make it MRU
  const got = lruGet(m, 'a', 1, 1);
  assert.deepEqual(got, { size: 1, mtime: 1, sha256: 'a' });
  assert.deepEqual([...m.keys()], ['b', 'a']);
});

test('lruPut evicts oldest beyond cap', () => {
  const m = new Map<string, HashCacheEntry>();
  lruPut(m, 'a', { size: 1, mtime: 1, sha256: 'a' }, 2);
  lruPut(m, 'b', { size: 1, mtime: 1, sha256: 'b' }, 2);
  lruPut(m, 'c', { size: 1, mtime: 1, sha256: 'c' }, 2);
  assert.deepEqual([...m.keys()], ['b', 'c']); // a evicted
});

test('lruPut updates an existing key in place and bumps to MRU', () => {
  const m = new Map<string, HashCacheEntry>();
  lruPut(m, 'a', { size: 1, mtime: 1, sha256: 'aa' }, 10);
  lruPut(m, 'b', { size: 1, mtime: 1, sha256: 'bb' }, 10);
  lruPut(m, 'a', { size: 1, mtime: 2, sha256: 'aaa' }, 10);
  assert.deepEqual([...m.keys()], ['b', 'a']);
  assert.deepEqual(m.get('a'), { size: 1, mtime: 2, sha256: 'aaa' });
});

// ───── InMemoryHashCache ────────────────────────────────────────────────

test('InMemoryHashCache: lookup miss then record and hit', async () => {
  const cache = new InMemoryHashCache<string>();
  assert.equal(await cache.lookup('u', 10, 100), undefined);
  assert.deepEqual(cache.stats(), { entries: 0, hits: 0, misses: 1, idb: false });
  await cache.record('u', 10, 100, 'deadbeef');
  assert.equal(await cache.lookup('u', 10, 100), 'deadbeef');
  assert.deepEqual(cache.stats(), { entries: 1, hits: 1, misses: 1, idb: false });
});

test('InMemoryHashCache: size/mtime mismatch invalidates entry', async () => {
  const cache = new InMemoryHashCache<string>();
  await cache.record('u', 10, 100, 'aa');
  assert.equal(await cache.lookup('u', 10, 101), undefined);
  assert.equal(await cache.lookup('u', 11, 100), undefined);
  assert.equal(await cache.lookup('u', 10, 100), 'aa');
});

test('InMemoryHashCache: forget drops an entry', async () => {
  const cache = new InMemoryHashCache<string>();
  await cache.record('u', 10, 100, 'aa');
  await cache.forget('u');
  assert.equal(await cache.lookup('u', 10, 100), undefined);
});

test('InMemoryHashCache: bounded by maxEntries (LRU evicts)', async () => {
  const cache = new InMemoryHashCache<string>({ maxEntries: 2 });
  await cache.record('a', 1, 1, 'a');
  await cache.record('b', 1, 1, 'b');
  await cache.record('c', 1, 1, 'c'); // evicts a
  assert.equal(await cache.lookup('a', 1, 1), undefined);
  assert.equal(await cache.lookup('b', 1, 1), 'b');
  assert.equal(await cache.lookup('c', 1, 1), 'c');
  assert.equal(cache.stats().entries, 2);
});

// ───── hashFileAtUri ────────────────────────────────────────────────────

test('hashFileAtUri: no cache → stat + read + hash, returns bytes when asked', async () => {
  const fs = makeFakeFs();
  const bytes = enc.encode('hello world');
  putFile(fs, 'u', bytes, 12345);

  const r1 = await hashFileAtUri(fs, 'u');
  assert.equal(r1.size, bytes.byteLength);
  assert.equal(r1.mtime, 12345);
  assert.equal(r1.sha256, await sha256Hex(bytes));
  assert.equal(r1.bytes, undefined, 'bytes withheld when needBytes is not set');

  const r2 = await hashFileAtUri(fs, 'u', undefined, { needBytes: true });
  assert.ok(r2.bytes && r2.bytes.byteLength === bytes.byteLength);

  // Without a cache we stat + read on every call.
  assert.deepEqual(fs.ops, ['stat u', 'read u', 'stat u', 'read u']);
});

test('hashFileAtUri: cache hit on destination walk shape skips the read', async () => {
  const fs = makeFakeFs();
  const bytes = enc.encode('destination bytes');
  putFile(fs, 'd', bytes, 7777);
  const cache = new InMemoryHashCache<string>();

  // First call populates the cache (miss → read+hash+record).
  const first = await hashFileAtUri(fs, 'd', cache);
  assert.equal(first.sha256, await sha256Hex(bytes));
  assert.deepEqual(fs.ops, ['stat d', 'read d']);

  // Second call with same size/mtime is a hit. No read. No bytes returned.
  fs.ops.length = 0;
  const second = await hashFileAtUri(fs, 'd', cache);
  assert.equal(second.sha256, first.sha256);
  assert.equal(second.bytes, undefined);
  assert.deepEqual(fs.ops, ['stat d']);
  assert.deepEqual(cache.stats(), { entries: 1, hits: 1, misses: 1, idb: false });
});

test('hashFileAtUri: cache hit with needBytes:true reads bytes but skips the hash', async () => {
  const fs = makeFakeFs();
  const bytes = enc.encode('source bytes');
  putFile(fs, 's', bytes, 444);
  const cache = new InMemoryHashCache<string>();

  await hashFileAtUri(fs, 's', cache); // populate

  fs.ops.length = 0;
  const r = await hashFileAtUri(fs, 's', cache, { needBytes: true });
  assert.deepEqual(fs.ops, ['stat s', 'read s'], 'read happens; no second compute step is observable to fs');
  assert.ok(r.bytes);
  assert.equal(r.bytes!.byteLength, bytes.byteLength);
  assert.equal(r.sha256, await sha256Hex(bytes));
});

test('hashFileAtUri: cache miss after mtime change → re-reads and updates the cache', async () => {
  const fs = makeFakeFs();
  const v1 = enc.encode('one');
  putFile(fs, 'f', v1, 1000);
  const cache = new InMemoryHashCache<string>();
  const r1 = await hashFileAtUri(fs, 'f', cache);

  // File overwritten with new bytes + new mtime; cache should invalidate.
  const v2 = enc.encode('two');
  putFile(fs, 'f', v2, 2000);

  fs.ops.length = 0;
  const r2 = await hashFileAtUri(fs, 'f', cache);
  assert.notEqual(r2.sha256, r1.sha256);
  assert.deepEqual(fs.ops, ['stat f', 'read f']);
  // And the cache should now hold the new entry.
  fs.ops.length = 0;
  await hashFileAtUri(fs, 'f', cache);
  assert.deepEqual(fs.ops, ['stat f']);
});

test('hashFileAtUri: throwing cache.record does not propagate', async () => {
  const fs = makeFakeFs();
  putFile(fs, 'u', enc.encode('x'), 1);
  const throwing: UriHashCache<string> = {
    async lookup() { return undefined; },
    async record() { throw new Error('idb-full'); },
    async forget() { /* noop */ },
    stats() { return { entries: 0, hits: 0, misses: 0, idb: true }; },
  };
  // Should not reject.
  const r = await hashFileAtUri(fs, 'u', throwing);
  assert.ok(r.sha256);
});

// ───── IndexedDbHashCache (with a fake IdbStore) ─────────────────────────

function makeFakeIdb<V>(): IdbStore<V> & { backing: Map<string, V>; ops: string[] } {
  const backing = new Map<string, V>();
  const ops: string[] = [];
  return {
    backing,
    ops,
    async get(key) {
      ops.push(`get ${key}`);
      return backing.get(key);
    },
    async put(key, value) {
      ops.push(`put ${key}`);
      backing.set(key, value);
    },
    async delete(key) {
      ops.push(`delete ${key}`);
      backing.delete(key);
    },
    async clear() {
      ops.push('clear');
      backing.clear();
    },
    async count() {
      return backing.size;
    },
    async getAll() {
      ops.push('getAll');
      return [...backing.values()];
    },
    close() {
      ops.push('close');
    },
  };
}

test('IndexedDbHashCache: miss when both tiers empty', async () => {
  const store = makeFakeIdb<HashCacheEntry>();
  const cache = await IndexedDbHashCache.open<string>({ open: async () => store });
  assert.equal(await cache.lookup('u', 10, 100), undefined);
  assert.deepEqual(cache.stats(), { entries: 0, hits: 0, misses: 1, idb: true });
  assert.deepEqual(store.ops, ['get u']);
});

test('IndexedDbHashCache: record writes through to IDB and warms in-memory', async () => {
  const store = makeFakeIdb<HashCacheEntry>();
  const cache = await IndexedDbHashCache.open<string>({ open: async () => store });
  await cache.record('u', 10, 100, 'abc123');
  assert.deepEqual([...store.backing.keys()], ['u']);
  // Next lookup is an in-memory hit; no extra IDB get is issued.
  store.ops.length = 0;
  const hit = await cache.lookup('u', 10, 100);
  assert.equal(hit, 'abc123');
  assert.deepEqual(store.ops, []);
});

test('IndexedDbHashCache: in-memory miss falls back to IDB and warms in-memory', async () => {
  // Simulate cold session: IDB pre-populated, in-memory empty.
  const store = makeFakeIdb<HashCacheEntry>();
  store.backing.set('u', { size: 10, mtime: 100, sha256: 'abc' });
  const cache = await IndexedDbHashCache.open<string>({ open: async () => store });

  // First lookup goes through to IDB.
  store.ops.length = 0;
  const first = await cache.lookup('u', 10, 100);
  assert.equal(first, 'abc');
  assert.deepEqual(store.ops, ['get u']);

  // Second lookup is in-memory only.
  store.ops.length = 0;
  const second = await cache.lookup('u', 10, 100);
  assert.equal(second, 'abc');
  assert.deepEqual(store.ops, []);
  assert.equal(cache.stats().hits, 2);
});

test('IndexedDbHashCache: IDB key matches but size/mtime mismatch → miss', async () => {
  const store = makeFakeIdb<HashCacheEntry>();
  store.backing.set('u', { size: 10, mtime: 100, sha256: 'abc' });
  const cache = await IndexedDbHashCache.open<string>({ open: async () => store });
  assert.equal(await cache.lookup('u', 10, 101), undefined);
  assert.equal(await cache.lookup('u', 11, 100), undefined);
});

test('IndexedDbHashCache: forget drops both tiers', async () => {
  const store = makeFakeIdb<HashCacheEntry>();
  const cache = await IndexedDbHashCache.open<string>({ open: async () => store });
  await cache.record('u', 10, 100, 'abc');
  await cache.forget('u');
  assert.equal(store.backing.has('u'), false);
  assert.equal(await cache.lookup('u', 10, 100), undefined);
});

test('IndexedDbHashCache: tolerates IDB.put failure (in-memory still works)', async () => {
  const store: IdbStore<HashCacheEntry> = {
    async get() { return undefined; },
    async put() { throw new Error('quota'); },
    async delete() { /* ok */ },
    async clear() { /* ok */ },
    async count() { return 0; },
    async getAll() { return []; },
    close() { /* ok */ },
  };
  const cache = await IndexedDbHashCache.open<string>({ open: async () => store });
  await cache.record('u', 10, 100, 'abc'); // must not throw
  assert.equal(await cache.lookup('u', 10, 100), 'abc');
});

// ───── run ────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
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
})();
