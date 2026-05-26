// vscode-wired half of the .foldersync-manifest.json custom text editor.
//
// Pairs with the pure renderer in manifestEditorHtml.ts. This module:
//   - Registers the CustomTextEditorProvider for .foldersync-manifest.json
//   - Builds the view model by parsing the document text via the shared
//     `parseManifestText` helper in manifest-types.ts
//   - Posts the rendered HTML to the panel and re-renders on document
//     change (the executor rewrites the manifest mid-sync if the editor is
//     open)
//   - Handles the `openAsText` message — the only user affordance in v1
//
// View-only by design: the manifest is fully extension-managed (entries by
// the executor, decisions by the plan webview). Hand-edits would be
// clobbered on the next sync run; if the user genuinely needs to edit, the
// Reopen-as-text button is the escape hatch. See the M6.E design notes in
// `folder-sync-v1-plan.md` for the full rationale.

import * as vscode from 'vscode';
import { log } from '../log';
import { parseManifestText } from './manifest-types';
import {
  renderManifestEditorHtml,
  toManifestViewModel,
  type ManifestEditorMode,
} from './manifestEditorHtml';
import {
  getDestinationOnlyState,
  onDidChangeDestinationOnlyState,
} from './destinationOnlyWired';

const VIEW_TYPE = 'folderSync.manifestEditor';
const MANIFEST_FILENAME = '.foldersync-manifest.json';

export class ManifestEditorProvider implements vscode.CustomTextEditorProvider {
  static register(): vscode.Disposable {
    const provider = new ManifestEditorProvider();
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      // The view is server-rendered (full HTML replacement per render);
      // there's no JS-side state worth preserving across hide/show, so
      // retainContextWhenHidden stays at its default (false). Matches the
      // plan webview's choice for the same reason.
      webviewOptions: { retainContextWhenHidden: false },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = this.renderFor(document);
    log(`manifest-editor: opened ${document.uri.toString()}`);

    // The executor writes the manifest mid-sync via writeManifest (tmp +
    // rename), which surfaces as onDidChangeTextDocument on the backing
    // text doc. We never edit the document from this editor, so there's no
    // own-edit to suppress. Full HTML replacement on every change is cheap
    // for the manifests we expect (tens to low hundreds of entries).
    const docSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      panel.webview.html = this.renderFor(document);
    });

    // Re-render when the workspace transitions into or out of destination-
    // only mode (e.g. user adds a .sync.jsonc to a previously operator-
    // only workspace). Hides/shows the Decisions section and swaps the
    // disclaimer copy without the user needing to reopen the file.
    const modeSub = onDidChangeDestinationOnlyState(() => {
      panel.webview.html = this.renderFor(document);
    });

    panel.onDidDispose(() => {
      docSub.dispose();
      modeSub.dispose();
    });

    panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      try {
        if (msg?.type === 'openAsText') {
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
        }
      } catch (err) {
        log(
          `manifest-editor: message handler failed (${msg?.type ?? 'unknown'}) — ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    });
  }

  private renderFor(document: vscode.TextDocument): string {
    const result = parseManifestText(document.getText());
    const destRootLabel = labelForManifest(document.uri);
    const mode: ManifestEditorMode = getDestinationOnlyState().isDestinationOnly
      ? 'operator'
      : 'mainUser';
    const vm = toManifestViewModel(result, destRootLabel, new Date(), mode);
    return renderManifestEditorHtml(vm, makeNonce());
  }
}

// ───── helpers ─────────────────────────────────────────────────────────

type WebviewMessage = { type?: 'openAsText' } | null | undefined;

/**
 * Compute a display label for the manifest's destination root. The custom
 * editor opens the manifest *file*, but the user thinks in destination
 * folders — strip the trailing `/.foldersync-manifest.json` and prefer a
 * workspace-relative form when available.
 */
function labelForManifest(manifestFileUri: vscode.Uri): string {
  const path = manifestFileUri.path;
  const suffix = `/${MANIFEST_FILENAME}`;
  const destPath = path.endsWith(suffix) ? path.slice(0, -suffix.length) : path;
  const destRootUri = manifestFileUri.with({ path: destPath || '/' });
  const rel = vscode.workspace.asRelativePath(destRootUri, false);
  if (rel && rel !== destRootUri.toString()) return rel;
  return destRootUri.toString();
}

function makeNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
