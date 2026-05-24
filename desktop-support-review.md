# Desktop VS Code — items to review next version

The extension is published as a **web extension only** (`package.json`
declares `"browser": "./dist/extension.js"` with no `"main"` field), so
it loads on desktop VS Code by running in the desktop host's web-extension
worker — same bundle, same constraints, no Node access. Nothing actively
prevents desktop installation, and most features work; the items below
are places where behaviour designed around vscode.dev's specific
constraints either becomes redundant on desktop or could be materially
faster if we branched on host.

The cheapest way to act on any of these is `vscode.env.appHost`
(`'desktop'` vs `'web'` / similar) or `vscode.env.uiKind`
(`UIKind.Desktop` vs `UIKind.Web`). Picking either as the
gate keyword and threading it through a single small `host.ts` helper
keeps the branching contained.

The bigger lever is to add a desktop-specific `"main"` bundle entry
alongside `"browser"`, which would unlock Node APIs (faster hashing,
real PDF.js worker, native streams). That's a real chunk of build
work — flagged below per item where it's the unlock.

---

## File-operation related (highest priority)

### 1. SHA-256 hashing on large buffers

**Where:** `src/sync/hash.ts` (`sha256Hex`, `hashFileAtUri`) — used by
the viewer's parse path, the planner's source + destination walks, the
executor's pre-write verify, and the search indexer.

**What we do today:** `crypto.subtle.digest('SHA-256', bytes)` on the
full buffer. Available identically in web and desktop web-extension
contexts.

**Observed cost:** M5.2 timing data put the 137 MB deck at ~449 ms hash
time (73 % of total parse). Mid-size decks (10–30 MB) sit in the
20–60 ms range. Multiplied across a destination walk on a hundred-file
mirror this dominates.

**Why it could be better on desktop:** Node's `crypto.createHash('sha256')`
in streaming mode is typically 3–5× faster on large buffers and avoids
the full-buffer allocation that WebCrypto requires. On desktop, with a
`"main"` bundle entry, the hash path could use Node crypto and stream
straight from `fs.createReadStream` — skipping the intermediate
`Uint8Array` entirely.

**What to consider:** a desktop-only `"main"` bundle, with a small
`hashBytes`/`hashFromUri` shim that picks WebCrypto on web and
Node-crypto on desktop. The cache layers (URI hash cache, parse cache)
don't need to change — same key, same value, different producer.

---

### 2. PDF.js worker bundling

**Where:** `src/pdfImportWebviewEntry.ts` (side-effect import of
`pdfjs-dist/build/pdf.worker.min.mjs`), inlined into `dist/extension.js`
by `esbuild.config.js`'s `pdfImportBundlePlugin`.

**What we do today:** Inline the worker as a string literal so it's
available without ever fetching an asset URL. Cost: ~1.2 MB of the
~2.0 MB `dist/extension.js` is this. We're stuck on the fake-worker
path (pdfjs v5 dropped `disableWorker`; see CLAUDE.md dead-end entry).

**Why it's like this:** vscode.dev's webview CSP blocks loading the
worker as a real Web Worker from extension-owned URLs, and the
`extensionUri` readFile hang (CLAUDE.md dead-end) rules out streaming
the bytes via the extension host.

**Why it could be better on desktop:** Desktop VS Code resolves
`vscode-resource:` URIs from extension directories without the CSP
friction. A real PDF.js Web Worker is viable, which (a) cuts ~1.2 MB
from the desktop bundle and (b) un-blocks the UI thread during PDF
render (right now fake-worker mode runs everything on the iframe's
main thread).

**What to consider:** either runtime-detect (`appHost === 'desktop'`)
and load a real worker URL via `Webview.asWebviewUri`, or split into
two bundles. The pure pipeline modules (`pdfImport.ts`,
`pdfImportLayout.ts`) don't change.

---

### 3. Tmp + rename for files open in custom editors

**Where:** `src/sync/snapshotStore.ts` (`writeSnapshot`),
`src/sync/manifest.ts` (the same rationale applies if a custom editor
were ever wired to `.foldersync-manifest.json` writes — currently the
editor is view-only so the path doesn't fire, but the workaround pattern
is still load-bearing for the snapshot path).

**What we do today:** When a `TextDocument` is already open at the
target URI, route through `workspace.applyEdit` + `TextDocument.save()`
instead of `writeFile(tmp) + rename(tmp, final)`. The rename path
otherwise closes the editor on vscode.dev (substrate dead-end:
"Atomic tmp+rename writes close any custom editor open on the target").

