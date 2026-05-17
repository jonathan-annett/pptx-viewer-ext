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

import type { Flag, MediaEntry, ParseResult } from './pptx';

export function renderHtml(r: ParseResult, nonce: string): string {
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
      <button id="download-btn" class="action-btn" type="button">Download</button>
      <span id="download-status" class="action-status" aria-live="polite"></span>
    </div>
    ${thumbnailImg(r)}
    ${errorBanner}

    <section>
      <h2>Metadata</h2>
      <dl class="meta">
        ${metadataRows.map(([k, v]) => row(k, v)).join('\n')}
      </dl>
    </section>

    <section>
      <h2>Validation</h2>
      <ul class="flags">
        ${flagLi(r.flags.linkedMedia)}
        ${flagLi(r.flags.showType)}
        ${flagLi(r.flags.showMediaControls)}
      </ul>
    </section>
  </main>
  <script nonce="${nonce}">${downloadScript(r.fileName)}</script>
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

// Webview-side download flow:
//   click   → postMessage({type:'download'}) to extension
//   extension reads bytes, base64-encodes, posts {type:'bytes', base64, byteLength}
//   webview decodes base64 → Uint8Array → Blob → <a download> click
//   browser handles save dialog
//
// Why base64 instead of sending the Uint8Array directly: VS Code's web webview
// postMessage path doesn't reliably preserve typed arrays — they can arrive on
// the other side as a plain {0:byte,1:byte,...} object, which makes
// `new Blob([payload])` produce "[object Object]" garbage. Base64 string is
// JSON-clean and survives any serialization layer.
//
// Every step posts a 'download-log' message back to the extension so the
// progress shows up in the Pptx Info output channel — easier than asking the
// user to open DevTools.
//
// The script is inlined as a string (not a separate file) so the bundle stays
// single-file — there's no asset-URL plumbing in this extension. The nonce in
// CSP gates execution; the file name is embedded as a JSON literal so quoting
// and unicode survive the round trip.
function downloadScript(fileName: string): string {
  return `(function(){
  const vscode = acquireVsCodeApi();
  const fileName = ${JSON.stringify(fileName)};
  const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const btn = document.getElementById('download-btn');
  const status = document.getElementById('download-status');

  function dlog(msg){
    try { vscode.postMessage({type:'download-log', message: msg}); } catch (_) {}
  }
  window.addEventListener('error', function(ev){
    dlog('window error: ' + (ev.message || ev.error || 'unknown'));
  });

  btn.addEventListener('click', function(){
    btn.disabled = true;
    status.textContent = 'Preparing…';
    dlog('click → requesting bytes');
    vscode.postMessage({type:'download'});
  });

  function base64ToBytes(b64){
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  window.addEventListener('message', function(e){
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'bytes') {
      try {
        if (typeof m.base64 !== 'string') {
          dlog('bytes message missing base64 string (typeof=' + (typeof m.base64) + ')');
          status.textContent = 'Download failed: malformed payload';
          btn.disabled = false;
          return;
        }
        dlog('received base64 (' + m.base64.length + ' chars, expecting ' + m.byteLength + ' bytes)');
        const bytes = base64ToBytes(m.base64);
        dlog('decoded ' + bytes.byteLength + ' bytes');
        const blob = new Blob([bytes], {type: PPTX_MIME});
        dlog('created blob, size=' + blob.size + ' type=' + blob.type);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
        dlog('anchor.click() dispatched');
        status.textContent = '';
        btn.disabled = false;
      } catch (err) {
        dlog('download exception: ' + (err && err.message ? err.message : String(err)));
        status.textContent = 'Download failed: ' + (err && err.message ? err.message : 'see Pptx Info');
        btn.disabled = false;
      }
    } else if (m.type === 'download-error') {
      dlog('extension error: ' + (m.message || 'unknown'));
      status.textContent = 'Download failed: ' + (m.message || 'unknown');
      btn.disabled = false;
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

    /* Action row (Download button + transient status text).
       - flex with align-items:center keeps the status text vertically centred on the button.
       - --vscode-button-* matches VS Code's primary-button styling across themes,
         so the button looks native rather than bolted on. */
    .actions {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 0 0 16px;
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
    .action-status {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
  `;
}
