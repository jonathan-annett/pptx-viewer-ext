# Changelog

All notable user-facing changes to **Presentation Folder Sync** (`sophtwhere.pptx-sync`) are recorded here, most recent at the top.

The project is currently **pre-1.0 / pre-release**: features and fixes land regularly, version numbers bump faster than typical post-1.0 cadence. Use this changelog to track what's new between marketplace publishes — useful when running an installed copy alongside the live test build at <https://vscode.sophtwhere.com>.

The VS Code Marketplace renders this file as the **Changelog** tab on the extension listing.

Format follows [Keep a Changelog](https://keepachangelog.com/); sub-sections used as needed (Added / Changed / Fixed / Performance / Notes).

---

## [Unreleased]

### Added
- **`.roomSync` filename alias.** A source folder can be flagged for sync with either `.sync.jsonc` (legacy) or `.roomSync` (forward-compatible alias) — same JSONC format, same semantics. A folder carrying both files surfaces a one-shot warning toast with a **Resolve…** action that opens a quick-pick to delete one. The custom form editor + JSON-Schema IntelliSense work on either filename.
- **`path-aliases` source-rewrite layer.** A new optional field in `.sync.jsonc` / `.roomSync` maps source-relative directories to destination-relative directories — useful for unifying day-major source layouts (`MON/breakout-1/…`, `TUE/breakout-1/…`) into a room-major destination tree without naming every day. Supports glob wildcards: `{ "*/room1": "*" }` captures the day prefix and reuses it on the destination side; `**` captures multi-segment prefixes. The plan view shows the rewrite provenance on each row as a subdued `← <source-path>` badge with the full alias pair in the tooltip.
- **Workspace-root `<dest>.roomSync` configs.** A `<handle>.roomSync` file placed at the root of a workspace folder declares a *logical destination* — the source is the whole workspace folder, the filename prefix is the operator-facing handle, and `path-aliases` is required. Multiple workspace-root configs coexist in the same workspace, each describing one destination group. The form editor swaps in a `Logical destination: <handle>` heading + a "path aliases are mandatory" explainer for these files.
- **`${roomSync}` template variable.** Pre-parse text substitution: `${roomSync}` in any string field resolves at load time to the filename prefix (for `<handle>.roomSync` files) or the enclosing folder name (for folder-level configs). Generators emit one verbatim template per logical destination, and the loader wires up the per-file handle automatically. The form editor reads templates literally so a form save preserves them; a helper line under the Path aliases section shows what the variable resolves to in context.
- **Generator emits per-room `.roomSync` templates.** `scripts/generate-event-folders.ts` now drops one `<roomId>.roomSync` template at the event root for each unique room in the schedule — empty `destinations: []` ready for the operator to fill in, and a `**/${roomSync}` → `**` path-alias that covers room-major + day-major source layouts with one rule. The operator opens the event folder as a workspace, drags each per-room destination folder in, wires up the URI via the form editor's **+ Add destination** button.
- **Destination-room operator view.** Auto-detects workspaces that mirror a sync destination but don't host a source (manifest present, zero `.sync.jsonc`). In that mode the status bar replaces the source-side "Folder Sync" entry with **`Destination only — last sync …`** that opens the manifest inspector on click; source-side commands (Show Plan, Sync This Folder, Open Admin Config, Show Topology, Dry-Run Plan, Show/Clear Workspace Snapshot) hide from the palette + explorer menus; and the canonical manifest auto-opens on activation (deferring to whatever you were last focused on if you already had a tab open).
- **Drift status per manifest entry.** Inside the manifest editor (operator mode only), every tracked file gets an inline badge prefix on its path: **✓ matches**, **⚠ drifted** (on-disk hash differs from the manifest), **✗ missing**, or **…** while computing. Hover for the per-status tooltip; a **Refresh drift** button forces a re-check; file-system events under the destination root flip badges automatically.
- **`.eventSync` filename alias for `.admin-sync.jsonc`.** The workspace-snapshot file at the root of the first workspace folder can now use the shorter `.eventSync` name — same JSONC format, same semantics, same custom form editor. Creating an empty `.eventSync` alongside an existing `.admin-sync.jsonc` is treated as "rename": the contents move over and the legacy file is deleted silently. If both files end up with content, a one-shot warning toast offers a **Resolve…** quick-pick. New workspaces write `.eventSync` by default; existing workspaces keep their `.admin-sync.jsonc` in place.
- **Event editor v2 — per-day timeslots + title input + swap/reorder + Generate folders.** Major follow-up iteration on the `.eventSchedule` custom editor. Most of these affordances reveal on hover to keep the grid uncluttered.
  - **Per-day timeslot lists.** Each day owns its own ordered slot list (`timeslotsByDay` in the file). Hover a row's leftmost cell to reveal **▲/▼** reorder buttons + an inline rename input (free-form, filename-safe — `\ / : * ? " < > |` rejected with a live red border) + a **✕** delete button (modal confirm with affected-session count). A trailing **+ Add timeslot to `<day>`** row appears under every day-block; new labels default to the next letter past the day's current max.
  - **Per-room session swap.** Hover a filled session cell to reveal **▲/▼** at the right edge that swap this session with the row neighbour *in the same room* (other rooms' rosters at that timeslot are unaffected).
  - **Session title (replaces the kind dropdown).** Optional free-form `title` on every session. The cell summary shows the title in normal weight, or — when blank — the underlying `kind` value as a muted-italic fallback. The edit panel's old kind `<select>` is gone; in its place an unobtrusive title input with the kind value as the placeholder hint. The `kind` field stays on disk for downstream tooling (`generate-event-folders` still routes by it).
  - **Clear button.** Tools section gains a red Clear that wipes speakers + rooms + sessions + vacancies (modal confirm). Keeps config + days + timeslot labels — Clear's whole purpose is to turn the file into a placeholder that the Generate sample schedule (formerly "Regenerate") form can refill.
  - **Generate sample schedule** — same action as the old "Regenerate from config", relabelled because "Regenerate" reads as "rebuild outputs from input" but really means "fill this file with random sample data". The expanded hint now explicitly notes this does not re-emit anything from authored data.
  - **`defaultTimeslots` config field + Apply to all.** A comma-separated input under Days in the event header sets the default timeslot labels used to seed any newly-added day. An **Apply to all** button next to it positionally renames every existing day's slot list to match — purely a rename, never drops a session (extras past the new list's length stay; extras past the old list's length get appended as empty rows).
  - **Generate folders button.** Tools section on populated schedules gains a "Generate folders…" affordance — the CLI behind `scripts/generate-event-folders.ts` now runs from inside the editor. Layout QuickPick (room-major vs day-major) + folder picker → progress notification walks the writes via `vscode.workspace.fs`. Hand-wired `.roomSync` templates in the destination are preserved on re-runs (existence check + skip); speaker placeholders overwrite. Summary toast offers a **Reveal** action.
  - **Bulk paste on add inputs.** Pressing Enter in the speaker / room "add" input fires the matching `+ Add` button. Pasting a multi-line clipboard payload (e.g. an Excel column) splits on `\r\n` / `\n` / `\r`, trims, drops blanks, and ships as a single bulk-add round-trip — avoids the race that N back-to-back single-add posts would lose entries to. Single-line pastes fall through to default browser behaviour. Focus stays in the input across re-renders so rapid-fire data entry doesn't break stride.
  - **Paste a roster into the speaker picker → replace this session.** Multi-line paste into a session's speaker-picker filter input replaces that session's roster with the pasted names. Matches the existing pool case-insensitively; unknown names auto-add to the pool (build a schedule by pasting rosters, no separate speaker-adding step). Same-timeslot conflicts resolve automatically — anyone who was in another session at this `(day, timeslot)` moves into the paste's target, and a modal lists each displacement (`"Alice was removed from Breakout 1 at MON A"`).
  - **Session edit panels are mutually exclusive.** Opening one auto-closes any other open one (`<details name>` accordion behaviour, no client JS).
- **Event editor speaker assignment uses chips + picker.** Replaced the comma-separated speaker-IDs text input with a row of name chips (each with an × to remove) and a `+` button that opens an inline picker. The picker lists only speakers eligible for this slot — anyone already assigned to another session at the same (day, timeslot) is filtered out so a single click can never double-book. Type-to-filter narrows the list. Chips are draggable: grab one and drop it onto another to reorder the slot order — the dragged chip lands before/after the target depending on which half of it you drop on, with a thin blue edge indicating where.
- **`.eventSchedule` custom editor.** Open any `*.eventSchedule` file and you get a form-driven planner: edit event name + days, manage the speaker pool, add/rename/remove rooms, and edit individual sessions in a day × timeslot × room grid (click a cell to expand, change kind, edit speakers, or remove). Vacancies are surfaced as a derived read-only list. A collapsible Tools section exposes the generator config + a Regenerate button — visible *only* when the file is empty or its content hash is in the placeholder registry, so authored data can never be wiped from the editor. JSON-Schema IntelliSense lights up if the file is reopened as text. The pure data model + deterministic generator that powers `scripts/generate-event-schedule.ts` now lives at `src/event/schedule.ts` and is shared between the CLI, the editor, and tests.
- **Progress bar during sync execution.** The standalone plan webview, the embedded admin editor, and the embedded config editor all show a live progress bar while a sync is running — `done / total (pct)` plus the destination + current file path. The bar's total is pre-computed from the same dispatch predicate the executor uses, so the count matches exactly what gets touched (skipped/unarmed rows aren't counted). The bar auto-hides once the run completes.
- **`.syncManifest` filename alias for `.foldersync-manifest.json`.** Destination manifests can now use the shorter `.syncManifest` name. Existing destinations carrying `.foldersync-manifest.json` keep using that file (no silent migration of operator-owned trees); new sync runs into fresh destinations write `.syncManifest`. The manifest custom editor recognises either filename.

### Changed
- **Event editor `timeslots` field replaced by per-day `timeslotsByDay`.** Save format change: the legacy top-level `timeslots: [...]` global union is dropped from `.eventSchedule` files. Per-day `timeslotsByDay: { MON: [...], TUE: [...] }` is the authoritative shape. Old files still parse cleanly — the legacy field is silently stripped on first save, per-day entries are computed from the existing breakout-knobs on load. No editor-facing behaviour change beyond the new per-day affordances.
- **`destinations: []` is no longer a parse error.** A `.sync.jsonc` / `.roomSync` with an empty destinations array is now valid — the form editor renders the config without a parse-error banner so generator-emitted templates open cleanly and surviving fields (like `path-aliases`) aren't lost on the first form save.
- **Manifest editor layout.** The destination root path is now the bold page title, with "Folder Sync Manifest" as a subtitle. The redundant `Key` column was dropped from the Entries table — the destPath cell is enough. The "this file is managed automatically…" disclaimer moved from the top of the page to a footer, with mode-aware copy (operator-mode framing reads "the source will rewrite it on the next sync" rather than "the executor will rewrite it"; decisions clause omitted).
- **Manifest version-mismatch banner.** Reframed in operator mode: "This destination was tracked by a newer version of Folder Sync. Update the extension to inspect this manifest." (Main-user copy unchanged.) Incomplete / hand-edited manifests without a `version` field are now treated as soft-fallback empty instead of surfacing the mismatch banner.

### Fixed
- **Event editor: Clear re-enables Generate sample schedule.** Previously, clicking Clear emptied the schedule but left the Tools section saying "this file has authored data" because the file still carried JSON scaffolding (config + per-day timeslots) and its sha didn't match the placeholder registry. A schedule with zero speakers / rooms / sessions / vacancies now counts as a placeholder regardless of file scaffolding, so the Generate form unlocks again right after a Clear.
- **Renamed workspace folder no longer stays read-only.** `files.readonlyExclude` is now self-healed at every snapshot-writer fire: if the workspace setting exists but doesn't carry a rule for the current `workspaceFolders[0].name`, the rule is added (other entries the user customised are preserved). Previously the original entry was seeded once and never updated, so renaming the writable folder (via the admin editor's Rename button, or vscode's UI) left the renamed folder read-only until the user hand-edited the snapshot.
- **Form-driven config edits now persist to disk reliably on vscode.dev.** The `.sync.jsonc` / `.roomSync` custom editor previously routed writes through `workspace.applyEdit` + `document.save()` — that pattern cleared the dirty flag without always flushing bytes through to the FSA-backed file in vscode.dev, so form edits to workspace-root `.roomSync` files appeared to save in memory but reverted on a close-and-reopen. Writes now go through `vscode.workspace.fs.writeFile` directly; every flush logs the write to the **pptx-viewer** Output Channel so persistence failures are visible.
- **Generated `.roomSync` templates can't be copied to destinations as content.** The walker's built-in ignore list previously caught `.sync.jsonc` and the bare `.roomSync` but missed named workspace-root configs like `breakout-1.roomSync`. These are now ignored alongside the manifest and other source-config filenames.
- **No more spurious `.admin-sync.jsonc` in workspaces with no source intent.** Workspaces that have zero `.sync.jsonc` files anywhere — including cold destination folders that haven't received a manifest yet — no longer get a snapshot file or read-only lock settings written. Both pieces of source-side machinery now gate on actual source presence.
- **Destination-only workspaces survive PWA refresh.** Adds a globalState capture (parallel to the file-based `.admin-sync.jsonc` pointer) so refreshing the browser while sitting in a destination workspace re-mounts the folder before the active-tab restorer fires.

---

## [0.1.3] — 2026-05-26

### Added
- **Placeholder files registry.** Workspace-level "this file is a stub, not real content yet" tracking. The admin editor (`.admin-sync.jsonc`) has a new **Placeholders** card — the empty-file sha is locked as the default, and you can add custom blank-template decks via an "Add placeholder…" file picker.
  - Per-row **`[P]` chip** in plan views marks files whose content matches the registry.
  - The viewer shows a blue "This is a placeholder file — content not yet uploaded." banner instead of the corrupt-file warning when the open file is a known placeholder.
  - A three-state footer line in the standalone plan webview summarises status: *"All N source files have content"* / *"All N source files are placeholders"* / *"N of M source files are placeholders"*. Counts are deduped per source — a single source file mirrored to 3 destinations counts once.

### Changed
- **Plan view row layout.** Per-file rows reorganised so chips/badges/decisions appear right after the filename and the size + hash columns anchor to a stable right-aligned column. Affordance accumulation no longer pushes the data columns around.

### Performance
- **Batched IDB reads.** Viewer-open of a non-placeholder `.pptx` drops from **~2.5s to sub-100ms** on warm caches. The hash cache and parse cache each collapse N per-file lookups into one bulk read per walk.
- **Zero-byte short-circuit.** Empty placeholder `.pptx` files open without any cache or storage round-trip.

---

## [0.1.2] — 2026-05-25

### Fixed
- **Desktop VS Code compatibility.** Cold-restore paths now correctly gate on the web host. Desktop VS Code no longer attempts the vscode.dev silent-restore flow on activation.

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
