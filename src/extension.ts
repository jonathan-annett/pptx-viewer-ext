// Web extension entrypoint.
// Runs inside a web worker in vscode.dev — no Node APIs available.
import * as vscode from 'vscode';
import { PptxEditorProvider } from './provider';
import { initLog, log } from './log';
import { SyncManager } from './sync/manager';
import { createStatusBarItem } from './sync/statusBar';
import { buildDryRunPlan, formatDryRunPlan } from './sync/planner';

// The literal "__PPTX_BUILD_INFO_PLACEHOLDER__" is rewritten in the emitted
// bundle by esbuild's post-build plugin (see esbuild.config.js) into a JSON
// payload like '{"buildTime":"...","gitSha":"..."}' — different on every
// (re)build. We parse it once at activation. Using a placeholder string
// rather than esbuild `define` because `define` is cached at watch-mode
// context creation and would freeze the values at watcher start.
const BUILD_INFO_RAW = '__PPTX_BUILD_INFO_PLACEHOLDER__';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLog(context);
  log(`activate: pptx-viewer ${packageVersion(context)} loaded`);
  logBuildInfo();
  context.subscriptions.push(PptxEditorProvider.register());
  log('activate: custom editor registered for *.pptx');

  // Sync feature — M1: config layer + diagnostics. The manager owns yaml
  // discovery, hot-reload, and topology resolution. The status bar and the
  // showTopology command are surface layers over the manager's state.
  const manager = await SyncManager.create(context);
  createStatusBarItem(context, manager);
  context.subscriptions.push(
    vscode.commands.registerCommand('folderSync.showTopology', () => {
      log('sync: showTopology invoked');
      log('--- topology ---');
      for (const line of manager.dumpTopology().split('\n')) log(line);
      log('--- end topology ---');
      // Surface the Output Channel so the user can read what just printed.
      void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
    }),
    vscode.commands.registerCommand('folderSync.dryRunPlan', async () => {
      log('sync: dryRunPlan invoked');
      try {
        const plans = await buildDryRunPlan(manager.getTopology());
        for (const line of formatDryRunPlan(plans).split('\n')) log(line);
      } catch (err) {
        log(`sync: dryRunPlan failed — ${err instanceof Error ? err.message : String(err)}`);
      }
      void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
    }),
  );
  log('activate: folder sync manager initialised');
}

export function deactivate(): void {
  log('deactivate');
}

function packageVersion(context: vscode.ExtensionContext): string {
  // context.extension is set when the activation context is fully wired up.
  // Fall back to "?" if it's not available (older API surfaces).
  return (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '?';
}

function logBuildInfo(): void {
  // The unprocessed placeholder is not valid JSON, so JSON.parse will throw
  // and the catch branch surfaces the misconfiguration. After a successful
  // build the value is a JSON object string and parses cleanly.
  try {
    const info = JSON.parse(BUILD_INFO_RAW) as { buildTime?: string; gitSha?: string };
    log(`build: ${info.buildTime ?? '?'} sha=${info.gitSha ?? '?'}`);
  } catch (err) {
    log(`build: info unparseable raw=${BUILD_INFO_RAW.slice(0, 60)} (${err instanceof Error ? err.message : String(err)})`);
  }
}
