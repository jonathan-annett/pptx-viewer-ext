// Custom read-only editor for *.pptx files.
//
// Flow:
//   openCustomDocument  -> return a thin wrapper around the URI
//   resolveCustomEditor -> read bytes via vscode.workspace.fs, parse, render HTML

import * as vscode from 'vscode';
import { parsePptx } from './pptx';
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

    // Save flow runs through VS Code APIs rather than a browser-native blob
    // download. The earlier blob + <a download> approach (even with
    // synchronous click + pre-loaded bytes to preserve user activation) was
    // silently dropped by the web-webview's sandbox/cross-origin policy on
    // vscode.dev — anchor.click() returned without exception but no file was
    // saved. showSaveDialog runs in the extension host, outside any iframe
    // sandbox, and writeFile uses whatever filesystem provider is registered
    // (on vscode.dev with an FSA-mounted folder, that's actual local disk).
    webviewPanel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: unknown; message?: unknown };
      if (m.type === 'download-log' && typeof m.message === 'string') {
        log(`download[webview]: ${m.message}`);
        return;
      }
      if (m.type !== 'save-as') return;
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
