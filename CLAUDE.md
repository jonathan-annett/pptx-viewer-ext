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
test/
  parse.test.ts  Node-runnable smoke tests via tsx — `npm run test:parse`
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

Runtime dependencies are kept minimal: `fflate` for zip handling, browser-native `crypto.subtle` for hashing. No frameworks. Bundle size matters — this is a web extension and load time is part of the user experience.

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

---

## Dead ends — don't relitigate

Things tried and found wrong. Don't propose them again without new evidence:

- **"Install Extension from Location…" in vscode.dev does NOT work for github.io URLs.** vscode.dev's CSP `connect-src` blocks fetches to non-allowlisted origins. The VPS test harness sidesteps this entirely; we don't need github.io.
- **Signing is not the issue.** `vsce` signing is for marketplace distribution, not sideloading or self-hosted test-web.
- **Web extensions DO use CJS.** A previous diagnosis claiming they require ESM was wrong. Don't change the bundle format.
- **`activationEvents` do not need explicit entries.** They're auto-inferred from `contributes.customEditors` since VS Code 1.74. Don't add them.
- **`vscode.workspace.fs.readFile` against `context.extensionUri` hangs in the web-extension host.** The web worker hosting the extension has no FS provider registered for the scheme backing `extensionUri`, so the promise never resolves *or* rejects — error-handling catch blocks never fire. Diagnostic data that needs to live alongside the bundle should be inlined into the bundle (see the build-info placeholder pattern in `esbuild.config.js`), not read at runtime.
- **esbuild's `define` substitution is frozen at watch-mode context creation.** Mutating `build.initialOptions.define` in `onStart` has no effect on subsequent rebuilds. The build-info logging uses a post-build `onEnd` hook that text-replaces a placeholder string in `dist/extension.js` — that fires per rebuild and the rewrite target isn't in esbuild's watch graph, so no feedback loop.
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
