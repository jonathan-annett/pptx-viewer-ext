# Changelog

All notable user-facing changes to **Presentation Folder Sync** (`sophtwhere.pptx-sync`) are recorded here, most recent at the top.

The project is currently **pre-1.0 / pre-release**: features and fixes land regularly, version numbers bump faster than typical post-1.0 cadence. Use this changelog to track what's new between marketplace publishes — useful when running an installed copy alongside the live test build at <https://vscode.sophtwhere.com>.

The VS Code Marketplace renders this file as the **Changelog** tab on the extension listing.

Format follows [Keep a Changelog](https://keepachangelog.com/); sub-sections used as needed (Added / Changed / Fixed / Performance / Notes).

---

## [Unreleased] — working towards 0.1.2

_Live on the test instance at `vscode.sophtwhere.com`; not yet published to the Marketplace. Available via the GitHub release page as a `.vsix` for self-install when a build is cut._

### Added
- **Placeholder files registry.** Workspace-level "this file is a stub, not real content yet" tracking. The admin editor (`.admin-sync.jsonc`) has a new **Placeholders** card — the empty-file sha is locked as the default, and you can add custom blank-template decks via an "Add placeholder…" file picker.
  - Per-row **`[P]` chip** in plan views marks files whose content matches the registry.
  - The viewer shows a blue "This is a placeholder file — content not yet uploaded." banner instead of the corrupt-file warning when the open file is a known placeholder.
  - A three-state footer line in the standalone plan webview summarises status: *"All N source files have content"* / *"All N source files are placeholders"* / *"N of M source files are placeholders"*. Counts are deduped per source — a single source file mirrored to 3 destinations counts once.

### Changed
- **Plan view row layout.** Per-file rows reorganised so chips/badges/decisions appear right after the filename and the size + hash columns anchor to a stable right-aligned column. Affordance accumulation no longer pushes the data columns around.

### Fixed
- **Desktop VS Code compatibility.** Cold-restore paths now correctly gate on the web host. Desktop VS Code no longer attempts the vscode.dev silent-restore flow on activation.

### Performance
- **Batched IDB reads.** Viewer-open of a non-placeholder `.pptx` drops from **~2.5s to sub-100ms** on warm caches. The hash cache and parse cache each collapse N per-file lookups into one bulk read per walk.
- **Zero-byte short-circuit.** Empty placeholder `.pptx` files open without any cache or storage round-trip.

---

## [0.1.1] — 2026-05-25

### Added
- **Presentation Search panel.** Workspace-wide, debounced as-you-type search across filename / `dc:creator` (author) / first-visible-slide text. Open via *Presentation Search: Open* in the command palette.
  - **AND across terms by default**, with an *Any term (OR)* toggle in the panel header.
  - **Results grouped by workspace folder.**
  - **Hash-pairing badge** highlights when the same content lives in multiple folders — sanity check for shipping the same deck to several conference rooms.
  - **Multi-select with "Update with…"** — pick a source row, tick one or more target rows, and push the same content to every target in a single gesture. PDF source / PPTX target pairs route through the viewer's PDF → PPTX import modal.
  - **Sync destinations excluded from indexing.** Search shows you sources and other workspace folders, not their mirrors.
- **PDF indexing in search** — `.pdf` files are indexed by filename so click-through from search works for PDFs the user is about to convert.
- **Basic PDF viewer.** A read-only custom editor that renders page 1 of any `.pdf` — clicking a PDF result no longer dumps raw binary into a text editor.

### Changed
- **Marketplace-facing README.** Rewritten to cover the three independent features (viewer / sync / search), with quick-start sections for both vscode.dev and desktop VS Code.

---

## [0.1.0] — 2026-05-24

**First marketplace publish** as `sophtwhere.pptx-sync`. Everything below was developed during pre-marketplace iterations (versions `0.0.1`–`0.0.3` were development tags only and never published).

### Added — Presentation viewer
- Custom editor for `.pptx` showing filename, size, mtime, sha256, slide count, hidden-slide count, author, last-modified-by, and embedded media list.
- **Three safety-check flags**: linked external media, kiosk/window show mode, on-screen media-controls (gated on whether the deck actually contains video).
- **Thumbnails** — in-file `docProps/thumbnail.*` extraction with a synthesised coloured-box + first-slide-title fallback for decks with no embedded thumbnail. Fallback colour is content-addressed so the same file always produces the same image.
- **Save As…** — download the open file via the standard VS Code save dialog.
- **Update…** — pick a `.pptx` and replace the open file (refuses identical content; writes only when bytes differ).
- **Drag-and-drop ingest** — drop a `.pptx` to compare + update (info modal for identical content, side-by-side compare modal when bytes differ), or drop a `.pdf` to open the PDF → PPTX import flow.
- **Extract embedded media** — dropdown of video parts annotated with slide-of-use, save via the standard save dialog.
- **PDF → PPTX import** — config modal (aspect / resolution / format / quality) inside the viewer, one slide per page, output routes through the existing ingest path.

### Added — Folder Sync v1
Complete one-way push workflow with plan-gate-execute model:
- **`.sync.jsonc` config** with JSON-Schema-backed IntelliSense in the text editor and a dedicated **custom editor** with form fields (dropdowns of currently-open workspace folders, subpath, include/exclude globs).
- **Plan webview** showing six operation categories (create / update-tracked / delete-tracked / collisions / destination-only / validation warnings) with a traffic-light footer (**green** Proceed for clean plans, **orange** "Proceed with safe items only" when collisions/warnings exist, **red** Cancel).
- **Per-row decisions** (overwrite collision, delete destination-only, sync-anyway override for warning) with persistent "don't ask again" via the manifest.
- **Manifest tracking** — `.foldersync-manifest.json` in each destination records what was placed there; opens in its own view-only editor showing tracked entries + decisions + timestamps.
- **Workspace snapshot + silent restore** — `.admin-sync.jsonc` at the root of the first workspace folder persists the open-folder set + relevant settings. On a folderless vscode.dev refresh, the extension re-mounts the folders automatically with no permission prompts.
- **Explorer context menu** — right-click any folder under a source for a folder-scoped plan; destination-side clicks reverse-map to the equivalent source-side plan.
- **Two-tier IDB caches** (URI hash cache + content-hashed parse cache) so re-syncs against unchanged destinations are fast.
- **Atomic writes** via tmp + rename with orphan `.tmp` sweep at the start of each run.

### Notes
- Extension ID: **`sophtwhere.pptx-sync`**.
- Targets vscode.dev (web extension) and desktop VS Code. The vscode.dev test instance lives at <https://vscode.sophtwhere.com>.
- Pre-release; no formal versioning policy yet. Expect 0.1.x to iterate quickly before a 1.0.

---

## Maintenance note (for future agents / release flow)

When cutting a marketplace publish:

1. Roll the `[Unreleased]` section above into a new `[<version>] — <YYYY-MM-DD>` entry just below it.
2. Open a fresh `[Unreleased]` section at the top for the next iteration.
3. Bump `package.json` `version` to match (or use `npm version <patch|minor|major>` which updates both `package.json` and `package-lock.json`).
4. Commit, tag (`v<version>`), publish via `vsce` to the Marketplace, and attach the `.vsix` to a GitHub release. Copy the new section's bullets into the GitHub release notes.
5. **In CLAUDE.md**, the protocol is documented under "Updating this doc" — keep the changelog as a release-flow artifact, separate from substrate / feature plans.
