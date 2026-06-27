// Wired webview panel for pptx search.
//
// Pure rendering lives in `searchPanelHtml.ts`; this module only knows about
// vscode + the indexer/engine handles. Lifecycle:
//   1. Open or reveal a singleton panel.
//   2. Render the initial HTML with a fresh nonce.
//   3. Subscribe to indexer progress so the footer stays live during cold
//      walks. Dispose the subscription with the panel.
//   4. Dispatch panel messages: `search` → engine.search → postMessage
//      `results`; `reindex` → indexer.refresh; `open` → workbench command.
//
// SLIM build: a basic find-and-open surface. The result-Update flow (compare
// modal, "Update file", archive/sync to destinations) moved to the PWA.
//
// retainContextWhenHidden: true. Clicking a search result opens the file in
// the same column as the panel, which hides the webview tab; without this
// flag the webview process tears down and the input + results are lost on
// return.

import * as vscode from 'vscode';
import { log } from '../log';
import type { SearchHit } from './index-types';
import type { SearchEngine } from './searchEngine';
import type { SearchIndexerHandle, IndexerProgress } from './indexer';
import { renderSearchPanelHtml } from './searchPanelHtml';
import { groupHitsByFolder } from './scope';

export interface OpenSearchPanelDeps {
  engine: SearchEngine;
  indexer: SearchIndexerHandle;
}

// Singleton — we only ever want one search panel active at a time.
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
      errors: p.errors,
      scopeFolderCount: p.scopeFolderCount,
    });
  });

  panel.webview.onDidReceiveMessage(async (msg: unknown) => {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: unknown };
    if (m.type === 'search') {
      const q = typeof (msg as { query?: unknown }).query === 'string'
        ? ((msg as { query: string }).query)
        : '';
      const op = (msg as { op?: unknown }).op === 'or' ? 'or' : 'and';
      handleSearch(panel, deps.engine, deps.indexer, q, op);
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
  indexer: SearchIndexerHandle,
  query: string,
  op: 'and' | 'or',
): void {
  let hits: SearchHit[] = [];
  try {
    hits = engine.search(query, op);
  } catch (err) {
    log(
      `pptxSearch: search threw — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  // Cap result count to keep webview message size sane.
  const MAX_RESULTS = 200;
  const trimmed = hits.length > MAX_RESULTS ? hits.slice(0, MAX_RESULTS) : hits;
  // Bucket by scope folder before sending. includeEmpty surfaces every scope
  // folder as a group so the panel can offer a persistent collapse toggle.
  const groups = groupHitsByFolder(trimmed, indexer.getScope(), workspaceFolderNames(), {
    includeEmpty: true,
  });
  void panel.webview.postMessage({
    type: 'results',
    query,
    groups,
    truncated: hits.length > MAX_RESULTS,
    totalMatches: hits.length,
  });
}

/**
 * Map of workspace-folder URI string → display name. Used to label search
 * groups with the friendly name rather than the URI basename.
 */
function workspaceFolderNames(): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    map.set(f.uri.toString(), f.name);
  }
  return map;
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
  // Open in the default custom editor — vscode.open delegates to whatever
  // editor is registered for the file type (our viewer for .pptx/.pdf).
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

// Per substrate convention. Inlined to keep the search subsystem self-contained.
function makeNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
