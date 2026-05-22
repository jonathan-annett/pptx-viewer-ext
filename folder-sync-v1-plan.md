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
  // Required: at least one destination. Destinations are keyed by URI — copy
  // the value from the matching entry in .admin-sync.jsonc (folders[].uri).
  // Using the URI rather than the display name means renaming a folder via
  // the Workspace snapshot editor doesn't break this file.
  "destinations": [
    {
      "uri": "file:///handle/abc-backup-drive",   // From .admin-sync.jsonc
      "path": "projects/alpha"                     // Optional subpath
    },
    {
      "uri": "file:///handle/def-archive-server",
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

- Every `destinations[].uri` must resolve to a workspace folder currently open. Unresolved URIs produce warnings in the Output Channel: *"destination URI 'file:///handle/abc-backup-drive' is not currently in the workspace"*. The source is still loadable; the unresolved destination will be skipped at sync time.
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
   - For each source, look up each `destinations[].uri` against the currently-open workspace folder URIs.
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
  - **Dry run** button opens the existing M3 plan webview (workspace-wide) in a separate panel — the "embedded plan in the lower half" was descoped to keep this milestone minimal. Picked back up as M4.7 with the scope correction (room-scoped, not workspace-wide) and re-labelled to **Open workspace-wide plan** so the per-room/global distinction is explicit
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

### M4.6 — Workspace snapshot + silent restore *(shipped)*

**Status (2026-05-19):** Probe + snapshot capture + silent restore + Clear/Show commands shipped in commits `6b45c4e`, `c62500f`. Admin custom editor (`folderSync.adminEditor`) + `folderSync.openAdminConfig` shipped in this commit. Empirically validated end-to-end on the VPS: a 4-folder snapshot restored in 134 ms with zero diagnostics, the restore now fires automatically on every refresh of `vscode.sophtwhere.com`. The admin editor's Rename / Refresh / Clear surface still needs in-browser dogfooding — the underlying machinery is the same `updateWorkspaceFolders` + snapshot-writer loop that's already known to work, so risk is low.

**Observed reality from the live runs:**

- Adding folders via `updateWorkspaceFolders` to a previously-folderless tab does **not** restart the extension host in vscode.dev. The pending-settings flag pattern documented below was defensive; the simpler same-activation path always runs. Flag still set + cleared for safety (and for any future desktop publish), but it's never read across activations in practice.
- vscode.dev surfaces FSA-granted folders as `file:` URIs. `vscode.Uri.parse(snapshot.folders[N].uri)` round-trips cleanly into `updateWorkspaceFolders`.
- Cold reads via captured URIs work without re-mounting first — one-step restore architecture is correct.

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

M4.7 extends this editor (along with the room editor and pptx preview) with the embedded + scoped dry-run system across all three sync scopes — see the M4.7 milestone below. M4.6 just establishes the admin editor surface and its maintenance commands.

**Probe outcomes (2026-05-19, sha 6b45c4e — `folderSync.probeColdRead` command in `src/sync/probe.ts`):**

- **(load-bearing) ✅ Cold reads work as-hoped.** With `workspaceFolders.length: 0`, `vscode.workspace.fs.readFile(parsed)` returned the correct 53 bytes in 66 ms (cold) and 13 ms (cold via `Uri.from`). One-step restore is viable — no mount-first fallback needed. The struck-out alternative below stays as historical context: ~~If it fails, restore becomes a two-step process: `updateWorkspaceFolders` to mount `workspaceFolders[0]` first... then read `.admin-sync.jsonc`, then continue with the remaining folders + settings.~~
- **✅ URI shape doesn't matter.** `vscode.Uri.parse(snapshot.folders[N].uri)` produces a URI byte-identical to `vscode.Uri.from({scheme, authority, path, query, fragment})`. Either works against the FSA grant. Going with `Uri.parse` for simplicity.
- **Scheme reality:** vscode.dev's FSA-granted folders surface as `file:` URIs (e.g. `file:///Speakers%20Prep`), not `vscode-vfs://` as originally guessed. No behavioural impact; spec wording updated.

**Open design questions to confirm during implementation:**

- **Activation in a folderless tab requires an explicit activation event.** The probe activation only fired because the user invoked a command from the palette — contributes-inferred events (`customEditors`, command invocation) don't trigger on a folderless cold start. M4.6 must add `"onStartupFinished"` to `activationEvents` in `package.json`. This is one of the rare cases where an explicit entry is needed (the substrate dead-end about "don't add activation events" is about events that are *already* implicit).
- **Adding the first folder triggers an extension-host restart.** Per VS Code API docs, `updateWorkspaceFolders` adding the first folder to a previously folderless workspace terminates and restarts the extension host (the deprecated `rootPath` changes). Practical implication: settings applied *after* `updateWorkspaceFolders` may not persist across the restart. Two options:
  - Apply settings *before* `updateWorkspaceFolders` — but settings at `ConfigurationTarget.Workspace` on a folderless workspace may be a no-op.
  - Mark a "settings-pending" flag in `globalState` before the call; on the post-restart activation, detect the flag and apply settings against the now-populated workspace.
  Going with option 2 for robustness; surface the actual behaviour in the Output Channel during testing.
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

### M4.7 — Embedded + scoped dry-run across all three sync surfaces *(✅ shipped)*

**Status snapshot (2026-05-19, M4.7 complete):**

| Phase | What | Status |
|---|---|---|
| A | Scope-restricted planner (`buildScopedDryRunPlan` + tests) | ✅ shipped |
| B | Room-editor embedded plan section | ✅ shipped |
| C | Admin-editor Full Dry-Run + Run Sync section | ✅ shipped |
| – | URI-keyed destinations (replaces fragile name-keying) | ✅ shipped (commit `b776671`) |
| – | Read-only lock seed + cross-source destination uniqueness + source-self filter | ✅ shipped (commit `c3b315c`) |
| D | Pptx viewer "Sync target" section + classifier | ✅ shipped (commit `e6eb9ca`) |
| D-adj | Pptx viewer UX additions (corrupt-flag hiding, Save As rename, Update button, drag-and-drop compare modal) | ✅ shipped (commit `e6eb9ca`) |
| follow-on | Run Sync symmetry: room-scoped button in `.sync.jsonc` editor + per-file button in pptx viewer (mirrors admin editor's gating) | ✅ shipped (commit `f6f0433`) |
| follow-on | Drop overlay copy clarification — own subtitle explaining Shift-to-drop-into-webview (VS Code's overlay text was inverted vs behaviour) | ✅ shipped (commit `88954c0`) |
| follow-on | Auto-sync checkbox in compare modal, default persisted in `globalState.pptxViewer.autoSyncAfterDrop` | ✅ shipped (commit `3577103`) |

Everything in M4.7 shipped over 2026-05-18 → 2026-05-19. The three follow-ons landed after the user dogfooded Phase D on the live URL and surfaced gaps: Run Sync only existed in the admin editor (felt like a regression once the user had three custom editors visible), the VS Code drop overlay's "hold shift to drop into editor" copy was inverted relative to behaviour, and the compare modal lacked a one-gesture path through to syncing the new file.

**Next milestone is M5** (interactive decisions + validators). The plan is **clean** between M4.7 and M5: no carried-over work, no half-finished follow-ons. M5 was paused for M4.7 and is now unblocked. *(2026-05-20 update: M5 has since shipped — see below.)*

**Why this exists:** The product framing is "pushing files to rooms" for a multi-room conference site. Three natural scopes, each with a natural surface:

| Scope | Surface | What this milestone adds |
|---|---|---|
| Per-event / global (all rooms) | `.admin-sync.jsonc` editor | Full Dry-Run section, run automatically + on Refresh |
| Per-room | `.sync.jsonc` editor | Embedded plan section for *this* room only, auto-runs on open + on file changes |
| Per-file | pptx preview panel | Implied single-file plan, context-sensitive (source / uncovered / destination) |

Today, the `.sync.jsonc` editor's only dry-run affordance is a button that opens the workspace-wide plan in a separate panel — that's both the wrong scope (everything, not just this room) and the wrong place (a different panel). The admin editor has no sync controls at all. The pptx preview shows file metadata but says nothing about *where* the file would be pushed. M4.7 closes all three gaps with one shared rendering surface so the same information appears everywhere.

**Conceptual lock-in:** the per-file view is "the dry-run for this file's containing room, filtered to just this file." A user looking at a pptx preview should see exactly the info they'd see in the room editor if this were the only file in the room — same renderer, same fields, smaller scope. That's the unifying constraint that makes the engine work pay off thrice over.

**Engine work — scope-restricted planner:**

The current `buildDryRunPlan(topology)` is workspace-wide. M4.7 needs:

- `buildScopedDryRunPlan(topology, { sourceConfigUri, pathFilter? })` — pure addition over the existing planner. `sourceConfigUri` selects a single source from `topology.sources`; `pathFilter` (optional URI) further restricts the source walk to files at-or-below that path. `pathFilter` of a directory yields a folder-scoped plan; `pathFilter` of a single file yields a one-file plan.
- Destination subpath rule already documented in §"Sync engine" (lines 110-115) — folder-scoped syncs append the relative offset to the destination subpath. The new function applies the same rule.
- Returns the same `PlanForDestination[]` shape so the existing `renderPlanHtml` works without modification.

Tests under tsx mirror `test/sync-plan.test.ts`: empty scope, scope at source root (= workspace-wide for that one source), scope at a subdirectory, scope at a single file. `test/sync-scoped-plan.test.ts`.

**Per-event / global — `.admin-sync.jsonc` editor Full Dry-Run:**

- Plan section appears below the existing folders/settings panels in the admin editor. Reuses `renderPlanHtml` — workspace-wide is just *no scope filter*, so it's literally `buildDryRunPlan(topology)` (or the scoped variant with no filter; same result).
- Runs automatically on editor open (same UX promise as the room editor — no extra click to see the state).
- Re-runs on the existing **Refresh from current workspace** button (which already exists for the snapshot; extend it to also refresh the plan).
- A separate **Run Sync** button — same machinery as the existing `folderSync.openPlan` → Proceed flow, but invoked from inside the admin editor without a separate panel. Gated by the same green/orange/red footer the plan webview already renders.

**Per-room — `.sync.jsonc` editor embedded dry-run:**

- Plan section appears below the form fields in the existing `configEditor` webview. Reuses `renderPlanHtml` so it's visually identical to the standalone plan panel — but constrained to *this* `.sync.jsonc`'s source + destinations.
- Runs automatically on editor open. Status indicator: "Scanning…" → results, or "Error: …" with a Retry button.
- Re-runs on:
  1. Any `onDidChangeTextDocument` of the same `.sync.jsonc` (debounced ~500ms after the form's last edit so the user isn't churning the planner while typing).
  2. File-tree changes inside the source folder. Implement via `vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(sourceFolder, '**/*'))` — covers vscode.dev's file-tree drop-to-add path (drops fire `onDidCreate` on the watcher), explorer-add, external rewrites, and deletes. Debounce ~500ms to coalesce drop bursts.
  3. **Refresh** button — manual. Useful for cases the watcher doesn't see (FSA-granted folders where vscode.dev's watcher coverage is incomplete; verify behaviour during implementation).
- Existing "Dry run" button at the bottom of the editor (which opens the workspace-wide plan in a separate panel) stays — relabel to **Open workspace-wide plan** so the scope distinction is explicit.

**Per-file — pptx viewer UX additions (bundled with Phase D):**

Four user-facing changes to the pptx viewer panel, agreed during the 2026-05-19 session before Phase D was implemented. All four land in the same patch as Phase D because they touch the same files (`src/provider.ts`, `src/webview.ts`).

1. **Hide validation badges on corrupt input.** When `ParseResult.parseError` is set (zip couldn't be unzipped), the three OK/WARN flags don't apply — drop the *Validation* section entirely so the user isn't reading a meaningless "OK Linked media" against a file we couldn't open. Keep the *Metadata* section (filename, size, sha256 are still meaningful) and the existing red error banner. The "Sync target" section from Phase D still renders (a corrupt file still has a location and a sync context).

2. **Rename `Download` → `Save As…`.** The internal message channel is already `save-as`; the renderer just needs the button label updated to match. The trailing ellipsis is the macOS convention for "opens a dialog".

3. **New `Update…` button** next to Save As. Click → hidden `<input type="file" accept=".pptx">` triggers → user picks a pptx → bytes posted to the extension → parse + hash → outcome:
   - Invalid pptx (parseError or unzip fail): inline status text *"Not a valid pptx file"*.
   - Same SHA-256 as current: inline status *"Not updated — identical content"*.
   - Different SHA-256, parse OK: write to `document.uri`, re-render `panel.webview.html` from the new ParseResult, inline status *"Updated"*.
   - No confirmation modal on this path — the user has explicitly opted in by clicking the button.

4. **Drag-and-drop ingest.** Drop any file onto the viewer (full-window listener):
   - If the dropped file isn't `.pptx` (extension or magic-bytes check), silently ignore (let the browser's drag layer reset).
   - Parse + hash. Invalid → inline status *"Dropped file is not a valid pptx"*.
   - Same SHA-256: full-overlay info modal *"File dropped matches existing content"* with a single OK button. No write.
   - Different SHA-256: full-overlay comparison modal showing both files side-by-side (filename, size, mtime, sha256, slide count, hidden count, author, last-modified-by, embedded media, thumbnails) — the same metadata table the main panel renders, in two columns headed *Current* / *Dropped*. Buttons: **Update file** (primary) / **Cancel** (secondary). Update → write + re-render + status *"Updated"*. Cancel → dismiss modal, status cleared.

**Design calls already locked in for implementation:**

- **File picker** uses webview `<input type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation">`, not `vscode.window.showOpenDialog`. Works the same on vscode.dev, desktop, and FSA mounts. We only want bytes, not a URI.
- **Comparison modal HTML is rendered in the extension and posted to the webview as an HTML string**, then inserted into a fixed container via `innerHTML`. Same pattern as `planView.ts` — no script execution from injected HTML (no nonce). Thumbnails work because the CSP already allows `img-src data:`.
- **Candidate bytes are cached in the extension under a token**, not re-posted on confirm. `Map<string, Uint8Array>` keyed by a counter ID, cleared on panel dispose or when the next ingest arrives. Avoids sending megabytes twice across the message channel.
- **Modal style is full overlay** — fixed-position div over the whole panel, dimmed backdrop, can't interact with the content behind it. The binary decision (update / cancel) is weighty enough to warrant blocking the rest of the UI.
- **Post-update refresh re-renders `panel.webview.html`** from the new ParseResult. Resets state cleanly (modal disposed, status text cleared, new sha256 in metadata). Once Phase D lands, the new render also picks up the fresh per-file sync plan automatically — that satisfies the user's "and the dry run be run again after the update" requirement without extra wiring.
- **Invalid-pptx detection** for the drop path uses the extension-side parser (we already trust `parsePptx` to set `parseError` on failed unzip). For the magic-bytes pre-filter in the webview, check that the first 4 bytes are `PK\x03\x04` (zip header) — fast, no parser dependency client-side, good enough to silently ignore an image drag without round-tripping the bytes.

**Files touched (proposed):**

- `src/provider.ts` — new message types (`ingest`, `confirm-update`, `cancel-update`), candidate-bytes Map, post-write re-render.
- `src/webview.ts` — drop the validation section when `parseError` is set; rename button; add Update button; add hidden file input + dragover/drop handlers; add modal container + scripts. Likely grows enough to warrant splitting the inline `<script>` into a separate `viewerScript.ts` module — judge at implementation time.
- `src/webview.ts` (or sibling pure module) — new `renderCompareModalHtml(current: ParseResult, candidate: ParseResult)` returning the modal HTML string.

**Tests:**

- `test/parse.test.ts` already covers the parser. No new parser cases needed — the corrupt-file path is exercised by `testParseErrorCase` (synthetic non-zip bytes).
- A new `test/viewer-compare.test.ts` (pure, tsx-runnable) for the compare-modal renderer: assert it includes both file names, both thumbnails when present, the *Different* / *Identical* discriminator, and the Update / Cancel button IDs the script binds to. CSP nonce threading isn't relevant — the modal HTML is inserted into an already-nonced page.
- Hide-on-corrupt is a small rendering branch; cover it in an existing or new `test/viewer-render.test.ts` that asserts the validation `<ul class="flags">` is absent when `parseError` is truthy. (Currently webview.ts has no test coverage — a smoke test here is overdue regardless.)

**Done when:**

- A corrupt pptx (truncated zip, wrong magic bytes) opens with just the metadata + error banner — no OK/WARN badges shown.
- Save As button has the new label; flow unchanged.
- Update button picks a pptx, validates, writes when different, leaves alone when identical, with inline status feedback in all three outcomes (updated / unchanged / invalid).
- Dropping a pptx anywhere on the panel triggers the overlay comparison modal when content differs, the "matches existing" info modal when it's identical, or silent ignore for a non-pptx file. Confirm-update writes and re-renders; cancel dismisses.
- Re-render after a successful update shows the new sha256, new metadata, and (once Phase D ships) refreshed Sync target section.

**Per-file — pptx preview implied dry-run:**

New section in the pptx viewer's HTML, below the existing metadata + validation flags. Header: **Sync target**. The preview can be opened in three distinct contexts, and the section renders accordingly. The classification key is *which workspace folder the file lives in*: a source folder (one that owns a `.sync.jsonc` covering this file), the top-level workspace folder (`workspaceFolders[0]`, where no `.sync.jsonc` applies), or a destination folder (one whose URI matches some `.sync.jsonc`'s `destinations[].uri`).

1. **File is inside a source folder covered by a `.sync.jsonc`.** Resolve via nearest-config rule (walk up from the file's URI). Run `buildScopedDryRunPlan(topology, { sourceConfigUri, pathFilter: documentUri })`. Render via `renderPlanHtml`. One row per destination — that's the per-room view, scoped to this one file.
2. **File is inside `workspaceFolders[0]` but no `.sync.jsonc` covers it.** Render an informational hint: *"This file is not covered by a room config. Open the room's `.sync.jsonc` (or create one) to set up syncing."* Optionally a quick-action button that creates a stub `.sync.jsonc` next to the file — *deferred to follow-up*; v1 just shows the message.
3. **File is inside a destination folder** (the workspace folder URI matches some `.sync.jsonc`'s `destinations[].uri`, marked read-only). Two sub-cases:
    - **Reverse-mapped to a source.** Look up the manifest entry for this destination URI; if found, it points back at the source config + relative path. Show the same per-file dry-run as case (1), labelled to make the direction clear (e.g. *"Synced from `rooms/plenary1/.sync.jsonc`"*). The plan shows what the *next* sync would do for this destination — usually *Skip (unchanged)*; *Update (tracked)* if the source has changed; *Update (collision)* if the destination hash drifted out from under the manifest.
    - **Orphan** (no manifest entry maps to this destination path). Render: *"This file is unique to the destination folder — no source pushes it. The next sync will leave it as-is."* Distinguish from "not yet scanned" by checking that the topology has at least one destination matching this folder; an unscanned destination shows a *"Run a dry-run to determine sync state"* hint instead.

Classification flows through one helper, `classifyPreviewContext(documentUri, topology, manifest)`, returning a discriminated union so the renderer branches cleanly. Pure module under tsx (`src/sync/previewContext.ts`).

No watcher needed; the file is whatever it is when previewed. (A future polish item is re-running on `Save` in case the user is editing the source in a split — out of scope for v1.)

**Files (proposed):**

- `src/sync/scopedPlan.ts` — pure helpers (scope filter predicate, single-file walk short-circuit). No vscode imports.
- `src/sync/planner.ts` — add `buildScopedDryRunPlan` (vscode-wired side; reuses `loadConfigForSource`, `walkAndHash` etc.).
- `src/sync/previewContext.ts` — pure classifier: `(documentUri, topology, manifest) → { kind: 'source' | 'uncovered' | 'destinationMapped' | 'destinationOrphan', …context }`.
- `src/sync/adminEditorHtml.ts` — add the Full Dry-Run section + Run Sync button markup.
- `src/sync/adminEditor.ts` — wire plan build + message handlers.
- `src/sync/configEditorHtml.ts` — add the plan section markup + scanning/idle/error states.
- `src/sync/configEditor.ts` — wire watcher + debouncer; post `planUpdated` messages to the webview.
- `src/webview.ts` (pptx viewer) — add the Sync target section, branching by `previewContext.kind`.
- `src/provider.ts` — classify on open, build the scoped plan when applicable, render.
- `test/sync-scoped-plan.test.ts` — scope-filter tests under tsx.
- `test/sync-preview-context.test.ts` — classifier tests for the four cases.

**Open design questions:**

- **Drag-and-drop pickup empirically.** vscode.dev's file-tree drop-to-add uses the workbench's file operation pipeline. `FileSystemWatcher` and `onDidCreateFiles` *should* both fire — but vscode.dev's watcher coverage over FSA-granted folders has historically been spotty. First implementation step is a small probe: open `.sync.jsonc`, drop a file into the source folder, watch the Output Channel for the watcher event. If watchers prove unreliable, fall back to `onDidCreateFiles` (documented to fire for all workbench-driven file ops). The Refresh button is the always-works backstop.
- **Reverse-mapping a destination file to its source.** Case 3a of the per-file context needs the manifest to answer *"which `.sync.jsonc` pushed this file here?"* The M4 manifest format already records the destination URIs it placed, keyed under each source. The lookup is "find a manifest entry whose `destinationUri + relativePath` equals this file's URI." If the manifest doesn't yet store enough to reconstruct the source path from a destination match (e.g., it stores hashes but not source-relative paths), extend it as part of this milestone. Worth verifying against the current `manifest-types.ts` shape during implementation.
- **Debounce horizons.** Plan re-runs after form edits, and watcher coalescing — both at 500ms initially, but the user noted the right values need to be felt out during dogfooding. Leave as TBD in the implementation and surface to user feedback before locking in.
- **Scope-filter granularity at the planner.** `pathFilter` against a file walks the entire source then filters, which is wasteful for the single-file pptx case. Optimisation: when `pathFilter` is a regular file, short-circuit to `readFile(pathFilter)` + hash + single-file state-compare. Premature for v1 unless rooms get genuinely large; revisit if the per-file preview feels slow.

**Done when:**

- Opening `.admin-sync.jsonc` shows a Full Dry-Run section under the existing panels, auto-populated within ~1s of open; Refresh and Run Sync work end-to-end.
- Opening a `.sync.jsonc` shows a room-scoped categorised plan below the form, auto-populated within ~1s of open.
- Dropping a file into the source folder via the file tree updates the per-room plan within ~1s without manual refresh (or, if watcher proves unreliable, the Refresh button works and the limitation is documented in the substrate dead-ends section).
- The pptx preview correctly classifies all four contexts (source, uncovered, destination-mapped, destination-orphan) and renders the matching surface.
- For the source case, the per-file plan shows one row per destination with the same operation labels (Create / Update tracked / Update collision / Skip / Delete) and the same styling as the room view.
- A destination-orphan file shows the "unique to destination" message; a mapped destination file shows the source's per-file dry-run with the source-config attribution visible.
- `renderPlanHtml` is unchanged — same renderer, three call sites (admin editor, room editor, file preview).
- `buildScopedDryRunPlan` is covered by `test/sync-scoped-plan.test.ts` (no scope, sub-directory, single file); `classifyPreviewContext` is covered by `test/sync-preview-context.test.ts` (all four cases).

### M5 — Interactive decisions + validators *(✅ shipped)*

**Status snapshot (2026-05-20, M5 complete):**

| Phase | What | Status |
|---|---|---|
| A | Pptx validators surfaced as plan warnings (linked media, show type, media controls) | ✅ shipped (commit `6c2cb7c`) |
| B | Per-row decision UI — checkboxes for overwrite/delete/remember (UI-only, no executor wiring) | ✅ shipped (commit `359e43a`) |
| C | Wire orange path: armed decisions flow to executor; `manifest.decisions` persist across runs | ✅ shipped (commit `74c5838`) |
| D | Warnings block green footer; orange proceed skips files with unresolved warnings | ✅ shipped (commit `4a1799d`, `76b1d6b`) |
| D-adj | Warning severity tiers (`'block'` vs `'override'`) + per-file "Sync anyway" override; media-controls demoted to override-only | ✅ shipped (commit `54355d3`) |
| follow-on | Orange "safe items only" button rendered in embedded plan views (room editor, admin editor, pptx viewer) | ✅ shipped (commit `1cc5f69`) |
| M5.1 | Per-row decision affordances (Overwrite / Delete / "Sync anyway") + live orange-button label wired in every embedded preview surface; shared `decisionWiringScript()` + `handleDecisionMessage()` helpers | ✅ shipped (this change) |

M5 shipped over 2026-05-19 → 2026-05-20. Collision detection, destination-only surfacing, and the manifest-decisions persistence were already in place from earlier milestones; M5's job was the *interactive* layer on top — letting the user arm specific overwrites/deletes/overrides per file and have those decisions remembered.

**Scope adjustment during M5 (D-adj):** the original plan had a single "warnings" category that hard-blocked green. Dogfooding the live URL after Phase D revealed this was too aggressive — the media-controls-on warning is genuinely *ship-able* (the file works fine; the progress bar is just visually noisy). D-adj introduced a two-tier severity model: `'block'` warnings (kiosk, browse mode, linked external media) still block green and cannot be overridden; `'override'` warnings (media-controls + embedded video) gain a per-file "Sync anyway" checkbox that arms a `warning-override` decision, persisted in the manifest like other arming decisions. The `RowDecision.kind` union widened from `'overwrite' | 'delete'` to `'overwrite' | 'delete' | 'warning-override'` to carry this.

**M5.1 — decisions in every embedded preview surface (2026-05-20): ✅ shipped.** The four embedded plan surfaces (room editor, admin editor, pptx viewer source case, pptx viewer destination case) now pass `{ interactive: true }` to `toViewModel`, so per-row Overwrite / Delete / "Sync anyway" checkboxes render inline alongside the read-only preview. Each host installs its own `'decision'` message handler that funnels through the shared pure helper `handleDecisionMessage` in `src/sync/decisions.ts`, which validates the payload and applies it to the host's in-memory `Map<string, RowDecision>`. The Run Sync buttons mirror the standalone webview's traffic-light: green when nothing blocks, orange "Run Sync (safe items only)" when collisions/warnings exist — with a live armed-count label that updates as the user arms checkboxes.

  Implementation pieces:

  - **Shared per-row JS:** `decisionWiringScript()` exported from `src/sync/planHtml.ts` returns a delegated `change` listener that posts `{type:'decision', id, kind, relPath, accepted, remember}` for every primary toggle (and again for the Remember companion). A `window.__decisionWiring` callback hook lets each host refresh its own orange button label without re-binding listeners.
  - **`acquireVsCodeApi()` caching:** each host's client JS now caches the API on `window.__decisionVscode` so the second `<script>` block (decisionWiringScript) can reuse it instead of throwing.
  - **Wired sites:** `src/sync/planView.ts` (standalone — refactored to share helpers), `src/sync/adminEditor.ts` + `adminEditorHtml.ts`, `src/sync/configEditor.ts` + `configEditorHtml.ts`, `src/provider.ts` + `src/webview.ts` (pptx viewer). The viewer's `renderRunSyncRow` now emits green + orange buttons; `runPerFileSync` takes a `decisions` map and forwards it to `runSync(plans, decisions)`.
  - **Tests:** existing `test/sync-decisions.test.ts` covers the pure helpers; `sync-config-editor` and `sync-admin-editor` nonce-count assertions were updated from 2 to 3 to account for the added shared `<script>` block. All sync + viewer + parse tests pass.

### M5.2 — Parse timing instrumentation *(✅ shipped)*

**Status: shipped at commit `e32f033` (2026-05-20).** Diagnostic-only — no behaviour change. Exists to size M5.3 empirically before committing to a cache design: which `parsePptx` phases dominate, and by how much, against real-world decks on the live URL.

What landed:

- **`ParseTimings` interface in `src/pptx.ts`** — `{ hashMs, unzipMs, xmlDecodeMs, slideScanMs, metadataMs, mediaMs, showPropsMs, totalMs }`. Optional field on `ParseResult` (absent in the malformed-zip early-return path, present on every successful parse). `performance.now()` is the time source — available in the web-extension worker context.
- **Per-phase markers in `parsePptx`** wrapping: sha256 of input bytes, fflate unzip, XML decode of the 4 hot parts (`presentation.xml`, `app.xml`, `core.xml`, `[Content_Types].xml`), slide scan + hidden-flag pass, metadata extract (author/lastModifiedBy), media work (embedded media + thumbnail + linked-media regex), show-props (kiosk/browse/media-controls).
- **`parse-timing:` log line in `src/provider.ts`** via a `logParseTimings(fileName, prefix, timings, readMs?)` helper. Format: `parse-timing: <name> — total=Xms read=Yms hash=… unzip=… xmlDecode=… slideScan=… metadata=… media=… showProps=…`. Three call sites instrumented:
  - **Initial open** — `vscode.workspace.fs.readFile` is timed separately as `read=`, so the per-file line shows both I/O cost and CPU cost.
  - **Ingest** — drag-and-drop / Update path, prefixed `ingest[<source>]:`.
  - **Refresh** — manual editor refresh, prefixed `refresh:`.
- **Why three sites and not the validator pass:** the validator's `parsePptx` calls happen inside `planner.ts` and are about to become the dominant cost surface in M5.3. Adding timing there now would be noise — M5.3 will instrument the cache hit/miss path directly, which is a more useful diagnostic than per-call cost. The three viewer surfaces give us the uncached-cost baseline we need.

What we're looking for in the data:

- **Phase ranking.** If `unzipMs + xmlDecodeMs` dominates (likely), the cache pays back proportionally; if `hashMs` is already a big chunk, that constrains the cache key strategy (can't cheaply hash on every comparison).
- **Total-ms distribution across deck sizes.** Tens of ms for small decks vs hundreds for video-heavy decks tells us how aggressive the LRU eviction has to be.
- **Read vs parse ratio.** If `read` is non-trivial, the IndexedDB tier earns its keep on cold loads (skip both read and parse).

Empirical data feeds into M5.3 before any cache code is written.

### M5.2.5 — URI hash cache *(probe ✅ complete, implementation planned)*

**Why this exists:** M5.2 data + 2026-05-19 dogfooding surfaced two compounding costs. (a) Hash dominates parse on big files — 449ms of a 619ms total on the 137MB deck, ~73%. (b) The sync planner re-hashes every destination file on every plan build, which is wasteful when destinations are mostly stable copies of what sync placed. Caching by `(uri, size, mtime) → sha256` short-circuits both: the viewer's hash phase, and the planner destination walk's *entire* read+hash phase.

This is **orthogonal to M5.3** (`sha256 → ParseResult`). Different keys, different values, different consumers. M5.2.5 ships independently; M5.3 reuses the same IndexedDB adapter once it's proven here.

**Probe results — `folderSync.probeStat`, commit `7cda491`, 2026-05-19:**

- **28 .pptx files** across 6 workspace folders, captured then verified across a browser refresh.
- **28/28 matched.** Every `size` and `mtime` byte-identical after refresh. The FSA adapter reads from the actual file, not session state. `mtime` granularity is real: files from the original Windows source have NTFS-precision (`…000` suffix); files pushed via the browser FSA have full ms precision. No zeros, no synthetics.
- **Stat cost ≈ 6ms wall-clock per call** (28 stats in ~180ms end-to-end). Compare with M5.2 read costs: 349ms for the 137MB deck, 12–60ms for normal decks. **Stat is 5–60× cheaper than read.** The destination-walk shortcut is real.
- **Bonus observation:** the capture revealed duplicated decks across `Plenary1 PC1` and `Plenary1 PC2` (identical size, near-identical mtimes — `Journey.pptx`, `Pfleger - November 2024.pptx`, `sample-1.pptx`, `sample-3.pptx`, the 137MB `WED 215 1100 …`). These are exactly the M5.3 misfiling-guard candidates — same content shipped to multiple destinations. Cross-referenced under M5.3 below.

Verdict: full design viable. In-memory layer is a session-scoped win unconditionally; IndexedDB tier earns its keep across refresh.

**Cache wrapper — new entrypoint in `src/sync/hash.ts` (or sibling):**

```ts
export async function hashFileAtUri(
  fs: SyncFs,
  uri: Uri,
  cache?: UriHashCache,
  opts?: { needBytes?: boolean }
): Promise<{ sha256: string; size: number; mtime: number; bytes?: Uint8Array }>;
```

- `cache?` optional so the planner's pure tests keep working without injection.
- `needBytes` lets the caller opt into the read — viewer/executor pass `true`; destination walk passes `false` and gets the genuine read-skip win.
- Returns `mtime` alongside so callers that already needed `stat` (e.g. executor's pre-write "did this change between plan and execute" check) don't double-stat.

Lookup protocol: `stat → cache.lookup(uri, size, mtime) → sha256` (fast path), or `→ read → sha256Hex → cache.record → sha256` (slow path). The existing `sha256Hex(bytes)` stays as the bytes-in building block.

**Cache interface — one shape, two implementations:**

```ts
interface UriHashCache {
  lookup(uri: Uri, size: number, mtime: number): Promise<string | undefined>;
  record(uri: Uri, size: number, mtime: number, sha256: string): Promise<void>;
  forget(uri: Uri): Promise<void>;
}
```

- **In-memory `Map<string, {size, mtime, sha256}>`** keyed by `uri.toString()`. Pure module, tsx-testable, used unconditionally.
- **IndexedDB-backed**, write-through over the in-memory layer. Survives browser refresh / extension reload. Gated behind a tiny "does IDB work in the worker context" probe; no-op fallback if IDB is unavailable.

Size+mtime *both* required for lookup-match (not just mtime): mtime collisions are rare but possible (a tool that preserves mtime across atomic replace); the size delta catches those for free.

**Wire sites:**

| Site | Today | After |
|---|---|---|
| `planner.ts` source walk | `read + hash` per file | `stat + lookup` hit → 0 reads; miss → `read + hash + record` |
| `planner.ts` destination walk | `read + hash` per file | same — and this is the multiplier (network-mounted destinations especially) |
| `executor.ts` pre-write verify | reads bytes to write anyway | passes `needBytes:true`, cache short-circuits the hash only |
| `provider.ts` / `pptx.ts` viewer | hash is inside `parsePptx` | leave alone — viewer integration is M5.3 territory |

**IndexedDB adapter:** M5.2.5 includes the small "does the worker context expose IndexedDB" check + a thin async adapter wrapping the open/get/put protocol. This de-risks M5.3 — the same adapter is reused there for the `sha256 → ParseResult` store. If IDB turns out to be unavailable in the web-extension worker, the URI cache silently degrades to in-memory only and M5.3 makes the same trade.

**Probe lifecycle:** `src/sync/probeStat.ts` + the `folderSync.probeStat` command stay in the tree during implementation (same pattern as M4.6's `src/sync/probe.ts`). Removed once the cache lands and is signed off.

**Diagnostics:**

- Activation-time log: `hash-cache: idb=<available|unavailable> in-memory entries=<N>`
- Per-sync-run log: `hash-cache: <reads saved>/<files walked> on <destination name>`
- Total saved bytes line per run, so the user can see the win on a 100-file destination directly.

**Done when:**

- `hashFileAtUri` shipped, plugged into planner source + destination walks and executor verify.
- A second plan build against an unchanged destination performs zero `readFile` calls on hashed-content paths — verifiable in the watcher log + diagnostic line.
- Cache survives browser refresh via IndexedDB (verify by emptying in-memory, doing one plan build, refresh, repeat — should hit IDB).
- In-memory cache is bounded (size or count); eviction policy doesn't matter much for v1 — recently-used wins.
- Output Channel diagnostic surfaces hit/miss counts per session and per sync run.
- `src/sync/probeStat.ts` + `folderSync.probeStat` command + package.json contribution removed as part of sign-off.

### M5.3 — Content-hashed parse cache + identity store *(Phases A, B & C shipped; D infrastructure landed but unwired)*

**Status: Phases A, B & C shipped and signed off; Phase D code is in the tree but intentionally unwired pending a clearer use case.** Promoted from the post-v1 roadmap into M5 because: (a) the validator pass is now exercised across every embedded preview surface introduced in M5.1, multiplying the cost; (b) the focus-following panel (currently post-v1) needs this as a prerequisite and the user is keen to land that surface; (c) M5.2's timing data informed the design empirically before any cache code was written.

**Phase status (for session-restart clarity):**

| Phase | Scope | Status | Key commits |
|---|---|---|---|
| **A** | Pure module `src/sync/parseCache.ts`: `InMemoryParseCache` LRU, `project` / `hydrate` round-trip, `parsePptxCached` entrypoint, module singleton. Wired into pptx viewer's three parse sites (open / ingest / refresh) via `getParseCacheSingleton`. `(cached)` suffix on parse log lines for hit visibility. tsx tests in `test/sync-parse-cache.test.ts`. | **Shipped, live-confirmed.** Pfleger 184ms → 71ms on repeat open. | `bf1f3f3` |
| **B** | IDB-backed `IndexedDbParseCache` in `src/sync/parseCacheIdb.ts`, two object stores under `folderSync.parseCache`: `parseResults` (dense metadata, identity-index foundation) + `thumbnails` (heavy data URLs, splittable under future memory pressure). Write-through over the in-memory LRU. `openParseCache` factory degrades silently to in-memory if IDB unavailable. Activation log: `parse-cache: idb=<…> warm-entries=N`. Fake-IdbStore tests cover lookup/record/forget/error paths. | **Shipped, live-confirmed** that `warm-entries` climbs across PWA refresh. First-cut had a multi-store IDB-open bug that fell back to in-memory silently; fixed by adding `openIdbStores` to the IDB adapter so both object stores get created in one upgrade transaction. DB_VERSION bumped 1→2 to migrate stale-state DBs. | `81a948f`, `6b028ac` |
| **C** | `validatePptxBytes` in `src/sync/validators.ts` now takes optional `{ sha256, cache }`. Hit path: build warnings straight from the cached flags + parseError (no unzip, no scan). Miss path: parse, record the projection, return warnings. Corrupt-zip results cache too — same bytes, same parseError, no re-parse. Planner threads the singleton through `walkAndHash` → `runValidators` and snapshots `cache.stats()` around each source walk to compute per-source deltas. New log line: `sync: parse-cache: H/T on <source>`. `PlanForDestination.parseCacheStats` carries the delta for future webview wiring. | **Shipped, live-confirmed.** | `05b40d5` |
| **D** | Identity store + misfiling guard. Destination walks populate the `parseResults` store with identity records keyed by sha256, carrying `knownAt: relPath[]`. At update/dry-run time, a sha256 hit at a *different* relPath surfaces a soft `misfiled-content` warning, routed through the same per-file `warning-override` decision pattern that M5 (D-adj) introduced for the media-controls warning. | **Infrastructure landed, unwired.** Schema extends `ParseResultRecord` with an optional `knownAt?: string[]` (all parse fields made optional, `flags` is the "fully parsed" discriminator). DB_VERSION 2→3. `lookupIdentity` / `recordIdentity` on `ParseResultCache` plus both implementations (in-memory + IDB) with read-modify-write merge so parse data and identity co-exist on one record. Pure `src/sync/misfile.ts` + `test/sync-misfile.test.ts`. **Activation in `planner.ts` was added then removed** — destination walks no longer call `recordIdentity`, source walks no longer call `checkMisfile`. Reason: the Alice-gets-Bob's-talk motivation is real but a nice-to-have, not a v1 priority. Re-wiring is two small edits in `planner.ts` when we revisit. | `7fdc1c9` (landed) → `705ed32` (unwired) |

**Workflow note:** Phases A, B and C had explicit pause-and-restart between each for a clean live-test pass; Phase D's infrastructure landed in one commit but its activation was pulled before sign-off, since the immediate misfile use case turned out not to be a v1 priority. The schema/API survives in the tree as latent infrastructure — re-enabling it is a small planner.ts diff (no schema work) when a future iteration wants it.

**Phase D entry-point notes (for the next session):**

- The destination walk in `planner.ts` (`walkAndHash` called with `validate: false`) is where identity-only records would be populated. After `hashFileAtUri` returns the sha256, write a record into the parse cache that marks "these bytes exist at this destination relPath", without parsing.
- Schema lean: extend `ParseResultRecord` (in `src/sync/parseCacheIdb.ts`) with an optional `knownAt?: string[]` field. A record with only `{ knownAt }` and no flags is "identity-only"; a record with flags is "fully parsed". The single `parseResults` store doubles as the identity index — no third store needed.
- Misfiling guard surface: a new `PlanWarning` code (`misfiled-content`?) with `severity: 'override'`, matching the existing media-controls pattern so the per-file "Sync anyway" affordance + decision-persistence wiring is already there. Hook the check in `classifyFiles` (or just before) so it sees both the source sha256 and the cache's `knownAt` lookup result.
- The motivating samples (already surfaced by the M5.2.5 stat probe) live on the live workspace: duplicated `Journey.pptx`, `Pfleger - November 2024.pptx`, `sample-1.pptx`, `sample-3.pptx`, and the 137MB `WED 215 1100 …` across `Plenary1 PC1` and `Plenary1 PC2`. These are the dogfooding targets — a misfiled-content warning should fire on them as soon as the identity store is populated.

**Cache shape** — `sha256 → ParseResult` keying (not URI-keyed). `parsePptx` already computes sha256 of the input bytes at the top of the function (`src/pptx.ts:59`) before any other work, so the key is free. Content-addressed means no invalidation: same bytes → same result, forever.

**Three primary consumers:**

1. **Pptx viewer open / ingest / refresh** — the three sites M5.2 just instrumented. Each one currently re-parses on every open; with the cache, repeated opens of the same deck are O(read + hash) instead of O(read + hash + unzip + scan).
2. **Sync source validator** — `parsePptx` calls inside `planner.ts` during plan builds, fired on every room-editor + admin-editor + viewer-embedded plan render and on every file-tree change. This is the cost that compounds across a 30-deck room.
3. **Sync destination identity check** — *new use, enabled by content-addressing.* Destinations are walked + hashed but **not parsed** (planner.ts:165-167 leaves `validate: false`; planner.ts:239 hashes only). Today that hash is used solely for collision/identity classification. With the cache populated, the hash lookup can also surface "these bytes already exist at <other path>" — useful as a soft warning on Update (potential misfiling guard: user about to overwrite `Wednesday/talk.pptx` with bytes that match `archive/2024/old-talk.pptx`).

**Two-tier design** (carried forward from the prior post-v1 sketch with empirical adjustments to follow from M5.2 data):

- **In-memory LRU** keyed by sha256 → `ParseResult`. Bounded by total bytes (initial target 64 MB; revisit after M5.2 shows the size distribution). Survives the lifetime of the extension host.
- **IndexedDB tier** behind the LRU. On cache miss, look up the sha256 in IndexedDB; on hit, hydrate the LRU and return. Survives browser refresh / extension reload — the wins here are the M4.6 silent-restore case (every refresh re-mounts the same folders, the validator pass re-runs against the same bytes) and the user's normal "close tab, come back tomorrow" flow.
- **Thumbnails as a separate object store.** They're the heaviest field by far. Storing the data URL once per sha256 in its own store lets the LRU optionally drop just the thumbnail under memory pressure, while keeping cheap metadata + validation results hot. Especially relevant because destination-only entries (use case 3 above) don't need the thumbnail at all — they only need the validation + metadata to answer "is this misfiled?"
- **Identity-only entries.** Destination walks already hash without parsing, so they can populate `sha256 → { knownAt: relPath[] }` entries that are cheap to maintain and back the misfiling guard. Distinct from the full `ParseResult` entries (which require an actual parse to populate).
- **Write path:** every successful `parsePptx` writes the result back to both tiers. Failures (`parseError` set) cache the failure too — same bytes, same failure, no point re-parsing.
- **Invalidation:** content-addressed, so there is no invalidation.

**Misfiling guard (new affordance enabled by the cache):**

- At Update time (or in the dry-run plan), if the source bytes hash to a sha256 that the identity store associates with a *different* relPath (in any known location across all destinations), surface a soft warning: "These bytes are already present at <other path>. Are you sure?"
- Bounded cost: a single sha256 lookup against the identity store, which is already populated as a side-effect of normal destination walks.
- Strictly opt-in to proceed — same orange-button "override per file" pattern as the validator warnings.
- **Concrete motivation from M5.2.5 probe data:** the 28-file stat-probe already surfaced duplicated decks across `Plenary1 PC1` and `Plenary1 PC2` (`Journey.pptx`, `Pfleger - November 2024.pptx`, `sample-1.pptx`, `sample-3.pptx`, and the 137MB `WED 215 1100 …`). These are the exact pattern the misfiling guard exists to flag — same content shipped to multiple destinations, with the possibility of a future update going to the wrong one.

**Open questions for when this lands:**

- **Does the web-extension worker context expose IndexedDB?** It's a standard worker global, but the VS Code host has surprised us before (see the `extensionUri` hang dead-end). M5.2.5 includes the IDB availability probe + adapter as a prerequisite (the URI hash cache uses the same adapter), so by the time M5.3 lands the IDB question is settled and the adapter is in the tree. M5.3 reuses it for the `sha256 → ParseResult` store. The IndexedDB tier sits behind a small async adapter that's a no-op if IndexedDB isn't available, keeping the parser usable from tsx tests.
- **Persistence scope.** IndexedDB is browser-origin scoped, which on vscode.dev is per-host. For the silent-restore case that's exactly right (same origin → same cache after refresh). For multi-workspace users this means the cache is shared across workspaces — usually fine (content-addressed, no privacy leak), but worth documenting.
- **Cache hit-rate diagnostics.** Activation-time log: `cache: in-memory <hits>/<lookups>, idb <hits>/<lookups>, identity <known files>`. Tells us whether the IndexedDB tier is earning its keep (cold vs warm hit ratio per refresh) and how the identity store is filling up.
- **`ParseResult` serialisation for IndexedDB.** Most fields are JSON-clean primitives, but the thumbnail data URL is fat and the `parseError` enum needs to round-trip. Should be straightforward — `JSON.stringify`/`parse` with a schema-version stamp so we can evict old shapes on upgrade.

**Slotting:** wait for M5.2 data, then implement. Prerequisite for the focus-following panel (post-v1) — that feature multiplies the validator pass across every focus change and can't ship until the cache lands.

### M6 — Polish + remaining surfaces *(blocked on M5.3)*

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

### Pptx parse cache *(promoted to M5.3 — see above)*

Originally roadmapped here; promoted into M5 once the validator pass became hot across every embedded preview surface in M5.1. Design detail moved to **M5.3 — Content-hashed parse cache + identity store** above. This entry kept as a back-reference for anyone scanning the post-v1 list.

### Focus-following dry-run panel

A `WebviewView` contributed to the `panel` view container (alongside Problems / Output / Terminal) that auto-renders the dry-run plan most relevant to whatever the user is currently looking at. Keeps the pptx viewer's embedded per-file dry-run exactly as it is today; this is an additional surface, not a replacement.

Focus → plan mapping:

- **Active editor is a file under a sync source** → scoped dry-run for that file's containing folder (nearest `.sync.jsonc` walking up).
- **Active editor is the workspace root, empty, or outside any source** → workspace-wide plan (the same one `folderSync.openPlan` currently produces).
- **User wants to peek at a specific folder without opening a file in it** → Explorer context-menu entry `Folder Sync: Show plan for this folder` that retargets the panel. VS Code has no public "Explorer selection changed" event, so this can't be made automatic; the menu command is the conventional substitute.
- **Optional in-panel breadcrumb / scope picker** if context-menu discoverability proves weak.

Wiring sketch:

- `viewsContainers.panel` + `views.webview` contribution; `registerWebviewViewProvider` on activation.
- `window.onDidChangeActiveTextEditor` + `window.tabGroups.onDidChangeTabs` (for custom editors like the pptx viewer) → debounced ~150ms → recompute scope → re-render.
- Reuses `renderPlanHtml` / `toViewModel` unchanged; the existing decision + Proceed wiring carries over because the message protocol is identical.
- `retainContextWhenHidden: true` so the user's in-progress decision toggles survive when they switch to Terminal and back. Decisions still don't persist across VS Code reloads — that's still the manifest's `decisions` block's job.

Costs and constraints:

- **Plan rebuilds are not free.** Every focus change re-walks + re-hashes both sides and runs validators. Without M5.3's parse cache, alt-tabbing between pptx files in the same folder re-parses each one — exactly the wrong shape for an always-visible panel. This is why M5.3 is the prerequisite.
- **Cache keyed by `(scope, configFile-mtime)`** at the planner level so repeated focuses inside the same folder hit a memoised plan rather than rebuilding. Invalidated by `.sync.jsonc` edits (the existing hot-reload signal) and by destination filesystem changes (M6's destination reverse pass already needs this signal).
- **Panel area is short and wide** — the current plan layout assumes a tall column with a sticky footer. Re-flow needed: totals on one line, per-pair sections collapsed by default, footer buttons inline-right rather than sticky.

Slotting target: after M5.3 lands and after M5 is signed off, so the cache is proven and the decision UX is stable before it gets a more prominent surface.

---

## Viewer enhancements (parallel track)

Two viewer-side features bundled into one track because they target the same audience (conference technicians running real shows from the deck) and both extend the existing pptx custom-editor surface. Independent of the folder-sync milestones above — sequenced in either order against M6 / Post-v1 work. Originally drafted in a separate `viewer-enhancements-plan.md`; folded in here once M-VE-2 shipped so the record stays in one place.

### M-VE-2 — Embedded media extraction *(✅ shipped — commit a4b03f7)*

Adds an "Extract media:" row to the pptx viewer that lists embedded videos with slide-of-use annotations and writes the chosen entry via the extension-side save dialog. The full operational record lives in `CLAUDE.md` ("What's currently shipping" → "Extract embedded media"); preserved here as the design record.

**Shipped behaviour:**

- Parser side (`src/pptx.ts`): walks every `ppt/slides/_rels/slide${N}.xml.rels` and joins `Target` URIs that resolve to `ppt/media/*` paths against the slide they came from. Produces a sibling field `mediaFiles: MediaFileEntry[]` (`{ mediaPath, mime, sizeBytes, slides: number[] }`) alongside the existing aggregate `embeddedMedia`. External-target relationships (`TargetMode="External"`) are skipped. Orphan entries (parsed but unreferenced) carry `slides: []` and remain extractable.
- Webview UI: dropdown labels `${basename} — slide N` (single use) / `slides N, M` (reuse) / `unused` (orphan). The whole row is hidden when no video parts are present (audio-only files don't render the row). Extract button is disabled until a selection is made.
- Extraction handler (`src/provider.ts`): re-reads `document.uri` + `fflate.unzipSync` on each click — videos are never retained in memory between clicks. Routes through `vscode.window.showSaveDialog` + `vscode.workspace.fs.writeFile` because anchor-driven downloads from the webview iframe are blocked on vscode.dev (now captured as a CLAUDE.md "Dead end" entry).
- IDB parse cache: bumped DB version 3→4 with `mediaFiles` as an additive field; old v3 records hydrate with `[]` so the Extract UI stays hidden until a fresh parse repopulates.

**Scope locked in for v1:**

- Video mimes only (audio/image parts are filtered from the dropdown but still counted in the aggregate `embeddedMedia` row).
- Re-read zip per click — no in-memory video cache.
- Suggested filename = media-entry basename. Browser save dialog has the final say.

**Deferred to follow-up:**

- Audio extraction (m4a, mp3, wav) — expand the mime filter, or split into a second dropdown.
- "Download all" zip of every referenced media file.
- Per-deck filename hint pattern (e.g. `${pptxBasename}-slide${N}-${basename}` in place of bare basename).
- In-memory media cache during the document's open session (only worth it if users repeatedly extract from the same deck).

### M-VE-1 — PDF → PPTX import *(Phases A–D done, Phase E pending VPS validation)*

#### What the user does

1. Drag a `.pdf` onto the viewer, or click Update… and pick a PDF.
2. Viewer detects PDF (extension + magic bytes `%PDF-`), opens a config panel modal inside the existing webview.
3. User picks: aspect (16:9 / 4:3), target display resolution, letterbox vs stretch, format (PNG / JPEG), JPEG quality.
4. Render runs: PDF.js renders every page to a canvas at the derived scale. Progress shown. Encoded blobs sum to a live size estimate.
5. User changes format / quality → instant re-encode preview (no re-render of the PDF).
6. User changes resolution / aspect → "Re-render" button reruns PDF.js.
7. Import → final `.pptx` bytes posted through the existing `ingest` channel as if a real `.pptx` had been dropped. The existing modal flow (no-change / different-replace) takes over from there.

#### Why this design

- **Slide size is dimensional in PowerPoint**, not pixel-based. We pick a fixed slide aspect (16:9 default) and *render each PDF page at the pixel count it will occupy on the target display*. A 1920×1080 projection display with a 16:9 slide gets 1920×1080 image pixels for landscape pages, and letterboxed images for portrait/4:3 pages. That gives 1:1 pixel display on the projector — sharper than any "scale 2×" abstraction.
- **All work happens in the webview**, not the extension host. The extension host is a worker with no DOM — `document.createElement('canvas')` would fail there. The webview iframe has full DOM access and is where the existing ingest UI already lives, so this is a natural fit.
- **Existing ingest path is the seam**. The webview produces `.pptx` bytes (regardless of input format) and posts them through the channel that already handles drops and Update… picks. No new extension-side message handler needed.

#### Derived render-scale model

Per PDF page:

```
slideAspect   = 16/9 (or 4/3)
targetPxW     = 1920 / 2560 / 3840 / window.screen.width * devicePixelRatio
pageAspectR   = pdfPage.widthPt / pdfPage.heightPt

if pageAspectR >= slideAspect:    // landscape or wider-than-slide
  imagePxW = targetPxW
  imagePxH = round(targetPxW / pageAspectR)
else:                              // portrait or narrower-than-slide
  imagePxH = round(targetPxW / slideAspect)
  imagePxW = round(imagePxH * pageAspectR)

renderScale  = imagePxW / pdfPage.widthPt        // PDF.js scale arg
oversample   = 1.0   // raise to 1.5–2.0 for downsample-from-larger (deferred knob)
```

Letterboxing in slide XML: each `<p:pic>` carries `<a:off>` + `<a:ext>` sized to its `imagePxW × imagePxH` mapped to EMU, centered within the fixed slide EMU. Slide background is the page color of the master (default white).

#### Decisions locked in

- **Defaults**: 16:9, target 1920×1080, letterbox, JPEG, quality 0.85, oversample 1.0.
- **Slide size fixed across the deck** with letterboxing for off-aspect pages. (Per-page slide-size overrides are OOXML-legal but poorly supported by viewers — don't go there.)
- **Render in the webview**, post `.pptx` bytes to the extension via the existing `ingest` channel.
- **Two-bundle layout (revised from "lazy `import()`")**: pdfjs-dist + the pipeline + the config-modal renderer live in a separate IIFE bundle (`dist/pdfImport.webview.js`), text-inlined into `dist/extension.js` via an esbuild post-build placeholder rewrite, and served as a nonced inline `<script>` in the viewer HTML. *Why not lazy `import()`:* runtime asset fetches from the webview against extension-owned URLs hit CSP friction on vscode.dev, and the readFile-against-extensionUri dead end rules out the extension host streaming the bytes. Inlining sidesteps both. The cost is eager bundle size (~431KB minified webview bundle inlined as a JSON string into extension.js); acceptable because the bundle lands only when the viewer panel is open, not on extension activation.
- **PDF.js fake-worker mode** for v1 (`GlobalWorkerOptions.workerSrc = ''` + `disableWorker: true` on each getDocument). Slower than a real worker, but no asset-URL plumbing inside vscode.dev's webview sandbox. If conversion of large PDFs blocks the UI unacceptably, revisit and ship a worker file as a `vscode-resource:` URL.
- **Letterbox bar color**: white (matches PowerPoint default slide background). Customisation deferred.

#### Module layout

New:

- **`src/pdfImport.ts`** — TS port of `pdf2pptx/pdfToPptx.js`, **split into three phases** so the webview can cache between phases:
  - `renderPdfPages(file, { pdfjsLib, renderScale[], onProgress })` → `Array<{ canvas, widthPt, heightPt }>` (one entry per page; `renderScale` can be a single number applied to all pages or an array of per-page scales — the derived model passes per-page).
  - `encodeCanvasesToBlobs(canvases, { format, quality, onProgress })` → `Array<{ bytes: Uint8Array, sizeBytes, widthPx, heightPx, widthPt, heightPt }>`.
  - `buildPptxFromImages(pages, { format, slideSizeEmu: {cx, cy}, letterbox: boolean })` → `Uint8Array` (raw, not Blob — caller wraps if needed).
  - The original tool packs render+encode+build into one function. The split lets the webview's live preview re-run only `encodeCanvasesToBlobs` when the user changes format/quality, which is the cheap operation.
- **`src/pdfImportLayout.ts`** — pure helper: `computePageLayout(page, slide, opts)` → `{ imagePxW, imagePxH, renderScale, placement }`, plus `targetPxWFor(slide, longEdgePx)` and `estimateCanvasBytes(layout)`. No DOM imports; imports `EMU_PER_POINT` + `PageEmuPlacement` from `pdfImport.ts`. Letterbox model: `pageAspect >= slideAspect → width-bound (T/B bars)`, else `height-bound (side bars)`; stretch mode bypasses letterbox entirely.
- **`src/pdfImportConfigHtml.ts`** — pure renderer for the config panel modal HTML (radios, sliders, size estimate row, action buttons). Pattern follows `planHtml.ts` / `adminEditorHtml.ts`. tsx-testable, no vscode import.
- **`src/pdfImportWebviewEntry.ts`** — the webview-side IIFE bundle entry. Imports `pdfjs-dist` + the three-phase pipeline + the layout helpers + the config renderer and exposes them as `globalThis.__pptxPdfImport`. Sets `GlobalWorkerOptions.workerSrc = ''` and shims `renderPdfPages` to inject `disableWorker: true` on every `getDocument` call (the base function stays generic — it doesn't know about pdf.js worker semantics).

Modified:

- **`src/webview.ts`** — widened drop and Update… gates to accept `.pdf` (magic bytes `%PDF-`). On PDF detection, renders the config panel HTML into the existing modal-host div via `window.__pptxPdfImport.renderPdfImportConfigHtml`, wires change handlers, runs render → encode → build through the API surface, and on Import posts the final `.pptx` bytes through `ingest` with a `${basename}.pptx` filename (always `source: 'picker'` to skip the compare-modal step — the bytes are freshly derived, there's no "previous version" to diff against). Carries a `__PPTX_PDFIMPORT_WEBVIEW_BUNDLE_PLACEHOLDER__` constant whose quoted literal is substituted by the esbuild plugin at build time. Drop-overlay copy: "Drop a .pptx or .pdf to compare or update".
- **`src/provider.ts`** — no change required. The `ingest` handler sees `.pptx` bytes coming in regardless of input format; confirmed during Phase D wiring.
- **`package.json`** — added `pdfjs-dist: ^5.7.284` as a dep. Three new test scripts: `test:pdf-import`, `test:pdf-import-layout`, `test:pdf-import-config-html`.
- **`esbuild.config.js`** — rewritten for two-bundle layout. `buildOptionsWebview` builds the IIFE bundle first (minified, no sourcemap). `buildOptionsExtension` builds the CJS extension bundle with two post-build plugins: `buildInfoPlugin` (existing) and `pdfImportBundlePlugin` (new) which regex-matches the quoted placeholder literal in the output and replaces it with `JSON.stringify(bundleSrc)` — robust to either single- or double-quoted output from esbuild, and JSON.stringify handles all string-literal escaping. Watch mode polls the webview output's mtime every 500ms and triggers an extension rebuild when the webview bundle changes, so an edit in either source tree refreshes the inlined copy.

Deletable after the port lands and is verified:

- `pdf2pptx/pdfToPptx.js`, `pdf2pptx/test-harness.html`, `pdf2pptx/readme` — the test harness can stay as a reference if useful, but the working code moves into `src/pdfImport.ts`.

#### Phases (suggested order)

- **Phase A — TS port + pure tests.** *Done.* Moved `pdf2pptx/pdfToPptx.js` to `src/pdfImport.ts` with the three-phase split. `test/pdf-import.test.ts` exercises `buildPptxFromImages` with synthetic 1×1 PNG buffers — verifies OOXML rels, slide count, picture offsets, slide-size EMU values, letterbox geometry. PDF.js itself is browser-only and isn't tested here.
- **Phase B — Letterbox math + slide-size derivation.** *Done.* `src/pdfImportLayout.ts` + `test/pdf-import-layout.test.ts` (14 tests). Confirmed during testing that A4 landscape (aspect ≈ 1.414) is *narrower* than 16:9 (1.778) and so gets side bars on 16:9, not top/bottom bars; the genuinely-panoramic case uses a 2:1 synthetic page for the T/B bar test.
- **Phase C — Config panel renderer.** *Done.* `src/pdfImportConfigHtml.ts` + `test/pdf-import-config-html.test.ts` (17 tests). Snapshot-style assertions over structural ids, checked-radio state, and the device-resolution row's appear/hide rules.
- **Phase D — Webview integration.** *Done.* Two-bundle layout in `esbuild.config.js` (replaces the planned lazy `import()`), `src/pdfImportWebviewEntry.ts` as the IIFE entry, `handlePdfFile()` flow added to `src/webview.ts`, drop/picker gates widened to accept PDF with magic-byte detection. Final placeholder-substitution gotcha resolved: replace the entire quoted literal via `JSON.stringify` so the inlined bundle's embedded quotes don't break the host string. `node --check dist/extension.js` passes; all four affected test suites (`test:pdf-import`, `test:pdf-import-layout`, `test:pdf-import-config-html`, `test:parse`) pass locally.
- **Phase E — VPS validation + sign-off.** *Pending.* On the VPS: `git pull --ff-only`; `npm install` (new `pdfjs-dist` dep — confirm with user first); `pm2 restart pptx-watch` (esbuild config changed; the watcher caches the config on startup); reload the PWA and exercise a couple of real PDFs end-to-end. Then: update `CLAUDE.md` "What's currently shipping" with a PDF→PPTX import bullet (defaults, two-bundle architecture, `pdfjs-dist` dep added), add the dead-end entries that surfaced (placeholder-substitution quote-style trap, possibly the pdfjs worker URL story), delete `pdf2pptx/` tree. Bundle-size check: `dist/extension.js` is now ~822KB (was ~366KB pre-M-VE-1) — the +456KB is the inlined webview bundle (~431KB minified, expanded ~6% by JSON-stringify escaping).

#### Open follow-ups (deferred)

- **Per-page format override** (text pages PNG, photo pages JPEG): would meaningfully shrink mixed decks. Defer until users actually ask.
- **Real PDF.js worker URL** for non-blocking render: only needed if fake-worker mode is too slow on big PDFs.
- **Memory ceiling**: a 100-page PDF at scale 4 in PNG canvases is hundreds of MB resident. Start with "keep raw canvases between re-encodes" and add a guard rail (drop canvases after encoding when memory is tight) if users hit it.
- **Letterbox bar color** knob (black for cinema feel): default white for now.
- **Audio extraction** from PDFs (some have embedded audio): out of scope for this iteration.
- **Oversample > 1.0 knob**: useful for crisp downsampling, deferred until someone notices anti-aliasing artefacts.

#### Workflow note

`npm install` on the VPS is required before Phase E sign-off (`pdfjs-dist` is a new dep in `package.json`). Confirm with the user before running it — it mutates `node_modules`. The watcher (`pptx-watch`) also needs `pm2 restart` because `esbuild.config.js` changed (the watcher loads the config once, on startup).

#### Resume notes (Phases A–D landed locally, not yet pushed)

Working tree state at the time of this note (use `git status` to verify before resuming):

```
 M  esbuild.config.js          ← two-bundle layout + JSON.stringify substitution
 M  package.json               ← pdfjs-dist dep + 3 new test scripts
 M  package-lock.json          ← lockfile for the dep
 M  src/webview.ts             ← drop/picker PDF gates + handlePdfFile + placeholder
?? src/pdfImport.ts             ← Phase A
?? src/pdfImportLayout.ts       ← Phase B
?? src/pdfImportConfigHtml.ts   ← Phase C
?? src/pdfImportWebviewEntry.ts ← Phase D (webview IIFE entry)
?? test/pdf-import.test.ts
?? test/pdf-import-layout.test.ts
?? test/pdf-import-config-html.test.ts
```

Phase E sequence:

1. Commit + push from Termux. Suggested commit message: `Viewer: PDF → PPTX import (M-VE-1 Phases A–D)`.
2. SSH to VPS, `cd ~/pptx-viewer-ext`, `git pull --ff-only`.
3. Ask the user before running `npm install`. After install completes, `pm2 restart pptx-watch`. Tail `pm2 logs pptx-watch --nostream` to confirm a clean rebuild and the `[esbuild] inlined pdfImport.webview.js (NNN KB) → extension.js` line.
4. Reload the PWA on `vscode.sophtwhere.com`. Open a `.pptx`, then drag a `.pdf` into the viewer. Step through the config modal: default render → JPEG quality change (should re-encode only) → aspect/resolution change (should re-render). Click Import → existing ingest flow should accept the bytes and replace the open file.
5. Sign-off updates: `CLAUDE.md` "What's currently shipping" gets a PDF→PPTX import bullet; add dead-end entries for anything that surprised during VPS validation; delete `pdf2pptx/` (the reference test harness — its working code is now in `src/pdfImport.ts`).
6. Final commit: `M-VE-1 sign-off: substrate + cleanup`.
