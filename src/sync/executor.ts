// Pure executor for the green-path operations: create, update-tracked,
// delete-tracked. All FS work goes through an injected `SyncFs<U>` interface
// so this module has no vscode import — the unit tests pass a fake fs with
// string URIs (see test/sync-executor.test.ts). The vscode-wired
// orchestrator that plugs `vscode.workspace.fs` into the same interface
// lives in runSync.ts.
//
// Three contracts that keep this module honest:
//
//  1. Atomic writes: every byte placement is `writeFile(<path>.tmp)` then
//     `rename(<path>.tmp, <path>)`. The destination never contains a
//     partially-written file at the final path. Tmp orphans from interrupted
//     runs are M6's problem (destination reverse pass).
//
//  2. Per-file error isolation: a failed op never aborts the run; it lands
//     in `results` with status='failed' and a message, and the rest of the
//     list keeps going. The manifest is mutated only on success — so on
//     re-run, the plan engine will see the same item as still pending.
//
//  3. Source-change detection: between plan and execute the source file may
//     have shifted. We re-hash what we read and fail the op if it doesn't
//     match the plan's sourceHash. Per plan: "v1 doesn't lock or re-plan;
//     the user reruns."

import type { Manifest } from './manifest-types';
import { manifestKey } from './manifest-types';
import type { OpKind, PlanItem } from './plan';
import { hasBlockingWarning, hasOverridableWarningOnly } from './plan';
import { hashFileAtUri } from './hash';
import type { UriHashCache } from './hashCache';

// The `SyncFs<U>` contract now lives in the host seam (`./host/fs`), extended
// with `readDirectory` + `FileType`. Re-exported here so existing importers
// (`vscodeFs`, `hash`, tests) keep their import path.
import type { SyncFs } from './host/fs';
export type { SyncFs } from './host/fs';

export interface ExecuteOptions<U> {
  /** Identifier embedded in manifest keys for this source. */
  sourceWorkspaceFolderName: string;
  sourceRootUri: U;
  destRootUri: U;
  /** Destination subpath under the workspace-folder root; stored in manifest.destPath. */
  destSubpath: string;
  items: readonly PlanItem[];
  /** Mutated in place — caller persists after this returns. */
  manifest: Manifest;
  fs: SyncFs<U>;
  /** Per-bytes hash. In production: sha256Hex via crypto.subtle. */
  hash: (bytes: Uint8Array) => Promise<string>;
  /** ISO-8601 timestamp factory; injected so tests get deterministic output. */
  now?: () => string;
  /**
   * Per-relPath user decisions for the orange path. Items in `overwrite` are
   * `update-collision` rows the user armed for execution this run; items in
   * `deleteDestOnly` are `destination-only` rows the user armed for deletion.
   * The executor treats armed collisions exactly like update-tracked writes
   * (with one wrinkle: the manifest may not have an entry, so the destination
   * hash isn't checked against it) and armed destination-only deletes like
   * delete-tracked.
   *
   * Both default empty — when M5 Phase C isn't relevant (workspace-wide
   * Proceed with no blocks) the runner just doesn't pass them.
   */
  decidedOverwrites?: ReadonlySet<string>;
  decidedDeletes?: ReadonlySet<string>;
  /**
   * Per-relPath "Sync anyway" decisions for rows whose only warnings are
   * 'override' severity (e.g. pptx media-controls + embedded video). When a
   * green-path item (create / update-tracked) has override-severity warnings
   * and its rel-path is in this set, the executor ships it; otherwise it
   * skips. 'block'-severity warnings ignore this set — they never ship.
   *
   * Decoupled from `decidedOverwrites` because the two arm different kinds
   * of risk (collision = destination state divergence; warning = file
   * quality concern). On an `update-collision` row that also carries
   * override warnings, the overwrite arming implicitly covers the warning —
   * the user agreeing to overwrite is taken as agreement on both — so this
   * set is consulted only for non-collision rows.
   */
  decidedWarningOverrides?: ReadonlySet<string>;
  /**
   * Optional URI hash cache (M5.2.5). When supplied, the per-file source
   * read goes through `hashFileAtUri` so a previously-hashed source skips
   * the sha256 compute — the read still happens because we need the bytes
   * to write. Successful writes also record the freshly-placed destination
   * bytes in the cache so the next plan-build's destination walk hits.
   */
  cache?: UriHashCache<U>;
  /**
   * Per-operation progress callback. Fires after each dispatched item
   * completes (both `ok` and `failed` outcomes). Skipped items (those
   * filtered by {@link resolveDispatch}) never fire.
   *
   * The runSync orchestrator wraps this to add a running `done` counter
   * + total across all plans, so the UI can render a true progress bar.
   * Pure callers (tests) can leave it undefined.
   */
  onProgress?: (event: ExecuteProgressEvent) => void;
}

