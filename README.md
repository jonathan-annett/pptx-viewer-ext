# Pptx Info — VS Code web extension

A VS Code web extension that combines two features:

1. **Pptx viewer** — a read-only viewer for `.pptx` files that surfaces
   metadata and three safety-relevant validation flags so a file can be
   inspected at a glance before opening it in PowerPoint. (No slide
   rendering — by design.)
2. **Folder sync** *(in development)* — a one-way folder sync for
   vscode.dev: read access on a source folder tree, write access on one or
   more destination folders, user-convened with a plan-gate-execute model.
   The pptx viewer's validation checks plug into the sync as flagged items.

## What the pptx viewer shows

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

## Folder sync (in development)

The folder-sync feature is being shipped incrementally. Currently landed
(milestones M1 through M4.5):

- `.sync.jsonc` discovery across all workspace folders (JSON with comments
  + trailing commas, same dialect as VS Code's `settings.json`)
- Schema validation and topology resolution (matching destination names to
  open workspace folders, detecting subpath collisions)
- Hot-reload via `FileSystemWatcher` — edit a config and the topology
  re-resolves
- Bundled JSON Schema → IntelliSense + red squiggles when editing as text
- Custom editor for `.sync.jsonc` with form-style destination/path/glob
  controls and a Dry run button
- Plan engine + categorised plan webview + executor with manifest writes
- Status bar item showing source/destination counts and any issues
- Commands: **Folder Sync: Show Topology**, **Show Plan**, **Dry-Run Plan**

Interactive decision UI (collisions, destination-only, validator warnings,
"don't ask again" persistence) ships in M5. See `folder-sync-v1-plan.md` at
the repo root for the full spec.

### `.sync.jsonc` example

```jsonc
// .sync.jsonc at the root of any folder you want treated as a source.
// This file itself is implicitly excluded from sync.
{
  "destinations": [
    // Minimal: just a workspace folder name. Whole source goes to the
    // destination's root.
    { "name": "usb-backup" },

    // With a subpath — the source maps into a nested location.
    { "name": "nas-archive", "path": "projects/alpha/2026" },

    // Multiple destinations are independent; each gets the full source
    // (filtered by the include/exclude rules below).
    { "name": "dropbox-mirror", "path": "work/alpha" }
  ],

  // Glob patterns excluded in addition to the built-in ignores
  // (.git/, .DS_Store, Thumbs.db, ~$*, .sync.jsonc itself,
  // .foldersync-manifest.json).
  "exclude": [
    "node_modules/**",
    "*.tmp",
    "build/**",
    ".vscode/**",
    "**/*.log"
  ]

  // include is optional. Default is everything not excluded.
}
```

### Field meanings

- `destinations[].name` — must match a workspace folder name currently open
  in vscode.dev. Unresolved names produce a warning at load and are skipped
  at sync time.
- `destinations[].path` — optional subpath under the destination. Normalised
  (no leading or trailing slashes, no doubled separators).
- `exclude` / `include` — glob patterns. Built-in ignores are always applied.

### What to look for when testing

- Workspace folder names in vscode.dev come from whatever you add via
  *Add Folder to Workspace*. Pick simple, distinctive names — collisions
  across destinations are detected and reported.
- Two sources writing to the same destination subpath (e.g. both
  `.sync.jsonc` files declaring `name: usb-backup` with no `path`) trigger
  the collision diagnostic.
- An invalid config gets a `jsonc parse error: ...` message in the Output
  Channel, the affected source is skipped, and the rest of the topology
  still loads.

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
  extension.ts     activate, register provider, init sync manager, log channel
  provider.ts      CustomReadonlyEditorProvider (pptx viewer)
  pptx.ts          parse pptx bytes -> ParseResult
  webview.ts       ParseResult -> HTML string
  log.ts           OutputChannel + console mirror
  sync/            folder sync feature
    configParse.ts     pure jsonc parse + schema validation (tsx-testable)
    config.ts          vscode-wired loader
    topology.ts        destination resolution + collision detection
    manager.ts         discovery, hot-reload, topology lifecycle
    statusBar.ts       status bar item
    plan.ts            pure classifier (six operation categories)
    planner.ts         vscode-wired walk + hash + plan assembly
    planHtml.ts        pure plan webview renderer
    planView.ts        vscode-wired plan webview panel
    walker.ts          tree walk respecting includes/excludes
    glob.ts            glob → regex compiler + built-in ignore list
    hash.ts            SHA-256 via crypto.subtle
    manifest-types.ts  pure manifest schema
    manifest.ts        vscode-wired manifest I/O
    executor.ts        pure executor (injected SyncFs)
    runSync.ts         vscode-wired orchestrator
    configEditorHtml.ts  pure renderer for the .sync.jsonc form editor
    configEditor.ts      vscode-wired CustomTextEditorProvider
schemas/
  sync.schema.json   JSON Schema for .sync.jsonc; powers IntelliSense
scripts/
  fix-cpus.cjs       Termux workaround for vsce
  fix-platform.cjs   Termux workaround for vscode-test-web
  publish-web.cjs    atomic GitHub Pages deploy
test/
  parse.test.ts             pptx parser smoke test
  sync-jsonc.test.ts        jsonc parse + schema validation
  sync-glob.test.ts         glob matcher
  sync-plan.test.ts         operation classifier
  sync-planview.test.ts     plan webview HTML renderer
  sync-executor.test.ts     pure executor
  sync-config-editor.test.ts form editor HTML renderer
```
