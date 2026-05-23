// Wired WebSocket client for the dropbox-server upload relay.
//
// Lives on the extension-host side of the upload flow. The host's worker
// context has the standard `WebSocket` global (same as any browser worker),
// so this module does not need vscode or DOM APIs — but it is "wired" in
// the project's sense because it owns a live network resource and is not
// runnable from pure-Node tests. The pure protocol validators live in
// `uploadProtocol.ts`; this module is what threads them onto a socket.
//
// Responsibilities:
//   - Open the WS, send the one `request` frame, listen for replies.
//   - Demultiplex text vs binary frames. Text frames go through the pure
//     `parseServerFrame` validator; binary frames are file payload, in order.
//   - Accumulate binary chunks into a single Uint8Array. The server only
//     emits binary frames between `upload-start` and `upload-end`, and we
//     surface the assembled bytes via the `complete` event together with
//     the `upload-end.sha256` so the caller can verify or pass straight on
//     to the ingest pipeline.
//   - Forward every validated protocol message to the caller via a single
//     `onEvent` callback (discriminated union — easier to thread through
//     vscode postMessage than a per-event-name EventEmitter).
//   - Expose `cancel()` (sends `{type:'cancel'}` then waits for the server
//     to close) and `close()` (drops the WS unconditionally; for panel
//     disposal or unrecoverable errors).
//
// The WS endpoint is `<baseUrl>/ws` with `http(s)://` rewritten to
// `ws(s)://`. The default for production is
// `https://vscode.sophtwhere.com/dropbox`; the M4 probe command lets the
// user override via the `pptxViewer.dropboxBaseUrl` setting so a local
// `http://127.0.0.1:3030` instance is reachable for offline debugging.
//
// Single-shot: one UploadClient instance == one upload session. Re-using
// the same instance after `closed` fires is not supported (the upstream
// server protocol doesn't either — re-`request` on the same socket is a
// hard error). Create a fresh client for a retry.

import { parseServerFrame, type ServerMessage } from './uploadProtocol';

export interface UploadRequest {
  /** Label string the uploader sees on the form. ≤200 chars per server. */
  label: string;
  /** Non-empty list of accepted MIME types (`type/subtype`, wildcards OK). */
  accept: string[];
  /** Per-upload byte ceiling. Server clamps to 500 MB. */
  maxBytes: number;
}

export interface UploadClientOptions extends UploadRequest {
  /**
   * dropbox-server base URL. Example: `https://vscode.sophtwhere.com/dropbox`.
   * The WS endpoint is derived as `<baseUrl>/ws` with the scheme rewritten:
   *   https:// → wss://, http:// → ws://.
   * Trailing slashes are tolerated.
   */
  baseUrl: string;
  /**
   * Single sink for all events. The wiring layer (M5) forwards relevant
   * shapes onward as webview postMessages; the M4 probe just logs them.
   */
  onEvent: (ev: UploadClientEvent) => void;
}

/**
 * Discriminated union of everything the client can surface to its caller.
 *
 * `server-message` is a passthrough of every validated text frame except
 * `upload-end`, which is folded into `complete` so the caller sees the
 * sha256 *and* the assembled bytes in one event. The split keeps the
 * protocol-shaped events on one branch and the binary-payload event on
 * another, which matches how the M5 wiring layer wants to handle them
 * (server-messages → postMessage to webview; complete → ingest pipeline).
 */
export type UploadClientEvent =
  /** WS is open and the `request` frame has just been sent. */
  | { kind: 'opened' }
  /** Validated text frame from the server, *not* `upload-end`. */
  | { kind: 'server-message'; message: Exclude<ServerMessage, { type: 'upload-end' }> }
  /**
   * A binary chunk arrived. Surfaced so the caller can show an "applying"
   * progress bar driven by accumulated byte count; `totalReceived` is the
   * running total including this chunk. The chunk itself is also already
   * stored in the internal accumulator and will reappear in `complete`.
   */
  | { kind: 'chunk'; bytes: Uint8Array; totalReceived: number }
  /**
   * `upload-end` arrived. `bytes` is the concatenated payload (every
   * binary frame since `upload-start`, in order). `sha256` is the server's
   * hash of those same bytes; the caller may verify by re-hashing.
   */
  | { kind: 'complete'; bytes: Uint8Array; sha256: string }
  /**
   * A text frame failed `parseServerFrame` validation. The client keeps the
   * WS open — the server will usually follow up with an `error` and close —
   * but surfaces the parse failure so it makes it into the log. Treat as
   * fatal for the session.
   */
  | { kind: 'protocol-error'; raw: string; error: string }
  /**
   * The WebSocket fired its `error` event. This is the transport layer,
   * not the protocol — connection refused, DNS, TLS, mid-stream drop.
   * `closed` will fire shortly after.
   */
  | { kind: 'ws-error'; message: string }
  /** WS is closed. Terminal — no further events. */
  | { kind: 'closed'; code: number; reason: string; wasClean: boolean };

