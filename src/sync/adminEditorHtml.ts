// Pure HTML renderer for the .admin-sync.jsonc custom editor.
//
// No vscode import — pairs with adminEditor.ts (vscode-wired) per the
// pure/wired split convention in CLAUDE.md.
//
// The admin editor is a view + control panel for the workspace snapshot:
//   - View the captured folders (uri + name)
//   - Rename a folder (re-applies updateWorkspaceFolders with a new name)
//   - View captured settings (read-only summary)
//   - Refresh (force a recapture) / Clear (delete pointer + file)
//   - Reopen as text (escape hatch into raw JSONC)
//   - Embedded **workspace-wide** dry-run plan + Run Sync — the same engine
//     as `folderSync.openPlan`, but rendered in-place so the admin editor is
//     a single pane for "snapshot + sync this workspace". Run Sync is gated
//     by the same green/orange/red logic as the standalone plan panel.
//
// The file itself is managed automatically — direct text edits get
// clobbered on the next topology change. The header comment in the file
// says so; this editor's intro panel says so. Edits flow through the
// snapshot writer rather than through onDidChangeTextDocument.

import { decisionWiringScript, planContentStyles } from './planHtml';

export interface AdminEditorFolder {
  uri: string;
  name: string;
  /** Position in workspaceFolders. Used by the client to address row events. */
  index: number;
  /** True when this is workspaceFolders[0] — the writable source root by convention. */
  isWorkspaceRoot: boolean;
  /** Sources whose destinations point at this folder. Empty when none. */
  sources: AdminEditorFolderSource[];
  /**
   * True when no sources link here AND there is no folder of the same name in
   * workspaceFolders[0]. Always false for workspaceFolders[0] itself. The
   * filesystem half of this decision is async — the wired side computes it
   * before constructing the view model.
   */
  canCreateSource: boolean;
}

/** One source pointing at this destination folder, ready for the renderer. */
export interface AdminEditorFolderSource {
  /** URI of the .sync.jsonc file in the source folder. */
  configUri: string;
  /** URI of the source folder itself (parent of configUri). */
  sourceFolderUri: string;
  /** Workspace-relative display path for the link text. */
  displayPath: string;
  /** Empty when the source targets the destination root; otherwise the subpath. */
  subpath: string;
}

export interface AdminEditorSettingSummary {
  key: string;
  /** Short human-readable summary, e.g. "[3 item(s)]" or "true". */
  valueSummary: string;
  /** Marked when the key isn't in KNOWN_WORKSPACE_KEYS — informational only. */
  unknown: boolean;
}

export interface AdminEditorPointerInfo {
  uri: string;
  lastWriteAt: string;
}

/**
 * One row in the Placeholders card. The locked default row (empty-file sha)
 * is rendered without an `[x]`; user-added rows are removable. The locked
 * default is a UI property only — it isn't stored in the on-disk array,
 * which means a malicious or scripted remove of EMPTY_FILE_SHA256 just no-ops
 * naturally (the filter doesn't find it).
 */
export interface PlaceholderRow {
  /** Lowercase hex sha256. */
  sha256: string;
  /** True for the empty-file default; no [x] is rendered. */
  locked: boolean;
  /** Suffix label for the row, e.g. "(default — zero-byte file)". */
  label?: string;
}

export interface AdminEditorViewModel {
  folders: AdminEditorFolder[];
  settings: AdminEditorSettingSummary[];
  /** Placeholders card rows (locked default first, then user entries). */
  placeholders: PlaceholderRow[];
  /** ISO timestamp from the snapshot body. Empty when unavailable. */
  capturedAt: string;
  /** GlobalState pointer info, or null when there is no pointer. */
  pointerInfo: AdminEditorPointerInfo | null;
  /** Parse error from the JSONC body, if any. */
  parseError: string | null;
}

/**
 * Render the admin editor HTML. The `nonce` must be unique per render and
 * match the CSP `script-src 'nonce-...'` directive — same pattern as the
 * other editor panels.
 */
