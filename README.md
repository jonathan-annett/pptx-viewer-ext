# Presentation Viewer

A VS Code extension for working with PowerPoint decks: inspect them at a
glance, replace them in place, and search across a folder of decks by
content. Designed first for **vscode.dev** (works there without installing
anything locally), and also runs in desktop VS Code.

> No slide rendering — this isn't a viewer that shows you the slides. It
> shows you everything *around* the slides (metadata, validation,
> thumbnail) so you can tell what a file is at a glance before opening
> it in PowerPoint, Keynote, or LibreOffice.

> **`extension-slim` branch.** This is the streamlined build: the
> **presentation viewer** + a **basic content search**. The heavier
> operator features — multi-folder **folder sync**, destination-aware
> search with the **Update/sync** workflow, and the **event scheduler** —
> have moved to the standalone PWA. The full pre-slim feature set lives on
> the frozen [`main`](https://github.com/jonathan-annett/pptx-viewer-ext/tree/main)
> branch (kept as-is for audit).

> **Pre-release.** Versions in the `0.1.x` series are pre-1.0 builds. See
> **[CHANGELOG.md](./CHANGELOG.md)**.

---

## Two features, useable independently

### 1. Presentation viewer

Open any `.pptx` and a metadata panel takes the place of the usual
"binary file" treatment:

- File name, size, hash, slide count, hidden-slide count, author,
  last-modified-by
- Embedded media summary (audio / video / image counts by mime type)
- **Thumbnail** — the deck's own embedded thumbnail when present, or a
  synthesised coloured-box + title-text fallback so every deck has one
- **Three safety checks** as pass/warn flags:
  - **Linked media** — slides reference video or audio that lives
    *outside* the file (won't play on a different machine)
  - **Show type** — file is set to kiosk or window mode instead of
    normal presenter mode
  - **Media controls** — on-screen player bar is enabled (visually
    noisy during a talk; usually a leftover from authoring)

**Actions in the viewer:**

- **Save As…** — download a copy
- **Update…** — pick a new `.pptx` and replace this one in place
  (compares first, refuses if identical)
- **Extract media** — pull any embedded video out as a standalone file
- **Drag & drop** a `.pptx` onto the viewer — same compare-and-replace
  flow without picking
- **Drag & drop** a `.pdf` onto the viewer — open the PDF → PPTX import
  modal (resolution, aspect, format, quality), one slide per page

A separate **PDF preview** also opens any `.pdf` and renders page 1, so
files clicked from search don't open as raw bytes.

### 2. Presentation search

Command palette → **Presentation Search: Open**.

A content search over your **main workspace folder**, matching across:

- Filename
- `dc:creator` (author) metadata
- First-visible-slide text

Type a query and watch results appear as you type — AND across terms by
default, with an **Any term (OR)** checkbox. Results are deduplicated by
content hash, and a coloured badge highlights when the same content
appears more than once. Placeholder/stub decks (zero-byte files, plus any
hashes you list in the `pptxViewer.placeholderHashes` setting) keep their
own filename rather than collapsing together. Click a result to open the
viewer; **Reindex** from the panel to pick up external changes.

---

## Quick start

### vscode.dev (no install)

1. Open <https://vscode.dev>.
2. Install this extension from the Extensions sidebar.
3. *File → Add Folder to Workspace* and pick a folder containing
   `.pptx` files.
4. Click any `.pptx` — the viewer takes over.

### Desktop VS Code

1. Install from the Marketplace, or
2. Download a `.vsix` from the [releases page][releases] and use
   *Extensions sidebar → ⋯ menu → Install from VSIX*.

[releases]: https://github.com/jonathan-annett/pptx-viewer-ext/releases

---

## Settings

| Setting | What it does |
|---|---|
| `pptxViewer.placeholderHashes` | SHA-256 hex hashes of decks to treat as placeholders (banner in the viewer; each indexed per-URI so byte-identical stubs keep their own filename). The empty-file hash is always a placeholder. |
| `pptxViewer.dropboxBaseUrl` | Override the dropbox-server base URL used by the upload-to-update flow. Empty = the default. |

## Commands

| Command | What it does |
|---|---|
| **Presentation Search: Open** | Open the search panel |
| **Pptx Info: Reset Extension State (Factory Reset)** | Clear cached state |

---

## What this extension does **not** do (by design)

- **No slide rendering.** The viewer surfaces metadata, validation, and
  a thumbnail. To see the slides themselves, open the file in
  PowerPoint, Keynote, or LibreOffice.
- **No legacy `.ppt` support.** Pptx only.
- **No folder sync, multi-folder search, or event scheduling** — those
  moved to the standalone PWA (see the branch note above).

---

## How writes work

- **Update…** replaces a deck in place — it compares the candidate
  against the current file (SHA-256) first and refuses an identical
  replacement, then overwrites the file at its path.
- In vscode.dev, folder access is granted by the browser's File System
  Access API. The first time you add a folder it asks; subsequent
  refreshes restore the grant automatically.

---

## Where to look when something seems off

- **Output panel → Pptx Info** — activation, per-file parse, and any errors
- **DevTools console** (Help → Toggle Developer Tools) — same lines,
  prefixed `[pptx-viewer]`, plus a build timestamp + short git SHA per
  activation.

---

## Issues and feedback

Report at <https://github.com/jonathan-annett/pptx-viewer-ext/issues>.

## License

MIT.
