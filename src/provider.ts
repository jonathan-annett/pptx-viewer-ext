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
import { getParseCacheSingleton, parsePptxCached, project } from './shared/parseCache';
import { renderHtml, renderError, type RenderOptions } from './webview';
import { log } from './log';
import { getActivePlaceholderSet } from './shared/placeholderRegistry';
import { renderCompareModalHtml, renderIdenticalModalHtml } from './shared/compareModalHtml';
import { startUploadFlow, type UploadFlowHandle } from './upload/uploadFlow';

class PptxDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {
    // no resources held
  }
}

// ───── cross-feature: PDF → PPTX import from the search panel ──────────
//
// The search panel surfaces pairs of (canonical PPTX, candidate PDF) and
// needs a way to drive the existing viewer-side PDF-import modal against
// the canonical PPTX target. The viewer's webview already accepts an
// `uploadedBytes` message (the upload flow uses it) and routes PDFs
// through `handlePdfFile()` — which opens the PDF-import modal. We
// reuse that path verbatim instead of re-implementing the import in
// the search panel.
//
// Mechanism:
//   - activePanels maps `uri.toString()` → the currently-mounted viewer
//     panel for that document. Populated on `resolveCustomEditor`, torn
//     down on panel dispose. Used to push `uploadedBytes` into an
//     already-open viewer without going through `vscode.open`.
//   - pendingPdfImports stashes a `{fileName, bytes}` payload keyed by
//     target URI. The provider drains it after the initial render of
//     each panel, posting `uploadedBytes` if there's a stash for this
//     URI. Used for the "viewer isn't open yet" branch: the caller
//     stashes the bytes, asks vscode.dev to open the URI, and the
//     freshly-mounted panel picks the bytes up at the end of its first
//     render.
//
// Why both: vscode.open on an already-open URI just reveals the tab —
// resolveCustomEditor doesn't fire. Without the activePanels registry
// the bytes would never be delivered in that case. Conversely, on a
// cold open we don't have a panel object to post to until
// resolveCustomEditor runs, hence the stash.

interface PendingPdfImport {
  fileName: string;
  bytes: Uint8Array;
}

const activePanels = new Map<string, vscode.WebviewPanel>();
const pendingPdfImports = new Map<string, PendingPdfImport>();

/**
 * Push a PDF into the viewer for `targetUri` and trigger the PDF-import
 * modal. Opens the viewer if it isn't already open.
 *
 * Used by the search panel when the user primes a (canonical PPTX,
 * candidate PDF) pair and clicks Update — instead of writing the PDF
 * bytes verbatim over the PPTX (which would corrupt it), we route into
 * the viewer's existing PDF → PPTX import pipeline. The user confirms
 * the conversion via the modal there.
 *
 * Idempotent: a second call before the first has been consumed
 * overwrites the stash. Concurrent imports for two different URIs work
 * because the stash is keyed by URI.
 */
export async function requestPdfImportIntoViewer(
  targetUri: vscode.Uri,
  fileName: string,
  bytes: Uint8Array,
): Promise<void> {
  const key = targetUri.toString();
  const existing = activePanels.get(key);
  if (existing) {
    // Viewer is already mounted — push the bytes directly. The webview's
    // `uploadedBytes` handler routes PDFs through `handlePdfFile` which
    // opens the import modal.
    try {
      existing.reveal(vscode.ViewColumn.Beside, false);
    } catch {
      // reveal can throw if the panel was disposed between get + use.
      // Fall through to the open-and-stash path.
      activePanels.delete(key);
      pendingPdfImports.set(key, { fileName, bytes });
      await vscode.commands.executeCommand('vscode.open', targetUri, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      });
      return;
    }
    existing.webview.postMessage({ type: 'uploadedBytes', fileName, bytes });
    log(`pdf-import: pushed ${bytes.byteLength} bytes into open viewer ${key}`);
    return;
  }
  // Viewer not open — stash and open. The post-render drain inside
  // resolveCustomEditor will deliver the bytes once the panel mounts.
  pendingPdfImports.set(key, { fileName, bytes });
  log(`pdf-import: stashed ${bytes.byteLength} bytes for ${key} (opening viewer)`);
  await vscode.commands.executeCommand('vscode.open', targetUri, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: false,
  });
}

export class PptxEditorProvider implements vscode.CustomReadonlyEditorProvider<PptxDocument> {
  public static readonly viewType = 'pptxViewer.viewer';

  public static register(): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      PptxEditorProvider.viewType,
      new PptxEditorProvider(),
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

