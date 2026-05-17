// Custom read-only editor for *.pptx files.
//
// Flow:
//   openCustomDocument  -> return a thin wrapper around the URI
//   resolveCustomEditor -> read bytes via vscode.workspace.fs, parse, render HTML

import * as vscode from 'vscode';
import { parsePptx } from './pptx';
import { renderHtml, renderError } from './webview';

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
    // No scripts needed — pure static HTML/CSS panel.
    webviewPanel.webview.options = { enableScripts: false };

    try {
      const [bytes, stat] = await Promise.all([
        vscode.workspace.fs.readFile(document.uri),
        vscode.workspace.fs.stat(document.uri),
      ]);
      const fileName = document.uri.path.split('/').pop() ?? 'unknown.pptx';
      const result = await parsePptx(bytes, {
        fileName,
        size: stat.size,
        mtime: stat.mtime,
      });
      webviewPanel.webview.html = renderHtml(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      webviewPanel.webview.html = renderError(document.uri.path, message);
    }
  }
}
