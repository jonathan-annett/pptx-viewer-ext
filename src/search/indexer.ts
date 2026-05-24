// Wired indexer for the pptx search subsystem.
//
// Responsibilities:
//   1. Decide which workspace folders are in-scope (sources only — never
//      destinations). Recomputed whenever the topology changes.
//   2. Walk the in-scope folders for *.pptx files. For each file, compute
//      its sha256 via `hashFileAtUri` (URI hash cache friendly) and
//      either reuse a stored SearchProjection or build one fresh.
//   3. Keep the in-memory engine in sync. Removed files / out-of-scope
//      files drop out; created/changed files refresh.
//   4. React to FS events via a `**/*.pptx` workspace watcher so the
//      index stays live during the session.
//
// Layered cache strategy (matches the M5.3 architecture sketch):
//   sha → SearchProjection in indexStore  → cheapest hit (no parse)
//   sha → CachedParseResult in parseCache → cheap-ish (project from cache)
//   miss → parsePptxCached (which itself caches the parse for future runs)
//
// `parsePptxCached` hashes the bytes internally as its first phase. We
// accept the double-hash on miss to keep parsePptx untouched — same
// trade-off the parse cache itself made.
//
// This file is the *wired* half — it imports vscode. The pure helpers
// (scope computation, projection building, the engine itself) live in
// sibling modules and are exercised by tsx tests.

import * as vscode from 'vscode';
import type { FileInfo } from '../pptx';
import { hashFileAtUri } from '../sync/hash';
import {
  getHashCacheSingleton,
  type UriHashCache,
} from '../sync/hashCache';
import {
  getParseCacheSingleton,
  parsePptxCached,
  type ParseResultCache,
} from '../sync/parseCache';
import type { SyncManager } from '../sync/manager';
import type { ResolvedTopology } from '../sync/topology';
import { vscodeFs } from '../sync/vscodeFs';
import { log } from '../log';
import { fold } from './fold';
import type { SearchProjection } from './index-types';
import type { SearchIndexStore } from './indexStore';
import {
  basenameOf,
  projectFromCached,
  projectFromParseResult,
} from './projection';
import { tokenize } from './tokenize';
import {
  computeSearchScope,
  isUnderScope,
  urisLeavingScope,
  type SearchScope,
} from './scope';
import type { SearchEngine } from './searchEngine';

/**
 * Per-event progress payload. M4 doesn't have a panel yet, so the
 * activation log is the only consumer — but the type is wired now so
 * M5's panel can subscribe without refactoring this module.
 */
export interface IndexerProgress {
  phase: 'walking' | 'projecting' | 'idle';
  done: number;
  total: number;
}

export interface IndexerStats {
  /** Distinct URIs ever processed since construction. */
  processed: number;
  /** Of those, how many used a hit from the indexStore (no parse needed). */
  indexStoreHits: number;
  /** Of those, how many used a parse-cache hit (no fresh parse). */
  parseCacheHits: number;
  /** Of those, how many required a fresh parse. */
  freshParses: number;
  /** Errors encountered (read failures, parse errors). */
  errors: number;
}

export interface SearchIndexerHandle extends vscode.Disposable {
  /** Resolves after the initial full pass completes (success or error). */
  ready(): Promise<void>;
  /** Trigger another full pass over the current scope. Coalesces with any
   *  in-flight pass — overlapping requests wait for the running pass to
   *  finish, then start a fresh one. */
  refresh(): Promise<void>;
  /** Subscribe to progress events. */
  onProgress(listener: (p: IndexerProgress) => void): vscode.Disposable;
  /** Snapshot diagnostics. */
  stats(): IndexerStats;
  /** Current scope, exposed so the panel can render the empty-state
   *  message in M6 ("No source folders to search…"). */
  getScope(): SearchScope;
}

export interface StartSearchIndexerOptions {
  engine: SearchEngine;
  /** Optional — when absent, indexer runs in pure in-memory mode
   *  (still useful for tests and degraded environments). */
  store?: SearchIndexStore;
  manager: SyncManager;
  /** Defaults to the global parse cache singleton; tests can inject. */
  parseCache?: ParseResultCache;
  /** Defaults to the global hash cache singleton. */
  hashCache?: UriHashCache<vscode.Uri>;
}

