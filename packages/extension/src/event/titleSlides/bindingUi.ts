// vscode-wired binding panel host.
//
// Owns the webview lifecycle, parses the template via `inspectTemplate`,
// and round-trips Save / Change-template / Cancel messages back to the
// caller. Does NOT know about `.eventSchedule` files — the caller
// (event editor) provides Save + Change-template callbacks. Keeping it
// schema-agnostic means the same panel can be re-used from elsewhere
// (e.g. a future command palette entry) without coupling the binding
// shape to a specific document type.

import * as vscode from 'vscode';
import { log } from 'pptx-tools-core/log';
import { inspectTemplate } from 'pptx-tools-core/event/titleSlides/templateInspect';
import type { TitleSlidesBinding } from 'pptx-tools-core/event/titleSlides/binding';
import { renderBindingPanelHtml } from 'pptx-tools-core/event/titleSlides/bindingUiHtml';

const VIEW_TYPE = 'pptxViewer.titleSlideBinding';

export interface BindingPanelDeps {
  /** Bytes of the template .pptx. Pre-loaded by the caller. */
  templateBytes: Uint8Array;
  /** Display path shown in the panel header. */
  templatePath: string;
  /** Pre-populate the form from an existing binding. */
  existing?: TitleSlidesBinding;
  /**
   * Called when the user clicks Save. The caller is responsible for
   * persisting the binding (typically: write to `config.titleSlides`
   * in the relevant `.eventSchedule` via `workspace.fs.writeFile` to
   * dodge the FSA-flush dead-end).
   *
   * Return `{ ok: false, error: 'msg' }` to surface a failure to the
   * user in the panel's status line; `{ ok: true }` clears the
   * unsaved-changes indicator.
   */
  onSave: (binding: TitleSlidesBinding) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Called when the user clicks "Change template". Caller shows a file
   * picker, loads bytes, and returns the new context — or undefined to
   * keep the current template. After a successful change, the panel
   * re-renders with the new template's frames.
   */
  onChangeTemplate: () => Promise<
    | { templateBytes: Uint8Array; templatePath: string }
    | undefined
  >;
}

export function openBindingPanel(
  _context: vscode.ExtensionContext,
  deps: BindingPanelDeps,
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    'Bind title-slide template',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      // Keep the panel state across hide/show — the in-form dropdowns
      // are pure client state, but losing them on tab-switch would be
      // annoying mid-bind.
      retainContextWhenHidden: true,
    },
  );

  let currentBytes = deps.templateBytes;
  let currentPath = deps.templatePath;
  let currentExisting = deps.existing;

  function render(): void {
    try {
      const inspection = inspectTemplate(currentBytes);
      const html = renderBindingPanelHtml(
        { templatePath: currentPath, inspection, existing: currentExisting },
        makeNonce(),
      );
      panel.webview.html = html;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`binding-ui: template parse failed — ${msg}`);
      panel.webview.html = renderErrorHtml(currentPath, msg, makeNonce());
    }
  }
  render();

  panel.webview.onDidReceiveMessage(async (msg: BindingPanelMessage) => {
    try {
      if (msg.type === 'save') {
        log(`binding-ui: save → ${msg.binding.fields.length} field(s)`);
        const result = await deps.onSave(msg.binding);
        if (result.ok) {
          panel.webview.postMessage({ type: 'saved' });
          // Refresh local "existing" so a subsequent Save without changes
          // doesn't overwrite with a stale snapshot if the user keeps
          // editing after a successful save.
          currentExisting = msg.binding;
        } else {
          panel.webview.postMessage({
            type: 'saveFailed',
            error: result.error ?? 'unknown error',
          });
        }
      } else if (msg.type === 'changeTemplate') {
        const next = await deps.onChangeTemplate();
        if (next) {
          currentBytes = next.templateBytes;
          currentPath = next.templatePath;
          currentExisting = undefined;   // new template → re-bind from scratch
          render();
        }
      } else if (msg.type === 'cancel') {
        panel.dispose();
      }
    } catch (err) {
      log(`binding-ui: message handler failed — ${err instanceof Error ? err.message : String(err)}`);
      panel.webview.postMessage({
        type: 'saveFailed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return panel;
}

// ───── Message types ─────────────────────────────────────────────────────

type BindingPanelMessage =
  | { type: 'save'; binding: TitleSlidesBinding }
  | { type: 'changeTemplate' }
  | { type: 'cancel' };

// ───── Error render (template parse failure) ─────────────────────────────

function renderErrorHtml(templatePath: string, error: string, nonce: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Bind title-slide template — error</title>
<style>
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px; }
  h1 { font-size: 1.4rem; }
  pre { background: var(--vscode-textCodeBlock-background, #2b2b2b); padding: 8px 12px; border-radius: 4px; overflow-x: auto; }
  .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 2px; }
</style>
</head>
<body>
  <h1>Couldn't read template</h1>
  <p>Tried to inspect: <code>${escapeHtml(templatePath)}</code></p>
  <pre>${escapeHtml(error)}</pre>
  <p>This usually means the file isn't a valid .pptx, or the template's presentation.xml is missing / malformed. Pick a different template:</p>
  <button class="btn" id="bind-change-template-btn">Change template…</button>
  <script nonce="${nonce}">
    var vscode = acquireVsCodeApi();
    document.getElementById('bind-change-template-btn').addEventListener('click', function(){
      vscode.postMessage({ type: 'changeTemplate' });
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ───── Nonce ─────────────────────────────────────────────────────────────

function makeNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
