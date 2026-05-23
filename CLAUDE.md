# SUBSTRATE — pptx-viewer-ext

This document describes the world an agent works within on this project: what the project is, how the dev workflow operates, what conventions apply, and where to find things. It is paired with the **project plan** at the repo root (`folder-sync-v1-plan.md`) that describes the specific feature being worked on this iteration.

Substrate changes slowly and deliberately. When reality drifts from this doc, it gets updated as a sign-off action on the relevant feature — small diffs on commit, never rewrites from scratch.

---

## What this project is

A VS Code **web extension** targeting **vscode.dev**.

The long-term goal is a **one-way folder sync tool** for vscode.dev users: read access on a source folder tree, write access on one or more destination trees, user-convened sync with a plan-gate-execute model. Full spec in `folder-sync-v1-plan.md` at the repo root.

The first feature shipped — and still part of v1 — is a **pptx viewer**. When a user opens a `.pptx` file with the extension installed, a custom read-only editor shows file metadata, content hash, three validation flags (linked external media, kiosk/window show mode, media-controls-enabled), and a thumbnail when one is embedded. The viewer's parsing layer is also the input to the sync engine's pptx validator, so the two features share code.

The choice to start with the pptx viewer was deliberate: a small, well-bounded feature to validate the dev workflow (phone-resident agent + VPS test harness + GitHub as sync bus) before tackling the larger sync surface. The workflow is now proven; focus is shifting to the sync feature.

---

## Where things live

- **Repo**: `jonathan-annett/pptx-viewer-ext` on GitHub (public). Single branch `main`, direct pushes, no PR workflow — the user is the only contributor.
- **Live test environment**: <https://vscode.sophtwhere.com>. A VS Code Web instance running on a Linux VPS behind Caddy with wildcard TLS. The extension is preloaded; visit and open a `.pptx` to see the viewer running.
- **Infrastructure documentation**: `/home/jonathan/pptx-viewer-ext-INFRASTRUCTURE.md` on the VPS. Covers Caddy, pm2, acme-dns, DNS records. Not in this repo. Read it if you're SSH'd into the VPS and need to understand what you're seeing.

---

## Codebase

Single-bundle web extension. Layout:

```
src/
  extension.ts   activation, log channel init, build-info logging
  provider.ts    CustomReadonlyEditorProvider — reads bytes, parses, renders
  pptx.ts        parse pptx bytes → ParseResult (zip via fflate, tolerant regex)
  webview.ts     ParseResult → HTML string (theme-aware CSS, inline)
  log.ts         OutputChannel + DevTools console mirror
  sync/          folder-sync feature — see below for the pure/wired split
schemas/
  sync.schema.json  JSON Schema for .sync.jsonc — registered via
                    contributes.jsonValidation; powers IntelliSense in the
                    raw-text editor
test/
  parse.test.ts  Node-runnable smoke tests via tsx — `npm run test:parse`
  sync-*.test.ts pure-module sync tests, one per concern (jsonc, glob, plan,
                 planview, executor, config-editor, snapshot)
scripts/
  fix-cpus.cjs        Termux compat shim (clamps os.cpus() for vsce)
  fix-platform.cjs    Termux compat shim (spoofs process.platform for playwright)
  fix-koa-proxy.cjs   Reverse-proxy support (patches Koa to honour X-Forwarded-Proto)
  publish-web.cjs     Atomic GitHub Pages deploy via git data API
esbuild.config.js     Single-bundle build; includes a post-build plugin that
                      rewrites a placeholder string in dist/extension.js with
                      a fresh JSON payload of build time + git SHA per rebuild.
ecosystem.config.cjs  pm2 process layout (used on the VPS).
```

