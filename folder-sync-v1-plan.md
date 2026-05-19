# Folder Sync — v1 Plan

## Purpose

Add a one-way folder sync feature to the existing `pptx-viewer-ext` VS Code web extension. Users author small JSONC files in their source folders describing where each should sync to; destinations are workspace folders added to vscode.dev via "Add Folder to Workspace". The user **convenes** a sync deliberately (no timers, no background watchers); each run produces a plan that the user reviews and gates before any writes happen.

**Config format note:** v1 originally used `.sync.yaml` with a hand-rolled mini-parser. Partway through development we pivoted to `.sync.jsonc` (JSON with comments + trailing commas) parsed by the `jsonc-parser` package. Reasoning: VS Code's own settings/tasks/launch ecosystem is JSONC, and `contributes.jsonValidation` gives us IntelliSense + validation for free against a bundled JSON Schema. The original justification for YAML — human-authorable templates with comments — is better served by a forthcoming custom-editor UI than by YAML syntax. See `M4.5` below.

The pptx-viewer feature continues to exist alongside the sync engine. The validation checks the viewer surfaces (linked media, kiosk/window show mode, show-media-controls) flow into the sync plan as flagged items, surfacing for user decision at gate time.

This plan covers the sync feature only. The development substrate (web extension runtime, FSA file access via `vscode.workspace.fs`, the VPS test harness, build and dev workflow) is documented separately and assumed.

---

## User-facing model

1. User opens vscode.dev with one workspace folder containing one or more **source** folders. Each source has its own `.sync.jsonc` describing its destinations.
2. User adds **destination** workspace folders via "Add Folder to Workspace". These are referenced by name from the source configs.
3. User invokes a sync via Explorer context menu, status bar button, command palette, or optional keybinding.
4. A webview panel shows the **plan** — a categorized list of every operation that would occur.
5. User gates the operation via a traffic-light decision:
   - **Green** when nothing needs attention — single button, proceed.
   - **Orange + Red** when issues exist — no default highlighted, deliberate choice between "proceed with OK only" or cancel.
6. After execution, a summary appears in the Output Channel; a notification reports overall success/failure counts.

The user is the "event" — sync is a convened operation, not a reactive automation.

---

## Concepts

| Concept | Definition |
|---|---|
| **Source** | Any folder containing a `.sync.jsonc` file. Can sit at any depth within a workspace folder. |
| **Destination** | A workspace folder whose name is referenced from some source's config. Detected automatically — no explicit marking needed. |
| **Scope** | The subset of the workspace targeted by a given sync invocation. Either workspace-wide or a specific folder under a source. |
| **Plan** | A structured list of every operation that would occur given the scope and current state. Produced before any writes. |
| **Manifest** | A persistent record of what sync has placed in a destination, plus user "don't ask again" decisions. Lives in destination root. |

---

## Configuration

### `.sync.jsonc` schema

```jsonc
{
  // Required: at least one destination
  "destinations": [
    {
      "name": "backup-drive",        // Must match a workspace folder name
      "path": "projects/alpha"       // Optional subpath within the destination
    },
    {
      "name": "archive-server",
      "path": "snapshots/alpha"
    }
  ],

  // Optional: glob patterns to exclude (in addition to built-in ignores)
  "exclude": [
    "~$*",
    "*.tmp",
    "node_modules/**"
  ],

  // Optional: glob patterns to include (default: everything not excluded)
  "include": [
    "**/*"
  ]
}
```

The config lives at the root of any folder treated as a source. The file itself is implicitly excluded from sync. Parsed with `jsonc-parser` so comments and trailing commas are first-class — same dialect VS Code uses for `settings.json`, `tasks.json`, `launch.json`.

A JSON Schema (bundled at `schemas/sync.schema.json`) is registered via `contributes.jsonValidation` against `**/.sync.jsonc` — the user gets IntelliSense, hover docs, and red-squiggle validation in the regular text editor with no extra wiring.

### Built-in ignores (always applied)

- `.sync.jsonc` (the config itself)
- `.foldersync-manifest.json` (sync state, never copied)
- `.DS_Store`, `Thumbs.db` (OS metadata)
- `~$*` (Office lock files)
- Any path beginning with `.git/`

### Hot reload

Config changes are picked up automatically via `vscode.workspace.createFileSystemWatcher('**/.sync.jsonc')`. Editing a config triggers topology re-resolution before the next sync invocation; no restart needed.

### Topology validation at load

Each time the config set is reloaded:

