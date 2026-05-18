# Folder Sync — v1 Plan

## Purpose

Add a one-way folder sync feature to the existing `pptx-viewer-ext` VS Code web extension. Users author small YAML files in their source folders describing where each should sync to; destinations are workspace folders added to vscode.dev via "Add Folder to Workspace". The user **convenes** a sync deliberately (no timers, no background watchers); each run produces a plan that the user reviews and gates before any writes happen.

The pptx-viewer feature continues to exist alongside the sync engine. The validation checks the viewer surfaces (linked media, kiosk/window show mode, show-media-controls) flow into the sync plan as flagged items, surfacing for user decision at gate time.

This plan covers the sync feature only. The development substrate (web extension runtime, FSA file access via `vscode.workspace.fs`, the VPS test harness, build and dev workflow) is documented separately and assumed.

---

## User-facing model

1. User opens vscode.dev with one workspace folder containing one or more **source** folders. Each source has its own `.sync.yaml` describing its destinations.
2. User adds **destination** workspace folders via "Add Folder to Workspace". These are referenced by name from the source yamls.
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
| **Source** | Any folder containing a `.sync.yaml` file. Can sit at any depth within a workspace folder. |
| **Destination** | A workspace folder whose name is referenced from some source's yaml. Detected automatically — no explicit marking needed. |
| **Scope** | The subset of the workspace targeted by a given sync invocation. Either workspace-wide or a specific folder under a source. |
| **Plan** | A structured list of every operation that would occur given the scope and current state. Produced before any writes. |
| **Manifest** | A persistent record of what sync has placed in a destination, plus user "don't ask again" decisions. Lives in destination root. |

---

## Configuration

### `.sync.yaml` schema

```yaml
# Required: at least one destination
destinations:
  - name: backup-drive          # Must match a workspace folder name
    path: projects/alpha        # Optional subpath within the destination
  - name: archive-server
    path: snapshots/alpha

# Optional: glob patterns to exclude (in addition to built-in ignores)
exclude:
  - "~$*"
  - "*.tmp"
  - "node_modules/**"

# Optional: glob patterns to include (default: everything not excluded)
include:
  - "**/*"
```

The yaml lives at the root of any folder treated as a source. The file itself is implicitly excluded from sync.

### Built-in ignores (always applied)

- `.sync.yaml` (the config itself)
- `.foldersync-manifest.json` (sync state, never copied)
- `.DS_Store`, `Thumbs.db` (OS metadata)
- `~$*` (Office lock files)
- Any path beginning with `.git/`

### Hot reload

YAML changes are picked up automatically via `vscode.workspace.createFileSystemWatcher('**/.sync.yaml')`. Editing a yaml triggers topology re-resolution before the next sync invocation; no restart needed.

### Topology validation at load

Each time the yaml set is reloaded:

- Every `destinations[].name` must resolve to a workspace folder currently open. Unresolved names produce warnings in the Output Channel: *"destination 'backup-drive' is not currently in the workspace"*. The source is still loadable; the unresolved destination will be skipped at sync time.
- Multiple sources targeting the same destination must use non-colliding subpaths. Collisions are configuration errors that block sync until resolved.
- A malformed yaml emits an error in the Output Channel; the affected source is excluded from sync until fixed.

---

## Sync engine

Every sync run follows three phases: **plan → gate → execute**. The user only ever sees one decision surface (the plan webview); execution after green/orange is silent and uninterrupted.

### Phase 1 — Plan

Given a scope (workspace-wide or folder-scoped):