    // Render the viewer shell for a parse result. The placeholder lookup is
    // async but always safe (the registry returns the empty-default set when
    // the workspace is folderless or the registry hasn't loaded yet) and just
    // drives the "placeholder stub" banner.
    const render = async (
      result: ParseResult,
      initialStatus?: string,
    ): Promise<void> => {
      const placeholders = await getActivePlaceholderSet();
      const opts: RenderOptions = {};
      if (initialStatus !== undefined) opts.initialStatus = initialStatus;
      if (placeholders.has(result.sha256)) opts.isPlaceholder = true;
      webviewPanel.webview.html = renderHtml(result, makeNonce(), opts);
      currentResult = result;
    };

    // M5: per-panel upload session. At most one is active at a time; opening
    // a fresh session replaces (and disposes) any previous one so the modal
    // stays consistent with whichever WS we're actually wired to. Cleared
    // on cancel/close finishing, and on panel dispose.
    let currentUploadFlow: UploadFlowHandle | null = null;

    // Register this panel so the search panel's PDF-import flow can find
    // it. Deregistered on dispose; overwrites any prior entry for the
    // same URI (one viewer per document, per provider config).
    const registryKey = document.uri.toString();
    activePanels.set(registryKey, webviewPanel);

    webviewPanel.onDidDispose(() => {
      pendingCandidate = null;
      currentUploadFlow?.dispose();
      currentUploadFlow = null;
      // Only delete the entry if it still points at *this* panel — a
      // brand-new resolveCustomEditor for the same URI may have replaced
      // it before dispose fires on the old panel.
      if (activePanels.get(registryKey) === webviewPanel) {
        activePanels.delete(registryKey);
      }
    });

    webviewPanel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as {
        type?: unknown;
        message?: unknown;
        source?: unknown;
        fileName?: unknown;
        bytes?: unknown;
        otp?: unknown;
      };

      if (m.type === 'viewer-log' && typeof m.message === 'string') {
        log(`viewer[${fileName}]: ${m.message}`);
        return;
      }

      if (m.type === 'save-as') {
        await handleSaveAs(document, webviewPanel, fileName);
        return;
      }

