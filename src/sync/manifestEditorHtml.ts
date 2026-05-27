// Pure HTML renderer for the .foldersync-manifest.json custom editor.
//
// Pairs with manifestEditor.ts (vscode-wired) per the pure/wired split
// convention in CLAUDE.md. tsx-testable, no vscode import.
//
// The manifest is fully extension-managed — the executor writes entries on
// every sync run, the plan webview writes decisions when the user toggles
// "don't ask again". v1 of this editor is view-only with a Reopen-as-text
// escape hatch. See `folder-sync-v1-plan.md` §M6.E for the design rationale.

import type { Manifest, ManifestReadResult } from './manifest-types';
import type { DriftRecord, ManifestDriftMap } from './manifestDrift';

/** A view model row for the `entries` table. */
export interface ManifestEditorEntryRow {
  key: string;
  destPath: string;
  /** Human-readable size, e.g. `1.2 MB`. */
  sizeHuman: string;
  /** First 12 chars of the sha256 for compact display. */
  sha256Short: string;
  /** Full sha256, used for the tooltip. */
  sha256Full: string;
  /** Relative time, e.g. `5m ago`. */
  syncedAtRelative: string;
  /** Original ISO timestamp, used for the tooltip. */
  syncedAtIso: string;
  /**
   * Drift classification for this row, when the wired layer has run a
   * pass. Undefined while drift is still computing (or when the editor
   * is rendering in main-user mode, where the drift column is hidden).
   */
  drift?: DriftRecord;
}

/** A view model row for the `decisions` table. */
export interface ManifestEditorDecisionRow {
  key: string;
  destOnlyDelete: boolean;
  collisionOverwrite: boolean;
  warningOverride: boolean;
  decidedAtRelative: string;
  decidedAtIso: string;
}

/**
 * Two presentation modes:
 *   - `'mainUser'` — the user who orchestrates syncs from above. Sees the
 *     full manifest, including the Decisions table (their own remembered
 *     "don't ask again" toggles).
 *   - `'operator'` — destination-only workspace. Decisions are source-side
 *     state (set in the plan webview, which doesn't exist here), so the
 *     section is hidden. Disclaimer copy is also operator-appropriate.
 *
 * Defaults to `'mainUser'` so callers that don't supply it keep the
 * existing rendering.
 */
export type ManifestEditorMode = 'mainUser' | 'operator';

export interface ManifestEditorOkViewModel {
  kind: 'ok';
  /** Display label for the destination root URI. */
  destRootLabel: string;
  /** Version field from the manifest — always 1 for the `ok` variant. */
  version: 1;
  /** Pretty-printed `lastSync` timestamp, or `(never)` when null. */
  lastSyncLabel: string;
  entries: ManifestEditorEntryRow[];
  decisions: ManifestEditorDecisionRow[];
  mode: ManifestEditorMode;
}

export interface ManifestEditorMismatchViewModel {
  kind: 'version-mismatch';
  destRootLabel: string;
  /** Stringified `actual` value from the read result. */
  actualLabel: string;
  mode: ManifestEditorMode;
}

export type ManifestEditorViewModel =
  | ManifestEditorOkViewModel
  | ManifestEditorMismatchViewModel;

/**
 * Shape a `ManifestReadResult` into a view model for the renderer. Pure —
 * the caller provides `destRootLabel` (a vscode.workspace-relative path or
 * URI string) and `now` (so relative timestamps are deterministic in tests).
 *
 * Sorting: entries and decisions are returned in alphabetical key order so
 * the manifest viewer is diff-friendly with what the user would see via
 * Reopen-as-text.
 */
export function toManifestViewModel(
  read: ManifestReadResult,
  destRootLabel: string,
  now: Date = new Date(),
  mode: ManifestEditorMode = 'mainUser',
  drift?: ManifestDriftMap,
): ManifestEditorViewModel {
  if (read.kind === 'version-mismatch') {
    return {
      kind: 'version-mismatch',
      destRootLabel,
      actualLabel: stringifyActual(read.actual),
      mode,
    };
  }
  return {
    kind: 'ok',
    destRootLabel,
    version: 1,
    lastSyncLabel: formatLastSync(read.manifest.lastSync, now),
    entries: shapeEntries(read.manifest, now, drift),
    decisions: shapeDecisions(read.manifest, now),
    mode,
  };
}

