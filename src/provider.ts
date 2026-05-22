// Custom read-only editor for *.pptx files.
//
// Flow:
//   openCustomDocument  -> return a thin wrapper around the URI
//   resolveCustomEditor -> read bytes via vscode.workspace.fs, parse, render
//
// Beyond the initial render, the viewer is also an active surface:
//   - Save As… (existing) — extension-side file dialog + writeFile
//   - Update… (M4.7 D-adj) — user-picked replacement; the extension parses,
//     hashes, compares to current sha256, writes when different
//   - Drag-and-drop ingest (M4.7 D-adj) — same path but with a compare modal
//     because the user did not pick the file from a dialog
//   - Sync target section (M4.7 D) — when the file lives under a .sync.jsonc
//     covered folder or is recognised as a destination, embed a scoped
//     dry-run plan with attribution

import * as vscode from 'vscode';
import { unzipSync } from 'fflate';
import { type ParseResult, type ParseTimings } from './pptx';
import { getParseCacheSingleton, parsePptxCached } from './sync/parseCache';
import { renderHtml, renderError, type RenderOptions } from './webview';
import { log } from './log';
import type { SyncManager } from './sync/manager';
import {
  classifyPreviewContext,
  type PreviewContext,
  type PreviewInput,
  type PreviewSource,
  type PreviewWorkspaceFolder,
} from './sync/previewContext';
import { buildScopedDryRunPlan, type PlanForDestination } from './sync/planner';
import { renderPlanPairs, toViewModel } from './sync/planHtml';
import { readManifest } from './sync/manifest';
import { renderCompareModalHtml, renderIdenticalModalHtml } from './sync/compareModalHtml';
import { runSync, formatRunSummary } from './sync/runSync';
import {
  countAccepted,
  handleDecisionMessage,
  seedRememberedDecisions,
  type RowDecision,
} from './sync/decisions';

class PptxDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {
    // no resources held
  }
}

export class PptxEditorProvider implements vscode.CustomReadonlyEditorProvider<PptxDocument> {
  public static readonly viewType = 'pptxViewer.viewer';

  constructor(
    private readonly manager: SyncManager,
    private readonly globalState: vscode.Memento,
  ) {}

