// Tests for the pure reverse-flow copy (dest → source).
// Run with: npm run test:sync-reverse-flow
//
// Mirrors the executor test's fake-fs approach: string URIs, an in-memory
// file map, injectable failures, and an ordered op log so we can assert the
// atomic write/rename sequence.

import { strict as assert } from 'node:assert';
import { copyDestToSource } from '../src/sync/reverseFlow';
import type { SyncFs } from '../src/sync/executor';

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void): void => {
  tests.push([name, fn]);
};

const SOURCE_ROOT = 'src://';
const DEST_ROOT = 'dst://';

interface FakeFs extends SyncFs<string> {
  files: Map<string, Uint8Array>;
  renameErrors: Map<string, Error>;
  ops: string[];
}

function makeFakeFs(): FakeFs {
  const files = new Map<string, Uint8Array>();
  const renameErrors = new Map<string, Error>();
  const ops: string[] = [];
  return {
    files,
    renameErrors,
    ops,
    joinPath(root, relPath) {
      const base = root.endsWith('/') ? root.slice(0, -1) : root;
      const sep = relPath.startsWith('/') ? '' : '/';
      return `${base}${sep}${relPath}`;
    },
    async stat(uri) {
      const bytes = files.get(uri);
      if (!bytes) {
        const e = new Error(`fake: not found ${uri}`);
        (e as { code?: string }).code = 'FileNotFound';
        throw e;
      }
      return { size: bytes.byteLength, mtime: 0 };
    },
    async readFile(uri) {
      ops.push(`read ${uri}`);
      const bytes = files.get(uri);
      if (!bytes) {
        const e = new Error(`fake: not found ${uri}`);
        (e as { code?: string }).code = 'FileNotFound';
        throw e;
      }
      return bytes;
    },
    async writeFile(uri, bytes) {
      ops.push(`write ${uri}`);
      files.set(uri, bytes);
    },
    async rename(src, dst) {
      ops.push(`rename ${src} ${dst}`);
      const err = renameErrors.get(src) ?? renameErrors.get(dst);
      if (err) throw err;
      const bytes = files.get(src);
      if (!bytes) {
        const e = new Error(`fake: rename source missing ${src}`);
        (e as { code?: string }).code = 'FileNotFound';
        throw e;
      }
      files.delete(src);
      files.set(dst, bytes);
    },
    async delete(uri) {
      ops.push(`delete ${uri}`);
      files.delete(uri);
    },
  };
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined): string => (b ? new TextDecoder().decode(b) : '');
async function lenHash(bytes: Uint8Array): Promise<string> {
  return `h${bytes.byteLength}`;
}

// ───── promote: overwrite an existing source ───────────────────────────────

test('promote: overwrites the existing source with the destination bytes', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://a.txt', enc('OLD source'));
  fs.files.set('dst://a.txt', enc('EDITED at destination'));

  const result = await copyDestToSource({
    sourceRootUri: SOURCE_ROOT,
    sourceRelPath: 'a.txt',
    destRootUri: DEST_ROOT,
    destRelPath: 'a.txt',
    fs,
    hash: lenHash,
  });

  assert.equal(result.status, 'ok');
  assert.equal(dec(fs.files.get('src://a.txt')), 'EDITED at destination');
  assert.equal(result.size, enc('EDITED at destination').byteLength);
  assert.equal(result.sha256, `h${result.size}`);
  // Atomic: bytes go to <source>.tmp first, then rename over the final path.
  assert.deepEqual(fs.ops, [
    'read dst://a.txt',
    'write src://a.txt.tmp',
    'rename src://a.txt.tmp src://a.txt',
  ]);
  // No lingering tmp.
  assert.ok(!fs.files.has('src://a.txt.tmp'), 'tmp should be renamed away');
});

// ───── copy: seed a brand-new source ───────────────────────────────────────

test('copy: creates a new source file from a destination-only file', async () => {
  const fs = makeFakeFs();
  fs.files.set('dst://new.txt', enc('born in the destination'));

  const result = await copyDestToSource({
    sourceRootUri: SOURCE_ROOT,
    sourceRelPath: 'new.txt',
    destRootUri: DEST_ROOT,
    destRelPath: 'new.txt',
    fs,
    hash: lenHash,
  });

  assert.equal(result.status, 'ok');
  assert.equal(dec(fs.files.get('src://new.txt')), 'born in the destination');
});

// ───── alias rewrite: source path differs from dest path ───────────────────

test('promote: writes to the pre-alias source path when they differ', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://MON/room1/keynote.pptx', enc('old'));
  fs.files.set('dst://MON/keynote.pptx', enc('edited'));

  const result = await copyDestToSource({
    sourceRootUri: SOURCE_ROOT,
    sourceRelPath: 'MON/room1/keynote.pptx',
    destRootUri: DEST_ROOT,
    destRelPath: 'MON/keynote.pptx',
    fs,
    hash: lenHash,
  });

  assert.equal(result.status, 'ok');
  assert.equal(dec(fs.files.get('src://MON/room1/keynote.pptx')), 'edited');
  // The dest file is untouched by the copy.
  assert.equal(dec(fs.files.get('dst://MON/keynote.pptx')), 'edited');
});

// ───── failure isolation ───────────────────────────────────────────────────

test('failed when the destination file is missing; source is untouched', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://a.txt', enc('keep me'));

  const result = await copyDestToSource({
    sourceRootUri: SOURCE_ROOT,
    sourceRelPath: 'a.txt',
    destRootUri: DEST_ROOT,
    destRelPath: 'a.txt',
    fs,
    hash: lenHash,
  });

  assert.equal(result.status, 'failed');
  assert.ok(result.error && /not found/.test(result.error));
  assert.equal(dec(fs.files.get('src://a.txt')), 'keep me', 'source must be unchanged on failure');
});

test('rename failure cleans up the tmp and leaves the source intact', async () => {
  const fs = makeFakeFs();
  fs.files.set('src://a.txt', enc('original'));
  fs.files.set('dst://a.txt', enc('edited'));
  fs.renameErrors.set('src://a.txt', new Error('rename boom'));

  const result = await copyDestToSource({
    sourceRootUri: SOURCE_ROOT,
    sourceRelPath: 'a.txt',
    destRootUri: DEST_ROOT,
    destRelPath: 'a.txt',
    fs,
    hash: lenHash,
  });

  assert.equal(result.status, 'failed');
  assert.ok(result.error && /boom/.test(result.error));
  // Original source bytes preserved (final path never half-written).
  assert.equal(dec(fs.files.get('src://a.txt')), 'original');
  // Tmp cleaned up on the failure path.
  assert.ok(!fs.files.has('src://a.txt.tmp'), 'tmp should be deleted after rename failure');
  assert.ok(fs.ops.includes('delete src://a.txt.tmp'), 'cleanup delete should have run');
});

// ───── runner ──────────────────────────────────────────────────────────────

(async (): Promise<void> => {
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
  console.log('all tests passed');
})();
