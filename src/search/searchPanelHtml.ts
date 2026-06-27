// Pure HTML renderer for the search panel.
//
// The wired layer (`searchPanel.ts`) builds the state, generates a nonce,
// and feeds them in. This file emits a single HTML document with:
//   - A `<meta http-equiv="Content-Security-Policy">` header matching the
//     project convention (default-src 'none'; style + img tightened; inline
//     scripts gated by `nonce-<random>`).
//   - The static input/results/footer chrome.
//   - One nonce-tagged inline script that drives the panel: it listens for
//     `results` / `indexProgress` / `indexComplete` messages from the
//     extension, debounces the input box, and posts `search` / `open` /
//     `reindex` messages back.
//
// Result rendering happens *inside the webview script* — the pure module
// emits the script as a string. Two reasons:
//   1. Initial state has no hits (the user hasn't typed anything yet), so
//      there's nothing for a server-side renderer to produce.
//   2. Every subsequent results delivery comes over postMessage, so the
//      script needs its own renderer anyway. Duplicating the logic in a
//      pure TS function would just drift.
//
// Tests focus on what *is* testable here: shell shape, CSP correctness,
// escape-safety on user-controlled fragments, and presence of the script.
//
// SLIM build: this is a basic find-and-open surface over the single workspace
// folder. The multi-select + result-Update flow (compare modal, "Update file",
// archive/sync) moved to the PWA; it is intentionally absent here.

export interface SearchPanelInitialState {
  /** Indexed-so-far count for the footer ("N of M indexed"). 0 ≤ done ≤ total. */
  indexedDone: number;
  /** Total file count discovered during the current walk. May be 0 before the
   *  first walk completes — the script flips into "Indexing…" mode then. */
  indexedTotal: number;
  /** Number of folders the indexer is scoped over (0 or 1 in the slim build).
   *  Drives the empty-scope message ("No folder to search…"). */
  scopeFolderCount: number;
}

/**
 * Render the full panel HTML. Pure: callers supply the nonce.
 */
export function renderSearchPanelHtml(
  state: SearchPanelInitialState,
  nonce: string,
): string {
  const safeFooter = renderFooterText(state);
  const emptyState = renderEmptyStateMessage(state);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<title>Presentation Search</title>
<style>${css()}</style>
</head>
<body>
  <main>
    <header class="search-head">
      <h1>Presentation Search</h1>
      <div class="search-input-row">
        <input
          id="q"
          type="search"
          autocomplete="off"
          spellcheck="false"
          placeholder="Search filename, author, or first-slide text…"
          aria-label="Search query"
        >
        <button id="reindex" type="button" title="Re-walk the workspace folder">Reindex</button>
      </div>
      <div class="search-options-row">
        <label class="search-option" title="When off (default), every word you type must match somewhere on the file. When on, files matching any one of your words appear — useful for fishing out a known filename fragment when the metadata isn't helping.">
          <input id="or-mode" type="checkbox">
          <span>Any term (OR)</span>
        </label>
      </div>
    </header>

    <section id="results" class="results" aria-live="polite" aria-busy="false">
      <div class="empty-state">${escapeHtml(emptyState)}</div>
    </section>

    <footer class="search-foot">
      <span id="footer-text">${escapeHtml(safeFooter)}</span>
    </footer>
  </main>
  <script nonce="${nonce}">${panelScript()}</script>
</body>
</html>`;
}

/**
 * Footer text for the initial render. The script updates this on every
 * progress / complete message so it stays live as the indexer walks.
 */
function renderFooterText(state: SearchPanelInitialState): string {
  if (state.scopeFolderCount === 0) return 'No workspace folder in scope.';
  if (state.indexedTotal === 0) {
    return `Scanning ${state.scopeFolderCount} folder${plural(state.scopeFolderCount)}…`;
  }
  return `${state.indexedDone} of ${state.indexedTotal} presentation${plural(state.indexedTotal)} indexed`;
}

/**
 * Banner text shown when the user hasn't typed anything yet. Distinguishes
 * the "no folder open" case from the "ready — type to search" case.
 */
function renderEmptyStateMessage(state: SearchPanelInitialState): string {
  if (state.scopeFolderCount === 0) {
    return 'No folder to search. Open a workspace folder to index its presentations.';
  }
  return 'Type to search across the workspace presentations.';
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

/**
 * CSS for the panel. Lean on VS Code's `--vscode-*` custom properties so
 * the panel matches the active theme without us redefining colours.
 */
function css(): string {
  return `
* { box-sizing: border-box; }

body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  margin: 0;
  padding: 0;
}

