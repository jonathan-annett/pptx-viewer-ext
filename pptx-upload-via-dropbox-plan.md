# Pptx Upload via Dropbox — Plan

## Status (2026-05-23)

**Shipped:** M1 (server S1+S2+S3), M2 (deploy), M3 (pure extension modules), and M4 (wired WS client + live probe). The dropbox-server is live at `https://vscode.sophtwhere.com/dropbox/` with `upload-progress` frames and `qrSvg` field in the `code` reply. 48/48 server e2e tests green. Extension-side: `src/upload/uploadProtocol.ts` + `src/upload/uploadModalHtml.ts` (pure, M3) plus `src/upload/uploadClient.ts` + `src/upload/probeUpload.ts` (wired, M4). The `UploadClient` opens a WS to `<baseUrl>/ws`, sends the one `request` frame, demultiplexes text vs ArrayBuffer frames, accumulates binary chunks into a single Uint8Array, and surfaces every protocol message + chunk + completion + ws lifecycle through one `onEvent` discriminated union — keeps the postMessage threading simple in M5. The throwaway `pptxViewer.probeUpload` command (palette: "Pptx Info: Probe Upload (M4 diagnostic)") opens a client against the live server, logs `code`/`qrSvg` size/`expiresAt`, sends `cancel` after 2 s, logs `cancelled` + `closed`. Base URL is read from `pptxViewer.dropboxBaseUrl` (empty default → `https://vscode.sophtwhere.com/dropbox`); set the override to `http://127.0.0.1:3030` to point at a local dev server. M3 + M4 committed and pushed (`c5ad5e5`, `d2714dc`); VPS pulled and rebuilt; healthz green.

**Next:** M5 — button + modal wiring. Rename "Update…" to "Browse to Update…" and add "Upload to Update…" in `src/webview.ts`. Wire `src/upload/uploadFlow.ts` between the webview, `UploadClient`, and the existing ingest dispatch — `'upload'` is the third source after `'picker'` and `'drop'`, behaving identically to `'picker'` (no compare modal, the phone upload is itself the affirmation). PDF detection on `complete` should route through the existing PDF→PPTX import modal. M5 is the first milestone where the user can actually use the feature end-to-end on the live URL.

**Carry-over for M7:** delete `src/upload/probeUpload.ts` + its command + the `pptxViewer.dropboxBaseUrl` setting (or keep the setting as a deliberate user-facing knob if it earns its keep). Same throwaway arc as `src/sync/probe.ts` for M4.6.

**Pointers for a fresh session:**
- This file (`pptx-upload-via-dropbox-plan.md`) is the active per-iteration plan.
- `CLAUDE.md` is substrate — read it for the project's conventions (especially the pure/wired split, no Node APIs in extension code, web-extension constraints).
- Sibling repo: `~/projects/dropbox-server/` — `PLAN.md` is the spec, `README.md` documents the wire protocol including the new `upload-progress` and `qrSvg` additions.
- Memory: `feedback_pm2_esm_autoboot.md`, `reference_dropbox_server.md`, `project_upload_via_dropbox.md`.

---

## Purpose

Add a third "replace the current file" affordance to the pptx viewer: in addition to **Browse to Update…** (local file picker) and drag-and-drop, the user can click **Upload to Update…** to get a short URL + QR code. Opening that URL on another device (typically a phone) and picking a file relays the bytes back to the viewer over a WebSocket. The viewer then feeds the bytes through the existing ingest pipeline — straight overwrite for `.pptx`, the PDF→PPTX import flow for `.pdf`.

The relay server is a separate already-built service (`~/projects/dropbox-server/`, see its `PLAN.md` and `REPORT.md` for the service contract) that this extension consumes as a client. It will be deployed at `https://vscode.sophtwhere.com/dropbox/` via a `handle_path /dropbox/*` block inside the existing Caddy site — same-origin to the test harness, which sidesteps the vscode.dev `connect-src` CSP friction.

This plan covers only the extension side and the small server-side additions needed to support it (`upload-progress` events, server-rendered QR). The dropbox-server's core protocol and tests are already shipping.

---

## User-facing model

1. User has a `.pptx` open in the viewer.
2. User clicks **Upload to Update…** under the filename.
3. A modal opens inside the existing webview panel showing:
   - A QR code (image).
   - The URL as text with a copy-to-clipboard button.
   - The 5-character code in large type.
   - A countdown to expiry (10 minutes).
   - A cancel button.
