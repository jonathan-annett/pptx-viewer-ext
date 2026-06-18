// Wired upload session — one per click of "Upload to Update…".
//
// Sits between three parties:
//   1. The webview (modal UI, which it can't drive on its own — every
//      state change is a postMessage from us into modal-host).
//   2. The UploadClient (the WS to the dropbox-server, which delivers
//      the protocol events).
//   3. The provider (which routes the delivered bytes through the existing
//      ingest pipeline once the upload completes).
//
// The flow holds the M5-shape state machine: connecting → waiting → uploading
// → applying → done, plus terminal expired/error. Every transition triggers
// a `renderUploadModalHtml()` call and a postMessage of the rendered HTML
// to the webview. The webview's only job is to drop the HTML into modal-host
// and re-bind the four well-known button ids.
//
// One UploadFlow per panel. The provider tracks the active flow and disposes
// any previous one when a new uploadOpen lands (or when the panel goes away).
// The countdown ticker is the only background timer — stopped on every state
// transition out of `waiting` plus on dispose.

import * as vscode from 'vscode';
import { log } from 'pptx-tools-core/log';
import { renderUploadModalHtml, type UploadModalState } from './uploadModalHtml';
import { UploadClient, type UploadClientEvent } from './uploadClient';
import { resolveDropboxBaseUrl } from './baseUrl';

// 200 MB is well within the user's expected pptx range and an order of
// magnitude below the server's 500 MB hard cap. Picked deliberately above
// the realistic-pptx ceiling so the server's clamp never bites in practice.
const UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
// pptx + pdf are the two affordances the viewer supports today; everything
// else would fail magic-bytes detection on the receiving side anyway.
const UPLOAD_ACCEPT = [
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/pdf',
];
// Countdown re-renders the modal once per second. Picked to match the
// resolution of formatCountdown's `m:ss` output — finer ticks would change
// nothing visible; coarser would skip seconds.
const COUNTDOWN_TICK_MS = 1000;

/**
 * Per-upload handle returned by `UploadFlow.start`. The provider invokes
 * `cancel` / `close` / `retry` from message handlers and `dispose` from
 * panel onDidDispose. All methods are idempotent.
 */
export interface UploadFlowHandle {
  cancel(): void;
  close(): void;
  retry(): void;
  /**
   * Submit a 6-digit OTP from the modal input. The OTP is the code the
   * phone has invented and displayed on its upload form; the desktop user
   * reads it off the phone's screen and types it here. We SHA-256 it and
   * send the hash to the server, which then gates the relay on the phone
   * presenting the same hash in its multipart form. Surfacing the hashing
   * here (rather than in webview JS) keeps the secret out of the webview's
   * postMessage trail.
   *
   * No-op if the flow has already moved past `waiting`. Local validation
   * failures (non-numeric / wrong length) re-render the waiting state with
   * an inline error rather than transitioning to the global `error` phase.
   */
  submitOtp(otp: string): void;
  dispose(): void;
}

export interface UploadFlowOptions {
  webviewPanel: vscode.WebviewPanel;
  /** Display name shown in the modal title + sent to the server as `label`. */
  fileName: string;
  /**
   * Called when the upload completes successfully with bytes ready to ingest.
   * The provider's handler does PDF magic-bytes detection and routes through
   * either the pdf-import webview path (`pdfFromUpload` message) or
   * `handleIngest` with source='upload'. Errors thrown by the callback are
   * caught and surfaced as a modal `error` state.
   */
  onComplete(bytes: Uint8Array, fileName: string): Promise<void> | void;
  /**
   * Optional override; tests / non-default deployments. Defaults to the
   * configured `pptxViewer.dropboxBaseUrl` or the production fallback.
   */
  baseUrl?: string;
}

/**
 * Start a new upload session. Posts the initial `connecting` modal to the
 * webview synchronously, opens the WS asynchronously, and wires the rest
 * via event handlers. Returns immediately with a handle the caller uses
 * for cancel/close/retry/dispose.
 */
export function startUploadFlow(opts: UploadFlowOptions): UploadFlowHandle {
  return new UploadFlow(opts);
}

