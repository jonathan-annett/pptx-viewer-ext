// Status bar item showing the current sync topology at a glance.
//
// Two modes:
//   - Main-user mode (default): source-side surface. States:
//       · No workspace folders or no .sync.jsonc found → "No sync configuration"
//       · N sources, M destinations → "$(sync) Folder Sync: N src · M dest"
//       · Any error-severity diagnostic → "$(warning) Folder Sync: <count> issue(s)"
//   - Operator mode (M2 / destination-only workspace): inspection surface.
//     Text + click target come from `statusBarOperator.ts`; the click opens
//     the canonical manifest in the M6.E custom editor.
//
// Mode selection is driven by the destination-only state event from
// `destinationOnlyWired.ts`. Both that event and `manager.onDidChange`
// trigger a re-render; the render function reads the latest cached value
// of each input rather than re-deriving them.
//
// Main-user click target:
//   - The openPlan command — opens the workspace-wide plan webview, the
//     primary user action. The showTopology dump remains available via
//     the command palette for diagnostics.
//   - When no sync config exists, clicking falls back to showTopology —
//     there's no useful plan to open, but the topology dump explains the
//     empty state (which workspace folders were considered, why nothing
//     matched, etc.).

import * as vscode from 'vscode';
import type { SyncManager } from './manager';
import type { ResolvedTopology } from './topology';
import {
  getDestinationOnlyState,
  onDidChangeDestinationOnlyState,
  type DestinationOnlyState,
} from './destinationOnlyWired';
import {
  formatOperatorText,
  pickOperatorClickTarget,
} from './statusBarOperator';

const COMMAND_PLAN = 'folderSync.openPlan';
const COMMAND_TOPOLOGY = 'folderSync.showTopology';

export function createStatusBarItem(
  context: vscode.ExtensionContext,
  manager: SyncManager,
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = COMMAND_PLAN;
  context.subscriptions.push(item);

  // Cache the latest input for each driver so a fire on one doesn't lose
  // the other's value. Initial topology comes from the manager directly;
  // initial destination-only state from the wired layer's accessor (the
  // first emit may race the manager.onDidChange below).
  let lastTopology: ResolvedTopology = manager.getTopology();
  let lastDestState: DestinationOnlyState = getDestinationOnlyState();

  const rerender = (): void => render(item, lastTopology, lastDestState);

  context.subscriptions.push(
    manager.onDidChange((topology) => {
      lastTopology = topology;
      rerender();
    }),
    onDidChangeDestinationOnlyState((state) => {
      lastDestState = state;
      rerender();
    }),
  );

  item.show();
  return item;
}

function render(
  item: vscode.StatusBarItem,
  topology: ResolvedTopology,
  destState: DestinationOnlyState,
): void {
  if (destState.isDestinationOnly) {
    renderOperator(item, destState);
    return;
  }
  renderMainUser(item, topology);
}

function renderOperator(item: vscode.StatusBarItem, destState: DestinationOnlyState): void {
  const { text, tooltip } = formatOperatorText(destState.canonicalManifest);
  item.text = text;
  item.tooltip = tooltip;
  // Operator mode is purely informational — no errors/warnings surface here
  // (those would mean source-side state, which doesn't apply). Plain
  // background keeps it visually distinct from the main-user error state.
  item.backgroundColor = undefined;
  const command = pickOperatorClickTarget(destState.canonicalManifest);
  // StatusBarItem.command accepts string | Command | undefined.
  item.command = command;
}

function renderMainUser(item: vscode.StatusBarItem, topology: ResolvedTopology): void {
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
