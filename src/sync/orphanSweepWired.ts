// vscode-wired adapter for the pure `sweepOrphanTmpFiles` helper.
// Kept separate from `orphanSweep.ts` so the pure half stays tsx-testable.

import * as vscode from 'vscode';
import type { SweepFs, FileTypeBits } from './orphanSweep';

/**
 * `vscode.workspace.fs` adapter for the sweep. Lives in its own module
 * (rather than reusing `vscodeFs()`) because the sweep needs
 * `readDirectory`, which the executor's `SyncFs` contract doesn't expose.
 */
export function vscodeSweepFs(): SweepFs<vscode.Uri> {
  return {
    joinPath(root, relPath) {
      const base = root.path.endsWith('/') ? root.path.slice(0, -1) : root.path;
      const sep = relPath.startsWith('/') ? '' : '/';
      return root.with({ path: `${base}${sep}${relPath}` });
    },
    readDirectory: (uri) =>
      Promise.resolve(vscode.workspace.fs.readDirectory(uri)) as Promise<
        Array<[string, FileTypeBits]>
      >,
    delete: (uri) => Promise.resolve(vscode.workspace.fs.delete(uri)).then(() => undefined),
  };
}
