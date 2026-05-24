// Pure HTML renderer for the search panel's "update file" confirmation modal.
//
// Two surfaces:
//   - renderSearchUpdateModalHtml: side-by-side compare between the canonical
//     target file (in the first scope folder) and the candidate source file
//     (from another scope folder, typically a dropbox-style staging area).
//     Three actions:
//       - Cancel                    (#search-update-cancel-btn)
//       - Update file               (#search-update-confirm-btn)
//       - Update & remove source    (#search-update-remove-btn)
//   - renderSearchUpdateIdenticalModalHtml: shown when the candidate's
//     sha256 matches the target's — single Cancel button, no destructive
//     action available.
//
// Mirrors the pattern in src/sync/compareModalHtml.ts (drop → update). CSS
// rules are reused via that module's `compareModalCss()` export so the two
// modals look identical; the only delta is the third button + the absence of
// the auto-sync checkbox (the search panel has no sync surface to drive).

import type { ParseResult } from '../pptx';

export interface SearchUpdateModalInput {
  /** The canonical file that lives in groups[0] of the search results. */
  target: ParseResult;
  /** The candidate source file from another scope folder. */
  candidate: ParseResult;
  /** Display label for the target's containing folder ("My Decks", etc.). */
  targetFolderLabel: string;
  /** Display label for the candidate's containing folder ("Dropbox-In", etc.). */
  candidateFolderLabel: string;
}

export function renderSearchUpdateModalHtml(input: SearchUpdateModalInput): string {
  const { target, candidate, targetFolderLabel, candidateFolderLabel } = input;
  return `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="search-update-title">
  <h2 id="search-update-title" class="modal-title">Update canonical file?</h2>
  <p class="modal-sub">Replace the file on the left with the file on the right.</p>
  <div class="compare-grid">
    <div class="compare-col">
      <h3 class="compare-col-head">Canonical — ${escapeHtml(targetFolderLabel)}</h3>
      ${renderColumn(target)}
    </div>
    <div class="compare-col">
      <h3 class="compare-col-head">Incoming — ${escapeHtml(candidateFolderLabel)}</h3>
      ${renderColumn(candidate)}
    </div>
  </div>
  <div class="modal-actions">
    <span class="modal-actions-spacer"></span>
    <button type="button" class="action-btn action-btn-secondary" id="search-update-cancel-btn">Cancel</button>
    <button type="button" class="action-btn action-btn-secondary" id="search-update-remove-btn" title="Overwrite the canonical file with the incoming file, then delete the incoming file from its folder.">Update &amp; remove source</button>
    <button type="button" class="action-btn" id="search-update-confirm-btn">Update file</button>
  </div>
</div>`;
}

export function renderSearchUpdateIdenticalModalHtml(input: {
  targetFileName: string;
  candidateFileName: string;
  targetFolderLabel: string;
  candidateFolderLabel: string;
  sha256: string;
}): string {
  // Single-button modal — destructive actions are intentionally absent here.
  // Identical sha256 means the canonical file already carries the same bytes,
  // so neither "Update" nor "Update & remove" is offered. The user can dismiss
  // and pick a different source if they actually meant to replace.
  return `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="search-update-identical-title">
  <h2 id="search-update-identical-title" class="modal-title">Files are identical</h2>
  <p class="modal-sub">
    <strong>${escapeHtml(input.candidateFileName)}</strong> in
    <em>${escapeHtml(input.candidateFolderLabel)}</em> matches
    <strong>${escapeHtml(input.targetFileName)}</strong> in
    <em>${escapeHtml(input.targetFolderLabel)}</em> (sha256
    <code>${escapeHtml(input.sha256.slice(0, 12))}…</code>).
    Nothing to update.
  </p>
  <div class="modal-actions">
    <span class="modal-actions-spacer"></span>
    <button type="button" class="action-btn" id="search-update-cancel-btn">Cancel</button>
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