function shapeEntries(
  manifest: Manifest,
  now: Date,
  drift?: ManifestDriftMap,
): ManifestEditorEntryRow[] {
  const keys = Object.keys(manifest.entries).sort();
  return keys.map((key) => {
    const e = manifest.entries[key];
    return {
      key,
      destPath: e.destPath,
      sizeHuman: humaniseSize(e.size),
      sha256Short: e.sha256.slice(0, 12),
      sha256Full: e.sha256,
      syncedAtRelative: relativeTime(e.syncedAt, now),
      syncedAtIso: e.syncedAt,
      drift: drift?.get(key),
    };
  });
}

function shapeDecisions(manifest: Manifest, now: Date): ManifestEditorDecisionRow[] {
  const keys = Object.keys(manifest.decisions).sort();
  return keys.map((key) => {
    const d = manifest.decisions[key];
    return {
      key,
      destOnlyDelete: d.destOnlyDelete,
      collisionOverwrite: d.collisionOverwrite,
      warningOverride: d.warningOverride,
      decidedAtRelative: relativeTime(d.decidedAt, now),
      decidedAtIso: d.decidedAt,
    };
  });
}

function formatLastSync(value: string | null, now: Date): string {
  if (!value) return '(never)';
  const rel = relativeTime(value, now);
  return rel ? `${rel} (${value})` : value;
}

function stringifyActual(actual: unknown): string {
  if (actual === undefined) return '(missing version field)';
  if (actual === null) return 'null';
  if (typeof actual === 'string') return JSON.stringify(actual);
  if (typeof actual === 'number' || typeof actual === 'boolean') return String(actual);
  try {
    return JSON.stringify(actual);
  } catch {
    return String(actual);
  }
}

/**
 * Render a size in bytes using a compact human-friendly form. Uses base-1024
 * units (KB/MB/GB/TB) — same convention as VS Code's file size displays.
 * Exposed for tests; the renderer uses it via shapeEntries.
 */
export function humaniseSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const formatted = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} ${units[i]}`;
}

/**
 * Compute a relative-time label for an ISO timestamp against `now`. Returns
 * the empty string for unparseable inputs so the caller can fall through to
 * showing the raw value. Exposed for tests.
 */
export function relativeTime(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const deltaMs = now.getTime() - t;
  const abs = Math.abs(deltaMs);
  const future = deltaMs < 0;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  let label: string;
  if (abs < 45_000) label = 'just now';
  else if (abs < hour) label = `${Math.round(abs / minute)}m`;
  else if (abs < day) label = `${Math.round(abs / hour)}h`;
  else if (abs < week) label = `${Math.round(abs / day)}d`;
  else label = `${Math.round(abs / week)}w`;
  if (label === 'just now') return label;
  return future ? `in ${label}` : `${label} ago`;
}

/**
 * Render the manifest editor HTML. The `nonce` must be unique per render
 * and match the CSP `script-src 'nonce-...'` directive — same pattern as
 * the other editor panels.
 */
export function renderManifestEditorHtml(
  vm: ManifestEditorViewModel,
  nonce: string,
): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Folder Sync Manifest</title>
<style>${STYLE}</style>
</head>
<body>
  <header class="page-header">
    <h1 class="mono">${escapeHtml(vm.destRootLabel)}</h1>
    <p class="subtitle">Folder Sync Manifest</p>
  </header>

  <section class="card">
    <h2>Header</h2>
    <dl class="kv">
      ${renderHeaderRows(vm)}
    </dl>
  </section>

  ${renderBody(vm)}

  <footer class="page-footer">
    <p class="subtle">${renderDisclaimer(vm.mode)}</p>
  </footer>

  <section class="actions">
    ${vm.kind === 'ok' && vm.mode === 'operator'
      ? '<button id="refresh-drift" class="btn btn-secondary" type="button" title="Recompute drift status for every tracked file">Refresh drift</button>'
      : ''}
    <button id="open-text" class="btn btn-secondary" type="button" title="Open this file in the default JSON editor">Reopen as text</button>
  </section>

  <script nonce="${nonce}">${CLIENT_JS}</script>
</body>
</html>`;
}

