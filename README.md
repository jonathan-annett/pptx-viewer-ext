# Pptx Info — VS Code web extension

A read-only viewer for `.pptx` files in **vscode.dev**. It does not render
slides; it surfaces metadata and three safety-relevant validation flags so a
file can be inspected at a glance before opening it in PowerPoint.

## What it shows

**Metadata**: file name, size, mtime, SHA-256, slide count, hidden slide count,
author, last-modified-by, embedded media (mime → count).

**Validation flags** (pass/warn):

| Flag                  | Warns when                                                              |
|-----------------------|-------------------------------------------------------------------------|
| Linked media          | A slide rels file links to external video/audio/media                   |
| Show type             | `<p:browse/>` or `<p:kiosk/>` is set on `<p:showPr>`                    |
| Show media controls   | `showMediaControls="1"` (or `"true"`) on `<p:showPr>`                   |

## Build and package

```bash
npm install
npm run bundle        # esbuild -> dist/extension.js
npm run package       # vsce -> pptx-viewer-<version>.vsix
```

The `.vsix` is the artefact handed to the human each cycle.

## Install in vscode.dev

1. Open https://vscode.dev
2. Extensions sidebar → `...` menu → **Install from VSIX**
3. Pick `pptx-viewer-<version>.vsix`
4. Reload when prompted
5. Open a `.pptx` file — the Pptx Info editor opens automatically

## Test cycle

Drop `.pptx` files into a workspace folder in vscode.dev, then click each one.
Observe:

- Did the editor open?
- Are metadata fields populated?
- Do warnings fire where they should and stay quiet where they shouldn't?
- Anything visually off?
- Errors in DevTools? (Help → Toggle Developer Tools)

Report findings back to the agent.

## Known limitations

- No slide rendering — by design.
- Legacy `.ppt` (binary) is not supported.
- Desktop VS Code is not a target (web extension only).
- Parsing uses targeted regex/substring scans rather than a full XML parser,
  trading strictness for size and tolerance of malformed input. Edge cases may
  resolve to "unknown".

## Layout

```
src/
  extension.ts   activate, register provider
  provider.ts    CustomReadonlyEditorProvider
  pptx.ts        parse pptx bytes -> ParseResult
  webview.ts     ParseResult -> HTML string
test/
  fixtures/      sample .pptx files (gitignored; user-provided)
  parse.test.ts  node-runnable parser smoke test
```

## Future

- Headless activation test via `@vscode/test-web --headless`
- Synthetic fixtures generated with `pptxgenjs` for CI
- Verbose-logging build variant for diagnosing real-world files
