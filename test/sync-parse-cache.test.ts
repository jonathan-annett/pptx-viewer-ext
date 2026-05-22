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
} from '../src/sync/parseCache';
import type { ParseResult } from '../src/pptx';

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
      thumbnail: undefined,
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

  // ---------- defaults ----------
  {
    assert.equal(typeof DEFAULT_MAX_ENTRIES, 'number');
    assert.ok(DEFAULT_MAX_ENTRIES > 0);
    ok(`DEFAULT_MAX_ENTRIES is positive (${DEFAULT_MAX_ENTRIES})`);
  }

  console.log('all tests passed');
}

run().catch((err) => {
  console.error('test run failed:', err);
  process.exit(1);
});
