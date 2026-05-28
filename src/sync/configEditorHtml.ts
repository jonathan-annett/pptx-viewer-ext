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
import { decisionWiringScript, planContentStyles } from './planHtml';

/**
 * Minimal HTML-escape — only the four characters that change meaning inside
 * an HTML element or unquoted attribute. The workspace-root handle goes into
 * an `<h1>` and a `<code>`, both contexts where this set suffices.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
  /**
   * True when this config file is a workspace-root named `.roomSync` (M3 of
   * room-sync-format-v1-plan.md). The editor surfaces a distinct intro
   * banner explaining the "logical destination handle" semantics, and the
   * Path aliases section becomes mandatory (the loader rejects saves with
   * an empty record at this location).
   *
   * Detected from the document URI: it sits directly under a workspace
   * folder root AND the filename has a non-empty prefix before `.roomSync`.
   * The bare `.roomSync` (folder-level config at the workspace root) keeps
   * the legacy semantics — this flag is false for it.
   */
  isWorkspaceRoot: boolean;
  /**
   * Human-readable filename prefix when {@link isWorkspaceRoot} is true —
   * e.g. `Room 1` for a file named `Room 1.roomSync`. Used as the editor's
   * heading line so the operator recognises which logical destination they
   * are configuring. Empty string when not at workspace root.
   */
  workspaceRootHandle: string;
  /**
   * Resolved value of the `${roomSync}` template variable for this config
   * file (v1 follow-up). The editor reads the document text *literally*
   * (no pre-parse substitution) so form inputs show the raw template; this
   * value is shown alongside as a helper line so the user can see what the
   * variable resolves to in context without losing the template on form
   * save. Empty string when no meaningful handle is available.
   *
   * Resolution rules (per `roomSyncHandle` in configFilenames.ts):
   *  - Workspace-root `<handle>.roomSync` → filename prefix
   *  - Folder-level config → enclosing folder basename
   *  - Bare workspace-root config → workspace folder name
   */
  roomSyncHandle: string;
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
    isWorkspaceRoot: vm.isWorkspaceRoot,
    workspaceRootHandle: vm.workspaceRootHandle,
  }).replace(/</g, '\\u003c');

  // Workspace-root variant banner — only rendered for named `<dest>.roomSync`
  // configs at a workspace folder root. Explains the M3 semantics: the
  // filename prefix is a UX handle (not parsed), path-aliases is mandatory,
  // and the source folder is the entire workspace. The folder-level intro
  // banner is replaced — not appended — so the user sees the right framing
  // up top.
  const headerBlock = vm.isWorkspaceRoot
    ? `<header class="page-header">
    <h1>Logical destination: ${escapeHtml(vm.workspaceRootHandle || '(unnamed)')}</h1>
    <p class="subtle">This <code>${escapeHtml(vm.workspaceRootHandle)}.roomSync</code> file lives at the workspace folder root. The filename prefix is a human-readable handle for the destination group — it is not parsed, and <code>destinations[]</code> below stays authoritative. <strong>Path aliases are mandatory at this location</strong>: without them the sync engine has no signal for which sub-trees to walk under the workspace root.</p>
  </header>`
    : `<header class="page-header">
    <h1>Folder Sync configuration</h1>
    <p class="subtle">Edits here are written back to <code>.sync.jsonc</code> with comments preserved. Use <em>Reopen with…</em> to edit as raw text.</p>
  </header>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<title>Folder Sync configuration</title>
<style>${STYLE}${planContentStyles()}${EMBEDDED_PLAN_STYLE}</style>
</head>
<body>
  ${headerBlock}

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
    <p class="hint">Glob patterns to exclude, in addition to the built-ins (<code>.git</code>, <code>.DS_Store</code>, <code>~$*</code>, <code>.sync.jsonc</code>, <code>.roomSync</code>, <code>.foldersync-manifest.json</code>). One pattern per line.</p>
    <textarea id="exclude" rows="4" spellcheck="false"></textarea>
  </section>

  <section class="card">
    <h2>Path aliases</h2>
    <p class="hint">Rewrite source-relative directories into destination-relative directories. When non-empty, only files inside one of the listed <em>From</em> directories sync — the destination relpath is <em>To</em> + the sub-path inside <em>From</em>. Useful for unifying day-major layouts (<code>MON/room1</code>, <code>TUE/room1</code>, …) into a room-major destination tree. Precedence is the row order (first match wins) — use the arrow buttons to reorder. Wildcards are supported: <code>*</code> matches one segment, <code>**</code> matches many, and the n-th wildcard on the <em>From</em> side feeds the n-th wildcard on <em>To</em> — so <code>*/room1</code> → <code>*</code> handles every day with one rule.</p>
    ${vm.roomSyncHandle ? `<p class="hint room-sync-var">Template variable: <code>\${roomSync}</code> resolves to <code>${escapeHtml(vm.roomSyncHandle)}</code> for this config file. Useful in generator-emitted templates — write <code>\${roomSync}/foo</code> in <em>From</em> or <em>To</em> and the loader substitutes the handle at runtime.</p>` : ''}
    <ul id="alias-list" class="alias-list"></ul>
    <button id="add-alias" class="btn btn-secondary" type="button">+ Add path alias</button>
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
    <button id="open-workspace-plan" class="btn btn-secondary" type="button">Open workspace-wide plan</button>
    <button id="open-text" class="btn btn-secondary" type="button">Reopen as text</button>
  </section>

  <p class="hint">Run Sync above executes this room only. The workspace-wide plan opens in a separate panel and covers every <code>.sync.jsonc</code> in the workspace — use it when you need to coordinate across rooms.</p>

  <script id="init-payload" type="application/json" nonce="${nonce}">${initialPayload}</script>
  <script nonce="${nonce}">${CLIENT_JS}</script>
  <script nonce="${nonce}">${decisionWiringScript()}</script>
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
/* Path-aliases list — From/To pair, reorder controls, remove. The grid
   keeps From and To equal-width so users can see both sides at a glance;
   the arrow column is intrinsic-width. M2 of room-sync-format-v1-plan.md. */
.alias-list { list-style: none; padding: 0; margin: 0 0 10px; }
.alias-list li {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) auto minmax(120px, 1fr) auto auto;
  gap: 6px 8px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.15));
}
.alias-list li:last-child { border-bottom: none; }
.alias-arrow {
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family);
  font-size: 0.9em;
}
.alias-move {
  background: transparent;
  border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.3));
  color: var(--vscode-foreground);
  padding: 2px 6px;
  border-radius: 3px;
  cursor: pointer;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.9em;
}
.alias-move:disabled { opacity: 0.4; cursor: not-allowed; }
.alias-move-group { display: inline-flex; gap: 2px; }
/* Template-variable helper line — surfaces the resolved roomSync handle
   under the Path aliases section's main hint. Subdued background so it
   reads as a side-note, not the primary instruction. v1 follow-up. */
.room-sync-var {
  margin-top: 2px;
  margin-bottom: 12px;
  padding: 6px 10px;
  background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.08));
  border-left: 2px solid var(--vscode-textLink-foreground, rgba(127,127,127,0.4));
  border-radius: 2px;
}
.room-sync-var code {
  background: transparent;
  padding: 0;
}
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
/* Per-op sync progress bar — fed by syncProgress messages while a run is
   in flight; re-hidden when syncStatus done/error follows. */
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
// Reads the data-island payload, builds form state, posts `setConfig` to the
// extension on any edit. Re-renders the dest list from state on each change.
// Textarea edits debounce so we don't spam the extension during typing.

const CLIENT_JS = `
(function () {
  // Cache the API on window so the decisionWiringScript loaded after us can
  // reuse it. acquireVsCodeApi() throws if called twice in the same page.
  const vscode = (window.__decisionVscode = window.__decisionVscode || acquireVsCodeApi());
  const payloadEl = document.getElementById('init-payload');
  const initial = JSON.parse(payloadEl.textContent);

  const state = {
    destinations: (initial.config.destinations || []).map(d => ({
      uri: d.uri || '',
      path: d.path || '',
    })),
    include: initial.config.include || [],
    exclude: initial.config.exclude || [],
    // Path aliases (M2): on-disk shape is Record<string,string>; the form
    // keeps it as an ordered list of {from,to} pairs so precedence and
    // reordering are explicit. Flushed back to a record at save time.
    pathAliases: aliasRecordToList(initial.config.pathAliases || {}),
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
  const aliasListEl = document.getElementById('alias-list');

  function aliasRecordToList(record) {
    return Object.entries(record || {}).map(([from, to]) => ({
      from: String(from || ''),
      to: String(to || ''),
    }));
  }
  function aliasListToRecord(list) {
    // Object property order is preserved — that's the precedence at runtime.
    // Skip rows that are fully empty (both sides blank) so a user adding a
    // row then changing their mind doesn't pollute the saved file.
    const out = {};
    for (const a of list) {
      const from = (a.from || '').trim();
      const to = (a.to || '').trim();
      if (from === '' && to === '') continue;
      out[from] = to;
    }
    return out;
  }

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

  function renderAliasList() {
    aliasListEl.innerHTML = '';
    state.pathAliases.forEach((alias, idx) => {
      const li = document.createElement('li');

      const fromInput = document.createElement('input');
      fromInput.type = 'text';
      fromInput.placeholder = 'From (source dir, e.g. MON/room1)';
      fromInput.spellcheck = false;
      fromInput.value = alias.from;
      fromInput.addEventListener('input', () => {
        state.pathAliases[idx].from = fromInput.value;
      });
      fromInput.addEventListener('change', flush);
      fromInput.addEventListener('blur', flush);

      const arrow = document.createElement('span');
      arrow.className = 'alias-arrow';
      arrow.textContent = '→';

      const toInput = document.createElement('input');
      toInput.type = 'text';
      toInput.placeholder = 'To (destination dir, e.g. MON)';
      toInput.spellcheck = false;
      toInput.value = alias.to;
      toInput.addEventListener('input', () => {
        state.pathAliases[idx].to = toInput.value;
      });
      toInput.addEventListener('change', flush);
      toInput.addEventListener('blur', flush);

      // Reorder controls — precedence is first-match-wins, so the user can
      // promote a narrower rule above a broader one.
      const moveGroup = document.createElement('span');
      moveGroup.className = 'alias-move-group';
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'alias-move';
      up.title = 'Move up (raise precedence)';
      up.textContent = '↑';
      up.disabled = idx === 0;
      up.addEventListener('click', () => {
        if (idx === 0) return;
        const tmp = state.pathAliases[idx - 1];
        state.pathAliases[idx - 1] = state.pathAliases[idx];
        state.pathAliases[idx] = tmp;
        renderAliasList();
        flush();
      });
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'alias-move';
      down.title = 'Move down (lower precedence)';
      down.textContent = '↓';
      down.disabled = idx === state.pathAliases.length - 1;
      down.addEventListener('click', () => {
        if (idx === state.pathAliases.length - 1) return;
        const tmp = state.pathAliases[idx + 1];
        state.pathAliases[idx + 1] = state.pathAliases[idx];
        state.pathAliases[idx] = tmp;
        renderAliasList();
        flush();
      });
      moveGroup.appendChild(up);
      moveGroup.appendChild(down);

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn-remove';
      rm.textContent = '×';
      rm.title = 'Remove alias';
      rm.addEventListener('click', () => {
        state.pathAliases.splice(idx, 1);
        renderAliasList();
        flush();
      });

      li.appendChild(fromInput);
      li.appendChild(arrow);
      li.appendChild(toInput);
      li.appendChild(moveGroup);
      li.appendChild(rm);
      aliasListEl.appendChild(li);
    });
  }

  document.getElementById('add-alias').addEventListener('click', () => {
    state.pathAliases.push({ from: '', to: '' });
    renderAliasList();
    // Don't flush yet — fully empty row is filtered out by aliasListToRecord
    // so flush would no-op. Wait for the user to type something.
  });

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
        pathAliases: aliasListToRecord(state.pathAliases),
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
  const runSyncSafeBtn = document.getElementById('run-sync-safe');
  const runSyncHintEl = document.getElementById('run-sync-hint');

  function hideOrange() {
    runSyncSafeBtn.hidden = true;
    runSyncSafeBtn.disabled = true;
    runSyncSafeBtn.textContent = 'Run Sync (safe items only)';
  }

  // M5.1: live label on the orange button — armed-count is read straight
  // off the DOM checkboxes the shared decisionWiringScript posts to the
  // extension. Hooked into window.__decisionWiring so the shared snippet
  // calls it on every toggle without us re-binding listeners.
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
        'No destinations to plan — add one above (the dropdown values come from your open workspace folders).';
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

    // Run Sync gating mirrors the admin editor's: blocking → green disabled
    // with a breakdown hint, orange shown so the user can flush the safe
    // items without resolving collisions/warnings here. Per-row decisions
    // for collisions still live in the standalone plan webview (button
    // below opens it); the orange button here is the bulk-skip path.
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
        hint += ' — open the workspace plan to decide per file.';
      }
      runSyncHintEl.textContent = hint;
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
      // External edit. Re-derive form state from the new config.
      state.destinations = (msg.config.destinations || []).map(d => ({
        uri: d.uri || '',
        path: d.path || '',
      }));
      state.include = msg.config.include || [];
      state.exclude = msg.config.exclude || [];
      state.pathAliases = aliasRecordToList(msg.config.pathAliases || {});
      includeEl.value = state.include.join('\\n');
      excludeEl.value = state.exclude.join('\\n');
      renderDestList();
      renderAliasList();
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
        runSyncSafeBtn.disabled = true;
        if (runSyncBtn.textContent !== 'Syncing…' && runSyncSafeBtn.textContent !== 'Syncing…') {
          runSyncBtn.textContent = 'Syncing…';
        }
      } else if (msg.status === 'done') {
        // The extension follows up with a fresh planStatus shortly — the
        // chip strip will reflect the post-sync world and re-gate the
        // buttons. Reset labels here.
        runSyncBtn.textContent = 'Run Sync';
        runSyncSafeBtn.textContent = 'Run Sync (safe items only)';
        refreshOrangeButton();
        hideSyncProgress();
      } else if (msg.status === 'error') {
        runSyncBtn.textContent = 'Run Sync';
        runSyncSafeBtn.textContent = 'Run Sync (safe items only)';
        runSyncBtn.disabled = false;
        if (!runSyncSafeBtn.hidden) runSyncSafeBtn.disabled = false;
        runSyncHintEl.textContent = 'Sync failed: ' + (msg.error || 'unknown error');
        refreshOrangeButton();
        hideSyncProgress();
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

  // Per-op progress bar — same wiring shape as the admin editor (which
  // shares the workspace-wide engine). Hidden until the executor fires its
  // first onProgress event; re-hidden on the syncStatus done/error follow-up.
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
  function hideSyncProgress(){
    if (!progressBox || !progressFill) return;
    progressBox.hidden = true;
    progressFill.classList.remove('sync-progress-fill-error');
  }

  renderDestList();
  renderAliasList();
})();
`;
