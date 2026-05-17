// Centralised logging. Writes to both:
//   - A VS Code Output Channel ("Pptx Info") — view via View > Output > Pptx Info
//   - The DevTools console (Help > Toggle Developer Tools)
// Both targets get the same lines so whichever the human is looking at, they
// see activation and per-file events.

import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('Pptx Info');
  context.subscriptions.push(channel);
}

export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  // eslint-disable-next-line no-console
  console.log('[pptx-viewer]', message);
  channel?.appendLine(line);
}