export interface ExecuteProgressEvent {
  /** The operation kind that was dispatched (mirrors OperationResult). */
  kind: OperationResult['kind'];
  /** Destination-relative path of the item just processed. */
  relPath: string;
  /** Whether the op succeeded or failed. */
  status: 'ok' | 'failed';
}

/**
 * Predicate counterpart of {@link resolveDispatch}: would the executor
 * actually dispatch an op for this item, given these decisions? Exposed
 * so the orchestrator can pre-compute a total *executable item count*
 * before the run, without duplicating the dispatch logic.
 */
export type DispatchOptions = Pick<
  ExecuteOptions<unknown>,
  'decidedOverwrites' | 'decidedDeletes' | 'decidedWarningOverrides'
>;

export function countExecutableItems(
  items: readonly PlanItem[],
  opts: DispatchOptions = {},
): number {
  let n = 0;
  for (const item of items) {
    if (resolveDispatchPredicate(item, opts)) n++;
  }
  return n;
}

export interface OperationResult {
  relPath: string;
  /**
   * The op that was attempted. 'skip' never lands here (filtered out). The
   * two collision-derived ops mirror the green-path equivalents: an armed
   * `update-collision` executes as `update-collision` so the summary can
   * distinguish overrides from clean updates without losing the row's
   * provenance.
   */
  kind: Extract<
    OpKind,
    | 'create'
    | 'update-tracked'
    | 'delete-tracked'
    | 'update-collision'
    | 'destination-only'
  >;
  status: 'ok' | 'failed';
  /** Present iff status='failed'. */
  error?: string;
}

export interface ExecuteResult {
  results: OperationResult[];
  /** Convenience counters; derivable from `results` but handy for the summary. */
  counts: {
    create: { ok: number; failed: number };
    updateTracked: { ok: number; failed: number };
    deleteTracked: { ok: number; failed: number };
    updateCollision: { ok: number; failed: number };
    destinationOnly: { ok: number; failed: number };
  };
}

const GREEN_KINDS: ReadonlySet<OpKind> = new Set<OpKind>([
  'create',
  'update-tracked',
  'delete-tracked',
]);

const TMP_SUFFIX = '.tmp';

/**
 * Execute the green-path subset of a plan against a single (source × destination)
 * pair. Returns per-op results; mutates `opts.manifest` in place on each success.
 * Caller persists the manifest once (or per pair) after this returns.
 */
export async function executePlan<U extends { toString(): string }>(
  opts: ExecuteOptions<U>,
): Promise<ExecuteResult> {
  const now = opts.now ?? defaultNow;
  const results: OperationResult[] = [];
  const counts = freshCounts();

  for (const item of opts.items) {
    const dispatch = resolveDispatch(item, opts);
    if (!dispatch) continue;
    const kind = dispatch;

    try {
      if (kind === 'delete-tracked' || kind === 'destination-only') {
        await executeDelete(opts, item);
      } else {
        await executeWrite(opts, item, kind, now);
      }
      results.push({ relPath: item.relPath, kind, status: 'ok' });
      bump(counts, kind, 'ok');
      opts.onProgress?.({ kind, relPath: item.relPath, status: 'ok' });
    } catch (err) {
      const message = errMsg(err);
      results.push({ relPath: item.relPath, kind, status: 'failed', error: message });
      bump(counts, kind, 'failed');
      opts.onProgress?.({ kind, relPath: item.relPath, status: 'failed' });
    }
  }

  return { results, counts };
}

