// Pure HTML renderer for the search panel.
//
// The wired layer (`searchPanel.ts`) builds the state, generates a nonce,
// and feeds them in. This file emits a single HTML document with:
//   - A `<meta http-equiv="Content-Security-Policy">` header matching the
//     project convention (default-src 'none'; style + img tightened; inline
//     scripts gated by `nonce-<random>`).
//   - The static input/results/footer chrome.
//   - A multi-select toolbar (hidden by default, shown after the first
//     shift-click) with a Clear button and the Update-file button that lights
//     up when the selection is "primed" — exactly one hit from the first
//     group and one from another group, see panelScript() below.
//   - A modal-host overlay for the side-by-side update-confirmation modal,
//     populated by `updateModal` messages from the extension.
//   - One nonce-tagged inline script that drives the panel: it listens for
//     `results` / `indexProgress` / `indexComplete` / `updateModal` /
//     `updateResult` messages from the extension, debounces the input box,
//     and posts `search` / `open` / `reindex` / `updateFile` /
//     `updateConfirm` / `updateCancel` messages back.
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

import { compareModalCss } from '../sync/compareModalHtml';

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

/** Render options. `host:'dom'` returns a script-free, CSP-free fragment for a
 *  single-document host (the PWA) to splice into a shadow root — mirroring the
 *  `RenderOptions.host:'dom'` mode `webview.ts` grew for the standalone PWA.
 *  The default `'webview'` mode is unchanged (full document + nonce'd script). */
export interface SearchPanelRenderOptions {
  host?: 'webview' | 'dom';
}

/**
 * Render the full panel HTML. Pure: callers supply the nonce.
 *
 * In the default `'webview'` mode this returns a complete document with the
 * project CSP and the nonce-gated inline `panelScript()` that drives the panel.
 * In `'dom'` mode it returns just `<style>` + the static `<main>`/modal-host
 * chrome (no doctype, no CSP, no script): the PWA mounts that fragment in a
 * shadow root and re-implements the interaction as direct DOM (the inline
 * script's webview-only `acquireVsCodeApi` bridge has no analogue there).
 */
export function renderSearchPanelHtml(
  state: SearchPanelInitialState,
  nonce: string,
  opts?: SearchPanelRenderOptions,
): string {
  const safeFooter = renderFooterText(state);
  const emptyState = renderEmptyStateMessage(state);
  if (opts?.host === 'dom') {
    // Script-free fragment. Same element ids/classes as the webview body so
    // css() styles it identically and the PWA twin can wire #q, #reindex,
    // #or-mode, #results, #footer-text and #modal-host by id.
    return `<style>${css()}</style>
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
      <div class="search-options-row">
        <label class="search-option" title="When off (default), every word you type must match somewhere on the file. When on, files matching any one of your words appear — useful for fishing out a known filename fragment when the metadata isn't helping.">
          <input id="or-mode" type="checkbox">
          <span>Any term (OR)</span>
        </label>
      </div>
      <div id="multi-toolbar" class="multi-toolbar" hidden>
        <span id="multi-status" class="multi-status" aria-live="polite">Multi-select: 0 selected</span>
        <span class="multi-toolbar-spacer"></span>
        <button id="multi-clear-btn" type="button" class="multi-btn multi-btn-secondary">Clear selection</button>
        <button id="multi-update-btn" type="button" class="multi-btn" disabled
          title="Select one file in the first group and one in another group to enable Update.">
          Update file…
        </button>
      </div>
    </header>

    <section id="results" class="results" aria-live="polite" aria-busy="false">
      <div class="empty-state">${escapeHtml(emptyState)}</div>
    </section>

    <footer class="search-foot">
      <span id="footer-text">${escapeHtml(safeFooter)}</span>
    </footer>
  </main>
  <div id="modal-host" class="modal-host" aria-hidden="true"></div>`;
  }
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
      <div class="search-options-row">
        <label class="search-option" title="When off (default), every word you type must match somewhere on the file. When on, files matching any one of your words appear — useful for fishing out a known filename fragment when the metadata isn't helping.">
          <input id="or-mode" type="checkbox">
          <span>Any term (OR)</span>
        </label>
      </div>
      <div id="multi-toolbar" class="multi-toolbar" hidden>
        <span id="multi-status" class="multi-status" aria-live="polite">Multi-select: 0 selected</span>
        <span class="multi-toolbar-spacer"></span>
        <button id="multi-clear-btn" type="button" class="multi-btn multi-btn-secondary">Clear selection</button>
        <button id="multi-update-btn" type="button" class="multi-btn" disabled
          title="Select one file in the first group and one in another group to enable Update.">
          Update file…
        </button>
      </div>
    </header>

    <section id="results" class="results" aria-live="polite" aria-busy="false">
      <div class="empty-state">${escapeHtml(emptyState)}</div>
    </section>

    <footer class="search-foot">
      <span id="footer-text">${escapeHtml(safeFooter)}</span>
    </footer>
  </main>
  <div id="modal-host" class="modal-host" aria-hidden="true"></div>
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
${compareModalCss()}

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

/*
 * Options row beneath the input — currently just the OR-mode checkbox, but
 * the row is its own block so future toggles (file-type filter, etc.) can
 * land here without re-flowing the input + Reindex layout above. Smaller
 * font, descriptionForeground colour because these are secondary affordances
 * rather than primary actions.
 */
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
  /* Coloured left rail keys the group to its kind: accent for the top
     workspace folder, muted for additional folders. Overridden per kind
     below. */
  border-left: 3px solid transparent;
}

