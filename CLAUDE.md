# SUBSTRATE — pptx-viewer-ext

This document describes the world an agent works within on this project: what the project is, how the dev workflow operates, what conventions apply, and where to find things. When a feature iteration is active, it's paired with a per-iteration plan doc at the repo root (`<feature>-vN-plan.md`); see the "Project plans" section below for the current index.

Substrate changes slowly and deliberately. When reality drifts from this doc, it gets updated as a sign-off action on the relevant feature — small diffs on commit, never rewrites from scratch. Per-feature as-shipped surface detail lives in `SHIPPED.md` (kept out of here to keep this doc lean for subagents).

---

## What this project is

A VS Code **web extension** targeting **vscode.dev**.

The long-term goal is a **one-way folder sync tool** for vscode.dev users: read access on a source folder tree, write access on one or more destination trees, user-convened sync with a plan-gate-execute model. Full spec in `folder-sync-v1-plan.md` at the repo root.

The first feature shipped — and still part of v1 — is a **pptx viewer**. When a user opens a `.pptx` file with the extension installed, a custom read-only editor shows file metadata, content hash, three validation flags (linked external media, kiosk/window show mode, media-controls-enabled), and a thumbnail when one is embedded. The viewer's parsing layer is also the input to the sync engine's pptx validator, so the two features share code.

The choice to start with the pptx viewer was deliberate: a small, well-bounded feature to validate the dev workflow (remote agent + VPS test harness + GitHub as sync bus) before tackling the larger sync surface. The workflow is now proven; focus is shifting to the sync feature.

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

The agent does its work locally on the user's MacBook (project at `/Users/jonathanannett/projects/pptx-viewer-ext`), pushing to GitHub. The VPS pulls and rebuilds. The agent can also build and run tests locally, but the agent does not run vscode.dev locally — the live runtime target stays the VPS test harness, which serves vscode.sophtwhere.com from the same source tree.

Historical note: the agent previously lived in Termux on Android and the push-pull-VPS loop was the only build path. As of 2026-05-25 the project moved to macOS; the VPS test harness stays in place as the closest-to-production runtime. The Termux compat shims (`scripts/fix-cpus.cjs`, `scripts/fix-platform.cjs`) are now inert but retained — see Cross-environment pattern.

### The 90% path

