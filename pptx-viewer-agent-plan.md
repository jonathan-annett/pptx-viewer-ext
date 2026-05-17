# Pptx Viewer Extension — Agent Handoff

## Purpose

Build a minimal read-only pptx viewer as a **VS Code web extension** targeting vscode.dev. The viewer displays file metadata and validation flags for a `.pptx` file. It does **not** render slides.

This deliverable also serves as a workflow validation. A Claude Code agent in a Linux shell develops, bundles, and packages the extension. The human installs the resulting `.vsix` into the live vscode.dev and tests it against real files. If the loop works cleanly here, the same approach will be used for a more ambitious folder-sync extension afterwards.

---

## What the extension does

When the user opens a `.pptx` file in vscode.dev with this extension installed, a custom read-only editor opens instead of the default "binary file" treatment. The editor shows a single panel with the following information.

### Metadata (informational)

- File name
- File size (bytes plus human-readable)
- File modified time (filesystem mtime)
- SHA-256 hash (hex)
- Total slide count
- Hidden slide count
- Author (`<dc:creator>` from `core.xml`)
- Last modified by (`<cp:lastModifiedBy>` from `core.xml`)
- Embedded media: list of mime types and counts (e.g. "video/mp4 × 2, audio/mpeg × 1"), or "none"

### Validation flags (warnings)

Each displayed as a pass/warn indicator with a short explanation. Warnings must be visually distinct from passes (colour, icon, leading "WARN:") so safety can be judged at a glance.

- **Linked media** — warn if any slide rels file contains a relationship to external video/audio/media
- **Show type** — warn if window mode (`<p:browse/>`) or kiosk mode (`<p:kiosk/>`) is set; pass otherwise (presenter mode is the default and the only acceptable state)
- **Show media controls** — warn if `showMediaControls="1"` (or `"true"`) on `<p:showPr>`; pass if absent or `"0"`

---

## Out of scope (v1)

- Slide rendering of any kind
- Editing pptx files
- Thumbnail extraction
- Legacy `.ppt` (binary) format support
- Desktop VS Code support — web extension only
- Multiple-file or batch views
- Any UI beyond the single read-only editor panel

---

## Technical specification

### Extension shape

Web extension. `package.json` declares a `"browser"` entry, not `"main"`. The bundle is built with target `webworker`.

### Contribution

```json
"contributes": {
  "customEditors": [{
    "viewType": "pptxViewer.viewer",
    "displayName": "Pptx Info",
    "selector": [{ "filenamePattern": "*.pptx" }],
    "priority": "default"
  }]
}
```

### Provider

Implement `vscode.CustomReadonlyEditorProvider`. On `openCustomDocument`, return a thin wrapper holding the URI. On `resolveCustomEditor`, read the file, parse it, render the panel HTML into the webview.

### File access

- Bytes: `vscode.workspace.fs.readFile(uri)` → `Uint8Array`
- Size and mtime: `vscode.workspace.fs.stat(uri)`

### Pptx parsing

The pptx is a zip. Unzip with **`fflate`** (small, pure JS, works in the web-extension worker context).

| Datum | Source in the zip | Extraction |
|---|---|---|
| Slide count | Entries matching `ppt/slides/slide*.xml` | Count entries |
| Hidden slides | Each `ppt/slides/slideN.xml`, root attribute `<p:sld show="0">` | Read first ~500 bytes of each; substring-search for `show="0"` |
| Author | `docProps/core.xml`, `<dc:creator>` element | Targeted regex or small XML read |
| Last modified by | `docProps/core.xml`, `<cp:lastModifiedBy>` element | Same |
| Embedded media | `[Content_Types].xml`, `Override` entries with `ContentType` starting `video/` or `audio/` | Single scan |
| Linked media | `ppt/slides/_rels/slideN.xml.rels`, `Relationship` with `Type` ending `/video`, `/audio`, or `/media` AND `TargetMode="External"` | Scan all rels files |
| Show type | `ppt/presentation.xml`, child element of `<p:showPr>` | Substring search for `<p:browse` or `<p:kiosk` |
| Show media controls | `ppt/presentation.xml`, attribute `showMediaControls` on `<p:showPr>` | Substring search |

A full XML parser is **not** required. Targeted regex/substring searches against the specific entries above are robust enough for real-world pptx files and keep the bundle small. If a more rigorous parser is ever needed, `fast-xml-parser` works in the worker context, but do not add it speculatively.

### SHA-256

`crypto.subtle.digest('SHA-256', bytes)` then hex-encode the resulting `ArrayBuffer`. No library needed.

### Webview