function renderVersionMismatchCopy(
  mode: ManifestEditorMode,
  actualLabel: string,
): string {
  const versionPart = `(version ${escapeHtml(actualLabel)})`;
  if (mode === 'operator') {
    // In operator mode there's nothing TO sync — reframe the warning as
    // "you can't inspect this without updating the extension" rather than
    // "sync is disabled".
    return (
      `<strong>This destination was tracked by a newer version of Folder Sync</strong> ${versionPart}. ` +
      `The current extension only understands version 1; update it to inspect the manifest's entries. ` +
      `Use <em>Reopen as text</em> to view the raw file in the meantime.`
    );
  }
  return (
    `<strong>This manifest was written by a newer version of Folder Sync</strong> ${versionPart}. ` +
    `The current extension only understands version 1. Sync is disabled for this destination until the extension is updated. ` +
    `Use <em>Reopen as text</em> to inspect or hand-edit the file.`
  );
}

function renderDisclaimer(mode: ManifestEditorMode): string {
  if (mode === 'operator') {
    // Operator can't trigger a sync from this workspace; the relevant
    // warning is "don't hand-edit the destination's tracking record".
    // The decisions clause doesn't apply (decisions are source-side state
    // and the section is hidden in operator mode).
    return `This file is the destination's sync manifest, managed by Folder Sync from the source side. It records which files have been synced to this destination and their hashes at placement time. <strong>Do not hand-edit</strong> — the source will rewrite it on the next sync run. Use <em>Reopen as text</em> if you need to inspect (e.g. for debugging).`;
  }
  return `This file is managed automatically by Folder Sync. It records which files have been synced to this destination, their hashes at placement time, and any per-file decisions you've toggled in the plan. <strong>Do not hand-edit</strong> — the executor will rewrite it on the next sync run. Use <em>Reopen as text</em> if you need to inspect or hand-edit (e.g. for debugging).`;
}

function renderHeaderRows(vm: ManifestEditorViewModel): string {
  if (vm.kind === 'version-mismatch') {
    return `<dt>Version</dt><dd class="mono"><span class="badge badge-warn">unsupported: ${escapeHtml(vm.actualLabel)}</span></dd>`;
  }
  return (
    `<dt>Version</dt><dd class="mono">${vm.version}</dd>` +
    `<dt>Last sync</dt><dd class="mono small">${escapeHtml(vm.lastSyncLabel)}</dd>`
  );
}

function renderBody(vm: ManifestEditorViewModel): string {
  if (vm.kind === 'version-mismatch') {
    return `
  <section class="card">
    <div class="banner warn">
      ${renderVersionMismatchCopy(vm.mode, vm.actualLabel)}
    </div>
  </section>`;
  }
  const entriesSection = `
  <section class="card">
    <h2>Entries <span class="count">(${vm.entries.length})</span></h2>
    ${vm.entries.length === 0
      ? '<p class="hint"><em>No tracked entries — nothing has been synced to this destination yet.</em></p>'
      : renderEntriesTable(vm.entries, vm.mode)}
  </section>`;
  // Decisions are source-side state — the operator has no plan webview
  // to toggle "don't ask again" from, so the section is hidden in operator
  // mode rather than rendering an always-empty table with confusing copy.
  if (vm.mode === 'operator') {
    return entriesSection;
  }
  return `${entriesSection}

  <section class="card">
    <h2>Decisions <span class="count">(${vm.decisions.length})</span></h2>
    ${vm.decisions.length === 0
      ? '<p class="hint"><em>No remembered decisions — toggle a "don\u2019t ask again" checkbox in the plan webview to add one.</em></p>'
      : renderDecisionsTable(vm.decisions)}
  </section>`;
}