1. **Source discovery**
   - Workspace-wide: walk all workspace folders, find every `.sync.yaml`. Each is a source root.
   - Folder-scoped: walk up from the selected folder. The nearest `.sync.yaml` is the source. The scope is restricted to files at or below the selected folder.

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
| Explorer context menu — folder | "Folder Sync: Sync This Folder" — folder-scoped. Greyed (with tooltip) if no `.sync.yaml` at or above the selection, or the selection is inside a destination workspace folder |
| Status bar button | "Folder Sync" with sync icon — workspace-wide. Tooltip shows source/destination count |
| Command palette | "Folder Sync: Sync Everything" (workspace-wide) and "Folder Sync: Sync This Folder" (acts on the active editor's folder, or first selected explorer item) |
| Optional keybinding | User-configurable via standard VS Code keybinding; no default binding ships |

For workspace-wide invocations covering multiple sources, the plan is **aggregated** into a single plan/gate/execute cycle with items grouped by source. The user cannot deselect individual sources within an aggregated plan in v1 — to sync "everything except source X", cancel and invoke per-source from the explorer.

---

## Edge cases and defaults

### Workspace structure

- **No `.sync.yaml` anywhere in the workspace** — status bar button shows "No sync configuration"; context menu items are greyed.
- **`.sync.yaml` references a destination not in the workspace** — warning at config load, that destination skipped at sync time; the plan summary reports "skipped: destination 'X' not available".
- **Nested sources** (e.g. `projects/.sync.yaml` AND `projects/alpha/.sync.yaml`) — closest wins (the "at or above" rule). The outer yaml never sees `alpha` because alpha's own yaml takes over for that subtree.

### Sync execution

- **A file changes during sync** — the read in execute happens after the plan was computed. If the source file changed between plan and execute, the size/hash check downstream fails — treated as a per-file error, recorded, sync continues. v1 doesn't lock or re-plan; the user reruns.
- **Disk full / write failure on destination** — recorded as a per-file error, sync continues with remaining files, summary surfaces the failure prominently.
- **Permission denied (e.g. UNC network glitch)** — same: recorded, sync continues.

### Manifest

- **Manifest absent but destination has files** — all destination files become destination-only in the plan. User most likely just proceeds, which creates manifest entries for files that also exist in source. Pure destination-only files remain destination-only.
- **Manifest version newer than extension** — refuse to sync, surface error.

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

The v1 scope is sequenced into six milestones. Each milestone is a single coherent diff, testable end-to-end on the VPS test harness, and leaves the existing pptx viewer untouched. Earlier milestones de-risk later ones — the config layer and plan engine are exercised long before any code writes a file.

### M1 — Config layer + diagnostics ✅ shipped (commit 4a60c73)

- Load `.sync.yaml` files via `vscode.workspace.findFiles`, parsed with a hand-rolled subset parser (`src/sync/yaml-mini.ts`) — the `yaml` npm package was tried first and dropped because it added 207 KB to the bundle
- `FileSystemWatcher` on `**/.sync.yaml` for hot reload
- Topology validation at load: destination name resolution, subpath collision detection, malformed yaml reporting
- Output Channel diagnostics for each load cycle
- Command **Folder Sync: Show Topology** — dumps resolved sources/destinations to the Output Channel
- Status bar item showing source/destination counts, or "No sync configuration"

**Done when:** authoring a yaml causes topology to resolve live, unresolved destinations produce a warning, the topology command prints the current resolved view.

### M2 — Plan engine (workspace-wide, no UI) ✅ shipped (commit 9e05937)

- Glob matching for `include`/`exclude` plus the built-in ignore list
- Source-tree walk via `vscode.workspace.fs`
- SHA-256 hashing via `crypto.subtle`
- Manifest reader (missing/corrupt treated as "no entries"). Split into `manifest-types.ts` (pure data) and `manifest.ts` (vscode I/O) so the pure plan tests can run under tsx without a vscode shim.
- State comparison producing the six operation categories (create, update-tracked, update-collision, skip-unchanged, delete-tracked, destination-only) — pure function in `src/sync/plan.ts`, no vscode dependency
- Command **Folder Sync: Dry-Run Plan** — dumps the categorized plan to the Output Channel

**Done when:** every operation category is exercisable by setting up the right source/destination state and verifying the output text. No filesystem writes anywhere yet.

### M3 — Plan webview UI (read-only)

- New regular webview panel (not a custom editor) with explicit CSP + per-render nonce, following the pptx-viewer pattern
- Header with scope description + aggregate counts
- Collapsible sections with per-row info (path, size, brief reason)
- Traffic-light footer: **Cancel** wired up; **Proceed** buttons rendered but disabled
- Invocation via command palette only for now

**Done when:** the plan webview renders the M2 plan structure and can be dismissed. No execution path yet.

### M4 — Executor + manifest writes (green path)

- Atomic writes via `writeFile` to `<path>.tmp` then `vscode.workspace.fs.rename`
- Manifest read → mutate → atomic write (same tmp+rename pattern)
- Create / tracked-update / tracked-delete execution
- Per-file error isolation; Output Channel summary; completion notification with success/failure counts
- Green **Proceed** button wired up for plans with no blocking items

**Done when:** a clean sync (no collisions, no validation warnings) runs end-to-end and the manifest reflects what was placed.

### M5 — Interactive decisions + validators

- Collision detection against the manifest
- Destination reverse pass to surface destination-only files
- Per-row toggles in the UI: "overwrite this", "delete this", "don't ask again"
- `manifest.decisions` persistence and re-application on next run
- Orange + red footer state with live transitions as toggles change
- Wire existing pptx validators (linked media, show type, showMediaCtrls + embedded video) into the plan as a Warnings category
- Orange button proceeds with non-blocked items only; red button cancels

**Done when:** collision and destination-only scenarios behave per spec; "don't ask again" persists across runs; pptx warnings appear and block green.

### M6 — Polish + remaining surfaces

- Explorer context menu entries with grey-out rules (no `.sync.yaml` at/above selection; selection inside a destination)
- Folder-scoped invocation: nearest-yaml rule + relative-offset destination subpath
- Status bar button as alternate workspace-wide invocation
- Orphan `.tmp` cleanup at the start of each run's destination reverse pass
- Manifest version-mismatch refusal with a clear error
- Walk the Definition of Done checklist; close any remaining gaps

**Done when:** every Definition-of-Done bullet below is satisfied.

---

## Definition of done (v1)

- User can author a `.sync.yaml` in a source folder, add destinations to the workspace, and convene a sync from Explorer context menu, status bar, or command palette
- Workspace-wide and folder-scoped invocations both produce a categorized plan
- Plan webview shows all operation categories with counts, per-file detail, and the traffic-light decision pattern
- Green proceeds silently for clean syncs; orange proceeds with non-blocked operations only; red cancels everything
- Per-file "remember this decision" persistence works across sync runs
- Manifest is created, updated, and read correctly; survives the destination folder being moved or re-mounted
- Per-file failures don't abort the run; summary surfaces them clearly
- Pptx validation flags appear in the plan as a dedicated category and behave as blocks
- All vscode.dev FSA constraints respected: no Node APIs, web-extension only, atomic writes via tmp + rename