export function renderAdminEditorHtml(vm: AdminEditorViewModel, nonce: string): string {
  // Escape "</" in the JSON payload so a folder name containing "</script>"
  // can't close the data-island tag (same rationale as configEditorHtml).
  const initialPayload = JSON.stringify({
    folders: vm.folders,
    settings: vm.settings,
    placeholders: vm.placeholders,
    capturedAt: vm.capturedAt,
    pointerInfo: vm.pointerInfo,
    parseError: vm.parseError,
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<title>Workspace snapshot</title>
<style>${STYLE}${planContentStyles()}${EMBEDDED_PLAN_STYLE}</style>
</head>
<body>
  <header class="page-header">
    <h1>Workspace snapshot</h1>
    <p class="subtle">This file is managed automatically. It records the folders and settings of the current workspace so they can be restored silently after a vscode.dev refresh (where workspace state is otherwise lost). On desktop VS Code the file is still captured — workspace state persists natively there, but keeping the snapshot current means you can switch a workspace between desktop and vscode.dev without losing it. <strong>Do not hand-edit</strong> — changes are clobbered on the next topology event. Use the controls below, or <em>Reopen as text</em> for a raw view.</p>
  </header>

  <div id="parse-error" class="banner warn" hidden></div>

  <section class="card" id="pointer-card">
    <h2>Pointer</h2>
    <dl class="kv">
      <dt>Captured at</dt><dd id="captured-at" class="mono"></dd>
      <dt>File</dt><dd id="pointer-uri" class="mono small"></dd>
    </dl>
  </section>

  <section class="card">
    <h2>Folders</h2>
    <p class="hint">Position in the list is meaningful — <code>workspaceFolders[0]</code> is the writable folder by convention. Rename to update the display name; this re-applies through <code>updateWorkspaceFolders</code> and gets reflected in the snapshot.</p>
    <ul id="folder-list" class="folder-list"></ul>
    <p id="folder-empty" class="hint" hidden><em>No folders in this snapshot.</em></p>
  </section>

  <section class="card">
    <h2>Settings</h2>
    <p class="hint">Workspace-scope settings captured at snapshot time. v1 captures a known-key allowlist (<code>files.readonlyInclude</code>, <code>files.readonlyExclude</code>); other keys are restored if present but flagged as unknown for follow-up.</p>
    <ul id="setting-list" class="setting-list"></ul>
    <p id="setting-empty" class="hint" hidden><em>No settings captured.</em></p>
  </section>

  <section class="card" id="placeholders-card">
    <h2 id="placeholders-heading">Placeholders</h2>
    <p class="hint">Files matching these sha256 hashes are treated as placeholders in plans and the viewer. The zero-byte default lets Windows Explorer "New PowerPoint Presentation" stubs flow through sync as placeholders. Add a sample to register a custom blank-template deck — its sha256 is captured and any file with that hash is then treated the same way.</p>
    <ul id="placeholder-list" class="placeholder-list"></ul>
    <div class="placeholder-actions">
      <button id="add-placeholder" class="btn btn-secondary btn-sm" type="button" title="Pick a sample .pptx — its sha256 is added to the placeholders list">Add placeholder…</button>
    </div>
  </section>

  <section class="card plan-card">
    <div class="plan-card-head">
      <h2>Full dry-run plan — this workspace</h2>
      <button id="plan-refresh" class="btn btn-secondary btn-sm" type="button" title="Re-scan every source folder and rebuild the plan">Refresh</button>
    </div>
    <p class="hint">Auto-runs whenever any <code>.sync.jsonc</code> in the workspace changes, and when workspace folders are added or removed. Run Sync below executes the green-path operations (create / update-tracked / delete-tracked). When the plan has collisions or validator warnings, Run Sync is gated; the orange "safe items only" button skips the blocked items so the clean items can still flow.</p>
    <div id="plan-status" class="plan-status plan-scanning">Scanning…</div>
    <div id="plan-totals" class="totals" hidden></div>
    <div id="plan-pairs" class="plan-pairs"></div>
    <div class="plan-actions">
      <button id="run-sync" class="btn btn-green" type="button" disabled title="Apply the green-path operations from the plan above">Run Sync</button>
      <button id="run-sync-safe" class="btn btn-orange" type="button" hidden title="Sync only the items without collisions or warnings — skips the blocked ones so the clean items can still flow">Run Sync (safe items only)</button>
      <span id="run-sync-hint" class="hint plan-actions-hint"></span>
    </div>
    <div id="sync-progress" class="sync-progress" hidden role="status" aria-live="polite">
      <div class="sync-progress-bar"><div class="sync-progress-fill" style="width:0%"></div></div>
      <div class="sync-progress-meta">
        <span class="sync-progress-count">0 / 0</span>
        <span class="sync-progress-path"></span>
      </div>
    </div>
  </section>

  <section class="actions">
    <button id="refresh" class="btn btn-primary" type="button" title="Recapture the current workspace and overwrite this file">Refresh from current workspace</button>
    <button id="clear" class="btn btn-danger" type="button" title="Delete this file and clear the pointer — on vscode.dev the next refresh will land in a folderless tab; on desktop this just discards the recorded snapshot">Clear snapshot</button>
    <button id="open-text" class="btn btn-secondary" type="button">Reopen as text</button>
  </section>

  <p class="hint">Use <em>Folder Sync: Show Workspace Snapshot</em> for an Output Channel dump.</p>

  <script id="init-payload" type="application/json" nonce="${nonce}">${initialPayload}</script>
  <script nonce="${nonce}">${CLIENT_JS}</script>
  <script nonce="${nonce}">${decisionWiringScript()}</script>
</body>
</html>`;
}

// ───── CSS ──────────────────────────────────────────────────────────────
//
// Theme-aware via VS Code's CSS variables — same palette as the config
// editor and plan webview so the two custom editors feel like siblings.

const STYLE = `
:root { color-scheme: light dark; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  padding: 16px 20px 40px;
  max-width: 900px;
  margin: 0 auto;
}
h1 { font-size: 1.4em; margin: 0 0 4px; }
h2 { font-size: 1.05em; margin: 0 0 10px; }
.subtle, .hint {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  margin: 0 0 12px;
}
.mono {
  font-family: var(--vscode-editor-font-family);
}
.small { font-size: 0.85em; word-break: break-all; }
code {
  font-family: var(--vscode-editor-font-family);
  background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1));
  padding: 1px 4px;
  border-radius: 3px;
}
.card {
  background: var(--vscode-editorWidget-background, rgba(127,127,127,0.05));
  border: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.2));
  border-radius: 6px;
  padding: 14px 16px;
  margin: 14px 0;
}
.banner {
  padding: 8px 12px;
  border-radius: 4px;
  margin: 8px 0;
  border-left: 3px solid;
}
.banner.warn {
  background: var(--vscode-inputValidation-warningBackground, rgba(255,180,0,0.1));
  border-color: var(--vscode-inputValidation-warningBorder, #b89500);
}
.kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 16px;
  margin: 0;
}
.kv dt { color: var(--vscode-descriptionForeground); font-weight: 600; }
.kv dd { margin: 0; }
.folder-list, .setting-list { list-style: none; padding: 0; margin: 0; }
.folder-list li, .setting-list li {
  display: grid;
  gap: 8px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.15));
}
.folder-list li { grid-template-columns: 24px minmax(140px, 1fr) minmax(160px, 2fr) minmax(160px, auto) auto; }
.setting-list li { grid-template-columns: minmax(180px, 1fr) auto; }
.folder-list li:last-child, .setting-list li:last-child { border-bottom: none; }
.folder-idx {
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family);
  font-size: 0.85em;
  text-align: right;
}
.folder-name { font-weight: 600; }
.folder-uri {
  font-family: var(--vscode-editor-font-family);
  color: var(--vscode-descriptionForeground);
  font-size: 0.85em;
  word-break: break-all;
}
.setting-key {
  font-family: var(--vscode-editor-font-family);
}
.setting-key.unknown::after {
  content: ' ?';
  color: var(--vscode-editorWarning-foreground, #b89500);
  font-weight: 600;
}
.setting-value {
  font-family: var(--vscode-editor-font-family);
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}
input[type="text"] {
  width: 100%;
  box-sizing: border-box;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.95em;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.3));
  border-radius: 3px;
  padding: 4px 6px;
}
.btn {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  border: 1px solid transparent;
  border-radius: 3px;
  padding: 5px 12px;
  cursor: pointer;
}
.btn-primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.btn-primary:hover { background: var(--vscode-button-hoverBackground); }
.btn-secondary {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border-color: var(--vscode-button-border, rgba(127,127,127,0.4));
}
.btn-secondary:hover {
  background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.15));
}
.btn-danger {
  background: transparent;
  color: var(--vscode-errorForeground, #cc5555);
  border: 1px solid var(--vscode-errorForeground, #cc5555);
}
.btn-danger:hover {
  background: var(--vscode-inputValidation-errorBackground, rgba(204,85,85,0.1));
}
.btn-rename {
  background: transparent;
  border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.3));
  color: var(--vscode-foreground);
  padding: 2px 10px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 0.85em;
}
.btn-rename:hover {
  background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.15));
}
.actions { display: flex; gap: 8px; margin: 16px 0 8px; flex-wrap: wrap; }
.folder-source-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.85em;
}
.folder-source-cell .source-link {
  /* Inline link styled like a VS Code clickable token — uses the editor
   * link colour so it picks up theme variants without us hard-coding. */
  color: var(--vscode-textLink-foreground, #3794ff);
  text-decoration: underline;
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  text-align: left;
  font-family: var(--vscode-editor-font-family);
  word-break: break-all;
}
.folder-source-cell .source-link:hover {
  color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground, #3794ff));
}
.folder-source-cell .source-subpath {
  /* Subpath suffix on the link, e.g. "→ sub/folder". Greyed to keep the
   * source-folder name dominant. */
  color: var(--vscode-descriptionForeground);
  margin-left: 6px;
  font-size: 0.95em;
}
.btn-create-source {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--vscode-button-border, rgba(127,127,127,0.4));
  border-radius: 3px;
  padding: 2px 10px;
  font-size: 0.85em;
  font-family: var(--vscode-font-family);
  cursor: pointer;
  white-space: nowrap;
}
.btn-create-source:hover {
  background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.15));
}
.editing { background: var(--vscode-editor-selectionBackground, rgba(127,127,127,0.15)); }
.placeholder-list {
  list-style: none;
  padding: 0;
  margin: 0 0 8px;
}
.placeholder-list li {
  display: grid;
  grid-template-columns: minmax(140px, auto) 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.15));
}
.placeholder-list li:last-child { border-bottom: none; }
.placeholder-row.locked { opacity: 0.7; }
.placeholder-sha {
  font-family: var(--vscode-editor-font-family);
  font-size: 0.9em;
  word-break: break-all;
}
.placeholder-label {
  color: var(--vscode-descriptionForeground);
  font-size: 0.85em;
}
.placeholder-list .remove-btn {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--vscode-button-border, rgba(127,127,127,0.4));
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 0.85em;
  cursor: pointer;
  font-family: var(--vscode-font-family);
}
.placeholder-list .remove-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.15));
}
.placeholder-empty {
  color: var(--vscode-descriptionForeground);
  font-size: 0.85em;
  font-style: italic;
  margin: 4px 0 8px;
}
.placeholder-actions { display: flex; gap: 8px; margin-top: 6px; }
`;

// Styles that complement planContentStyles() inside the embedded plan card.
// Mirrors the embedded styling from configEditorHtml.ts so the two editors
// feel consistent.
const EMBEDDED_PLAN_STYLE = `
.plan-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.plan-card-head h2 { margin: 0; }
.btn-sm { padding: 3px 10px; font-size: 0.9em; }
.plan-status {
  font-size: 0.9em;
  margin: 6px 0 10px;
  color: var(--vscode-descriptionForeground);
}
.plan-scanning::before {
  content: '';
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--vscode-progressBar-background, var(--vscode-foreground));
  opacity: 0.55;
  animation: plan-pulse 1.2s ease-in-out infinite;
  vertical-align: middle;
}
@keyframes plan-pulse {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 0.85; }
}
.plan-error { color: var(--vscode-errorForeground); }
.plan-error .plan-retry { margin-left: 8px; }
.plan-card .totals { margin-bottom: 8px; }
.plan-card .pair {
  /* Tighten the pair card so it sits more naturally inside the section */
  margin: 8px 0;
  padding: 8px 12px;
}
.plan-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.plan-actions-hint { margin: 0; }
/* Per-op sync progress bar — sits beneath the Run Sync buttons during a
   running sync. Hidden until the executor fires its first onProgress event
   and re-hidden on the syncStatus done/error follow-up. */