  public static register(
    manager: SyncManager,
    globalState: vscode.Memento,
  ): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      PptxEditorProvider.viewType,
      new PptxEditorProvider(manager, globalState),
      {
        webviewOptions: { retainContextWhenHidden: false },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  async openCustomDocument(uri: vscode.Uri): Promise<PptxDocument> {
    return new PptxDocument(uri);
  }

  async resolveCustomEditor(
    document: PptxDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };

    const fileName = document.uri.path.split('/').pop() ?? 'unknown.pptx';
    log(`open: ${document.uri.toString()}`);

    // Single-slot candidate cache for the ingest → confirm-update flow. The
    // drop path posts bytes once, waits for the user to click Update inside
    // the compare modal, and we re-use the same bytes from memory rather
    // than asking the webview to send them twice. Cleared on confirm, cancel,
    // or panel dispose.
    let pendingCandidate: { fileName: string; bytes: Uint8Array; sha256: string } | null = null;

    // Currently-rendered ParseResult — kept so the ingest path can compare
    // sha256 without re-reading and re-parsing the file on disk.
    let currentResult: ParseResult | null = null;

    // Per-render scoped-plan stash. The Sync target section's Run Sync button
    // dispatches `run-sync` and we feed these plans straight into runSync().
    // Reset on every render so a button that survives in a stale tab can't
    // operate on out-of-date plans.
    let lastPerFilePlans: PlanForDestination[] = [];
    let lastPerFileBlocking = 0;
    let lastPerFileHasWork = false;
    let syncInFlight = false;
    // M5.1: per-row decisions for the embedded scoped plan. Reset on each
    // render alongside `lastPerFilePlans` — IDs are positional and the plan
    // is recomputed on every render (drop, save-as, topology change).
    let lastPerFileDecisions = new Map<string, RowDecision>();

    const renderWithSyncTarget = async (
      result: ParseResult,
      initialStatus?: string,
    ): Promise<void> => {
      const syncTarget = await buildSyncTargetHtml(this.manager, document.uri);
      lastPerFilePlans = syncTarget?.plans ?? [];
      lastPerFileBlocking = syncTarget?.blocking ?? 0;
      lastPerFileHasWork = syncTarget?.hasWork ?? false;
      // The webview HTML is rebuilt on every render, so any decisions the
      // user armed before are gone from the DOM. Reset the stash to match —
      // remembered rows will come back pre-checked via the renderer.
      // Seed the map from the plan's `remembered.accepted` items so the
      // extension's view of armed decisions matches the rendered DOM (pre-
      // checked checkboxes don't fire change events on load).
      lastPerFileDecisions = new Map();
      const seeded = seedRememberedDecisions(lastPerFilePlans, lastPerFileDecisions);
      if (seeded > 0) {
        log(`viewer[${fileName}]: seeded ${seeded} remembered decision(s) from plan`);
      }
      const opts: RenderOptions = { syncTargetHtml: syncTarget?.html ?? null };
      if (initialStatus !== undefined) opts.initialStatus = initialStatus;
      webviewPanel.webview.html = renderHtml(result, makeNonce(), opts);
      currentResult = result;
    };

    webviewPanel.onDidDispose(() => {
      pendingCandidate = null;
    });

    webviewPanel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as {
        type?: unknown;
        message?: unknown;
        source?: unknown;
        fileName?: unknown;
        bytes?: unknown;
      };

      if (m.type === 'viewer-log' && typeof m.message === 'string') {
        log(`viewer[${fileName}]: ${m.message}`);
        return;
      }

      if (m.type === 'decision') {
        handleDecisionMessage(msg, lastPerFileDecisions, (line) =>
          log(`viewer[${fileName}]: ${line}`),
        );
        return;
      }

      if (m.type === 'save-as') {
        await handleSaveAs(document, webviewPanel, fileName);
        return;
      }

      if (m.type === 'extractMedia') {
        await handleExtractMedia(msg, document, webviewPanel, fileName);
        return;
      }

      if (m.type === 'ingest') {
        await handleIngest(
          m,
          document,
          webviewPanel,
          currentResult,
          (candidate) => {
            pendingCandidate = candidate;
          },
          renderWithSyncTarget,
          this.globalState.get<boolean>('pptxViewer.autoSyncAfterDrop', false),
        );
        return;
      }

      if (m.type === 'confirm-update') {
        if (!pendingCandidate) {
          log(`update[${fileName}]: confirm-update with no pending candidate`);
          return;
        }
        const candidate = pendingCandidate;
        pendingCandidate = null;
        // The webview sends the checkbox state along; persist it so the next
        // drop's modal opens with the same default. Cancel takes the other
        // branch and does NOT touch the stored default.
        const autoSync = (msg as { autoSync?: unknown }).autoSync === true;
        await this.globalState.update('pptxViewer.autoSyncAfterDrop', autoSync);
        await handleConfirmUpdate(document, webviewPanel, candidate, renderWithSyncTarget);
        if (autoSync && lastPerFileHasWork && lastPerFileBlocking === 0 && !syncInFlight) {
          syncInFlight = true;
          webviewPanel.webview.postMessage({ type: 'sync-status', status: 'running' });
          try {
            await runPerFileSync(
              webviewPanel,
              fileName,
              lastPerFilePlans,
              lastPerFileDecisions,
              currentResult,
              renderWithSyncTarget,
            );
          } finally {
            syncInFlight = false;
          }
        }
        return;
      }

      if (m.type === 'cancel-update') {
        if (pendingCandidate) {
          log(`update[${fileName}]: cancelled (candidate ${pendingCandidate.fileName} discarded)`);
        }
        pendingCandidate = null;
        return;
      }

      if (m.type === 'run-sync') {
        // Per-file Run Sync — same machinery as the admin editor's, but with
        // a plan list filtered to a single file by buildScopedDryRunPlan's
        // pathFilter+pathFilterIsFile options.
        //
        // M5.1: orange Run Sync (safe items only) posts the same message;
        // the difference is what's in `lastPerFileDecisions`. The executor
        // honours whatever's armed; un-armed collisions, blocked warnings,
        // and destination-only files skip naturally. So we only gate on the
        // truly no-op case (no work AND no armed decisions). Mirrors the
        // admin/config editor's runSync handler.
        if (syncInFlight) return;
        if (!lastPerFileHasWork && countAccepted(lastPerFileDecisions) === 0) {
          log(`viewer[${fileName}]: run-sync ignored — nothing to do`);
          // Defensive: the webview has locked its buttons into "Syncing…"
          // on click. Post a terminal status so it unlocks even though we
          // never started execution. Without this the orange button stays
          // pinned in its locked label forever.
          webviewPanel.webview.postMessage({
            type: 'sync-status',
            status: 'done',
            ok: 0,
            failed: 0,
          });
          return;
        }
        syncInFlight = true;
        webviewPanel.webview.postMessage({ type: 'sync-status', status: 'running' });
        try {
          await runPerFileSync(
            webviewPanel,
            fileName,
            lastPerFilePlans,
            lastPerFileDecisions,
            currentResult,
            renderWithSyncTarget,
          );
        } finally {
          syncInFlight = false;
        }
        return;
      }
    });

    try {
      // Time the raw VS Code FS read separately from the parse — useful for
      // sizing the parse-cache work (large decks read over the FS provider
      // can dominate the wall-clock the user feels).
      const tReadStart = performance.now();
      const [bytes, stat] = await Promise.all([
        vscode.workspace.fs.readFile(document.uri),
        vscode.workspace.fs.stat(document.uri),
      ]);
      const readMs = performance.now() - tReadStart;
      const { result, cacheHit } = await parsePptxCached(
        bytes,
        { fileName, size: stat.size, mtime: stat.mtime },
        getParseCacheSingleton(),
      );
      const warnCount = [
        result.flags.linkedMedia.ok,
        result.flags.showType.ok,
        result.flags.showMediaControls.ok,
      ].filter((ok) => !ok).length;
      const thumbDesc = result.thumbnail
        ? `${result.thumbnail.mime} ${result.thumbnail.dataUrl.length} chars`
        : 'none';
      log(
        `parsed: ${fileName} — ${result.size} bytes, ${result.slideCount} slides ` +
          `(${result.hiddenSlideCount} hidden), ${warnCount} warning(s), ` +
          `thumbnail: ${thumbDesc}` +
          (result.parseError ? `, parseError: ${result.parseError}` : '') +
          (cacheHit ? ' (cached)' : ''),
      );
      if (result.timings) logParseTimings(fileName, '', result.timings, readMs);
      await renderWithSyncTarget(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`ERROR opening ${fileName}: ${message}`);
      webviewPanel.webview.html = renderError(document.uri.path, message);
    }
  }
}

