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
import { parsePptx, type ParseResult } from './pptx';
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

    const renderWithSyncTarget = async (
      result: ParseResult,
      initialStatus?: string,
    ): Promise<void> => {
      const syncTarget = await buildSyncTargetHtml(this.manager, document.uri);
      lastPerFilePlans = syncTarget?.plans ?? [];
      lastPerFileBlocking = syncTarget?.blocking ?? 0;
      lastPerFileHasWork = syncTarget?.hasWork ?? false;
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

      if (m.type === 'save-as') {
        await handleSaveAs(document, webviewPanel, fileName);
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
        // pathFilter+pathFilterIsFile options. Block on collisions / warnings
        // and no-work, same as the other surfaces.
        if (syncInFlight) return;
        if (lastPerFileBlocking > 0) {
          log(`viewer[${fileName}]: run-sync ignored — collisions present`);
          return;
        }
        if (!lastPerFileHasWork) {
          log(`viewer[${fileName}]: run-sync ignored — nothing to do`);
          return;
        }
        syncInFlight = true;
        webviewPanel.webview.postMessage({ type: 'sync-status', status: 'running' });
        try {
          await runPerFileSync(
            webviewPanel,
            fileName,
            lastPerFilePlans,
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
      const [bytes, stat] = await Promise.all([
        vscode.workspace.fs.readFile(document.uri),
        vscode.workspace.fs.stat(document.uri),
      ]);
      const result = await parsePptx(bytes, {
        fileName,
        size: stat.size,
        mtime: stat.mtime,
      });
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
          (result.parseError ? `, parseError: ${result.parseError}` : ''),
      );
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
  try {
    candidate = await parsePptx(bytes, {
      fileName: ingestFileName,
      size: bytes.byteLength,
      mtime: Date.now(),
    });
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
      `${bytes.byteLength} bytes, sha256=${candidate.sha256.slice(0, 12)}…`,
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
  const refreshed = await parsePptx(bytes, {
    fileName: targetName,
    size: stat.size,
    mtime: stat.mtime,
  });
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
  currentResult: ParseResult | null,
  renderWithSyncTarget: (r: ParseResult, initialStatus?: string) => Promise<void>,
): Promise<void> {
  log(`viewer[${fileName}]: run-sync — starting execution`);
  let summary;
  try {
    summary = await runSync(plans);
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
  return { html, plans: [], blocking: 0, hasWork: false };
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
    // Embedded read-only preview: the viewer panel has no message channel
    // back to a plan controller, so suppress the decision checkboxes that
    // the standalone plan webview emits.
    const vm = toViewModel(
      plans,
      (plan) => {
        const rel = vscode.workspace.asRelativePath(plan.source.sourceFolderUri, false);
        return rel || plan.source.sourceFolderUri.toString();
      },
      { interactive: false },
    );
    const head = `<p class="sync-attribution">Source: <code>${escapeHtml(attribution.workspaceFolderName)}</code> · path <code>${escapeHtml(attribution.relPath)}</code></p>`;
    const blocking = vm.totals.updateCollision + vm.totals.warnings;
    const hasWork =
      vm.totals.create + vm.totals.updateTracked + vm.totals.deleteTracked + vm.totals.updateCollision > 0;
    const actions = renderRunSyncRow(hasWork, vm.totals.updateCollision, vm.totals.warnings);
    const html = `<div class="sync-target">${head}${renderPlanPairs(vm)}${actions}</div>`;
    return { html, plans, blocking, hasWork };
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
    // Embedded read-only preview: the viewer panel has no message channel
    // back to a plan controller, so suppress the decision checkboxes that
    // the standalone plan webview emits.
    const vm = toViewModel(
      plans,
      (plan) => {
        const rel = vscode.workspace.asRelativePath(plan.source.sourceFolderUri, false);
        return rel || plan.source.sourceFolderUri.toString();
      },
      { interactive: false },
    );
    const head = `<p class="sync-attribution">Placed here by source <code>${escapeHtml(ctx.sourceWorkspaceFolderName)}</code> · source path <code>${escapeHtml(ctx.sourceRelPath)}</code></p>`;
    const blocking = vm.totals.updateCollision + vm.totals.warnings;
    const hasWork =
      vm.totals.create + vm.totals.updateTracked + vm.totals.deleteTracked + vm.totals.updateCollision > 0;
    const actions = renderRunSyncRow(hasWork, vm.totals.updateCollision, vm.totals.warnings);
    const html = `<div class="sync-target">${head}${renderPlanPairs(vm)}${actions}</div>`;
    return { html, plans, blocking, hasWork };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`viewer: dest-mapped scoped-plan failed — ${message}`);
    return bannerOnly(`<div class="sync-banner muted">Could not build scoped plan: ${escapeHtml(message)}</div>`);
  }
}

/**
 * Render the Run Sync action row appended to a scoped plan section. The button
 * is disabled (with an explanatory hint) when there's nothing to do or when
 * collisions/warnings would block — same gating as the admin/config editors.
 * Per-row decisions for collisions and the orange "Proceed with safe items
 * only" path live in the standalone plan webview; this per-file Run Sync is
 * green-path only by design.
 */
function renderRunSyncRow(hasWork: boolean, collisions: number, warnings: number): string {
  let hint = '';
  let disabled = '';
  const blocking = collisions + warnings;
  if (blocking > 0) {
    disabled = ' disabled';
    const parts: string[] = [];
    if (collisions) parts.push(`${collisions} collision${collisions === 1 ? '' : 's'}`);
    if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
    hint = `${parts.join(' + ')} — open the workspace plan to decide per file.`;
  } else if (!hasWork) {
    disabled = ' disabled';
    hint = 'Nothing to sync — destination is up to date.';
  }
  return `<div class="sync-actions">
    <button id="sync-run-btn" class="action-btn sync-run-btn" type="button"${disabled} title="Apply the green-path operations from the plan above — limited to this file">Run Sync</button>
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
