# Pptx Info — VS Code web extension

A read-only viewer for `.pptx` files. It does not render slides; it surfaces
metadata and three safety-relevant validation flags so a file can be inspected
at a glance before opening it in PowerPoint.

## What it shows

**Metadata**: file name, size, mtime, SHA-256, slide count, hidden slide count,
author, last-modified-by, embedded media (mime → count).

**Validation flags** (pass/warn):

| Flag                  | Warns when                                                              |
|-----------------------|-------------------------------------------------------------------------|
| Linked media          | A slide rels file links to external video/audio/media                   |
| Show type             | `<p:browse/>` or `<p:kiosk/>` is set on `<p:showPr>`                    |
| Show media controls   | `showMediaControls="1"` (or `"true"`) on `<p:showPr>`                   |

## Logging

Once installed, activation and per-file events are logged in two places:

- **Output panel** — *View → Output → Pptx Info*
- **DevTools console** — *Help → Toggle Developer Tools*, lines are prefixed `[pptx-viewer]`

## Building

```bash
npm install --ignore-scripts   # ignore-scripts: skips @vscode/vsce-sign's
                               # native postinstall (no android-arm64 binary)
npm run compile-web            # esbuild -> dist/extension.js
npm run package                # vsce -> pptx-viewer-<version>.vsix
```

## Installing & testing

vscode.dev does **not** support installing extensions from arbitrary URLs or
uploaded `.vsix` files (the "Install from VSIX" menu only exists on desktop,
and the "Install Extension from Location..." command is restricted to
`localhost` by CSP). There are two working paths:

### A. vscode.dev via local server (recommended for dev)

```bash
npm run open-in-browser
```

This runs `@vscode/test-web`, which serves a copy of VS Code Web with this
extension preloaded at `http://localhost:3001/`. Open that URL in Chrome on
the same machine. The extension is active immediately — open a `.pptx` from a
workspace folder and the Pptx Info editor takes over.

First run downloads ~34 MB of VS Code Insiders web build into
`.vscode-test-web/`; subsequent runs reuse the cache.

### B. Desktop VS Code via `.vsix`

```
Extensions sidebar (Ctrl/Cmd+Shift+X) → ... menu → Install from VSIX
```

Pick the `.vsix` from a release on
<https://github.com/jonathan-annett/pptx-viewer-ext/releases> or one you
built locally with `npm run package`.

## What to look for when testing

- Did the editor open instead of "binary file" treatment?
- Are metadata fields populated? Any "unknown" you didn't expect?
- Do the three validation flags fire on the right files and stay quiet on
  clean ones?
- Anything visually off, confusing, or missing?
- Errors in DevTools console or in *Output → Pptx Info*?

## Publishing built files

`npm run publish:web` atomically commits the built extension files
(`package.json` + `dist/*`) and the latest `.vsix` to a GitHub Pages repo via
the git data API (no clone required). Configured by the `webPublish` block in
`package.json`:

```json
"webPublish": {
  "repo":   "owner/repo",
  "branch": "main",
  "folder": "vscode-ext-dev/pptx-viewer-ext"
}
```

The vsix lands at the parent of `folder`; older `<name>-*.vsix` siblings are
removed automatically. **Note:** these published files are *not* loadable
into vscode.dev directly (see above) — the publish exists for sharing the
`.vsix` and as a download URL for desktop installs.

## Known limitations

- No slide rendering — by design.
- Legacy `.ppt` (binary) is not supported.
- Desktop VS Code works via "Install from VSIX"; remote desktops also work.
- Parsing uses targeted regex/substring scans rather than a full XML parser,
  trading strictness for size and tolerance of malformed input. Edge cases may
  resolve to "unknown".

## Termux notes

This project was bootstrapped on Termux/Android. Two non-obvious workarounds
ship with the repo for that environment:

- **`scripts/fix-cpus.cjs`** — preloaded into `vsce package`. Android's app
  sandbox makes `os.cpus()` return `[]`, which crashes `@secretlint/node`
  (used by `vsce` for secrets scanning) when it passes `0` as a p-map
  concurrency. The preload clamps to `os.availableParallelism()`.
- **`scripts/fix-platform.cjs`** — preloaded into `vscode-test-web`.
  `playwright-core` (a transitive dep) throws *"Unsupported platform: android"*
  at import time. The preload spoofs `process.platform = 'linux'`; combined
  with `--browserType=none`, no chromium binary is ever resolved.

On a real Linux/macOS dev box neither preload is necessary — the scripts
no-op when `process.platform !== 'android'`.

## Layout

```
src/
  extension.ts   activate, register provider, log channel init
  provider.ts    CustomReadonlyEditorProvider
  pptx.ts        parse pptx bytes -> ParseResult
  webview.ts     ParseResult -> HTML string
  log.ts         OutputChannel + console mirror
scripts/
  fix-cpus.cjs       Termux workaround for vsce
  fix-platform.cjs   Termux workaround for vscode-test-web
  publish-web.cjs    atomic GitHub Pages deploy
test/
  parse.test.ts  Node-runnable parser smoke test
```