class UploadFlow implements UploadFlowHandle {
  private readonly webview: vscode.WebviewPanel;
  private readonly fileName: string;
  private readonly onComplete: NonNullable<UploadFlowOptions['onComplete']>;
  private readonly baseUrl: string;
  private client: UploadClient | undefined;
  private state: UploadModalState = { phase: 'connecting' };
  private countdownTimer: ReturnType<typeof setInterval> | undefined;
  /** Server-reported total bytes — set by `upload-start`, used to drive the
   *  applying-phase progress bar against accumulated chunk size. */
  private applyingTotalBytes = 0;
  /** When true we expect a `closed` event imminently; suppress the auto-
   *  transition to `error`. Set by cancel(), close(), and after `done`. */
  private terminalReached = false;
  private disposed = false;

  constructor(opts: UploadFlowOptions) {
    this.webview = opts.webviewPanel;
    this.fileName = opts.fileName;
    this.onComplete = opts.onComplete;
    this.baseUrl = opts.baseUrl ?? resolveDropboxBaseUrl();

    // Render the connecting state synchronously so the user sees the modal
    // pop the moment they click the button — the WS open + first server
    // reply usually take 100–300 ms which would otherwise feel laggy.
    this.renderModal();
    this.openClient();
  }

  cancel(): void {
    if (this.disposed) return;
    log(`upload[${this.fileName}]: cancel requested`);
    this.terminalReached = true;
    this.client?.cancel();
    // The server will reply `cancelled` then close the WS — we wait for
    // that close to drive `closeModal()`, so the modal stays visible
    // through the round-trip rather than blinking out before the server
    // confirms. If the server is unreachable, `closed` still fires from
    // the underlying ws.close() the client falls back to.
  }

  close(): void {
    if (this.disposed) return;
    log(`upload[${this.fileName}]: close requested`);
    this.terminalReached = true;
    this.client?.close();
    this.closeModal();
  }

  retry(): void {
    if (this.disposed) return;
    log(`upload[${this.fileName}]: retry requested`);
    // Tear down the current client without surfacing the close as an error,
    // reset state, and reopen. The modal stays open through the transition
    // (back to 'connecting').
    this.terminalReached = true;
    this.client?.close();
    this.client = undefined;
    this.terminalReached = false;
    this.applyingTotalBytes = 0;
    this.stopCountdownTimer();
    this.transition({ phase: 'connecting' });
    this.openClient();
  }

  submitOtp(otp: string): void {
    if (this.disposed) return;
    // Only relevant in the `waiting` phase — once the upload has started, the
    // phone has already presented its hash and the server has made its
    // decision; there's nothing to (re-)submit.
    if (this.state.phase !== 'waiting') {
      log(`upload[${this.fileName}]: submitOtp ignored in phase=${this.state.phase}`);
      return;
    }
    const cleaned = (otp ?? '').trim();
    if (!/^\d{6}$/.test(cleaned)) {
      this.transition({
        ...this.state,
        otpStatus: 'pending',
        otpError: 'Code must be exactly 6 digits.',
      });
      this.startCountdownTimer();
      return;
    }
    // Flip the UI to 'sent' immediately so the user can't double-click while
    // we're hashing. Hashing is sub-millisecond on any device that runs
    // vscode.dev, but the discipline is the same as anywhere — UI commits
    // before async work starts.
    this.transition({ ...this.state, otpStatus: 'sent', otpError: undefined });
    this.startCountdownTimer();

    void (async () => {
      try {
        const hash = await sha256Hex(cleaned);
        // State may have changed while we were hashing (cancel, error, etc.).
        // Bail without sending if we're no longer in the waiting phase.
        if (this.disposed) return;
        if (this.state.phase !== 'waiting') return;
        this.client?.sendOtp(hash);
        // We don't optimistically mark accepted — wait for the server's
        // otp-ack so a transport failure doesn't silently leave the form
        // in a misleading "locked" state.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`upload[${this.fileName}]: OTP hashing failed — ${message}`);
        if (this.disposed) return;
        if (this.state.phase === 'waiting') {
          this.transition({
            ...this.state,
            otpStatus: 'pending',
            otpError: `Could not compute code: ${message}`,
          });
          this.startCountdownTimer();
        }
      }
    })();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopCountdownTimer();
    this.client?.close();
    this.client = undefined;
    // Don't post a closeModal here — the panel is going away, so the webview
    // can't receive postMessages anyway. If the panel is alive (e.g. provider
    // is just reassigning the slot for a new flow), the new flow's first
    // render replaces the modal HTML wholesale.
  }

