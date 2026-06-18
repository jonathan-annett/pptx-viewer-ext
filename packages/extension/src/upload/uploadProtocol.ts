// Pure validators for the dropbox-server WebSocket protocol — *receive side*.
//
// The dropbox-server (sibling repo `~/projects/dropbox-server/`) defines two
// directions on a single WS connection:
//
//   requester → server : `request`, `cancel`, `otp`
//   server    → requester (us) : `code`, `otp-ack`, `upload-progress`,
//                                `upload-start`, `upload-end`, `expired`,
//                                `cancelled`, `error`
//                                + binary frames (in-order chunks of the file).
//
// The extension only ever sits on the *requester* side, so this module only
// validates the inbound messages we expect to receive. The send side is two
// hard-coded JSON literals (`request` and `cancel`) emitted by `uploadClient`
// and doesn't need its own validator.
//
// Shape mirrors dropbox-server's `protocol.js` — `{ ok: true, value }` /
// `{ ok: false, error }`. Pure: no vscode, no Node, no DOM.
//
// Tests: `test/upload-protocol.test.ts` (tsx-runnable).

/* eslint-disable @typescript-eslint/no-explicit-any */

export type CodeMessage = {
  type: 'code';
  /** 5-char Crockford-base32 code, canonicalised by the server. */
  code: string;
  /** Absolute URL the uploader visits on their phone. */
  url: string;
  /** Server-rendered SVG of the URL as a QR code. Drop into the DOM via
   *  innerHTML — no leading XML decl, no trailing whitespace. */
  qrSvg: string;
  /** ISO-8601 instant. After this the code expires and the WS will see
   *  `expired`. */
  expiresAt: string;
};

export type UploadProgressMessage = {
  type: 'upload-progress';
  /** Bytes spooled to the server so far. Monotonic non-decreasing across
   *  frames of a single upload. */
  bytesReceived: number;
  /** Total bytes — mirrors `Content-Length`, or `null` if the uploader's
   *  browser didn't send one. */
  sizeBytes: number | null;
};

export type UploadStartMessage = {
  type: 'upload-start';
  filename: string;
  mime: string;
  sizeBytes: number;
};

export type UploadEndMessage = {
  type: 'upload-end';
  /** Hex SHA-256 of the relayed bytes. We don't strictly need to verify this
   *  on the requester side — we only re-hash once on ingest — but surface it
   *  so callers can log/compare. */
  sha256: string;
};

export type ExpiredMessage = {
  type: 'expired';
  code: string;
};

export type CancelledMessage = {
  type: 'cancelled';
};

/**
 * Sent in reply to a client `otp` message. Acknowledgement only — no payload.
 * The server has now stored the hash; subsequent uploads will be checked
 * against it.
 */
export type OtpAckMessage = {
  type: 'otp-ack';
};

export type ErrorMessage = {
  type: 'error';
  message: string;
};

export type ServerMessage =
  | CodeMessage
  | UploadProgressMessage
  | UploadStartMessage
  | UploadEndMessage
  | ExpiredMessage
  | CancelledMessage
  | OtpAckMessage
  | ErrorMessage;

export type ServerMessageType = ServerMessage['type'];

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Parse a text frame received from the server and validate its shape.
 *
 * Wraps JSON.parse so callers don't have to handle SyntaxError separately —
 * a malformed frame is just another validation failure.
 */
export function parseServerFrame(text: string): ValidationResult<ServerMessage> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `frame is not valid JSON: ${(e as Error).message}` };
  }
  return validateServerMessage(parsed);
}

/**
 * Validate an already-parsed JSON value against the server→client protocol.
 *
 * Unknown `type`s are rejected with a clear error rather than silently
 * passed through — the server's protocol is closed.
 */
export function validateServerMessage(msg: unknown): ValidationResult<ServerMessage> {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, error: 'message must be a JSON object' };
  }
  const m = msg as Record<string, any>;
  if (typeof m.type !== 'string') {
    return { ok: false, error: 'missing "type"' };
  }
  switch (m.type) {
    case 'code': return validateCode(m);
    case 'upload-progress': return validateUploadProgress(m);
    case 'upload-start': return validateUploadStart(m);
    case 'upload-end': return validateUploadEnd(m);
    case 'expired': return validateExpired(m);
    case 'cancelled': return validateCancelled(m);
    case 'otp-ack': return validateOtpAck(m);
    case 'error': return validateError(m);
    default: return { ok: false, error: `unknown message type "${m.type}"` };
  }
}

// ───── per-type validators ──────────────────────────────────────────────

