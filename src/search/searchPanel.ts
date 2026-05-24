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
// No retainContextWhenHidden: the panel re-renders cleanly from initial
// state when the user re-reveals it. Search input contents would be lost
// across tab switches, but for v1 that's an acceptable trade for not
// holding hundreds of KB of accumulated result DOM in memory.

import * as vscode from 'vscode';
import { log } from '../log';
import type { SearchHit } from './index-types';
import type { SearchEngine } from './searchEngine';
import type { SearchIndexerHandle, IndexerProgress } from './indexer';
import { renderSearchPanelHtml } from './searchPanelHtml';

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
      retainContextWhenHidden: false,
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

  panel.webview.onDidReceiveMessage((msg: unknown) => {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: unknown };
    if (m.type === 'search') {
      const q = typeof (msg as { query?: unknown }).query === 'string'
        ? ((msg as { query: string }).query)
        : '';
      handleSearch(panel, deps.engine, q);
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
  });

  panel.onDidDispose(() => {
    progressSub.dispose();
    if (currentPanel === panel) currentPanel = undefined;
    log('pptxSearch: panel disposed');
  });
}

function handleSearch(
  panel: vscode.WebviewPanel,
  engine: SearchEngine,
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
  void panel.webview.postMessage({
    type: 'results',
    query,
    hits: trimmed,
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
