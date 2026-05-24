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

export interface SearchPanelInitialState {
  /** Indexed-so-far count for the footer ("N of M indexed"). 0 ≤ done ≤ total. */
  indexedDone: number;
  /** Total file count discovered during the current walk. May be 0 before the
   *  first walk completes — the script flips into "Indexing…" mode then. */
  indexedTotal: number;
  /** Number of source folders the indexer is scoped over. Drives the
   *  empty-scope message ("No source folders to search…"). */
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
        <button id="reindex" type="button" title="Re-walk source folders">Reindex</button>
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
  if (state.scopeFolderCount === 0) return 'No source folders in scope.';
  if (state.indexedTotal === 0) {
    return `Scanning ${state.scopeFolderCount} folder${plural(state.scopeFolderCount)}…`;
  }
  return `${state.indexedDone} of ${state.indexedTotal} presentation${plural(state.indexedTotal)} indexed`;
}

/**
 * Banner text shown when the user hasn't typed anything yet. Distinguishes
 * the "scope empty — add a folder" case from the "scope healthy — type to
 * search" case, both visually and for the M6 polish bullet.
 */
function renderEmptyStateMessage(state: SearchPanelInitialState): string {
  if (state.scopeFolderCount === 0) {
    return 'No source folders to search. Add a workspace folder, or check that it is not claimed as a destination by an active .sync.jsonc.';
  }
  return 'Type to search across the source-folder presentations.';
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

/**
 * CSS for the panel. Lean on VS Code's `--vscode-*` custom properties so
 * the panel matches the active theme without us redefining colours.
 *
 * CSS notes (the user is fluent in JS, less so in CSS — these comments
 * stick around so the lesson lands):
 *
 * - `box-sizing: border-box` means padding + border are *included* in the
 *   declared width/height. Without it, a `width: 100%` input box plus any
 *   padding overflows its parent. We set it once at the universal selector
 *   so every element behaves consistently.
 *
 * - `display: flex` on `.search-input-row` lays the input + button out in
 *   a row, with the input growing to fill remaining space via `flex: 1`
 *   on the input. The `gap` property adds spacing between the two children
 *   without margin hacks.
 *
 * - The `.hit` rows are styled as a list of buttons-without-the-button-look.
 *   `cursor: pointer` is the only visual cue for clickability, plus a
 *   subtle hover background change. Pointer + role="button" + tabindex=0 on
 *   the script-rendered nodes keeps them keyboard-accessible.
 *
 * - The `<mark>` element is what we wrap matched substrings in. Browsers
 *   give it a yellow highlight by default; we override to use the theme's
 *   `findMatchHighlightBackground` so it matches VS Code's own search UX.
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
  margin-bottom: 16px;
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
 * Folder groups. Each .hit-group is a section that contains a header (the
 * folder label) and a .hit-list with the rows in that folder.
 *
 * The :nth-of-type alternation gives every other group a subtle tinted
 * background so the user can see at a glance where one folder ends and
 * the next begins — same idea as zebra-striped tables but at folder
 * granularity rather than row granularity. We use VS Code's widget
 * background token because it sits a small step away from the editor bg
 * in every theme; falling back to a tiny rgba tint covers the rare case
 * where the token isn't defined.
 */
.hit-group {
  margin-bottom: 12px;
  padding: 6px 8px;
  border-radius: 4px;
}

.hit-group:nth-of-type(even) {
  background: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.07));
}

.hit-group-header {
  font-size: 0.85em;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 2px 6px;
  margin: 0;
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
  margin-bottom: 6px;
}

.hit-group-count {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  opacity: 0.75;
  margin-left: 6px;
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
}

.hit:hover,
.hit:focus {
  background: var(--vscode-list-hoverBackground);
  outline: none;
}

.hit-filename {
  font-weight: 600;
  margin-bottom: 2px;
}