- Every `destinations[].name` must resolve to a workspace folder currently open. Unresolved names produce warnings in the Output Channel: *"destination 'backup-drive' is not currently in the workspace"*. The source is still loadable; the unresolved destination will be skipped at sync time.
- Multiple sources targeting the same destination must use non-colliding subpaths. Collisions are configuration errors that block sync until resolved.
- A malformed config emits an error in the Output Channel; the affected source is excluded from sync until fixed.

---

## Sync engine

Every sync run follows three phases: **plan → gate → execute**. The user only ever sees one decision surface (the plan webview); execution after green/orange is silent and uninterrupted.

### Phase 1 — Plan

Given a scope (workspace-wide or folder-scoped):

1. **Source discovery**
   - Workspace-wide: walk all workspace folders, find every `.sync.jsonc`. Each is a source root.
   - Folder-scoped: walk up from the selected folder. The nearest `.sync.jsonc` is the source. The scope is restricted to files at or below the selected folder.

2. **Destination resolution**
   - For each source, look up each `destinations[].name` as a currently-open workspace folder URI.
   - Apply the optional `path` subpath.
   - For folder-scoped syncs, append the selected folder's relative offset to that destination subpath, so a sync of `alpha/src/utils` writes to `<destination>/projects/alpha/src/utils/...`.

3. **Source enumeration** — walk the source's file tree, respecting includes/excludes and built-in ignores. Produces the set of source files in scope.

4. **State comparison** — for each source file, decide which operation applies, consulting the destination state and the manifest:

   | Operation | When |
   |---|---|
   | **Create** | Source has it; destination does not |
   | **Update (tracked)** | Both have it; manifest entry exists with prior hash; current source hash differs; current destination hash matches prior manifest hash |
   | **Update (collision)** | Both have it, but the manifest doesn't know we placed the destination version — overwriting would clobber unrelated content |
   | **Skip (unchanged)** | Both have it; hashes match |
   | **Delete (tracked removal)** | Manifest has an entry for this file; source no longer has it |

5. **Destination reverse pass** — walk the destination's scope-matched subtree:
   - Files matching a manifest entry are handled above
   - Files with no matching manifest entry are **destination-only files** (never placed by sync)

6. **Validator pass** — run filetype-specific validators on relevant files. v1 ships with the pptx validators already in the viewer:
   - Linked external media present
   - Show type is window (`<p:browse/>`) or kiosk (`<p:kiosk/>`)
   - `showMediaControls="1"` on `<p:showPr>`
   
   Each warning is attached to its file as flagged-item metadata in the plan.

7. **Plan assembly** — operations grouped by category, counts computed, per-file metadata attached (size, hash, validator warnings).

### Phase 2 — Gate

Present the plan in the webview panel. User reviews and chooses to proceed (fully or partially) or cancel. See **Plan / gate UI** below for details.

### Phase 3 — Execute

For each approved operation, in order:

- **Create / Update** — read source bytes via `vscode.workspace.fs.readFile`; write to `<destPath>.tmp` via `writeFile`; `vscode.workspace.fs.rename(tmpUri, finalUri)` to commit atomically; update manifest with new hash and current timestamp.
- **Delete** — `vscode.workspace.fs.delete(uri)`; remove from manifest.
- **Destination-only deletion** (only if the user explicitly toggled it) — same delete; if user checked "don't ask again", record the decision in the manifest.

**Error handling.** Per-file errors do not abort the run. Each failure is recorded with file path, attempted operation, and the error. After execution, a summary line goes to the Output Channel and a notification reports total successes/failures, with a "Show details" action linking back to the Output Channel.

**Atomicity.** The tmp + rename pattern ensures the destination never contains a partially-written file at the final path. Orphaned `.tmp` files from interrupted runs are cleaned up at the start of the next sync's destination reverse pass.

---

## Plan / gate UI

The plan is presented in a webview panel (separate from the pptx-viewer custom editor — this is a regular webview, not a custom editor).

### Layout

- **Header** — scope description ("Sync everything — 3 sources" or "Sync this folder: projects/alpha/src") and aggregate counts ("12 to create, 3 to update, 2 to delete, 4 destination-only, 1 warning")
- **Sections**, each with a count in the heading and collapsible body. In order:
  1. **To create** — clean creates, no decisions needed
  2. **To update (tracked)** — manifest-tracked overwrites, no decisions needed
  3. **To delete (source removed)** — manifest-tracked deletions, no decisions needed
  4. **Collisions requiring confirmation** — per-row "overwrite this file" toggle plus "don't ask again" checkbox
  5. **Destination-only files** — per-row "delete this file" toggle (default off) plus "don't ask again" checkbox
  6. **Validation warnings** — per-row reason ("kiosk mode set", "showMediaControls enabled", "linked external video on slide 4"). Cannot be resolved inline — only via the orange button (skip these files) or red (cancel everything)
