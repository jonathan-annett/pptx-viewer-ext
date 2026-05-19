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
import { planContentStyles } from './planHtml';

export interface WorkspaceFolderEntry {
  /** URI string — the stable identifier persisted in `.sync.jsonc`. */
  uri: string;
  /** Live display name from the workspace folder. Shown in the dropdown. */
  name: string;
}

export interface ConfigEditorViewModel {
  /** Initial config to pre-fill the form. */
  initialConfig: SyncConfig;
  /**
   * Currently-open workspace folders, used to populate the destination
   * dropdown. The dropdown shows each entry's display `name` but persists
   * its `uri` into the config — display names are mutable (admin editor's
   * Rename button), so we never key off them.
   */
  workspaceFolders: WorkspaceFolderEntry[];
  /**
   * URI of the workspace folder containing this `.sync.jsonc`. Excluded from
   * the dropdown options — a source cannot be its own destination, otherwise
   * sync would target the folder it's reading from. May be null when the
   * file isn't inside any open workspace folder (an edge case but possible
   * when the form is opened on a detached URI).
   */
  sourceFolderUri: string | null;
  /**
   * URIs claimed as destinations by other `.sync.jsonc` files in the
   * workspace. Each destination URI may be owned by only one source — see
   * the matching diagnostic in topology.ts. The dropdown filters these out
   * so the user can't accidentally create the conflict in the first place.
   */
  claimedElsewhere: string[];
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
    workspaceFolders: vm.workspaceFolders,
    sourceFolderUri: vm.sourceFolderUri,
    claimedElsewhere: vm.claimedElsewhere,
    parseError: vm.parseError,
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<title>Folder Sync configuration</title>
<style>${STYLE}${planContentStyles()}${EMBEDDED_PLAN_STYLE}</style>
</head>
<body>
  <header class="page-header">
    <h1>Folder Sync configuration</h1>
    <p class="subtle">Edits here are written back to <code>.sync.jsonc</code> with comments preserved. Use <em>Reopen with…</em> to edit as raw text.</p>
  </header>

  <div id="parse-error" class="banner warn" hidden></div>

  <section class="card">
    <h2>Destinations</h2>
    <p class="hint">Pick a workspace folder for each destination. The source folder (where this <code>.sync.jsonc</code> lives) and any folder already claimed by another <code>.sync.jsonc</code> are filtered out automatically.</p>
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

  <section class="card plan-card">
    <div class="plan-card-head">
      <h2>Dry-run plan — this room</h2>
      <button id="plan-refresh" class="btn btn-secondary btn-sm" type="button" title="Re-scan the source folder and rebuild the plan">Refresh</button>
    </div>
    <p class="hint">Auto-runs whenever this file or the source folder changes. Limited to the destinations declared above — use <em>Open workspace-wide plan</em> below for the whole workspace.</p>
    <div id="plan-status" class="plan-status plan-scanning">Scanning…</div>
    <div id="plan-totals" class="totals" hidden></div>
    <div id="plan-pairs" class="plan-pairs"></div>
    <div class="plan-actions">
      <button id="run-sync" class="btn btn-green" type="button" disabled title="Apply the green-path operations from the plan above — limited to this room's destinations">Run Sync</button>
      <span id="run-sync-hint" class="hint plan-actions-hint"></span>
    </div>
  </section>

  <section class="actions">
    <button id="open-workspace-plan" class="btn btn-secondary" type="button">Open workspace-wide plan</button>
    <button id="open-text" class="btn btn-secondary" type="button">Reopen as text</button>
  </section>