function renderEntriesTable(
  rows: ManifestEditorEntryRow[],
  mode: ManifestEditorMode,
): string {
  const showDriftBadge = mode === 'operator';
  const head = `
    <thead>
      <tr>
        <th class="col-dest">File</th>
        <th class="col-size">Size</th>
        <th class="col-hash">SHA-256</th>
        <th class="col-time">Synced</th>
      </tr>
    </thead>`;
  const body = rows
    .map(
      (r) => `
      <tr>
        <td class="mono small">${showDriftBadge ? renderDriftBadge(r) : ''}${escapeHtml(r.destPath)}</td>
        <td class="mono small">${escapeHtml(r.sizeHuman)}</td>
        <td class="mono small" title="${escapeHtml(r.sha256Full)}">${escapeHtml(r.sha256Short)}</td>
        <td class="mono small" title="${escapeHtml(r.syncedAtIso)}">${escapeHtml(r.syncedAtRelative || r.syncedAtIso)}</td>
      </tr>`,
    )
    .join('');
  return `<table class="data">${head}<tbody>${body}</tbody></table>`;
}

/**
 * Drift badge rendered inline as a prefix to the file path. Carries
 * its own per-status tooltip (the badge tells the whole story; a
 * separate column header would be redundant).
 */
function renderDriftBadge(row: ManifestEditorEntryRow): string {
  const status = row.drift?.status ?? 'computing';
  const expectedShort = row.sha256Short;
  switch (status) {
    case 'matches':
      return `<span class="drift-badge drift-match" title="On disk matches manifest sha (${escapeHtml(row.sha256Full)})">✓</span>`;
    case 'drifted': {
      const actualFull = row.drift?.actualSha256 ?? '';
      const actualShort = actualFull.slice(0, 12);
      const tip = `On disk differs from manifest. Expected ${expectedShort}, on disk ${actualShort || '(unknown)'}`;
      return `<span class="drift-badge drift-drifted" title="${escapeHtml(tip)}">⚠</span>`;
    }
    case 'missing':
      return `<span class="drift-badge drift-missing" title="File not present at ${escapeHtml(row.destPath)}">✗</span>`;
    case 'computing':
    default:
      return `<span class="drift-badge drift-computing" title="Checking…">…</span>`;
  }
}

function renderDecisionsTable(rows: ManifestEditorDecisionRow[]): string {
  const head = `
    <thead>
      <tr>
        <th class="col-key">Key</th>
        <th class="col-flag" title="User accepted destination-only deletion for this rel-path">Delete dest-only</th>
        <th class="col-flag" title="User accepted overwriting a collision for this rel-path">Overwrite collision</th>
        <th class="col-flag" title="User accepted shipping a file with override-severity warnings">Sync anyway (warned)</th>
        <th class="col-time">Decided</th>
      </tr>
    </thead>`;
  const body = rows
    .map(
      (r) => `
      <tr>
        <td class="mono small">${escapeHtml(r.key)}</td>
        <td class="flag">${flagCell(r.destOnlyDelete)}</td>
        <td class="flag">${flagCell(r.collisionOverwrite)}</td>
        <td class="flag">${flagCell(r.warningOverride)}</td>
        <td class="mono small" title="${escapeHtml(r.decidedAtIso)}">${escapeHtml(r.decidedAtRelative || r.decidedAtIso)}</td>
      </tr>`,
    )
    .join('');
  return `<table class="data">${head}<tbody>${body}</tbody></table>`;
}

