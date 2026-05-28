# Presentation Folder Sync

A VS Code extension for working with PowerPoint decks: inspect them at a
glance, push them between folders with a reviewable plan, and search
across hundreds of decks by content. Designed first for **vscode.dev**
(works there without installing anything locally), and also runs in
desktop VS Code.

> No slide rendering — this isn't a viewer that shows you the slides. It
> shows you everything *around* the slides (metadata, validation,
> thumbnail) so you can tell what a file is at a glance before opening
> it in PowerPoint, Keynote, or LibreOffice.

> **Pre-release.** Versions in the `0.1.x` series are pre-1.0 builds. See
> **[CHANGELOG.md](./CHANGELOG.md)** (also rendered as the *Changelog* tab
> on the Marketplace listing) for what's landed in each publish — and
> what's queued in the live test build at
> <https://vscode.sophtwhere.com> ahead of the next publish.

---

## Four features, useable independently

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
- **Update…** — pick a new `.pptx` and replace this one (compares first,
  refuses if identical)
- **Extract media** — pull any embedded video out as a standalone file
- **Drag & drop** a `.pptx` onto the viewer — same compare-and-update
  flow without picking
- **Drag & drop** a `.pdf` onto the viewer — open the PDF → PPTX import
  modal (resolution, aspect, format, quality), one slide per page

A separate **PDF preview** also opens any `.pdf` and renders page 1, so
files clicked from search don't open as raw bytes.

### 2. Folder sync

One-way push from a source folder to one or more destination folders.
You convene every sync; nothing fires in the background.

**The flow:**

1. Drop a `.sync.jsonc` in any folder you want to push *from*. A custom
   editor opens by default with form fields for destinations, paths, and
   include/exclude globs; the file is regular JSONC and IntelliSense
   works in the text editor too.
2. Add the destination folders to your workspace (in vscode.dev: drag
   from File Explorer, or use *File → Add Folder to Workspace*).
3. Click **Folder Sync** in the status bar, or right-click any folder
   under a source in the Explorer → **Sync This Folder**.
