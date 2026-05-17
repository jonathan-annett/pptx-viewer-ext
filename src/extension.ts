// Web extension entrypoint.
// Runs inside a web worker in vscode.dev — no Node APIs available.
import * as vscode from 'vscode';
import { PptxEditorProvider } from './provider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(PptxEditorProvider.register());
}

export function deactivate(): void {
  // nothing to clean up
}