// ───── save-as ──────────────────────────────────────────────────────────

async function handleSaveAs(
  document: PptxDocument,
  webviewPanel: vscode.WebviewPanel,
  fileName: string,
): Promise<void> {
  try {
    const target = await vscode.window.showSaveDialog({
      defaultUri: document.uri,
      saveLabel: 'Save',
      filters: { 'PowerPoint': ['pptx'] },
    });
    if (!target) {
      log(`save: ${fileName} cancelled`);
      webviewPanel.webview.postMessage({ type: 'save-as-result', status: 'cancelled' });
      return;
    }
    const fresh = await vscode.workspace.fs.readFile(document.uri);
    await vscode.workspace.fs.writeFile(target, fresh);
    log(`save: ${fileName} → ${target.toString()} (${fresh.byteLength} bytes)`);
    webviewPanel.webview.postMessage({
      type: 'save-as-result',
      status: 'ok',
      target: target.toString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`save ERROR ${fileName}: ${message}`);
    webviewPanel.webview.postMessage({ type: 'save-as-result', status: 'error', message });
  }
}

// ───── extract media ────────────────────────────────────────────────────

/**
 * Pull a specific entry out of the .pptx zip and write it to a user-chosen
 * location. Same pattern as Save As… (extension-side save dialog rather than
 * an anchor download in the webview) because vscode.dev's web-webview iframe
 * silently drops anchor-driven downloads — the round-trip-via-postMessage
 * approach the original viewer plan described is a confirmed dead end.
 *
 * We don't keep video bytes in memory after parse (they'd bloat the cached
 * ParseResult for no benefit when most users never extract). On click we
 * re-read + re-unzip; the latency is fine for an explicit user action.
 */
async function handleExtractMedia(
  rawMsg: unknown,
  document: PptxDocument,
  webviewPanel: vscode.WebviewPanel,
  fileName: string,
): Promise<void> {
  const msg = (rawMsg && typeof rawMsg === 'object' ? rawMsg : {}) as {
    mediaPath?: unknown;
    suggestedName?: unknown;
  };
  const mediaPath = typeof msg.mediaPath === 'string' ? msg.mediaPath : '';
  const suggestedName = typeof msg.suggestedName === 'string' && msg.suggestedName.length > 0
    ? msg.suggestedName
    : basenameOf(mediaPath) || 'extracted-media';

  if (!mediaPath) {
    log(`extract[${fileName}]: missing mediaPath`);
    webviewPanel.webview.postMessage({
      type: 'extract-result',
      status: 'error',
      message: 'No media selected.',
    });
    return;
  }

  // Re-read + re-unzip from disk on each click. The parse cache hits would
  // give us metadata but not the raw entry bytes, so there's no shortcut
  // here. fflate's unzipSync materialises all entries — we then pluck the
  // requested one.
  let entry: Uint8Array;
  try {
    const fresh = await vscode.workspace.fs.readFile(document.uri);
    const entries = unzipSync(fresh);
    const found = entries[mediaPath];
    if (!found) {
      log(`extract[${fileName}]: ${mediaPath} not present in zip`);
      webviewPanel.webview.postMessage({
        type: 'extract-result',
        status: 'error',
        mediaPath,
        message: `Entry not found in archive: ${mediaPath}`,
      });
      return;
    }
    entry = found;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`extract[${fileName}]: read/unzip failed — ${message}`);
    webviewPanel.webview.postMessage({
      type: 'extract-result',
      status: 'error',
      mediaPath,
      message,
    });
    return;
  }

  // Default the save dialog to the pptx's directory so users land somewhere
  // recognisable. URI.joinPath handles the directory join across schemes.
  const parentDir = vscode.Uri.joinPath(document.uri, '..');
  const defaultUri = vscode.Uri.joinPath(parentDir, suggestedName);

  let target: vscode.Uri | undefined;
  try {
    target = await vscode.window.showSaveDialog({
      defaultUri,
      saveLabel: 'Extract',
      filters: filtersForName(suggestedName),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`extract[${fileName}]: showSaveDialog threw — ${message}`);
    webviewPanel.webview.postMessage({
      type: 'extract-result',
      status: 'error',
      mediaPath,
      message,
    });
    return;
  }

  if (!target) {
    log(`extract[${fileName}]: ${mediaPath} cancelled`);
    webviewPanel.webview.postMessage({
      type: 'extract-result',
      status: 'cancelled',
      mediaPath,
    });
    return;
  }

  try {
    await vscode.workspace.fs.writeFile(target, entry);
    log(`extracted: ${mediaPath} — ${entry.byteLength} bytes → ${target.toString()}`);
    webviewPanel.webview.postMessage({
      type: 'extract-result',
      status: 'ok',
      mediaPath,
      target: target.toString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`extract[${fileName}]: writeFile failed — ${message}`);
    webviewPanel.webview.postMessage({
      type: 'extract-result',
      status: 'error',
      mediaPath,
      message,
    });
  }
}

function basenameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Heuristic filter for the save dialog based on the file extension of the
 * suggested name. Just enough to nudge the user toward the right file
 * extension on platforms whose save dialog enforces filters; we always
 * include an "All files" escape hatch.
 */
function filtersForName(name: string): Record<string, string[]> {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  if (!m) return { 'All files': ['*'] };
  const ext = m[1].toLowerCase();
  // Mime → friendly label mapping kept small; the goal is just a sensible
  // default. Unknown extensions still get the typed extension as the label.
  const label =
    ext === 'mp4' ? 'MP4 video' :
    ext === 'mov' ? 'QuickTime video' :
    ext === 'webm' ? 'WebM video' :
    ext === 'avi' ? 'AVI video' :
    ext === 'mp3' ? 'MP3 audio' :
    ext === 'm4a' ? 'M4A audio' :
    ext === 'wav' ? 'WAV audio' :
    ext.toUpperCase();
  return { [label]: [ext], 'All files': ['*'] };
}

// ───── ingest (picker + drop) ───────────────────────────────────────────

interface IngestMessage {
  type?: unknown;
  source?: unknown;
  fileName?: unknown;
  bytes?: unknown;
}

async function handleIngest(
  m: IngestMessage,
  document: PptxDocument,
  webviewPanel: vscode.WebviewPanel,
  currentResult: ParseResult | null,
  setCandidate: (c: { fileName: string; bytes: Uint8Array; sha256: string }) => void,
  renderWithSyncTarget: (r: ParseResult, initialStatus?: string) => Promise<void>,
  autoSyncDefault: boolean,
): Promise<void> {
  const source = m.source === 'drop' ? 'drop' : 'picker';
  const resultMessageType = source === 'drop' ? 'drop-result' : 'picker-result';
  const ingestFileName = typeof m.fileName === 'string' && m.fileName.length > 0
    ? m.fileName
    : 'dropped.pptx';

  // postMessage marshals the Uint8Array as a plain object with numeric keys
  // on some hosts; coerce defensively so we always have a real Uint8Array
  // for parsePptx and writeFile.
  let bytes: Uint8Array;
  try {
    bytes = coerceToUint8Array(m.bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`ingest[${source}]: bad bytes payload — ${message}`);
    webviewPanel.webview.postMessage({
      type: resultMessageType,
      outcome: 'invalid',
      message,
    });
    return;
  }

  // Parse the candidate. parsePptx itself doesn't throw on malformed input
  // (it returns parseError instead), but the synthetic FileInfo is harmless.
  let candidate: ParseResult;
  let candidateCached = false;
  try {
    const outcome = await parsePptxCached(
      bytes,
      {
        fileName: ingestFileName,
        size: bytes.byteLength,
        mtime: Date.now(),
      },
      getParseCacheSingleton(),
    );
    candidate = outcome.result;
    candidateCached = outcome.cacheHit;
    if (candidate.timings) logParseTimings(ingestFileName, `ingest[${source}]: `, candidate.timings);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`ingest[${source}]: parse threw — ${message}`);
    webviewPanel.webview.postMessage({
      type: resultMessageType,
      outcome: 'invalid',
      message,
    });
    return;
  }

  if (candidate.parseError) {
    log(`ingest[${source}]: ${ingestFileName} has parseError — ${candidate.parseError}`);
    webviewPanel.webview.postMessage({
      type: resultMessageType,
      outcome: 'invalid',
      message: candidate.parseError,
    });
    return;
  }

  log(
    `ingest[${source}]: ${ingestFileName} parsed — ` +
      `${bytes.byteLength} bytes, sha256=${candidate.sha256.slice(0, 12)}…` +
      (candidateCached ? ' (cached)' : ''),
  );

  if (currentResult && candidate.sha256 === currentResult.sha256) {
    // Identical content. Picker: terse status. Drop: modal so the user has
    // a positive ack for the gesture they just made.
    if (source === 'drop') {
      webviewPanel.webview.postMessage({
        type: 'drop-result',
        outcome: 'identical',
        modalHtml: renderIdenticalModalHtml(ingestFileName),
      });
    } else {
      webviewPanel.webview.postMessage({
        type: 'picker-result',
        outcome: 'identical',
      });
    }
    return;
  }

  // Picker — write immediately (the user already affirmed via the dialog).
  // Drop — stash + open the compare modal (user affirms via Update button).
  if (source === 'picker') {
    try {
      // PDF→PPTX import is the only producer of source='picker' today, and
      // re-importing the same PDF reproduces the same sha256. If a previous
      // import landed before the in-file thumbnail change (or any other
      // content-determined behaviour we've since added to the parser), its
      // cached entry would shadow the freshly-written file's parse and the
      // panel would render against the stale shape.
      //
      // Evict the entry for *this one sha* (scoped, not a full cache flush)
      // so the post-write re-parse inside writeAndRender misses and then
      // records the fresh result via parsePptxCached → cache.record. Net
      // effect: the cache entry for the imported file is replaced with the
      // up-to-date parse; every other file's entry stays intact. Import is
      // already the slow path — paying for one extra parse is well below
      // the user-noticeable threshold.
      const cache = getParseCacheSingleton();
      if (cache) {
        await cache.forget(candidate.sha256);
        log(`ingest[picker]: evicted stale cache entry for sha256=${candidate.sha256.slice(0, 12)}… (will be repopulated by post-write re-parse)`);
      }
      await writeAndRender(document, webviewPanel, bytes, ingestFileName, renderWithSyncTarget);
      webviewPanel.webview.postMessage({ type: 'picker-result', outcome: 'updated' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`update[picker]: write failed — ${message}`);
      webviewPanel.webview.postMessage({
        type: 'picker-result',
        outcome: 'error',
        message,
      });
    }
    return;
  }

  // Drop path — stash candidate and ask the user.
  setCandidate({ fileName: ingestFileName, bytes, sha256: candidate.sha256 });
  const modalHtml = currentResult
    ? renderCompareModalHtml(currentResult, candidate, autoSyncDefault)
    : renderIdenticalModalHtml(ingestFileName); // shouldn't happen — current is always set by the time the user can drop, but be tolerant
  webviewPanel.webview.postMessage({
    type: 'drop-result',
    outcome: 'different',
    modalHtml,
  });
}

async function handleConfirmUpdate(
  document: PptxDocument,
  webviewPanel: vscode.WebviewPanel,
  candidate: { fileName: string; bytes: Uint8Array; sha256: string },
  renderWithSyncTarget: (r: ParseResult, initialStatus?: string) => Promise<void>,
): Promise<void> {
  try {
    await writeAndRender(
      document,
      webviewPanel,
      candidate.bytes,
      candidate.fileName,
      renderWithSyncTarget,
    );
    // The re-render above replaces the whole webview HTML; no follow-up
    // message needed. The new render carries initialStatus='Updated'.
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`update[drop]: write failed — ${message}`);
    webviewPanel.webview.postMessage({
      type: 'drop-result',
      outcome: 'error',
      message,
    });
  }
}

/**
 * Write the candidate bytes over the document URI, re-stat + re-parse against
 * the freshly-written file, then re-render the panel with initialStatus='Updated'.
 * The re-parse uses the real on-disk size/mtime so the metadata grid matches
 * what `stat()` will see for any subsequent action.
 */
async function writeAndRender(
  document: PptxDocument,
  _webviewPanel: vscode.WebviewPanel,
  bytes: Uint8Array,
  ingestFileName: string,
  renderWithSyncTarget: (r: ParseResult, initialStatus?: string) => Promise<void>,
): Promise<void> {
  await vscode.workspace.fs.writeFile(document.uri, bytes);
  const targetName = document.uri.path.split('/').pop() ?? 'unknown.pptx';
  log(`update: ${ingestFileName} → ${document.uri.toString()} (${bytes.byteLength} bytes)`);

  const stat = await vscode.workspace.fs.stat(document.uri);
  const { result: refreshed, cacheHit: refreshedCached } = await parsePptxCached(
    bytes,
    { fileName: targetName, size: stat.size, mtime: stat.mtime },
    getParseCacheSingleton(),
  );
  if (refreshed.timings) logParseTimings(targetName, 'refresh: ', refreshed.timings);
  if (refreshedCached) log(`refresh: ${targetName} served from parse-cache`);
  await renderWithSyncTarget(refreshed, 'Updated');
}

function coerceToUint8Array(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw && typeof raw === 'object' && 'byteLength' in raw && typeof (raw as ArrayBufferView).byteLength === 'number') {
    const view = raw as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  // Some webview marshallers serialize Uint8Array as { '0': n, '1': n, ... , length: n }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.length === 'number') {
      const out = new Uint8Array(obj.length);
      for (let i = 0; i < out.length; i++) out[i] = Number(obj[String(i)] ?? 0) & 0xff;
      return out;
    }
  }
  throw new Error('Could not interpret bytes payload as Uint8Array');
}

