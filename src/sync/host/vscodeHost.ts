// VS Code implementations of the host seam (URI algebra + workspace provider).
//
// The filesystem impl lives in `../vscodeFs.ts` (`vscodeFs()`), kept there
// because several out-of-seam modules already import it. `extension.ts` wires
// all of these into `initHost()` at activation. Phase 2 moves the seam to
// `pptx-tools-core`; these VS Code impls stay in the extension.

import * as vscode from 'vscode';
import { isWebHost } from '../../host';
import type { UriHelper } from './uri';
import type { WorkspaceProvider, WorkspaceRoot } from './workspace';

/** URI algebra over `vscode.Uri` (paths are always forward-slash). */
export const vscodeUri: UriHelper<vscode.Uri> = {
  join(root, relPath) {
    const base = root.path.endsWith('/') ? root.path.slice(0, -1) : root.path;
    const sep = relPath.startsWith('/') ? '' : '/';
    return root.with({ path: `${base}${sep}${relPath}` });
  },
  dirname(uri) {
    // Robust to trailing slashes. URI path is always forward-slash.
    const path = uri.path;
    const idx = path.lastIndexOf('/');
    const parent = idx <= 0 ? '/' : path.slice(0, idx);
    return uri.with({ path: parent });
  },
  path(uri) {
    return uri.path;
  },
  parse(text) {
    return vscode.Uri.parse(text);
  },
};

/** Map a live `vscode.WorkspaceFolder` to a host-seam root. */
export function toWorkspaceRoot(folder: vscode.WorkspaceFolder): WorkspaceRoot<vscode.Uri> {
  return { id: folder.uri.toString(), name: folder.name, uri: folder.uri, status: 'ready' };
}

function currentRoots(): ReadonlyArray<WorkspaceRoot<vscode.Uri>> {
  return (vscode.workspace.workspaceFolders ?? []).map(toWorkspaceRoot);
}

export const vscodeWorkspaceProvider: WorkspaceProvider<vscode.Uri> = {
  listRoots: currentRoots,
  asRelativePath(uri) {
    // `false`: don't prefix the folder name when there's a single root —
    // matches the prior `vscode.workspace.asRelativePath(uri, false)` calls.
    return vscode.workspace.asRelativePath(uri, false);
  },
  isWebHost,
  // VS Code restores workspace folders natively across reloads, so "restore"
  // is just the current set. The PWA host (Phase 6) reads persisted handles.
  restore: currentRoots,
};