      if (m.type === 'thumbnail-synthesised') {
        // M-VE-3: the webview rendered a fallback thumbnail on canvas. We
        // update the in-memory currentResult so any subsequent render this
        // session reflects the new thumbnail, and write through the parse
        // cache so future opens of the same content (sha256) skip the
        // synthesis pass entirely. The webview has already swapped its
        // placeholder eagerly — the thumbnail-set ACK we post back is a
        // belt-and-braces refresh, not the primary display path.
        const tm = msg as {
          sha256?: unknown;
          dataUrl?: unknown;
          mime?: unknown;
        };
        const sha = typeof tm.sha256 === 'string' ? tm.sha256 : '';
        const dataUrl = typeof tm.dataUrl === 'string' ? tm.dataUrl : '';
        const mime = typeof tm.mime === 'string' ? tm.mime : 'image/jpeg';
        if (!sha || !dataUrl) {
          log(`viewer[${fileName}]: thumbnail-synthesised — missing sha/dataUrl`);
          return;
        }
        if (!currentResult || currentResult.sha256 !== sha) {
          // The user may have updated the file between render and synthesis
          // (sha changes → cached entry no longer matches). Skip silently;
          // the new render will trigger its own synthesis if needed.
          log(`viewer[${fileName}]: thumbnail-synthesised — sha mismatch (cur=${currentResult?.sha256?.slice(0, 12) ?? 'none'} got=${sha.slice(0, 12)}), discarding`);
          return;
        }
        currentResult.thumbnail = { mime, dataUrl, synthesised: true };
        // Clear the hint — the next hydrate of this sha should yield a
        // result that already has a thumbnail, so no re-synthesis fires.
        currentResult.synthesisHint = undefined;
        const cache = getParseCacheSingleton();
        if (cache) {
          try {
            await cache.record(sha, project(currentResult));
            log(`thumbnail: synthesised sha=${sha.slice(0, 12)}… (${dataUrl.length} chars, cached)`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log(`viewer[${fileName}]: thumbnail-synthesised cache write failed — ${message}`);
          }
        } else {
          log(`thumbnail: synthesised sha=${sha.slice(0, 12)}… (${dataUrl.length} chars, no cache)`);
        }
        webviewPanel.webview.postMessage({ type: 'thumbnail-set', dataUrl });
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
          render,
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
        await handleConfirmUpdate(document, webviewPanel, candidate, render);
        return;
      }

      if (m.type === 'cancel-update') {
        if (pendingCandidate) {
          log(`update[${fileName}]: cancelled (candidate ${pendingCandidate.fileName} discarded)`);
        }
        pendingCandidate = null;
        return;
      }

      if (m.type === 'uploadOpen') {
        // User clicked "Upload to Update…". Dispose any prior flow (defensive
        // — UI shouldn't allow concurrent flows, but a stale one could exist
        // if the webview reloaded mid-session) and open a fresh one.
        currentUploadFlow?.dispose();
        log(`upload[${fileName}]: opening session`);
        currentUploadFlow = startUploadFlow({
          webviewPanel,
          fileName,
          onComplete: async (bytes, sourceName) => {
            // Hand the bytes back to the webview. It does PDF vs PPTX
            // routing (magic bytes + filename extension), closes the
            // upload modal, and either opens the PDF-import modal or
            // posts an ingest message we'll receive below as
            // m.type === 'ingest' with source='upload'.
            log(
              `upload[${fileName}]: delivered ${bytes.byteLength} bytes ` +
                `to webview (source=${sourceName})`,
            );
            webviewPanel.webview.postMessage({
              type: 'uploadedBytes',
              fileName: sourceName,
              bytes,
            });
          },
        });
        return;
      }

      if (m.type === 'uploadCancel') {
        if (currentUploadFlow) {
          currentUploadFlow.cancel();
          // Don't null the slot here — the flow's WS close handler still
          // needs to fire and post `uploadModalClose`. The next uploadOpen
          // disposes whatever remains.
        }
        return;
      }

      if (m.type === 'uploadClose') {
        if (currentUploadFlow) {
          currentUploadFlow.close();
          currentUploadFlow.dispose();
          currentUploadFlow = null;
        }
        return;
      }

      if (m.type === 'uploadRetry') {
        if (currentUploadFlow) {
          currentUploadFlow.retry();
        }
        return;
      }

      if (m.type === 'uploadOtpSubmit' && typeof m.otp === 'string') {
        // OTP came from a user typing into the modal. The flow validates the
        // 6-digit format again on its side and hashes before forwarding to
        // the WS — we just route it.
        if (currentUploadFlow) {
          currentUploadFlow.submitOtp(m.otp);
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
      await render(result);

      // Drain any pending PDF-import stash. The search panel's update flow
      // for a (canonical PPTX, candidate PDF) pair stashes the PDF bytes
      // before calling vscode.open; once the viewer has finished its first
      // render we push the bytes through so `handlePdfFile` opens the
      // import modal.
      const pendingImport = pendingPdfImports.get(registryKey);
      if (pendingImport) {
        pendingPdfImports.delete(registryKey);
        log(
          `pdf-import: delivering stashed bytes for ${registryKey} — ` +
            `${pendingImport.fileName} (${pendingImport.bytes.byteLength} bytes)`,
        );
        webviewPanel.webview.postMessage({
          type: 'uploadedBytes',
          fileName: pendingImport.fileName,
          bytes: pendingImport.bytes,
        });
      }
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
  render: (r: ParseResult, initialStatus?: string) => Promise<void>,
): Promise<void> {
  // 'upload' is a new (M5) ingest source — user-affirmed bytes from the
  // dropbox-server. It behaves identically to 'picker' (no compare modal;
  // write immediately) but logs under its own label so traces stay
  // distinguishable. Anything else falls through to 'picker' for back-compat.
  const source: 'drop' | 'picker' | 'upload' =
    m.source === 'drop' ? 'drop' : m.source === 'upload' ? 'upload' : 'picker';
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

  // Picker / Upload — write immediately (the user already affirmed via the
  // dialog / by completing the phone upload). Drop — stash + open the compare
  // modal (user affirms via Update button).
  if (source === 'picker' || source === 'upload') {
    try {
      // PDF→PPTX import + (now) phone upload can both re-deliver bytes the
      // user has shipped before; if a previous import/upload landed before
      // a parser change, its cached entry would shadow the freshly-written
      // file and the panel would render against the stale shape.
      //
      // Evict the entry for *this one sha* (scoped, not a full cache flush)
      // so the post-write re-parse inside writeAndRender misses and then
      // records the fresh result via parsePptxCached → cache.record. Net
      // effect: the cache entry for the imported file is replaced with the
      // up-to-date parse; every other file's entry stays intact. Import /
      // upload is already the slow path — paying for one extra parse is
      // well below the user-noticeable threshold.
      const cache = getParseCacheSingleton();
      if (cache) {
        await cache.forget(candidate.sha256);
        log(`ingest[${source}]: evicted stale cache entry for sha256=${candidate.sha256.slice(0, 12)}… (will be repopulated by post-write re-parse)`);
      }
      await writeAndRender(document, webviewPanel, bytes, ingestFileName, render);
      webviewPanel.webview.postMessage({ type: 'picker-result', outcome: 'updated' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`update[${source}]: write failed — ${message}`);
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
    ? renderCompareModalHtml(currentResult, candidate)
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

// Cryptographically-random nonce for the webview's CSP. 16 bytes → 32 hex chars
// is comfortably above the "guessable" line and well below any header-size
// concern. crypto.getRandomValues is available in the web-extension worker.
function makeNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
