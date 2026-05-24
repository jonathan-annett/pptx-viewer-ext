// Pure HTML renderer for the basic PDF viewer.
//
// The PDF viewer is a sibling of the pptx viewer: same metadata grid + a
// first-page preview rendered by pdfjs-dist inside the webview iframe. We
// reuse the existing `__PPTX_PDFIMPORT_WEBVIEW_BUNDLE_PLACEHOLDER__` so the
// same inlined pdf.js bundle that powers PDF → PPTX import also drives the
// preview here — no second webview bundle, no extra build target.
//
// Why a custom editor at all: vscode.dev's default opener for *.pdf falls
// back to the plain-text editor (PDFs surface as binary noise). The search
// panel surfaces PDFs alongside pptx files and clicking through to "binary
// gibberish" is jarring. A minimal renderer that shows page 1 + metadata
// is enough to confirm the file is what the user expected.
//
// CSP mirrors the pptx viewer: default-src 'none'; style-src 'unsafe-inline';
// img-src data:; script-src 'nonce-<random>'. The pdfjs bundle is loaded
// inline under the nonce just like the pptx viewer does.

export interface PdfViewerHtmlInput {
  fileName: string;
  size: number;
  sizeHuman: string;
  mtimeHuman: string;
  sha256: string;
  /** Per-render nonce for the CSP script-src 'nonce-...' allowance. */
  nonce: string;
}

// Placeholder string. esbuild's pdfimport-webview-bundle plugin substitutes
// the entire quoted literal (quotes included) with a JSON.stringify of the
// dist/pdfImport.webview.js source after every build. Same literal as
// src/webview.ts — keep them in sync with esbuild.config.js's
// PDF_IMPORT_BUNDLE_PLACEHOLDER.
const PDF_IMPORT_WEBVIEW_BUNDLE_PLACEHOLDER =
  '__PPTX_PDFIMPORT_WEBVIEW_BUNDLE_PLACEHOLDER__';

