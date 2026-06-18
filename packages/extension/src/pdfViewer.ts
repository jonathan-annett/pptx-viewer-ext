// Custom read-only editor for *.pdf files.
//
// vscode.dev's default opener for PDFs is the plain-text editor, which
// surfaces binary noise. Since the search panel lists PDFs alongside pptx
// files, opening one would dump megabytes of garbled text into a tab. This
// minimal editor instead shows the same metadata grid as the pptx viewer
// plus a rendered first-page preview, so the user can confirm the file is
// what they expected without leaving the workspace.
//
// Flow:
//   openCustomDocument  -> trivial wrapper around the URI (matches PptxDocument)
//   resolveCustomEditor -> read bytes, stat, sha256, render shell with metadata,
//                          post bytes to the webview which uses the inlined
//                          pdfjs-dist bundle (via __pptxPdfImport) to render
//                          page 1 into an <img>.
//
// We deliberately do NOT cache the rendered image on the extension side. The
// webview pipeline is fast enough for an interactive open, and the parse-cache
// is keyed by pptx sha256 / shape — adding a parallel pdf preview cache is out
// of scope for v1 of the PDF viewer. If the viewer earns its keep we can plug
// it into the same IDB pattern parseCache.ts uses.

import * as vscode from 'vscode';
import { humanSize, formatTime } from 'pptx-tools-core/pptx';
import { sha256Hex } from 'pptx-tools-core/sync/hash';
import { log } from 'pptx-tools-core/log';
import { renderPdfViewerHtml, renderPdfViewerError } from 'pptx-tools-core/pdfViewerHtml';

class PdfDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {
    // no resources held
  }
}

export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
  public static readonly viewType = 'pptxViewer.pdfViewer';

  public static register(): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      PdfEditorProvider.viewType,
      new PdfEditorProvider(),
      {
        webviewOptions: { retainContextWhenHidden: false },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  async openCustomDocument(uri: vscode.Uri): Promise<PdfDocument> {
    return new PdfDocument(uri);
  }

  async resolveCustomEditor(
    document: PdfDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };

    const fileName = document.uri.path.split('/').pop() ?? 'unknown.pdf';
    log(`pdf-viewer: open ${document.uri.toString()}`);

    // Two-channel wiring:
    //   - viewer-log: forwards inline-script log lines into the Output channel
    //     so failures inside the pdfjs render are visible without devtools.
    //   - pdf-viewer-ready: the webview signals it's listening for bytes. We
    //     hold the bytes in a closure and post them on receipt rather than
    //     racing the render of the initial HTML.
    let pendingBytes: Uint8Array | null = null;
    let webviewReady = false;

    webviewPanel.webview.onDidReceiveMessage((msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: unknown; message?: unknown };
      if (m.type === 'viewer-log' && typeof m.message === 'string') {
        log(`pdf-viewer[${fileName}]: ${m.message}`);
        return;
      }
      if (m.type === 'pdf-viewer-ready') {
        webviewReady = true;
        if (pendingBytes) {
          webviewPanel.webview.postMessage({ type: 'pdfBytes', bytes: pendingBytes });
          log(`pdf-viewer[${fileName}]: posted ${pendingBytes.byteLength} bytes to ready webview`);
          pendingBytes = null;
        }
      }
    });

    try {
      const [bytes, stat] = await Promise.all([
        vscode.workspace.fs.readFile(document.uri),
        vscode.workspace.fs.stat(document.uri),
      ]);
      const sha = await sha256Hex(bytes);
      log(
        `pdf-viewer: parsed ${fileName} — ${bytes.byteLength} bytes, ` +
          `sha256=${sha.slice(0, 12)}…`,
      );

      const nonce = makeNonce();
      webviewPanel.webview.html = renderPdfViewerHtml({
        fileName,
        size: stat.size,
        sizeHuman: humanSize(stat.size),
        mtimeHuman: formatTime(stat.mtime),
        sha256: sha,
        nonce,
      });

      // If the webview's inline script has already signalled readiness before
      // setting .html resolved (unlikely but possible since setting .html
      // restarts the iframe), the ready handler picks up `pendingBytes` and
      // delivers them. Otherwise the ready handler post-message arrives after
      // the iframe boots and we send synchronously from there.
      if (webviewReady) {
        webviewPanel.webview.postMessage({ type: 'pdfBytes', bytes });
        log(`pdf-viewer[${fileName}]: posted ${bytes.byteLength} bytes to ready webview (immediate)`);
      } else {
        pendingBytes = bytes;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`pdf-viewer: ERROR opening ${fileName} — ${message}`);
      webviewPanel.webview.html = renderPdfViewerError(document.uri.path, message);
    }
  }
}

// Cryptographically-random nonce for the webview's CSP. Matches the pptx
// viewer's makeNonce — 16 bytes → 32 hex chars.
function makeNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