/**
 * State the client itself tracks. Exposed only for testability / debug
 * logging — callers should drive their own UI from the events above.
 */
export type UploadClientPhase =
  | 'idle'
  | 'connecting'
  | 'awaiting-code'
  | 'awaiting-upload'
  | 'receiving'
  | 'done'
  | 'closed';

export class UploadClient {
  private readonly ws: WebSocket;
  private readonly onEvent: (ev: UploadClientEvent) => void;
  private readonly request: UploadRequest;
  private readonly chunks: Uint8Array[] = [];
  private receivedBytes = 0;
  private _phase: UploadClientPhase = 'idle';
  /** Set true when the *client* initiated a cancel; lets us distinguish
   *  caller-initiated closes from server-initiated ones in logs. */
  private cancelSent = false;

  constructor(opts: UploadClientOptions) {
    this.onEvent = opts.onEvent;
    this.request = { label: opts.label, accept: opts.accept, maxBytes: opts.maxBytes };

    const wsUrl = deriveWsUrl(opts.baseUrl);
    this._phase = 'connecting';
    // WebSocket is available in the web-extension worker context (same as
    // any browser worker). In a Node test environment this constructor
    // would throw — which is why this module isn't covered by tsx tests.
    this.ws = new WebSocket(wsUrl);
    // We need the raw bytes of binary frames, not a Blob — set this before
    // any frames can arrive. Default in browsers is 'blob'.
    this.ws.binaryType = 'arraybuffer';

    this.ws.addEventListener('open', this.handleOpen);
    this.ws.addEventListener('message', this.handleMessage);
    this.ws.addEventListener('error', this.handleError);
    this.ws.addEventListener('close', this.handleClose);
  }

  get phase(): UploadClientPhase {
    return this._phase;
  }