function flagCell(on: boolean): string {
  return on ? '<span class="flag-on" title="yes">\u2713</span>' : '<span class="flag-off" title="no">\u2013</span>';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ───── CSS ──────────────────────────────────────────────────────────────
//
// Theme-aware via VS Code's CSS variables — same palette as the config and
// admin editors so all three custom editors feel like siblings.

const STYLE = `
:root { color-scheme: light dark; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  padding: 16px 20px 40px;
  max-width: 1100px;
  margin: 0 auto;
}
h1 {
  font-size: 1.35em;
  margin: 0 0 2px;
  word-break: break-all;
  line-height: 1.25;
}
h1.mono { font-family: var(--vscode-editor-font-family); }
h2 { font-size: 1.05em; margin: 0 0 10px; }
.subtle, .hint {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  margin: 0 0 12px;
}
.page-header {
  margin: 0 0 16px;
}
.subtitle {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: 0.95em;
  letter-spacing: 0.02em;
}
.page-footer {
  margin: 24px 0 4px;
  border-top: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.2));
  padding-top: 12px;
}
.page-footer .subtle { margin: 0; }
.mono {
  font-family: var(--vscode-editor-font-family);
}
.small { font-size: 0.85em; word-break: break-all; }
.count {
  color: var(--vscode-descriptionForeground);
  font-weight: normal;
  font-size: 0.9em;
}
.card {
  background: var(--vscode-editorWidget-background, rgba(127,127,127,0.05));
  border: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.2));
  border-radius: 6px;
  padding: 14px 16px;
  margin: 14px 0;
}
.banner {
  padding: 10px 14px;
  border-radius: 4px;
  border-left: 3px solid;
  line-height: 1.4;
}
.banner.warn {
  background: var(--vscode-inputValidation-warningBackground, rgba(255,180,0,0.1));
  border-color: var(--vscode-inputValidation-warningBorder, #b89500);
}
.badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 3px;
  font-size: 0.85em;
  font-weight: 600;
}
.badge-warn {
  background: var(--vscode-inputValidation-warningBackground, rgba(255,180,0,0.2));
  color: var(--vscode-editorWarning-foreground, #b89500);
}
.kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 16px;
  margin: 0;
}
.kv dt { color: var(--vscode-descriptionForeground); font-weight: 600; }
.kv dd { margin: 0; }
table.data {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
}
table.data th, table.data td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.15));
  vertical-align: top;
}
table.data th {
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editorWidget-background, transparent);
  border-bottom: 2px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.25));
  white-space: nowrap;
}
table.data tbody tr:last-child td { border-bottom: none; }
table.data .col-dest { width: auto; }
table.data .col-size, table.data .col-hash, table.data .col-time { white-space: nowrap; }
table.data .col-flag { text-align: center; white-space: nowrap; }
td.flag { text-align: center; }
.flag-on { color: var(--vscode-charts-green, #4caf50); font-weight: 600; }
.flag-off { color: var(--vscode-descriptionForeground); }
/* Drift badge — rendered inline as a prefix to the file path. */
.drift-badge {
  display: inline-block;
  width: 1.1em;
  margin-right: 6px;
  text-align: center;
  font-weight: 600;
  cursor: help;
}
.drift-match { color: var(--vscode-charts-green, #4caf50); }
.drift-drifted { color: var(--vscode-editorWarning-foreground, #b89500); }
.drift-missing { color: var(--vscode-editorError-foreground, #f44336); }
.drift-computing { color: var(--vscode-descriptionForeground); font-weight: normal; }
.btn {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  border: 1px solid transparent;
  border-radius: 3px;
  padding: 5px 12px;
  cursor: pointer;
}
.btn-secondary {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border-color: var(--vscode-button-border, rgba(127,127,127,0.4));
}
.btn-secondary:hover {
  background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.15));
}
.actions { display: flex; gap: 8px; margin: 16px 0 8px; flex-wrap: wrap; }
`;

// ───── client-side JS ──────────────────────────────────────────────────
//
// Just enough JS to wire the Reopen-as-text button. The view itself is
// fully server-rendered (re-render on doc change, posted as a full HTML
// replacement via panel.webview.html in manifestEditor.ts).

const CLIENT_JS = `
(function () {
  const vscode = acquireVsCodeApi();
  const openText = document.getElementById('open-text');
  if (openText) {
    openText.addEventListener('click', function () {
      vscode.postMessage({ type: 'openAsText' });
    });
  }
  const refreshDrift = document.getElementById('refresh-drift');
  if (refreshDrift) {
    refreshDrift.addEventListener('click', function () {
      vscode.postMessage({ type: 'refresh-drift' });
    });
  }
})();
`;