/**
 * Decide whether and how to act on a plan item. Returns the operation kind to
 * record in results, or `undefined` to skip.
 *
 * Decision matrix per category:
 *
 *  1. Any 'block'-severity warning → always skip. No override exists; the
 *     user must fix the source file and re-plan. Trumps every arming flag.
 *
 *  2. Green-path kinds (create / update-tracked / delete-tracked):
 *     - No warnings → execute.
 *     - 'override'-severity warnings only → execute iff
 *       decidedWarningOverrides has the rel-path.
 *
 *  3. `update-collision` kind:
 *     - Requires decidedOverwrites arming.
 *     - Override-severity warnings on the same row are implicitly covered
 *       by the overwrite arming — the user agreeing to overwrite the
 *       destination is taken as agreement on the warning too.
 *
 *  4. `destination-only` kind:
 *     - Requires decidedDeletes arming. These rows never carry warnings
 *       (no source bytes to validate), so the warning matrix doesn't apply.
 *
 * Items in `skip` kind are filtered by the planner before the executor sees
 * them, so they never reach this function.
 */
function resolveDispatch<U>(
  item: PlanItem,
  opts: ExecuteOptions<U>,
): OperationResult['kind'] | undefined {
  return resolveDispatchPredicate(item, opts);
}

/**
 * The minimal dispatch decision — same matrix as {@link resolveDispatch} but
 * takes only the decision Sets. Shared with {@link countExecutableItems} so
 * a "would this dispatch?" pre-pass uses the exact same logic the executor
 * will use at run time.
 */
function resolveDispatchPredicate(
  item: PlanItem,
  opts: DispatchOptions,
): OperationResult['kind'] | undefined {
  if (hasBlockingWarning(item)) return undefined;

  if (GREEN_KINDS.has(item.kind)) {
    if (hasOverridableWarningOnly(item)) {
      if (!opts.decidedWarningOverrides?.has(item.relPath)) return undefined;
    }
    return item.kind as OperationResult['kind'];
  }
  if (item.kind === 'update-collision' && opts.decidedOverwrites?.has(item.relPath)) {
    // Note: no separate warning-override arming required — overwrite covers
    // the row's override warnings. `hasBlockingWarning` above already
    // filtered out collisions with block-severity warnings.
    return 'update-collision';
  }
  if (item.kind === 'destination-only' && opts.decidedDeletes?.has(item.relPath)) {
    return 'destination-only';
  }
  return undefined;
}

// ───── per-op handlers ───────────────────────────────────────────────────

