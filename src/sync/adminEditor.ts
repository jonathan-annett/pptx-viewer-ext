// vscode-wired half of the .admin-sync.jsonc custom text editor.
//
// Pairs with the pure renderer in adminEditorHtml.ts. This module:
//   - Registers the CustomTextEditorProvider for .admin-sync.jsonc
//   - Builds the view model by parsing the document text + asking the store
//     for pointer info
//   - Handles command messages: renameFolder, refreshSnapshot, clearSnapshot,
//     openAsText
//
// Folder renames re-apply through vscode.workspace.updateWorkspaceFolders;
// the snapshot writer (in restoreFlow) reacts to that topology event and
// rewrites the file. We don't write the file ourselves from this editor —
// that would race the writer and bypass its diff-check.

import * as vscode from 'vscode';
import { log } from '../log';
import {
  renderAdminEditorHtml,
  type AdminEditorSettingSummary,
  type AdminEditorViewModel,
} from './adminEditorHtml';
import { parseSnapshot, KNOWN_WORKSPACE_KEYS, type Snapshot } from './snapshot';
import { SnapshotStore } from './snapshotStore';
import { captureAndWriteSnapshot } from './restoreFlow';

const VIEW_TYPE = 'folderSync.adminEditor';

export class AdminEditorProvider implements vscode.CustomTextEditorProvider {
  static register(store: SnapshotStore): vscode.Disposable {
    const provider = new AdminEditorProvider(store);
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      // Keep edit-state across hide/show; the form has per-row "Rename" mode
      // we don't want to lose when the user switches tabs.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  constructor(private readonly store: SnapshotStore) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = this.renderFor(document);
    log(`admin-editor: opened ${document.uri.toString()}`);

    // Re-render when the document text changes (the snapshot writer rewrites
    // the file on every topology event). We never edit the document from
    // this editor, so there's no own-edit to suppress.
    const docSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      const vm = buildViewModel(document, this.store);
      void panel.webview.postMessage({ type: 'docChanged', payload: vm });
    });

    // Topology changes don't always rewrite the file in the same tick — for
    // example, a rename has to go through updateWorkspaceFolders → writer →
    // disk → onDidChangeTextDocument. Subscribing here too gives the panel
    // an early hint that something is in flight (the writer's rewrite will
    // arrive shortly via docSub).
    const folderSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // No-op for now; left as a hook for future pre-write feedback (e.g.
      // disabling the rename buttons while a rewrite is in flight).
    });

    panel.onDidDispose(() => {
      docSub.dispose();
      folderSub.dispose();
    });

    panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      try {
        if (msg.type === 'renameFolder') {
          await this.renameFolder(msg.index, msg.name);
        } else if (msg.type === 'refreshSnapshot') {
          await this.refreshSnapshot(panel, document);
        } else if (msg.type === 'clearSnapshot') {
          await vscode.commands.executeCommand('folderSync.clearSnapshot');
        } else if (msg.type === 'openAsText') {
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
        }
      } catch (err) {
        log(
          `admin-editor: message handler failed (${msg.type}) — ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    });
  }

  private renderFor(document: vscode.TextDocument): string {
    const vm = buildViewModel(document, this.store);
    return renderAdminEditorHtml(vm, makeNonce());
  }

  private async renameFolder(index: number, newName: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (index < 0 || index >= folders.length) {
      log(`admin-editor: renameFolder index=${index} out of range (n=${folders.length})`);
      return;
    }
    const folder = folders[index];
    if (folder.name === newName) {
      log(`admin-editor: renameFolder index=${index} no-op (name unchanged)`);
      return;
    }
    log(`admin-editor: renameFolder index=${index} "${folder.name}" → "${newName}"`);
    // updateWorkspaceFolders with the replace overload: (start, deleteCount, ...newFolders)
    const ok = vscode.workspace.updateWorkspaceFolders(index, 1, {
      uri: folder.uri,
      name: newName,
    });
    log(`admin-editor: updateWorkspaceFolders(${index}, 1, …) returned ${ok}`);
    // The snapshot writer fires off the resulting onDidChangeWorkspaceFolders
    // event and rewrites the file. The doc change then posts `docChanged` to
    // the webview through our docSub above.
  }

  private async refreshSnapshot(
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument,
  ): Promise<void> {
    log('admin-editor: refresh requested');
    const captured = await captureAndWriteSnapshot(this.store);
    if (!captured) {
      void vscode.window.showWarningMessage(
        'Cannot refresh snapshot — no workspace folders open.',
      );
      return;
    }
    void vscode.window.showInformationMessage(
      `Snapshot refreshed — ${captured.folders.length} folder(s).`,
    );
    // The atomic write fires onDidChangeTextDocument which re-posts the VM.
    // Also push a fresh VM directly in case the doc-change event lags.
    const vm = buildViewModel(document, this.store);
    void panel.webview.postMessage({ type: 'docChanged', payload: vm });
  }
}

// ───── helpers ─────────────────────────────────────────────────────────

type WebviewMessage =
  | { type: 'renameFolder'; index: number; name: string }
  | { type: 'refreshSnapshot' }
  | { type: 'clearSnapshot' }
  | { type: 'openAsText' };

function buildViewModel(document: vscode.TextDocument, store: SnapshotStore): AdminEditorViewModel {
  const text = document.getText();
  const { snapshot, errors } = parseSnapshot(text);
  const pointer = store.getPointer();
  return {
    folders: snapshot.folders.map((f) => ({ uri: f.uri, name: f.name })),
    settings: summariseSettings(snapshot),
    capturedAt: snapshot.capturedAt,
    pointerInfo: pointer ? { uri: pointer.uri, lastWriteAt: pointer.lastWriteAt } : null,
    parseError: errors.length > 0 ? errors.join('; ') : null,
  };
}

function summariseSettings(snapshot: Snapshot): AdminEditorSettingSummary[] {
  return Object.keys(snapshot.settings)
    .sort()
    .map((key) => ({
      key,
      valueSummary: valueSummary(snapshot.settings[key]),
      unknown: !KNOWN_WORKSPACE_KEYS.includes(key),
    }));
}

function valueSummary(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length} item(s)]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).length} key(s)}`;
  return JSON.stringify(v);
}

function makeNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
