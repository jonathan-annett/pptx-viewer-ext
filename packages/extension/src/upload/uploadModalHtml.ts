// Pure HTML renderer for the Upload-to-Update modal.
//
// The modal lives inside the existing viewer webview's .modal-host overlay
// (same container the PDF-import and compare modals use). The renderer is
// pure — same inputs in, same string out, no DOM dependency. Snapshot-style
// structural tests in test/upload-modal-html.test.ts.
//
// Why a discriminated union on `phase`:
//   The modal is a state machine driven by inbound WS frames. Each phase
//   shows a distinct visual layout — QR code while waiting, progress bars
//   while uploading/applying, error text on failure. Folding all of that
//   into a single "props" bag would force every consumer to know about
//   every field; the discriminated union makes the wiring side (M5) thread
//   the relevant frame straight into a `UploadModalState` without bookkeeping.
//
// CSS is exported separately from `uploadModalCss()` and concatenated into
// the viewer's main <style> block at render time (same pattern as
// pdfImportConfigCss / compareModalCss).
//
// All inline scripts that act on this modal are nonced from the parent
// viewerScript() in webview.ts and registered there by element id — no
// script tags inside this HTML.

export type UploadModalState =
  /** WS opening, no `code` reply yet. */
  | { phase: 'connecting' }
  /**
   * Code received, waiting for the phone to upload. This is the "happy
   * path" landing screen — QR + URL + code + countdown to TTL, plus an
   * OTP entry box that the desktop user fills in by reading the 6-digit
   * code off the phone's screen.
   *
   * `otpStatus` is the per-render snapshot of the OTP handshake with the
   * server:
   *   - 'pending': haven't sent SHA(otp) yet. Input box is editable; phone
   *     uploads will be 403'd by the server until we send.
   *   - 'sent':    sent {type:'otp'} over WS, awaiting otp-ack. Input is
   *     disabled to prevent double-submits.
   *   - 'accepted': otp-ack arrived. The hidden field on the phone's form
   *     either matches (upload proceeds) or doesn't (server keeps refusing
   *     and the phone retries). Input is replaced with a "locked" badge.
   *   - 'rejected': sub-state we don't actually reach today — the server
   *     doesn't tell us about hash mismatches (intentional, to avoid
   *     noisy WS frames mid-typing); included for future use if/when the
   *     server gains an explicit "OTP mismatch" notification.
   */
  | {
      phase: 'waiting';
      code: string;
      url: string;
      qrSvg: string;
      /** ISO-8601 instant; the countdown is computed against `nowMs`. */
      expiresAt: string;
      otpStatus: 'pending' | 'sent' | 'accepted' | 'rejected';
      /**
       * Local-side OTP-handling error. Populated when the user typed a
       * non-numeric / wrong-length OTP into the input. Distinct from a
       * server-side rejection (which we currently don't surface).
       */
      otpError?: string;
    }
  /**
   * Phone is uploading to the server. Driven by `upload-progress` frames.
   * `sizeBytes: null` means the uploader didn't send Content-Length —
   * we show a bytes-received counter without a denominator.
   */
  | {
      phase: 'uploading';
      bytesReceived: number;
      sizeBytes: number | null;
    }
  /**
   * Server has the full file and is relaying it back over the WS. Driven
   * by accumulator state inside the extension host (chunk count + size).
   * `totalBytes` comes from `upload-start.sizeBytes`.
   */
  | {
      phase: 'applying';
      bytesApplied: number;
      totalBytes: number;
    }
  /** TTL elapsed without an upload, or server sent `expired`. */
  | { phase: 'expired'; code?: string }
  /** Server sent `error`, WS dropped, or any other unrecoverable failure. */
  | { phase: 'error'; message: string }
  /** Terminal success state — kept in the union so the modal can render
   *  a brief "Done" before closing. The wiring side may skip this and
   *  dismiss the modal directly. */
  | { phase: 'done' };

export interface ModalRenderOptions {
  /** Source file the user clicked Upload to Update… on. Shown in the title
   *  and in the phone-side label. Passed through `escapeHtml` before emit. */
  fileName: string;
  /** Current state of the upload flow. */
  state: UploadModalState;
  /**
   * Current wall-clock time in epoch ms — only used when `state.phase ===
   * 'waiting'` to compute the countdown line. Optional; defaults to
   * `Date.now()` at render time, but tests pass a fixed value for stable
   * snapshots and the wiring layer may pass `Date.now()` per tick.
   */
  nowMs?: number;
}

/**
 * Returns the modal markup. Insert into the viewer's `.modal-host` div via
 * innerHTML and `.modal-host.classList.add('open')`. The caller is responsible
 * for re-rendering the *whole* modal on state changes — there is no diffing
 * here. Re-rendering is cheap and keeps the inline-script wiring trivial.
 */