.sync-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
}
.sync-progress[hidden] { display: none; }
.sync-progress-bar {
  width: 100%;
  height: 6px;
  background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
  border-radius: 3px;
  overflow: hidden;
}
.sync-progress-fill {
  height: 100%;
  background: var(--vscode-button-background, #0e639c);
  transition: width 140ms ease-out;
}
.sync-progress-fill-error { background: var(--vscode-errorForeground, #f14c4c); }
.sync-progress-meta {
  display: flex;
  gap: 12px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}
.sync-progress-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.btn-green {
  background: var(--vscode-charts-green, #4caf50);
  color: #fff;
  border: 1px solid transparent;
}
.btn-green:hover:not(:disabled) {
  filter: brightness(1.1);
}
.btn-green:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.btn-orange {
  background: var(--vscode-charts-orange, #d97706);
  color: #fff;
  border: 1px solid transparent;
}
.btn-orange:hover:not(:disabled) {
  filter: brightness(1.1);
}
.btn-orange:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
`;

// ───── client-side JS ──────────────────────────────────────────────────
//
// Reads the data-island payload, renders the folder + setting lists, posts
// command messages to the extension. Listens for `docChanged` messages so
// external rewrites (the snapshot writer firing after a topology change) are
// reflected without losing focus.

const CLIENT_JS = `
(function () {
  // Cache the API on window so the decisionWiringScript loaded after us can
  // reuse it. acquireVsCodeApi() throws if called twice in the same page.
  const vscode = (window.__decisionVscode = window.__decisionVscode || acquireVsCodeApi());
  const payloadEl = document.getElementById('init-payload');
  let state = JSON.parse(payloadEl.textContent);

  // Per-row edit state — keyed by folder index. Persisted in vscode.setState
  // so retainContextWhenHidden survives even if the panel hides/shows.
  const previous = vscode.getState();
  let editing = (previous && typeof previous.editing === 'object') ? previous.editing : {};
  function saveLocal() { vscode.setState({ editing: editing }); }

  const parseErrEl = document.getElementById('parse-error');
  const capturedAtEl = document.getElementById('captured-at');
  const pointerUriEl = document.getElementById('pointer-uri');
  const folderListEl = document.getElementById('folder-list');
  const folderEmptyEl = document.getElementById('folder-empty');
  const settingListEl = document.getElementById('setting-list');
  const settingEmptyEl = document.getElementById('setting-empty');
  const placeholderListEl = document.getElementById('placeholder-list');
  const placeholdersHeadingEl = document.getElementById('placeholders-heading');

  function renderAll() {
    if (state.parseError) {
      parseErrEl.textContent = 'Cannot parse snapshot: ' + state.parseError;
      parseErrEl.hidden = false;
    } else {
      parseErrEl.hidden = true;
    }

    capturedAtEl.textContent = state.capturedAt || '(unknown)';
    pointerUriEl.textContent = state.pointerInfo ? state.pointerInfo.uri : '(no pointer)';

    folderListEl.innerHTML = '';
    if (!state.folders || state.folders.length === 0) {
      folderEmptyEl.hidden = false;
    } else {
      folderEmptyEl.hidden = true;
      state.folders.forEach((f, idx) => folderListEl.appendChild(renderFolderRow(f, idx)));
    }

    settingListEl.innerHTML = '';
    if (!state.settings || state.settings.length === 0) {
      settingEmptyEl.hidden = false;
    } else {
      settingEmptyEl.hidden = true;
      state.settings.forEach((s) => settingListEl.appendChild(renderSettingRow(s)));
    }

    placeholderListEl.innerHTML = '';
    const placeholders = state.placeholders || [];
    placeholdersHeadingEl.textContent = 'Placeholders (' + placeholders.length + ')';
    if (placeholders.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'placeholder-empty';
      empty.textContent = 'No placeholders.';
      placeholderListEl.appendChild(empty);
    } else {
      placeholders.forEach((p) => placeholderListEl.appendChild(renderPlaceholderRow(p)));
    }
  }

  function renderFolderRow(folder, idx) {
    const li = document.createElement('li');
    if (editing[idx] !== undefined) li.classList.add('editing');

    const idxCell = document.createElement('span');
    idxCell.className = 'folder-idx';
    idxCell.textContent = '[' + idx + ']';

    const nameCell = document.createElement('div');
    if (editing[idx] !== undefined) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = editing[idx];
      input.addEventListener('input', () => {
        editing[idx] = input.value;
        saveLocal();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { commit(idx); }
        else if (e.key === 'Escape') { cancel(idx); }
      });
      // Defer focus until after this row is mounted.
      setTimeout(() => { input.focus(); input.select(); }, 0);
      nameCell.appendChild(input);
    } else {
      const span = document.createElement('span');
      span.className = 'folder-name';
      span.textContent = folder.name;
      nameCell.appendChild(span);
    }

    const uriCell = document.createElement('span');
    uriCell.className = 'folder-uri';
    uriCell.textContent = folder.uri;

    // Source-link / create-source cell. Sits between the URI and the
    // Rename action. One of three states:
    //   1. One+ sources point here → list each as a clickable link that
    //      asks the extension to reveal the source folder in the explorer.
    //   2. canCreateSource → render "Create source folder" — clicking it
    //      asks the extension to mkdir + write .sync.jsonc pointing here.
    //   3. Otherwise empty (workspaceFolders[0], or a folder of the same
    //      name already exists in the workspace root).
    const sourceCell = document.createElement('div');
    sourceCell.className = 'folder-source-cell';
    const sources = folder.sources || [];
    if (sources.length > 0) {
      sources.forEach((s) => {
        const wrap = document.createElement('div');
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'source-link';
        link.textContent = s.displayPath || s.sourceFolderUri;
        link.title = 'Reveal source folder in Explorer';
        link.addEventListener('click', () => {
          vscode.postMessage({ type: 'revealSource', sourceFolderUri: s.sourceFolderUri });
        });
        wrap.appendChild(link);
        if (s.subpath) {
          const sub = document.createElement('span');
          sub.className = 'source-subpath';
          sub.textContent = '→ ' + s.subpath;
          wrap.appendChild(sub);
        }
        sourceCell.appendChild(wrap);
      });
    } else if (folder.canCreateSource) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-create-source';
      btn.textContent = 'Create source folder';
      btn.title = 'Create an empty folder in the workspace root and wire it up as a source for this destination';
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'createSourceFolder', folderUri: folder.uri, name: folder.name });
      });
      sourceCell.appendChild(btn);
    }

    const actionCell = document.createElement('div');
    if (editing[idx] !== undefined) {
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn-rename';
      save.textContent = 'Save';
      save.addEventListener('click', () => commit(idx));
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn-rename';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => cancel(idx));
      actionCell.appendChild(save);
      actionCell.appendChild(document.createTextNode(' '));
      actionCell.appendChild(cancelBtn);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-rename';
      btn.textContent = 'Rename…';
      btn.addEventListener('click', () => {
        editing[idx] = folder.name;
        saveLocal();
        renderAll();
      });
      actionCell.appendChild(btn);
    }

    li.appendChild(idxCell);
    li.appendChild(nameCell);
    li.appendChild(uriCell);
    li.appendChild(sourceCell);
    li.appendChild(actionCell);
    return li;
  }

  function renderPlaceholderRow(row) {
    const li = document.createElement('li');
    li.className = 'placeholder-row' + (row.locked ? ' locked' : '');

    const shaEl = document.createElement('span');
    shaEl.className = 'placeholder-sha';
    shaEl.textContent = row.sha256.slice(0, 12) + '…';
    shaEl.title = row.sha256;

    const labelEl = document.createElement('span');
    labelEl.className = 'placeholder-label';
    labelEl.textContent = row.label || '';

    const actionEl = document.createElement('div');
    if (!row.locked) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'remove-btn';
      btn.textContent = '×';
      btn.title = 'Remove placeholder';
      btn.setAttribute('aria-label', 'Remove placeholder ' + row.sha256);
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'removePlaceholder', sha256: row.sha256 });
      });
      actionEl.appendChild(btn);
    }

    li.appendChild(shaEl);
    li.appendChild(labelEl);
    li.appendChild(actionEl);
    return li;
  }

  function renderSettingRow(s) {
    const li = document.createElement('li');
    const keyEl = document.createElement('span');
    keyEl.className = 'setting-key' + (s.unknown ? ' unknown' : '');
    keyEl.textContent = s.key;
    if (s.unknown) keyEl.title = 'Not in the known-keys allowlist — restored as-is.';
    const valueEl = document.createElement('span');
    valueEl.className = 'setting-value';
    valueEl.textContent = s.valueSummary;
    li.appendChild(keyEl);
    li.appendChild(valueEl);
    return li;
  }

  function commit(idx) {
    const newName = (editing[idx] !== undefined ? editing[idx] : '').trim();
    delete editing[idx];
    saveLocal();
    if (newName && newName !== state.folders[idx].name) {
      vscode.postMessage({ type: 'renameFolder', index: idx, name: newName });
    } else {
      renderAll();
    }
  }

  function cancel(idx) {
    delete editing[idx];
    saveLocal();
    renderAll();
  }

  document.getElementById('add-placeholder').addEventListener('click', () => {
    vscode.postMessage({ type: 'addPlaceholderFromSample' });
  });
  document.getElementById('refresh').addEventListener('click', () => {
    vscode.postMessage({ type: 'refreshSnapshot' });
  });
  document.getElementById('clear').addEventListener('click', () => {
    vscode.postMessage({ type: 'clearSnapshot' });
  });
  document.getElementById('open-text').addEventListener('click', () => {
    vscode.postMessage({ type: 'openAsText' });
  });

  // ───── embedded full dry-run plan ─────────────────────────────────
  const planStatusEl = document.getElementById('plan-status');
  const planTotalsEl = document.getElementById('plan-totals');
  const planPairsEl = document.getElementById('plan-pairs');
  const planRefreshBtn = document.getElementById('plan-refresh');
  const runSyncBtn = document.getElementById('run-sync');
  const runSyncSafeBtn = document.getElementById('run-sync-safe');
  const runSyncHintEl = document.getElementById('run-sync-hint');

  function hideOrange() {
    runSyncSafeBtn.hidden = true;
    runSyncSafeBtn.disabled = true;
    runSyncSafeBtn.textContent = 'Run Sync (safe items only)';
  }

  // Live label on the orange button — armed-count is read straight off the
  // DOM checkboxes the shared decisionWiringScript posts to the extension.
  // Hooked into window.__decisionWiring so the shared snippet calls it on
  // every toggle without us re-binding listeners. Matches the standalone
  // plan webview's labelling.
  function refreshOrangeButton() {
    if (runSyncSafeBtn.hidden) return;
    let n = 0;
    const cbs = document.querySelectorAll('.decision-input');
    for (let i = 0; i < cbs.length; i++) if (cbs[i].checked) n++;
    runSyncSafeBtn.textContent = n === 0
      ? 'Run Sync (safe items only)'
      : 'Run Sync (with ' + n + ' override' + (n === 1 ? '' : 's') + ')';
  }
  window.__decisionWiring = refreshOrangeButton;

  function setPlanScanning() {
    planStatusEl.className = 'plan-status plan-scanning';
    planStatusEl.textContent = 'Scanning…';
    planRefreshBtn.disabled = true;
    runSyncBtn.disabled = true;
    hideOrange();
    runSyncHintEl.textContent = '';
  }

  function setPlanReady(msg) {
    planRefreshBtn.disabled = false;
    if (msg.empty) {
      planStatusEl.className = 'plan-status';
      planStatusEl.textContent =
        'No source/destination pairs configured. Add a .sync.jsonc to a source folder, and add the named destination to the workspace.';
      planTotalsEl.innerHTML = '';
      planTotalsEl.hidden = true;
      planPairsEl.innerHTML = '';
      runSyncBtn.disabled = true;
      runSyncBtn.textContent = 'Run Sync';
      hideOrange();
      runSyncHintEl.textContent = 'Nothing to sync.';
      return;
    }
    planStatusEl.className = 'plan-status';
    const t = msg.totals || {};
    const parts = [];
    if (t.create) parts.push(t.create + ' to create');
    if (t.updateTracked) parts.push(t.updateTracked + ' to update');
    if (t.updateCollision) parts.push(t.updateCollision + ' collision' + (t.updateCollision === 1 ? '' : 's'));
    if (t.deleteTracked) parts.push(t.deleteTracked + ' to delete');
    if (t.destinationOnly) parts.push(t.destinationOnly + ' destination-only');
    if (parts.length === 0) parts.push('in sync');
    planStatusEl.textContent = 'Plan: ' + parts.join(', ') + '.';
    planTotalsEl.innerHTML = msg.chipsHtml || '';
    planTotalsEl.hidden = !msg.chipsHtml;
    planPairsEl.innerHTML = msg.pairsHtml || '';

    // Run Sync gating mirrors the standalone plan panel's traffic-light.
    // Blocking > 0 → green disabled, orange shown so the user can flush
    // the safe items without resolving collisions/warnings in this view.
    // Per-row decisions still live in the standalone plan webview
    // (folderSync.openPlan); the orange button here is the bulk-skip path.
    //
    // Safe upper bound = create + updateTracked + deleteTracked. The
    // executor's resolveDispatch will further drop warned items in the
    // create/update lanes — worst case orange fires with "nothing to do"
    // when every safe slot is warned, which is acceptable feedback.
    runSyncBtn.textContent = 'Run Sync';
    const safeUpper =
      (t.create || 0) + (t.updateTracked || 0) + (t.deleteTracked || 0);
    if (msg.blocking > 0) {
      runSyncBtn.disabled = true;
      const collisions = t.updateCollision || 0;
      // Severity breakdown: blocked = block-severity warnings (can never
      // ship); overridable = override-severity warnings (the user can arm
      // "Sync anyway" per file in the workspace plan).
      const blocked = t.blockingWarnings || 0;
      const overridable = t.overridableWarnings || 0;
      const hintParts = [];
      if (collisions) hintParts.push(collisions + ' collision' + (collisions === 1 ? '' : 's'));
      if (blocked) hintParts.push(blocked + ' blocked file' + (blocked === 1 ? '' : 's'));
      if (overridable) hintParts.push(overridable + ' file' + (overridable === 1 ? '' : 's') + ' needing override');
      let hint = hintParts.join(' + ');
      if (safeUpper > 0) {
        runSyncSafeBtn.hidden = false;
        runSyncSafeBtn.disabled = false;
        hint +=
          ' — orange skips them (or arm the per-row checkboxes below to ship overrides).';
      } else {
        hideOrange();
        hint += ' — open the workspace plan (Folder Sync: Show Plan) to decide per file.';
      }
      runSyncHintEl.textContent = hint;
      // Reflect any pre-armed (remembered) decisions in the orange label.
      refreshOrangeButton();
    } else if (!msg.hasWork) {
      runSyncBtn.disabled = true;
      hideOrange();
      runSyncHintEl.textContent = 'Nothing to sync — destinations are up to date.';
    } else {
      runSyncBtn.disabled = false;
      hideOrange();
      runSyncHintEl.textContent = '';
    }
  }

  function setPlanError(errorMsg) {
    planRefreshBtn.disabled = false;
    runSyncBtn.disabled = true;
    hideOrange();
    runSyncHintEl.textContent = '';
    planStatusEl.className = 'plan-status plan-error';
    planStatusEl.innerHTML =
      'Error: ' +
      String(errorMsg).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
      ' <button type="button" class="btn btn-secondary btn-sm plan-retry">Retry</button>';
    const retry = planStatusEl.querySelector('.plan-retry');
    if (retry) retry.addEventListener('click', () => {
      setPlanScanning();
      vscode.postMessage({ type: 'refreshPlan' });
    });
    planTotalsEl.innerHTML = '';
    planTotalsEl.hidden = true;
    planPairsEl.innerHTML = '';
  }

  planRefreshBtn.addEventListener('click', () => {
    setPlanScanning();
    vscode.postMessage({ type: 'refreshPlan' });
  });

  runSyncBtn.addEventListener('click', () => {
    if (runSyncBtn.disabled) return;
    runSyncBtn.disabled = true;
    runSyncBtn.textContent = 'Syncing…';
    runSyncSafeBtn.disabled = true;
    planRefreshBtn.disabled = true;
    runSyncHintEl.textContent = '';
    vscode.postMessage({ type: 'runSync' });
  });

  // Orange button posts the same {type:'runSync'} message; the wired side
  // calls executePlan with no decidedOverwrites/decidedDeletes, which the
  // executor treats as safe-items-only (collisions, destination-only, and
  // warned items all skip).
  runSyncSafeBtn.addEventListener('click', () => {
    if (runSyncSafeBtn.disabled) return;
    runSyncBtn.disabled = true;
    runSyncSafeBtn.disabled = true;
    runSyncSafeBtn.textContent = 'Syncing…';
    planRefreshBtn.disabled = true;
    runSyncHintEl.textContent = '';
    vscode.postMessage({ type: 'runSync' });
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'docChanged') {
      // Snapshot file rewritten — fold in the new payload. Drop in-flight
      // edits whose index no longer exists; preserve others so a rename in
      // progress isn't clobbered by an unrelated topology event.
      state = msg.payload;
      for (const idx of Object.keys(editing)) {
        if (Number(idx) >= (state.folders || []).length) delete editing[idx];
      }
      saveLocal();
      renderAll();
    } else if (msg.type === 'planStatus') {
      if (msg.status === 'scanning') setPlanScanning();
      else if (msg.status === 'ready') setPlanReady(msg);
      else if (msg.status === 'error') setPlanError(msg.error || 'unknown error');
    } else if (msg.type === 'syncStatus') {
      if (msg.status === 'running') {
        runSyncBtn.disabled = true;
        runSyncSafeBtn.disabled = true;
        // Show "Syncing…" on whichever button isn't already showing it.
        if (runSyncBtn.textContent !== 'Syncing…' && runSyncSafeBtn.textContent !== 'Syncing…') {
          runSyncBtn.textContent = 'Syncing…';
        }
      } else if (msg.status === 'done') {
        // Extension follows up with a fresh planStatus shortly — that
        // recomputes which button is visible/enabled. Just reset labels.
        runSyncBtn.textContent = 'Run Sync';
        runSyncSafeBtn.textContent = 'Run Sync (safe items only)';
        refreshOrangeButton();
        hideProgress();
      } else if (msg.status === 'error') {
        runSyncBtn.textContent = 'Run Sync';
        runSyncSafeBtn.textContent = 'Run Sync (safe items only)';
        refreshOrangeButton();
        // Re-enable buttons defensively; the next planStatus will gate them
        // properly. Without this the editor would be stuck if a planStatus
        // doesn't follow.
        runSyncBtn.disabled = false;
        if (!runSyncSafeBtn.hidden) runSyncSafeBtn.disabled = false;
        runSyncHintEl.textContent = 'Sync failed: ' + (msg.error || 'unknown error');
        hideProgress();
      }
    } else if (msg.type === 'syncProgress') {
      showSyncProgress(
        typeof msg.done === 'number' ? msg.done : 0,
        typeof msg.total === 'number' ? msg.total : 0,
        typeof msg.relPath === 'string' ? msg.relPath : '',
        typeof msg.destLabel === 'string' ? msg.destLabel : '',
        typeof msg.status === 'string' ? msg.status : 'ok',
      );
    }
  });

  // Per-op progress bar — fed by syncProgress messages from runSync's
  // onProgress callback. Hidden once the syncStatus done/error message lands.
  const progressBox = document.getElementById('sync-progress');
  const progressFill = progressBox ? progressBox.querySelector('.sync-progress-fill') : null;
  const progressCount = progressBox ? progressBox.querySelector('.sync-progress-count') : null;
  const progressPath = progressBox ? progressBox.querySelector('.sync-progress-path') : null;

  function showSyncProgress(done, total, relPath, destLabel, status){
    if (!progressBox || !progressFill || !progressCount || !progressPath) return;
    progressBox.hidden = false;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    progressFill.style.width = pct + '%';
    if (status === 'failed') progressFill.classList.add('sync-progress-fill-error');
    progressCount.textContent = done + ' / ' + total + (total > 0 ? ' (' + pct + '%)' : '');
    let suffix = '';
    if (destLabel && relPath) suffix = destLabel + ' • ' + relPath;
    else if (relPath) suffix = relPath;
    else if (destLabel) suffix = destLabel;
    else suffix = 'Starting\\u2026';
    progressPath.textContent = suffix;
  }
  function hideProgress(){
    if (!progressBox || !progressFill) return;
    progressBox.hidden = true;
    progressFill.classList.remove('sync-progress-fill-error');
  }

  renderAll();
})();
`;
