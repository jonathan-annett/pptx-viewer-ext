// Status bar item showing the current sync topology at a glance.
//
// States:
//   - No workspace folders or no .sync.yaml found → "No sync configuration"
//   - N sources, M destinations → "$(sync) Folder Sync: N src · M dest"
//   - Any error-severity diagnostic → "$(warning) Folder Sync: <count> issue(s)"
//
// Click target: the showTopology command, which dumps detail to the Output Channel.

import * as vscode from 'vscode';
import type { SyncManager } from './manager';
import type { ResolvedTopology } from './topology';

const COMMAND_ID = 'folderSync.showTopology';

export function createStatusBarItem(
  context: vscode.ExtensionContext,
  manager: SyncManager,
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = COMMAND_ID;
  context.subscriptions.push(item);

  const subscription = manager.onDidChange((topology) => {
    render(item, topology);
  });
  context.subscriptions.push(subscription);

  item.show();
  return item;
}

function render(item: vscode.StatusBarItem, topology: ResolvedTopology): void {
  const errorCount = topology.diagnostics.filter((d) => d.severity === 'error').length;
  const warnCount = topology.diagnostics.filter((d) => d.severity === 'warning').length;

  if (topology.sources.length === 0 && topology.failed.length === 0) {
    item.text = 'No sync configuration';
    item.tooltip = 'No .sync.yaml files in the workspace. Click for details.';
    item.backgroundColor = undefined;
    return;
  }

  const destCount = topology.sources.reduce((acc, s) => acc + s.destinations.length, 0);

  if (errorCount > 0) {
    item.text = `$(warning) Folder Sync: ${errorCount} issue${errorCount === 1 ? '' : 's'}`;
    item.tooltip =
      `${errorCount} configuration error(s)` +
      (warnCount > 0 ? `, ${warnCount} warning(s)` : '') +
      '. Click for details.';
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    return;
  }

  const warnSuffix = warnCount > 0 ? `  ($(warning) ${warnCount})` : '';
  item.text = `$(sync) Folder Sync: ${topology.sources.length} src · ${destCount} dest${warnSuffix}`;
  item.tooltip =
    `${topology.sources.length} source(s), ${destCount} destination(s)` +
    (warnCount > 0 ? `, ${warnCount} warning(s)` : '') +
    '. Click for topology.';
  item.backgroundColor =
    warnCount > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
}