4. User opens the URL on a phone (scans the QR or types it).
5. Phone shows the upload form (the dropbox-server's `/<code>` page) prompting "Please upload the new content for *foo.pptx*". User picks a file and hits Send.
6. As the phone uploads to the server, the viewer modal shows "receiving from phone… 4.2 MB / 12 MB" (driven by `upload-progress` events).
7. Once the server has the full file and the relay starts, the modal shows "applying…" while the bytes stream back over WS.
8. On completion:
   - If the uploaded file is a `.pdf`, the existing PDF→PPTX import config modal opens (skipping no further user prompts the picker path also skips).
   - If a `.pptx`, the file is written over `document.uri` and the viewer re-parses — same final step as Browse to Update….
9. Modal closes; viewer shows the new content with the existing "Updated" status indicator.

Cancellation paths:
- User closes the modal → `cancel` sent over WS, code dropped, WS closed.
- TTL elapses → `expired` arrives → modal shows "code expired" and offers a retry button that opens a fresh session.
- WS drops mid-relay → modal shows an error; user can retry.

---

## Button layout

The current row under the filename is:

```
[ Save As… ] [ Update… ]
```

Becomes:

```
[ Save As… ] [ Browse to Update… ] [ Upload to Update… ]
```

`Update…` is renamed to `Browse to Update…` — same button id, same handler, label text only. No behavioural change to the existing flow.

---

## Architecture

```
                          (same-origin)
┌──────────────────────────┐      WSS          ┌────────────────────┐
│  viewer webview          │ ◄──────────────► │  vscode.sophtwhere │ 
│  (modal: QR/URL/progress)│                  │  .com/dropbox      │
└──────────┬───────────────┘                  │  (Node + ws + qr)  │
           │ postMessage                       └────────┬───────────┘
           │                                            │ multipart POST
           ▼                                            │
┌──────────────────────────┐                            ▼
│  extension host          │                  ┌────────────────────┐
│  - opens WS              │ ◄────WS frames── │  phone browser     │
│  - accumulates bytes     │                  │  /<code> form      │
│  - feeds ingest pipeline │                  └────────────────────┘
└──────────────────────────┘
```

**Why the WS lives in the extension host, not the webview**

- Final bytes need to land via `vscode.workspace.fs.writeFile`, only callable from the host.
- Putting the WS host-side avoids relaying every binary chunk through `postMessage`.
- Host → webview communication is restricted to small status updates + (eventually) the bytes for PDF detour.

**Why same-origin matters**

- vscode.dev's webview iframe has tight `connect-src` rules. Self-hosted vscode-web at `vscode.sophtwhere.com` is more lenient, but we still want to keep the surface minimal.
- Serving the dropbox-server at `/dropbox/` on the same host means we only need to add the dropbox origin to the webview's CSP `connect-src` if the WS turned out to live there. Since the WS is in the host (worker context), no CSP-meta change is strictly required — the worker's CSP is inherited from the host page.
- The webview's CSP *does* need `img-src` widened to allow the QR SVG, but since we'll inline the SVG as a `data:` URL or render as raw SVG inside the page (not as `<img src="…">`), the existing `img-src data:` policy already covers it.

---

## Module layout

Following the project's pure / vscode-wired split convention.

**New, in `src/upload/`:**

- **`uploadProtocol.ts`** — pure. Message-shape validators for the WS protocol's *server → client* messages (`code`, `upload-progress`, `upload-start`, `upload-end`, `expired`, `error`). Mirror of `protocol.js` in the dropbox-server but only the receive side. tsx-testable, no vscode import.
- **`uploadModalHtml.ts`** — pure renderer. Given `{ url, code, qrSvg, expiresAt }` (or various error states), returns the modal HTML fragment to inject into the webview. Follows the `pdfImportConfigHtml.ts` pattern. tsx-testable.
- **`uploadClient.ts`** — wired. Opens the WS to `<sameOrigin>/dropbox/ws`, sends `request`, demultiplexes incoming frames, accumulates binary chunks. Exposes an `EventEmitter`-style or async iterator API so the panel wiring can subscribe without knowing the WS exists. Uses the browser-side `WebSocket` (the extension host has it in the web-extension worker — same as workers anywhere).
- **`uploadFlow.ts`** — wired. Glue between `uploadClient`, the webview panel, and the existing ingest path. Lifecycle: open WS → request → forward `code` to webview → forward progress → on `upload-end`, post bytes through to the webview's existing ingest dispatch as `source: 'upload'`.

**Modified:**

- **`src/webview.ts`** — add the third button + a modal overlay container. The modal is rendered inline from `uploadModalHtml.ts` strings via postMessage from the extension. Existing PDF-import modal pattern (overlay container, render-on-demand) is the template.
- **`src/provider.ts`** — register the `{type: 'uploadOpen'}` postMessage handler that kicks off `uploadFlow`. Extend the `ingest` source enum to `'picker' | 'drop' | 'upload'`. The `'upload'` branch is identical to `'picker'` (user affirmed via the phone upload — no compare modal).

**Tests, in `test/`:**

- `upload-protocol.test.ts` — validates and rejects every incoming-message shape against `uploadProtocol.ts`. Pattern follows existing `sync-*.test.ts` pure tests, run via `npx tsx --test`.
- `upload-modal-html.test.ts` — snapshot-style assertions on the modal renderer for happy / expired / error states.

E2E coverage of the WS roundtrip stays in `~/projects/dropbox-server/test/e2e.test.js` (the server-side suite already proves the protocol end-to-end). Extension-side WS wiring is verified manually against the deployed server.

---

## Server-side additions (live in `~/projects/dropbox-server/`) — ✅ all shipped 2026-05-23

Retained for historical context. The "as-shipped" summaries (with commits, throttle details, and live-verification notes) are under **M1** in the Milestones section below; this section preserves the original spec for what was asked of the server.

### S1 — `upload-progress` events

A new server→requester message type:

```json
{ "type": "upload-progress", "bytesReceived": 4287312, "sizeBytes": 12000000 }
```

Emitted while the multipart body is being spooled to `/tmp`, debounced to ~10 messages/sec or every 64 KB, whichever fires less often. `sizeBytes` may be `null` if the client didn't send `Content-Length`. The existing `upload-start` event still fires *after* spool + validation pass, so the requester sees:

```
{type:'upload-progress', …}  (many)
{type:'upload-start',   …}   (once)
<binary chunks>
{type:'upload-end',     …}
```

Tests: extend `test/e2e.test.js` to assert at least one `upload-progress` arrives before `upload-start` when posting a file of >256 KB.

### S2 — Server-rendered QR

Add `qrcode` (npm, ~30 KB) as a dependency. In the `code` reply, include a new field:

```json
{
  "type": "code",
  "code": "ABCDE",
  "url": "https://vscode.sophtwhere.com/dropbox/ABCDE",
  "qrSvg": "<svg …>…</svg>",
  "expiresAt": "..."
}
```

`qrSvg` is the SVG string (not a data URL). Caller decides how to embed it.

Tests: extend `test/e2e.test.js` to assert `qrSvg` is present, starts with `<svg`, and decodes (via a tiny qr-decoder shim) back to the URL.

### S3 — README + protocol-doc updates

Reflect S1/S2 in `README.md` and `PLAN.md` (the deviation table at the bottom of PLAN.md captures the change). No other behaviour changes.

---

## Milestones

### M1 — Server additions *(✅ shipped 2026-05-23)*

Three commits to `dropbox-server`, each pulled + `pm2 restart`'d on the VPS for live validation against `https://vscode.sophtwhere.com/dropbox/`:

- **S1** (`23b9747`) — `upload-progress` frame emitted during multipart spooling. Throttled at ≥64 KB *and* ≥100 ms (whichever fires *less* often wins, so neither slow nor fast uploads flood the channel). `sizeBytes` mirrors `Content-Length` or `null`. Verified live: 512 KB upload emits ≥1 monotonic progress frame before `upload-start`.
- **S2** (`6ac2b5f`) — `qrSvg` field added to the `{type:'code'}` reply. Renders the upload URL as a trimmed SVG (ECC level M, 1-module quiet zone) via the `qrcode` npm dep — ~0.25 ms per render in benchmarks, ~2 KB SVG on the wire. `issueCode()` is now async; the WS message handler awaits it with an `issuedCode='pending'` re-entry guard set synchronously before the await. Verified live: production WS returns a 2000-byte SVG starting with `<svg xmlns="http://www.w3.org/2000/svg" …>` and ending `</svg>`.
- **S3** (`4a74fc8`) — `README.md` + `PLAN.md` updates documenting both protocol additions, the new `qrcode` dep, and the refreshed lifecycle diagrams.

48/48 tests green. Loop established: edit on phone → push → pull on VPS → `npm install --omit=dev` (only when deps change) → `pm2 restart dropbox-server` → live verification.

### M2 — Deploy *(✅ shipped 2026-05-23, done out of order)*

Landed before M1 — the baseline `v0.1.0` server was deployed first so the rest of the pipeline could be built against the live URL rather than a local-only `localhost:3030`. Sequence:

- **Caddyfile** — `handle_path /dropbox/*` block inserted inside the existing `vscode.sophtwhere.com { … }` site, wrapping the existing catch-all in `handle { reverse_proxy 127.0.0.1:3001 }` to keep routing explicit. `request_body { max_size 500MB }` to match `SERVER_MAX_BYTES`. Wildcard subdomain block untouched. Backup at `/etc/caddy/Caddyfile.bak.20260523-224018`. `sudo caddy validate` clean before reload.
- **Checkout** — `~/dropbox-server` cloned from `https://github.com/jonathan-annett/dropbox-server.git`, `npm install --omit=dev` (3 packages: `busboy`, `ws`, plus deps).
- **pm2** — `dropbox-server` running on `127.0.0.1:3030` alongside the existing `pptx-watch` + `pptx-dev-server`. `pm2 save`d so the unit survives reboots.

**pm2 ESM auto-boot bugfix (commit `8f0eef6`):** pm2's process launcher `import()`s ESM scripts, which makes `process.argv[1]` point at the launcher rather than `server.js`. The existing `isEntryPoint` guard (designed to keep the test path clean) silently swallowed the production boot — process appeared *online* in pm2, port 3030 unbound, logs empty. Fix: explicit `DROPBOX_AUTOBOOT=1` env-var override in `server.js` + set in `ecosystem.config.cjs`. Banner now logs ` (DROPBOX_AUTOBOOT=1)` suffix when the override fired, so the boot reason is visible. Tests unaffected (they import the module without the env var). Captured as a feedback memory.

**End-to-end verification (live):**
- `GET https://vscode.sophtwhere.com/dropbox/healthz` → `OK` (200)
- `GET https://vscode.sophtwhere.com/dropbox/` → 200, 691-byte upload form
- WS upgrade on `/dropbox/ws` → `HTTP/1.1 101 Switching Protocols`
- `GET https://vscode.sophtwhere.com/` (vscode-web) → 200 (unaffected by the Caddy change)

**Deploy loop established** (mirrors `pptx-watch`):
```
# on phone
git push origin main
# on VPS
cd ~/dropbox-server && git pull --ff-only && pm2 restart dropbox-server
```
No `node --watch` — explicit restart is the convention, per substrate.

### M3 — Pure modules *(✅ shipped 2026-05-23)*

- **`src/upload/uploadProtocol.ts`** — `validateServerMessage` + `parseServerFrame` discriminate the seven inbound message types and return `{ok, value}` / `{ok, error}` shaped exactly like the dropbox-server's `protocol.js`. The strictness is deliberate: the server's protocol is closed, so an unrecognised `type` is treated as a hard failure rather than silently passed through. Per-type validators check field shapes (code is `[0-9A-HJKMNPQRSTVWXYZ]{5}` — `U` excluded, `I/L/O` already normalised by the server before emit; sha256 is lowercase hex; `expiresAt` parses as a Date; QR SVG must start with `<svg`) and surface specific error messages so log lines from the wiring layer point straight at the offending frame. `upload-progress.sizeBytes` is normalised: explicit `null`, omitted, and `undefined` all collapse to `null` since the server uses `null` to mean "no Content-Length seen".
- **`src/upload/uploadModalHtml.ts`** — `renderUploadModalHtml(opts)` is a pure string-out renderer over a `UploadModalState` discriminated union. Phases: `connecting` (spinner), `waiting` (QR + URL + code + countdown), `uploading` (progress bar from `upload-progress` frames; indeterminate variant when `sizeBytes === null`), `applying` (second progress bar driven by the relay accumulator), `expired` / `error` (with close + retry buttons), `done` (terminal, no buttons). The QR SVG is injected verbatim — the server's `qrcode` lib emits a clean `<svg>` and the existing webview CSP (`script-src 'nonce-…'`) means inline `<script>` inside an SVG wouldn't execute anyway. Action buttons carry stable ids (`upload-cancel-btn`, `upload-close-btn`, `upload-retry-btn`, `upload-copy-btn`) so M5's wiring attaches handlers via `getElementById` rather than DOM traversal. CSS lives in `uploadModalCss()` and follows the existing modal pattern: themed via `--vscode-*` custom properties, narrow-viewport collapse on the QR/text grid via a `max-width: 480px` media query, indeterminate progress as a 30%-wide strip sliding back and forth via a `@keyframes upload-bar-indet` rule.
- **Helpers exported for the wiring layer**: `formatCountdown(expiresAt, nowMs)` → `expires in M:SS` (pads seconds, floors at 0:00, falls back to `expires soon` for garbage input), `progressPercent(n, d)` → 0–100 integer (clamps top + bottom, returns 0 for null/zero denominator), `formatBytes(n)` → `512 B` / `1.0 KB` / `1.5 MB` / `1.0 GB` (always-1-decimal for KB+, 0 B for negative/non-finite input).
- **Tests** — `test/upload-protocol.test.ts` (28 cases) covers every type, every required-field rejection, plus the JSON-parse wrapper. `test/upload-modal-html.test.ts` (20 cases) walks each phase asserting the expected ids, copy, and progress-bar markup, plus unit tests for the three helpers. Both runnable individually via `npm run test:upload-protocol` / `npm run test:upload-modal-html`. **DoD: green.**

### M4 — Wired WS client *(✅ shipped 2026-05-23)*

- **`src/upload/uploadClient.ts`** (commit `d2714dc`) — `UploadClient` opens the WS in its constructor (single-shot, one instance per session), sets `binaryType = 'arraybuffer'` before any frames can arrive, sends `{type:'request', label, accept, maxBytes}` on `open`, and routes inbound frames through the M3 `parseServerFrame` validator. Binary frames accumulate into an internal `Uint8Array[]` summed into a single buffer on `upload-end` — that buffer ships out via the `complete` event together with the server-reported sha256, sparing the M5 wiring layer from per-chunk reassembly. All other server messages pass through as `server-message`; transport-level WS `error` becomes `ws-error`; close becomes `closed`. `cancel()` and `close()` are both idempotent. `deriveWsUrl(baseUrl)` is exported as a helper (https↔wss / http↔ws rewrite, trailing-slash tolerance, fail-closed to wss for bare hosts) so the probe logs the exact endpoint the client uses.
- **`src/upload/probeUpload.ts`** — `pptxViewer.probeUpload` registered alongside the M4.6 cold-read probe. Reads `pptxViewer.dropboxBaseUrl` (empty default → `https://vscode.sophtwhere.com/dropbox`), opens an `UploadClient` with hardcoded label/accept/maxBytes, logs every event to the Pptx Info channel, fires `cancel()` at 2 s, with a 10 s safety-net `close()` if the close handshake stalls. Surfaces the Output Channel at end so the trace is visible without spelunking. Will be removed at M7 once the real UI proves the same path.
- **package.json** — `pptxViewer.probeUpload` command + a new `configuration` block declaring `pptxViewer.dropboxBaseUrl` (empty string default; `markdownDescription` documents the fallback and the `/ws` derivation). First config contribution from this extension.

**DoD met:** `npm run typecheck` clean; M3 tests still green; bundle built (`dist/extension.js` 421.6 KB, modest +30 KB vs M3); VPS pulled + esbuild rebuilt to `d2714dc`; `dropbox/healthz` returns 200. The actual live WS round-trip needs the user to invoke the palette command from the PWA — handed off pending that verification.

### M5 — Button + modal wiring

- Button row in `src/webview.ts` updated: rename existing, add new.
- Modal overlay container in the webview, populated by postMessage from the host.
- `src/upload/uploadFlow.ts` — opens the WS via `uploadClient`, forwards `code`/`upload-progress`/`upload-start`/`upload-end`/`expired`/`error` to the webview as postMessages, accumulates binary chunks.
- On `upload-end`: post the assembled bytes back to the webview as `{type:'uploadedBytes', fileName, bytes}`. The webview's existing detection logic (magic-bytes for PDF vs PPTX) decides:
  - PDF → kick off `pdfImport` flow (existing modal + pipeline).
  - PPTX → post `{type:'ingest', source:'upload', fileName, bytes}` back to the host, which routes through the same handler as `'picker'`.

**DoD (against the live VPS):**

- Click Upload to Update… → modal appears with QR / URL / code / countdown.
- Open URL on a phone, upload a `.pptx` → viewer applies it, "Updated" indicator shows.
- Upload a `.pdf` → PDF→PPTX modal opens with the uploaded PDF preloaded.
- Cancel button drops the WS and closes the modal cleanly.
- TTL expiry → modal shows expired state + retry button.

### M6 — Progress UI

- Modal renders a progress bar driven by `upload-progress` events: "Receiving from phone… X / Y MB" (or "…X MB received" if Y is unknown).
- A second bar for the relay phase ("Applying… X / Y MB", driven by chunk-accumulator state inside the host).

**DoD:** Both bars visibly animate on a >1 MB upload over the live VPS.

### M7 — Polish + sign-off

- Error paths covered: WS connect failure (server down), WS upgrade refused, mid-relay disconnect, server `{type:'error'}` event.
- The `connect-src` reality check: confirm the webview's CSP doesn't need widening. If it does (because we ended up making any direct fetch from the webview), document the exact additions in `src/webview.ts`.
- CLAUDE.md updated with the new feature under "What's currently shipping".
- This plan's DoD checklist (below) verified.

---

## Definition of Done

1. Three-button row visible in the viewer; existing Browse path unchanged.
2. Upload to Update… opens a modal showing a scannable QR, copyable URL, 5-char code, and live countdown.
3. Phone upload of a `.pptx` reaches the viewer and replaces the open file; the viewer re-parses without disposing the panel (or, if the panel does dispose on overwrite, it's reopened automatically — whichever matches the existing Browse-to-Update behaviour, which this flow is just mirroring).
4. Phone upload of a `.pdf` enters the existing PDF→PPTX import modal with the uploaded bytes preloaded.
5. Progress is visible on both the phone (already present in `upload.html`) and the viewer modal (driven by `upload-progress` events).
6. Cancel, TTL expiry, and mid-flow WS drop all clean up the code + modal without leaving the viewer in a broken state.
7. `npx tsx --test test/upload-*.test.ts` green.
8. The dropbox-server is reachable at `https://vscode.sophtwhere.com/dropbox/healthz` and its e2e tests still pass after S1+S2 additions.
9. `CLAUDE.md` updated under "What's currently shipping" describing the new feature.

---

## Out of scope (v1)

- **Reverse direction**: uploading from desktop to phone. The dropbox-server protocol doesn't support it and there's no use case yet.
- **Multi-file**: one upload session = one file. If a user needs to update several files, they click the button several times.
- **Auth/token gating**: the dropbox-server stays open per its v1 design. A `DROPBOX_REQUIRE_TOKEN` env-var seam may land in S1 work as a TODO comment but isn't enforced.
- **Persistent sessions across browser restarts**: closing the viewer panel cancels the WS and drops the code. This is intentional — the user just clicks again.
- **Direct peer-to-peer (WebRTC)**: explicitly out of scope per dropbox-server's own plan.
- **Resumable uploads**: also out of scope per dropbox-server's plan. If an upload fails, click the button again.

---

## Dead ends to avoid

(Discovered while drafting this plan; pre-emptively recorded so a future session doesn't relitigate.)

- **Don't try to open the WS from the webview iframe.** Webview-side WebSocket connections face tighter CSP than the host worker and would force `connect-src` widening per host. The bytes also have nowhere useful to land from the webview side (the host owns `vscode.workspace.fs`). Single source of truth: WS lives in the extension host.
- **Don't bundle a QR library on the extension side.** The dropbox-server emits SVG; extension bundles are already ~2 MB and this is the cheapest place to dodge ~30 KB.
- **Don't re-implement PDF/PPTX detection in the upload flow.** The existing webview already detects magic bytes on the drag-drop path. Route the uploaded bytes through that same detection so PDF→PPTX work doesn't fork.
- **Don't make `'upload'` ingest source behave like `'drop'`.** Drop opens a compare modal asking "is this the file you want?". The phone-upload act is itself the affirmation — treat `'upload'` like `'picker'` (skip compare, go straight to write-and-render).