  // ───── internals ─────────────────────────────────────────────────────

  private openClient(): void {
    try {
      this.client = new UploadClient({
        baseUrl: this.baseUrl,
        label: this.fileName,
        accept: UPLOAD_ACCEPT,
        maxBytes: UPLOAD_MAX_BYTES,
        onEvent: (ev) => this.handleEvent(ev),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`upload[${this.fileName}]: WebSocket constructor threw — ${message}`);
      this.transition({ phase: 'error', message });
    }
  }

  private handleEvent(ev: UploadClientEvent): void {
    if (this.disposed) return;
    switch (ev.kind) {
      case 'opened':
        // Stay in 'connecting' — the user is waiting for the `code` reply,
        // not for the WS handshake. No visible change.
        return;

      case 'server-message': {
        const m = ev.message;
        if (m.type === 'code') {
          log(
            `upload[${this.fileName}]: code=${m.code} url=${m.url} ` +
              `expires=${m.expiresAt} qrSvg=${m.qrSvg.length}B`,
          );
          this.transition({
            phase: 'waiting',
            code: m.code,
            url: m.url,
            qrSvg: m.qrSvg,
            expiresAt: m.expiresAt,
            otpStatus: 'pending',
          });
          this.startCountdownTimer();
          return;
        }
        if (m.type === 'otp-ack') {
          // Only fold into the waiting state. If the user was somehow already
          // past waiting (extremely fast phone, edge cases), ack is harmless
          // to drop — the gate is already satisfied at this point.
          if (this.state.phase === 'waiting') {
            log(`upload[${this.fileName}]: otp accepted by server`);
            this.transition({ ...this.state, otpStatus: 'accepted', otpError: undefined });
            this.startCountdownTimer();
          } else {
            log(`upload[${this.fileName}]: otp-ack received in phase=${this.state.phase} (ignored)`);
          }
          return;
        }
        if (m.type === 'upload-progress') {
          this.transition({
            phase: 'uploading',
            bytesReceived: m.bytesReceived,
            sizeBytes: m.sizeBytes,
          });
          return;
        }
        if (m.type === 'upload-start') {
          log(
            `upload[${this.fileName}]: upload-start filename=${m.filename} ` +
              `mime=${m.mime} sizeBytes=${m.sizeBytes}`,
          );
          this.applyingTotalBytes = m.sizeBytes;
          this.transition({
            phase: 'applying',
            bytesApplied: 0,
            totalBytes: m.sizeBytes,
          });
          return;
        }
        if (m.type === 'expired') {
          log(`upload[${this.fileName}]: expired code=${m.code}`);
          this.terminalReached = true;
          this.transition({ phase: 'expired', code: m.code });
          return;
        }
        if (m.type === 'cancelled') {
          // Server-confirmed cancel. The WS will close right after; we
          // close the modal on the `closed` event, not here, so any
          // post-cancel error frames still get a chance to render.
          log(`upload[${this.fileName}]: cancel confirmed`);
          return;
        }
        if (m.type === 'error') {
          log(`upload[${this.fileName}]: server error — ${m.message}`);
          this.terminalReached = true;
          this.transition({ phase: 'error', message: m.message });
          return;
        }
        return;
      }

      case 'chunk':
        // Update only when we're already in the applying phase. The server
        // doesn't emit binary frames before `upload-start`, so any chunk
        // received outside that window is anomalous — the UploadClient
        // still counts it (so the eventual `complete` payload is intact)
        // but we don't shove it through the UI.
        if (this.state.phase === 'applying') {
          this.transition({
            phase: 'applying',
            bytesApplied: ev.totalReceived,
            totalBytes: this.applyingTotalBytes,
          });
        }
        return;

      case 'complete':
        // Bytes are in hand. Switch to `done` (modal shows "File received,
        // updating viewer…") and hand off to the provider's ingest path.
        // The closed event will follow; we suppress the auto-error
        // transition via terminalReached. If the ingest itself fails we
        // surface it as an error modal so the user knows the file made it
        // across the wire but couldn't be applied.
        log(
          `upload[${this.fileName}]: complete sha256=${ev.sha256} bytes=${ev.bytes.byteLength}`,
        );
        this.terminalReached = true;
        this.transition({ phase: 'done' });
        // Dispatch via microtask so the modal's 'done' state hits the DOM
        // before the panel potentially re-renders out from under us.
        void Promise.resolve().then(async () => {
          if (this.disposed) return;
          try {
            await this.onComplete(ev.bytes, this.fileName);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log(`upload[${this.fileName}]: ingest failed — ${message}`);
            if (!this.disposed) {
              this.transition({ phase: 'error', message });
            }
            return;
          }
          // Ingest succeeded — but we deliberately don't closeModal here.
          // The webview owns modal lifecycle once bytes are in flight: it
          // either swaps in the PDF-import modal (PDF branch) or kicks off
          // ingest and lets the ingest-result handler set status (PPTX
          // branch). Auto-closing here would race those handlers and
          // dismiss whatever modal the webview just opened.
        });
        return;

      case 'protocol-error':
        log(`upload[${this.fileName}]: protocol-error — ${ev.error}`);
        this.terminalReached = true;
        this.transition({ phase: 'error', message: `Protocol error: ${ev.error}` });
        return;

      case 'ws-error':
        // Don't transition here — the close event right behind it will
        // do the work. We just log so the cause is visible.
        log(`upload[${this.fileName}]: ws-error — ${ev.message}`);
        return;

      case 'closed':
        this.stopCountdownTimer();
        log(
          `upload[${this.fileName}]: ws closed code=${ev.code} wasClean=${ev.wasClean}` +
            (ev.reason ? ` reason="${ev.reason}"` : ''),
        );
        if (this.state.phase === 'done') {
          // Successful path — modal already in 'done' (the brief "Updating
          // viewer…" splash), bytes already handed off to the provider via
          // the microtask. The webview takes over modal lifecycle from
          // here (closes upload modal + routes to PDF import or PPTX
          // ingest); nothing for us to do on this WS close.
          return;
        }
        if (this.terminalReached) {
          // We knew this close was coming (user-initiated cancel, server
          // expired/error already surfaced). Dismiss the modal unless the
          // current state is one the user needs to see (expired/error
          // both carry their own buttons; the user closes manually).
          if (this.state.phase === 'expired' || this.state.phase === 'error') {
            return;
          }
          this.closeModal();
          return;
        }
        // Unexpected close — connection died mid-flow. Surface as an
        // error so the user gets a retry button.
        this.transition({
          phase: 'error',
          message: `Connection closed unexpectedly (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`,
        });
        return;
    }
  }

  private transition(next: UploadModalState): void {
    this.state = next;
    if (next.phase !== 'waiting') {
      this.stopCountdownTimer();
    }
    this.renderModal();
  }

  private renderModal(): void {
    if (this.disposed) return;
    const html = renderUploadModalHtml({
      fileName: this.fileName,
      state: this.state,
    });
    this.webview.webview.postMessage({ type: 'uploadModal', html });
  }

  private closeModal(): void {
    if (this.disposed) return;
    this.webview.webview.postMessage({ type: 'uploadModalClose' });
  }

  private startCountdownTimer(): void {
    this.stopCountdownTimer();
    this.countdownTimer = setInterval(() => {
      // Only re-render when still in waiting — defensive against late
      // ticks racing a state transition.
      if (this.state.phase !== 'waiting') {
        this.stopCountdownTimer();
        return;
      }
      this.renderModal();
    }, COUNTDOWN_TICK_MS);
  }

  private stopCountdownTimer(): void {
    if (this.countdownTimer !== undefined) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = undefined;
    }
  }
}

/**
 * SHA-256 a UTF-8 string and return its lowercase hex digest. crypto.subtle is
 * available in the web-extension worker context, same as in any browser
 * worker. Async because the SubtleCrypto API is.
 *
 * Kept module-private rather than exported to a `crypto` helper — the only
 * caller is the OTP submit path; if a second caller appears, promote it.
 */
async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}
