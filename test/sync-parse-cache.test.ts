// Tests for the content-hashed parse cache (M5.3 Phase A).
//
// Runs under plain Node via tsx — neither the cache nor parsePptxCached
// imports vscode. We build a synthetic minimal pptx zip and assert that
// repeated parsePptxCached calls hit the cache on the second pass and that
// per-open display fields (fileName, mtime) come from the caller's FileInfo
// rather than the cached payload.
//
// Run with: npm run test:sync-parse-cache

import { strict as assert } from 'node:assert';
import { webcrypto } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import {
  DEFAULT_MAX_ENTRIES,
  InMemoryParseCache,
  hydrate,
  lruGet,
  lruPut,
  parsePptxCached,
  project,
  setParseCacheSingleton,
  getParseCacheSingleton,
  snapshotLookup,
  type CachedParseResult,
} from '../src/sync/parseCache';
import {
  IndexedDbParseCache,
  type ParseResultRecord,
} from '../src/sync/parseCacheIdb';
import type { IdbStore } from '../src/sync/idbAdapter';
import type { ParseResult, Thumbnail } from '../src/pptx';

if (!(globalThis as { crypto?: unknown }).crypto) {
  (globalThis as { crypto?: unknown }).crypto = webcrypto;
}

// Build a minimal pptx that survives the parser. Just enough to land in the
// "successful parse" path so the cache has a meaningful payload to store.
function makeMinimalPptx(): Uint8Array {
  const ct = `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`;
  const presentation = `<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"></p:presentation>`;
  const core = `<?xml version="1.0"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:creator>Alice</dc:creator>
  <cp:lastModifiedBy>Bob</cp:lastModifiedBy>
</cp:coreProperties>`;
  return zipSync({
    '[Content_Types].xml': strToU8(ct),
    'ppt/presentation.xml': strToU8(presentation),
    'docProps/core.xml': strToU8(core),
  });
}

function ok(name: string): void {
  console.log(`  ok: ${name}`);
}

// Fake IdbStore for IDB-backed cache tests. Mirrors the pattern used in
// test/sync-hash-cache.test.ts — no real IndexedDB needed; we just trace
// the call sequence and inspect the backing map.
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
    async getAllEntries() {
      ops.push('getAllEntries');
      return [...backing.entries()];
    },
    close() {
      ops.push('close');
    },
  };
}

function makeSampleCached(sha: string, withThumbnail: boolean): CachedParseResult {
  const thumbnail: Thumbnail | undefined = withThumbnail
    ? { mime: 'image/png', dataUrl: 'data:image/png;base64,iVBOR' }
    : undefined;
  return project({
    fileName: '', size: 0, sizeHuman: '', mtime: 0, mtimeHuman: '',
    sha256: sha,
    slideCount: 7, hiddenSlideCount: 2,
    author: 'Carol', lastModifiedBy: 'Dave',
    embeddedMedia: [],
    mediaFiles: [],
    thumbnail,
    firstVisibleSlideText: '',
    flags: {
      linkedMedia: { ok: true, label: 'Linked media', detail: '' },
      showType: { ok: true, label: 'Show type', detail: '' },
      showMediaControls: { ok: true, label: 'Show media controls', detail: '' },
    },
  });
}