**Why it could be different on desktop:** Desktop's `fs.rename`
semantics may not trigger the same `TextDocument` disposal — historically
desktop tolerates same-path replacement without dropping editors. Worth
empirically verifying. If desktop doesn't have the problem, the
applyEdit branch is harmless overhead; if it does, the workaround is
already correct.

**What to consider:** add a desktop probe to confirm the rename-closes-
editor behaviour; if confirmed safe, the workaround stays as a no-op
overhead, no code change. The reason this is worth checking is that
`applyEdit` serialises the *text* of the document through VS Code's
edit pipeline, which for a multi-MB manifest is measurably slower than
a direct binary rename.

---

### 4. Anchor `<a download>` round-trip for Save As + Extract Media

**Where:** `src/provider.ts` — webview posts `{type:'save-as'}` or
`{type:'extract-media', mediaPath}`, the extension reads bytes, calls
`vscode.window.showSaveDialog`, then writes via
`vscode.workspace.fs.writeFile`.

**Why it's like this:** Anchor-driven downloads from the webview iframe
are blocked on vscode.dev (substrate dead-end: "Anchor-driven downloads
from the webview iframe are blocked on vscode.dev").

**Why it could be simpler on desktop:** Desktop VS Code's webview iframe
sandbox does not strip the download intent in the same way. A direct
`<a href="blob:…" download="name.pptx">` click would work without the
post-back / showSaveDialog round-trip.

**What to consider:** a desktop branch could shortcut to the anchor
path. Net effect for the user is one fewer dialog (the showSaveDialog
becomes the browser's native download flow). Verify before committing
to a branch — VS Code desktop's webview is an Electron renderer and
behaviour has shifted between versions.

---

### 5. FileSystemWatcher backstop UI

**Where:** Refresh buttons in the `.sync.jsonc` custom editor and the
admin editor; the M4.7 dogfood notes describe these as backstops because
vscode.dev's watcher coverage over FSA-granted folders is incomplete.

**On desktop:** Native FS watchers (inotify on Linux, FSEvents on macOS,
ReadDirectoryChangesW on Windows) are reliable. The Refresh button is
redundant on desktop — but harmless, and the UX cost of having it is
near-zero.

**What to consider:** keep the buttons (explicit user actions are
fine), but the diagnostic copy that *implies* watchers might miss things
could be platform-conditioned. Cosmetic, low priority.

---

## Activation + lifecycle

### 6. `onStartupFinished` activation event

**Where:** `package.json` `activationEvents`.

**Why it's like this:** vscode.dev refreshes can land you in a
folderless tab, in which case no `contributes.customEditors` /
`contributes.commands` event fires implicitly. The snapshot-restore flow
needs to run *before* the user clicks anything (so the workspace is
back in place), so we need an explicit cold-start activation.

**On desktop:** VS Code persists workspace state natively across restart
— if you closed a workspace with three folders, it reopens with three
folders. The cold-start snapshot-restore is therefore redundant on
desktop. `onStartupFinished` still fires (waking the extension on every
desktop startup, even when the user isn't going to touch any of its
features that session), which costs activation latency.

**What to consider:** gate the `onStartupFinished`-driven restore code
path on `uiKind === Web`. The event itself can stay (implicit activation
events are sufficient on desktop), but the restore handler should
short-circuit on desktop and let activation lazily fire on first use of
a contribution.

---

### 7. Workspace snapshot silent restore

**Where:** `src/sync/restoreFlow.ts`, `src/sync/snapshotStore.ts`.

**What it does:** Captures the open-folder set + known workspace
settings to `.admin-sync.jsonc` on every topology change; on cold
activation in a folderless tab, reads the snapshot pointer from
`globalState` and re-mounts the folders via `updateWorkspaceFolders`.

**On desktop:** The cold-restore is redundant (see item 6). Worse, on
desktop it could *surprise* a user: if they removed a folder from their
workspace last session, then reopen the workspace today, the extension's
restore would silently add it back. The user's reaction is reasonable to
be "why is this folder back?"

**What to consider:**

- Web: keep the current behaviour exactly as-is.
- Desktop: skip the cold-restore entirely. The capture side (writing
  `.admin-sync.jsonc` on topology changes) has independent value as a
  portable workspace export — keep that; just don't read the snapshot
  back on cold start.

Gate on `uiKind === Web` in `restoreFlow`. The admin editor + Show /
Clear / Refresh commands stay useful on both platforms (they're
inspectors of the snapshot file, not auto-restore triggers).

---

### 8. `.admin-sync.jsonc` UX framing on desktop

**Where:** `src/sync/adminEditorHtml.ts`, the toast copy in
`restoreFlow.ts`.

**Why this matters:** The admin editor and its toasts use phrasing like
"workspace restored from snapshot" that's specific to the web's
folder-loss-on-refresh problem. On desktop, the file is a portable
workspace export, not a restore artefact. A user opening it for the
first time on desktop sees copy that doesn't match the behaviour they
just experienced.

**What to consider:** when restore is gated to web (item 7), either
(a) reword the editor and toasts to be platform-neutral ("workspace
export" / "workspace snapshot") and let the web-specific restore-fired
toast be a separate, web-only string, or (b) keep two strings, one per
platform. Either works; both are cosmetic.

---

## External I/O (CSP-bound on web)

### 9. Upload-via-dropbox relay path

**Where:** `pptx-upload-via-dropbox-plan.md` (in flight per memory),
`pptxViewer.dropboxBaseUrl` setting in `package.json`.

**Why it's like this:** vscode.dev's webview CSP `connect-src` blocks
direct external HTTP from the webview iframe, so the upload-to-update
feature routes through a relay server. The relay is necessary on web.

**On desktop:** Webview CSP is more permissive; the webview can post
directly to the destination origin. The relay becomes unnecessary
overhead.

**What to consider:** when upload-via-dropbox actually ships, leave the
relay path as the default (it works everywhere) but allow a desktop
branch that posts directly. Probably not worth a separate code path
unless the relay becomes a UX bottleneck.

---

### 10. Activation log "build: <iso> sha=<short>"

**Where:** `src/extension.ts`, populated by the `buildInfoPlugin` in
`esbuild.config.js`.

**Why it's like this:** On vscode.dev / PWA installations, browsers
sometimes serve stale extension bundles from cache. The activation log
line lets a user instantly compare on-screen SHA vs the SHA on the
server to diagnose a stale-cache problem.

**On desktop:** No caching layer between the .vsix and the running
extension. The diagnostic is still useful for issue reports (which
version is the user running?) but the "is my cache stale" use case
doesn't apply. No action needed; just be aware the line is less
load-bearing on desktop.

---

## Storage + bundle size

### 11. IndexedDB origin scoping (parse cache, hash cache, search index)

**Where:** `src/sync/parseCacheIdb.ts`, `src/sync/hashCacheIdb.ts`,
`src/search/indexStore.ts`.

**On web:** IndexedDB is per-origin. On vscode.dev this means one cache
shared across every workspace opened from that origin. Content-addressed
keys make this safe (no privacy leak), but cache-hit-rate diagnostics
mix workspaces together.

**On desktop:** IDB is scoped to the VS Code profile + extension. Cache
isolation is per-extension-install, not per-workspace.

**What to consider:** mostly fine as-is, but the activation log
`parse-cache: idb=… warm-entries=N` is interpreted differently on each
platform. If we ever add a "clear all caches" command, the scope of
"all" differs by platform — worth a one-liner in the command's
confirmation prompt.

---

### 12. Bundle size — desktop bundle without inlined pdf.worker

**Where:** `esbuild.config.js`, two-bundle layout.

If items 1 (Node crypto) and 2 (real PDF.js worker) get split-bundle
treatment, the desktop bundle could come in around 600–800 KB
(currently 2.0 MB for the combined web bundle, of which 1.2 MB is the
inlined PDF worker). Cheap install, less RAM, faster startup. The web
bundle stays at its current size.

**What to consider:** worth quantifying *after* deciding on items 1 and
2 — these are the unlocks; the size win is a downstream consequence.

---

## Marketing / packaging

### 13. Marketplace listing wording

**Where:** `package.json` `displayName` + `description`, and the README
(now user-facing).

**Current state:** README mentions vscode.dev first and desktop as
secondary. The `description` field still reads "One-way folder sync and
pptx inspector for vscode.dev." which would be misleading on the
marketplace listing once desktop is a documented target.

**What to consider:** bump the `description` to platform-neutral
phrasing before the next marketplace publish. Trivial diff but
load-bearing for first impressions.

---

## Verification path

Before acting on any of the above, the cheap dogfood is:

1. Install the current `.vsix` on a desktop VS Code instance.
2. Open a workspace with a `.sync.jsonc` and a few `.pptx` files.
3. Run through: open viewer, drop a PDF, run sync end-to-end, open
   search panel, multi-select update.
4. Note which items above actually manifest as friction vs which are
   purely theoretical wins. Prioritise the first list.

Items 1 (hashing), 2 (PDF worker), and 7 (snapshot restore on desktop)
are the most likely to show up as real friction. Items 3–5, 9–11 are
optimisations; items 6, 8, 12, 13 are cleanups.
