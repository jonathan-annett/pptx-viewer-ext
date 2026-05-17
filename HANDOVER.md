# Handover — pptx-viewer-ext

You're picking up a VS Code web extension that was bootstrapped on Termux/Android
and is being moved to a Linux VPS for final testing and (eventually) publishing.

The README documents the *what* and *how to build*. This file documents the
*where we are*, *what hasn't been verified yet*, and *what to drop now that
you're on a real Linux box*.

## Repo

- GitHub: `jonathan-annett/pptx-viewer-ext` (public)
- Branch: `main`, clean working tree as of commit `c4cf703`
- Latest release: `v0.0.3` with `.vsix` attached

Get started:

```bash
git clone https://github.com/jonathan-annett/pptx-viewer-ext.git
cd pptx-viewer-ext
npm install --ignore-scripts   # see "Termux-isms" below — --ignore-scripts is
                               # only needed if you're STILL on Android. On a
                               # real Linux box, plain `npm install` is fine.
```

## Current state

**Code:** complete. `src/` is five small files (`extension.ts`, `provider.ts`,
`pptx.ts`, `webview.ts`, `log.ts`). Parser is targeted regex over unzipped
pptx parts, not a full XML parser — deliberate, see README "Known limitations".

**Tests:** `npm run test:parse` runs 7 parser smoke tests via `tsx`. All
passing as of last commit.

**Build:** `npm run compile-web` → `dist/extension.js` (esbuild, CJS, browser
target). `npm run package` → `pptx-viewer-<version>.vsix` via `vsce`.

**Publishing pipeline that exists but isn't fully exercised:**
- GitHub Releases — `0.0.3.vsix` is uploaded manually via `gh release`.
- `npm run publish:web` — `scripts/publish-web.cjs` atomically commits
  `package.json`, `dist/*`, and the current `.vsix` to
  `jonathan-annett.github.io/vscode-ext-dev/pptx-viewer-ext/` via the git
  data API (no clone needed). This was originally intended for sideloading
  into vscode.dev, but **that path doesn't work** — see "Dead ends".

## What hasn't been verified yet (the real reason for the move)

Nobody has visually confirmed the extension actually renders correctly in a
browser. The test-web server starts cleanly on Termux
(`http://localhost:3001/` returns 200) but the user hasn't been able to load
that URL in a browser on the phone in a way that's pleasant to evaluate.

**First priority on the VPS:** open a real `.pptx` in the dev server and
confirm:

1. The Pptx Info editor takes over (not the "binary file" treatment).
2. Metadata fields populate (file name, size, mtime, SHA-256, slide count,
   hidden count, author, last-modified-by, embedded media counts).
3. The three validation flags fire correctly (see README "What it shows").
4. Activation and per-file events appear in the Output panel
   (*View → Output → Pptx Info*) and DevTools console (lines prefixed
   `[pptx-viewer]`).
5. Nothing visually broken — the webview uses VS Code CSS variables, should
   look native in light/dark themes.

The user's intended testing loop on the VPS:

```
VPS: npm run open-in-browser     # serves VS Code Web on :3001
Mac: ssh -L 3001:localhost:3001 vps
Mac: open http://localhost:3001 in browser
```

This is functionally equivalent to running it locally — the SSH tunnel just
moves the browser to the Mac. The CSP allowlist for `localhost` is what makes
this work; remote URLs are blocked by vscode.dev's CSP (see "Dead ends").

Test pptx files: the user will need to bring their own. The parser was
written against real-world files but they're not in the repo. A handful of
edge cases worth probing:

- A clean deck with no media, no kiosk mode → all flags should be green.
- A deck with `<p:browse/>` or `<p:kiosk/>` in `<p:showPr>` → "Show type"
  flag warns.
- A deck with `showMediaControls="1"` → "Show media controls" warns.
- A deck with externally linked video/audio → "Linked media" warns.
- A deck with unicode in author/title → no mojibake.
- An intentionally broken/truncated pptx → graceful error, not a crash.

## Termux-isms you can ignore (or remove)

Two scripts in `scripts/` exist purely to work around Android sandbox quirks.
Both have `if (process.platform === 'android')` guards so they no-op on
Linux. **You don't have to remove them** — they cost nothing — but if you
prefer a clean repo, they can go along with their references in
`package.json`:

