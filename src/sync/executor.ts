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

/** Abstract FS contract — production wires vscode.workspace.fs, tests fake. */
export interface SyncFs<U> {
  /** Resolve a relative path under a root URI. Implementation owns URI shape. */
  joinPath(root: U, relPath: string): U;
  readFile(uri: U): Promise<Uint8Array>;
  writeFile(uri: U, bytes: Uint8Array): Promise<void>;
  rename(src: U, dst: U): Promise<void>;
  /** Throw a FileSystemError-shaped object (.code='FileNotFound') for missing. */
  delete(uri: U): Promise<void>;
}

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
export async function executePlan<U>(opts: ExecuteOptions<U>): Promise<ExecuteResult> {
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
    } catch (err) {
      const message = errMsg(err);
      results.push({ relPath: item.relPath, kind, status: 'failed', error: message });
      bump(counts, kind, 'failed');
    }
  }

  return { results, counts };
}

/**
 * Decide whether and how to act on a plan item. Returns the operation kind to
 * record in results, or `undefined` to skip. Green-path items pass through;
 * orange-path items (`update-collision`, `destination-only`) only act when
 * the caller explicitly armed them via `decidedOverwrites` / `decidedDeletes`.
 *
 * M5 Phase D: items carrying validator warnings are blocked unconditionally —
 * the plan webview shows them with a ⚠ badge and flips the footer to orange,
 * and the orange "Proceed with safe items only" button means exactly that.
 * There is no per-row override for warnings (the user must fix the file and
 * re-plan), so an armed overwrite on a warned collision still skips here.
 * `delete-tracked` and `destination-only` items never carry warnings (no
 * source bytes to validate), so this filter only affects `create`,
 * `update-tracked`, and armed `update-collision` items in practice.
 */
function resolveDispatch<U>(
  item: PlanItem,
  opts: ExecuteOptions<U>,
): OperationResult['kind'] | undefined {
  if (item.warnings && item.warnings.length > 0) return undefined;
  if (GREEN_KINDS.has(item.kind)) return item.kind as OperationResult['kind'];
  if (item.kind === 'update-collision' && opts.decidedOverwrites?.has(item.relPath)) {
    return 'update-collision';
  }
  if (item.kind === 'destination-only' && opts.decidedDeletes?.has(item.relPath)) {
    return 'destination-only';
  }
  return undefined;
}

// ───── per-op handlers ───────────────────────────────────────────────────

async function executeWrite<U>(
  opts: ExecuteOptions<U>,
  item: PlanItem,
  kind: 'create' | 'update-tracked' | 'update-collision',
  now: () => string,
): Promise<void> {
  const { fs, sourceRootUri, destRootUri } = opts;
  const sourceUri = fs.joinPath(sourceRootUri, item.relPath);
  const destUri = fs.joinPath(destRootUri, item.relPath);
  const tmpUri = fs.joinPath(destRootUri, item.relPath + TMP_SUFFIX);

  const bytes = await fs.readFile(sourceUri);
  const actualHash = await opts.hash(bytes);

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

async function executeDelete<U>(
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