/* Zebra only among the secondary folders, so it never competes with the
   primary folder's accent treatment. */
.hit-group.is-secondary:nth-of-type(even) {
  background: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.07));
}

/* ── Top / workspace folder: accent-coded, prominent ───────────────────── */
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

/* ── Additional folders: muted rail ────────────────────────────────────── */
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
  margin: 0;
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
  margin-bottom: 6px;
}

.hit-group-label {
  /* The folder name itself — don't let a long path crowd the tag/count. */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The definite kind tag ("workspace folder" / "other folder"). */
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
  /* Transition the selection colour so toggling feels responsive but not
     jarring. ~120ms matches VS Code's own list interactions. */
  transition: background-color 120ms ease;
}

.hit:hover,
.hit:focus {
  background: var(--vscode-list-hoverBackground);
  outline: none;
}

/*
 * Selection state — sticky yellow once a row is selected (shift-click enters
 * the mode; further clicks toggle). Lime green when the selection is "primed"
 * for the Update action: exactly 2 rows, one in the first group, one in
 * another. We use bold inline colours rather than theme tokens because the
 * semantics are intentional (yellow = staged, green = ready) and shouldn't
 * blend into the chrome.
 *
 * Black text on both colours is deliberate — both backgrounds are bright
 * enough that the theme's foreground (often near-white in dark themes) would
 * disappear into them.
 */
.hit.selected {
  background: #fff59d; /* material yellow 200 — high contrast on both light and dark themes */
  color: #1a1a1a;
}
.hit.selected:hover,
.hit.selected:focus {
  background: #ffeb3b; /* yellow 500 — small pop on hover so the row still answers to the cursor */
}

.hit.selected.primed {
  background: #b9f6ca; /* green A100 — clearly different hue from the yellow */
  color: #0d2818;
}
.hit.selected.primed:hover,
.hit.selected.primed:focus {
  background: #69f0ae; /* green A200 */
}

/*
 * Disabled state — applied after an Update or Update & remove completes. The
 * row stops responding to clicks (pointer-events: none) and the selection
 * affordance is dropped (cursor + hover go away). We keep two distinct
 * variants:
 *   .updated  — dimmed neutral, indicating "this file has already been
 *               processed in this batch"
 *   .removed  — dark gray with a red wash, indicating "this file no longer
 *               exists on disk; it was deleted as part of the update".
 *
 * Both variants need !important on the background because they have to win
 * over .selected / .selected.primed (the inline-script keeps disabled rows
 * out of the selected set, so this is belt-and-braces).
 */
.hit.disabled {
  cursor: default;
  pointer-events: none;
  opacity: 0.55;
}
.hit.disabled.updated {
  background: var(--vscode-list-inactiveSelectionBackground, rgba(127, 127, 127, 0.12)) !important;
  color: var(--vscode-descriptionForeground) !important;
}
.hit.disabled.removed {
  background: #3a1a1a !important; /* dark gray with red tinge */
  color: #c89292 !important;
  text-decoration: line-through;
  text-decoration-color: rgba(255, 100, 100, 0.5);
}
.hit.disabled mark {
  /* match the dimmed foreground so highlights don't pop on disabled rows */
  background: transparent;
  color: inherit;
  font-weight: inherit;
}

