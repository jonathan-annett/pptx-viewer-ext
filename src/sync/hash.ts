// SHA-256 hashing via the Web Crypto API.
// The web-extension host has crypto.subtle; we don't use Node's crypto here
// because that module isn't available in the worker context.

import type { SyncFs } from './host/fs';
import { snapshotHashLookup, type HashCacheEntry, type UriHashCache } from './hashCache';

/**
 * Compute the SHA-256 of a byte buffer and return a lowercase hex string.
 * Empty input yields the conventional empty-bytes digest.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // crypto.subtle.digest returns an ArrayBuffer of the digest bytes (32 for
  // SHA-256). Convert via Uint8Array → array of byte values → hex.
  // Slice into a fresh, owned ArrayBuffer to sidestep TS5's strict
  // ArrayBuffer vs SharedArrayBuffer typing on Uint8Array's underlying buffer.
  // Runtime cost is one copy of the input bytes per hash.
  const buf = bytes.slice().buffer;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    const b = view[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

/**
 * Cache-aware file hash with optional byte return (M5.2.5).
 *
 * Protocol:
 *   1. `fs.stat(uri)` — cheap (~6ms on the FSA adapter per the probe).
 *   2. If a cache is supplied: `cache.lookup(uri, size, mtime)`.
 *      - Hit + `needBytes=false`: return cached sha256, no read.
 *      - Hit + `needBytes=true`:  read bytes, return cached sha256 (we
 *        avoid the hash compute; the read is unavoidable for the caller).
 *      - Miss: fall through.
 *   3. Read + hash + `cache.record(uri, size, mtime, sha)`. Return both.
 *
 * Callers:
 *   - Planner destination walk passes `needBytes:false` → biggest win, the
 *     full read+hash is replaced by stat+lookup on unchanged files.
 *   - Planner source walk passes `needBytes:true` (validators need bytes).
 *     Saves the hash compute on cache hit; the read still happens.
 *   - Executor verify passes `needBytes:true`. Same as source walk —
 *     verify-against-plan still needs the bytes to write.
 *
 * `cache` is optional so pure tests and the no-cache code paths keep
 * working without injection. When omitted this function degenerates to
 * stat → read → hash.
 *
 * The returned `mtime` lets a caller that already needed stat (e.g. an
 * executor that wants to know when the file was last touched) avoid a
 * second round-trip.
 */
export interface HashFileAtUriOptions {
  /**
   * When true, the bytes read from disk are returned alongside the sha256.
   * Used by the planner's source walk (validators need bytes) and the
   * executor (writes need bytes). The destination walk passes false and
   * gets the read-skip win on cache hit.
   */
  needBytes?: boolean;
  /**
   * Hash function used for newly-read bytes. Defaults to {@link sha256Hex}.
   * Exposed for test isolation — production code should leave this unset so
   * the cache values stay consistent with sha256Hex everywhere.
   */
  hash?: (bytes: Uint8Array) => Promise<string>;
  /**
   * Walk-scoped snapshot of the URI hash cache, consulted before {@link
   * cache}. Callers walking many files should call `cache.snapshot()` once
   * before the walk and thread the resulting map through every per-file
   * hash call. Snapshot hits avoid the IDB round-trip; `cache` is still
   * the per-file fallback on miss.
   */
  snapshot?: Map<string, HashCacheEntry>;
}

export async function hashFileAtUri<U extends { toString(): string }>(
  fs: SyncFs<U>,
  uri: U,
  cache?: UriHashCache<U>,
  opts?: HashFileAtUriOptions,
): Promise<{ sha256: string; size: number; mtime: number; bytes?: Uint8Array }> {
  const needBytes = opts?.needBytes ?? false;
  const hashFn = opts?.hash ?? sha256Hex;
  const stat = await fs.stat(uri);

  // Consult the snapshot first (sync Map.get with size/mtime validation),
  // then fall through to per-call cache.lookup() so a record() that landed
  // mid-walk from another caller is still observed. Either tier returns a
  // sha string on hit, undefined on miss.
  if (opts?.snapshot || cache) {
    const cached = await snapshotHashLookup(opts?.snapshot, cache, uri, stat.size, stat.mtime);
    if (cached !== undefined) {
      if (!needBytes) {
        return { sha256: cached, size: stat.size, mtime: stat.mtime };
      }
      const bytes = await fs.readFile(uri);
      return { sha256: cached, size: stat.size, mtime: stat.mtime, bytes };
    }
  }

  const bytes = await fs.readFile(uri);
  const sha256 = await hashFn(bytes);
  if (cache) {
    // Best-effort record — a backing-store failure (e.g. IDB quota) shouldn't
    // break the caller. The IDB-backed cache swallows its own failures; this
    // try is defence in depth for future adapters that might throw.
    try {
      await cache.record(uri, stat.size, stat.mtime, sha256);
    } catch {
      /* ignore */
    }
  }
  return {
    sha256,
    size: stat.size,
    mtime: stat.mtime,
    bytes: needBytes ? bytes : undefined,
  };
}