export function renderUploadModalHtml(opts: ModalRenderOptions): string {
  const fileName = escapeHtml(opts.fileName);
  const body = renderBody(opts);
  return `<div class="modal upload-modal" role="dialog" aria-modal="true" aria-labelledby="upload-modal-title">
  <h2 id="upload-modal-title" class="modal-title">Upload to Update</h2>
  <p class="modal-sub">Replace <code>${fileName}</code> with a file from another device.</p>
  <div class="upload-modal-body" id="upload-modal-body">
${body}
  </div>
  <div class="modal-actions">
    <span class="modal-actions-spacer"></span>
    ${renderActions(opts.state)}
  </div>
</div>`;
}

// ───── body per-phase ───────────────────────────────────────────────────

function renderBody(opts: ModalRenderOptions): string {
  const s = opts.state;
  switch (s.phase) {
    case 'connecting':
      return `    <div class="upload-status upload-status-connecting" id="upload-status">
      <div class="upload-spinner" aria-hidden="true"></div>
      <p>Connecting to upload server…</p>
    </div>`;

    case 'waiting': {
      const now = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
      const countdown = formatCountdown(s.expiresAt, now);
      const otpBlock = renderOtpBlock(s.otpStatus, s.otpError);
      // The QR SVG comes straight from the server. The server's qrcode lib
      // emits a clean <svg> with no embedded scripts; the existing webview
      // CSP (default-src 'none'; img-src data:) means a *foreign* <img> wouldn't
      // load anyway. We inject the SVG inline with no wrapper to avoid any
      // double-frame; the .upload-qr container does the sizing via CSS.
      return `    <div class="upload-waiting" id="upload-status">
      <div class="upload-qr" aria-label="QR code containing the upload URL">
${s.qrSvg}
      </div>
      <div class="upload-waiting-text">
        <p class="upload-code-line">
          <span class="upload-code-label">Code</span>
          <span class="upload-code" id="upload-code">${escapeHtml(s.code)}</span>
        </p>
        <p class="upload-url-line">
          <a class="upload-url" id="upload-url" href="${escapeAttr(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.url)}</a>
          <button type="button" class="upload-copy-btn" id="upload-copy-btn" aria-label="Copy URL">Copy</button>
        </p>
        <p class="upload-countdown" id="upload-countdown">${escapeHtml(countdown)}</p>
${otpBlock}
      </div>
    </div>`;
    }

    case 'uploading': {
      const pct = progressPercent(s.bytesReceived, s.sizeBytes);
      const sizeLine = s.sizeBytes === null
        ? `${formatBytes(s.bytesReceived)} received`
        : `${formatBytes(s.bytesReceived)} / ${formatBytes(s.sizeBytes)}`;
      return `    <div class="upload-progress-block" id="upload-status">
      <p class="upload-progress-label">Receiving from phone…</p>
      ${renderProgressBar('upload-progress-bar', pct, s.sizeBytes === null)}
      <p class="upload-progress-numbers" id="upload-progress-numbers">${escapeHtml(sizeLine)}</p>
    </div>`;
    }

    case 'applying': {
      const pct = progressPercent(s.bytesApplied, s.totalBytes);
      const sizeLine = `${formatBytes(s.bytesApplied)} / ${formatBytes(s.totalBytes)}`;
      return `    <div class="upload-progress-block" id="upload-status">
      <p class="upload-progress-label">Applying…</p>
      ${renderProgressBar('upload-apply-bar', pct, false)}
      <p class="upload-progress-numbers" id="upload-apply-numbers">${escapeHtml(sizeLine)}</p>
    </div>`;
    }

    case 'expired':
      return `    <div class="upload-status upload-status-expired" id="upload-status">
      <p class="upload-status-headline">Code expired</p>
      <p>The 10-minute window passed without an upload. Start a fresh session and try again.</p>
    </div>`;

    case 'error':
      return `    <div class="upload-status upload-status-error" id="upload-status">
      <p class="upload-status-headline">Upload failed</p>
      <p class="upload-error-message">${escapeHtml(s.message)}</p>
    </div>`;

    case 'done':
      return `    <div class="upload-status upload-status-done" id="upload-status">
      <p class="upload-status-headline">Done</p>
      <p>File received. Updating the viewer…</p>
    </div>`;
  }
}