```
agent edits src/*.ts on macOS  →  commit  →  push to origin/main
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

Local fast path (optional, MacBook-only). For typecheck/smoke-test before pushing: `npm run bundle` produces `dist/extension.js` locally in a few hundred ms, and any `npm run test:*` script runs under Node via tsx. Neither exercises the vscode.dev runtime, so the VPS pull-rebuild-reload loop is still the way to verify behaviour on the live target — but a green local build catches type errors and test regressions before they cost a push round-trip.

The user runs vscode.sophtwhere.com as an installed PWA on macOS. **Cmd-R reliably reloads the PWA window** and picks up the freshly-built `dist/extension.js` — same behaviour as a hard reload in a Chrome tab, no DevTools or service-worker dance required. If a future change starts misbehaving on PWA refresh (stale bundle, persistent state), the activation log line `[pptx-viewer] build: <iso> sha=<short>` in the Output Channel / DevTools console is the diagnostic: SHA on screen ≠ SHA on the VPS means the PWA cached a stale bundle and something needs hardening.

### Agent VPS access

The agent has SSH access to the VPS as `jonathan@vscode.sophtwhere.com` from the MacBook. The checkout on the VPS lives at `~/pptx-viewer-ext`. The pm2 process layout: `pptx-watch` (esbuild `--watch`) and `pptx-dev-server` (Koa test-web server).

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

The project currently runs in two environments: **macOS** (where the agent does local work — edits, builds, tests) and **the Linux VPS** (where the live test harness serves vscode.sophtwhere.com). It previously also ran in **Termux on Android**, which is why three preload-script shims exist. The pattern handles environment differences without per-host branching:

- `scripts/fix-cpus.cjs`, `scripts/fix-platform.cjs` — Termux compatibility shims; no-op on macOS and Linux. Inert in the current setup but retained so the project can be pulled back into Termux without re-inventing the workarounds.
- `scripts/fix-koa-proxy.cjs` — Reverse-proxy support for the test-web instance behind Caddy on the VPS; no-op when not behind a proxy (macOS and Termux both fall through because `X-Forwarded-Proto` is absent).

Same `package.json` runs across all three environments; runtime conditions select the behaviour. When adding tooling that needs environment-specific handling, follow this pattern rather than branching by hostname.

### Things to keep in mind when committing

- `dist/` is gitignored. Don't commit local builds; the VPS rebuilds from `src/`.
- `.vscode-test-web/` is gitignored.
- Don't remove the preload scripts. `fix-koa-proxy.cjs` is actively load-bearing on the VPS; the Termux shims (`fix-cpus.cjs`, `fix-platform.cjs`) are inert on macOS but retained against a future return to Termux.
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
- **The `EMPTY_FILE_SHA256` constant is intentionally duplicated between `src/sync/snapshot.ts` and `src/pptx.ts`.** Both want the literal `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` — the snapshot module uses it for the placeholder registry's implicit default; the parse path uses it inside the zero-byte short-circuit to skip the actual `crypto.subtle.digest` call. Importing `snapshot.ts` from `pptx.ts` would be a backward dependency (pptx is foundational; sync builds on it). The value is mathematically immutable — empty bytes hash to exactly this string forever — so the duplication carries zero maintenance risk. The constants are marked with cross-reference comments in both modules.

---

## What's currently shipping

Live on `vscode.sophtwhere.com`. Per-feature as-shipped detail (UX, modules, message flows, gotchas) lives in `SHIPPED.md`. Design rationale + milestone history lives in the per-feature plan files where applicable.

- **Pptx viewer family.** Custom editor with metadata + three validation flags (linked media, show mode, media controls + embedded video) + in-file or M-VE-3-synthesised fallback thumbnail. Save As / Update… / drag-drop ingest (compare modal when content differs, info modal when identical). PDF → PPTX import via drag-drop or Update… (M-VE-1; ~1.6 MB inlined webview bundle for pdfjs-dist). Extract embedded video parts (M-VE-2). Build-info + per-file parse log on every open.
- **Folder Sync v1 — complete, DoD signed off 2026-05-23.** `.sync.jsonc` config + JSON Schema IntelliSense, plan-gate-execute model with traffic-light footer, manifest tracking, three custom editors (`.sync.jsonc`, `.admin-sync.jsonc`, `.foldersync-manifest.json`), explorer context menu + scoped plans, M4.6 silent restore from `.admin-sync.jsonc` snapshot, two-tier IDB caches (M5.2.5 URI hash cache + M5.3 parse cache, both with batched `snapshot()` reads). Full milestone history at `folder-sync-v1-plan.md`.
- **Presentation Search v1.** Workspace-wide debounced search panel for `.pptx` (filename / `dc:creator` / first-slide text) and `.pdf` (filename only), with click-to-open and a multi-select update flow that routes PDF→PPTX pairs through the viewer's import modal. Read-only PDF custom editor renders page 1 so click-through from search doesn't dump raw binary into a text editor. Plan + handoff: `pptx-search-v1-plan.md` + `pptx-search-v1-report.md`.
- **Placeholder files v1.** Workspace-level "this file is a stub" registry — `.admin-sync.jsonc#placeholders` array of sha256 hex (empty-file sha is an implicit, locked default). Surfaces as a per-row `[P]` chip in plan views, a three-state footer line in the standalone plan, and a blue info banner in the viewer that replaces the corrupt-file banner. Plan + handoff: `placeholder-files-v1-plan.md` + `placeholder-files-v1-report.md`.

**Cross-cutting patterns (load-bearing for new work):**

- **Layered-cache abstraction.** New derived-data stores should sit alongside existing content caches via a layered lookup (`indexStore` → `parseCache` → fresh parse), not a coordinated rewrite. The IDB adapter (`src/sync/idbAdapter.ts`) is shared infrastructure; each subsystem owns its own DB name + schema version so eviction/upgrades stay independent. Search uses `pptxSearch.index`; sync uses `folderSync.hashCache` + `folderSync.parseCache`. Both caches expose `snapshot()` for batched walks — viewer-open ~2.5s → sub-100ms on warm caches.
- **Per-file row layout.** `.row-lead` (path + chips/badges/decisions, grows + wraps) + `.row-meta` (size + hashes, intrinsic-width, anchors right) in `src/sync/planHtml.ts`. Don't slip back to size-between-path-and-affordances; layout-regression test guards against drift.
- **Pure / vscode-wired split for testable modules.** A module that does data shaping or rendering should not `import * as vscode`; the vscode-touching half lives in a sibling module that imports the pure one. The sync feature follows this throughout (see "Conventions and user preferences" above for examples).