`package.json` uses the `"browser"` entry (web-extension target), no `"main"` field. The esbuild build uses `platform: 'browser'`, format CJS (VS Code's web loader uses CommonJS-style `require`).

Runtime dependencies are kept minimal: `fflate` for zip handling, `jsonc-parser` for `.sync.jsonc` config + modification (the same parser VS Code ships internally), and browser-native `crypto.subtle` for hashing. No frameworks. Bundle size matters — this is a web extension and load time is part of the user experience.

---

## Dev workflow

The phone-resident agent does its work in Termux on Android, pushing to GitHub. The VPS pulls and rebuilds. The agent does not run vscode.dev locally — testing happens on the live VPS test harness.

### The 90% path

```
phone agent edits src/*.ts  →  commit  →  push to origin/main
                                       ↓
agent (or user) runs `git pull` on the VPS in the repo dir
                                       ↓
pm2-managed esbuild --watch picks up the change via inotify
                                       ↓
dist/extension.js rebuilt in ~20ms
                                       ↓
user hard-reloads the browser tab on vscode.sophtwhere.com
                                       ↓
new code runs
```

That's the loop. Most cycles need nothing more.

The user runs vscode.sophtwhere.com as an installed PWA on macOS. **Cmd-R reliably reloads the PWA window** and picks up the freshly-built `dist/extension.js` — same behaviour as a hard reload in a Chrome tab, no DevTools or service-worker dance required. If a future change starts misbehaving on PWA refresh (stale bundle, persistent state), the activation log line `[pptx-viewer] build: <iso> sha=<short>` in the Output Channel / DevTools console is the diagnostic: SHA on screen ≠ SHA on the VPS means the PWA cached a stale bundle and something needs hardening.

### Agent VPS access

The phone agent has SSH access to the VPS as `jonathan@vscode.sophtwhere.com`. The checkout lives at `~/pptx-viewer-ext`. The pm2 process layout: `pptx-watch` (esbuild `--watch`) and `pptx-dev-server` (Koa test-web server).

What the agent can do unprompted:

- `git pull --ff-only origin main` in the repo dir right after pushing — closes the loop without making the user switch terminals. `--ff-only` makes any unexpected divergence a loud failure instead of an implicit merge.
- Read-only verification: `git log`, `git rev-parse`, `pm2 logs <name> --nostream`, `pm2 jlist`, file reads, `npm run test:*`.
- Inspect the embedded `gitSha` in `dist/extension.js` to confirm a rebuild fired (grep for `buildTime` / `gitSha`).

What the agent should ask about first:

- `pm2 restart` of any process — interrupts the live test harness for whoever is using it.
- `npm install` on the VPS — mutates `node_modules`; may require a watcher restart afterwards.
- Edits to anything outside the git checkout (Caddyfile, systemd units, infra docs).
- Any action in the exceptions table below — the agent can perform them, but they're exception-path operations and warrant a heads-up.

### Local smoke test before pushing

`npm run test:parse` runs `test/parse.test.ts` under Node via tsx. It exercises the parser against synthetic in-memory zips covering each code path (normal, warnings, malformed, thumbnail extraction). Cheap, no VS Code dependency — run it before any push that touches `src/pptx.ts`.

### Exceptions — extra step on the VPS

| If the diff touches… | Also run after the pull |
|---|---|
| `package.json` deps or `package-lock.json` | `npm install` |
| `scripts/*.cjs` preloads, or `package.json` `scripts` entries | `pm2 restart pptx-dev-server` |
| `esbuild.config.js` | `pm2 restart pptx-watch` (the watcher loads the config once, on startup) |
| Multiple of the above | each, in that order |

If a push appears not to have taken effect, the first thing to check is `pm2 logs pptx-watch` for the rebuild line. Absent → `pm2 restart pptx-watch`. The activation log `[pptx-viewer] build: <iso> sha=<short>` printed in the browser DevTools console makes a stale browser cache visible at a glance — the SHA there should match `git rev-parse --short HEAD` on the VPS.

### Cross-environment pattern

The project runs in two environments: **Termux on Android** (where the phone agent does local work, e.g. running tests) and **the Linux VPS** (where the live server runs). The preload-script pattern handles environment differences without per-host branching:

- `scripts/fix-cpus.cjs`, `scripts/fix-platform.cjs` — Termux compatibility shims; no-op on Linux.
- `scripts/fix-koa-proxy.cjs` — Reverse-proxy support for the test-web instance behind Caddy; no-op when not behind a proxy (Termux falls through because `X-Forwarded-Proto` is absent).

Same `package.json` runs in both environments; runtime conditions select the behaviour. When adding tooling that needs environment-specific handling, follow this pattern rather than branching by hostname.

### Things to keep in mind when committing

- `dist/` is gitignored. Don't commit local builds; the VPS rebuilds from `src/`.
- `.vscode-test-web/` is gitignored.
- Don't remove the preload scripts. All three are still needed across environments.
- The `open-in-browser` script preloads both `fix-platform.cjs` and `fix-koa-proxy.cjs`. If you rewrite the script, preserve both `--require` flags.

### Commit style

From `git log`: short imperative present tense — "Add X for Y", "Fix X". The user has approved including `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` on agent-authored commits.

---

## Conventions and user preferences

- **Plain Node, no frameworks unless they earn their keep.** Applies to build tooling, runtime libraries, and UI. Prefer platform primitives. The current dependency footprint reflects this — `fflate` and not much else.
- **Single-file until it doesn't.** Start with one module; split when the file is genuinely doing too much, not preemptively.
- **No Node APIs in extension code.** This is a web extension. `vscode.workspace.fs` for files, URIs not paths, `crypto.subtle` not Node `crypto`. Build scripts and preload shims are CJS Node code and that's fine — but anything that ends up in the worker-context bundle must be platform-clean.
- **Webview CSP is explicit.** The webview HTML carries its own `<meta http-equiv="Content-Security-Policy">`. The current policy is `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-<random>';`. Inline scripts are gated by a per-render nonce generated by `makeNonce()` in `src/provider.ts` and threaded through `renderHtml(result, nonce)`; remote scripts and unsafe-inline scripts are not allowed. When adding a new resource type to the panel (fonts, external images, additional scripts), widen the policy in `src/webview.ts` deliberately, not by removing it — and keep the nonce gate in place for any new inline script.
- **Defensive parsing.** Files in the wild are inconsistent. Show "unknown" for missing fields, never crash the editor or sync engine on malformed input. The viewer's whole purpose is to inspect potentially-problematic files; the sync engine has to keep going across heterogeneous source trees.
- **CSS help with explanation.** The user is fluent in JavaScript but finds CSS more opaque. When CSS comes up (likely in `src/webview.ts` and any sync-feature UI work), be generous with styling help and *explain the rules being applied* so the lesson lands.
- **Pure / vscode-wired split for testable modules.** A module that does data shaping or rendering should not `import * as vscode`; the vscode-touching half lives in a sibling module that imports the pure one. The sync feature follows this throughout — `plan.ts` (pure classifier) vs `planner.ts` (vscode-driven walk+hash), `manifest-types.ts` (pure data) vs `manifest.ts` (vscode I/O), `planHtml.ts` (pure renderer) vs `planView.ts` (vscode panel wiring). The payoff is that each pure module gets a `test/sync-*.test.ts` runnable under plain Node via tsx — no vscode shim needed. When adding a new webview or new transform, follow the same split rather than reaching for a test double.

---

## Dead ends — don't relitigate

Things tried and found wrong. Don't propose them again without new evidence:

- **"Install Extension from Location…" in vscode.dev does NOT work for github.io URLs.** vscode.dev's CSP `connect-src` blocks fetches to non-allowlisted origins. The VPS test harness sidesteps this entirely; we don't need github.io.
- **Signing is not the issue.** `vsce` signing is for marketplace distribution, not sideloading or self-hosted test-web.
- **Web extensions DO use CJS.** A previous diagnosis claiming they require ESM was wrong. Don't change the bundle format.
- **`activationEvents` mostly auto-infer — except `onStartupFinished`.** Events derived from `contributes.customEditors`, `contributes.commands`, etc. are added implicitly since VS Code 1.74. The exception is anything that needs to fire on a folderless cold start (no file open, no folder mounted, no command invoked yet). M4.6 silent restore needs `"onStartupFinished"` explicitly because nothing else triggers activation in a folderless tab. Rule of thumb: don't add events that duplicate implicit ones; do add events that no contribution implies.
- **Adding the first folder via `updateWorkspaceFolders` does NOT restart the extension host in vscode.dev (the web host).** Desktop VS Code docs warn about a host restart when `workspaceFolders[0]` is created, removed, or changed (the deprecated `rootPath` updates). Empirically (M4.6 silent restore validation, 2026-05-19), the web host keeps the activation alive — settings applied *after* `updateWorkspaceFolders` in the same async function persist normally. The "pending-settings flag" pattern in `src/sync/restoreFlow.ts` is defensive against the desktop behaviour; the same-activation branch always runs on vscode.dev. If/when the project ever publishes to desktop, the flag becomes load-bearing.
- **`vscode.workspace.fs.readFile` against `context.extensionUri` hangs in the web-extension host.** The web worker hosting the extension has no FS provider registered for the scheme backing `extensionUri`, so the promise never resolves *or* rejects — error-handling catch blocks never fire. Diagnostic data that needs to live alongside the bundle should be inlined into the bundle (see the build-info placeholder pattern in `esbuild.config.js`), not read at runtime.
- **esbuild's `define` substitution is frozen at watch-mode context creation.** Mutating `build.initialOptions.define` in `onStart` has no effect on subsequent rebuilds. The build-info logging uses a post-build `onEnd` hook that text-replaces a placeholder string in `dist/extension.js` — that fires per rebuild and the rewrite target isn't in esbuild's watch graph, so no feedback loop.
- **Atomic tmp+rename writes close any custom editor open on the target.** `vscode.workspace.fs.writeFile(tmp)` + `fs.rename(tmp, final, { overwrite: true })` replaces the file on disk; VS Code surfaces this as the backing `TextDocument` being disposed and a new one created, which closes any `CustomTextEditorProvider` bound to it. Symptom: the admin editor panel disappears mid-rename. Fix in `src/sync/snapshotStore.ts` `writeSnapshot`: when a `TextDocument` is already open at the target URI, route through `workspace.applyEdit` + `TextDocument.save()` so the change goes through the document model — the editor stays alive and receives `onDidChangeTextDocument`. Atomic path is preserved for the no-editor-open case. Same gotcha applies to `writeManifest`; if a custom editor is ever wired to `.foldersync-manifest.json`, apply the same pattern.
- **Anchor-driven downloads from the webview iframe are blocked on vscode.dev.** A `<a href="blob:…" download>` click inside a `CustomEditorProvider` webview either silently no-ops or opens the blob in a new tab — vscode.dev's iframe sandbox strips the download intent. The working pattern is to round-trip through the extension host: the webview posts `{type:'…'}`, the extension reads/produces the bytes, calls `vscode.window.showSaveDialog()` to pick a target URI, and writes via `vscode.workspace.fs.writeFile(target, bytes)`. This is how both the Save As button and the Extract media row land bytes on the user's machine. When adding any new "save a file" affordance to the viewer, do *not* attempt anchor-download; mirror the existing handler.
- **pdfjs-dist v5 dropped `disableWorker` as a getDocument option.** The new `PDFWorker` constructor only honours `name`/`port`/`verbosity`. Passing `{ data, disableWorker: true }` to `getDocument` is silently ignored; `PDFWorker.#initialize` falls through to reading `GlobalWorkerOptions.workerSrc`, which throws `No "GlobalWorkerOptions.workerSrc" specified` if not set. Setting `workerSrc = ''` doesn't help — empty string is falsy and the getter rejects it the same way. The working fake-worker path in v5 is to side-effect-import `pdfjs-dist/build/pdf.worker.min.mjs`: its top-level code assigns `globalThis.pdfjsWorker = { WorkerMessageHandler }`, which `PDFWorker.#initialize` checks *before* consulting `workerSrc`. Cost: the worker module gets bundled (~1.2 MB minified into the IIFE) but no URL ever needs to be fetched from the webview sandbox. See `src/pdfImportWebviewEntry.ts`. If pdfjs-dist is ever downgraded to v4, the side-effect import becomes a no-op and `disableWorker: true` works again — leave the shim in place.
- **esbuild's text-rewrite placeholders need to be the entire quoted literal, not a bare token.** The `pdfImportBundlePlugin` in `esbuild.config.js` inlines `dist/pdfImport.webview.js` into `dist/extension.js`. The first attempt replaced a bare placeholder string with the raw bundle source — instantly broken because the IIFE contains its own `"…"` and `'…'` characters, which broke the host string. The fix: match the *quoted* literal in either single or double quotes (`/(['"])__PPTX_PDFIMPORT_WEBVIEW_BUNDLE_PLACEHOLDER__\1/`) and substitute `JSON.stringify(bundleSrc)` — that handles every embedded quote and escape correctly regardless of which quote style esbuild emitted around the placeholder. Same principle applies to any future inline-string-replacement plugin: rewrite the literal *including its delimiters*, and let `JSON.stringify` do the escaping.
- **`main.vscode-cdn.net` CORS errors in the browser console are not from this extension.** VS Code Web itself fetches `extensions/marketplace.json` and `extensions/chat.json` from Microsoft's CDN to populate the "Featured" extensions tab and Copilot Chat surfaces. The CDN returns 200 without `Access-Control-Allow-Origin`, the browser blocks reading, the affected UI tabs stay empty. The requests go browser → CDN directly, bypassing Caddy and our Koa server, so we can't intercept them with a middleware. Cosmetic; ignore unless something downstream actually needs that data.

---

## What's currently shipping

- **Pptx viewer custom editor**, verified working on the live URL. Shows file name, size, mtime, SHA-256, slide count, hidden slide count, author, last-modified-by, embedded media list, and three validation flags:
  - **Linked media** — warn when any slide has a `Relationship` with a media type and `TargetMode="External"`.
  - **Show type** — warn when `<p:showPr>` contains `<p:kiosk/>` or `<p:browse/>`. Presenter mode (default) is the pass case.
  - **Show media controls** — warn only when *both* `showMediaCtrls` resolves to on (explicit `val="1"`, or absent — PowerPoint's ECMA-376 default is on) *and* at least one embedded video part exists. Controls-on with no embedded video, or audio-only files, are intentional passes — there is no on-screen controls bar to worry about.
- **Real-world samples in `samples/`** — five `.pptx` files covering each flag state (kiosk, browse/window, controls explicitly off, controls implicit-on with no video, controls implicit-on with embedded video). Checked into the repo and exercised by `testRealSamples` in `test/parse.test.ts` alongside the synthetic-zip cases.
- **Thumbnail extraction.** Pulls `docProps/thumbnail.{jpg,jpeg,png,gif,webp}` from the zip and renders it as a `data:` URL `<img>` under the filename. EMF thumbnails are deliberately skipped — browsers can't render them. A file with no thumbnail (or only `.emf`) shows just the filename, which is the prior layout.
- **Build-info logged at activation.** `[pptx-viewer] build: <ISO timestamp> sha=<short git SHA>` printed to the Pptx Info output channel and DevTools console. Implemented by an esbuild `onEnd` plugin that text-replaces a placeholder string in the emitted bundle on every (re)build; the runtime side reads the inlined JSON. Lets the user instantly tell whether a stale browser cache is serving an old bundle.
- **Per-file parse log.** `[pptx-viewer] parsed: <name> — <bytes> bytes, <N> slides (<M> hidden), <W> warning(s), thumbnail: <mime+size | none>` printed per file open. Diagnostic only — no behavioural effect.
- **Download button.** Primary-styled button under the filename. Click → webview posts `{type:'download'}` to the extension → extension re-reads bytes from `document.uri` via `vscode.workspace.fs.readFile` (not retained after parse) → posts them back as `Uint8Array` → webview wraps in a `Blob` and triggers a hidden `<a download>` click. Browser handles the save dialog. A `download:` line is logged per click.
- **PDF → PPTX import.** Drag a `.pdf` onto the viewer (or pick one via the Update… affordance) and a config modal appears inside the existing webview. Defaults: 16:9 aspect, 1920px long-edge resolution, letterbox on, JPEG @ quality 0.85. The pipeline is render → encode → build, split so format/quality tweaks re-encode in place without re-running PDF.js; aspect/resolution changes go through a "Re-render" button. The output `.pptx` is posted through the existing `ingest` channel as `source: 'picker'` so the compare-modal step is skipped (the user just affirmed via the modal). The first slide's already-encoded bytes are also written verbatim to `docProps/thumbnail.<ext>` with the `metadata/thumbnail` relationship, so the viewer's existing thumbnail extractor picks it up on the immediate re-parse — this is the *only* place we ever write a thumbnail into a pptx; every other file stays byte-identical (hash stability is identity for the parse cache, URI hash cache, planner, and misfiling guard). On import the picker path also evicts the entry for the imported file's sha256 from the parse cache before writing, so the post-write `parsePptxCached` call misses for that one sha and repopulates with the fresh result — net effect is a scoped *replace*, not a flush. Code lives across `src/pdfImport.ts` (three-phase pipeline), `src/pdfImportLayout.ts` (pure letterbox math), `src/pdfImportConfigHtml.ts` (pure modal renderer), and `src/pdfImportWebviewEntry.ts` (the IIFE entry that loads pdfjs-dist). The webview bundle is a separate esbuild target (`buildOptionsWebview` in `esbuild.config.js`) text-inlined into `dist/extension.js` via a `pdfImportBundlePlugin` placeholder rewrite — pdfjs-dist runs in the DOM-having webview iframe, no asset URLs need to traverse vscode.dev's CSP. New dep: `pdfjs-dist@^5.7.284`. Bundle size: `dist/extension.js` ~2.0 MB (was ~366KB pre-M-VE-1); the +1.6 MB is the inlined webview IIFE, of which ~1.2 MB is the `pdf.worker.min.mjs` side-effect import that puts the fake-worker handler on `globalThis`. The bundle only lands when the viewer panel opens, not on activation. Thumbnails in the panel render at a fixed 240px height with `width: auto` so every file's thumbnail occupies the same vertical slot regardless of source dimensions.
- **Extract embedded media.** When a deck has at least one embedded video, an "Extract media:" row appears below the action buttons: a dropdown lists each video as `${basename} — slide N` / `slides N, M` / `unused` (orphan), and the Extract button writes the chosen entry via the extension-side `vscode.window.showSaveDialog` + `vscode.workspace.fs.writeFile` (same pattern as Save As — anchor downloads from the webview iframe are blocked on vscode.dev). The parser side, in `src/pptx.ts`, walks `ppt/slides/_rels/slide*.xml.rels` and builds a sibling field `mediaFiles: MediaFileEntry[]` (`{mediaPath, mime, sizeBytes, slides: number[]}`) alongside the existing aggregate `embeddedMedia`; orphan entries (no slide rels reference) are included with `slides: []` and are still extractable. v1 scope is video mimes only — audio/image parts are filtered out of the dropdown but still counted in the aggregate row. Re-reads + re-unzips the file on each click; no in-memory video cache. `[pptx-viewer] extracted: <path> — <bytes> bytes → <target>` is logged per successful extraction.
- **Folder Sync — M1 through M4.5 shipped.** `.sync.jsonc` (post-M4.5 pivot from `.sync.yaml`) discovery, topology resolution with hot reload, status bar item, and a categorised plan webview (`folderSync.openPlan` — palette only for now). The webview renders all six operation categories as collapsible `<details>` sections, with a traffic-light footer: green Proceed wired (clean plans), orange + red on collisions (orange not yet wired — lands in M5). The Output Channel still has `folderSync.dryRunPlan` for text-form debugging. Execution (writes + manifest persistence) shipped in M4.

  M4.5 added a custom text editor for `.sync.jsonc` (`folderSync.configEditor`): form fields for destinations (dropdowns of workspace folder names), subpath, include/exclude textareas, with form↔text two-way sync via `jsonc-parser`'s `modify()` API. A bundled JSON Schema at `schemas/sync.schema.json` provides IntelliSense + red squiggles in the raw-text editor. "Dry run" from the editor opens the workspace-wide plan webview in a separate panel.

- **Folder Sync — M4.6 silent restore + admin editor shipped.** A workspace snapshot system that persists the open-folder set + known workspace settings to `.admin-sync.jsonc` at the root of `workspaceFolders[0]`, with a `context.globalState.folderSync.snapshotPointer` cold-start hint. On a folderless activation (the state vscode.dev refreshes into) the extension reads the pointer, re-mounts the folders via `updateWorkspaceFolders`, applies known settings, and surfaces a single `Workspace restored from snapshot · Undo` toast. The capture path subscribes to `SyncManager.onDidChange` and atomically writes (tmp + rename) when the captured shape differs from on-disk — no-op writes are skipped via `snapshotsEqual`. Settings capture is currently restricted to `KNOWN_WORKSPACE_KEYS` (`files.readonlyInclude`, `files.readonlyExclude`); full-blob capture is M4.6 follow-up work.

  Module layout follows the pure/wired convention:
  - `src/sync/snapshot.ts` — types, marshal/parse JSONC, equality. tsx-testable, no vscode import.
  - `src/sync/snapshotStore.ts` — globalState pointer + atomic file I/O + `captureCurrent()` from vscode state.
  - `src/sync/restoreFlow.ts` — orchestrates cold-restore + post-restart settings apply + the topology-change writer + the Show/Clear commands. Exports `captureAndWriteSnapshot()` for force-recapture (used by the admin editor's Refresh button).
  - `src/sync/adminEditorHtml.ts` / `src/sync/adminEditor.ts` — pure renderer + wired `CustomTextEditorProvider` for `.admin-sync.jsonc`. View-only by design (file is managed automatically); affordances are Rename-folder per row (routes through `updateWorkspaceFolders` then the writer rewrites the file), Refresh, Clear, and Reopen as text.
  - `src/sync/probe.ts` — throwaway `folderSync.probeColdRead` diagnostic; stays in the tree until M4.6 is fully signed off in case a regression needs the same flow.

  Commands: `folderSync.showSnapshot`, `folderSync.clearSnapshot`, `folderSync.openAdminConfig`.

- **Folder Sync — M5.2.5 URI hash cache shipped.** A two-tier cache keyed by `(uri, size, mtime) → sha256`, sitting between the planner/executor and `vscode.workspace.fs.readFile`. The in-memory tier is a bounded `Map<string, …>` keyed by `uri.toString()`; the IndexedDB tier (opened via `src/sync/hashCacheIdb.ts`) is a write-through layer that survives browser refresh and silently degrades to in-memory-only if IDB isn't reachable from the worker context. Public entrypoint is `hashFileAtUri(fs, uri, cache?, { needBytes? })` in `src/sync/hash.ts` — callers that need bytes (viewer, executor) pass `needBytes: true`; callers that only need the hash (destination walks) pass `false` and skip the read entirely on cache hit. Wired into `planner.ts` source + destination walks and `executor.ts` pre-write verify; the singleton is set at activation in `extension.ts` and read by planner/runSync via `getHashCacheSingleton`. Activation log: `hash-cache: idb=<available|unavailable> warm-entries=<N>`; per-sync-run log surfaces hits/total + bytes saved per destination. The M5.2.5 probe (`src/sync/probeStat.ts` + `folderSync.probeStat`) was removed at sign-off; `src/sync/probe.ts` for M4.6 stays until M4.6 itself is signed off. The same IDB adapter is the planned foundation for M5.3's `sha256 → ParseResult` cache.

- **Folder Sync — M6 polish shipped (v1 Definition-of-Done complete).** Six phases that filled the gap between "execution works" and "shippable v1":
  - **M6.A** — Status bar primary action: clicking the item opens the workspace plan (`folderSync.openPlan`) in the healthy state, falls back to `showTopology` for empty / error states.
  - **M6.B** — Explorer context menu + folder-scoped invocation. `folderSync.syncThisFolder` registered under `7_modification@10` with `when` = `explorerResourceIsFolder && folderSync.hasAnySource` (a context key written from `manager.onDidChange`). Source-side clicks open the scoped plan against the nearest enclosing source; destination-side clicks reverse-map through `destRootUri` to the equivalent source path, so the plan the user sees matches the one they'd see right-clicking the mirror folder. `openPlanPanel` takes optional `{ scope, title }` so scoped panels live alongside the workspace-wide one with folder-specific tab titles.
  - **M6.C** — Orphan `.tmp` cleanup. `**/*.tmp` added to `BUILT_IN_IGNORES` so an interrupted atomic write no longer surfaces as a fake destination-only entry. Pre-execute sweep in `runSync.ts` walks each `destRootUri` and removes orphan `*.tmp` files before the run; pure `sweepOrphanTmpFiles` in `src/sync/orphanSweep.ts` (tsx-tested) + thin vscode-wired adapter in `src/sync/orphanSweepWired.ts`.
  - **M6.D** — Manifest version-mismatch refusal. `readManifest` returns a discriminated `ManifestReadResult` (`{ kind: 'ok' }` / `{ kind: 'version-mismatch', actual }`). Planner surfaces mismatches as `skippedReason`, `runSync` collects them into `summary.manifestVersionMismatches`, and both green-path proceed surfaces (workspace plan panel + per-file sync from the viewer) show a warning toast via `surfaceManifestVersionMismatches()` in `planView.ts` with `Open Manifest` / `Show Details` actions. Writing a v1 manifest over an unknown schema would clobber the user's prior tracking, so refusal is the safe default.
  - **M6.E** — Manifest custom editor (`folderSync.manifestEditor`, `filenamePattern: **/.foldersync-manifest.json`). View-only tabular renderer: header (version + lastSync + destination root), sorted entries table (key / dest path / humanised size / sha-first-12 with full-hash tooltip / relative-time synced-at with ISO tooltip), sorted decisions table (✓/– flag glyphs for `destOnlyDelete` / `collisionOverwrite` / `warningOverride` + decided-at), version-mismatch banner replacing tables when `readManifest` returns the mismatch variant, Reopen-as-text escape hatch. Pure renderer + view-model in `src/sync/manifestEditorHtml.ts` (`renderManifestEditorHtml`, `toManifestViewModel`, `humaniseSize`, `relativeTime`), wired provider in `src/sync/manifestEditor.ts` re-rendering full HTML on `onDidChangeTextDocument` so the executor's mid-sync writes refresh the editor live. The parse helper was extracted into `manifest-types.ts` as `parseManifestText` / `normaliseManifest` so the editor and `readManifest` share one parser (same pattern as `parseSnapshot` / `parseSyncConfigText`).
  - **M6.F** — DoD walkthrough + sign-off. All 9 v1 DoD bullets verified against the code. This bullet is the sign-off.

---

## Open project decisions

- **Publishing path** — not yet chosen. Options are Marketplace pre-release, Open VSX, or `.vsix`-only distribution. Decision deferred until the sync feature is closer to v1.

---

## Project plans

Project plans live at the repo root and are the per-iteration instruction set the agent works against. Substrate (this doc) is the world the plan operates in. They have different lifecycles and should not be merged.

Current plan:

- `folder-sync-v1-plan.md` — **active target.** Adds folder sync to the extension alongside the existing pptx viewer. The next major piece of work.

---

## Pointers to other context

- `/home/jonathan/pptx-viewer-ext-INFRASTRUCTURE.md` on the VPS — TLS, reverse proxy, pm2, DNS, certs.
- `~/projects/CLAUDE.md` — the user's wider preferences across projects. The load-bearing pieces are inlined in "Conventions and user preferences" above, but read the full file for additional context.
- `~/.claude/projects/.../memory/MEMORY.md` — auto-memory index, user profile, GitHub auth notes.

---

## Updating this doc

When a feature lands, propose substrate updates as part of the sign-off rather than as a separate task. Cheap to do in one sitting; expensive to reconstruct later when reality has drifted further. Reviewing a small diff to this file is easier than rebuilding it from scratch.
