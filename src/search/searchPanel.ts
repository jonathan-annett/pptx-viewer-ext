// Wired webview panel for pptx search.
//
// Pure rendering lives in `searchPanelHtml.ts`; this module only knows about
// vscode + the indexer/engine handles. Lifecycle:
//   1. Open or reveal a singleton panel. Two panels racing on postMessage
//      against the same engine would duplicate work — one is plenty for v1.
//   2. Render the initial HTML with a fresh nonce.
//   3. Subscribe to indexer progress so the footer stays live during cold
//      walks. Dispose the subscription with the panel.
//   4. Dispatch panel messages: `search` → engine.search → postMessage
//      `results`; `reindex` → indexer.refresh; `open` → workbench command.
//
// CSP per substrate convention: default-src 'none'; style-src 'unsafe-inline';
// img-src data:; script-src 'nonce-<random>';
//
// retainContextWhenHidden: true. Clicking a search result opens the file in
// the same column as the panel, which hides the webview tab; without this
// flag the webview process tears down and the input + results are lost on
// return. Memory cost is small (the result DOM caps at MAX_RESULTS rows).

import * as vscode from 'vscode';
import { log } from '../log';
import type { SearchHit } from './index-types';
import type { SearchEngine } from './searchEngine';
import type { SearchIndexerHandle, IndexerProgress } from './indexer';
import { renderSearchPanelHtml } from './searchPanelHtml';
import { groupHitsByFolder, folderLabelFor } from './scope';
import {
  renderSearchUpdateModalHtml,
  renderSearchUpdateIdenticalModalHtml,
} from './updateModalHtml';
import { getParseCacheSingleton, parsePptxCached } from '../sync/parseCache';

export interface OpenSearchPanelDeps {
  engine: SearchEngine;
  indexer: SearchIndexerHandle;
}

// Singleton — we only ever want one search panel active at a time. Tracked
// at module scope rather than via vscode's webview serializer because the
// panel state is reconstructible from the indexer and we don't need
// post-reload persistence in v1.
let currentPanel: vscode.WebviewPanel | undefined;

/**
 * Open the search panel, or reveal it if already open. Idempotent — calling
 * the command twice in a row brings the existing panel to the front.
 */