// ───── per-file Run Sync ────────────────────────────────────────────────

/**
 * Execute the per-file scoped plan via the shared runSync engine, log a summary,
 * surface info/warning toasts (same UX as admin + config editors), and re-render
 * the panel so the Sync target section reflects the post-sync world. The post-
 * sync re-render is what gives the user immediate feedback that the section's
 * "to update" line went away.
 */
async function runPerFileSync(
  webviewPanel: vscode.WebviewPanel,
  fileName: string,
  plans: PlanForDestination[],
  decisions: ReadonlyMap<string, RowDecision>,
  currentResult: ParseResult | null,
  renderWithSyncTarget: (r: ParseResult, initialStatus?: string) => Promise<void>,
): Promise<void> {
  log(
    `viewer[${fileName}]: run-sync — starting execution (${countAccepted(decisions)} armed override(s))`,
  );
  let summary;
  try {
    summary = await runSync(plans, decisions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`viewer[${fileName}]: run-sync threw — ${message}`);
    void vscode.window.showErrorMessage(`Folder Sync: execution failed — ${message}`);
    webviewPanel.webview.postMessage({ type: 'sync-status', status: 'error', message });
    return;
  }

  for (const line of formatRunSummary(summary).split('\n')) log(line);

  const total = summary.ok + summary.failed;
  if (summary.failed === 0 && summary.manifestWriteFailures.length === 0) {
    if (total === 0) {
      void vscode.window.showInformationMessage('Folder Sync: nothing to do.');
    } else {
      void vscode.window.showInformationMessage(
        `Folder Sync: ${summary.ok} operation(s) completed.`,
      );
    }
  } else if (summary.failed > 0) {
    void vscode.window
      .showWarningMessage(
        `Folder Sync: ${summary.ok} succeeded, ${summary.failed} failed.`,
        'Show details',
      )
      .then((choice) => {
        if (choice === 'Show details') {
          void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
        }
      });
  } else {
    void vscode.window.showWarningMessage(
      `Folder Sync: files placed, but ${summary.manifestWriteFailures.length} manifest write(s) failed. ` +
        `Re-run will re-detect these as already-placed-but-untracked files.`,
    );
  }

  // Re-render. The whole webview HTML is replaced — the new render's Sync
  // target section will reflect the updated manifest (typically nothing-to-do
  // after a green-path apply). initialStatus mirrors what the user just did.
  if (currentResult) {
    const status = summary.failed === 0 ? 'Synced' : 'Sync partially failed';
    await renderWithSyncTarget(currentResult, status);
  } else {
    // No current parse on hand (shouldn't happen — the button only renders
    // after a successful parse), but be defensive: at least notify the page.
    webviewPanel.webview.postMessage({
      type: 'sync-status',
      status: 'done',
      ok: summary.ok,
      failed: summary.failed,
    });
  }
}

