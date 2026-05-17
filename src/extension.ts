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
  // Fire-and-forget: log build info once the FS read settles. We don't await
  // because activation should never block on this — it's diagnostic only.
  logBuildInfo(context);
}

export function deactivate(): void {
  log('deactivate');
}

function packageVersion(context: vscode.ExtensionContext): string {
  // context.extension is set when the activation context is fully wired up.
  // Fall back to "?" if it's not available (older API surfaces).
  return (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '?';
}

async function logBuildInfo(context: vscode.ExtensionContext): Promise<void> {
  // dist/build-info.json is written by the esbuild plugin on every (re)build.
  // Reading it at activation lets us print the exact build timestamp + git SHA
  // so a stale browser cache is immediately visible. Best-effort: if the file
  // is missing (built with an older esbuild config) we log that fact rather
  // than failing activation.
  try {
    const uri = vscode.Uri.joinPath(context.extensionUri, 'dist', 'build-info.json');
    const bytes = await vscode.workspace.fs.readFile(uri);
    const json = JSON.parse(new TextDecoder().decode(bytes)) as { buildTime?: string; gitSha?: string };
    log(`build: ${json.buildTime ?? '?'} sha=${json.gitSha ?? '?'}`);
  } catch (err) {
    log(`build: info unavailable (${err instanceof Error ? err.message : String(err)})`);
  }
}
