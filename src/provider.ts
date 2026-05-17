// Custom read-only editor for *.pptx files.
//
// Flow:
//   openCustomDocument  -> return a thin wrapper around the URI
//   resolveCustomEditor -> read bytes via vscode.workspace.fs, parse, render HTML

import * as vscode from 'vscode';
import { parsePptx, bytesToBase64 } from './pptx';
import { renderHtml, renderError } from './webview';
import { log } from './log';

class PptxDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {
    // no resources held
  }
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
    // Scripts enabled for the download button. The webview's CSP gates execution
    // via a per-render nonce; we don't allow inline scripts without a nonce and
    // we don't load remote scripts at all.
    webviewPanel.webview.options = { enableScripts: true };

    const fileName = document.uri.path.split('/').pop() ?? 'unknown.pptx';
    log(`open: ${document.uri.toString()}`);

    // The webview only sends us diagnostic log lines now — the download flow
    // itself runs entirely inside the webview using bytes we pre-load below.
    //
    // Why pre-load: browsers gate "save file" anchor clicks on a fresh user-
    // activation token. The earlier on-demand design ran an async round-trip
    // (click → postMessage → workspace.fs.readFile → postMessage → blob → click)
    // and by the time anchor.click() fired, activation had expired and the
    // browser silently refused the download. We avoid the round-trip by
    // shipping the bytes to the webview right after render and letting the
    // click handler do its work synchronously — activation is still live.
    webviewPanel.webview.onDidReceiveMessage((msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: unknown; message?: unknown };
      if (m.type === 'download-log' && typeof m.message === 'string') {
        log(`download[webview]: ${m.message}`);
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
      webviewPanel.webview.html = renderHtml(result, makeNonce());

      // Ship the bytes to the webview so the Download button can build a Blob
      // synchronously inside the user-activation window. We reuse the bytes
      // already in memory from the parse step — no second readFile. The base64
      // encoding is a one-time cost amortised across however many times the
      // user clicks Download in this panel session.
      const base64 = bytesToBase64(bytes);
      log(`download preload: ${fileName} (${bytes.byteLength} bytes → ${base64.length} b64 chars)`);
      webviewPanel.webview.postMessage({
        type: 'preload',
        base64,
        byteLength: bytes.byteLength,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`ERROR opening ${fileName}: ${message}`);
      webviewPanel.webview.html = renderError(document.uri.path, message);
    }
  }
}

// Cryptographically-random nonce for the webview's CSP. 16 bytes → 32 hex chars
// is comfortably above the "guessable" line and well below any header-size
// concern. crypto.getRandomValues is available in the web-extension worker.
function makeNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
