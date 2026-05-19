// Thin adapter: vscode.workspace.fs → SyncFs<vscode.Uri>.
//
// Shared by runSync (executor wiring) and planner (hashFileAtUri wiring).
// Lives in its own module to break what would otherwise be a circular
// import between planner.ts and runSync.ts.

import * as vscode from 'vscode';
import type { SyncFs } from './executor';

export function vscodeFs(): SyncFs<vscode.Uri> {
  return {
    joinPath(root, relPath) {
      const base = root.path.endsWith('/') ? root.path.slice(0, -1) : root.path;
      const sep = relPath.startsWith('/') ? '' : '/';
      return root.with({ path: `${base}${sep}${relPath}` });
    },
    async stat(uri) {
      // The FSA adapter populates size + mtime; M5.2.5 probe verified both
      // are real and stable across browser refresh.
      const s = await vscode.workspace.fs.stat(uri);
      return { size: s.size, mtime: s.mtime };
    },
    readFile: (uri) => Promise.resolve(vscode.workspace.fs.readFile(uri)).then(passThrough),
    writeFile: (uri, bytes) =>
      Promise.resolve(vscode.workspace.fs.writeFile(uri, bytes)).then(noop),
    rename: (src, dst) =>
      Promise.resolve(vscode.workspace.fs.rename(src, dst, { overwrite: true })).then(noop),
    delete: (uri) => Promise.resolve(vscode.workspace.fs.delete(uri)).then(noop),
  };
}

function passThrough(x: Uint8Array): Uint8Array { return x; }
function noop(): void { /* discard */ }