- **Per-row info** — file path (relative to source), size, brief reason or hash diff where helpful
- **Footer buttons** — traffic light:
  - **All blocks resolved**: single green **Proceed**
  - **Unresolved blocks present**: orange **Proceed with OK only** + red **Cancel**, no default highlighted
  - As the user toggles inline decisions, the footer transitions live — once all collisions are resolved and only validation warnings remain, the buttons stay orange/red; if the user resolves a collision via toggle, that one moves out of the block count

### What counts as blocking

- Validation warnings on files (only resolvable via orange = skip them, or red = cancel)
- Collision overwrites that haven't been confirmed (either inline toggle, or remembered "don't ask again" from a prior run)

### What does not block (handled silently on green)

- Creates
- Tracked updates (manifest knows the prior content)
- Tracked deletions (source removed)
- Destination-only files with no user toggle (default behaviour: leave alone)

---

## Manifest

### Purpose

Distinguish "files sync placed here" from "files the user added independently", and persist user "don't ask again" decisions.

### Location

`.foldersync-manifest.json` at the root of each destination workspace folder. Travels with the destination — if the folder is moved or re-mounted, sync state goes with it. The manifest is in the built-in ignore list and is never itself copied during sync.

### Schema

```json
{
  "version": 1,
  "lastSync": "2026-05-17T10:30:00Z",
  "entries": {
    "<sourceWorkspaceFolder>:<relativePath>": {
      "destPath": "projects/alpha/src/main.ts",
      "size": 1234,
      "sha256": "abc123...",
      "syncedAt": "2026-05-17T10:30:00Z"
    }
  },
  "decisions": {
    "<sourceWorkspaceFolder>:<relativePath>": {
      "destOnlyDelete": false,
      "collisionOverwrite": true,
      "decidedAt": "2026-05-17T10:30:00Z"
    }
  }
}
```

- `entries` — each tracked file, keyed by source identity + relative path; records what was placed where and the hash at sync time
- `decisions` — remembered "don't ask again" answers, keyed the same way

### Lifecycle

- Created on the first sync that places anything in the destination
- Updated atomically (tmp + rename, same as sync files) after each successful operation
- Read at the start of each sync's plan phase
- A missing or corrupt manifest is treated as "no entries yet". Existing files in the destination then surface as destination-only files in the plan — making this state visible by symptom (large destination-only count) rather than hiding it
- Forward-compatibility: if the version field is higher than the extension expects, refuse to sync and emit a clear error ("manifest written by a newer version")

---

## Invocation surfaces