/**
 * Start the indexer. Subscribes to the manager's `onDidChange` event
 * (which fires once immediately, so the initial scope is captured
 * synchronously), kicks off the first full pass in the background,
 * and registers a recursive pptx FileSystemWatcher.
 *
 * Caller is responsible for adding the returned disposable to
 * `context.subscriptions`. The disposable tears down the watcher, the
 * manager subscription, and any in-flight pass's progress listeners.
 */
export function startSearchIndexer(
  opts: StartSearchIndexerOptions,
): SearchIndexerHandle {
  const fs = vscodeFs();
  const stats: IndexerStats = {
    processed: 0,
    indexStoreHits: 0,
    parseCacheHits: 0,
    freshParses: 0,
    errors: 0,
  };
  const progressListeners = new Set<(p: IndexerProgress) => void>();

  let scope: SearchScope = { folderUris: [] };
  let disposed = false;
  let inFlight: Promise<void> | undefined;
  let queued = false;
  let firstPassReady: Promise<void>;
  let resolveFirstPass: () => void = () => {};
  firstPassReady = new Promise<void>((res) => {
    resolveFirstPass = res;
  });
  let firstPassDone = false;

  const emitProgress = (p: IndexerProgress): void => {
    for (const fn of progressListeners) {
      try {
        fn(p);
      } catch (err) {
        log(
          `search-indexer: progress listener threw — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  };

  const finishFirstPass = (): void => {
    if (firstPassDone) return;
    firstPassDone = true;
    resolveFirstPass();
  };

  const updateScope = (topology: ResolvedTopology): void => {
    const workspaceFolderUris = (vscode.workspace.workspaceFolders ?? []).map(
      (f) => f.uri.toString(),
    );
    // Destination workspace-folder URIs: only those that resolved to a
    // currently-open folder count. Unresolved destinations (config refers
    // to a folder not in the workspace) don't exclude anything because
    // they aren't part of `workspaceFolderUris` to begin with.
    const destUris: string[] = [];
    for (const src of topology.sources) {
      for (const dest of src.destinations) {
        if (dest.workspaceFolderUri) destUris.push(dest.workspaceFolderUri.toString());
      }
    }
    const next = computeSearchScope({
      workspaceFolderUris,
      destinationWorkspaceFolderUris: destUris,
    });
    const prev = scope;
    scope = next;

    // Evict any tracked URIs that just fell out of scope (e.g. a workspace
    // folder was promoted to destination). The IDB record stays — the same
    // sha may still be valid in another scope or later if the user reverts
    // the topology — only the engine's URI mapping is dropped here.
    const evictions = urisLeavingScope(next, opts.engine.getAllUris());
    for (const uri of evictions) opts.engine.removeUri(uri);
    if (evictions.length > 0) {
      log(
        `search-indexer: scope changed — evicted ${evictions.length} URI(s) ` +
          `now outside any source folder`,
      );
    }

    const sameFolders =
      prev.folderUris.length === next.folderUris.length &&
      prev.folderUris.every((u, i) => u === next.folderUris[i]);
    if (!sameFolders) {
      log(
        `search-indexer: scope folders [${next.folderUris.join(', ') || '(none)'}]`,
      );
      // Topology may have added new source folders — kick a walk so their
      // existing files land in the index. Coalesced with any in-flight pass.
      void runFullPass();
    }
  };

  /**
   * Walk every in-scope folder, find *.pptx files, and process each.
   * Coalesces with overlapping requests — a second call while one is in
   * flight waits, then runs once more.
   */
  async function runFullPass(): Promise<void> {
    if (disposed) return;
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    inFlight = (async (): Promise<void> => {
      do {
        queued = false;
        await doFullPass();
      } while (queued && !disposed);
    })();
    try {
      await inFlight;
    } finally {
      inFlight = undefined;
      finishFirstPass();
    }
  }

  async function doFullPass(): Promise<void> {
    if (disposed) return;
    const folders = scope.folderUris;
    if (folders.length === 0) {
      emitProgress({ phase: 'idle', done: 0, total: 0 });
      log('search-indexer: no folders in scope — pass skipped');
      return;
    }

    emitProgress({ phase: 'walking', done: 0, total: 0 });
    const t0 = performance.now();

    // Use vscode.workspace.findFiles with a RelativePattern per folder so
    // the search is scoped exactly to the folders we want (not every
    // workspace folder). Per-folder calls also let us avoid leaking
    // results from destination folders.
    const allUris: vscode.Uri[] = [];
    for (const folderUriStr of folders) {
      if (disposed) return;
      const folderUri = vscode.Uri.parse(folderUriStr);
      const folder = (vscode.workspace.workspaceFolders ?? []).find(
        (f) => f.uri.toString() === folderUriStr,
      );
      if (!folder) continue;
      try {
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, '**/*.pptx'),
          // Use the global default exclude pattern (respects files.exclude
          // + search.exclude) — same as findFiles' standard behaviour.
        );
        allUris.push(...found);
      } catch (err) {
        log(
          `search-indexer: findFiles failed for ${folderUri.toString()} — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const total = allUris.length;
    log(`search-indexer: pass starting — ${total} pptx file(s) across ${folders.length} folder(s)`);

    // Sweep: any URIs the engine knows about that aren't in the found set
    // and that *should* be in scope must have been deleted on disk between
    // sessions. Drop them. (Out-of-scope URIs were handled by updateScope.)
    const foundSet = new Set(allUris.map((u) => u.toString()));
    const stale = opts.engine.getAllUris().filter((u) => isUnderScope(scope, u) && !foundSet.has(u));
    for (const u of stale) {
      await removeUri(u);
    }
    if (stale.length > 0) {
      log(`search-indexer: dropped ${stale.length} stale URI(s) from engine`);
    }

    let done = 0;
    for (const uri of allUris) {
      if (disposed) return;
      emitProgress({ phase: 'projecting', done, total });
      try {
        await processUri(uri);
      } catch (err) {
        stats.errors++;
        log(
          `search-indexer: process failed for ${uri.toString()} — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      done++;
    }

    const elapsed = Math.round(performance.now() - t0);
    log(
      `search-indexer: pass complete — processed=${stats.processed} ` +
        `(indexStore=${stats.indexStoreHits} parseCache=${stats.parseCacheHits} ` +
        `fresh=${stats.freshParses} errors=${stats.errors}) in ${elapsed}ms`,
    );
    emitProgress({ phase: 'idle', done: total, total });
  }

  /**
   * Walk the layered cache to obtain a projection for a single file and
   * upsert it into the engine + indexStore.
   *
   * Order of operations:
   *   1. hashFileAtUri(needBytes:false) — returns sha + stat. Reads bytes
   *      only if the URI hash cache misses.
   *   2. indexStore.getBySha(sha) — if hit, the projection is exactly
   *      what we need. Upsert engine, refresh metadata, done.
   *   3. parseCache.lookup(sha) — if hit, project from the cached parse
   *      payload (no unzip). Upsert engine + indexStore.
   *   4. Miss everywhere — read bytes (possibly already in hand if step 1
   *      had to read), call parsePptxCached (which will populate the
   *      parseCache for future runs), project, upsert.
   */
  async function processUri(uri: vscode.Uri): Promise<void> {
    const hashCache = opts.hashCache ?? (getHashCacheSingleton() as UriHashCache<vscode.Uri> | undefined);
    const parseCache = opts.parseCache ?? getParseCacheSingleton();

    // First read: stat + maybe-read for the hash. Source-walk style —
    // bytes returned only on cache miss, which is when we'll likely need
    // them anyway (parse). Hits skip the read.
    const hashed = await hashFileAtUri(fs, uri, hashCache, { needBytes: false });
    const sha = hashed.sha256;
    const info: FileInfo = {
      fileName: basenameOf(uri.toString()),
      size: hashed.size,
      mtime: hashed.mtime,
    };

    // Step 2: indexStore hit — no parse needed. Refresh URI-derived fields
    // (filename, tokens, size, mtime) in case the file was moved to a new
    // basename since the projection was first written; the content-derived
    // fields (author, slideText) are unchanged because the sha is unchanged.
    if (opts.store) {
      const cached = await opts.store.getBySha(sha);
      if (cached) {
        const refreshed: SearchProjection = {
          ...cached,
          filename: fold(info.fileName),
          filenameTokens: tokenize(info.fileName),
          sizeBytes: info.size,
          mtime: info.mtime,
        };
        opts.engine.addOrUpdate(uri.toString(), refreshed);
        // Mirror the refresh into IDB so future cold-loads see the
        // up-to-date filename. Idempotent for same-name + same-stat.
        await opts.store.putProjection(refreshed);
        stats.processed++;
        stats.indexStoreHits++;
        return;
      }
    }

    // Step 3: parse cache hit — project from the cached payload.
    if (parseCache) {
      const cachedParse = await parseCache.lookup(sha);
      if (cachedParse) {
        const projection = projectFromCached(cachedParse, info);
        opts.engine.addOrUpdate(uri.toString(), projection);
        if (opts.store) await opts.store.putProjection(projection);
        stats.processed++;
        stats.parseCacheHits++;
        return;
      }
    }

    // Step 4: fresh parse. Read bytes (skipped at step 1) and feed
    // parsePptxCached so the parse-cache learns about this sha too.
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(uri);
    } catch (err) {
      stats.errors++;
      log(
        `search-indexer: read failed for ${uri.toString()} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    const { result } = await parsePptxCached(bytes, info, parseCache);
    if (result.parseError) {
      // A broken pptx still gets a projection (filename + author are
      // valid even when slide parsing fails). The plan's "defensive
      // parsing" convention applies here too.
      log(
        `search-indexer: parse warning for ${uri.toString()} — ${result.parseError}`,
      );
    }
    const projection = projectFromParseResult(result);
    opts.engine.addOrUpdate(uri.toString(), projection);
    if (opts.store) await opts.store.putProjection(projection);
    stats.processed++;
    stats.freshParses++;
  }

  /**
   * Drop a URI from the engine and mirror to the indexStore if that
   * was the last URI for the sha. The engine handles the projection
   * eviction internally; we mirror to IDB after the fact.
   */
  async function removeUri(uriStr: string): Promise<void> {
    const sha = opts.engine.getShaForUri(uriStr);
    opts.engine.removeUri(uriStr);
    if (sha && opts.store) {
      // Engine drops the sha→projection map when the last URI goes away.
      // Mirror that into IDB so a future warm-load doesn't resurrect a
      // projection nothing points at.
      if (!opts.engine.getProjection(sha)) {
        await opts.store.deleteBySha(sha);
      }
    }
  }

  // ───── activation: subscribe to topology + start first pass ─────────────
  //
  // `manager.onDidChange` fires the listener once immediately with the
  // current topology, so `updateScope` runs synchronously before we register
  // the watcher. The first full pass kicks off as a result of that initial
  // updateScope call (scope.folderUris becomes non-empty → runFullPass).

  const managerSub = opts.manager.onDidChange((topology) => {
    if (disposed) return;
    updateScope(topology);
  });

  // FileSystemWatcher fires for every workspace folder, not just sources.
  // We filter inside the handlers via `isUnderScope`.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.pptx');
  const onCreate = watcher.onDidCreate((uri) => {
    if (disposed) return;
    if (!isUnderScope(scope, uri.toString())) return;
    void processUri(uri).catch((err) => {
      stats.errors++;
      log(
        `search-indexer: onDidCreate ${uri.toString()} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });
  const onChange = watcher.onDidChange((uri) => {
    if (disposed) return;
    if (!isUnderScope(scope, uri.toString())) return;
    void processUri(uri).catch((err) => {
      stats.errors++;
      log(
        `search-indexer: onDidChange ${uri.toString()} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });
  const onDelete = watcher.onDidDelete((uri) => {
    if (disposed) return;
    void removeUri(uri.toString()).catch((err) => {
      log(
        `search-indexer: onDidDelete ${uri.toString()} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });

  // If the initial onDidChange already kicked a pass off, runFullPass is
  // either running or queued — we just await it. If scope was empty (no
  // workspace folders), no pass was queued and firstPassReady resolves
  // immediately via finishFirstPass at the end of the (empty) walk.
  if (!inFlight) {
    // Empty initial scope path — finish the first-pass promise so callers
    // awaiting `ready()` don't block forever.
    finishFirstPass();
  }

  return {
    async ready() {
      await firstPassReady;
    },
    async refresh() {
      await runFullPass();
    },
    onProgress(listener) {
      progressListeners.add(listener);
      return new vscode.Disposable(() => progressListeners.delete(listener));
    },
    stats() {
      return { ...stats };
    },
    getScope() {
      return { folderUris: [...scope.folderUris] };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      managerSub.dispose();
      onCreate.dispose();
      onChange.dispose();
      onDelete.dispose();
      watcher.dispose();
      progressListeners.clear();
    },
  };
}