Plain HTML and CSS. No framework. The provider builds the HTML once after parsing. Use VS Code CSS variables (`--vscode-foreground`, `--vscode-editor-background`, `--vscode-errorForeground`, etc.) so the panel matches the user's theme.

### Hard constraints

- **No Node APIs.** No `fs`, `path`, `child_process`, Node `crypto`, `os`, etc. Use `vscode.workspace.fs`, URIs, and `crypto.subtle`.
- **No network calls** from extension or webview.
- **Single bundled file** for the extension entry point. Use **esbuild** (preferred for speed/simplicity) or webpack.
- **Minimal runtime dependencies.** `fflate` should be the only one needed.

---

## Project structure

```
pptx-viewer/
  package.json              (browser entry, customEditors contribution, scripts)
  tsconfig.json
  esbuild.config.js
  src/
    extension.ts            (activate, register provider)
    provider.ts             (CustomReadonlyEditorProvider impl)
    pptx.ts                 (parse pptx bytes -> ParseResult object)
    webview.ts              (render ParseResult -> HTML string)
  test/
    fixtures/               (sample .pptx files)
    smoke.test.ts           (headless activation test)
  README.md                 (install + iteration instructions for the human)
```

---

## Test inputs

Place sample `.pptx` files in `test/fixtures/` covering:

- **Normal** — presenter mode, no linked media, no hidden slides, author populated
- **Bad** — kiosk mode set, `showMediaControls="1"`, at least one linked external video, at least one hidden slide
- **Messy** — missing author, no `<p:showPr>` at all (exercises defaults)
- **Minimal** — single slide, no media

If the human has not provided fixtures, generate synthetic ones with `pptxgenjs`, but flag in the handoff that real-world samples are still needed for full confidence — generated files won't surface real-world quirks.

The README should note which fixture exercises which check.

---

## Build and package

```bash
npm install
npm run bundle           # esbuild -> dist/extension.js
npx vsce package         # -> pptx-viewer-<version>.vsix
```

The `.vsix` is the deliverable handed to the human each cycle.

---

## Headless smoke test

Use `@vscode/test-web --headless` to confirm:

- Extension activates without error
- Custom editor is registered for `*.pptx`
- Opening a known-good fixture does not throw
- The webview HTML string contains the expected field labels

This catches gross regressions. It does **not** validate visual presentation or live-site behaviour — that is the human's job.

---

## Dev workflow

The agent and the human have well-defined roles. Neither should try to do the other's part.

### Agent — every cycle

1. Apply changes based on the human's last report
2. Run the headless smoke test; fix any failures before handing over
3. `npm run bundle && npx vsce package`
4. Hand over the new `.vsix` along with a short note: what changed, what to check, any open questions

### Human — every cycle

1. In vscode.dev: Extensions sidebar → `...` menu → **Install from VSIX** → pick the file
2. Reload when prompted
3. Open a real `.pptx` (or a fixture uploaded into a workspace folder)
4. Observe the rendered panel
5. Report:
   - Did the editor open?
   - Are the fields populated correctly?
   - Do the warning flags fire where they should, and stay quiet where they should?
   - Anything visually off, confusing, or missing?
   - Errors in DevTools? (Help → Toggle Developer Tools)

### Definition of done (v1)

- Any well-formed pptx opens and shows all metadata fields populated
- Each of the three validation flags fires on files where it should and stays quiet on clean files
- No errors in the extension host console on any fixture
- Layout is readable at a glance; warnings visually distinct from passes
- README explains install steps and known limitations

---

## Notes for the agent

- **The human is the integration tester, not a code reviewer.** They will tell you what they see in the browser. They may not give you stack traces unprompted. If you suspect a bug needs more diagnostic data, ship a build with verbose logging to a VS Code Output Channel and ask them to paste the contents back.

- **Pptx files in the wild are inconsistent.** Defensive parsing matters: missing zip entries, missing XML elements, unexpected encodings. Fail soft — show "unknown" for a missing field, never crash the editor. The whole point of the tool is to inspect potentially-problematic files.

- **Bundle size affects load time** in a web extension. Keep it lean. If a job can be done with a small regex instead of a large library, do that.

- **Do not add features beyond the spec without explicit go-ahead.** Scope creep is one of the failure modes this dry-run is meant to catch. If you spot a tempting addition, write it as a "future" note in the README and keep going.

- **When you hit a real ambiguity** — e.g. a pptx that has no `<p:showPr>` at all, or a malformed core.xml — make the obvious safe choice (treat as defaults, treat as unknown) and flag it in your handoff note for the human to confirm. Do not block waiting for clarification on small calls.

- **Each cycle should land in the human's hands as a buildable, installable artifact**, not a half-finished diff. If a cycle isn't ready, finish the previous behaviour cleanly before starting the new work.