main {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  padding: 16px 20px 0;
}

h1 {
  font-size: 1.2em;
  margin: 0 0 12px;
  font-weight: 600;
}

.search-input-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.search-options-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}
.search-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}
.search-option input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
}

#q {
  flex: 1;
  padding: 6px 10px;
  font-size: 1em;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  outline: none;
}

#q:focus {
  border-color: var(--vscode-focusBorder);
}

#reindex {
  padding: 6px 12px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 3px;
  cursor: pointer;
}

#reindex:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.results {
  flex: 1;
  margin-bottom: 16px;
}

.empty-state {
  padding: 24px 8px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}

/*
 * Folder groups. In the slim build there is normally a single group (the
 * workspace folder), but the grouped rendering + collapse toggle are kept so
 * the panel reads the same and an orphan bucket still renders cleanly.
 */
.hit-group {
  margin-bottom: 12px;
  padding: 6px 8px;
  border-radius: 4px;
  border-left: 3px solid transparent;
}
.hit-group.is-secondary:nth-of-type(even) {
  background: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.07));
}
.hit-group.is-primary {
  border-left-color: var(--vscode-textLink-foreground, #3794ff);
  background: var(--vscode-editor-selectionHighlightBackground, rgba(55, 148, 255, 0.10));
}
.hit-group.is-primary .hit-group-header {
  color: var(--vscode-textLink-foreground, #3794ff);
  border-bottom-color: var(--vscode-textLink-foreground, #3794ff);
}
.hit-group.is-primary .hit-group-tag {
  background: var(--vscode-textLink-foreground, #3794ff);
  color: var(--vscode-editor-background, #1e1e1e);
  border-color: transparent;
}
.hit-group.is-secondary {
  border-left-color: var(--vscode-panel-border, rgba(127, 127, 127, 0.35));
}

.hit-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85em;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 2px 6px;
  margin: 0 0 6px;
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
  cursor: pointer;
  user-select: none;
}
.hit-group-header:hover {
  color: var(--vscode-foreground);
}
.hit-group-header:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: 2px;
}

.hit-group-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hit-group-path {
  font-family: var(--vscode-editor-font-family);
  font-size: 0.8em;
  font-weight: 400;
  color: var(--vscode-descriptionForeground);
  opacity: 0.85;
  white-space: nowrap;
}
.hit-group-tag {
  flex: 0 0 auto;
  font-size: 0.82em;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 8px;
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.45));
  color: var(--vscode-descriptionForeground);
  opacity: 0.9;
}
.hit-group-count {
  flex: 0 0 auto;
  margin-left: auto;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  opacity: 0.75;
}
.hit-group-chevron {
  flex: 0 0 auto;
  width: 0.9em;
  text-align: center;
  opacity: 0.7;
  transition: transform 120ms ease;
}
.hit-group.collapsed .hit-group-chevron {
  transform: rotate(-90deg);
}
.hit-group.collapsed .hit-list {
  display: none;
}
.hit-group-hidden {
  flex: 0 0 auto;
  margin-left: auto;
  display: none;
  font-weight: 600;
  text-transform: none;
  letter-spacing: 0;
  font-size: 0.9em;
  padding: 1px 8px;
  border-radius: 8px;
  background: var(--vscode-badge-background, rgba(127, 127, 127, 0.3));
  color: var(--vscode-badge-foreground, inherit);
}
.hit-group.collapsed .hit-group-hidden {
  display: inline-block;
}
.hit-group.collapsed .hit-group-count {
  display: none;
}

.hit-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hit {
  display: block;
  padding: 8px 10px;
  border-radius: 3px;
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  transition: background-color 120ms ease;
}

.hit:hover,
.hit:focus {
  background: var(--vscode-list-hoverBackground);
  outline: none;
}

.hit-filename {
  font-weight: 600;
  margin-bottom: 2px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
}

.hash-badge {
  font-family: var(--vscode-editor-font-family);
  font-size: 0.75em;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;
  color: #1a1a1a;
  letter-spacing: 0.03em;
  white-space: nowrap;
  position: relative;
  top: -1px;
}

.placeholder-badge {
  font-size: 0.72em;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  opacity: 0.85;
  position: relative;
  top: -1px;
}
.hit.placeholder .hit-filename-text {
  opacity: 0.7;
}

.hit-meta {
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.hit-author {
  font-weight: 700;
  color: var(--vscode-foreground);
}

.hit-badges {
  display: inline-flex;
  gap: 4px;
}

.hit-badge {
  font-size: 0.8em;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.hit-uris {
  font-family: var(--vscode-editor-font-family);
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  margin-top: 4px;
  word-break: break-all;
}

.hit-uri {
  display: block;
  padding: 2px 0;
}

mark {
  background: var(--vscode-editor-findMatchHighlightBackground);
  color: inherit;
  padding: 0;
}

.search-foot {
  border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
  padding: 8px 0;
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
}
`.trim();
}

/**
 * The inline script that drives the panel. Returned as a string so the
 * pure renderer can splice it into the document with a nonce. The script
 * itself uses only browser primitives — no module imports, no eval.
 */
function panelScript(): string {
  return `
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const DEBOUNCE_MS = 150;

  const qInput = document.getElementById('q');
  const reindex = document.getElementById('reindex');
  const orToggle = document.getElementById('or-mode');
  const results = document.getElementById('results');
  const footerText = document.getElementById('footer-text');

  let latestQuery = '';
  let debounceHandle = null;
  // Set when the user clicks Reindex; consumed by the next indexComplete so
  // we re-run the term currently in the box once the freshly-walked index is
  // ready.
  let reindexRequested = false;
  let currentGroups = [];
  let lastRenderedQuery = '';

  // ── Per-folder collapse state ─────────────────────────────────────────
  function loadCollapsed() {
    try {
      const st = vscode.getState();
      if (st && Array.isArray(st.collapsedFolders)) return new Set(st.collapsedFolders);
    } catch (_e) { /* no persisted state yet */ }
    return new Set();
  }
  const collapsedFolders = loadCollapsed();
  function persistCollapsed() {
    try {
      const st = vscode.getState() || {};
      st.collapsedFolders = Array.from(collapsedFolders);
      vscode.setState(st);
    } catch (_e) { /* setState unavailable — in-memory state still works */ }
  }

  // Palette for the hash-pairing badge.
  const HASH_PALETTE = [
    '#ef9a9a', '#f48fb1', '#ce93d8', '#9fa8da', '#90caf9',
    '#80deea', '#80cbc4', '#ffcc80', '#bcaaa4',
  ];

  function basenameOf(uri) {
    if (!uri) return '';
    var s = String(uri);
    var cut = s.search(/[?#]/);
    if (cut >= 0) s = s.slice(0, cut);
    if (s.endsWith('/')) s = s.slice(0, -1);
    var seg = s.slice(s.lastIndexOf('/') + 1);
    try { return decodeURIComponent(seg); } catch (_) { return seg; }
  }

  function currentOp() {
    return orToggle && orToggle.checked ? 'or' : 'and';
  }

  function postSearch(q) {
    latestQuery = q;
    vscode.postMessage({ type: 'search', query: q, op: currentOp() });
  }

  qInput.addEventListener('input', function () {
    const q = qInput.value;
    if (debounceHandle) clearTimeout(debounceHandle);
    if (q.trim() === '') {
      latestQuery = '';
      renderEmpty();
      return;
    }
    debounceHandle = setTimeout(function () {
      debounceHandle = null;
      postSearch(q);
    }, DEBOUNCE_MS);
  });

  reindex.addEventListener('click', function () {
    reindexRequested = true;
    vscode.postMessage({ type: 'reindex' });
  });

  if (orToggle) {
    orToggle.addEventListener('change', function () {
      const q = qInput.value;
      if (q.trim() === '') return;
      postSearch(q);
    });
  }

  qInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      if (debounceHandle) { clearTimeout(debounceHandle); debounceHandle = null; }
      postSearch(qInput.value);
    } else if (e.key === 'Escape') {
      qInput.value = '';
      latestQuery = '';
      renderEmpty();
    }
  });

  window.addEventListener('message', function (e) {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'results') {
      if (typeof msg.query === 'string' && msg.query !== latestQuery) return;
      renderResults(msg.groups || [], latestQuery);
    } else if (msg.type === 'indexProgress') {
      updateFooter(msg);
    } else if (msg.type === 'indexComplete') {
      updateFooter(msg);
      const requested = reindexRequested;
      reindexRequested = false;
      const q = requested ? qInput.value : latestQuery;
      if (q && q.trim() !== '') {
        postSearch(q);
      }
    } else if (msg.type === 'emptyState') {
      renderEmpty(msg.message);
    }
  });

  function renderEmpty(customMessage) {
    const message = typeof customMessage === 'string' && customMessage
      ? customMessage
      : 'Type to search across the workspace presentations.';
    const wrap = document.createElement('div');
    wrap.className = 'empty-state';
    wrap.textContent = message;
    results.replaceChildren(wrap);
    results.setAttribute('aria-busy', 'false');
  }

  function renderResults(groups, query) {
    lastRenderedQuery = query;
    currentGroups = groups || [];

    let totalHits = 0;
    for (const g of currentGroups) totalHits += (g.hits || []).length;
    if (!totalHits) {
      const wrap = document.createElement('div');
      wrap.className = 'empty-state';
      wrap.textContent = 'No matches.';
      results.replaceChildren(wrap);
      return;
    }

    const shaCounts = new Map();
    for (const g of currentGroups) {
      for (const h of (g.hits || [])) {
        const s = (h && h.sha256) || '';
        if (!s) continue;
        shaCounts.set(s, (shaCounts.get(s) || 0) + 1);
      }
    }
    const shaColors = new Map();
    let paletteIdx = 0;
    for (const g of currentGroups) {
      for (const h of (g.hits || [])) {
        const s = (h && h.sha256) || '';
        if (!s) continue;
        if ((shaCounts.get(s) || 0) < 2) continue;
        if (shaColors.has(s)) continue;
        shaColors.set(s, HASH_PALETTE[paletteIdx % HASH_PALETTE.length]);
        paletteIdx++;
      }
    }

    const frag = document.createDocumentFragment();
    let groupIndex = 0;
    for (const group of currentGroups) {
      if (!group) {
        groupIndex++;
        continue;
      }
      frag.appendChild(renderGroup(group, query, groupIndex, shaColors, shaCounts));
      groupIndex++;
    }
    results.replaceChildren(frag);
  }

  function renderGroup(group, query, groupIndex, shaColors, shaCounts) {
    const isPrimary = groupIndex === 0;
    const hitCount = (group.hits || []).length;
    const folderKey = group.folderUri || '(other)';
    const collapsed = collapsedFolders.has(folderKey);

    const section = document.createElement('section');
    section.className =
      'hit-group' + (isPrimary ? ' is-primary' : ' is-secondary') + (collapsed ? ' collapsed' : '');
    section.dataset.folderKey = folderKey;

    const header = document.createElement('h2');
    header.className = 'hit-group-header';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', String(!collapsed));
    header.title = (collapsed ? 'Expand' : 'Collapse') + ' this folder';

    const chevron = document.createElement('span');
    chevron.className = 'hit-group-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '▾';
    header.appendChild(chevron);

    const label = document.createElement('span');
    label.className = 'hit-group-label';
    label.textContent = group.folderName || group.folderLabel || group.folderUri || '(unknown)';
    header.appendChild(label);
    if (group.folderLabel && group.folderLabel !== (group.folderName || group.folderLabel)) {
      const path = document.createElement('span');
      path.className = 'hit-group-path';
      path.textContent = group.folderLabel;
      header.appendChild(path);
    }
    const tag = document.createElement('span');
    tag.className = 'hit-group-tag';
    tag.textContent = isPrimary ? 'workspace folder' : 'other folder';
    header.appendChild(tag);

    if (hitCount > 0) {
      const hidden = document.createElement('span');
      hidden.className = 'hit-group-hidden';
      hidden.textContent = hitCount + ' result' + (hitCount === 1 ? '' : 's') + ' hidden';
      header.appendChild(hidden);
    }

    const count = document.createElement('span');
    count.className = 'hit-group-count';
    count.textContent =
      hitCount === 0 ? 'no matches' : hitCount + ' match' + (hitCount === 1 ? '' : 'es');
    header.appendChild(count);

    function toggleCollapse() {
      const nowCollapsed = section.classList.toggle('collapsed');
      if (nowCollapsed) collapsedFolders.add(folderKey);
      else collapsedFolders.delete(folderKey);
      header.setAttribute('aria-expanded', String(!nowCollapsed));
      header.title = (nowCollapsed ? 'Expand' : 'Collapse') + ' this folder';
      persistCollapsed();
    }
    header.addEventListener('click', toggleCollapse);
    header.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleCollapse();
      }
    });

    section.appendChild(header);

    if (hitCount > 0) {
      const list = document.createElement('div');
      list.className = 'hit-list';
      for (const hit of group.hits) {
        list.appendChild(renderHit(hit, query, shaColors, shaCounts));
      }
      section.appendChild(list);
    }
    return section;
  }

  function renderHit(hit, query, shaColors, shaCounts) {
    const row = document.createElement('div');
    row.className = 'hit';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.dataset.sha = hit.sha256 || '';

    const filename = document.createElement('div');
    filename.className = 'hit-filename';
    const displayName = basenameOf((hit.uris && hit.uris[0]) || '') || hit.displayFilename || hit.filename || '(unknown)';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'hit-filename-text';
    nameSpan.appendChild(highlight(displayName, query));
    filename.appendChild(nameSpan);
    const sha = (hit && hit.sha256) || '';
    if (sha && shaColors && shaColors.has(sha)) {
      const badge = document.createElement('span');
      badge.className = 'hash-badge';
      badge.style.background = shaColors.get(sha);
      badge.textContent = sha.slice(0, 8);
      const n = (shaCounts && shaCounts.get(sha)) || 0;
      badge.title =
        'sha256 ' + sha + ' — appears in ' + n + ' result' + (n === 1 ? '' : 's');
      filename.appendChild(badge);
    }
    if (hit.isPlaceholder) {
      row.classList.add('placeholder');
      const ph = document.createElement('span');
      ph.className = 'placeholder-badge';
      ph.textContent = 'placeholder';
      ph.title = 'Placeholder stub — no deck content yet; matched on filename';
      filename.appendChild(ph);
    }
    row.appendChild(filename);

    const meta = document.createElement('div');
    meta.className = 'hit-meta';
    const authorText = hit.displayAuthor || hit.author || '';
    if (authorText) {
      const author = document.createElement('span');
      author.className = 'hit-author';
      author.appendChild(document.createTextNode('by '));
      author.appendChild(highlight(authorText, query));
      meta.appendChild(author);
    }
    if (Array.isArray(hit.matchedFields) && hit.matchedFields.length) {
      const badges = document.createElement('span');
      badges.className = 'hit-badges';
      for (const f of hit.matchedFields) {
        const badge = document.createElement('span');
        badge.className = 'hit-badge';
        badge.textContent = badgeLabel(f);
        badges.appendChild(badge);
      }
      meta.appendChild(badges);
    }
    row.appendChild(meta);

    if (Array.isArray(hit.uris) && hit.uris.length) {
      const uris = document.createElement('div');
      uris.className = 'hit-uris';
      for (const uri of hit.uris) {
        const u = document.createElement('span');
        u.className = 'hit-uri';
        let display = uri;
        try { display = decodeURIComponent(uri); } catch (_) { /* keep raw */ }
        u.textContent = display;
        uris.appendChild(u);
      }
      row.appendChild(uris);
    }

    function fire() {
      const uri = (hit.uris && hit.uris[0]) || '';
      if (!uri) return;
      vscode.postMessage({ type: 'open', uri: uri });
    }

    row.addEventListener('click', fire);
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fire();
      }
    });

    return row;
  }

  function badgeLabel(field) {
    if (field === 'filename') return 'filename';
    if (field === 'author') return 'author';
    if (field === 'slideText') return 'slide';
    return field;
  }

  function highlight(text, query) {
    const frag = document.createDocumentFragment();
    if (!query) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    const tokens = query
      .split(/[^\\p{L}\\p{N}]+/u)
      .filter(Boolean)
      .sort(function (a, b) { return b.length - a.length; });
    if (!tokens.length) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    const lower = text.toLowerCase();
    const ranges = [];
    for (const t of tokens) {
      const tt = t.toLowerCase();
      let from = 0;
      while (true) {
        const idx = lower.indexOf(tt, from);
        if (idx === -1) break;
        ranges.push({ start: idx, end: idx + tt.length });
        from = idx + tt.length;
      }
    }
    if (!ranges.length) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }
    ranges.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    const merged = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
      const last = merged[merged.length - 1];
      const r = ranges[i];
      if (r.start <= last.end) {
        if (r.end > last.end) last.end = r.end;
      } else {
        merged.push(r);
      }
    }
    let cursor = 0;
    for (const r of merged) {
      if (r.start > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, r.start)));
      }
      const m = document.createElement('mark');
      m.textContent = text.slice(r.start, r.end);
      frag.appendChild(m);
      cursor = r.end;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    return frag;
  }

  function updateFooter(msg) {
    const total = typeof msg.total === 'number' ? msg.total : 0;
    const done = typeof msg.done === 'number' ? msg.done : 0;
    const errors = typeof msg.errors === 'number' ? msg.errors : 0;
    const scopeFolderCount = typeof msg.scopeFolderCount === 'number'
      ? msg.scopeFolderCount
      : -1;

    if (scopeFolderCount === 0) {
      footerText.textContent = 'No workspace folder in scope.';
      results.setAttribute('aria-busy', 'false');
      if (!latestQuery || latestQuery.trim() === '') {
        renderEmpty('No folder to search. Open a workspace folder to index its presentations.');
      }
      return;
    }

    if (msg.type === 'indexComplete' || msg.phase === 'idle') {
      let text = total === 0
        ? 'No presentations indexed.'
        : (total + ' presentation' + (total === 1 ? '' : 's') + ' indexed');
      if (errors > 0) {
        text += ' · ' + errors + ' error' + (errors === 1 ? '' : 's') +
          ' (see Output → Pptx Info)';
      }
      footerText.textContent = text;
      footerText.title = errors > 0
        ? 'Some files could not be read or parsed during indexing. See the Output Channel "Pptx Info" for details.'
        : '';
      results.setAttribute('aria-busy', 'false');
      return;
    }
    results.setAttribute('aria-busy', 'true');
    let progressText;
    if (msg.phase === 'walking') {
      progressText = 'Walking the workspace folder…';
    } else {
      progressText = 'Indexing ' + done + ' of ' + total + '…';
    }
    if (errors > 0) {
      progressText += ' · ' + errors + ' error' + (errors === 1 ? '' : 's');
    }
    footerText.textContent = progressText;
    footerText.title = errors > 0
      ? 'Some files could not be read or parsed during indexing. See the Output Channel "Pptx Info" for details.'
      : '';
  }
})();
`.trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