/*
 * Multi-select toolbar. Sits in the header next to the search input, hidden
 * by default and surfaced only when selectionMode is on. Flex layout mirrors
 * the search-input-row immediately above it so the affordance reads as a
 * sibling control strip.
 */
.multi-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 6px 10px;
  border-radius: 3px;
  background: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.07));
  border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.25)));
}
.multi-toolbar[hidden] { display: none; }

.multi-status {
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
}

.multi-toolbar-spacer { flex: 1 1 auto; }

.multi-btn {
  padding: 4px 12px;
  font-family: inherit;
  font-size: 0.9em;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: 1px solid transparent;
  border-radius: 2px;
  cursor: pointer;
}
.multi-btn:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}
.multi-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.multi-btn-secondary {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border-color: var(--vscode-panel-border, rgba(128, 128, 128, 0.4));
}
.multi-btn-secondary:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground, color-mix(in srgb, var(--vscode-foreground) 8%, transparent));
}

/* Inline modal action button — used inside the update modal (renders via
   updateModalHtml.ts). Same shape as .multi-btn but exposed under the
   .action-btn name the modal HTML uses, since that's the convention shared
   with the viewer's compare modal. */
.action-btn {
  padding: 6px 14px;
  font-family: inherit;
  font-size: inherit;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: 1px solid transparent;
  border-radius: 2px;
  cursor: pointer;
}
.action-btn:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}
.action-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
/* (.action-btn-secondary rules are provided by compareModalCss() above.) */

.hit-filename {
  font-weight: 600;
  margin-bottom: 2px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
}

/*
 * Hash-pairing badge — surfaces sha collisions across the current result set
 * visually so the user can spot which rows are byte-identical at a glance
 * (the same content can exist in N folders; groupHitsByFolder fans it into N
 * rows). Only rendered for shas with count ≥ 2 — singletons get no badge so
 * the panel doesn't fill with noise.
 *
 * Background colour is set inline on the span (CSP allows 'unsafe-inline'
 * for style), assigned in first-appearance order from a small palette. Black
 * foreground is chosen for contrast against the pastel palette — same
 * reasoning as the .selected colours above.
 */