export function renderPdfViewerHtml(input: PdfViewerHtmlInput): string {
  const { fileName, size, sizeHuman, mtimeHuman, sha256, nonce } = input;
  const metadataRows: Array<[string, string]> = [
    ['File name', fileName],
    ['Size', `${sizeHuman} (${size.toLocaleString()} bytes)`],
    ['Modified', mtimeHuman],
    ['SHA-256', sha256],
    // Page count is filled in by the webview after the PDF parse lands; the
    // initial value is a dash so the row's layout doesn't jitter when the
    // real number arrives.
    ['Pages', '\u2014'],
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<title>${escapeHtml(fileName)}</title>
<style>${pdfViewerCss()}</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(fileName)}</h1>
    <div id="preview-wrap" class="preview-wrap">
      <div id="preview-host" class="preview-placeholder" aria-live="polite">Rendering preview\u2026</div>
    </div>
    <section>
      <h2>Metadata</h2>
      <dl class="meta">
        ${metadataRows.map(([k, v]) => row(k, v)).join('\n        ')}
      </dl>
    </section>
  </main>
  <script nonce="${nonce}">${PDF_IMPORT_WEBVIEW_BUNDLE_PLACEHOLDER}</script>
  <script nonce="${nonce}">${pdfViewerScript()}</script>
</body>
</html>`;
}

export function renderPdfViewerError(path: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>PDF error</title>
<style>${pdfViewerCss()}</style>
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

// ───── pieces ───────────────────────────────────────────────────────────

function row(key: string, value: string): string {
  // `data-row` attribute on the page row lets the inline script find and
  // update the cell when the PDF parse reports `numPages`. Avoids brittle
  // querySelector heuristics keyed off "Pages" text.
  const attr = key === 'Pages' ? ' data-row="pages"' : '';
  return `<div class="row"${attr}>
    <dt>${escapeHtml(key)}</dt>
    <dd>${escapeHtml(value)}</dd>
  </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ───── inline script ────────────────────────────────────────────────────
//
// Runs inside the webview iframe under the script-src nonce. The pdfjs
// bundle inlined just above this script puts `__pptxPdfImport` on globalThis
// — we use `renderPdfPages` for page 1 only, at a modest scale, and paint
// the resulting canvas's PNG dataURL into an <img>.
//
// We do NOT keep the canvas in the DOM. Two reasons:
//   - pdfjs-dist leaves the canvas as a live OffscreenCanvas-like surface;
//     keeping it alive holds onto the worker's render context until GC.
//   - <img src="data:"> is what the pptx viewer uses for its thumbnail, so
//     this matches that surface in look + memory profile.
function pdfViewerScript(): string {
  return `(function(){
  const vscode = acquireVsCodeApi();

  function vlog(msg){
    try { vscode.postMessage({type:'viewer-log', message: msg}); } catch (_) {}
  }

  function setPageCount(n) {
    const cell = document.querySelector('[data-row="pages"] dd');
    if (cell) cell.textContent = String(n);
  }

  function showError(msg) {
    const host = document.getElementById('preview-host');
    if (host) {
      host.className = 'preview-error';
      host.textContent = msg;
    }
  }

  function swapInImage(dataUrl) {
    const host = document.getElementById('preview-host');
    if (!host) return;
    const img = document.createElement('img');
    img.className = 'preview-img';
    img.alt = '';
    img.src = dataUrl;
    host.replaceWith(img);
  }

  // Driven by a 'pdfBytes' postMessage from the extension. We don't render
  // synchronously on load because the extension owns the bytes and posts
  // them after the panel is wired.
  async function renderFirstPage(bytes) {
    const api = window.__pptxPdfImport;
    if (!api || !api.renderPdfPages || !api.pdfjsLib) {
      showError('PDF renderer not available in this build.');
      vlog('pdf-viewer: __pptxPdfImport missing or incomplete');
      return;
    }
    try {
      // renderPdfPages renders every page. We want only page 1 here, but the
      // existing API doesn't take a page range — so we render the whole PDF
      // and pluck pages[0]. Acceptable because the viewer is read-only and
      // the user just dropped into this tab; if the PDF is huge we'd want a
      // pageRange option, but that's a future enhancement, not a blocker for
      // the first-page preview the user asked for.
      //
      // Scale 1.5 puts a standard A4 page at ~1224px wide — enough for the
      // preview to read clearly inside the panel without overrunning narrow
      // editor layouts. CSS caps the rendered <img> with max-width:100%.
      const pages = await api.renderPdfPages(bytes, {
        pdfjsLib: api.pdfjsLib,
        renderScale: 1.5,
      });
      if (!pages || pages.length === 0) {
        showError('PDF contains no pages.');
        return;
      }
      setPageCount(pages.length);
      const first = pages[0];
      const canvas = first.canvas;
      if (!canvas || typeof canvas.toDataURL !== 'function') {
        showError('PDF rendered but canvas is unavailable.');
        return;
      }
      let dataUrl;
      try {
        dataUrl = canvas.toDataURL('image/png');
      } catch (err) {
        showError('Could not convert preview to image: ' + (err && err.message || err));
        return;
      }
      swapInImage(dataUrl);
      vlog('pdf-viewer: rendered page 1 of ' + pages.length + ' (' + first.widthPx + 'x' + first.heightPx + 'px, ' + dataUrl.length + ' chars)');
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      showError('Failed to render PDF: ' + msg);
      vlog('pdf-viewer: render failed — ' + msg);
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'pdfBytes' && m.bytes) {
      // postMessage may have marshalled the Uint8Array as a plain object on
      // some hosts; the renderPdfPages helper accepts Uint8Array / ArrayBuffer
      // / Blob, so coerce to Uint8Array defensively.
      let bytes = m.bytes;
      if (!(bytes instanceof Uint8Array)) {
        if (bytes instanceof ArrayBuffer) {
          bytes = new Uint8Array(bytes);
        } else if (Array.isArray(bytes)) {
          bytes = Uint8Array.from(bytes);
        } else if (bytes && typeof bytes === 'object' && typeof bytes.length === 'number') {
          const out = new Uint8Array(bytes.length);
          for (let i = 0; i < out.length; i++) out[i] = Number(bytes[i] || 0) & 0xff;
          bytes = out;
        } else {
          showError('Unrecognised bytes payload from extension.');
          return;
        }
      }
      renderFirstPage(bytes);
    }
  });

  // Tell the extension we're listening — it'll respond with 'pdfBytes'.
  vscode.postMessage({ type: 'pdf-viewer-ready' });
})();`;
}

// ───── css ──────────────────────────────────────────────────────────────
//
// Mirrors the pptx viewer's palette and metadata grid so the two editors
// feel like siblings. The preview-host placeholder mirrors the synthesised-
// thumbnail placeholder layout from the pptx viewer (subtle theme-tinted
// box that the rendered image swaps into).
function pdfViewerCss(): string {
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
    .preview-wrap {
      margin: 0 0 16px;
    }
    /* Rendered preview image: capped at the panel width, modest max-height
       so a tall-aspect page (legal/portrait) doesn't push the metadata grid
       miles down. width:auto + height:auto lets the natural pixel size win
       up to those caps. */
    .preview-img {
      display: block;
      max-width: 100%;
      max-height: 640px;
      width: auto;
      height: auto;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 4px;
      background: var(--vscode-editor-background);
    }
    /* Placeholder shown while the pdf.js bundle is parsing + rendering. The
       16:9 ratio mostly approximates the eventual page shape; an actual A4
       portrait will reflow once it lands, which is fine. */
    .preview-placeholder, .preview-error {
      aspect-ratio: 4 / 3;
      max-width: 100%;
      max-height: 640px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 4px;
    }
    .preview-error {
      color: var(--vscode-errorForeground);
      background: color-mix(in srgb, var(--vscode-errorForeground) 8%, transparent);
      border-color: var(--vscode-errorForeground);
    }
    .banner {
      padding: 8px 12px;
      border-radius: 4px;
      margin: 12px 0;
    }
    .banner.warn {
      background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
      border-left: 3px solid var(--vscode-errorForeground);
    }
    .meta {
      display: grid;
      grid-template-columns: auto 1fr;
      column-gap: 16px;
      row-gap: 4px;
      margin: 0;
    }
    .row {
      display: contents;
    }
    .row dt {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    .row dd {
      margin: 0;
      word-break: break-all;
      font-family: var(--vscode-editor-font-family, monospace);
    }
  `;
}