// ───── sync target section ──────────────────────────────────────────────

/**
 * Output of buildSyncTargetHtml. `plans` is the raw planner output, kept so
 * the per-file Run Sync button can hand them straight to runSync() without
 * a second walk. `blocking` + `hasWork` are the same gating values the admin
 * + config editors compute.
 */
interface SyncTargetResult {
  html: string;
  plans: PlanForDestination[];
  blocking: number;
  /**
   * Items whose only warnings are 'override' severity. The viewer's orange
   * Run Sync button is enabled whenever `blocking > 0` so the user can ship
   * armed overrides through the same per-row affordance the standalone plan
   * webview offers.
   */
  overridableWarnings: number;
  hasWork: boolean;
}

/**
 * Build the HTML for the viewer's "Sync target" section from current topology
 * + manifest. Returns null when the file is outside any workspace folder —
 * the renderer drops the section entirely in that case.
 *
 * Branching:
 *   - source             → scoped dry-run plan + attribution + Run Sync
 *   - destinationMapped  → scoped dry-run plan against the owning source +
 *                          attribution lines + Run Sync (re-sync this file
 *                          from the source's current copy)
 *   - destinationOrphan  → muted banner "unique to destination" (no plan)
 *   - uncovered          → muted banner "not covered by a .sync.jsonc"
 *   - outsideWorkspace   → null (no section)
 */
