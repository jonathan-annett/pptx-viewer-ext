// Status bar item showing the current sync topology at a glance.
//
// States:
//   - No workspace folders or no .sync.jsonc found → "No sync configuration"
//   - N sources, M destinations → "$(sync) Folder Sync: N src · M dest"
//   - Any error-severity diagnostic → "$(warning) Folder Sync: <count> issue(s)"
//
// Click target (M6): the openPlan command — opens the workspace-wide plan
// webview, the primary user action. The showTopology dump remains available
// via the command palette for diagnostics.
//
// When no sync config exists, clicking falls back to showTopology — there's
// no useful plan to open, but the topology dump explains the empty state
// (which workspace folders were considered, why nothing matched, etc.).

import * as vscode from 'vscode';
import type { SyncManager } from './manager';
import type { ResolvedTopology } from './topology';

const COMMAND_PLAN = 'folderSync.openPlan';
const COMMAND_TOPOLOGY = 'folderSync.showTopology';

export function createStatusBarItem(
  context: vscode.ExtensionContext,
  manager: SyncManager,
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  // Default click target — overridden to COMMAND_TOPOLOGY in render() when
  // no sync config exists, since "open plan" on an empty topology would
  // just show an empty webview.
  item.command = COMMAND_PLAN;
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
    item.tooltip = 'No .sync.jsonc files in the workspace. Click for details.';
    item.backgroundColor = undefined;
    // Empty topology has no plan to show; click falls back to topology dump
    // so the user can see which folders were considered and why none matched.
    item.command = COMMAND_TOPOLOGY;
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
    // Errors are config-level, so jumping to the plan webview would surface
    // the errors as skip reasons — but the topology dump is the more direct
    // diagnostic view. Route there.
    item.command = COMMAND_TOPOLOGY;
    return;
  }

  const warnSuffix = warnCount > 0 ? `  ($(warning) ${warnCount})` : '';
  item.text = `$(sync) Folder Sync: ${topology.sources.length} src · ${destCount} dest${warnSuffix}`;
  item.tooltip =
    `${topology.sources.length} source(s), ${destCount} destination(s)` +
    (warnCount > 0 ? `, ${warnCount} warning(s)` : '') +
    '. Click to open sync plan (palette: "Folder Sync: Show Topology" for diagnostics).';
  item.backgroundColor =
    warnCount > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  // Healthy path → primary action is the workspace-wide plan.
  item.command = COMMAND_PLAN;
}