  <p class="hint">Run Sync above executes this room only. The workspace-wide plan opens in a separate panel and covers every <code>.sync.jsonc</code> in the workspace — use it when you need to coordinate across rooms.</p>

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
  gap: 8px 8px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.15));
}
.dest-list li:last-child { border-bottom: none; }
.dest-uri {
  grid-column: 1 / -1;
  margin: 0;
  padding: 0;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.78em;
  color: var(--vscode-descriptionForeground);
  word-break: break-all;
  /* Pad the caption left so it lines up visually under the name column.
     Negative top-margin tightens the gap so it reads as one row. */
  margin-top: -4px;
}
.dest-uri.stale { color: var(--vscode-errorForeground, #cc5555); }
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

// Styles that complement planContentStyles() inside the embedded plan card.
// planContentStyles supplies `.totals`/`.pair`/`.sec`/`.rows`/`.banner` —
// these rules add the host-side framing (card header row, status pill,
// scanning shimmer) and tighten spacing so the section reads as one unit.
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
.plan-error {
  color: var(--vscode-errorForeground);
}
.plan-error .plan-retry {
  margin-left: 8px;
}
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
      uri: d.uri || '',
      path: d.path || '',
    })),
    include: initial.config.include || [],
    exclude: initial.config.exclude || [],
    // Each entry: { uri, name }. Display name is for the dropdown label;
    // the option value (what gets persisted in .sync.jsonc) is the URI.
    workspaceFolders: initial.workspaceFolders || [],
    // The workspace folder hosting this .sync.jsonc — filtered out of the
    // destination dropdown (source ≠ destination invariant).
    sourceFolderUri: initial.sourceFolderUri || null,
    // URIs already claimed as destinations by some other .sync.jsonc —
    // filtered out of the dropdown (one destination → one source).
    claimedElsewhere: Array.isArray(initial.claimedElsewhere) ? initial.claimedElsewhere : [],
  };

  function fallbackNameFromUri(uri) {
    // Mirrors topology.ts:fallbackNameFromUri — used purely for the "(not in
    // workspace)" stale row so the dropdown still has something readable.
    try {
      var u = new URL(uri);
      var path = u.pathname.replace(/\\/+$/, '');
      var idx = path.lastIndexOf('/');
      var seg = idx >= 0 ? path.slice(idx + 1) : path;
      var decoded = decodeURIComponent(seg);
      return decoded || uri;
    } catch (_) { return uri; }
  }

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

      // Destination dropdown — value is the workspace folder URI (what gets
      // persisted), label is the live display name (what reads naturally).
      //
      // Filter rules:
      //   - The source folder (workspace folder containing this .sync.jsonc)
      //     is never offered — a source cannot sync into itself.
      //   - URIs claimed by some OTHER .sync.jsonc file are never offered —
      //     each destination URI may be owned by exactly one source.
      //   - A "stale" row appears when the persisted URI isn't currently in
      //     the workspace; we surface it as a labelled disabled-looking
      //     option so the user can see what's saved without losing the
      //     value.
      //   - If the currently-selected URI is excluded for a reason above, we
      //     keep it as a labelled option (so the user sees what's saved and
      //     why it's wrong) — they can then pick a valid alternative.
      const select = document.createElement('select');
      const usedByOtherRows = new Set(
        state.destinations
          .map((d, j) => (j === idx ? null : d.uri))
          .filter(Boolean)
      );

      function isFiltered(uri) {
        if (!uri) return false;
        if (state.sourceFolderUri && uri === state.sourceFolderUri) return 'source';
        if (state.claimedElsewhere.indexOf(uri) !== -1) return 'claimed';
        if (usedByOtherRows.has(uri)) return 'self-dupe';
        return false;
      }

      const offered = state.workspaceFolders.filter(f => !isFiltered(f.uri));
      const isStale = dest.uri && !state.workspaceFolders.some(f => f.uri === dest.uri);
      const filteredReason = isFiltered(dest.uri);

      // If the saved value is currently filtered out (e.g. a manual edit
      // moved the source-folder URI into the file), prepend a labelled
      // option so the form still shows the user what's persisted.
      if (filteredReason) {
        const label =
          filteredReason === 'source'
            ? '  (source folder — cannot be its own destination)'
            : filteredReason === 'claimed'
            ? '  (claimed by another .sync.jsonc)'
            : '  (already used in another row)';
        offered.unshift({
          uri: dest.uri,
          name: fallbackNameFromUri(dest.uri) + label,
        });
      } else if (isStale) {
        offered.unshift({
          uri: dest.uri,
          name: fallbackNameFromUri(dest.uri) + '  (not in workspace)',
        });
      }

      if (offered.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(no workspace folders available — every folder is the source or already a destination)';
        select.appendChild(opt);
      } else {
        offered.forEach(f => {
          const opt = document.createElement('option');
          opt.value = f.uri;
          opt.textContent = f.name || fallbackNameFromUri(f.uri);
          if (f.uri === dest.uri) opt.selected = true;
          select.appendChild(opt);
        });
      }
      select.addEventListener('change', () => {
        state.destinations[idx].uri = select.value;
        renderDestList();
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

      // URI caption — shows the literal value persisted in the config. Span
      // the full row so a long URI doesn't squeeze the controls above. A
      // "stale" colour applies for any condition that the topology resolver
      // would flag (not in workspace, source-self, or claimed elsewhere).
      const uriEl = document.createElement('p');
      const captionWarn = isStale || !!filteredReason;
      uriEl.className = 'dest-uri' + (captionWarn ? ' stale' : '');
      uriEl.title = filteredReason === 'source'
        ? 'This URI is the source folder of this .sync.jsonc — a source cannot be its own destination.'
        : filteredReason === 'claimed'
        ? 'This URI is already claimed as a destination by another .sync.jsonc file in the workspace.'
        : filteredReason === 'self-dupe'
        ? 'This URI is already used as a destination by another row in this .sync.jsonc.'
        : isStale
        ? 'This destination is recorded in .sync.jsonc but the folder is not currently open in the workspace.'
        : 'URI persisted in .sync.jsonc — stable across folder renames.';
      uriEl.textContent = dest.uri || '(no URI set)';

      li.appendChild(select);
      li.appendChild(pathInput);
      li.appendChild(rm);
      li.appendChild(uriEl);
      destListEl.appendChild(li);
    });
  }

  document.getElementById('add-dest').addEventListener('click', () => {
    // Default to the first workspace folder that's actually a legal
    // destination — skip the source folder, anything claimed by other
    // .sync.jsonc files, and anything already used in this form. Falls back
    // to '' (no URI) if no legal option exists; the user sees the empty
    // dropdown message and either adds another folder to the workspace or
    // frees one up.
    const usedHere = new Set(state.destinations.map(d => d.uri).filter(Boolean));
    const claimed = new Set(state.claimedElsewhere);
    const firstLegal = state.workspaceFolders.find(f =>
      f.uri !== state.sourceFolderUri && !claimed.has(f.uri) && !usedHere.has(f.uri),
    );
    state.destinations.push({ uri: firstLegal ? firstLegal.uri : '', path: '' });
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
          .filter(d => d.uri)
          .map(d => d.path ? { uri: d.uri, path: d.path } : { uri: d.uri }),
        include: state.include,
        exclude: state.exclude,
      },
    });
  }

  document.getElementById('open-workspace-plan').addEventListener('click', () => {
    vscode.postMessage({ type: 'openWorkspacePlan' });
  });

  document.getElementById('open-text').addEventListener('click', () => {
    vscode.postMessage({ type: 'openAsText' });
  });

  // ───── embedded plan section ──────────────────────────────────────
  const planStatusEl = document.getElementById('plan-status');
  const planTotalsEl = document.getElementById('plan-totals');
  const planPairsEl = document.getElementById('plan-pairs');
  const planRefreshBtn = document.getElementById('plan-refresh');
  const runSyncBtn = document.getElementById('run-sync');
  const runSyncHintEl = document.getElementById('run-sync-hint');

  function setPlanScanning() {
    planStatusEl.className = 'plan-status plan-scanning';
    planStatusEl.textContent = 'Scanning…';
    planRefreshBtn.disabled = true;
    runSyncBtn.disabled = true;
    runSyncHintEl.textContent = '';
  }

  function setPlanReady(msg) {
    planRefreshBtn.disabled = false;
    if (msg.empty) {
      planStatusEl.className = 'plan-status';
      planStatusEl.textContent =
        'No destinations to plan — add one above (the dropdown values come from your open workspace folders).';
      planTotalsEl.innerHTML = '';
      planTotalsEl.hidden = true;
      planPairsEl.innerHTML = '';
      runSyncBtn.disabled = true;
      runSyncBtn.textContent = 'Run Sync';
      runSyncHintEl.textContent = 'Nothing to sync.';
      return;
    }
    planStatusEl.className = 'plan-status';
    // Compact summary line so the user gets a one-glance read even before
    // expanding sections. The chip strip below gives the colour-coded counts.
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

    // Run Sync gating mirrors the admin editor's: blocking → disabled with
    // a collision hint; no work → disabled with "Nothing to sync"; otherwise
    // enabled in green.
    runSyncBtn.textContent = 'Run Sync';
    if (msg.blocking > 0) {
      runSyncBtn.disabled = true;
      runSyncHintEl.textContent =
        msg.blocking + ' collision' + (msg.blocking === 1 ? '' : 's') +
        ' must be resolved before sync. Inline decisions land in M5.';
    } else if (!msg.hasWork) {
      runSyncBtn.disabled = true;
      runSyncHintEl.textContent = 'Nothing to sync — destinations are up to date.';
    } else {
      runSyncBtn.disabled = false;
      runSyncHintEl.textContent = '';
    }
  }

  function setPlanError(errorMsg) {
    planRefreshBtn.disabled = false;
    runSyncBtn.disabled = true;
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
    planRefreshBtn.disabled = true;
    runSyncHintEl.textContent = '';
    vscode.postMessage({ type: 'runSync' });
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'docChanged') {
      // External edit. Re-derive form state from the new config.
      state.destinations = (msg.config.destinations || []).map(d => ({
        uri: d.uri || '',
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
    } else if (msg.type === 'workspaceFoldersChanged') {
      state.workspaceFolders = msg.workspaceFolders || [];
      if (Array.isArray(msg.claimedElsewhere)) {
        state.claimedElsewhere = msg.claimedElsewhere;
      }
      if (typeof msg.sourceFolderUri !== 'undefined') {
        state.sourceFolderUri = msg.sourceFolderUri || null;
      }
      renderDestList();
    } else if (msg.type === 'planStatus') {
      if (msg.status === 'scanning') setPlanScanning();
      else if (msg.status === 'ready') setPlanReady(msg);
      else if (msg.status === 'error') setPlanError(msg.error || 'unknown error');
    } else if (msg.type === 'syncStatus') {
      if (msg.status === 'running') {
        runSyncBtn.disabled = true;
        runSyncBtn.textContent = 'Syncing…';
      } else if (msg.status === 'done') {
        // The extension follows up with a fresh planStatus shortly — the
        // chip strip will reflect the post-sync world. Keep the button
        // disabled until then so a double-click can't re-fire mid-refresh.
        runSyncBtn.textContent = 'Run Sync';
      } else if (msg.status === 'error') {
        runSyncBtn.textContent = 'Run Sync';
        runSyncBtn.disabled = false;
        runSyncHintEl.textContent = 'Sync failed: ' + (msg.error || 'unknown error');
      }
    }
  });

  renderDestList();
})();
`;