async function buildSyncTargetHtml(
  manager: SyncManager,
  documentUri: vscode.Uri,
): Promise<SyncTargetResult | null> {
  const topology = manager.getTopology();
  const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map(toPreviewWorkspaceFolder);
  const sources = topology.sources.map(toPreviewSource);

  // Find the containing workspace folder by ancestry on path. Used to read
  // the manifest at that root before classifying.
  const containing = pickContainingFolder(documentUri.path, vscode.workspace.workspaceFolders ?? []);
  const manifest = containing ? await readManifest(containing.uri) : null;

  const input: PreviewInput = {
    documentUri: documentUri.toString(),
    documentPath: documentUri.path,
    workspaceFolders,
    sources,
    manifest,
  };
  const ctx = classifyPreviewContext(input);

  switch (ctx.kind) {
    case 'outsideWorkspace':
      return null;

    case 'uncovered':
      return bannerOnly(renderUncoveredBanner(ctx.workspaceFolderName, ctx.relPath));

    case 'destinationOrphan':
      return bannerOnly(renderOrphanBanner(ctx.destinationWorkspaceFolderName, ctx.relPath));

    case 'source':
      return renderScopedPlan(manager, ctx.sourceConfigUri, documentUri, {
        kind: 'source',
        workspaceFolderName: ctx.workspaceFolderName,
        relPath: ctx.relPath,
      });

    case 'destinationMapped':
      // Build the scoped plan against the source that placed the file, with
      // pathFilter relative to the source folder. Resolve the source URI by
      // looking up the configUri in topology.
      return renderScopedPlanForDestination(manager, ctx, documentUri);
  }
}

function bannerOnly(html: string): SyncTargetResult {
  return { html, plans: [], blocking: 0, overridableWarnings: 0, hasWork: false };
}

function renderUncoveredBanner(workspaceFolderName: string, relPath: string): string {
  const where = relPath ? `${workspaceFolderName}/${relPath}` : workspaceFolderName;
  return `<div class="sync-banner muted">
    <strong>Not covered by sync.</strong>
    <code>${escapeHtml(where)}</code> is in the workspace but no <code>.sync.jsonc</code> includes it.
  </div>`;
}