// ───── OTP entry block (rendered inside `waiting`) ─────────────────────
//
// Layout choices:
//   - inputmode="numeric" + autocomplete="one-time-code" so phone keyboards
//     pop the number row by default. (The desktop user is still typing — the
//     attributes don't hurt anything there.)
//   - maxlength=6 + pattern enforced in JS in webview.ts; we also do a
//     server-equivalent format check in uploadFlow before hashing.
//   - The submit button is a sibling, not a wrapper <form> — we don't want
//     an accidental Enter press to submit a hypothetical outer form. The
//     inline-script wiring (webview.ts) adds an Enter-to-submit handler on
//     the input itself.
//
// `accepted` collapses the block to a tiny "locked" badge instead of the
// whole input + button surface, freeing up vertical space for the QR/code
// section. The wiring code never transitions back from `accepted` to
// `pending` in the same modal lifetime.

function renderOtpBlock(
  status: 'pending' | 'sent' | 'accepted' | 'rejected',
  error?: string,
): string {
  if (status === 'accepted') {
    return `        <p class="upload-otp upload-otp-accepted" id="upload-otp-block">
          <span class="upload-otp-badge" aria-hidden="true">✓</span>
          Code locked in — waiting for the upload from the phone.
        </p>`;
  }
  const disabled = status === 'sent' ? ' disabled' : '';
  const btnDisabled = status === 'sent' ? ' disabled' : '';
  const hint = status === 'sent'
    ? `Sending…`
    : `The phone is showing a 6-digit code. Type it here so the upload can be relayed back.`;
  const errLine = error
    ? `<p class="upload-otp-error" id="upload-otp-error">${escapeHtml(error)}</p>`
    : ``;
  return `        <div class="upload-otp" id="upload-otp-block">
          <label class="upload-otp-label" for="upload-otp-input">One-time code from the phone</label>
          <div class="upload-otp-row">
            <input
              type="text"
              id="upload-otp-input"
              class="upload-otp-input"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              pattern="[0-9]{6}"
              placeholder="······"${disabled}
              aria-describedby="upload-otp-hint">
            <button type="button" class="action-btn" id="upload-otp-submit-btn"${btnDisabled}>Confirm</button>
          </div>
          <p class="upload-otp-hint" id="upload-otp-hint">${escapeHtml(hint)}</p>
          ${errLine}
        </div>`;
}

// ───── action buttons per-phase ────────────────────────────────────────
//
// Cancel is always present except in `done`. Retry only appears in terminal
// failure states. Ids are stable so the inline-script wiring in webview.ts
// can attach handlers via getElementById.

function renderActions(state: UploadModalState): string {
  switch (state.phase) {
    case 'connecting':
    case 'waiting':
    case 'uploading':
    case 'applying':
      return `<button type="button" class="action-btn action-btn-secondary" id="upload-cancel-btn">Cancel</button>`;

    case 'expired':
    case 'error':
      return `<button type="button" class="action-btn action-btn-secondary" id="upload-close-btn">Close</button>
    <button type="button" class="action-btn" id="upload-retry-btn">Try again</button>`;

    case 'done':
      // No buttons — the wiring layer dismisses the modal once the host
      // finishes feeding bytes through the ingest pipeline.
      return ``;
  }
}

// ───── helpers ──────────────────────────────────────────────────────────

/**
 * Render a progress bar. `indeterminate` (no Content-Length on the upload)
 * just leaves the percent line off the bar; the bar still animates via the
 * CSS rule on `.upload-bar-indeterminate`.
 */
function renderProgressBar(id: string, pct: number, indeterminate: boolean): string {
  if (indeterminate) {
    return `<div class="upload-bar upload-bar-indeterminate" id="${id}" role="progressbar" aria-valuemin="0" aria-valuemax="100"><span class="upload-bar-fill"></span></div>`;
  }
  return `<div class="upload-bar" id="${id}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span class="upload-bar-fill" style="width: ${pct}%"></span></div>`;
}

/**
 * Format remaining time as either "9:42" or "0:08". Negative or invalid
 * deltas show "0:00" rather than a dash; the wiring layer should already
 * have transitioned to `expired` by then but a brief mismatch is
 * harmless visually.
 */
export function formatCountdown(expiresAt: string, nowMs: number): string {
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return 'expires soon';
  const remainMs = Math.max(0, t - nowMs);
  const totalSec = Math.floor(remainMs / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `expires in ${mm}:${ss.toString().padStart(2, '0')}`;
}

/** Compute a 0–100 integer percentage, guarding zero/null denominators. */
export function progressPercent(numer: number, denom: number | null): number {
  if (denom === null || denom === undefined || denom <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((numer / denom) * 100)));
}

/**
 * Human-readable byte size. Picks the largest unit that keeps the value ≥1.
 * Always 1 decimal place for KB and up, no decimal for bytes.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
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
  return escapeHtml(s);
}

// ───── styles ───────────────────────────────────────────────────────────

/**
 * CSS for the upload modal. Concatenate with the existing modal CSS rules
 * already provided by webview.ts (compareModalCss + pdfImportConfigCss).
 *
 * The QR container is sized in CSS so we don't depend on the server's SVG
 * having any particular viewBox / width attributes (it does, but treating
 * the SVG as content-shaped rather than fixed-pixel-shaped lets the modal
 * scale gracefully on narrow viewports).
 */
