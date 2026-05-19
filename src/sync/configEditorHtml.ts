// Pure HTML renderer for the .sync.jsonc custom text editor.
//
// No vscode import — pairs with configEditor.ts (vscode-wired) per the
// pure/wired split convention in CLAUDE.md.
//
// The page is a two-pane form + embedded dry-run plan area. All form state
// lives client-side; the webview posts `setConfig` messages to the extension
// when the user edits anything, and the extension serialises through
// jsonc-parser's modification API so comments + formatting are preserved.

import type { SyncConfig } from './configParse';

export interface ConfigEditorViewModel {
  /** Initial config to pre-fill the form. */
  initialConfig: SyncConfig;
  /** Names of currently-open workspace folders, used to populate the dropdown. */
  workspaceFolderNames: string[];
  /** If the document failed to parse, the error to surface in the banner. */
  parseError: string | null;
}

/**
 * Render the editor HTML. The `nonce` must be unique per render and match the
 * CSP `script-src 'nonce-...'` directive — same pattern as the plan view and
 * the pptx viewer panel.
 */
export function renderConfigEditorHtml(vm: ConfigEditorViewModel, nonce: string): string {
  // The initial payload is serialised into a data-island script tag rather
  // than HTML-escaped into JS code — the JSON.stringify output is safe to
  // place inside <script type="application/json"> because the only sequence
  // that could close the tag is "</" which JSON.stringify naturally escapes
  // when the value is a string. For object payloads, we use String.replace
  // on the JSON output for the rare case where a workspace folder name
  // contains "</".
  const initialPayload = JSON.stringify({
    config: vm.initialConfig,
    workspaceFolderNames: vm.workspaceFolderNames,
    parseError: vm.parseError,
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<title>Folder Sync configuration</title>
<style>${STYLE}</style>
</head>
<body>
  <header class="page-header">
    <h1>Folder Sync configuration</h1>
    <p class="subtle">Edits here are written back to <code>.sync.jsonc</code> with comments preserved. Use <em>Reopen with…</em> to edit as raw text.</p>
  </header>

  <div id="parse-error" class="banner warn" hidden></div>

  <section class="card">
    <h2>Destinations</h2>
    <p class="hint">Each destination's <code>name</code> must match a workspace folder open in vscode.dev. Add the folder via <em>File → Add Folder to Workspace</em>.</p>
    <ul id="dest-list" class="dest-list"></ul>
    <button id="add-dest" class="btn btn-secondary" type="button">+ Add destination</button>
  </section>

  <section class="card">
    <h2>Include</h2>
    <p class="hint">Glob patterns to include. Leave empty to include everything not excluded. One pattern per line.</p>
    <textarea id="include" rows="4" spellcheck="false"></textarea>
  </section>

  <section class="card">
    <h2>Exclude</h2>
    <p class="hint">Glob patterns to exclude, in addition to the built-ins (<code>.git</code>, <code>.DS_Store</code>, <code>~$*</code>, <code>.sync.jsonc</code>, <code>.foldersync-manifest.json</code>). One pattern per line.</p>
    <textarea id="exclude" rows="4" spellcheck="false"></textarea>
  </section>

  <section class="actions">
    <button id="dry-run" class="btn btn-primary" type="button">Open dry-run plan</button>
    <button id="open-text" class="btn btn-secondary" type="button">Reopen as text</button>
  </section>

  <p class="hint">Dry run opens the workspace-wide plan in a separate panel. No files are written.</p>

  <script id="init-payload" type="application/json" nonce="${nonce}">${initialPayload}</script>
  <script nonce="${nonce}">${CLIENT_JS}</script>
</body>
</html>`;
}

// ───── CSS ──────────────────────────────────────────────────────────────
//
// Theme-aware via VS Code's CSS variables. The same palette + spacing scheme
// used by the plan webview and pptx viewer panel.

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
.dest-list { list-style: none; padding: 0; margin: 0 0 10px; }
.dest-list li {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) minmax(160px, 2fr) auto;
  gap: 8px;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.15));
}
.dest-list li:last-child { border-bottom: none; }
select, input[type="text"], textarea {
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
textarea { resize: vertical; min-height: 60px; }
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
.btn-remove {
  background: transparent;
  border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.3));
  color: var(--vscode-errorForeground, #cc5555);
  padding: 2px 8px;
  border-radius: 3px;
  cursor: pointer;
}
.actions { display: flex; gap: 8px; margin: 16px 0 8px; }
`;

// ───── client-side JS ──────────────────────────────────────────────────
//
// Reads the data-island payload, builds form state, posts `setConfig` to the
// extension on any edit. Re-renders the dest list from state on each change.
// Textarea edits debounce so we don't spam the extension during typing.

const CLIENT_JS = `
(function () {
  const vscode = acquireVsCodeApi();
  const payloadEl = document.getElementById('init-payload');
  const initial = JSON.parse(payloadEl.textContent);

  const state = {
    destinations: (initial.config.destinations || []).map(d => ({
      name: d.name || '',
      path: d.path || '',
    })),
    include: initial.config.include || [],
    exclude: initial.config.exclude || [],
    folderNames: initial.workspaceFolderNames || [],
  };

  const parseErrEl = document.getElementById('parse-error');
  if (initial.parseError) {
    parseErrEl.textContent = 'Cannot parse file: ' + initial.parseError;
    parseErrEl.hidden = false;
  }

  const destListEl = document.getElementById('dest-list');
  const includeEl = document.getElementById('include');
  const excludeEl = document.getElementById('exclude');

  includeEl.value = state.include.join('\\n');
  excludeEl.value = state.exclude.join('\\n');

  function renderDestList() {
    destListEl.innerHTML = '';
    state.destinations.forEach((dest, idx) => {
      const li = document.createElement('li');

      // Name dropdown — populated from workspace folders. If the current name
      // isn't in the dropdown, we still display it as a stale entry so the
      // user can see + fix it without losing the value.
      const select = document.createElement('select');
      const names = state.folderNames.slice();
      const stale = dest.name && !names.includes(dest.name);
      if (stale) names.unshift(dest.name);
      if (names.length === 0) names.push('');
      names.forEach(n => {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n || '(no workspace folders)';
        if (n === dest.name) opt.selected = true;
        if (stale && n === dest.name) opt.textContent = n + '  (not in workspace)';
        select.appendChild(opt);
      });
      select.addEventListener('change', () => {
        state.destinations[idx].name = select.value;
        flush();
      });

      const pathInput = document.createElement('input');
      pathInput.type = 'text';
      pathInput.placeholder = 'optional subpath, e.g. projects/alpha';
      pathInput.value = dest.path;
      pathInput.addEventListener('input', () => {
        state.destinations[idx].path = pathInput.value;
      });
      pathInput.addEventListener('change', flush);
      pathInput.addEventListener('blur', flush);

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn-remove';
      rm.textContent = '×';
      rm.title = 'Remove destination';
      rm.addEventListener('click', () => {
        state.destinations.splice(idx, 1);
        renderDestList();
        flush();
      });

      li.appendChild(select);
      li.appendChild(pathInput);
      li.appendChild(rm);
      destListEl.appendChild(li);
    });
  }

  document.getElementById('add-dest').addEventListener('click', () => {
    state.destinations.push({
      name: state.folderNames[0] || '',
      path: '',
    });
    renderDestList();
    flush();
  });

  let textareaTimer = null;
  function scheduleTextareaFlush() {
    clearTimeout(textareaTimer);
    textareaTimer = setTimeout(() => {
      state.include = parseLines(includeEl.value);
      state.exclude = parseLines(excludeEl.value);
      flush();
    }, 300);
  }
  includeEl.addEventListener('input', scheduleTextareaFlush);
  excludeEl.addEventListener('input', scheduleTextareaFlush);
  includeEl.addEventListener('blur', () => {
    clearTimeout(textareaTimer);
    state.include = parseLines(includeEl.value);
    state.exclude = parseLines(excludeEl.value);
    flush();
  });
  excludeEl.addEventListener('blur', () => {
    clearTimeout(textareaTimer);
    state.include = parseLines(includeEl.value);
    state.exclude = parseLines(excludeEl.value);
    flush();
  });

  function parseLines(text) {
    return text.split('\\n').map(s => s.trim()).filter(s => s.length > 0);
  }

  function flush() {
    vscode.postMessage({
      type: 'setConfig',
      config: {
        destinations: state.destinations
          .filter(d => d.name)
          .map(d => d.path ? { name: d.name, path: d.path } : { name: d.name }),
        include: state.include,
        exclude: state.exclude,
      },
    });
  }

  document.getElementById('dry-run').addEventListener('click', () => {
    vscode.postMessage({ type: 'requestDryRun' });
  });

  document.getElementById('open-text').addEventListener('click', () => {
    vscode.postMessage({ type: 'openAsText' });
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'docChanged') {
      // External edit. Re-derive form state from the new config.
      state.destinations = (msg.config.destinations || []).map(d => ({
        name: d.name || '',
        path: d.path || '',
      }));
      state.include = msg.config.include || [];
      state.exclude = msg.config.exclude || [];
      includeEl.value = state.include.join('\\n');
      excludeEl.value = state.exclude.join('\\n');
      renderDestList();
      if (msg.parseError) {
        parseErrEl.textContent = 'Cannot parse file: ' + msg.parseError;
        parseErrEl.hidden = false;
      } else {
        parseErrEl.hidden = true;
      }
    } else if (msg.type === 'folderNamesChanged') {
      state.folderNames = msg.workspaceFolderNames || [];
      renderDestList();
    }
  });

  renderDestList();
})();
`;
