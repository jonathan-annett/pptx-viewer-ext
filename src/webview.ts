// Render a ParseResult into the static HTML shown inside the webview.
//
// Styling notes (for the human learning CSS):
// - VS Code exposes its current theme via CSS custom properties prefixed with
//   --vscode-*. We use those instead of hardcoded colours so the panel matches
//   light/dark/high-contrast themes automatically.
// - The layout uses a 2-column CSS grid for the metadata table: the property
//   name is auto-sized, the value column grows to fill the rest. Grids are the
//   right tool when you want columns that align across many rows without
//   building a real <table>.
// - Warnings are visually distinct via:
//     1. a coloured left border (data ink — draws the eye)
//     2. a "WARN" pill that uses --vscode-errorForeground for high contrast
//     3. background tint using a low-opacity error colour
//   Three signals so the warn/pass distinction survives colour-blindness and
//   themes where the error colour is muted.
//
// Beyond rendering, this module also hosts the inline <script> that powers:
//   - Save As… (existing — routes through the extension host because the
//     web-webview iframe drops anchor-driven downloads on vscode.dev).
//   - Update… (file picker) — user-initiated replace; bytes posted to the
//     extension which parses + hashes + writes when the sha256 differs.
//   - Drag-and-drop ingest — drop a .pptx anywhere on the panel; same parse
//     + hash but with a confirmation modal because the user did not pick
//     this file from a dialog.
//
// The modal HTML is rendered on the extension side (see
// src/sync/compareModalHtml.ts) and posted to the webview as a string; the
// host container is a fixed-position overlay that the script toggles.

import type { Flag, MediaEntry, ParseResult } from './pptx';
import { compareModalCss } from './sync/compareModalHtml';

export interface RenderOptions {
  /** Pre-rendered HTML for the "Sync target" section, or null/undefined for
   *  none (file is outside any workspace). Passed verbatim — the caller is
   *  responsible for HTML safety on its inputs. */
  syncTargetHtml?: string | null;
  /** Pre-populated status text shown in the action row. Used after a
   *  successful Update / drop-confirm to surface "Updated" without needing
   *  the new script to receive a postMessage that may race the re-render. */
  initialStatus?: string;
}

export function renderHtml(r: ParseResult, nonce: string, opts: RenderOptions = {}): string {
  const metadataRows: Array<[string, string]> = [
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

  const errorBanner = r.parseError
    ? `<div class="banner warn">${escapeHtml(r.parseError)}</div>`
    : '';

  // Validation section is dropped when parsing failed — the three OK/WARN
  // flags rely on having parsed the deck, so reading "OK Linked media" off
  // a file we couldn't unzip would just be misleading.
  const validationSection = r.parseError
    ? ''
    : `<section>
      <h2>Validation</h2>
      <ul class="flags">
        ${flagLi(r.flags.linkedMedia)}
        ${flagLi(r.flags.showType)}
        ${flagLi(r.flags.showMediaControls)}
      </ul>
    </section>`;

  const syncTargetSection = opts.syncTargetHtml
    ? `<section>
      <h2>Sync target</h2>
      ${opts.syncTargetHtml}
    </section>`
    : '';

  const initialStatus = opts.initialStatus ? escapeHtml(opts.initialStatus) : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<title>${escapeHtml(r.fileName)}</title>
<style>${css()}</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(r.fileName)}</h1>
    <div class="actions">
      <button id="save-as-btn" class="action-btn" type="button">Save As\u2026</button>
      <button id="update-btn" class="action-btn action-btn-secondary" type="button">Update\u2026</button>
      <span id="action-status" class="action-status" aria-live="polite">${initialStatus}</span>
    </div>
    <input id="update-input" type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" style="display:none">
    ${thumbnailImg(r)}
    ${errorBanner}

    <section>
      <h2>Metadata</h2>
      <dl class="meta">
        ${metadataRows.map(([k, v]) => row(k, v)).join('\n')}
      </dl>
    </section>

    ${validationSection}

    ${syncTargetSection}
  </main>
  <div id="modal-host" class="modal-host" aria-hidden="true"></div>
  <div id="drop-overlay" class="drop-overlay" aria-hidden="true">
    <div class="drop-overlay-inner">
      <div class="drop-overlay-title">Drop a .pptx to compare or update</div>
      <div class="drop-overlay-sub">Hold <kbd>Shift</kbd> while dropping &mdash; otherwise VS Code opens it as a new tab</div>
    </div>
  </div>
  <script nonce="${nonce}">${viewerScript()}</script>
</body>
</html>`;
}

export function renderError(path: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>Pptx error</title>
<style>${css()}</style>
</head>
<body>
  <main>
    <h1>Could not open file</h1>
    <p class="path">${escapeHtml(path)}</p>
    <div class="banner warn">${escapeHtml(message)}</div>
  </main>
</body>
</html>`;
}