async function executeWrite<U extends { toString(): string }>(
  opts: ExecuteOptions<U>,
  item: PlanItem,
  kind: 'create' | 'update-tracked' | 'update-collision',
  now: () => string,
): Promise<void> {
  const { fs, sourceRootUri, destRootUri } = opts;
  // Under `path-aliases` (M2 of room-sync-format-v1-plan.md) `item.relPath`
  // is the destination-relative path post-rewrite. The on-disk source file
  // lives at the pre-rewrite path carried on `aliasOrigin`. When no alias
  // rewrote this row, `aliasOrigin` is absent and both paths coincide.
  const sourceRelPath = item.aliasOrigin?.sourceRelPath ?? item.relPath;
  const sourceUri = fs.joinPath(sourceRootUri, sourceRelPath);
  const destUri = fs.joinPath(destRootUri, item.relPath);
  const tmpUri = fs.joinPath(destRootUri, item.relPath + TMP_SUFFIX);

  // hashFileAtUri short-circuits the sha256 compute on cache hit (the read
  // is unavoidable — we need the bytes to write). When no cache is supplied
  // it falls back to stat → read → opts.hash, matching the pre-M5.2.5 path
  // modulo an extra stat call.
  const result = await hashFileAtUri(fs, sourceUri, opts.cache, {
    needBytes: true,
    hash: opts.hash,
  });
  const bytes = result.bytes!;
  const actualHash = result.sha256;

  // Source-change detection: the file we just read isn't the file the plan
  // saw. The plan's hash is the source of truth for "what the user agreed
  // to". Refuse to silently sync different bytes.
  if (item.sourceHash && actualHash !== item.sourceHash) {
    throw new Error(
      `source changed between plan and execute (plan hash ${item.sourceHash.slice(0, 8)}, ` +
        `now ${actualHash.slice(0, 8)})`,
    );
  }

  await fs.writeFile(tmpUri, bytes);

  try {
    await fs.rename(tmpUri, destUri);
  } catch (err) {
    // Best-effort cleanup: leave no .tmp behind on failure. Swallow cleanup
    // errors — the original rename failure is the one to surface.
    try { await fs.delete(tmpUri); } catch { /* ignore */ }
    throw err;
  }

  // Record the freshly-placed destination bytes so the next plan build's
  // destination walk hits the cache. We re-stat to capture whatever mtime
  // the filesystem stamped on the rename; the stat is the only viable key
  // material. Best-effort — a stat failure here doesn't unwind the write.
  if (opts.cache) {
    try {
      const destStat = await fs.stat(destUri);
      await opts.cache.record(destUri, destStat.size, destStat.mtime, actualHash);
    } catch {
      /* ignore */
    }
  }

  // Manifest entry records what's actually on disk (the hash we just placed),
  // plus the destination-relative path. Subpath is stored alongside relPath so
  // a manifest entry stays meaningful even when looking at the destination
  // workspace folder in isolation.
  const key = manifestKey(opts.sourceWorkspaceFolderName, item.relPath);
  opts.manifest.entries[key] = {
    destPath: opts.destSubpath
      ? `${opts.destSubpath}/${item.relPath}`
      : item.relPath,
    size: bytes.byteLength,
    sha256: actualHash,
    syncedAt: now(),
  };
  opts.manifest.lastSync = now();
  // Mark `kind` consumed; the value is captured in results.
  void kind;
}

async function executeDelete<U extends { toString(): string }>(
  opts: ExecuteOptions<U>,
  item: PlanItem,
): Promise<void> {
  const destUri = opts.fs.joinPath(opts.destRootUri, item.relPath);
  try {
    await opts.fs.delete(destUri);
  } catch (err) {
    // If the file was already gone, the desired end state is achieved —
    // treat as success and prune the manifest entry. Any other failure
    // propagates out.
    if (!isFileNotFound(err)) throw err;
  }
  // Drop the cache entry for the now-deleted destination URI — best-effort.
  if (opts.cache) {
    try { await opts.cache.forget(destUri); } catch { /* ignore */ }
  }
  const key = manifestKey(opts.sourceWorkspaceFolderName, item.relPath);
  delete opts.manifest.entries[key];
  opts.manifest.lastSync = (opts.now ?? defaultNow)();
}

// ───── helpers ───────────────────────────────────────────────────────────

function freshCounts(): ExecuteResult['counts'] {
  return {
    create: { ok: 0, failed: 0 },
    updateTracked: { ok: 0, failed: 0 },
    deleteTracked: { ok: 0, failed: 0 },
    updateCollision: { ok: 0, failed: 0 },
    destinationOnly: { ok: 0, failed: 0 },
  };
}

function bump(
  counts: ExecuteResult['counts'],
  kind: OperationResult['kind'],
  outcome: 'ok' | 'failed',
): void {
  if (kind === 'create') counts.create[outcome]++;
  else if (kind === 'update-tracked') counts.updateTracked[outcome]++;
  else if (kind === 'delete-tracked') counts.deleteTracked[outcome]++;
  else if (kind === 'update-collision') counts.updateCollision[outcome]++;
  else counts.destinationOnly[outcome]++;
}

function isFileNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'FileNotFound';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultNow(): string {
  return new Date().toISOString();
}