function renderOrphanBanner(destinationWorkspaceFolderName: string, relPath: string): string {
  const where = relPath
    ? `${destinationWorkspaceFolderName}/${relPath}`
    : destinationWorkspaceFolderName;
  return `<div class="sync-banner muted">
    <strong>Destination-only file.</strong>
    <code>${escapeHtml(where)}</code> lives in a sync destination but isn't tracked by any source manifest.
  </div>`;
}

async function renderScopedPlan(
  manager: SyncManager,
  sourceConfigUri: string,
  documentUri: vscode.Uri,
  attribution: { kind: 'source'; workspaceFolderName: string; relPath: string },
): Promise<SyncTargetResult> {
  try {
    const plans = await buildScopedDryRunPlan(manager.getTopology(), {
      sourceConfigUri: vscode.Uri.parse(sourceConfigUri),
      pathFilter: documentUri,
      pathFilterIsFile: true,
    });
    // M5.1: per-row decision checkboxes are wired through to the viewer's
    // postMessage channel — same as the admin/config editors. Collisions get
    // an Overwrite arming, destination-only rows get Delete, and green-path
    // rows with override-only warnings get "Sync anyway".
    const vm = toViewModel(
      plans,
      (plan) => {
        const rel = vscode.workspace.asRelativePath(plan.source.sourceFolderUri, false);
        return rel || plan.source.sourceFolderUri.toString();
      },
      { interactive: true },
    );
    const head = `<p class="sync-attribution">Source: <code>${escapeHtml(attribution.workspaceFolderName)}</code> · path <code>${escapeHtml(attribution.relPath)}</code></p>`;
    const blocking = vm.totals.updateCollision + vm.totals.warnings;
    const hasWork =
      vm.totals.create + vm.totals.updateTracked + vm.totals.deleteTracked + vm.totals.updateCollision > 0;
    const actions = renderRunSyncRow(hasWork, vm.totals);
    const html = `<div class="sync-target">${head}${renderPlanPairs(vm)}${actions}</div>`;
    return { html, plans, blocking, overridableWarnings: vm.totals.overridableWarnings, hasWork };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`viewer: scoped-plan failed — ${message}`);
    return bannerOnly(`<div class="sync-banner muted">Could not build scoped plan: ${escapeHtml(message)}</div>`);
  }
}

async function renderScopedPlanForDestination(
  manager: SyncManager,
  ctx: Extract<PreviewContext, { kind: 'destinationMapped' }>,
  _documentUri: vscode.Uri,
): Promise<SyncTargetResult> {
  try {
    const topology = manager.getTopology();
    const source = topology.sources.find(
      (s) => s.configUri.toString() === ctx.sourceConfigUri,
    );
    if (!source) {
      return bannerOnly(`<div class="sync-banner muted">Source no longer present in topology — manifest may be stale.</div>`);
    }
    // pathFilter is the source-relative path joined onto the source folder URI.
    const pathFilter = source.sourceFolderUri.with({
      path: joinPath(source.sourceFolderUri.path, ctx.sourceRelPath),
    });
    const plans = await buildScopedDryRunPlan(topology, {
      sourceConfigUri: source.configUri,
      pathFilter,
      pathFilterIsFile: true,
    });
    // M5.1: same interactive treatment as the source-side scoped plan.
    const vm = toViewModel(
      plans,
      (plan) => {
        const rel = vscode.workspace.asRelativePath(plan.source.sourceFolderUri, false);
        return rel || plan.source.sourceFolderUri.toString();
      },
      { interactive: true },
    );
    const head = `<p class="sync-attribution">Placed here by source <code>${escapeHtml(ctx.sourceWorkspaceFolderName)}</code> · source path <code>${escapeHtml(ctx.sourceRelPath)}</code></p>`;
    const blocking = vm.totals.updateCollision + vm.totals.warnings;
    const hasWork =
      vm.totals.create + vm.totals.updateTracked + vm.totals.deleteTracked + vm.totals.updateCollision > 0;
    const actions = renderRunSyncRow(hasWork, vm.totals);
    const html = `<div class="sync-target">${head}${renderPlanPairs(vm)}${actions}</div>`;
    return { html, plans, blocking, overridableWarnings: vm.totals.overridableWarnings, hasWork };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`viewer: dest-mapped scoped-plan failed — ${message}`);
    return bannerOnly(`<div class="sync-banner muted">Could not build scoped plan: ${escapeHtml(message)}</div>`);
  }
}

/**
 * Render the Run Sync action row appended to a scoped plan section. M5.1
 * mirrors the admin/config editor's traffic-light buttons:
 *   - Green Run Sync — always present; enabled iff `blocking === 0` & hasWork.
 *   - Orange Run Sync (safe items only) — shown iff `blocking > 0`; label is
 *     refreshed by the viewer's `__decisionWiring` hook as the user arms
 *     per-row checkboxes (the same checkboxes embedded in the scoped plan
 *     above this action row).
 *
 * The hint to the right explains gating when something blocks; otherwise it
 * stays empty.
 */