export function openSearchPanel(deps: OpenSearchPanelDeps): void {
  if (currentPanel) {
    currentPanel.reveal(undefined, false);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'pptxSearch.panel',
    'Presentation Search',
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );
  currentPanel = panel;

  const nonce = makeNonce();
  const scope = deps.indexer.getScope();
  const stats = deps.engine.stats();
  panel.webview.html = renderSearchPanelHtml(
    {
      indexedDone: stats.projections,
      indexedTotal: stats.projections,
      scopeFolderCount: scope.folderUris.length,
    },
    nonce,
  );
  log(
    `pptxSearch: panel opened — scope folders=${scope.folderUris.length} ` +
      `projections=${stats.projections} uris=${stats.uris}`,
  );

  // Forward indexer progress to the panel so the footer stays live during
  // walks. Disposed when the panel goes away.
  const progressSub = deps.indexer.onProgress((p: IndexerProgress) => {
    void panel.webview.postMessage({
      type: p.phase === 'idle' ? 'indexComplete' : 'indexProgress',
      phase: p.phase,
      done: p.done,
      total: p.total,
    });
  });

  // Per-panel pending-update slot. Stashed when handleUpdateFile finishes
  // reading + parsing both files and posts the compare modal; cleared on
  // updateCancel or after a successful updateConfirm. Holds the source bytes
  // so the confirm path doesn't have to re-read (the source might be on a
  // slow file system or might already have changed under us — capture the
  // exact bytes the user saw in the modal).
  let pendingUpdate: PendingUpdate | null = null;

  panel.webview.onDidReceiveMessage(async (msg: unknown) => {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: unknown };
    if (m.type === 'search') {
      const q = typeof (msg as { query?: unknown }).query === 'string'
        ? ((msg as { query: string }).query)
        : '';
      handleSearch(panel, deps.engine, deps.indexer, q);
      return;
    }
    if (m.type === 'open') {
      const uri = typeof (msg as { uri?: unknown }).uri === 'string'
        ? ((msg as { uri: string }).uri)
        : '';
      handleOpen(uri);
      return;
    }
    if (m.type === 'reindex') {
      log('pptxSearch: reindex requested from panel');
      void deps.indexer.refresh().catch((err) => {
        log(
          `pptxSearch: reindex failed — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
      return;
    }
    if (m.type === 'updateFile') {
      const targetUriStr = typeof (msg as { targetUri?: unknown }).targetUri === 'string'
        ? ((msg as { targetUri: string }).targetUri)
        : '';
      const sourceUriStr = typeof (msg as { sourceUri?: unknown }).sourceUri === 'string'
        ? ((msg as { sourceUri: string }).sourceUri)
        : '';
      pendingUpdate = await handleUpdateFile(panel, deps.indexer, targetUriStr, sourceUriStr);
      return;
    }
    if (m.type === 'updateConfirm') {
      const mode = (msg as { mode?: unknown }).mode === 'update-remove' ? 'update-remove' : 'update';
      const slot = pendingUpdate;
      pendingUpdate = null;
      if (!slot) {
        log('pptxSearch: updateConfirm with no pending update — ignoring');
        return;
      }
      await handleUpdateConfirm(panel, slot, mode);
      return;
    }
    if (m.type === 'updateCancel') {
      if (pendingUpdate) {
        log(
          `pptxSearch: updateCancel — discarded pending update ` +
            `(${pendingUpdate.candidateFileName} → ${pendingUpdate.targetFileName})`,
        );
      }
      pendingUpdate = null;
      void panel.webview.postMessage({ type: 'updateModalClose' });
      return;
    }
  });

  panel.onDidDispose(() => {
    progressSub.dispose();
    pendingUpdate = null;
    if (currentPanel === panel) currentPanel = undefined;
    log('pptxSearch: panel disposed');
  });
}

// ───── update-file flow ─────────────────────────────────────────────────
//
// The search panel surfaces a "primed" pair of selections — exactly one file
// in groups[0] (canonical) and one in another group (remote/dropbox). On
// click of the Update-file button the panel posts `updateFile` with both
// URI strings; this layer:
//   1. Parses both URIs, validates they're under scope.
//   2. Reads + parses both files. If the source's sha256 matches the
//      target's, posts the identical-files modal (Cancel only).
//   3. Otherwise posts the side-by-side compare modal with three buttons:
//      Cancel / Update file / Update & remove source.
//   4. On `updateConfirm`, calls handleUpdateConfirm which mirrors the
//      `handleIngest` picker/upload path: parse-cache eviction → writeFile
//      to target → (optional) delete source → open the target in the viewer.
//
// We re-use the same parsePptxCached + getParseCacheSingleton().forget()
// primitives the viewer's ingest path uses, so the update goes through the
// same cache lifecycle as a Browse-to-Update or phone-upload affirmation.

interface PendingUpdate {
  targetUri: vscode.Uri;
  sourceUri: vscode.Uri;
  candidateBytes: Uint8Array;
  candidateSha: string;
  candidateFileName: string;
  targetFileName: string;
}

async function handleUpdateFile(
  panel: vscode.WebviewPanel,
  indexer: SearchIndexerHandle,
  targetUriStr: string,
  sourceUriStr: string,
): Promise<PendingUpdate | null> {
  if (!targetUriStr || !sourceUriStr) {
    log('pptxSearch: updateFile — missing target or source URI');
    return null;
  }
  let targetUri: vscode.Uri;
  let sourceUri: vscode.Uri;
  try {
    targetUri = vscode.Uri.parse(targetUriStr);
    sourceUri = vscode.Uri.parse(sourceUriStr);
  } catch (err) {
    log(
      `pptxSearch: updateFile — invalid URI — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  // Resolve folder labels by longest-prefix match against scope. Mirrors the
  // bucketing inside groupHitsByFolder so the modal headers read the same
  // way the search-panel groups do.
  const scope = indexer.getScope();
  const targetFolderLabel = folderLabelFor(longestScopePrefix(scope.folderUris, targetUriStr) ?? '');
  const candidateFolderLabel = folderLabelFor(longestScopePrefix(scope.folderUris, sourceUriStr) ?? '');

  const targetFileName = basenameFromUri(targetUri);
  const candidateFileName = basenameFromUri(sourceUri);

  // Read + parse both files. parsePptxCached uses the URI-hash cache under
  // the hood so a recently-indexed file hits cache and pays only a hash.
  let targetBytes: Uint8Array;
  let candidateBytes: Uint8Array;
  try {
    targetBytes = await vscode.workspace.fs.readFile(targetUri);
    candidateBytes = await vscode.workspace.fs.readFile(sourceUri);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`pptxSearch: updateFile — read failed — ${message}`);
    void panel.webview.postMessage({
      type: 'updateResult',
      outcome: 'error',
      message: `Could not read file: ${message}`,
    });
    return null;
  }

  const cache = getParseCacheSingleton();
  let targetParse, candidateParse;
  try {
    const [targetStat, sourceStat] = await Promise.all([
      vscode.workspace.fs.stat(targetUri),
      vscode.workspace.fs.stat(sourceUri),
    ]);
    [targetParse, candidateParse] = await Promise.all([
      parsePptxCached(
        targetBytes,
        { fileName: targetFileName, size: targetStat.size, mtime: targetStat.mtime },
        cache,
      ),
      parsePptxCached(
        candidateBytes,
        { fileName: candidateFileName, size: sourceStat.size, mtime: sourceStat.mtime },
        cache,
      ),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`pptxSearch: updateFile — parse failed — ${message}`);
    void panel.webview.postMessage({
      type: 'updateResult',
      outcome: 'error',
      message: `Could not parse file: ${message}`,
    });
    return null;
  }

  // Identical content → Cancel-only modal. Don't stash a pending update —
  // there's nothing to confirm.
  if (candidateParse.result.sha256 === targetParse.result.sha256) {
    const html = renderSearchUpdateIdenticalModalHtml({
      targetFileName,
      candidateFileName,
      targetFolderLabel,
      candidateFolderLabel,
      sha256: candidateParse.result.sha256,
    });
    void panel.webview.postMessage({ type: 'updateModal', html });
    log(
      `pptxSearch: updateFile — identical content (sha256=${candidateParse.result.sha256.slice(
        0,
        12,
      )}…), no update offered`,
    );
    return null;
  }

  const html = renderSearchUpdateModalHtml({
    target: targetParse.result,
    candidate: candidateParse.result,
    targetFolderLabel,
    candidateFolderLabel,
  });
  void panel.webview.postMessage({ type: 'updateModal', html });
  log(
    `pptxSearch: updateFile — comparing ${candidateFileName} ` +
      `(sha=${candidateParse.result.sha256.slice(0, 12)}…) → ${targetFileName} ` +
      `(sha=${targetParse.result.sha256.slice(0, 12)}…)`,
  );

  return {
    targetUri,
    sourceUri,
    candidateBytes,
    candidateSha: candidateParse.result.sha256,
    candidateFileName,
    targetFileName,
  };
}

async function handleUpdateConfirm(
  panel: vscode.WebviewPanel,
  slot: PendingUpdate,
  mode: 'update' | 'update-remove',
): Promise<void> {
  const cache = getParseCacheSingleton();
  try {
    // Evict the parse-cache entry for the candidate sha before write. Mirrors
    // the picker/upload path in provider.ts/handleIngest: the about-to-be-
    // written file's cache entry could be stale (e.g. parser change since it
    // was last cached); a scoped forget() guarantees the post-write re-read
    // produces a fresh ParseResult.
    if (cache) {
      await cache.forget(slot.candidateSha);
      log(
        `pptxSearch: update — evicted parse-cache entry for sha=${slot.candidateSha.slice(
          0,
          12,
        )}…`,
      );
    }
    await vscode.workspace.fs.writeFile(slot.targetUri, slot.candidateBytes);
    log(
      `pptxSearch: update — wrote ${slot.candidateBytes.byteLength} bytes to ` +
        `${slot.targetUri.toString()}`,
    );

    let removed = false;
    if (mode === 'update-remove') {
      try {
        await vscode.workspace.fs.delete(slot.sourceUri, { useTrash: false });
        removed = true;
        log(`pptxSearch: update — removed source ${slot.sourceUri.toString()}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`pptxSearch: update — delete source failed (write already done) — ${message}`);
        // The target write already succeeded; the operation is partially
        // complete. Tell the panel the update happened but the source wasn't
        // removed, and surface the error in a toast so the user can clean up
        // manually.
        void vscode.window.showWarningMessage(
          `Updated ${slot.targetFileName}, but could not delete source: ${message}`,
        );
        void panel.webview.postMessage({
          type: 'updateResult',
          outcome: 'updated',
          targetUri: slot.targetUri.toString(),
          sourceUri: slot.sourceUri.toString(),
        });
        await openTargetInViewer(slot.targetUri);
        return;
      }
    }

    // Open the canonical viewer for the freshly-written file. The viewer
    // re-reads bytes via resolveCustomEditor and renders the new content;
    // no special message needed.
    await openTargetInViewer(slot.targetUri);

    void panel.webview.postMessage({
      type: 'updateResult',
      outcome: removed ? 'updated-removed' : 'updated',
      targetUri: slot.targetUri.toString(),
      sourceUri: slot.sourceUri.toString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`pptxSearch: update — write failed — ${message}`);
    void panel.webview.postMessage({
      type: 'updateResult',
      outcome: 'error',
      message,
    });
  }
}

async function openTargetInViewer(targetUri: vscode.Uri): Promise<void> {
  try {
    // Open beside the search panel so the user keeps the search results
    // visible alongside the viewer — they're likely going to process more
    // files in the same batch.
    await vscode.commands.executeCommand('vscode.open', targetUri, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
    });
  } catch (err) {
    log(
      `pptxSearch: update — failed to open viewer for ${targetUri.toString()} — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function basenameFromUri(uri: vscode.Uri): string {
  const tail = uri.path.split('/').pop() ?? '';
  try {
    return decodeURIComponent(tail) || tail || uri.toString();
  } catch {
    return tail || uri.toString();
  }
}

function longestScopePrefix(folderUris: readonly string[], fileUri: string): string | null {
  let best = '';
  for (const folder of folderUris) {
    const prefix = folder.endsWith('/') ? folder : `${folder}/`;
    if (fileUri === folder || fileUri.startsWith(prefix)) {
      if (folder.length > best.length) best = folder;
    }
  }
  return best || null;
}

function handleSearch(
  panel: vscode.WebviewPanel,
  engine: SearchEngine,
  indexer: SearchIndexerHandle,
  query: string,
): void {
  let hits: SearchHit[] = [];
  try {
    hits = engine.search(query);
  } catch (err) {
    log(
      `pptxSearch: search threw — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  // Echo `query` back so the webview can drop stale results when the user
  // types fast. Cap result count to keep webview message size sane —
  // a query that matches every file in a 3000-deck folder doesn't need to
  // ship all 3000 hits across the postMessage boundary; the top slice is
  // overwhelmingly what users act on.
  const MAX_RESULTS = 200;
  const trimmed = hits.length > MAX_RESULTS ? hits.slice(0, MAX_RESULTS) : hits;
  // Bucket by scope folder before sending. The pure helper preserves scope
  // order, which is the workspace-folder declaration order — what the user
  // sees in the explorer matches what they see here.
  const groups = groupHitsByFolder(trimmed, indexer.getScope());
  void panel.webview.postMessage({
    type: 'results',
    query,
    groups,
    truncated: hits.length > MAX_RESULTS,
    totalMatches: hits.length,
  });
}

function handleOpen(uri: string): void {
  if (!uri) return;
  let parsed: vscode.Uri;
  try {
    parsed = vscode.Uri.parse(uri);
  } catch (err) {
    log(
      `pptxSearch: open failed — invalid URI "${uri}" — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  // Open in the default custom editor — vscode.open accepts a URI and
  // delegates to whatever editor is registered for the file type. For a
  // .pptx that hits our viewer; for any other extension it falls back to
  // the platform default. This is the same command the explorer uses on
  // double-click.
  void vscode.commands.executeCommand('vscode.open', parsed).then(
    () => log(`pptxSearch: opened ${uri}`),
    (err: unknown) =>
      log(
        `pptxSearch: open failed for ${uri} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
  );
}

// Per substrate convention — same as provider.ts / planView.ts. Inlined
// here rather than imported to keep the search subsystem self-contained.
function makeNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Diagnostic: log index + store stats and a sample of entries to the output
 * channel. Removed at M6 polish. Cheap; safe to call anytime.
 */
export async function probeSearchIndex(deps: {
  engine: SearchEngine;
  indexer: SearchIndexerHandle;
}): Promise<void> {
  const engineStats = deps.engine.stats();
  const indexerStats = deps.indexer.stats();
  const scope = deps.indexer.getScope();
  log('pptxSearch: probeIndex — engine + indexer snapshot');
  log(`  scope folders: ${scope.folderUris.length}`);
  for (const f of scope.folderUris) log(`    - ${f}`);
  log(
    `  engine: projections=${engineStats.projections} uris=${engineStats.uris}`,
  );
  log(
    `  indexer: processed=${indexerStats.processed} ` +
      `indexStoreHits=${indexerStats.indexStoreHits} ` +
      `parseCacheHits=${indexerStats.parseCacheHits} ` +
      `fresh=${indexerStats.freshParses} errors=${indexerStats.errors}`,
  );
  // Sample up to 5 URIs and their projections so a sign-off run can
  // eyeball that filenames + authors look right. URIs → sha → projection
  // is two hops via the engine's lookup helpers.
  const sample = deps.engine.getAllUris().slice(0, 5);
  for (const uri of sample) {
    const sha = deps.engine.getShaForUri(uri);
    const projection = sha ? deps.engine.getProjection(sha) : undefined;
    if (projection) {
      log(
        `  sample: ${uri} → ${projection.filename} ` +
          `(author=${projection.author || '(none)'}, ` +
          `slideText=${(projection.slideText || '').length} chars)`,
      );
    } else {
      log(`  sample: ${uri} → (no projection)`);
    }
  }
}