- `scripts/fix-cpus.cjs` — preloaded into `vsce package`. Android's app
  sandbox makes `os.cpus()` return `[]`, which makes `@secretlint/node`
  (used by `vsce` for secrets scanning) crash with `concurrency ... got 0`.
  The preload clamps to `os.availableParallelism()`. On Linux this is
  unnecessary.

- `scripts/fix-platform.cjs` — preloaded into `vscode-test-web`.
  `playwright-core` (transitive dep of `@vscode/test-web`) throws
  *"Unsupported platform: android"* at import time. The preload spoofs
  `process.platform = 'linux'`. On Linux this is unnecessary.

If removing, update the `package` and `open-in-browser` scripts in
`package.json` to drop the `--require ./scripts/fix-*.cjs` flags. Don't
remove the `--ignore-scripts` advice from the README without also testing
that `@vscode/vsce-sign`'s postinstall succeeds on the VPS (it ships
prebuilt binaries for linux-x64 / linux-arm64 / darwin / win32, so it
*should* be fine — but verify).

Also irrelevant on Linux: the "first run downloads ~34 MB of VS Code
Insiders" note in the README is still true, but the download is fast and
unremarkable on a normal connection.

## Dead ends — don't relitigate these

- **"Install Extension from Location..." in vscode.dev does NOT work for
  github.io URLs.** vscode.dev's CSP `connect-src` directive blocks any
  fetch to non-allowlisted origins. The allowlist is localhost +
  Microsoft CDNs + api.github.com. github.io is not on it. Confirmed by
  Microsoft maintainers in `microsoft/vscode#201317`. The "Install from
  VSIX" menu only exists on desktop VS Code, not vscode.dev. This is why
  we ended up on `@vscode/test-web` for dev — localhost is the only
  origin vscode.dev's CSP will let you sideload from, and `test-web`
  serves a VS Code Web instance from localhost with the extension
  preloaded.

- **Signing is not the issue.** The CSP error fires before any content
  validation. vsce signing is for Marketplace, not for sideloading.

- **The Copilot diagnosis claiming CJS bundle was wrong and
  `activationEvents` needed entries was incorrect.** Web extensions DO
  use CJS (the host provides `require`/`module`). `activationEvents` are
  auto-inferred from `contributes.customEditors` since VS Code 1.74.
  Don't change either.

## Potential next steps (user-directed)

The user mentioned "once tested i can look into publishing." Open
questions to surface at that point:

- **VS Code Marketplace** — requires a publisher account and signing.
  Most visibility.
- **Open VSX Registry** — used by VSCodium and many forks. No signing
  required.
- **Stay unlisted, just ship `.vsix` via GitHub Releases** — simplest,
  desktop-only audience.
- **github.io publish** — keep it for `.vsix` download URL convenience,
  but stop pretending it enables vscode.dev install.

Also worth a thought once the basic UI is verified:

- Does the user want to add slide rendering later, or keep "by design no
  rendering" as a stable identity? (README currently says the latter.)
- Is there value in supporting `.ppt` (legacy binary) or is the scope
  intentionally pptx-only?

## Context files to read

- `README.md` — user-facing build/install/test docs
- `pptx-viewer-agent-plan.md` — the original plan that bootstrapped the
  project (history, not active guidance)
- `~/projects/CLAUDE.md` — the user's wider Termux/Android context. Most
  of it won't apply on a Linux VPS, but the "user preferences" section
  (plain Node, no frameworks unless they earn their keep, single-file
  until it doesn't, CSS help with explanation) carries over.
- `~/.claude/projects/.../memory/MEMORY.md` — auto-memory index. Note
  that the "Termux Node.js quirks" memory and the Doze memory are
  Android-specific and won't matter on the VPS, but the user profile and
  GitHub auth notes do carry over.

## One thing the user values

They prefer Claude to do the coding so the iterations stay documented
and reviewable. They are fluent in JavaScript but struggle with CSS —
when CSS comes up (e.g., if you end up tweaking `webview.ts`), be
generous with styling help and *explain the rules being applied* so the
lesson sticks.
