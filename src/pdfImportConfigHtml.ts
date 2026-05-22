// Pure HTML renderer for the PDF → PPTX import config modal.
//
// Lives in the viewer webview as a modal panel (re-uses the existing
// .modal-host container). The user lands here after dropping a .pdf onto the
// viewer or picking a PDF via Update… — Phase D wires that path. The renderer
// is pure: same inputs in, same string out, no DOM dependency. Snapshot tests
// in test/pdf-import-config-html.test.ts assert structural properties of the
// emitted markup.
//
// CSS lives in the exported `pdfImportConfigCss()` function and is
// concatenated into the viewer's main <style> block at render time (same
// pattern as compareModalHtml.ts).
//
// All inline scripts that act on this modal are nonced from the parent
// viewerScript() and registered there by element id — no script tags inside
// this HTML.

export type AspectChoice = '16:9' | '4:3';
export type FormatChoice = 'png' | 'jpeg';

export interface PdfImportConfig {
  /** Slide aspect ratio. 16:9 is the modern PowerPoint default. */
  aspect: AspectChoice;
  /**
   * Long-edge target pixel width — how many pixels the slide's long edge
   * should occupy at "fill" density. 1920 is HD; 2560 ≈ QHD; 3840 ≈ 4K.
   * Picking a number larger than the display can show wastes file size; we
   * surface the device's own width as a 4th choice in the rendered control.
   */
  resolution: number;
  /** When true, fit page in slide preserving aspect; when false, stretch. */
  letterbox: boolean;
  /** Image format inside the .pptx. PNG = lossless, JPEG = much smaller. */
  format: FormatChoice;
  /** JPEG quality 0..1. Ignored when format='png'. */
  quality: number;
}

export const DEFAULT_PDF_IMPORT_CONFIG: PdfImportConfig = {
  aspect: '16:9',
  resolution: 1920,
  letterbox: true,
  format: 'jpeg',
  quality: 0.85,
};

/**
 * Discrete resolution presets surfaced in the UI. The "device" choice resolves
 * to `window.screen.width * devicePixelRatio` at render time on the webview
 * side; this list is what the markup hardcodes.
 */
export const RESOLUTION_PRESETS = [1280, 1920, 2560, 3840] as const;

export interface ConfigRenderOptions {
  /** Source PDF file name (escaped before emit; pass the raw name). */
  fileName: string;
  /** Number of pages parsed from the PDF — undefined while the first
   *  render is still in flight. */
  pageCount?: number;
  /**
   * One-line status string shown in the status row. Examples:
   *   "Rendering page 4 of 12…"
   *   "12 pages • 1920×1080 • JPEG q=85 — 4.2 MB"
   *   "Encoding…"
   * Pass empty string to suppress the row.
   */
  status?: string;
  /** Current config — drives which radios/sliders are pre-selected. */
  config?: PdfImportConfig;
  /** Disable the Re-render button (e.g. while a render is in progress, or
   *  when res/aspect hasn't changed since the last render). */
  rerenderDisabled?: boolean;
  /** Disable the Import button (while rendering/encoding, or when no pages
   *  have been encoded yet). */
  importDisabled?: boolean;
  /**
   * The device's effective pixel width (CSS screen × dPR). When present, a
   * "Device" preset is shown alongside the fixed numeric presets, rendered
   * as e.g. "Device (2560)". When omitted, the device row is hidden.
   */
  devicePxW?: number;
}

/**
 * Returns the modal markup. Insert into the viewer's `.modal-host` div via
 * innerHTML and `.modal-host.classList.add('open')`.
 */
export function renderPdfImportConfigHtml(opts: ConfigRenderOptions): string {
  const cfg = { ...DEFAULT_PDF_IMPORT_CONFIG, ...(opts.config ?? {}) };
  const fileName = escapeHtml(opts.fileName);
  const status = opts.status ?? '';
  const pageCountLine =
    typeof opts.pageCount === 'number'
      ? `<p class="modal-sub">${opts.pageCount} page${opts.pageCount === 1 ? '' : 's'} from <code>${fileName}</code></p>`
      : `<p class="modal-sub">Reading <code>${fileName}</code>…</p>`;

  return `<div class="modal pdf-import-modal" role="dialog" aria-modal="true" aria-labelledby="pdf-import-title">
  <h2 id="pdf-import-title" class="modal-title">Import PDF as PPTX</h2>
  ${pageCountLine}
  <form class="pdf-import-form" onsubmit="return false">
    <fieldset class="pdf-import-field">
      <legend>Slide aspect</legend>
      ${renderRadioGroup('pdfimport-aspect', [
        ['16:9', '16:9 widescreen', cfg.aspect === '16:9'],
        ['4:3', '4:3 standard', cfg.aspect === '4:3'],
      ])}
    </fieldset>

    <fieldset class="pdf-import-field">
      <legend>Resolution <span class="pdf-import-hint">long-edge pixels</span></legend>
      ${renderResolutionRadios(cfg.resolution, opts.devicePxW)}
    </fieldset>

    <fieldset class="pdf-import-field">
      <legend>Fit</legend>
      ${renderRadioGroup('pdfimport-fit', [
        ['letterbox', 'Letterbox (preserve page aspect)', cfg.letterbox],
        ['stretch', 'Stretch (fill slide)', !cfg.letterbox],
      ])}
    </fieldset>

    <fieldset class="pdf-import-field">
      <legend>Image format</legend>
      ${renderRadioGroup('pdfimport-format', [
        ['jpeg', 'JPEG (small)', cfg.format === 'jpeg'],
        ['png', 'PNG (lossless)', cfg.format === 'png'],
      ])}
      <div class="pdf-import-quality${cfg.format === 'jpeg' ? '' : ' pdf-import-quality-hidden'}">
        <label for="pdfimport-quality">JPEG quality
          <span id="pdfimport-quality-value">${Math.round(cfg.quality * 100)}%</span>
        </label>
        <input type="range" id="pdfimport-quality" min="0.1" max="1" step="0.05" value="${cfg.quality}">
      </div>
    </fieldset>

    <div class="pdf-import-status" id="pdfimport-status">${escapeHtml(status)}</div>
  </form>

  <div class="modal-actions">
    <span class="modal-actions-spacer"></span>
    <button type="button" class="action-btn action-btn-secondary" id="pdfimport-cancel-btn">Cancel</button>
    <button type="button" class="action-btn action-btn-secondary" id="pdfimport-rerender-btn"${opts.rerenderDisabled ? ' disabled' : ''}>Re-render</button>
    <button type="button" class="action-btn" id="pdfimport-import-btn"${opts.importDisabled ? ' disabled' : ''}>Import</button>
  </div>
</div>`;
}

