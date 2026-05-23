// M4 throwaway probe command — `pptxViewer.probeUpload`.
//
// Purpose: prove the wired WS client (`uploadClient.ts`) talks to the live
// dropbox-server end-to-end from inside the vscode.dev extension host. This
// is the first time anything in the upload feature touches `vscode.*`.
//
// The command:
//   1. Reads the dropbox-server base URL from the `pptxViewer.dropboxBaseUrl`
//      setting; falls back to `https://vscode.sophtwhere.com/dropbox`.
//   2. Opens an `UploadClient` with a hardcoded label + accept list.
//   3. Logs every event (`opened`, each `server-message`, any `chunk`,
//      `complete`, `ws-error`, `protocol-error`, `closed`).
//   4. After 2 seconds, sends `cancel`.
//
// DoD per the plan: log the `code` / `qrSvg` length / `expiresAt`, then
// observe `cancelled` + `closed` arrive cleanly.
//
// Lifetime: this command is intentionally throwaway. It stays in the tree
// until M5 (button + modal wiring) demonstrates the same flow through the
// real UI; at sign-off the command + this file go away (same arc as
// `src/sync/probe.ts` for M4.6). The module is small and self-contained so
// the deletion is a one-file diff.

import * as vscode from 'vscode';
import { log } from '../log';
import { UploadClient, deriveWsUrl, type UploadClientEvent } from './uploadClient';

const DEFAULT_BASE_URL = 'https://vscode.sophtwhere.com/dropbox';
const CANCEL_AFTER_MS = 2000;
// Hardcoded label/accept/maxBytes. Realistic enough to match the eventual
// M5 wiring (pptx + pdf), but the probe never actually uploads anything —
// the cancel timer fires before the user could open the URL.
const PROBE_LABEL = 'probe.pptx';
const PROBE_ACCEPT = [
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/pdf',
];
const PROBE_MAX_BYTES = 200 * 1024 * 1024; // 200 MB; server clamps to 500.

export function registerUploadProbe(): vscode.Disposable {
  return vscode.commands.registerCommand('pptxViewer.probeUpload', async () => {
    log('--- probeUpload: live WS roundtrip ---');
    const baseUrl = resolveBaseUrl();
    log(`probeUpload: baseUrl = ${baseUrl}`);
    log(`probeUpload: wsUrl   = ${deriveWsUrl(baseUrl)}`);

    let client: UploadClient | undefined;
    let closed = false;
    // Resolved on `closed`; the command awaits this so the Output Channel
    // ordering is sane (banner ← events ← end banner) regardless of how
    // long the close handshake takes.
    const closedPromise = new Promise<void>((resolve) => {
      const handle = (ev: UploadClientEvent): void => {
        logEvent(ev);
        if (ev.kind === 'closed') {
          closed = true;
          resolve();
        }
      };
      try {
        client = new UploadClient({
          baseUrl,
          label: PROBE_LABEL,
          accept: PROBE_ACCEPT,
          maxBytes: PROBE_MAX_BYTES,
          onEvent: handle,
        });
      } catch (err) {
        // Synchronous WebSocket constructor throw — invalid URL, blocked
        // by a policy, etc. Surface and resolve immediately so the command
        // doesn't hang waiting for events that'll never arrive.
        log(`probeUpload: WebSocket constructor threw — ${errMsg(err)}`);
        resolve();
      }
    });

    // Schedule the cancel. If `closed` already fired (e.g. server refused
    // the request), the cancel is a no-op courtesy of UploadClient's
    // idempotency guard.
    const cancelTimer = setTimeout(() => {
      if (closed) return;
      log(`probeUpload: ${CANCEL_AFTER_MS}ms elapsed — sending cancel`);
      client?.cancel();
    }, CANCEL_AFTER_MS);

    // Safety net: if the server somehow never closes the WS (it should
    // close immediately after `cancelled`), bail at 10 s so the command
    // surface terminates and the Output Channel banner fires.
    const safetyTimer = setTimeout(() => {
      if (closed) return;
      log('probeUpload: safety timeout (10s) — forcing close');
      client?.close();
    }, 10_000);

    try {
      await closedPromise;
    } finally {
      clearTimeout(cancelTimer);
      clearTimeout(safetyTimer);
    }

    log('--- probeUpload: end ---');
    void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
  });
}

function resolveBaseUrl(): string {
  const cfg = vscode.workspace.getConfiguration('pptxViewer');
  const v = cfg.get<string>('dropboxBaseUrl');
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return DEFAULT_BASE_URL;
}

function logEvent(ev: UploadClientEvent): void {
  switch (ev.kind) {
    case 'opened':
      log('probeUpload: ws opened — request frame sent');
      return;
    case 'server-message': {
      const m = ev.message;
      switch (m.type) {
        case 'code':
          log(
            `probeUpload: ← code  code=${m.code} url=${m.url} ` +
              `qrSvg=${m.qrSvg.length} bytes expiresAt=${m.expiresAt}`,
          );
          return;
        case 'upload-progress':
          log(
            `probeUpload: ← upload-progress bytesReceived=${m.bytesReceived} ` +
              `sizeBytes=${m.sizeBytes ?? 'null'}`,
          );
          return;
        case 'upload-start':
          log(
            `probeUpload: ← upload-start filename=${m.filename} ` +
              `mime=${m.mime} sizeBytes=${m.sizeBytes}`,
          );
          return;
        case 'expired':
          log(`probeUpload: ← expired code=${m.code}`);
          return;
        case 'cancelled':
          log('probeUpload: ← cancelled');
          return;
        case 'error':
          log(`probeUpload: ← error message=${m.message}`);
          return;
      }
      return;
    }
    case 'chunk':
      // The probe cancels before any phone upload happens, so chunks are
      // not expected. If one shows up, it's diagnostic information worth
      // surfacing (a malicious or buggy server is the only plausible cause).
      log(`probeUpload: ← <binary chunk> ${ev.bytes.byteLength} bytes (total ${ev.totalReceived})`);
      return;
    case 'complete':
      log(`probeUpload: ← complete sha256=${ev.sha256} bytes=${ev.bytes.byteLength}`);
      return;
    case 'protocol-error':
      log(`probeUpload: protocol-error — ${ev.error}; raw="${truncate(ev.raw, 120)}"`);
      return;
    case 'ws-error':
      log(`probeUpload: ws-error — ${ev.message}`);
      return;
    case 'closed':
      log(
        `probeUpload: ws closed — code=${ev.code} reason="${ev.reason}" wasClean=${ev.wasClean}`,
      );
      return;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