.hash-badge {
  font-family: var(--vscode-editor-font-family);
  font-size: 0.75em;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;
  color: #1a1a1a;
  letter-spacing: 0.03em;
  white-space: nowrap;
  /* Pulled up a hair so it visually centres against the heavier filename
     glyphs above the baseline rather than dropping below them. */
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
/* Placeholder rows read a touch dimmer so real decks stand out in a list
   that mixes both (an event tree is mostly placeholders pre-handover). */
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
  const orToggle = document.getElementById('or-mode');
  const results = document.getElementById('results');
  const footerText = document.getElementById('footer-text');
  const multiToolbar = document.getElementById('multi-toolbar');
  const multiStatus = document.getElementById('multi-status');
  const multiClearBtn = document.getElementById('multi-clear-btn');
  const multiUpdateBtn = document.getElementById('multi-update-btn');
  const modalHost = document.getElementById('modal-host');

  let latestQuery = '';
  let debounceHandle = null;

  // ── Multi-select state ────────────────────────────────────────────────
  //
  // selectionMode flips true on the first shift-click on a hit row and stays
  // true until the user clicks "Clear selection" or a fresh search query is
  // typed. While selectionMode is on, plain clicks toggle row selection
  // instead of opening the file; shift-click also toggles (the modifier only
  // matters for entering the mode, not for the per-row interaction once in).
  //
  // selectedKeys keys each row by its first URI — rows are already fanned
  // out per folder (groupHitsByFolder partitions duplicate-content hits into
  // one row per folder), so the first URI is unique per row in the panel.
  // The group index (0-based, into the rendered groups[] array) is stored on
  // the row's dataset so we can evaluate the "primed for update" condition
  // (exactly 2 selected, one in group 0, one in group 1+) without rebuilding
  // a key→group map on every click.
  //
  // disabledKeys remembers rows that have already been processed in this
  // batch (Update or Update & remove completed). The keys map to the disable
  // reason ('updated' or 'removed') so we can render the correct visual.
  // Cleared when the user types a new query — but preserved across reindex
  // re-search and across panel show/hide (retainContextWhenHidden).
  //
  // currentGroups stashes the last-rendered groups array so the primed-check
  // can resolve a row's group from its dataset.
  let selectionMode = false;
  const selectedKeys = new Set();
  const disabledKeys = new Map(); // uri → 'updated' | 'removed'
  let currentGroups = [];
  let lastRenderedQuery = '';

  // Palette for the hash-pairing badge. Pastel hues that work over both light
  // and dark themes; yellow + lime are deliberately omitted to avoid visual
  // collision with the .selected (yellow) and .selected.primed (lime) row
  // states. If a result set has more distinct duplicated shas than there are
  // palette slots, colours cycle — pairing within a colour-group is still
  // useful even if a single colour now means "one of several pairs".
  const HASH_PALETTE = [
    '#ef9a9a', // red 200
    '#f48fb1', // pink 200
    '#ce93d8', // purple 200
    '#9fa8da', // indigo 200
    '#90caf9', // blue 200
    '#80deea', // cyan 200
    '#80cbc4', // teal 200
    '#ffcc80', // orange 200
    '#bcaaa4', // brown 200
  ];

  function rowKey(hit) {
    return (hit && Array.isArray(hit.uris) && hit.uris[0]) || '';
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

  if (orToggle) {
    // Toggling AND↔OR with a non-empty query re-runs the search immediately;
    // empty input just leaves the empty-state in place. No debounce — the
    // user's just clicked once and is waiting for a single response.
    orToggle.addEventListener('change', function () {
      const q = qInput.value;
      if (q.trim() === '') return;
      postSearch(q);
    });
  }

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
        vscode.postMessage({ type: 'search', query: latestQuery, op: currentOp() });
      }
    } else if (msg.type === 'emptyState') {
      // Used by the extension to push a custom empty-state message after a
      // topology change (scope dropped to zero, etc.).
      renderEmpty(msg.message);
    } else if (msg.type === 'updateModal') {
      // Extension finished reading + parsing both files; render the compare
      // modal (or the identical-files variant). The HTML comes from
      // updateModalHtml.ts on the extension side.
      if (typeof msg.html === 'string' && msg.html) {
        openModal(msg.html);
      }
    } else if (msg.type === 'updateModalClose') {
      // Extension is dismissing the modal (e.g. after a cancel).
      closeModal();
    } else if (msg.type === 'updateResult') {
      // Outcome of an Update or Update & remove. Mark the rows as disabled
      // with the appropriate visual (dimmed or red-tinged) so the user can
      // see what's already been processed in this batch, and dismiss the
      // modal if it's still up.
      closeModal();
      if (msg.outcome === 'updated' || msg.outcome === 'updated-removed') {
        if (typeof msg.targetUri === 'string' && msg.targetUri) {
          disabledKeys.set(msg.targetUri, 'updated');
        }
        if (typeof msg.sourceUri === 'string' && msg.sourceUri) {
          disabledKeys.set(
            msg.sourceUri,
            msg.outcome === 'updated-removed' ? 'removed' : 'updated',
          );
        }
        // Drop the now-disabled rows from selection and exit selection mode
        // so the user can immediately start a fresh pair without clicking
        // Clear. If they want to keep working with multi-select, the next
        // shift-click flips the mode back on.
        selectedKeys.clear();
        selectionMode = false;
        applySelectionStyles();
        updateMultiToolbar();
      } else if (msg.outcome === 'pdf-import-routed') {
        // The PDF source was handed off to the viewer's PDF-import modal.
        // We don't disable the rows — the user may cancel inside the
        // viewer or convert and want to keep the source visible. Just
        // clear selection so the panel is ready for the next pair.
        selectedKeys.clear();
        selectionMode = false;
        applySelectionStyles();
        updateMultiToolbar();
      }
      // 'error' / 'identical' outcomes leave selection alone — the user may
      // want to retry, pick a different source, or cancel manually.
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
    // Clear selection/disabled state when the user types a new query — the
    // rows belong to a different result set so stale selections would be
    // confusing. Reindex-triggered re-runs against the SAME query keep the
    // state (in-progress batch survives a watcher event).
    if (query !== lastRenderedQuery) {
      selectionMode = false;
      selectedKeys.clear();
      disabledKeys.clear();
    }
    lastRenderedQuery = query;
    currentGroups = groups || [];

    // Total hit count across every group — drives the "No matches" empty
    // state when nothing came back at all.
    let totalHits = 0;
    for (const g of currentGroups) totalHits += (g.hits || []).length;
    if (!totalHits) {
      const wrap = document.createElement('div');
      wrap.className = 'empty-state';
      wrap.textContent = 'No matches.';
      results.replaceChildren(wrap);
      updateMultiToolbar();
      return;
    }

    // Hash-pairing colours. First pass tallies sha occurrences across the
    // rendered set; second pass assigns a palette colour to each sha seen
    // ≥ 2 times, in first-appearance order so the colour ordering is stable
    // for a given query. Singletons stay out of shaColors — renderHit skips
    // the badge entirely for them.
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
      if (!group || !group.hits || !group.hits.length) {
        groupIndex++;
        continue;
      }
      frag.appendChild(renderGroup(group, query, groupIndex, shaColors, shaCounts));
      groupIndex++;
    }
    results.replaceChildren(frag);
    // Re-apply selection/disabled state to freshly-built DOM (covers the
    // reindex re-render case where state survives).
    applySelectionStyles();
    updateMultiToolbar();
  }

  function renderGroup(group, query, groupIndex, shaColors, shaCounts) {
    // groupIndex 0 is the top/canonical workspace folder (same signal the
    // update-priming uses); give it a distinct, clearly-labelled header so it
    // reads apart from additional folders.
    const isPrimary = groupIndex === 0;
    const section = document.createElement('section');
    section.className = 'hit-group' + (isPrimary ? ' is-primary' : ' is-secondary');
    const header = document.createElement('h2');
    header.className = 'hit-group-header';
    const label = document.createElement('span');
    label.className = 'hit-group-label';
    label.textContent = group.folderLabel || group.folderUri || '(unknown)';
    header.appendChild(label);
    // Definite tag delineating the top workspace folder from the rest.
    const tag = document.createElement('span');
    tag.className = 'hit-group-tag';
    tag.textContent = isPrimary ? 'workspace folder' : 'other folder';
    header.appendChild(tag);
    const count = document.createElement('span');
    count.className = 'hit-group-count';
    count.textContent = group.hits.length + ' match' + (group.hits.length === 1 ? '' : 'es');
    header.appendChild(count);
    section.appendChild(header);
    const list = document.createElement('div');
    list.className = 'hit-list';
    for (const hit of group.hits) {
      list.appendChild(renderHit(hit, query, groupIndex, shaColors, shaCounts));
    }
    section.appendChild(list);
    return section;
  }

  function renderHit(hit, query, groupIndex, shaColors, shaCounts) {
    const row = document.createElement('div');
    row.className = 'hit';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.dataset.sha = hit.sha256 || '';
    // Identity for the selection / disabled-state maps. First URI is unique
    // per fanned-out row; group index lets the primed-state evaluator decide
    // "is this in the first group or elsewhere" without walking the DOM.
    const key = rowKey(hit);
    row.dataset.uri = key;
    row.dataset.groupIndex = String(groupIndex);

    const filename = document.createElement('div');
    filename.className = 'hit-filename';
    // Prefer the display-form field (URI-decoded, case preserved); fall
    // back to the folded match form if an older indexer record doesn't
    // carry one — schema-mismatch eviction should make that transient.
    const displayName = hit.displayFilename || hit.filename || '(unknown)';
    // Wrap the filename text in its own span so flex layout treats it as a
    // single inline item, with the hash badge floating beside it. Without
    // this wrapper, the highlight() fragment's individual text nodes and
    // <mark> elements each become flex items and gap is applied between
    // every one of them.
    const nameSpan = document.createElement('span');
    nameSpan.className = 'hit-filename-text';
    nameSpan.appendChild(highlight(displayName, query));
    filename.appendChild(nameSpan);
    // Hash-pairing badge: only when this sha appears 2+ times in the current
    // result set. Tooltip shows the full sha + the count so the user can
    // verify why the colour was assigned.
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
    // Placeholder marker: this hit is a zero-byte / registered-placeholder
    // stub, indexed by its filename. Tag it so it reads distinctly from a
    // real deck (they carry no author / slide text to search anyway).
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

    function onActivate(e) {
      // Disabled rows are inert. CSS sets pointer-events:none so this branch
      // is belt-and-braces (covers keyboard activation as well).
      if (disabledKeys.has(key)) return;
      // Shift activates selection mode on first use; once in selection mode,
      // every click toggles selection. We never open the file from a click
      // while selectionMode is active — the user can Clear to exit.
      const shift = !!(e && e.shiftKey);
      if (!selectionMode && shift) {
        selectionMode = true;
        selectedKeys.add(key);
        applySelectionStyles();
        updateMultiToolbar();
        return;
      }
      if (selectionMode) {
        if (selectedKeys.has(key)) selectedKeys.delete(key);
        else selectedKeys.add(key);
        applySelectionStyles();
        updateMultiToolbar();
        return;
      }
      fire();
    }

    row.addEventListener('click', onActivate);
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate(e);
      }
    });

    // Apply the row's current visual state on first render. Subsequent state
    // changes go through applySelectionStyles which walks all rows.
    if (disabledKeys.has(key)) {
      row.classList.add('disabled');
      row.classList.add(disabledKeys.get(key) === 'removed' ? 'removed' : 'updated');
      row.setAttribute('aria-disabled', 'true');
    } else if (selectedKeys.has(key)) {
      row.classList.add('selected');
    }

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

  // ── Selection styling & toolbar ───────────────────────────────────────

  /**
   * Walk every .hit row in the DOM and reconcile its classes against the
   * current selectedKeys + disabledKeys + primed-state. Cheap — the row
   * count is capped at MAX_RESULTS (200) and class toggles are batched per
   * row. Called after every selection change and after every renderResults.
   */
  function applySelectionStyles() {
    const primedKeys = evaluatePrimedKeys();
    const rows = results.querySelectorAll('.hit');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const key = row.dataset.uri || '';
      // Disabled wins over everything else — these rows are inert.
      if (disabledKeys.has(key)) {
        row.classList.add('disabled');
        const reason = disabledKeys.get(key);
        row.classList.toggle('removed', reason === 'removed');
        row.classList.toggle('updated', reason !== 'removed');
        row.classList.remove('selected');
        row.classList.remove('primed');
        row.setAttribute('aria-disabled', 'true');
        continue;
      }
      row.removeAttribute('aria-disabled');
      row.classList.remove('disabled');
      row.classList.remove('removed');
      row.classList.remove('updated');
      const isSelected = selectedKeys.has(key);
      row.classList.toggle('selected', isSelected);
      row.classList.toggle('primed', isSelected && primedKeys.has(key));
    }
  }

  /**
   * Compute the "primed for update" set: exactly two selected rows, one in
   * group 0 and one in another group. Returns a Set of the two row keys
   * (URIs) when primed, or an empty Set otherwise. The caller toggles the
   * .primed CSS class for any selected row whose key is in this set.
   *
   * Selected keys that no longer correspond to a row in the current results
   * (shouldn't happen — we clear selection on query change — but defensive
   * against late results) are skipped.
   */
  function evaluatePrimedKeys() {
    const empty = new Set();
    if (selectedKeys.size !== 2) return empty;
    let inFirstGroup = null;
    let elsewhere = null;
    const rows = results.querySelectorAll('.hit');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const key = row.dataset.uri || '';
      if (!selectedKeys.has(key)) continue;
      const groupIndex = parseInt(row.dataset.groupIndex || '-1', 10);
      if (groupIndex === 0) {
        if (inFirstGroup) return empty; // 2nd one in first group → not primed
        inFirstGroup = key;
      } else if (groupIndex > 0) {
        if (elsewhere) return empty; // 2nd one outside first group → not primed
        elsewhere = key;
      } else {
        // Unparseable group index — bail rather than guess.
        return empty;
      }
    }
    if (inFirstGroup && elsewhere) {
      const out = new Set();
      out.add(inFirstGroup);
      out.add(elsewhere);
      return out;
    }
    return empty;
  }

  /**
   * Reconcile the multi-select toolbar visibility + button states with the
   * current selection. Driven by every selection change.
   */
  function updateMultiToolbar() {
    if (!selectionMode) {
      multiToolbar.setAttribute('hidden', '');
      return;
    }
    multiToolbar.removeAttribute('hidden');
    const n = selectedKeys.size;
    const primedKeys = evaluatePrimedKeys();
    const primed = primedKeys.size === 2;
    if (primed) {
      multiStatus.textContent = 'Ready to update — 1 file in canonical group, 1 in remote.';
    } else if (n === 0) {
      multiStatus.textContent = 'Multi-select: 0 selected. Click rows to choose two files.';
    } else if (n === 1) {
      multiStatus.textContent = 'Multi-select: 1 selected. Pick a second from a different group.';
    } else if (n === 2) {
      multiStatus.textContent = 'Multi-select: 2 selected — need one in the first group and one in another.';
    } else {
      multiStatus.textContent = 'Multi-select: ' + n + ' selected — narrow to exactly 2 (one per group).';
    }
    multiUpdateBtn.disabled = !primed;
    multiUpdateBtn.title = primed
      ? 'Compare the two selected files and choose how to update the canonical copy.'
      : 'Select one file in the first group and one in another group to enable Update.';
  }

  /**
   * Find the target (first-group) and source (other-group) URIs from the
   * current primed selection. Returns null when not primed.
   */
  function getPrimedPair() {
    if (selectedKeys.size !== 2) return null;
    let target = null;
    let source = null;
    const rows = results.querySelectorAll('.hit');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const key = row.dataset.uri || '';
      if (!selectedKeys.has(key)) continue;
      const groupIndex = parseInt(row.dataset.groupIndex || '-1', 10);
      if (groupIndex === 0) target = key;
      else if (groupIndex > 0) source = key;
    }
    if (!target || !source) return null;
    return { targetUri: target, sourceUri: source };
  }

  // ── Multi-toolbar buttons ─────────────────────────────────────────────

  multiClearBtn.addEventListener('click', function () {
    selectionMode = false;
    selectedKeys.clear();
    applySelectionStyles();
    updateMultiToolbar();
  });

  multiUpdateBtn.addEventListener('click', function () {
    const pair = getPrimedPair();
    if (!pair) return; // shouldn't happen — button is disabled when not primed
    // The extension will read both files, parse, compare sha, and post back
    // an updateModal message with the side-by-side comparison HTML.
    vscode.postMessage({
      type: 'updateFile',
      targetUri: pair.targetUri,
      sourceUri: pair.sourceUri,
    });
  });

  // ── Modal host ────────────────────────────────────────────────────────

  function openModal(html) {
    modalHost.innerHTML = html;
    modalHost.classList.add('open');
    modalHost.setAttribute('aria-hidden', 'false');
    // Wire whichever of the four well-known button ids are present in the
    // posted HTML. The renderer (updateModalHtml.ts) controls which subset
    // appears: identical-modal has only the cancel button; the full compare
    // modal has all three.
    const cancelBtn = modalHost.querySelector('#search-update-cancel-btn');
    const confirmBtn = modalHost.querySelector('#search-update-confirm-btn');
    const removeBtn = modalHost.querySelector('#search-update-remove-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'updateCancel' });
      });
    }
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function () {
        confirmBtn.disabled = true;
        if (removeBtn) removeBtn.disabled = true;
        vscode.postMessage({ type: 'updateConfirm', mode: 'update' });
      });
    }
    if (removeBtn) {
      removeBtn.addEventListener('click', function () {
        removeBtn.disabled = true;
        if (confirmBtn) confirmBtn.disabled = true;
        vscode.postMessage({ type: 'updateConfirm', mode: 'update-remove' });
      });
    }
  }

  function closeModal() {
    modalHost.classList.remove('open');
    modalHost.setAttribute('aria-hidden', 'true');
    modalHost.innerHTML = '';
  }

  function updateFooter(msg) {
    const total = typeof msg.total === 'number' ? msg.total : 0;
    const done = typeof msg.done === 'number' ? msg.done : 0;
    const errors = typeof msg.errors === 'number' ? msg.errors : 0;
    const scopeFolderCount = typeof msg.scopeFolderCount === 'number'
      ? msg.scopeFolderCount
      : -1; // -1 = unknown → don't override existing empty-state handling

    // Scope-changed-to-zero: surface the empty-scope state in the footer
    // and (when no query is active) in the results pane, so a user who
    // had the panel open through a workspace-folder removal sees the
    // dropped state instead of stale "N indexed".
    if (scopeFolderCount === 0) {
      footerText.textContent = 'No source folders in scope.';
      results.setAttribute('aria-busy', 'false');
      if (!latestQuery || latestQuery.trim() === '') {
        renderEmpty(
          'No source folders to search. Add a workspace folder, or check that it is not claimed as a destination by an active .sync.jsonc.',
        );
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
      progressText = 'Walking source folders…';
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