.hit-meta {
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
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
  // Notes on style:
  // - `acquireVsCodeApi` is available in webviews; calling it twice throws,
  //   so we cache the handle in a single const.
  // - The debounce delay lives in the script as a literal — easy to tune.
  // - We track the latest query so out-of-order results (slow renders +
  //   fast typists) can be dropped on arrival without flicker.
  return `
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const DEBOUNCE_MS = 150;

  const qInput = document.getElementById('q');
  const reindex = document.getElementById('reindex');
  const results = document.getElementById('results');
  const footerText = document.getElementById('footer-text');

  let latestQuery = '';
  let debounceHandle = null;

  function postSearch(q) {
    latestQuery = q;
    vscode.postMessage({ type: 'search', query: q });
  }

  qInput.addEventListener('input', function () {
    const q = qInput.value;
    if (debounceHandle) clearTimeout(debounceHandle);
    if (q.trim() === '') {
      // Clear results immediately — no debounce — so backspacing to empty
      // gives instant feedback.
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
    vscode.postMessage({ type: 'reindex' });
  });

  // Keyboard: Enter on input triggers immediate search (skip debounce);
  // Escape clears the box.
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
      // Drop stale results — only render if this batch matches what's
      // currently in the input box (post-debounce). Compare against
      // latestQuery rather than qInput.value so an in-flight backspace
      // doesn't blank legitimate matches mid-render.
      if (typeof msg.query === 'string' && msg.query !== latestQuery) return;
      renderResults(msg.groups || [], latestQuery);
    } else if (msg.type === 'indexProgress') {
      updateFooter(msg);
    } else if (msg.type === 'indexComplete') {
      updateFooter(msg);
      // If user has typed something already, re-run the search now that
      // more files might be in the index.
      if (latestQuery && latestQuery.trim() !== '') {
        vscode.postMessage({ type: 'search', query: latestQuery });
      }
    } else if (msg.type === 'emptyState') {
      // Used by the extension to push a custom empty-state message after a
      // topology change (scope dropped to zero, etc.).
      renderEmpty(msg.message);
    }
  });

  function renderEmpty(customMessage) {
    const message = typeof customMessage === 'string' && customMessage
      ? customMessage
      : 'Type to search across the source-folder presentations.';
    const wrap = document.createElement('div');
    wrap.className = 'empty-state';
    wrap.textContent = message;
    results.replaceChildren(wrap);
    results.setAttribute('aria-busy', 'false');
  }

  function renderResults(groups, query) {
    // Total hit count across every group — drives the "No matches" empty
    // state when nothing came back at all.
    let totalHits = 0;
    for (const g of groups) totalHits += (g.hits || []).length;
    if (!totalHits) {
      const wrap = document.createElement('div');
      wrap.className = 'empty-state';
      wrap.textContent = 'No matches.';
      results.replaceChildren(wrap);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const group of groups) {
      if (!group || !group.hits || !group.hits.length) continue;
      frag.appendChild(renderGroup(group, query));
    }
    results.replaceChildren(frag);
  }

  function renderGroup(group, query) {
    const section = document.createElement('section');
    section.className = 'hit-group';
    const header = document.createElement('h2');
    header.className = 'hit-group-header';
    header.textContent = group.folderLabel || group.folderUri || '(unknown)';
    const count = document.createElement('span');
    count.className = 'hit-group-count';
    count.textContent = group.hits.length + ' match' + (group.hits.length === 1 ? '' : 'es');
    header.appendChild(count);
    section.appendChild(header);
    const list = document.createElement('div');
    list.className = 'hit-list';
    for (const hit of group.hits) {
      list.appendChild(renderHit(hit, query));
    }
    section.appendChild(list);
    return section;
  }

  function renderHit(hit, query) {
    const row = document.createElement('div');
    row.className = 'hit';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.dataset.sha = hit.sha256 || '';

    const filename = document.createElement('div');
    filename.className = 'hit-filename';
    // Prefer the display-form field (URI-decoded, case preserved); fall
    // back to the folded match form if an older indexer record doesn't
    // carry one — schema-mismatch eviction should make that transient.
    const displayName = hit.displayFilename || hit.filename || '(unknown)';
    filename.appendChild(highlight(displayName, query));
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
        // Decode percent-escapes for display so paths read naturally.
        // decodeURIComponent throws on malformed sequences — fall back to
        // the raw URI rather than break the row.
        let display = uri;
        try { display = decodeURIComponent(uri); } catch (_) { /* keep raw */ }
        u.textContent = display;
        uris.appendChild(u);
      }
      row.appendChild(uris);
    }

    function fire() {
      // Multiple URIs: open the first. The user can right-click in the
      // explorer to open siblings; v1 keeps the click-target simple.
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

  /**
   * Wrap query-token substrings with <mark>. Splits the query by the same
   * boundaries the extension's tokeniser uses (whitespace + punctuation) and
   * highlights each non-empty token, longest-first so substring overlap
   * doesn't double-wrap. Comparison is case-insensitive.
   */
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
    // Merge overlaps.
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
    if (msg.type === 'indexComplete' || msg.phase === 'idle') {
      footerText.textContent = total === 0
        ? 'No presentations indexed.'
        : (total + ' presentation' + (total === 1 ? '' : 's') + ' indexed');
      results.setAttribute('aria-busy', 'false');
      return;
    }
    results.setAttribute('aria-busy', 'true');
    if (msg.phase === 'walking') {
      footerText.textContent = 'Walking source folders…';
    } else {
      footerText.textContent = 'Indexing ' + done + ' of ' + total + '…';
    }
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
