// Web extension entrypoint.
// Runs inside a web worker in vscode.dev — no Node APIs available.
import * as vscode from 'vscode';
import { PptxEditorProvider } from './provider';
import { initLog, log } from './log';

export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  log(`activate: pptx-viewer ${packageVersion(context)} loaded`);
  context.subscriptions.push(PptxEditorProvider.register());
  log('activate: custom editor registered for *.pptx');
}

export function deactivate(): void {
  log('deactivate');
}

function packageVersion(context: vscode.ExtensionContext): string {
  // context.extension is set when the activation context is fully wired up.
  // Fall back to "?" if it's not available (older API surfaces).
  return (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '?';
}
