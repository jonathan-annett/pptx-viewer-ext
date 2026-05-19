// Pure HTML renderer for the pptx viewer's "drop file to update" modals.
//
// Two surfaces:
//   - renderCompareModalHtml: full-overlay side-by-side comparison shown
//     when a dropped pptx differs from the file currently open. Buttons:
//     "Update file" (#compare-update-btn) / "Cancel" (#compare-cancel-btn).
//   - renderIdenticalModalHtml: info modal shown when the dropped file
//     has the same sha256 as the current file. Single OK
//     (#compare-ok-btn).
//
// The webview inserts the returned HTML into a fixed-position container via
// innerHTML, so we don't need a nonce — no inline script runs from this
// string. CSS lives in the main webview <style> block (compareModalCss()
// returns the rules; the viewer concatenates them with its existing CSS).
//
// Sits under src/sync/ alongside the other pure renderers, even though it
// belongs to the pptx viewer surface — the project's pure/wired convention
// is signalled by the file's vscode-freedom, not by the directory.

import type { ParseResult } from '../pptx';

export function renderCompareModalHtml(
  current: ParseResult,
  candidate: ParseResult,
  autoSyncDefault: boolean,
): string {
  // Modal is rendered into a host container that the viewer styles as a
  // full-window overlay. The dimmed backdrop is a sibling rule on .modal-host.
  // The auto-sync checkbox lives in the action row; its initial checked state
  // comes from globalState (last value used on a previous Update). Toggling
  // the box only takes effect when the user actually clicks Update — Cancel
  // preserves the prior default.
  const checked = autoSyncDefault ? ' checked' : '';
  return `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="compare-title">
  <h2 id="compare-title" class="modal-title">Replace current file?</h2>
  <p class="modal-sub">A different pptx was dropped. Compare and choose.</p>
  <div class="compare-grid">
    <div class="compare-col">
      <h3 class="compare-col-head">Current</h3>
      ${renderColumn(current)}
    </div>
    <div class="compare-col">
      <h3 class="compare-col-head">Dropped</h3>
      ${renderColumn(candidate)}
    </div>
  </div>
  <div class="modal-actions">
    <label class="compare-auto-sync" title="Run the per-file sync immediately after replacing — pushes the new file out to its destinations">
      <input type="checkbox" id="compare-auto-sync"${checked}>
      <span>Sync to destinations after update</span>
    </label>
    <span class="modal-actions-spacer"></span>
    <button type="button" class="action-btn action-btn-secondary" id="compare-cancel-btn">Cancel</button>
    <button type="button" class="action-btn" id="compare-update-btn">Update file</button>
  </div>
</div>`;
}

export function renderIdenticalModalHtml(droppedFileName: string): string {
  return `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="identical-title">
  <h2 id="identical-title" class="modal-title">File dropped matches existing content</h2>
  <p class="modal-sub">${escapeHtml(droppedFileName)} has the same sha256 as the file currently open. No update needed.</p>
  <div class="modal-actions">
    <button type="button" class="action-btn" id="compare-ok-btn">OK</button>
  </div>
</div>`;
}

// ───── pieces ───────────────────────────────────────────────────────────

function renderColumn(r: ParseResult): string {
  const rows: Array<[string, string]> = [
    ['File name', r.fileName],
    ['Size', `${r.sizeHuman} (${r.size.toLocaleString()} bytes)`],
    ['Modified', r.mtimeHuman],
    ['SHA-256', r.sha256],
    ['Slides', String(r.slideCount)],
    ['Hidden slides', String(r.hiddenSlideCount)],
    ['Author', r.author],
    ['Last modified by', r.lastModifiedBy],
    ['Embedded media', formatMedia(r.embeddedMedia)],
  ];
  const thumb = r.thumbnail
    ? `<img class="compare-thumb" src="${r.thumbnail.dataUrl}" alt="">`
    : '<div class="compare-thumb compare-thumb-empty">No thumbnail</div>';
  return `${thumb}
    <dl class="compare-meta">
      ${rows.map(([k, v]) => `<div class="compare-row"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('\n      ')}
    </dl>`;
}

function formatMedia(media: ParseResult['embeddedMedia']): string {
  if (media.length === 0) return 'none';
  return media.map((m) => `${m.mime} × ${m.count}`).join(', ');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ───── styles ───────────────────────────────────────────────────────────

/**
 * Inline CSS for both modals. Concatenate into the viewer's main `<style>`
 * block so the rules are available the moment the host container is
 * populated via innerHTML.
 */
export function compareModalCss(): string {
  return `
    .modal-host {
      position: fixed;
      inset: 0;
      background: color-mix(in srgb, #000 55%, transparent);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      z-index: 1000;
    }
    .modal-host.open { display: flex; }
    .modal {
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.4));
      border-radius: 6px;
      max-width: 920px;
      width: 100%;
      max-height: calc(100vh - 48px);
      overflow: auto;
      padding: 20px 24px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
    }
    .modal-title {
      margin: 0 0 4px;
      font-size: 1.1em;
    }
    .modal-sub {
      margin: 0 0 16px;
      color: var(--vscode-descriptionForeground);
    }
    .modal-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 16px;
      flex-wrap: wrap;
    }
    /* Spacer eats any leftover width between the checkbox (left-aligned)
       and the buttons (right-aligned), so the row reads as two clusters. */
    .modal-actions-spacer { flex: 1 1 auto; }
    .compare-auto-sync {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--vscode-foreground);
      font-size: 0.92em;
      user-select: none;
      cursor: pointer;
    }
    .compare-auto-sync input[type="checkbox"] {
      margin: 0;
      cursor: pointer;
      /* Inherit the host palette so the box doesn't look like a stray
         browser-native widget against VS Code's chrome. */
      accent-color: var(--vscode-charts-green, #4caf50);
    }
    .action-btn-secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border-color: var(--vscode-panel-border, rgba(128,128,128,0.4));
    }
    .action-btn-secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground, color-mix(in srgb, var(--vscode-foreground) 8%, transparent));
    }

    .compare-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .compare-col {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 4px;
      padding: 12px;
      background: color-mix(in srgb, var(--vscode-foreground) 3%, transparent);
    }
    .compare-col-head {
      margin: 0 0 8px;
      font-size: 0.95em;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 700;
    }
    .compare-thumb {
      display: block;
      max-width: 100%;
      max-height: 180px;
      height: auto;
      margin: 0 0 10px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 4px;
      background: var(--vscode-editor-background);
    }
    .compare-thumb-empty {
      padding: 24px 8px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    .compare-meta {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 4px 12px;
      margin: 0;
    }
    .compare-row { display: contents; }
    .compare-meta dt {
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .compare-meta dd {
      margin: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      word-break: break-all;
    }

    /* Narrow viewport: stack the two columns. */
    @media (max-width: 720px) {
      .compare-grid { grid-template-columns: 1fr; }
    }
  `;
}