function renderRunSyncRow(
  hasWork: boolean,
  totals: {
    updateCollision: number;
    warnings: number;
    blockingWarnings: number;
    overridableWarnings: number;
    create: number;
    updateTracked: number;
    deleteTracked: number;
    destinationOnly: number;
  },
): string {
  const collisions = totals.updateCollision;
  const blocking = collisions + totals.warnings;
  const safeUpper = totals.create + totals.updateTracked + totals.deleteTracked;
  // Items the orange "safe items only" button can actually ship when armed:
  // collisions (overwrite decision), destination-only (delete decision), and
  // create/update-tracked rows that may carry an overridable warning. A
  // skip-row with an overridable warning has nothing to ship — the file is
  // already in sync — so it doesn't count.
  const shippable = collisions + totals.destinationOnly + safeUpper;

  let hint = '';
  let greenDisabled = '';
  let orangeAttrs = ' hidden disabled';

  if (blocking > 0) {
    greenDisabled = ' disabled';
    const parts: string[] = [];
    if (collisions) parts.push(`${collisions} collision${collisions === 1 ? '' : 's'}`);
    if (totals.blockingWarnings) {
      parts.push(`${totals.blockingWarnings} blocked file${totals.blockingWarnings === 1 ? '' : 's'}`);
    }
    if (totals.overridableWarnings) {
      parts.push(
        `${totals.overridableWarnings} file${totals.overridableWarnings === 1 ? '' : 's'} needing override`,
      );
    }
    if (shippable > 0) {
      orangeAttrs = '';
      hint = `${parts.join(' + ')} — orange ships armed overrides or skips the rest.`;
    } else if (totals.overridableWarnings > 0 && !hasWork) {
      // Skip-row(s) carry an overridable warning, but there's nothing to
      // ship — destination already matches source. The warning is purely
      // informational in this case.
      hint = 'Destination already matches source — validator warning is informational.';
    } else {
      hint = `${parts.join(' + ')} — cannot ship; fix the source file and re-open.`;
    }
  } else if (!hasWork) {
    greenDisabled = ' disabled';
    hint = 'Nothing to sync — destination is up to date.';
  }

  return `<div class="sync-actions">
    <button id="sync-run-btn" class="action-btn sync-run-btn" type="button"${greenDisabled} title="Apply the green-path operations from the plan above — limited to this file">Run Sync</button>
    <button id="sync-run-safe-btn" class="action-btn sync-run-safe-btn" type="button"${orangeAttrs} title="Sync only the items without collisions or warnings — armed checkboxes still ship">Run Sync (safe items only)</button>
    <span id="sync-run-hint" class="action-status">${escapeHtml(hint)}</span>
  </div>`;
}

function joinPath(base: string, sub: string): string {
  if (!sub) return base;
  return base.endsWith('/') ? `${base}${sub}` : `${base}/${sub}`;
}

function toPreviewWorkspaceFolder(f: vscode.WorkspaceFolder): PreviewWorkspaceFolder {
  return { uri: f.uri.toString(), path: f.uri.path, name: f.name };
}

function toPreviewSource(s: import('./sync/topology').ResolvedSource): PreviewSource {
  return {
    configUri: s.configUri.toString(),
    sourceFolderPath: s.sourceFolderUri.path,
    workspaceFolderName: s.workspaceFolderName,
    destinations: s.destinations.map((d) => ({ uri: d.uri, subpath: d.subpath })),
  };
}

function pickContainingFolder(
  documentPath: string,
  folders: readonly vscode.WorkspaceFolder[],
): vscode.WorkspaceFolder | null {
  let best: vscode.WorkspaceFolder | null = null;
  let bestLen = -1;
  for (const f of folders) {
    const base = f.uri.path.replace(/\/+$/, '');
    if (documentPath === base || documentPath.startsWith(`${base}/`)) {
      if (base.length > bestLen) {
        best = f;
        bestLen = base.length;
      }
    }
  }
  return best;
}

/**
 * Format a millisecond duration for the parse-timing log line. Under 10ms we
 * keep one decimal (sub-millisecond noise is visible there); above that an
 * integer is plenty for human-eyeballing relative phase costs.
 */
function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '?';
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}

/**
 * Emit a one-line parse-timing breakdown to the output channel. Used by all
 * three parsePptx call sites (initial open, ingest from drop/picker, refresh
 * after Update). `readMs` is only present for the initial-open path — ingest
 * has its bytes in memory from the webview, refresh has them from the write
 * it just performed.
 */
function logParseTimings(
  fileName: string,
  prefix: string,
  timings: ParseTimings,
  readMs?: number,
): void {
  const readPart = readMs !== undefined ? `read=${fmtMs(readMs)} ` : '';
  log(
    `${prefix}parse-timing: ${fileName} — total=${fmtMs(timings.totalMs)} ` +
      `${readPart}` +
      `hash=${fmtMs(timings.hashMs)} ` +
      `unzip=${fmtMs(timings.unzipMs)} ` +
      `xml=${fmtMs(timings.xmlDecodeMs)} ` +
      `slides=${fmtMs(timings.slideScanMs)} ` +
      `meta=${fmtMs(timings.metadataMs)} ` +
      `media=${fmtMs(timings.mediaMs)} ` +
      `show=${fmtMs(timings.showPropsMs)}`,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Cryptographically-random nonce for the webview's CSP. 16 bytes → 32 hex chars
// is comfortably above the "guessable" line and well below any header-size
// concern. crypto.getRandomValues is available in the web-extension worker.
function makeNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
