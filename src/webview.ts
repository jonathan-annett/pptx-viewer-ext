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

export function renderHtml(r: ParseResult): string {
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>${escapeHtml(r.fileName)}</title>
<style>${css()}</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(r.fileName)}</h1>
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
  `;
}