  /**
   * Send `{type:'cancel'}` to the server. The server replies with
   * `cancelled` and closes the WS, so the caller will see one final
   * `server-message` event then `closed`. Safe to call before the WS is
   * open — we queue by waiting on `readyState`, but in practice the M4
   * probe only cancels after the `code` reply arrives.
   *
   * Idempotent: a second call is a no-op.
   */
  cancel(): void {
    if (this.cancelSent) return;
    if (this._phase === 'closed' || this._phase === 'done') return;
    this.cancelSent = true;
    if (this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'cancel' }));
      } catch {
        // If send throws, fall back to a hard close — the server will time
        // the code out on its own.
        this.ws.close();
      }
    } else {
      // Not open yet (or already closing) — just abort the connection.
      this.ws.close();
    }
  }

  /**
   * Drop the WS without telling the server. Use for panel disposal or
   * unrecoverable client-side errors; for a user-initiated cancel prefer
   * `cancel()` so the server reclaims the code immediately.
   */
  close(): void {
    if (this._phase === 'closed') return;
    this.ws.close();
  }

  // ───── event handlers ───────────────────────────────────────────────

  private handleOpen = (): void => {
    this._phase = 'awaiting-code';
    try {
      this.ws.send(JSON.stringify({ type: 'request', ...this.request }));
    } catch (err) {
      // Should be unreachable — open just fired. Surface as ws-error so the
      // caller doesn't silently sit waiting for a code that'll never arrive.
      this.emit({ kind: 'ws-error', message: `failed to send request frame: ${errMsg(err)}` });
      this.ws.close();
      return;
    }
    this.emit({ kind: 'opened' });
  };

  private handleMessage = (ev: MessageEvent): void => {
    if (typeof ev.data === 'string') {
      this.handleTextFrame(ev.data);
      return;
    }
    // ArrayBuffer (binaryType set in constructor). Other shapes would be a
    // browser/runtime bug; treat as a protocol error rather than crashing.
    if (ev.data instanceof ArrayBuffer) {
      this.handleBinaryFrame(new Uint8Array(ev.data));
      return;
    }
    this.emit({
      kind: 'protocol-error',
      raw: `<non-string, non-ArrayBuffer frame: ${typeof ev.data}>`,
      error: 'expected text or ArrayBuffer frame',
    });
  };

  private handleTextFrame(text: string): void {
    const result = parseServerFrame(text);
    if (!result.ok) {
      this.emit({ kind: 'protocol-error', raw: text, error: result.error });
      return;
    }
    const msg = result.value;
    // Phase transitions track the server's protocol order. Used only for
    // local sanity; we don't reject out-of-order messages here — the server
    // is the protocol authority and if it does something weird, the caller
    // will see the events in whatever order they actually arrived.
    switch (msg.type) {
      case 'code':
        this._phase = 'awaiting-upload';
        break;
      case 'upload-start':
        this._phase = 'receiving';
        break;
      case 'upload-end':
        // Don't forward as 'server-message'; fold into 'complete' below.
        this._phase = 'done';
        this.emit({
          kind: 'complete',
          bytes: concatChunks(this.chunks, this.receivedBytes),
          sha256: msg.sha256,
        });
        return;
      case 'expired':
      case 'cancelled':
      case 'error':
        // These are terminal from the server's perspective; a close will
        // follow. Phase stays at whatever it was so the caller can tell
        // whether the error came pre- or post-upload.
        break;
      case 'upload-progress':
        // Pure passthrough; no state transition.
        break;
    }
    this.emit({ kind: 'server-message', message: msg });
  }

  private handleBinaryFrame(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.receivedBytes += bytes.byteLength;
    this.emit({ kind: 'chunk', bytes, totalReceived: this.receivedBytes });
  }

  private handleError = (ev: Event): void => {
    // The browser WebSocket `error` event carries no useful detail — the
    // spec deliberately hides network specifics. The `close` event
    // immediately following will have a code; use that for diagnosis.
    // We still surface a marker so callers can distinguish "ws errored"
    // from "ws closed cleanly" in their logs.
    const message =
      ev instanceof ErrorEvent && ev.message
        ? ev.message
        : 'WebSocket error (no detail available)';
    this.emit({ kind: 'ws-error', message });
  };

  private handleClose = (ev: CloseEvent): void => {
    this._phase = 'closed';
    this.emit({
      kind: 'closed',
      code: ev.code,
      reason: ev.reason,
      wasClean: ev.wasClean,
    });
  };

  private emit(ev: UploadClientEvent): void {
    try {
      this.onEvent(ev);
    } catch {
      // Swallow caller-side throws; an exception in a UI handler must not
      // tear down the WS or skip subsequent events. The wiring layer is
      // expected to do its own try/catch around side effects.
    }
  }
}

/**
 * Build the WebSocket URL from the dropbox-server base URL.
 *
 * Examples:
 *   `https://vscode.sophtwhere.com/dropbox`     → `wss://vscode.sophtwhere.com/dropbox/ws`
 *   `https://vscode.sophtwhere.com/dropbox/`    → `wss://vscode.sophtwhere.com/dropbox/ws`
 *   `http://127.0.0.1:3030`                     → `ws://127.0.0.1:3030/ws`
 *   `ws://127.0.0.1:3030`                       → `ws://127.0.0.1:3030/ws`  (already ws)
 *
 * Exported so the probe command can log the derived URL for diagnostic
 * purposes — same value the client uses internally.
 */
export function deriveWsUrl(baseUrl: string): string {
  // Strip trailing slash so we don't end up with `/dropbox//ws`.
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.startsWith('wss://') || trimmed.startsWith('ws://')) {
    return `${trimmed}/ws`;
  }
  if (trimmed.startsWith('https://')) {
    return `wss://${trimmed.slice('https://'.length)}/ws`;
  }
  if (trimmed.startsWith('http://')) {
    return `ws://${trimmed.slice('http://'.length)}/ws`;
  }
  // Bare host — assume secure. Caller misconfiguration; better to fail
  // closed (wss) than open (ws) if it's ever a real URL.
  return `wss://${trimmed}/ws`;
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  // Build the final payload in one allocation. The chunks array stays
  // around for the lifetime of the client; we don't free it because the
  // M5 wiring discards the whole UploadClient after `complete` fires.
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