export function uploadModalCss(): string {
  return `
    .upload-modal {
      max-width: 560px;
    }
    .upload-modal-body {
      min-height: 220px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 8px 0 16px;
    }
    /* "Connecting…" — a centred spinner with copy underneath. */
    .upload-status {
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .upload-status-headline {
      font-weight: 600;
      color: var(--vscode-foreground);
      margin: 0 0 6px;
    }
    .upload-spinner {
      width: 28px;
      height: 28px;
      border: 3px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-top-color: var(--vscode-charts-blue, #2196f3);
      border-radius: 50%;
      margin: 0 auto 12px;
      animation: upload-spin 0.9s linear infinite;
    }
    @keyframes upload-spin {
      to { transform: rotate(360deg); }
    }
    /* "Waiting" layout — QR on the left, text on the right. Collapses to a
       single column under ~440px so the QR doesn't get squeezed unreadably
       small. */
    .upload-waiting {
      display: grid;
      grid-template-columns: 200px 1fr;
      gap: 18px;
      align-items: start;
    }
    @media (max-width: 480px) {
      .upload-waiting {
        grid-template-columns: 1fr;
        justify-items: center;
        text-align: center;
      }
    }
    .upload-qr {
      width: 200px;
      height: 200px;
      background: #ffffff;
      padding: 8px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 0 1px var(--vscode-panel-border, rgba(128,128,128,0.3));
    }
    .upload-qr svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .upload-waiting-text {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .upload-code-line {
      margin: 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .upload-code-label {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .upload-code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 1.6em;
      font-weight: 600;
      letter-spacing: 0.15em;
    }
    .upload-url-line {
      margin: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .upload-url {
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-textLink-foreground);
      word-break: break-all;
    }
    .upload-copy-btn {
      background: transparent;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 3px;
      color: var(--vscode-foreground);
      cursor: pointer;
      font: inherit;
      padding: 2px 8px;
    }
    .upload-copy-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15));
    }
    .upload-countdown {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
    }
    .upload-hint {
      margin: 0;
      font-size: 0.92em;
      color: var(--vscode-descriptionForeground);
    }
    /* Progress block — used for both 'uploading' (phone → server) and
       'applying' (server → us). The bar is the same visual; only the label
       and id differ. */
    .upload-progress-block {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 16px 0;
    }
    .upload-progress-label {
      margin: 0;
      color: var(--vscode-foreground);
      font-weight: 600;
    }
    .upload-progress-numbers {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
    }
    .upload-bar {
      position: relative;
      height: 8px;
      width: 100%;
      background: var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 4px;
      overflow: hidden;
    }
    .upload-bar-fill {
      display: block;
      height: 100%;
      width: 0%;
      background: var(--vscode-charts-blue, #2196f3);
      transition: width 120ms linear;
    }
    /* Indeterminate state — Content-Length missing. A 30%-wide strip slides
       back and forth so the user sees movement even when the percentage
       can't be computed. */
    .upload-bar-indeterminate .upload-bar-fill {
      width: 30%;
      animation: upload-bar-indet 1.4s ease-in-out infinite;
    }
    @keyframes upload-bar-indet {
      0%   { transform: translateX(-100%); }
      100% { transform: translateX(333%); }
    }
    .upload-status-error .upload-error-message {
      color: var(--vscode-errorForeground);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
    }
    /* OTP block — lives at the bottom of the waiting layout's right column.
       margin-top:6px puts a small visual gap below the countdown without
       cramming up against it. The accepted state collapses to a single line. */
    .upload-otp {
      margin-top: 6px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .upload-otp-accepted {
      color: var(--vscode-charts-green, #4caf50);
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 6px 0 0;
    }
    .upload-otp-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--vscode-charts-green, #4caf50);
      color: var(--vscode-editor-background, #fff);
      font-size: 0.85em;
      font-weight: 700;
    }
    .upload-otp-label {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .upload-otp-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .upload-otp-input {
      flex: 1;
      min-width: 0;
      font: inherit;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 1.25em;
      letter-spacing: 0.3em;
      text-align: center;
      padding: 4px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.4)));
      border-radius: 3px;
    }
    .upload-otp-input:focus {
      outline: 1px solid var(--vscode-focusBorder, #007fd4);
      outline-offset: -1px;
    }
    .upload-otp-input:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .upload-otp-hint {
      margin: 0;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    .upload-otp-error {
      margin: 0;
      font-size: 0.85em;
      color: var(--vscode-errorForeground);
    }
  `;
}