// ---------- pieces ----------

function thumbnailImg(r: ParseResult): string {
  if (!r.thumbnail) return '';
  // alt="" because the image is decorative — the filename above already labels
  // the content. A non-empty alt would just be read twice by a screen reader.
  return `<img class="thumbnail" src="${r.thumbnail.dataUrl}" alt="">`;
}

function row(key: string, value: string): string {
  return `<div class="row">
    <dt>${escapeHtml(key)}</dt>
    <dd>${escapeHtml(value)}</dd>
  </div>`;
}

function flagLi(f: Flag): string {
  const cls = f.ok ? 'pass' : 'warn';
  const tag = f.ok ? 'OK' : 'WARN';
  return `<li class="flag ${cls}">
    <span class="pill">${tag}</span>
    <span class="label">${escapeHtml(f.label)}</span>
    <span class="detail">${escapeHtml(f.detail)}</span>
  </li>`;
}

function formatMedia(media: MediaEntry[]): string {
  if (media.length === 0) return 'none';
  return media.map((m) => `${m.mime} × ${m.count}`).join(', ');
}

// Inline script consolidates all webview-side behaviour:
//
//   - Save As… → postMessage({type:'save-as'}), wait for save-as-result.
//   - Update… → click hidden <input type="file"> → on change post
//     {type:'ingest', source:'picker', fileName, bytes}.
//   - Drag/drop → on full-window drop, post {type:'ingest', source:'drop', …}
//     if the file passes a quick PK\x03\x04 magic-bytes check.
//   - Modal driver: when the extension replies with drop-result/different or
//     drop-result/identical, populate #modal-host via innerHTML (no nonce
//     needed — the modal HTML carries no scripts), wire the buttons, and
//     post confirm-update / cancel-update back.
//
// The save flow does NOT do a browser-native blob download — vscode.dev's
// web-webview iframe silently drops anchor-driven downloads (sandbox /
// cross-origin policy), even with a live user-activation token. Routing
// through the extension host bypasses the iframe restriction entirely.
function viewerScript(): string {
  return `(function(){
  const vscode = acquireVsCodeApi();
  const saveBtn = document.getElementById('save-as-btn');
  const updateBtn = document.getElementById('update-btn');
  const updateInput = document.getElementById('update-input');
  const status = document.getElementById('action-status');
  const modalHost = document.getElementById('modal-host');
  const dropOverlay = document.getElementById('drop-overlay');
  // The Run Sync button + hint live inside the Sync target section, which
  // may or may not be rendered — both are nullable. Re-resolved each render
  // because the whole webview HTML is replaced on every renderWithSyncTarget.
  const syncRunBtn = document.getElementById('sync-run-btn');
  const syncRunHint = document.getElementById('sync-run-hint');

  function vlog(msg){
    try { vscode.postMessage({type:'viewer-log', message: msg}); } catch (_) {}
  }
  window.addEventListener('error', function(ev){
    vlog('window error: ' + (ev.message || ev.error || 'unknown'));
  });

  function setStatus(text){ if (status) status.textContent = text || ''; }

  function setBusy(busy){
    if (saveBtn) saveBtn.disabled = busy;
    if (updateBtn) updateBtn.disabled = busy;
  }

  function openModal(html){
    if (!modalHost) return;
    modalHost.innerHTML = html;
    modalHost.classList.add('open');
    modalHost.setAttribute('aria-hidden', 'false');
    // Bind whichever buttons the modal contains. The IDs are stable;
    // see src/sync/compareModalHtml.ts.
    const okBtn = document.getElementById('compare-ok-btn');
    const updateBtnInModal = document.getElementById('compare-update-btn');
    const cancelBtnInModal = document.getElementById('compare-cancel-btn');
    if (okBtn) okBtn.addEventListener('click', function(){
      closeModal(); setStatus('');
    });
    if (cancelBtnInModal) cancelBtnInModal.addEventListener('click', function(){
      closeModal(); setStatus('');
      try { vscode.postMessage({type:'cancel-update'}); } catch (_) {}
    });
    if (updateBtnInModal) updateBtnInModal.addEventListener('click', function(){
      updateBtnInModal.disabled = true;
      if (cancelBtnInModal) cancelBtnInModal.disabled = true;
      // Read the auto-sync checkbox state at click time. The extension uses
      // this both to persist the next-time default and to decide whether to
      // run the per-file sync immediately after the write.
      var autoSyncCb = document.getElementById('compare-auto-sync');
      var autoSync = !!(autoSyncCb && autoSyncCb.checked);
      setStatus('Updating\u2026');
      try { vscode.postMessage({type:'confirm-update', autoSync: autoSync}); } catch (_) {}
    });
  }

  function closeModal(){
    if (!modalHost) return;
    modalHost.classList.remove('open');
    modalHost.setAttribute('aria-hidden', 'true');
    modalHost.innerHTML = '';
  }

  // ----- Save As… -----
  if (saveBtn) saveBtn.addEventListener('click', function(){
    setBusy(true);
    setStatus('Saving\u2026');
    vlog('click → save-as');
    try { vscode.postMessage({type: 'save-as'}); } catch (_) {}
  });

  // ----- Update… (file picker) -----
  if (updateBtn && updateInput) {
    updateBtn.addEventListener('click', function(){
      // Reset value first so picking the same filename twice still fires change.
      try { updateInput.value = ''; } catch (_) {}
      updateInput.click();
    });
    updateInput.addEventListener('change', async function(){
      const file = updateInput.files && updateInput.files[0];
      if (!file) return;
      vlog('picker → ' + file.name + ' (' + file.size + ' bytes)');
      setBusy(true);
      setStatus('Checking\u2026');
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        vscode.postMessage({type:'ingest', source:'picker', fileName: file.name, bytes: buf});
      } catch (err) {
        setBusy(false);
        setStatus('Could not read file');
        vlog('picker read error: ' + (err && err.message || err));
      }
    });
  }

  // ----- Drag and drop -----
  // dragenter/dragover need preventDefault to opt into a drop. We toggle a
  // body class so the overlay shows; dragleave is debounced via a counter
  // because dragleave fires on every child during a single drag.
  let dragDepth = 0;
  function showOverlay(){ if (dropOverlay) dropOverlay.classList.add('open'); }
  function hideOverlay(){ if (dropOverlay) dropOverlay.classList.remove('open'); }

  window.addEventListener('dragenter', function(e){
    e.preventDefault();
    dragDepth++;
    showOverlay();
  });
  window.addEventListener('dragover', function(e){
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', function(){
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideOverlay();
  });
  window.addEventListener('drop', async function(e){
    e.preventDefault();
    dragDepth = 0;
    hideOverlay();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    // First gate: extension. Lets us bail on obvious junk (.png, .pdf, …)
    // without round-tripping bytes through the extension host.
    if (!/\\.pptx$/i.test(file.name)) {
      vlog('drop: ignored non-pptx ' + file.name);
      return;
    }
    // Second gate: zip magic bytes PK\\x03\\x04. Tells us the file is at least
    // structurally a zip; the extension's full parser confirms it's a pptx.
    try {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (head[0] !== 0x50 || head[1] !== 0x4B || head[2] !== 0x03 || head[3] !== 0x04) {
        vlog('drop: ignored bad magic ' + file.name);
        return;
      }
    } catch (err) {
      vlog('drop: head read error: ' + (err && err.message || err));
      return;
    }
    vlog('drop → ' + file.name + ' (' + file.size + ' bytes)');
    setBusy(true);
    setStatus('Checking\u2026');
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      vscode.postMessage({type:'ingest', source:'drop', fileName: file.name, bytes: buf});
    } catch (err) {
      setBusy(false);
      setStatus('Could not read dropped file');
      vlog('drop read error: ' + (err && err.message || err));
    }
  });

  // ----- Per-file Run Sync (button lives inside the Sync target section) -----
  if (syncRunBtn) syncRunBtn.addEventListener('click', function(){
    if (syncRunBtn.disabled) return;
    syncRunBtn.disabled = true;
    syncRunBtn.textContent = 'Syncing\u2026';
    if (syncRunHint) syncRunHint.textContent = '';
    setBusy(true);
    setStatus('Syncing\u2026');
    vlog('click → run-sync');
    try { vscode.postMessage({type:'run-sync'}); } catch (_) {}
  });

  // ----- Extension → webview messages -----
  window.addEventListener('message', function(e){
    const m = e.data;
    if (!m || typeof m !== 'object') return;

    if (m.type === 'save-as-result') {
      setBusy(false);
      if (m.status === 'ok') {
        setStatus('Saved.');
        vlog('saved to ' + (m.target || '(unknown)'));
      } else if (m.status === 'cancelled') {
        setStatus('');
        vlog('save cancelled');
      } else {
        setStatus('Save failed: ' + (m.message || 'unknown'));
        vlog('save error: ' + (m.message || 'unknown'));
      }
      return;
    }

    if (m.type === 'picker-result') {
      setBusy(false);
      if (m.outcome === 'invalid') {
        setStatus('Not a valid pptx file');
      } else if (m.outcome === 'identical') {
        setStatus('Not updated \u2014 identical content');
      } else if (m.outcome === 'error') {
        setStatus('Update failed: ' + (m.message || 'unknown'));
      }
      // outcome='updated' → the extension re-renders the panel; this script
      // is about to be replaced. No status update needed here.
      return;
    }

    if (m.type === 'sync-status') {
      // The typical post-runSync path re-renders the whole webview, replacing
      // this script entirely. These messages only land if the extension chose
      // not to re-render (defensive no-currentResult case, or an error before
      // the re-render fires).
      if (m.status === 'running') {
        if (syncRunBtn) {
          syncRunBtn.disabled = true;
          syncRunBtn.textContent = 'Syncing\u2026';
        }
        setStatus('Syncing\u2026');
      } else if (m.status === 'done') {
        setBusy(false);
        setStatus(m.failed ? 'Sync partially failed' : 'Synced');
        if (syncRunBtn) {
          syncRunBtn.disabled = true;
          syncRunBtn.textContent = 'Run Sync';
        }
      } else if (m.status === 'error') {
        setBusy(false);
        setStatus('Sync failed: ' + (m.message || 'unknown'));
        if (syncRunBtn) {
          syncRunBtn.disabled = false;
          syncRunBtn.textContent = 'Run Sync';
        }
        if (syncRunHint) syncRunHint.textContent = '';
      }
      return;
    }

    if (m.type === 'drop-result') {
      setBusy(false);
      if (m.outcome === 'invalid') {
        setStatus('Dropped file is not a valid pptx');
        return;
      }
      if (m.outcome === 'error') {
        setStatus('Update failed: ' + (m.message || 'unknown'));
        return;
      }
      if (m.outcome === 'identical' && typeof m.modalHtml === 'string') {
        setStatus('');
        openModal(m.modalHtml);
        return;
      }
      if (m.outcome === 'different' && typeof m.modalHtml === 'string') {
        setStatus('');
        openModal(m.modalHtml);
        return;
      }
      // outcome='updated' → panel re-render; nothing more to do.
      return;
    }
  });
})();`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function css(): string {
  return `
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family, system-ui);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.5;
    }
    main { max-width: 900px; margin: 0 auto; padding: 24px; }
    h1 {
      font-size: 1.4em;
      margin: 0 0 16px;
      word-break: break-all;
    }
    /* Thumbnail styling:
       - max-width:100% keeps the image from overflowing the panel on narrow widths.
       - height:auto preserves the aspect ratio while max-width shrinks it.
       - max-height clamps very tall thumbnails (rare, but Office can produce them).
       - The subtle border + radius matches the rest of the panel's chrome and
         keeps a near-white slide image from bleeding into a light theme background.
    */
    .thumbnail {
      display: block;
      max-width: 100%;
      max-height: 360px;
      height: auto;
      margin: 0 0 16px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 4px;
      background: var(--vscode-editor-background);
    }
    h2 {
      font-size: 1.05em;
      margin: 24px 0 8px;
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    .path {
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
      word-break: break-all;
      margin-top: -8px;
    }
    .banner {
      padding: 8px 12px;
      border-radius: 4px;
      margin: 12px 0;
    }
    .banner.warn {
      background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
      border-left: 3px solid var(--vscode-errorForeground);
      color: var(--vscode-foreground);
    }
    .banner.info {
      background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 10%, transparent);
      border-left: 3px solid var(--vscode-charts-blue, #3794ff);
      color: var(--vscode-foreground);
    }

    /* Metadata: 2-col grid (label | value). 'auto 1fr' = label hugs content, value fills. */
    dl.meta {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 4px 16px;
      margin: 0;
    }
    dl.meta .row {
      display: contents; /* lets <dt>/<dd> participate directly in the grid */
    }
    dl.meta dt {
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    dl.meta dd {
      margin: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      word-break: break-all;
    }

    /* Validation flags. Each row is a flexbox with a status pill + label + detail. */
    ul.flags {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .flag {
      display: grid;
      grid-template-columns: max-content max-content 1fr;
      gap: 12px;
      align-items: baseline;
      padding: 8px 12px;
      border-radius: 4px;
      border-left: 3px solid transparent;
    }
    .flag.pass {
      background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
      border-left-color: var(--vscode-charts-green, #4caf50);
    }
    .flag.warn {
      background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent);
      border-left-color: var(--vscode-errorForeground);
    }
    .pill {
      font-size: 0.75em;
      font-weight: 700;
      letter-spacing: 0.05em;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .flag.pass .pill {
      background: var(--vscode-charts-green, #4caf50);
      color: var(--vscode-editor-background);
    }
    .flag.warn .pill {
      background: var(--vscode-errorForeground);
      color: var(--vscode-editor-background);
    }
    .label { font-weight: 600; }
    .detail { color: var(--vscode-descriptionForeground); }

    /* Action row (Save As + Update + transient status text).
       - flex with align-items:center keeps the status text vertically centred on the button.
       - --vscode-button-* matches VS Code's primary-button styling across themes,
         so the button looks native rather than bolted on. */
    .actions {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 0 0 16px;
      flex-wrap: wrap;
    }
    .action-btn {
      font-family: inherit;
      font-size: inherit;
      padding: 6px 14px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid transparent;
      border-radius: 2px;
      cursor: pointer;
    }
    .action-btn:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    .action-btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .action-btn:disabled {
      opacity: 0.6;
      cursor: default;
    }
    /* Secondary variant for Update — same shape, muted palette so Save As
       reads as the primary action. */
    .action-btn-secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border-color: var(--vscode-panel-border, rgba(128,128,128,0.4));
    }
    .action-btn-secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground, color-mix(in srgb, var(--vscode-foreground) 8%, transparent));
    }
    .action-status {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }

    /* ----- Sync target section ------------------------------------------- */
    /* The section reuses the plan-content selectors emitted by
       src/sync/planHtml.ts when the file is in a source-covered folder, plus
       lightweight banners for the uncovered/orphan/error states. */
    .sync-banner {
      padding: 10px 12px;
      border-radius: 4px;
      border-left: 3px solid var(--vscode-charts-blue, #3794ff);
      background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 10%, transparent);
      color: var(--vscode-foreground);
    }
    .sync-banner.muted {
      border-left-color: var(--vscode-panel-border, rgba(128,128,128,0.5));
      background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
      color: var(--vscode-descriptionForeground);
    }
    .sync-attribution {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
      margin: 0 0 8px;
    }
    .sync-attribution code {
      font-family: var(--vscode-editor-font-family, monospace);
      background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
      padding: 0 4px;
      border-radius: 3px;
    }
    /* Per-file Run Sync action row inside the Sync target section. Mirrors
       the admin/config editor's Run Sync visually so all three surfaces feel
       like siblings — green button, descriptive hint to its right. */
    .sync-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
      flex-wrap: wrap;
    }
    .sync-run-btn {
      background: var(--vscode-charts-green, #4caf50);
      color: #fff;
      border-color: transparent;
    }
    .sync-run-btn:hover:not(:disabled) {
      background: var(--vscode-charts-green, #4caf50);
      filter: brightness(1.1);
    }
    .sync-run-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    ${syncPlanEmbedCss()}

    /* ----- Drag-and-drop overlay ----------------------------------------- */
    .drop-overlay {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--vscode-focusBorder, #0e639c) 18%, transparent);
      pointer-events: none; /* the drop event still fires on window */
      z-index: 900;
    }
    .drop-overlay.open { display: flex; }
    .drop-overlay-inner {
      padding: 16px 24px;
      border: 2px dashed var(--vscode-focusBorder, #0e639c);
      border-radius: 6px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      text-align: center;
    }
    .drop-overlay-title {
      font-weight: 600;
      margin-bottom: 6px;
    }
    .drop-overlay-sub {
      font-weight: 400;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    /* kbd pill — mimics VS Code's keybinding affordance so the Shift hint
       reads as a key rather than a word. */
    .drop-overlay-sub kbd {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
      padding: 1px 6px;
      border-radius: 3px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.4));
      background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
      color: var(--vscode-foreground);
    }

    /* ----- Modal overlay (compare / identical) --------------------------- */
    ${compareModalCss()}
  `;
}

/**
 * Minimal subset of the plan-view CSS needed when embedding plan markup into
 * the viewer's Sync target section. Keeps the rules colocated so the viewer
 * has no runtime import-cycle risk with planHtml.ts (which is otherwise a
 * sibling pure module). Mirrors `planContentCss()` from planHtml.ts; if the
 * two drift far apart we can swap to importing `planContentStyles()` from
 * planHtml directly.
 */
function syncPlanEmbedCss(): string {
  return `
    .sync-target .pair {
      margin: 8px 0;
      padding: 10px 14px;
      border-left: 3px solid var(--vscode-panel-border, rgba(128,128,128,0.4));
      background: color-mix(in srgb, var(--vscode-foreground) 3%, transparent);
      border-radius: 0 4px 4px 0;
    }
    .sync-target .pair-head {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: baseline;
      margin-bottom: 6px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .sync-target .pair-head .src { font-weight: 600; }
    .sync-target .pair-head .arrow,
    .sync-target .pair-head .dst { color: var(--vscode-descriptionForeground); }
    .sync-target .sec {
      margin: 6px 0;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 4px;
      background: var(--vscode-editor-background);
    }
    .sync-target .sec summary {
      list-style: none;
      cursor: pointer;
      padding: 5px 10px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      user-select: none;
    }
    .sync-target .sec summary::-webkit-details-marker { display: none; }
    .sync-target .sec summary::before {
      content: '\u25B6';
      font-size: 0.75em;
      color: var(--vscode-descriptionForeground);
      transition: transform 0.12s ease;
    }
    .sync-target .sec[open] summary::before { transform: rotate(90deg); }
    .sync-target .sec-block summary { color: var(--vscode-errorForeground); }
    .sync-target .sec-count {
      margin-left: auto;
      font-weight: 400;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .sync-target ul.rows {
      list-style: none;
      margin: 0;
      padding: 4px 10px 10px;
    }
    .sync-target ul.rows .row {
      display: grid;
      grid-template-columns: 1fr max-content max-content;
      gap: 12px;
      align-items: baseline;
      padding: 2px 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
    }
    .sync-target ul.rows .path { word-break: break-all; }
    .sync-target ul.rows .size,
    .sync-target ul.rows .hashes {
      color: var(--vscode-descriptionForeground);
    }
    .sync-target .banner.ok   { background: color-mix(in srgb, var(--vscode-charts-green, #4caf50) 10%, transparent); border-left-color: var(--vscode-charts-green, #4caf50); }
  `;
}