| Surface | Behaviour |
|---|---|
| Explorer context menu — folder | "Folder Sync: Sync This Folder" — folder-scoped. Greyed (with tooltip) if no `.sync.jsonc` at or above the selection, or the selection is inside a destination workspace folder |
| Status bar button | "Folder Sync" with sync icon — workspace-wide. Tooltip shows source/destination count |
| Command palette | "Folder Sync: Sync Everything" (workspace-wide) and "Folder Sync: Sync This Folder" (acts on the active editor's folder, or first selected explorer item) |
| Optional keybinding | User-configurable via standard VS Code keybinding; no default binding ships |

For workspace-wide invocations covering multiple sources, the plan is **aggregated** into a single plan/gate/execute cycle with items grouped by source. The user cannot deselect individual sources within an aggregated plan in v1 — to sync "everything except source X", cancel and invoke per-source from the explorer.

---

## Edge cases and defaults

### Workspace structure

- **No `.sync.jsonc` anywhere in the workspace** — status bar button shows "No sync configuration"; context menu items are greyed.
- **`.sync.jsonc` references a destination not in the workspace** — warning at config load, that destination skipped at sync time; the plan summary reports "skipped: destination 'X' not available".
- **Nested sources** (e.g. `projects/.sync.jsonc` AND `projects/alpha/.sync.jsonc`) — closest wins (the "at or above" rule). The outer config never sees `alpha` because alpha's own config takes over for that subtree.

### Sync execution

- **A file changes during sync** — the read in execute happens after the plan was computed. If the source file changed between plan and execute, the size/hash check downstream fails — treated as a per-file error, recorded, sync continues. v1 doesn't lock or re-plan; the user reruns.
- **Disk full / write failure on destination** — recorded as a per-file error, sync continues with remaining files, summary surfaces the failure prominently.
- **Permission denied (e.g. UNC network glitch)** — same: recorded, sync continues.

### Manifest

- **Manifest absent but destination has files** — all destination files become destination-only in the plan. User most likely just proceeds, which creates manifest entries for files that also exist in source. Pure destination-only files remain destination-only.
- **Manifest version newer than extension** — refuse to sync, surface error.

### Config format migration

- **Existing `.sync.yaml` files** — once M4.5 ships, the YAML loader is gone. The format is not auto-migrated by the extension; users with pre-pivot files convert by hand (the schema is small and the new authoring UI makes it a one-time chore). If we ever publish to a marketplace, a one-shot migration command might be worth adding.

---

## Out of scope (v1)

Raised in conversation, deliberately not in v1:

- Time-based / scheduled syncs (no timer)
- File-system-watcher-driven auto-prompts on source change
- Per-row checkbox selection of arbitrary file subsets (only the traffic light + per-decision inline toggles for the two interactive categories)
- Bidirectional sync
- Conflict-resolution policies beyond skip/overwrite (no three-way merge, no newer-wins logic)
- Sync history beyond the most recent run summary
- Sync of individual files (folders are the unit)
- Deselecting individual sources from a workspace-wide aggregated plan (cancel and run per-source instead)
- Queue-and-run-when-online or deferred-sync modes
- Custom network protocols beyond what the workspace folder URI provides (UNC support comes from the OS through FSA; nothing custom)

---

## Milestones

The v1 scope is sequenced into milestones. Each milestone is a single coherent diff, testable end-to-end on the VPS test harness, and leaves the existing pptx viewer untouched. Earlier milestones de-risk later ones — the config layer and plan engine are exercised long before any code writes a file. M1–M4 shipped against `.sync.yaml`; M4.5 pivots the format to `.sync.jsonc` and adds a minimal authoring UI, after which M5/M6 resume.

### M1 — Config layer + diagnostics ✅ shipped (commit 4a60c73)

- Load `.sync.yaml` files via `vscode.workspace.findFiles`, parsed with a hand-rolled subset parser (`src/sync/yaml-mini.ts`) — the `yaml` npm package was tried first and dropped because it added 207 KB to the bundle
- `FileSystemWatcher` on `**/.sync.yaml` for hot reload
- Topology validation at load: destination name resolution, subpath collision detection, malformed yaml reporting
- Output Channel diagnostics for each load cycle
- Command **Folder Sync: Show Topology** — dumps resolved sources/destinations to the Output Channel
- Status bar item showing source/destination counts, or "No sync configuration"

**Done when:** authoring a yaml causes topology to resolve live, unresolved destinations produce a warning, the topology command prints the current resolved view.

> **Note (post-M4 pivot):** the yaml-mini implementation and `.sync.yaml` filename will be replaced with `.sync.jsonc` parsed by `jsonc-parser` as part of **M4.5** below. The M1 outcomes (load, hot reload, topology validation, status bar) remain — only the file format and parser swap.

### M2 — Plan engine (workspace-wide, no UI) ✅ shipped (commit 9e05937)

- Glob matching for `include`/`exclude` plus the built-in ignore list
- Source-tree walk via `vscode.workspace.fs`
- SHA-256 hashing via `crypto.subtle`
- Manifest reader (missing/corrupt treated as "no entries"). Split into `manifest-types.ts` (pure data) and `manifest.ts` (vscode I/O) so the pure plan tests can run under tsx without a vscode shim.
- State comparison producing the six operation categories (create, update-tracked, update-collision, skip-unchanged, delete-tracked, destination-only) — pure function in `src/sync/plan.ts`, no vscode dependency
- Command **Folder Sync: Dry-Run Plan** — dumps the categorized plan to the Output Channel

**Done when:** every operation category is exercisable by setting up the right source/destination state and verifying the output text. No filesystem writes anywhere yet.

### M3 — Plan webview UI (read-only) ✅ shipped (commit 19f0be2)

- New regular webview panel (not a custom editor) with explicit CSP + per-render nonce, following the pptx-viewer pattern
- Header with scope description + aggregate counts
- Collapsible sections with per-row info (path, size, brief reason)
- Traffic-light footer: **Cancel** wired up; **Proceed** buttons rendered but disabled (Proceed is wired in M4)
- Invocation via command palette only for now
- Pure/vscode-wired split: `planHtml.ts` (pure renderer, tsx-testable) vs `planView.ts` (vscode panel wiring)

**Done when:** the plan webview renders the M2 plan structure and can be dismissed. No execution path yet. ✅

### M4 — Executor + manifest writes (green path) ✅ shipped (commit aed3a74)

- Atomic writes via `writeFile` to `<path>.tmp` then `vscode.workspace.fs.rename`
- Manifest read → mutate → atomic write (same tmp+rename pattern)
- Create / tracked-update / tracked-delete execution, with pure executor in `src/sync/executor.ts` (injected `SyncFs<U>`) and vscode-wired orchestrator in `src/sync/runSync.ts`
- Per-file error isolation; Output Channel summary; completion notification with success/failure counts
- Green **Proceed** button wired up for plans with no blocking items; clean no-op plans show "Nothing to do" + Close

**Done when:** a clean sync (no collisions, no validation warnings) runs end-to-end and the manifest reflects what was placed. ✅

### M4.5 — JSON pivot + minimal authoring UI ✅ shipped

**Why this exists:** After M4 shipped working, the user decided in-depth testing should wait until there's a UI for editing settings, and standardised the project on JSON over YAML because VS Code's settings/tasks/launch ecosystem is JSONC. M5 and M6 were paused until M4.5 shipped.

**What shipped:**

- Format pivot complete — `.sync.yaml`/`yaml-mini.ts` gone; `.sync.jsonc` parsed via `jsonc-parser` package.
- Pure parser in `src/sync/configParse.ts` (tsx-testable) + vscode-wired loader in `src/sync/config.ts`. Field `yamlUri` renamed to `configUri` everywhere.
- JSON Schema at `schemas/sync.schema.json` registered via `contributes.jsonValidation` against `**/.sync.jsonc`. Schema is included in the .vsix (not in `.vscodeignore`). The user gets IntelliSense + red squiggles when editing as text.
- Minimal `CustomTextEditor` for `.sync.jsonc` (`folderSync.configEditor`, priority `default`):
  - Destination rows with `<select>` populated from current workspace folders, subpath input, add/remove rows
  - Plain textareas for include/exclude (one glob per line)
  - Form edits flow back into the document via `jsonc-parser`'s `modify()` API so comments + formatting on other keys are preserved
  - **Dry run** button opens the existing M3 plan webview (workspace-wide) in a separate panel — the "embedded plan in the lower half" was descoped to keep this milestone minimal; embedding is a polish item in the post-v1 roadmap
  - **Reopen as text** button delegates to `vscode.openWith` with the default text editor
  - CSP + per-render nonce same as plan webview and pptx viewer
  - Pure renderer in `configEditorHtml.ts` (with smoke tests under tsx) + vscode-wired `configEditor.ts`

**Below: the original plan; preserved for reference.**

**Part A — format pivot (mechanical)**

- Add `jsonc-parser` to dependencies (bundled; small)
- Delete `src/sync/yaml-mini.ts` and `test/sync-yaml.test.ts`
- Rewrite `src/sync/config.ts` to parse `.sync.jsonc` via `jsonc-parser` (use `parseTree` + `getNodeValue` so we keep span info for error reporting; or `parse` with errors array if spans aren't needed)
- Update `src/sync/manager.ts` glob to `**/.sync.jsonc`; update the `FileSystemWatcher` pattern likewise
- Update `src/sync/planner.ts` (and anywhere else) to drop the dynamic `./yaml-mini` import in favour of the JSONC path
- Migrate any in-repo `.sync.yaml` test fixtures to `.sync.jsonc`
- Remove the `test:sync-yaml` script from `package.json`

**Part B — schema + IntelliSense**

- Author `schemas/sync.schema.json` describing the config shape (destinations, include, exclude, with descriptions on each property)
- Register via `package.json` `contributes.jsonValidation`:
  ```json
  "contributes": {
    "jsonValidation": [
      { "fileMatch": ["**/.sync.jsonc"], "url": "./schemas/sync.schema.json" }
    ]
  }
  ```
- Bundle the schema file into the published extension (esbuild config or copy step)

**Part C — minimal authoring custom editor**

A `CustomTextEditor` for `.sync.jsonc` files. Just enough surface that a user can pick destinations from a dropdown of currently-open workspace folder names rather than typing them, and can hit "Dry run" to see the plan inline without leaving the editor. Reuses `renderPlanHtml` + the M2 dry-run plan builder — no new engine code.

- Custom editor activates on `.sync.jsonc` (registered as a secondary editor — the user can still open as raw text via "Reopen With")
- Upper half: form-style controls
  - List of destinations with `<select>` populated from `vscode.workspace.workspaceFolders` names
  - Subpath text input per destination
  - Add/remove destination row
  - Plain textareas for include/exclude glob lists (one per line is fine for v1; better authoring is a future polish task)
- Lower half: embedded plan webview, refreshed by a **Dry run** button
- Two-way sync between the form and the underlying JSONC text: edits in the form re-serialise via `jsonc-parser`'s modification API (preserves comments + formatting where possible)
- CSP + per-render nonce same as the plan webview

**Done when:**

- `.sync.jsonc` files in samples/fixtures replace the old `.sync.yaml`
- The bundled JSON Schema gives IntelliSense + red squiggles in a plain text editor on a malformed config
- The custom editor opens by default on `.sync.jsonc`, shows destinations as dropdowns of workspace folder names, and a Dry-run click renders the M3 plan webview inline
- All existing pure tests pass against the new parser path
- `yaml-mini.ts` and `test/sync-yaml.test.ts` are gone from the tree

### M4.6 — Workspace snapshot + silent restore *(active target)*

**Starting point for the next session:** Spec below is signed off. The first concrete step is the cold-read URI probe (first bullet under "Open design questions") — it's load-bearing for the whole architecture. Run it on the VPS before writing any snapshot module. The "Snapshot shape" and "Restore path" sections assume the probe succeeds; the fallback (if it fails) is noted under that bullet.

**Why this exists:** vscode.dev loses its open-folder set on browser refresh, but FSA grants persist at the origin level (verified empirically — pasting the workspace JSON back via *Workspaces: Open Workspace Configuration File* re-attaches folders with no further permission prompts, even in a fresh window of the same browser profile). The extension can automate that restore: persist the workspace shape on every topology change, replay it on a folderless activation.

This is orthogonal to M5's interactive UI work — it touches activation flow and storage, not the plan/gate engine. Slotting it before M5 because (a) it materially improves the test loop the user is about to lean on for M5 dogfooding, and (b) it's small.

**Storage model:**

- **`.admin-sync.jsonc`** at the top level of `workspaceFolders[0]` is the snapshot file. JSONC for consistency with `.sync.jsonc`. Contains a managed-by-extension header comment warning the user not to hand-edit, then:
  - `folders` — array of `{ uri: string, name: string }`. Both fields captured explicitly: users can override folder display names in the workspace config (e.g. `name: "P1 PC2"` for `uri: "file:///Plenary1 PC2"`), and the restore must preserve the override.
  - `settings` — full Workspace-target configuration blob (everything the user would see in *Open Workspace Configuration File*, not just `files.readonly*`).
  - `capturedAt` — ISO timestamp for diagnostics.
- **`context.globalState`** holds one pointer entry under `folderSync.snapshotPointer`:
  - `uri` — the `.admin-sync.jsonc` location as a string.
  - `lastWriteAt` — ISO timestamp matching `capturedAt`, for staleness diagnostics.
- First-folder convention: `workspaceFolders[0]` is also (by user convention, e.g. via `files.readonlyExclude`) the writable folder. Positional, not name-based — array position is load-bearing, display name is decorative.
- Why this split: globalState alone can't carry the snapshot across a `globalState` wipe (browser profile reset, extension reinstall). The on-disk file is the durable artifact; the pointer is the cold-start hint. If the pointer is wiped but the file survives, an import wizard (deferred to follow-up) can re-establish the link.

**Trigger and write path:**

- On any topology change (added/removed source, destination resolved/unresolved, config edit applied), recompute the snapshot from current `workspaceFolders` + workspace config.
- Atomic write: tmp + rename via `vscode.workspace.fs.rename`, same pattern as the manifest writer.
- Update `globalState.snapshotPointer` to match the new `capturedAt`.
- If `workspaceFolders` is empty, no write — there's nothing to capture and writing would require knowing which folder to target.

**Restore path (cold activation):**

1. Read `globalState.snapshotPointer`. If absent → no restore, log `snapshot: no pointer, no restore`.
2. If `workspaceFolders` is already non-empty → no restore (user opened something via UI). Refresh pointer on the next topology change as usual.
3. Otherwise, `vscode.workspace.fs.readFile(pointer.uri)` to load `.admin-sync.jsonc`. (See empirical probe below — load-bearing unknown.)
4. Parse via the existing `jsonc-parser` setup.
5. Call `vscode.workspace.updateWorkspaceFolders(0, 0, ...folders.map(f => ({ uri: vscode.Uri.parse(f.uri), name: f.name })))`. Names preserved.
6. Apply each settings key via `getConfiguration().update(key, value, ConfigurationTarget.Workspace)`.
7. Surface a single toast: `Workspace restored from snapshot · Undo`. Undo clears pointer + file and removes the just-added folders.
8. Any failure (file unreadable, pointer stale, parse error) → log it, leave workspace alone, never crash activation.

**Known settings keys** (`files.readonlyInclude`, `files.readonlyExclude`, anything else found during implementation) are restored without comment. Unknown keys are also restored (full-blob policy) but each unknown key is logged: `snapshot: restoring unknown setting <key> = <value summary>`. Diagnostic only — never blocks restore.

**Commands:**

- **Folder Sync: Clear Workspace Snapshot** — wipes `globalState.snapshotPointer` *and* deletes `.admin-sync.jsonc`. Confirmation prompt; destructive.
- **Folder Sync: Show Workspace Snapshot** — dumps the current on-disk snapshot to the Output Channel.
- **Folder Sync: Open Admin Config** — opens `.admin-sync.jsonc` in its custom editor (below).

**Custom editor on `.admin-sync.jsonc`:**

Registered as `folderSync.adminEditor`, viewType priority `default` so the file always opens with the safe editor (no accidental hand-edits). M4.6 surface is minimal:

- List of snapshotted folders (uri + name) and a settings summary.
- Per-folder **⋯** menu with a **Rename** action — opens an inline edit on the `name`, commits via `vscode.workspace.updateWorkspaceFolders(index, 1, { uri: same, name: newName })`. This is the only UX in vscode.dev that exposes folder renaming without making the user edit raw JSON, so any folder-list rendering we do is a natural place to surface it. Establishes the pattern for M4.7 and beyond — see "Folder rename as a cross-cutting UX touch" under the post-v1 polish section.
- Two buttons: **Clear snapshot**, **Refresh from current workspace** (re-captures now).
- Footer note: *"This file is managed by Folder Sync. Open as text via Reopen With → Text Editor only for diagnostics."*

M4.7 extends this editor with workspace-level sync commands (Full Dry-Run, etc) — that's the natural home per the framing of "top level info and commands that affect all the lower sync sources". M4.6 just establishes the editor and its maintenance commands.

**Open design questions to confirm during implementation:**

- **(load-bearing)** Can `vscode.workspace.fs.readFile(uri)` resolve a `vscode-vfs://` URI to a folder that *isn't currently mounted* in `workspaceFolders`? Probe: in a normal session with a folder open, write a throwaway command that (a) captures a file URI inside that folder, (b) removes the folder via `updateWorkspaceFolders`, (c) tries to read the captured URI. If it succeeds, the cold-restore architecture above works as-described. **If it fails**, restore becomes a two-step process: `updateWorkspaceFolders` to mount `workspaceFolders[0]` first using a URI shape we'd need to derive (probably from the pointer URI's parent), *then* read `.admin-sync.jsonc`, then continue with the remaining folders + settings. Same architecture, just an extra mount step at the front.
- URI round-trip shape: does `vscode.Uri.parse(snapshot.folders[0].uri)` produce a URI that `updateWorkspaceFolders` resolves against the FSA grant? Or do we need `vscode.Uri.from({...})` with explicit scheme/authority/path? Falls out of the same probe.
- Race against user-initiated workspace open: if the user is in the middle of *Open Folder* when activation fires, we must not race. Mitigation: only restore if `workspaceFolders` is still empty after a short `await new Promise(r => setTimeout(r, 0))` — gives VS Code a tick to finish any in-flight folder add.
- Settings round-trip: confirm `getConfiguration().update(..., Workspace)` is sufficient for all keys, or whether some (e.g. `files.readonlyInclude`) need `ConfigurationTarget.WorkspaceFolder` per-folder. Empirically validate against the user's existing readonly-locked-destinations setup.
- *(low priority)* `context.globalState` is per-extension but not per-origin. If the user ever installed this extension on both vscode.dev and desktop, a desktop session would clobber the vscode.dev snapshot pointer. Don't worry for v1 — desktop is not a target environment. Revisit if/when desktop publishing is on the table.
- *(deferred to follow-up)* Import wizard for the case where `globalState` is wiped but `.admin-sync.jsonc` still exists on disk. User opens *one* folder containing the file, extension detects it, offers to restore. Captures the resurrection path. Tracked as M4.6-follow-up, lands once the core flow is stable.

**Done when:**

- Refreshing the browser with `vscode.sophtwhere.com` open re-attaches the previously open folders (with custom names preserved) and re-applies workspace settings, with a single "Workspace restored from snapshot" toast and no permission prompts.
- Output Channel shows the activation decision: `snapshot: restored N folder(s) and M setting(s)` / `snapshot: workspace already populated, no restore` / `snapshot: no pointer, no restore`.
- `.admin-sync.jsonc` exists at the top level of `workspaceFolders[0]` after any topology change, is human-readable JSONC, and carries a "managed by Folder Sync — do not hand-edit" header comment.
- Unknown settings keys round-trip and log.
- The custom editor opens `.admin-sync.jsonc` as a read-only listing with Clear/Refresh buttons; hand-editing requires explicit Reopen With → Text Editor.
- *Clear Workspace Snapshot* produces a clean activation next refresh (no restore, no prompt, no file on disk).
- Snapshot updates on every topology change — verifiable by editing a `.sync.jsonc` to add a destination, refreshing, and seeing the new destination re-attached with its display name intact.

### M5 — Interactive decisions + validators *(paused until M4.6 ships)*

- Collision detection against the manifest
- Destination reverse pass to surface destination-only files
- Per-row toggles in the UI: "overwrite this", "delete this", "don't ask again"
- `manifest.decisions` persistence and re-application on next run
- Orange + red footer state with live transitions as toggles change
- Wire existing pptx validators (linked media, show type, showMediaCtrls + embedded video) into the plan as a Warnings category
- Orange button proceeds with non-blocked items only; red button cancels

**Done when:** collision and destination-only scenarios behave per spec; "don't ask again" persists across runs; pptx warnings appear and block green.

### M6 — Polish + remaining surfaces *(paused until M4.6 ships)*

- Explorer context menu entries with grey-out rules (no `.sync.jsonc` at/above selection; selection inside a destination)
- Folder-scoped invocation: nearest-yaml rule + relative-offset destination subpath
- Status bar button as alternate workspace-wide invocation
- Orphan `.tmp` cleanup at the start of each run's destination reverse pass
- Manifest version-mismatch refusal with a clear error
- Walk the Definition of Done checklist; close any remaining gaps

**Done when:** every Definition-of-Done bullet below is satisfied.

---

## Definition of done (v1)

- User can author a `.sync.jsonc` in a source folder, add destinations to the workspace, and convene a sync from Explorer context menu, status bar, or command palette
- Workspace-wide and folder-scoped invocations both produce a categorized plan
- Plan webview shows all operation categories with counts, per-file detail, and the traffic-light decision pattern
- Green proceeds silently for clean syncs; orange proceeds with non-blocked operations only; red cancels everything
- Per-file "remember this decision" persistence works across sync runs
- Manifest is created, updated, and read correctly; survives the destination folder being moved or re-mounted
- Per-file failures don't abort the run; summary surfaces them clearly
- Pptx validation flags appear in the plan as a dedicated category and behave as blocks
- All vscode.dev FSA constraints respected: no Node APIs, web-extension only, atomic writes via tmp + rename

---

## Post-v1 roadmap

Items raised in conversation that wait until v1 ships. Listed in rough order of expected value; sequencing decided when v1 is closer to done.

### Authoring UI polish (after M4.5 minimal version)

M4.5 ships a *minimal* `.sync.jsonc` custom editor: workspace-folder dropdown, subpath input, add/remove rows, glob textareas, embedded dry-run. Polish that didn't make M4.5:

- Richer glob editor (per-pattern row with remove button, validation against the schema, an "exclude default" toggle that adds/removes the common boilerplate patterns)
- Live preview of which files match the current include/exclude set without running a full dry-run
- "Save as template" — copy the current config to clipboard or another folder
- Visual diff when the user has edited the form vs the underlying file (e.g. comments would be lost)

### Folder rename as a cross-cutting UX touch

VS Code's built-in UI doesn't expose a friendly way to set a workspace folder's display `name` — the user has to hand-edit the workspace JSON via *Workspaces: Open Workspace Configuration File*. Any feature of ours that renders a list of folders or destinations should expose a **⋯ → Rename** affordance that commits via `vscode.workspace.updateWorkspaceFolders(index, 1, { uri: same, name: newName })`. Established in M4.6's admin editor; inherited by M4.7's config editor destination rows, the workspace control panel (M4.7), and any further folder-list rendering. Cost is one short helper module and a confirmation prompt; payoff is users get folder rename for free everywhere we render the list.

### Per-file sync from the pptx viewer

A "Sync now" action on the pptx custom editor's metadata page. Resolves the file's source `.sync.jsonc` (nearest-config rule), pushes the single file to each destination immediately (no plan/gate cycle — the user already saw the file open), updates the manifest, and surfaces sync status as a new metadata row (last synced timestamp + destination list, or "not under a sync source"). Skips the collision/validator gate when invoked this way — the user is acting on one known file and has the viewer's validation output in front of them.