// 5-char Crockford base32, ambiguous letters (I/L/O) already normalised away
// by the server, plus `U` is never minted. The server canonicalises before
// emit so we just need to confirm length + character set as a sanity check.
const CODE_RE = /^[0-9A-HJKMNPQRSTVWXYZ]{5}$/;

function validateCode(m: Record<string, any>): ValidationResult<CodeMessage> {
  if (typeof m.code !== 'string' || !CODE_RE.test(m.code)) {
    return { ok: false, error: 'code: "code" must be a 5-char Crockford-base32 string' };
  }
  if (typeof m.url !== 'string' || m.url.length === 0) {
    return { ok: false, error: 'code: "url" must be a non-empty string' };
  }
  if (typeof m.qrSvg !== 'string' || !m.qrSvg.startsWith('<svg')) {
    return { ok: false, error: 'code: "qrSvg" must be an SVG string starting with <svg' };
  }
  if (typeof m.expiresAt !== 'string' || Number.isNaN(Date.parse(m.expiresAt))) {
    return { ok: false, error: 'code: "expiresAt" must be an ISO-8601 instant' };
  }
  return {
    ok: true,
    value: {
      type: 'code',
      code: m.code,
      url: m.url,
      qrSvg: m.qrSvg,
      expiresAt: m.expiresAt,
    },
  };
}

function validateUploadProgress(m: Record<string, any>): ValidationResult<UploadProgressMessage> {
  if (!Number.isFinite(m.bytesReceived) || !Number.isInteger(m.bytesReceived) || m.bytesReceived < 0) {
    return { ok: false, error: 'upload-progress: "bytesReceived" must be a non-negative integer' };
  }
  let sizeBytes: number | null;
  if (m.sizeBytes === null || m.sizeBytes === undefined) {
    sizeBytes = null;
  } else if (
    Number.isFinite(m.sizeBytes) &&
    Number.isInteger(m.sizeBytes) &&
    m.sizeBytes >= 0
  ) {
    sizeBytes = m.sizeBytes;
  } else {
    return { ok: false, error: 'upload-progress: "sizeBytes" must be a non-negative integer or null' };
  }
  return {
    ok: true,
    value: {
      type: 'upload-progress',
      bytesReceived: m.bytesReceived,
      sizeBytes,
    },
  };
}

function validateUploadStart(m: Record<string, any>): ValidationResult<UploadStartMessage> {
  if (typeof m.filename !== 'string' || m.filename.length === 0) {
    return { ok: false, error: 'upload-start: "filename" must be a non-empty string' };
  }
  if (typeof m.mime !== 'string' || m.mime.length === 0) {
    return { ok: false, error: 'upload-start: "mime" must be a non-empty string' };
  }
  if (!Number.isFinite(m.sizeBytes) || !Number.isInteger(m.sizeBytes) || m.sizeBytes < 0) {
    return { ok: false, error: 'upload-start: "sizeBytes" must be a non-negative integer' };
  }
  return {
    ok: true,
    value: {
      type: 'upload-start',
      filename: m.filename,
      mime: m.mime,
      sizeBytes: m.sizeBytes,
    },
  };
}

function validateUploadEnd(m: Record<string, any>): ValidationResult<UploadEndMessage> {
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) {
    return { ok: false, error: 'upload-end: "sha256" must be a 64-char lowercase hex string' };
  }
  return { ok: true, value: { type: 'upload-end', sha256: m.sha256 } };
}

function validateExpired(m: Record<string, any>): ValidationResult<ExpiredMessage> {
  if (typeof m.code !== 'string' || !CODE_RE.test(m.code)) {
    return { ok: false, error: 'expired: "code" must be a 5-char Crockford-base32 string' };
  }
  return { ok: true, value: { type: 'expired', code: m.code } };
}

function validateCancelled(m: Record<string, any>): ValidationResult<CancelledMessage> {
  const extras = Object.keys(m).filter((k) => k !== 'type');
  if (extras.length > 0) {
    return { ok: false, error: `cancelled has unexpected fields: ${extras.join(', ')}` };
  }
  return { ok: true, value: { type: 'cancelled' } };
}

function validateOtpAck(m: Record<string, any>): ValidationResult<OtpAckMessage> {
  const extras = Object.keys(m).filter((k) => k !== 'type');
  if (extras.length > 0) {
    return { ok: false, error: `otp-ack has unexpected fields: ${extras.join(', ')}` };
  }
  return { ok: true, value: { type: 'otp-ack' } };
}

function validateError(m: Record<string, any>): ValidationResult<ErrorMessage> {
  if (typeof m.message !== 'string' || m.message.length === 0) {
    return { ok: false, error: 'error: "message" must be a non-empty string' };
  }
  return { ok: true, value: { type: 'error', message: m.message } };
}
