# Pptx Upload via Dropbox — Plan

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

## Server-side additions (live in `~/projects/dropbox-server/`)

Three additions, each small. Each lands as its own commit in the dropbox-server repo, not this one.

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

### M1 — Server additions *(work in `~/projects/dropbox-server/`)*

S1, S2, S3 from the previous section. Lands as one or two commits in the dropbox-server repo. Now that **M2 is shipped**, each commit gets `git pull && pm2 restart dropbox-server` on the VPS for live validation against the deployed URL (`https://vscode.sophtwhere.com/dropbox/`). **DoD:**

- `npm test` passes with new assertions added.
- `node server.js` boots; manual probe (or `curl`/`websocat`) confirms `qrSvg` round-trips from the live URL.
- `upload-progress` observable when posting a >1 MB file to a fresh code on the live URL.

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

### M3 — Pure modules

- `src/upload/uploadProtocol.ts` — message validators.
- `src/upload/uploadModalHtml.ts` — modal renderer for happy / expired / error states.
- `test/upload-protocol.test.ts`, `test/upload-modal-html.test.ts` — tsx-runnable.

No vscode imports anywhere in M3. **DoD:** both test files green via `npx tsx --test test/upload-*.test.ts`.

### M4 — Wired WS client

- `src/upload/uploadClient.ts` — opens WS, sends `request`, exposes events.
- Decides the WS endpoint: derive from the webview's `window.location.origin` (passed in via the initial postMessage from webview to host), append `/dropbox/ws`. In dev / fallback, allow override via a setting like `pptxViewer.dropboxBaseUrl`.

**DoD:** A throwaway command `pptxViewer.probeUpload` (analogous to the M4.6 probe) opens a WS to the live or local server, requests a code, logs the `code`/`qrSvg`/`expiresAt` to the Output Channel, sends `cancel` after 2s.

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