---

## Open project decisions

- **Publishing path** — not yet chosen. Options are Marketplace pre-release, Open VSX, or `.vsix`-only distribution. Decision deferred until the sync feature is closer to v1.

---

## Project plans

Project plans live at the repo root and are the per-iteration instruction set the agent works against. Substrate (this doc) is the world the plan operates in. They have different lifecycles and should not be merged.

No active plan right now — folder-sync v1 + adjacent features are all signed off. Recently signed-off plans (handoff reports at repo root where applicable):

- `folder-sync-v1-plan.md` — folder sync feature, DoD signed off 2026-05-23. Contains the milestone history, the viewer enhancements track (M-VE-1/2/3 — PDF→PPTX import, embedded-media extraction, synthesised thumbnails), and the post-v1 roadmap (focus-following panel, authoring-UI polish, misfile guard re-wiring).
- `placeholder-files-v1-plan.md` + `placeholder-files-v1-report.md` — workspace-level placeholder registry (`.admin-sync.jsonc#placeholders`), plan-view `[P]` chip + footer count, viewer info banner. Shipped 2026-05-26.
- `pptx-search-v1-plan.md` + `pptx-search-v1-report.md` — workspace-wide search panel.

When the next iteration starts, its plan goes here as the active target.

---

## Pointers to other context

- `/home/jonathan/pptx-viewer-ext-INFRASTRUCTURE.md` on the VPS — TLS, reverse proxy, pm2, DNS, certs.
- `~/projects/CLAUDE.md` — the user's wider preferences across projects. The load-bearing pieces are inlined in "Conventions and user preferences" above, but read the full file for additional context.
- `~/.claude/projects/.../memory/MEMORY.md` — auto-memory index, user profile, GitHub auth notes.

---

## Updating this doc

When a feature lands, propose substrate updates as part of the sign-off rather than as a separate task. Cheap to do in one sitting; expensive to reconstruct later when reality has drifted further. Reviewing a small diff to this file is easier than rebuilding it from scratch.

**Where things go:**

- `CLAUDE.md` (this file) — top-level: what the project is, where things live, dev workflow, conventions, dead ends, brief shipping summary + cross-cutting patterns, project plans index. Kept lean so subagents working on specific tasks load less ambient context.
- `SHIPPED.md` — per-feature as-shipped surface detail (UX, module layout, message flows, hard-won gotchas). Update when a feature ships or its surface meaningfully changes. The brief bullets in CLAUDE.md should stay one-line-ish; depth belongs here.
- `CHANGELOG.md` — user-facing changes per marketplace version, reverse chronological. **Update as part of the release flow** (see below). The Marketplace renders it as the *Changelog* tab on the extension listing.
- Feature plans (`<feature>-vN-plan.md`) — design rationale + milestone progress, the per-iteration instruction set. Update during the iteration.
- Feature handoff reports (`<feature>-vN-report.md`, optional) — condensed pickup-from-here doc for the *next* agent working on adjacent work. Update at sign-off.

When the same fact would belong in two places, prefer one canonical home and cross-reference. Dead ends always belong in `CLAUDE.md` (load-bearing — preventing re-treading is the whole point).

### Release flow

When cutting a marketplace publish:

1. Roll the `[Unreleased]` section in `CHANGELOG.md` into a new `[<version>] — <YYYY-MM-DD>` entry just below it; open a fresh `[Unreleased]` section at the top for the next iteration.
2. Bump `package.json` `version` (matching commit / tag conventions: tag the publish commit `v<version>`).
3. Publish via `vsce` to the Marketplace; attach the `.vsix` to a GitHub release with the new changelog section copied into the release notes.

Between publishes, **as user-facing changes land, add bullets to the `[Unreleased]` section** so the changelog is always current rather than being reconstructed from `git log` at release time. Internal refactors, docs, and substrate updates don't belong in the changelog — only things a marketplace user would notice (UX, perf, fixes, new commands, new affordances).