async function run(): Promise<void> {
  // ---------- LRU helpers ----------
  {
    const map = new Map<string, number>();
    lruPut(map, 'a', 1, 3);
    lruPut(map, 'b', 2, 3);
    lruPut(map, 'c', 3, 3);
    assert.equal(lruGet(map, 'a'), 1);
    // 'a' was just touched, so it's MRU now; inserting 'd' evicts 'b'.
    lruPut(map, 'd', 4, 3);
    assert.equal(lruGet(map, 'b'), undefined);
    assert.equal(lruGet(map, 'a'), 1);
    ok('lruGet bumps MRU, lruPut evicts oldest at capacity');
  }

  // ---------- project + hydrate round-trip ----------
  {
    const result: ParseResult = {
      fileName: 'orig.pptx',
      size: 1024,
      sizeHuman: '1.00 KB',
      mtime: 1_700_000_000_000,
      mtimeHuman: '2023-…',
      sha256: 'deadbeef',
      slideCount: 5,
      hiddenSlideCount: 1,
      author: 'Alice',
      lastModifiedBy: 'Bob',
      embeddedMedia: [],
      mediaFiles: [],
      thumbnail: undefined,
      firstVisibleSlideText: '',
      flags: {
        linkedMedia: { ok: true, label: 'Linked media', detail: '' },
        showType: { ok: true, label: 'Show type', detail: '' },
        showMediaControls: { ok: true, label: 'Show media controls', detail: '' },
      },
      parseError: undefined,
      timings: {
        hashMs: 1, unzipMs: 1, xmlDecodeMs: 1, slideScanMs: 1,
        metadataMs: 1, mediaMs: 1, showPropsMs: 1, totalMs: 7,
      },
    };
    const cached = project(result);
    assert.equal('fileName' in cached, false, 'fileName must not survive project');
    assert.equal('size' in cached, false, 'size must not survive project');
    assert.equal('mtime' in cached, false, 'mtime must not survive project');
    assert.equal('timings' in cached, false, 'timings must not survive project');
    assert.equal(cached.sha256, 'deadbeef');
    assert.equal(cached.slideCount, 5);
    ok('project drops per-open display fields and timings');

    const hydrated = hydrate(cached, {
      fileName: 'renamed.pptx',
      size: 2048,
      mtime: 1_800_000_000_000,
    });
    assert.equal(hydrated.fileName, 'renamed.pptx', 'fileName comes from FileInfo');
    assert.equal(hydrated.size, 2048, 'size comes from FileInfo');
    assert.equal(hydrated.mtime, 1_800_000_000_000, 'mtime comes from FileInfo');
    assert.equal(hydrated.sizeHuman, '2.00 KB', 'sizeHuman recomputed from FileInfo.size');
    assert.notEqual(hydrated.mtimeHuman, 'unknown', 'mtimeHuman composed from FileInfo.mtime');
    assert.equal(hydrated.slideCount, 5, 'content fields from cache');
    assert.equal(hydrated.author, 'Alice');
    assert.equal(hydrated.timings, undefined, 'no timings on cache hit');
    ok('hydrate composes per-open display fields from FileInfo, content from cache');
  }

  // ---------- InMemoryParseCache lookup/record ----------
  {
    const cache = new InMemoryParseCache();
    const sample = project({
      fileName: '',
      size: 0,
      sizeHuman: '',
      mtime: 0,
      mtimeHuman: '',
      sha256: 'abc123',
      slideCount: 3,
      hiddenSlideCount: 0,
      author: '',
      lastModifiedBy: '',
      embeddedMedia: [],
      mediaFiles: [],
      firstVisibleSlideText: '',
      flags: {
        linkedMedia: { ok: true, label: '', detail: '' },
        showType: { ok: true, label: '', detail: '' },
        showMediaControls: { ok: true, label: '', detail: '' },
      },
    });
    assert.equal(await cache.lookup('abc123'), undefined);
    assert.equal(cache.stats().misses, 1);
    await cache.record('abc123', sample);
    const hit = await cache.lookup('abc123');
    assert.ok(hit);
    assert.equal(hit?.slideCount, 3);
    assert.equal(cache.stats().hits, 1);
    assert.equal(cache.stats().entries, 1);
    assert.equal(cache.stats().idb, false);
    ok('InMemoryParseCache: miss → record → hit, stats counts both');
  }

  // ---------- LRU eviction at capacity ----------
  {
    const cache = new InMemoryParseCache({ maxEntries: 2 });
    const stub = project({
      fileName: '', size: 0, sizeHuman: '', mtime: 0, mtimeHuman: '',
      sha256: '', slideCount: 0, hiddenSlideCount: 0, author: '', lastModifiedBy: '',
      embeddedMedia: [],
      mediaFiles: [],
      firstVisibleSlideText: '',
      flags: {
        linkedMedia: { ok: true, label: '', detail: '' },
        showType: { ok: true, label: '', detail: '' },
        showMediaControls: { ok: true, label: '', detail: '' },
      },
    });
    await cache.record('one', stub);
    await cache.record('two', stub);
    await cache.lookup('one'); // bump 'one' to MRU
    await cache.record('three', stub); // should evict 'two'
    assert.equal(await cache.lookup('two'), undefined, 'LRU evicts oldest');
    assert.ok(await cache.lookup('one'), 'MRU survives');
    assert.ok(await cache.lookup('three'), 'most-recent insert survives');
    ok('InMemoryParseCache: LRU eviction respects MRU bumps');
  }

  // ---------- InMemoryParseCache.snapshot: returns a frozen shallow copy ----------
  {
    const cache = new InMemoryParseCache();
    await cache.record('aaa', makeSampleCached('aaa', false));
    await cache.record('bbb', makeSampleCached('bbb', true));
    const snap = await cache.snapshot();
    assert.equal(snap.size, 2, 'snapshot includes both entries');
    assert.equal(snap.get('aaa')?.sha256, 'aaa');
    assert.equal(snap.get('bbb')?.sha256, 'bbb');

    // Records added after snapshot() must NOT mutate the snapshot (frozen).
    await cache.record('ccc', makeSampleCached('ccc', false));
    assert.equal(snap.size, 2, 'snapshot is frozen against later record()');
    assert.equal(snap.get('ccc'), undefined);

    // But the underlying cache picked up the new entry — a fresh snapshot
    // sees it.
    const snap2 = await cache.snapshot();
    assert.equal(snap2.size, 3, 'fresh snapshot picks up later record');

    // Mutating the snapshot map must NOT mutate the cache.
    snap.delete('aaa');
    const hit = await cache.lookup('aaa');
    assert.ok(hit, 'underlying cache still has the entry');
    ok('InMemoryParseCache.snapshot returns a frozen shallow copy');
  }

  // ---------- snapshotLookup: snapshot hit short-circuits, miss falls through ----------
  {
    const cache = new InMemoryParseCache();
    await cache.record('inboth', makeSampleCached('inboth', false));
    await cache.record('cachonly', makeSampleCached('cachonly', false));
    const snap = await cache.snapshot();
    // Drop cachonly from the snapshot to simulate "added after snapshot".
    snap.delete('cachonly');

    // Snapshot hit — no underlying lookup needed.
    const beforeHits = cache.stats().hits;
    const hit1 = await snapshotLookup(snap, cache, 'inboth');
    assert.equal(hit1?.sha256, 'inboth', 'snapshot hit returns the value');
    assert.equal(cache.stats().hits, beforeHits, 'snapshot hit does not bump cache.stats.hits');

    // Snapshot miss + cache hit — falls through to lookup().
    const hit2 = await snapshotLookup(snap, cache, 'cachonly');
    assert.equal(hit2?.sha256, 'cachonly', 'fallthrough returns cache value');
    assert.equal(cache.stats().hits, beforeHits + 1, 'fallthrough bumps cache.stats.hits');

    // Snapshot miss + no cache (snapshot-only mode).
    const miss = await snapshotLookup(snap, undefined, 'cachonly');
    assert.equal(miss, undefined, 'snapshot-only mode returns undefined on miss');

    // Snapshot undefined + cache present — degenerates to plain cache.lookup.
    const hit3 = await snapshotLookup(undefined, cache, 'inboth');
    assert.equal(hit3?.sha256, 'inboth');
    ok('snapshotLookup: hit short-circuits, miss falls through, both modes work');
  }

  // ---------- parsePptxCached: no cache → falls through to parsePptx ----------
  {
    const bytes = makeMinimalPptx();
    const outcome = await parsePptxCached(
      bytes,
      { fileName: 'm.pptx', size: bytes.byteLength, mtime: 1 },
      undefined,
    );
    assert.equal(outcome.cacheHit, false, 'no-cache: cacheHit=false');
    assert.ok(outcome.result.sha256.length === 64, 'parsed sha256 looks valid');
    assert.equal(outcome.result.author, 'Alice');
    ok('parsePptxCached: no cache supplied → falls through to parsePptx');
  }

  // ---------- parsePptxCached: miss-then-hit ----------
  {
    const bytes = makeMinimalPptx();
    const cache = new InMemoryParseCache();
    const first = await parsePptxCached(
      bytes,
      { fileName: 'first.pptx', size: bytes.byteLength, mtime: 1000 },
      cache,
    );
    assert.equal(first.cacheHit, false, 'first call is a miss');
    assert.equal(cache.stats().misses, 1);
    assert.equal(cache.stats().entries, 1);

    // Second call with same bytes but different display fields. Expect hit
    // and the result's fileName/mtime to reflect the new FileInfo.
    const second = await parsePptxCached(
      bytes,
      { fileName: 'second.pptx', size: bytes.byteLength, mtime: 2000 },
      cache,
    );
    assert.equal(second.cacheHit, true, 'second call hits');
    assert.equal(cache.stats().hits, 1);
    assert.equal(second.result.fileName, 'second.pptx', 'fileName overridden on hit');
    assert.equal(second.result.mtime, 2000, 'mtime overridden on hit');
    assert.equal(second.result.sha256, first.result.sha256, 'sha256 preserved');
    assert.equal(second.result.author, 'Alice', 'content fields preserved on hit');
    assert.equal(second.result.timings, undefined, 'no timings on hit');
    ok('parsePptxCached: miss caches, second call hits with overridden display fields');
  }

  // ---------- parsePptxCached: zero-byte short-circuits without consulting the cache ----------
  {
    const cache = new InMemoryParseCache();
    const outcome = await parsePptxCached(
      new Uint8Array(0),
      { fileName: 'empty.pptx', size: 0, mtime: 1234 },
      cache,
    );
    // No IDB / Map round-trip on the zero-byte path; cacheHit is reported as
    // true to reflect "no work was done in the wrapper".
    assert.equal(outcome.cacheHit, true, 'zero-byte path reports cacheHit=true');
    assert.equal(
      outcome.result.sha256,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'sha256 is the well-known empty digest',
    );
    assert.equal(outcome.result.parseError, undefined, 'no parseError on zero-byte');
    // The cache was never written to or queried.
    assert.equal(cache.stats().entries, 0, 'cache.record was not called');
    assert.equal(cache.stats().hits, 0, 'cache.lookup was not called');
    assert.equal(cache.stats().misses, 0, 'cache.lookup was not called');
    ok('parsePptxCached: zero-byte short-circuits without touching the cache');
  }

  // ---------- singleton getter/setter ----------
  {
    assert.equal(getParseCacheSingleton(), undefined, 'singleton starts unset');
    const cache = new InMemoryParseCache();
    setParseCacheSingleton(cache);
    assert.equal(getParseCacheSingleton(), cache, 'singleton round-trips');
    setParseCacheSingleton(undefined);
    assert.equal(getParseCacheSingleton(), undefined, 'singleton can be cleared');
    ok('module singleton getter/setter round-trip');
  }

  // ---------- IndexedDbParseCache: miss when both stores empty ----------
  {
    const results = makeFakeIdb<ParseResultRecord>();
    const thumbs = makeFakeIdb<Thumbnail>();
    const cache = await IndexedDbParseCache.open({
      openResults: async () => results,
      openThumbnails: async () => thumbs,
    });
    assert.equal(await cache.lookup('nope'), undefined);
    assert.equal(cache.stats().misses, 1);
    assert.equal(cache.stats().idb, true);
    // Both stores were probed in parallel.
    assert.deepEqual(results.ops, ['get nope']);
    assert.deepEqual(thumbs.ops, ['get nope']);
    ok('IndexedDbParseCache: miss probes both stores; reports idb=true');
  }

  // ---------- IndexedDbParseCache: record splits payload across stores ----------
  {
    const results = makeFakeIdb<ParseResultRecord>();
    const thumbs = makeFakeIdb<Thumbnail>();
    const cache = await IndexedDbParseCache.open({
      openResults: async () => results,
      openThumbnails: async () => thumbs,
    });
    const sample = makeSampleCached('aaa', true);
    await cache.record('aaa', sample);

    // parseResults gets the record sans-thumbnail; thumbnails gets just the
    // thumbnail. Storing the thumbnail twice would waste quota on the heavy
    // payload and break the "drop thumbs to relieve memory pressure" plan.
    const stored = results.backing.get('aaa');
    assert.ok(stored, 'parseResults has the record');
    assert.equal('thumbnail' in (stored ?? {}), false, 'parseResults record has no thumbnail');
    assert.equal(stored?.slideCount, 7);
    assert.equal(thumbs.backing.get('aaa')?.mime, 'image/png');
    ok('IndexedDbParseCache: record splits thumbnail into thumbnails store');
  }

  // ---------- IndexedDbParseCache: record without thumbnail leaves thumbs untouched ----------
  {
    const results = makeFakeIdb<ParseResultRecord>();
    const thumbs = makeFakeIdb<Thumbnail>();
    const cache = await IndexedDbParseCache.open({
      openResults: async () => results,
      openThumbnails: async () => thumbs,
    });
    await cache.record('bbb', makeSampleCached('bbb', false));
    assert.ok(results.backing.has('bbb'));
    assert.equal(thumbs.backing.has('bbb'), false, 'no thumbnail → no entry in thumbnails store');
    assert.deepEqual(thumbs.ops, [], 'no put issued against thumbnails store');
    ok('IndexedDbParseCache: record skips thumbnails store when thumbnail is absent');
  }

  // ---------- IndexedDbParseCache: cold session reads from IDB then warms in-memory ----------
  {
    const results = makeFakeIdb<ParseResultRecord>();
    const thumbs = makeFakeIdb<Thumbnail>();
    // Pre-populate IDB to simulate a previous session's work.
    const cold = makeSampleCached('ccc', true);
    const { thumbnail, ...rest } = cold;
    results.backing.set('ccc', rest);
    if (thumbnail) thumbs.backing.set('ccc', thumbnail);

    const cache = await IndexedDbParseCache.open({
      openResults: async () => results,
      openThumbnails: async () => thumbs,
    });

    // First lookup goes through to IDB on both stores and reassembles.
    results.ops.length = 0;
    thumbs.ops.length = 0;
    const first = await cache.lookup('ccc');
    assert.ok(first, 'IDB-only entry resolves on cold lookup');
    assert.equal(first?.slideCount, 7);
    assert.equal(first?.thumbnail?.mime, 'image/png', 'thumbnail reassembled from second store');
    assert.deepEqual(results.ops, ['get ccc']);
    assert.deepEqual(thumbs.ops, ['get ccc']);

    // Second lookup is served from the warmed in-memory tier — no extra IDB hits.
    results.ops.length = 0;
    thumbs.ops.length = 0;
    const second = await cache.lookup('ccc');
    assert.ok(second);
    assert.deepEqual(results.ops, [], 'in-memory hit, no IDB get');
    assert.deepEqual(thumbs.ops, [], 'in-memory hit, no IDB get');
    assert.equal(cache.stats().hits, 2);
    ok('IndexedDbParseCache: cold IDB lookup reassembles + warms in-memory');
  }

  // ---------- IndexedDbParseCache: result-present, thumbnail-absent means "no thumbnail" ----------
  {
    const results = makeFakeIdb<ParseResultRecord>();
    const thumbs = makeFakeIdb<Thumbnail>();
    const cold = makeSampleCached('ddd', false); // built with thumbnail: undefined
    const { thumbnail: _ignored, ...rest } = cold;
    results.backing.set('ddd', rest);
    // Intentionally no entry in thumbs.

    const cache = await IndexedDbParseCache.open({
      openResults: async () => results,
      openThumbnails: async () => thumbs,
    });
    const hit = await cache.lookup('ddd');
    assert.ok(hit, 'hit even without a thumbnail row');
    assert.equal(hit?.thumbnail, undefined, 'absent thumbnail row means content has no thumbnail');
    ok('IndexedDbParseCache: parseResults hit + thumbnails miss → CachedParseResult with no thumbnail');
  }

  // ---------- IndexedDbParseCache.snapshot: single getAll(), excludes identity-only + thumbnails ----------
  {
    const results = makeFakeIdb<ParseResultRecord>();
    const thumbs = makeFakeIdb<Thumbnail>();
    const cache = await IndexedDbParseCache.open({
      openResults: async () => results,
      openThumbnails: async () => thumbs,
    });
    // Two full parse records (with flags) + one identity-only record (no
    // flags — like a destination walk's recordIdentity payload).
    await cache.record('aaa', makeSampleCached('aaa', true));
    await cache.record('bbb', makeSampleCached('bbb', false));
    // Identity-only record written directly into the fake — no flags, no
    // sha (but real records always have sha so we set it). Mirrors what
    // recordIdentity produces when no parse data exists yet.
    results.backing.set('ccc', { sha256: 'ccc', knownAt: ['some/path'] });

    results.ops.length = 0; // reset op trace
    thumbs.ops.length = 0;

    const snap = await cache.snapshot();

    // One IDB op, not N — that's the headline contract.
    assert.deepEqual(results.ops, ['getAll'], 'snapshot uses a single getAll on parseResults');
    // Thumbnails store is not touched at all.
    assert.deepEqual(thumbs.ops, [], 'snapshot does not touch the thumbnails store');

    // Snapshot contains the two full records, excludes the identity-only.
    assert.equal(snap.size, 2, 'identity-only record excluded');
    assert.ok(snap.has('aaa'));
    assert.ok(snap.has('bbb'));
    assert.ok(!snap.has('ccc'), 'no-flags record excluded from snapshot');

    // Even the entry that had a thumbnail in IDB comes back with thumbnail
    // omitted — see the snapshot() JSDoc.
    assert.equal(snap.get('aaa')?.thumbnail, undefined, 'thumbnails omitted from IDB snapshot');
    ok('IndexedDbParseCache.snapshot: single getAll, no thumbnails, no identity-only');
  }

  // ---------- IndexedDbParseCache.snapshot: tolerates IDB read failure ----------
  {
    const results: IdbStore<ParseResultRecord> = {
      async get() { return undefined; },
      async put() { /* noop */ },
      async delete() { /* noop */ },
      async clear() { /* noop */ },
      async count() { return 0; },
      async getAll() { throw new Error('idb gone'); },
      async getAllEntries() { throw new Error('idb gone'); },
      close() { /* noop */ },
    };
    const thumbs = makeFakeIdb<Thumbnail>();
    const cache = await IndexedDbParseCache.open({
      openResults: async () => results,
      openThumbnails: async () => thumbs,
    });
    const snap = await cache.snapshot();
    assert.equal(snap.size, 0, 'IDB getAll failure → empty snapshot, no throw');
    ok('IndexedDbParseCache.snapshot: tolerates IDB read failure');
  }

  // ---------- IndexedDbParseCache: forget drops both stores ----------
  {
    const results = makeFakeIdb<ParseResultRecord>();
    const thumbs = makeFakeIdb<Thumbnail>();
    const cache = await IndexedDbParseCache.open({
      openResults: async () => results,
      openThumbnails: async () => thumbs,
    });
    await cache.record('eee', makeSampleCached('eee', true));
    assert.equal(results.backing.has('eee'), true);
    assert.equal(thumbs.backing.has('eee'), true);
    await cache.forget('eee');
    assert.equal(results.backing.has('eee'), false);
    assert.equal(thumbs.backing.has('eee'), false);
    assert.equal(await cache.lookup('eee'), undefined);
    ok('IndexedDbParseCache: forget removes entries from both stores and in-memory');
  }

  // ---------- IndexedDbParseCache: tolerates IDB write failure ----------
  {
    const results: IdbStore<ParseResultRecord> = {
      async get() { return undefined; },
      async put() { throw new Error('quota'); },
      async delete() { /* noop */ },
      async clear() { /* noop */ },
      async count() { return 0; },
      async getAll() { return []; },
      async getAllEntries() { return []; },
      close() { /* noop */ },
    };
    const thumbs = makeFakeIdb<Thumbnail>();
    const cache = await IndexedDbParseCache.open({
      openResults: async () => results,
      openThumbnails: async () => thumbs,
    });
    // Must not throw — IDB write failure is silently absorbed; in-memory
    // tier carries this session.
    await cache.record('fff', makeSampleCached('fff', false));
    const hit = await cache.lookup('fff');
    assert.ok(hit, 'in-memory still works when IDB.put rejects');
    ok('IndexedDbParseCache: tolerates IDB.put failure (in-memory still serves)');
  }

  // ---------- IndexedDbParseCache: idbEntryCount reports parseResults size ----------
  {
    const results = makeFakeIdb<ParseResultRecord>();
    const thumbs = makeFakeIdb<Thumbnail>();
    results.backing.set('w1', {} as ParseResultRecord);
    results.backing.set('w2', {} as ParseResultRecord);
    thumbs.backing.set('w1', { mime: 'image/png', dataUrl: '' });
    const cache = await IndexedDbParseCache.open({
      openResults: async () => results,
      openThumbnails: async () => thumbs,
    });
    assert.equal(await cache.idbEntryCount(), 2, 'count comes from parseResults, not thumbnails');
    ok('IndexedDbParseCache: idbEntryCount counts parseResults entries');
  }

  // ---------- defaults ----------
  {
    assert.equal(typeof DEFAULT_MAX_ENTRIES, 'number');
    assert.ok(DEFAULT_MAX_ENTRIES > 0);
    ok(`DEFAULT_MAX_ENTRIES is positive (${DEFAULT_MAX_ENTRIES})`);
  }

  // ---------- InMemoryParseCache: identity index basic ops ----------
  {
    const cache = new InMemoryParseCache();
    assert.equal(await cache.lookupIdentity('zzz'), undefined, 'empty index returns undefined');
    await cache.recordIdentity('zzz', 'a/file.pptx');
    assert.deepEqual(await cache.lookupIdentity('zzz'), ['a/file.pptx']);
    await cache.recordIdentity('zzz', 'b/file.pptx');
    assert.deepEqual(await cache.lookupIdentity('zzz'), ['a/file.pptx', 'b/file.pptx']);
    // De-duplicated on repeat call.
    await cache.recordIdentity('zzz', 'a/file.pptx');
    assert.deepEqual(await cache.lookupIdentity('zzz'), ['a/file.pptx', 'b/file.pptx']);
    ok('InMemoryParseCache: recordIdentity appends, lookupIdentity returns list, dedup on repeat');
  }

  // ---------- InMemoryParseCache: identity and parse-data are independent ----------
  {
    const cache = new InMemoryParseCache();
    // Identity-only record: no parse data yet, but lookupIdentity should find it.
    await cache.recordIdentity('iso1', 'only/path.pptx');
    assert.equal(await cache.lookup('iso1'), undefined, 'no parse data → lookup miss');
    assert.deepEqual(await cache.lookupIdentity('iso1'), ['only/path.pptx']);
    // Now record parse data — identity must survive.
    const sample = makeSampleCached('iso1', false);
    await cache.record('iso1', sample);
    assert.ok(await cache.lookup('iso1'), 'parse-data hit after record');
    assert.deepEqual(await cache.lookupIdentity('iso1'), ['only/path.pptx'], 'identity preserved');
    // And forget drops both.
    await cache.forget('iso1');
    assert.equal(await cache.lookup('iso1'), undefined);
    assert.equal(await cache.lookupIdentity('iso1'), undefined);
    ok('InMemoryParseCache: identity and parse-data are independent, forget drops both');
  }

  // ---------- IndexedDbParseCache: recordIdentity stores knownAt on parseResults ----------
  {
    const results = makeFakeIdb<ParseResultRecord>();
    const thumbs = makeFakeIdb<Thumbnail>();
    const cache = await IndexedDbParseCache.open({
      openResults: async () => results,
      openThumbnails: async () => thumbs,
    });
    await cache.recordIdentity('idb1', 'first.pptx');
    const stored1 = results.backing.get('idb1');
    assert.deepEqual(stored1?.knownAt, ['first.pptx'], 'identity-only record has knownAt');
    assert.equal(stored1?.flags, undefined, 'identity-only record has no flags (the discriminator)');
    // Second identity record appends.
    await cache.recordIdentity('idb1', 'second.pptx');
    assert.deepEqual(results.backing.get('idb1')?.knownAt, ['first.pptx', 'second.pptx']);
    // Repeat is a no-op against IDB (skips the put).
    results.ops.length = 0;
    await cache.recordIdentity('idb1', 'first.pptx');
    assert.equal(
      results.ops.some((op) => op.startsWith('put ')),
      false,
      'repeat recordIdentity skips IDB put',
    );
    ok('IndexedDbParseCache: recordIdentity writes knownAt, dedups, skips redundant put');
  }

  // ---------- IndexedDbParseCache: lookupIdentity reads from IDB and warms in-memory ----------
  {
    const results = makeFakeIdb<ParseResultRecord>();
    const thumbs = makeFakeIdb<Thumbnail>();
    // Pre-populate as if a prior session recorded identity.
    results.backing.set('idb2', { knownAt: ['cold/x.pptx', 'cold/y.pptx'] });
    const cache = await IndexedDbParseCache.open({
      openResults: async () => results,
      openThumbnails: async () => thumbs,
    });
    results.ops.length = 0;
    const first = await cache.lookupIdentity('idb2');
    assert.deepEqual(first, ['cold/x.pptx', 'cold/y.pptx']);
    assert.deepEqual(results.ops, ['get idb2'], 'cold lookupIdentity hits IDB once');
    // Second call served from warm in-memory — no extra IDB op.
    results.ops.length = 0;
    const second = await cache.lookupIdentity('idb2');
    assert.deepEqual(second, ['cold/x.pptx', 'cold/y.pptx']);
    assert.deepEqual(results.ops, [], 'warm in-memory hit, no IDB op');
    ok('IndexedDbParseCache: lookupIdentity reads cold IDB then warms in-memory');
  }

  // ---------- IndexedDbParseCache: record() preserves existing knownAt ----------
  {
    const results = makeFakeIdb<ParseResultRecord>();
    const thumbs = makeFakeIdb<Thumbnail>();
    // Prior session left an identity-only record.
    results.backing.set('idb3', { knownAt: ['existing.pptx'] });
    const cache = await IndexedDbParseCache.open({
      openResults: async () => results,
      openThumbnails: async () => thumbs,
    });
    // Now full parse arrives — record() must merge knownAt rather than overwrite.
    await cache.record('idb3', makeSampleCached('idb3', false));
    const stored = results.backing.get('idb3');
    assert.deepEqual(stored?.knownAt, ['existing.pptx'], 'knownAt survives record()');
    assert.ok(stored?.flags, 'flags now present from the parse');
    assert.equal(stored?.slideCount, 7, 'parse data is the new payload');
    ok('IndexedDbParseCache: record() merges new parse data with existing knownAt');
  }

  // ---------- IndexedDbParseCache: recordIdentity preserves existing parse data ----------
  {
    const results = makeFakeIdb<ParseResultRecord>();
    const thumbs = makeFakeIdb<Thumbnail>();
    const cache = await IndexedDbParseCache.open({
      openResults: async () => results,
      openThumbnails: async () => thumbs,
    });
    // First the parse, then the identity arrives. Parse data must survive.
    await cache.record('idb4', makeSampleCached('idb4', false));
    await cache.recordIdentity('idb4', 'late/path.pptx');
    const stored = results.backing.get('idb4');
    assert.equal(stored?.slideCount, 7, 'parse data preserved');
    assert.ok(stored?.flags);
    assert.deepEqual(stored?.knownAt, ['late/path.pptx']);
    ok('IndexedDbParseCache: recordIdentity preserves existing parse data');
  }

  // ---------- IndexedDbParseCache: identity-only record returns undefined from lookup() ----------
  {
    const results = makeFakeIdb<ParseResultRecord>();
    const thumbs = makeFakeIdb<Thumbnail>();
    // Identity-only — no flags. Should NOT satisfy a parse-data lookup.
    results.backing.set('idb5', { knownAt: ['only.pptx'] });
    const cache = await IndexedDbParseCache.open({
      openResults: async () => results,
      openThumbnails: async () => thumbs,
    });
    const parseHit = await cache.lookup('idb5');
    assert.equal(parseHit, undefined, 'identity-only record is not a parse-data hit');
    assert.equal(cache.stats().misses, 1, 'counted as a parse-data miss');
    // But lookupIdentity finds it — and the side effect of lookup() warmed
    // the identity map (so no extra IDB op needed).
    results.ops.length = 0;
    const identityHit = await cache.lookupIdentity('idb5');
    assert.deepEqual(identityHit, ['only.pptx']);
    assert.deepEqual(results.ops, [], 'identity warmed by prior lookup, no IDB op');
    ok('IndexedDbParseCache: identity-only record yields lookup miss + lookupIdentity hit');
  }

  console.log('all tests passed');
}

run().catch((err) => {
  console.error('test run failed:', err);
  process.exit(1);
});