// ───── pieces ───────────────────────────────────────────────────────────

function renderRadioGroup(
  name: string,
  options: Array<[value: string, label: string, checked: boolean]>,
): string {
  return `<div class="pdf-import-radios">
        ${options
          .map(
            ([value, label, checked]) => `<label class="pdf-import-radio">
          <input type="radio" name="${name}" value="${escapeAttr(value)}"${checked ? ' checked' : ''}>
          <span>${escapeHtml(label)}</span>
        </label>`,
          )
          .join('\n        ')}
      </div>`;
}

function renderResolutionRadios(current: number, devicePxW?: number): string {
  const presets = RESOLUTION_PRESETS.map((px) => ({
    value: String(px),
    label: `${px}px`,
    checked: current === px,
  }));
  // Add the device preset only if we have a value, and only if it's not
  // already in the fixed list (so we don't show "Device (1920)" alongside the
  // bare 1920 button).
  const showDevice =
    typeof devicePxW === 'number' &&
    devicePxW > 0 &&
    !RESOLUTION_PRESETS.includes(devicePxW as (typeof RESOLUTION_PRESETS)[number]);
  if (showDevice) {
    presets.push({
      value: String(devicePxW),
      label: `Device (${devicePxW}px)`,
      checked: current === devicePxW,
    });
  }
  // If `current` matches none of the preset values, the markup leaves the
  // group with nothing checked — Phase D's wiring can choose to snap to the
  // nearest preset in that case.
  return `<div class="pdf-import-radios">
        ${presets
          .map(
            (p) => `<label class="pdf-import-radio">
          <input type="radio" name="pdfimport-resolution" value="${escapeAttr(p.value)}"${p.checked ? ' checked' : ''}>
          <span>${escapeHtml(p.label)}</span>
        </label>`,
          )
          .join('\n        ')}
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

function escapeAttr(s: string): string {
  // Same set as escapeHtml — attribute values are HTML-encoded the same way
  // when the attribute is double-quoted (which all of ours are).
  return escapeHtml(s);
}

// ───── styles ───────────────────────────────────────────────────────────

/**
 * CSS for the PDF import config modal. Concatenate with the existing
 * compareModalCss() in the main viewer <style> block. Relies on the .modal /
 * .modal-actions rules already provided by that file.
 */
export function pdfImportConfigCss(): string {
  return `
    .pdf-import-modal {
      max-width: 560px;
    }
    /* The form uses a vertical stack of fieldsets so the user reads top-down.
       Each fieldset gets a flat hairline border (vscode-panel-border) instead
       of the browser's stock 3-D groove — feels more in keeping with the rest
       of the UI. */
    .pdf-import-form {
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .pdf-import-field {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 4px;
      padding: 8px 12px 10px;
      margin: 0;
    }
    .pdf-import-field legend {
      padding: 0 6px;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .pdf-import-hint {
      text-transform: none;
      letter-spacing: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 0.95em;
      margin-left: 6px;
      opacity: 0.7;
    }
    /* Inline-flex wrap so radios sit on one line when there's space, but
       fall to a second row gracefully on narrow viewports. */
    .pdf-import-radios {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 14px;
    }
    .pdf-import-radio {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      user-select: none;
    }
    .pdf-import-radio input[type="radio"] {
      margin: 0;
      cursor: pointer;
      accent-color: var(--vscode-charts-blue, #2196f3);
    }
    .pdf-import-quality {
      margin-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    /* Use visibility:hidden + height:0 rather than display:none so the
       layout doesn't shift when toggling JPEG↔PNG. */
    .pdf-import-quality-hidden {
      visibility: hidden;
      height: 0;
      margin-top: 0;
      overflow: hidden;
    }
    .pdf-import-quality label {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.92em;
      color: var(--vscode-foreground);
    }
    .pdf-import-quality input[type="range"] {
      width: 100%;
      accent-color: var(--vscode-charts-blue, #2196f3);
    }
    .pdf-import-status {
      min-height: 1.4em;
      padding: 6px 0 0;
      color: var(--vscode-descriptionForeground);
      font-size: 0.92em;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .pdf-import-status:empty { display: none; }
  `;
}
