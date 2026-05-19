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
//
// The file itself is managed automatically — direct text edits get
// clobbered on the next topology change. The header comment in the file
// says so; this editor's intro panel says so. Edits flow through the
// snapshot writer rather than through onDidChangeTextDocument.

export interface AdminEditorFolder {
  uri: string;
  name: string;
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

export interface AdminEditorViewModel {
  folders: AdminEditorFolder[];
  settings: AdminEditorSettingSummary[];
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
<style>${STYLE}</style>
</head>
<body>
  <header class="page-header">
    <h1>Workspace snapshot</h1>
    <p class="subtle">This file is managed automatically. It records the folders and settings of the current workspace so the next browser refresh can restore them silently. <strong>Do not hand-edit</strong> — changes are clobbered on the next topology event. Use the controls below, or <em>Reopen as text</em> for a raw view.</p>
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

  <section class="actions">
    <button id="refresh" class="btn btn-primary" type="button" title="Recapture the current workspace and overwrite this file">Refresh from current workspace</button>
    <button id="clear" class="btn btn-danger" type="button" title="Delete this file and clear the pointer — next refresh will land in a folderless tab">Clear snapshot</button>
    <button id="open-text" class="btn btn-secondary" type="button">Reopen as text</button>
  </section>

  <p class="hint">Use <em>Folder Sync: Show Workspace Snapshot</em> for an Output Channel dump.</p>

  <script id="init-payload" type="application/json" nonce="${nonce}">${initialPayload}</script>
  <script nonce="${nonce}">${CLIENT_JS}</script>
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
.folder-list li { grid-template-columns: 24px minmax(140px, 1fr) minmax(160px, 2fr) auto; }
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
.editing { background: var(--vscode-editor-selectionBackground, rgba(127,127,127,0.15)); }
`;

// ───── client-side JS ──────────────────────────────────────────────────
//
// Reads the data-island payload, renders the folder + setting lists, posts
// command messages to the extension. Listens for `docChanged` messages so
// external rewrites (the snapshot writer firing after a topology change) are
// reflected without losing focus.

const CLIENT_JS = `
(function () {
  const vscode = acquireVsCodeApi();
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
    li.appendChild(actionCell);
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

  document.getElementById('refresh').addEventListener('click', () => {
    vscode.postMessage({ type: 'refreshSnapshot' });
  });
  document.getElementById('clear').addEventListener('click', () => {
    vscode.postMessage({ type: 'clearSnapshot' });
  });
  document.getElementById('open-text').addEventListener('click', () => {
    vscode.postMessage({ type: 'openAsText' });
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
    }
  });

  renderAll();
})();
`;