4. A **plan webview** opens, showing every file that would be created,
   updated, or deleted. Operations are grouped into six categories:
   - To create
   - To update (already tracked)
   - To delete (source removed)
   - **Collisions** — destination has drifted from what the manifest
     expected (per-row "overwrite this file" toggle, plus a "don't ask
     again" checkbox that persists)
   - **Destination-only files** — never placed by sync (per-row delete
     toggle, default off)
   - **Validation warnings** — files flagged by the pptx viewer's
     safety checks
5. Choose a path through the **traffic-light gate**:
   - **Green Proceed** when nothing needs attention (clean plan)
   - **Orange "Proceed with safe items only"** when collisions or
     warnings exist — applies only the items you armed plus the always-
     safe ones
   - **Red Cancel** to back out entirely

A manifest file in each destination (`.foldersync-manifest.json`)
tracks what was placed there, so sync can distinguish files it put there
from files you added by hand. The manifest opens in its own view-only
editor showing tracked entries, recorded decisions, and last-sync
timestamps.

**Workspace snapshot.** Because vscode.dev forgets which folders you had
open across a browser refresh, the extension keeps an
`.admin-sync.jsonc` snapshot of the open-folder set + relevant settings
in the root of your first workspace folder. On a folderless reload, it
re-mounts the folders for you (no permission prompts after the first
grant). The snapshot has its own editor with rename / refresh / clear
actions.

### 3. Presentation search

Command palette → **Presentation Search: Open**.

A workspace-wide search panel that matches across:

- Filename
- `dc:creator` (author) metadata
- First-visible-slide text

Type a query and watch results appear as you type. AND across terms by
default, with an **Any term (OR)** checkbox. Results are grouped by
workspace folder, deduplicated by content hash, and a coloured badge
highlights when the same content lives in multiple places (a useful
sanity check when you're shipping the same deck to several conference
rooms). Click a result to open the viewer.

**Multi-select with Update with…** — pick a source row, tick one or
more target rows, and push the same content into every target in one
gesture. PDF sources route through the viewer's PDF→PPTX import flow
automatically.

Sync destinations are excluded from indexing — the search shows you
*sources* and other workspace folders, not their mirrors.

### 4. Event schedule editor

For conference / event organisers: a form-driven planner for
`*.eventSchedule` files. Lay out an event as **days × timeslots × rooms**
and assign speakers to each session, then generate a folder tree ready
to wire up with the sync feature.

**Event header.**

- **Event name** + **days** (comma-separated, e.g. `MON, TUE, WED`)
- **Default timeslots** — comma-separated labels (e.g. `A, B, C`) seeded
  into any newly-added day. An **Apply to all** button next to it
  positionally renames every existing day's slots to match — a pure
  rename that cascades into sessions, never drops one.

**Speaker pool + rooms.**

- Add / remove speakers (chips). The speaker pool also grows
  automatically when you paste a roster (see below).
- Add / remove rooms; each room has a kind (plenary, breakout, etc.)
  used by the folder generator.

**Day × timeslot × room grid.**

- Click any cell to open a session edit panel. Edit session title
  (optional free-form), and add / remove / reorder speakers via the
  inline **speaker picker** — the picker filters out anyone already
  assigned to another session at the same `(day, timeslot)` so a single
  click can never double-book. Drag chips to reorder.
- Hover a row's leftmost cell for the timeslot affordances: **▲ / ▼**
  reorder the slot up or down within the day, an inline rename input
  (filename-safe), and **✕** to delete (modal confirms with affected-
  session count). Per-day independent — renaming MON's "B" doesn't
  touch TUE's.
- Hover a filled session cell for **▲ / ▼** at the right edge: swap
  this session with the row neighbour *in the same room*.
- A trailing **+ Add timeslot to `<day>`** row appears under every
  day-block; new labels default to the next letter past the day's max.
- Session edit panels are **mutually exclusive** — opening one
  auto-closes any other.

**Bulk paste workflows.**

- Paste a multi-line clipboard payload (e.g. an Excel column) into the
  speaker or room **Add** input and the whole list ships as one bulk
  add. Pressing Enter on a single name still works as expected.
- Paste a roster into a session's **speaker picker** filter to replace
  that session's roster with the pasted names. Unknown names auto-add
  to the pool (so you can build a schedule from a list of rosters
  without a separate speaker-adding step). Same-timeslot conflicts
  resolve automatically — anyone displaced from another session is
  surfaced in a modal.

**Tools section** (collapsible).

- **Generate sample schedule** — fills an empty file with random
  example data using the breakout/plenary knobs (room count, breakout
  count, etc.). Visible *only* when the file is empty or structurally
  empty so authored data can never be wiped.
- **Clear** — wipes speakers + rooms + sessions (modal confirm), but
  keeps your config + days + timeslot labels. Turns the file back into
  a placeholder that **Generate sample schedule** can refill.
- **Generate folders…** — materialises a folder tree from the schedule
  into a destination of your choice. Layout chooser
  (**room-major** vs **day-major**); writes one empty-`.pptx` placeholder
  per (session, speaker) plus one **`<roomId>.roomSync`** template per
  unique room ready to wire up with the sync feature. Re-runs preserve
  any `.roomSync` you've hand-wired.

JSON-Schema IntelliSense lights up if the file is reopened as text.

---

## Quick start

### vscode.dev (no install)

1. Open <https://vscode.dev>.
2. Install **Presentation Folder Sync** from the Extensions sidebar.
3. *File → Add Folder to Workspace* and pick a folder containing
   `.pptx` files.
4. Click any `.pptx` — the viewer takes over.

### Desktop VS Code

1. Install from the Marketplace (search "Presentation Folder Sync"), or
2. Download a `.vsix` from the [releases page][releases] and use
   *Extensions sidebar → ⋯ menu → Install from VSIX*.

[releases]: https://github.com/jonathan-annett/pptx-viewer-ext/releases

---

## Configuring sync

The sync feature reads a `.sync.jsonc` at the root of each source folder.
Minimal example:

```jsonc
{
  // Destinations are workspace folders, identified by URI.
  // Copy the URI from .admin-sync.jsonc (the workspace snapshot file)
  // — using the URI rather than a display name means renaming a folder
  // in the UI won't break this config.
  "destinations": [
    { "uri": "file:///handle/abc-backup-drive" },
    { "uri": "file:///handle/def-archive", "path": "snapshots/alpha" }
  ],

  // Optional: glob patterns to exclude (added to the built-in ignore list)
  "exclude": [
    "node_modules/**",
    "build/**",
    "*.tmp"
  ]

  // Optional: glob patterns to include (default is everything not excluded)
}
```

**Always ignored** (you don't need to list these): `.git/`,
`.DS_Store`, `Thumbs.db`, `~$*` (Office lock files), `.sync.jsonc`
itself, `.foldersync-manifest.json`, and `*.tmp`.

The bundled JSON schema gives you autocomplete and red squiggles in the
text editor; the custom editor gives you dropdowns of currently-open
workspace folders so you don't have to copy URIs by hand for the simple
case.

---

## Commands

All available from the command palette under the **Folder Sync**, **Pptx
Info**, and **Presentation Search** categories:

| Command | What it does |
|---|---|
| **Presentation Search: Open** | Open the search panel |
| **Folder Sync: Show Plan** | Open the workspace-wide sync plan |
| **Folder Sync: Sync This Folder** | Folder-scoped plan (also on Explorer right-click) |
| **Folder Sync: Show Topology** | Print resolved sources + destinations to the Output panel |
| **Folder Sync: Dry-Run Plan** | Print the plan to the Output panel as text |
| **Folder Sync: Open Admin Config** | Open the workspace snapshot editor |
| **Folder Sync: Show / Clear Workspace Snapshot** | Diagnostic + reset |

---

## What this extension does **not** do (by design)

- **No slide rendering.** The viewer surfaces metadata, validation, and
  a thumbnail. To see the slides themselves, open the file in
  PowerPoint, Keynote, or LibreOffice.
- **No legacy `.ppt` support.** Pptx only.
- **No bidirectional sync.** Pushes go one way: source → destination(s).
  Nothing flows back.
- **No scheduled or automatic sync.** You convene every run. The plan
  webview is always between you and any write.
- **No three-way merge.** When a destination file has drifted out from
  under the manifest, the plan flags it as a collision; you choose
  overwrite or skip. There's no merging.
- **No background watchers writing files.** File watchers exist to keep
  the plan view fresh, never to fire writes.

---

## How writes work

- Atomic write pattern: contents go to `<path>.tmp` first, then a rename
  swaps it into place. An interrupted sync leaves only the original
  file at the final path; orphan `.tmp` files are swept on the next
  run.
- Files are matched by content (SHA-256). Renaming a destination file
  doesn't confuse the planner — but the manifest is keyed by source
  path, so files renamed *at the source* surface as a delete + create
  pair until you sync.
- In vscode.dev, folder access is granted by the browser's File System
  Access API. The first time you add a folder it asks; subsequent
  refreshes restore the grant automatically.

---

## Where to look when something seems off

- **Output panel → Pptx Info** — activation, per-file parse, sync
  events, and any errors
- **DevTools console** (Help → Toggle Developer Tools) — same lines,
  prefixed `[pptx-viewer]`, plus a build timestamp + short git SHA per
  activation. Handy when reporting issues.

---

## Issues and feedback

Report at <https://github.com/jonathan-annett/pptx-viewer-ext/issues>.
PRs and discussions welcome.

## License

MIT.
