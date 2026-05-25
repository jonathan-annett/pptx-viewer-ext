# Placeholder files — v1 plan

## Progress log

- **2026-05-26 — M1 complete.** Snapshot schema extended (`placeholders: string[]`); `EMPTY_FILE_SHA256`, `effectivePlaceholderSet`, `computeEffectiveSetFromText` exported from `src/sync/snapshot.ts`; `parseSnapshot` lowercases on read + defaults to `[]`; `marshalSnapshot` always emits the field; `snapshotsEqual` uses set-membership compare. 8 new tests in `test/sync-snapshot.test.ts`.
- **2026-05-26 — M2.1 complete.** `captureCurrent()` accepts `existingPlaceholders`; new `readPlaceholdersFromDisk()` helper in `snapshotStore.ts`; topology writer (`startSnapshotWriter`) and `captureAndWriteSnapshot()` in `restoreFlow.ts` now read on-disk placeholders before recapture, preserving the array across folder renames / Refresh.
- **2026-05-26 — M2.2 complete.** `PlaceholderRow` type + Placeholders card (locked default + user rows, themed `[x]` button, "Add placeholder…" button) in `adminEditorHtml.ts`. `adminEditor.ts` builds the rows from the parsed snapshot, hashes picked samples via `hashFileAtUri(vscodeFs(), …)`, mutates the on-disk array through `store.writeSnapshot` (open-document path so the editor panel stays alive). 4 new renderer tests.
- **2026-05-26 — M3 complete.** New `src/sync/placeholderRegistry.ts` (FileSystemWatcher on `.admin-sync.jsonc`, async/sync cache accessors, `onDidChangePlaceholderSet` event, workspace-folder topology subscription). Pure helper `computeEffectiveSetFromText` colocated in `snapshot.ts` so it stays tsx-testable. Wired into `extension.ts` activation. 5 tests in `test/sync-placeholder-registry.test.ts`.
- **2026-05-26 — M4 complete.** `PlanItem.isPlaceholder?` added; `classifyFiles` accepts an optional `placeholders: Set<string>` and annotates each item by category-appropriate identity hash (`sourceHash ?? destHash ?? manifestHash`). New `BuildPlanOptions` on `buildDryRunPlan` / `buildScopedDryRunPlan` threads the set through. Call sites updated: `planView.openPlanPanel`, `adminEditor` embedded plan, `configEditor` embedded plan, `provider.renderScopedPlan` + `renderScopedPlanForDestination`, and the `folderSync.dryRunPlan` command — each fetches via `getActivePlaceholderSet()` immediately before building. 6 new tests in `test/sync-plan.test.ts` + 1 in `test/sync-scoped-plan.test.ts`.

## Context

Event planning often produces `.pptx` files long before the actual content lands. Operators create stubs so hyperlinks, agenda slots, and folder structure can be defined up-front; the presenter delivers the real deck later. Two shapes show up in practice:

1. **Zero-byte files** — Windows Explorer's "New PowerPoint Presentation" right-click context menu writes a 0-byte file. Common, easy to produce, opens with a "this file is corrupt" message in most viewers.
2. **Custom blank-template decks** — a themed `.pptx` with a single slide reading something like "no presentation files have been uploaded for this speaker." Looks intentional, conveys status. The content is irrelevant; the file is identified entirely by its sha256 hash.

These files still need to flow through the folder-sync pipeline like any other deck — they're real artifacts in the source tree, the destinations should see them, and removing one upstream is a real deletion. What's new is that the operator needs to *see* which destination files are still placeholders so they know what's outstanding when content lands.

This plan adds a workspace-level placeholder registry (an array of sha256 hashes persisted in `.admin-sync.jsonc`), surfaces it across the sync plan UI and the pptx viewer, and gives the admin editor an "add by browsing to a sample" / "[x] to remove" UI for managing custom entries. The zero-byte sha256 is baked in as a non-removable default.

## What ships in v1

User-visible behaviour after this lands:

- **Admin editor (`.admin-sync.jsonc`)**: a new "Placeholders" card. Lists the locked zero-byte default (annotated "(default — zero-byte file)"), then any custom entries the user has added. Each custom entry shows the sha256 (truncated, full on hover) and an `[x]` to remove. An "Add placeholder…" button opens a file picker; the chosen file is hashed and its sha256 appended.
- **Workspace plan view + scoped plans**: each item row whose sha256 matches the effective placeholder set (default + custom) shows a blue `[P]` chip with a "placeholder" tooltip. A new footer line reads "N of M files are placeholders (missing content)." The totals strip at the top of the panel gets a `[P] N` chip alongside the existing OK / warn / block counts.
- **Pptx viewer**: when the opened file's sha256 is in the placeholder set, the corrupt-file banner is replaced by an info-blue banner reading "This is a placeholder file — content not yet uploaded." For genuinely corrupt files **not** in the placeholder set, the existing red-warn corrupt banner stays exactly as today. A 0-byte file becomes a placeholder banner; a malformed-but-not-zero pptx that isn't registered remains a corrupt warning.
- **Persistence**: the `placeholders: string[]` field is part of the `.admin-sync.jsonc` snapshot. The topology-change writer continues to skip no-op writes (snapshot equality now accounts for the array). Crucially, snapshot recapture (folder rename, Refresh button) preserves the user's placeholder array across writes — see M2 for the gotcha.

## Out of scope (v1)

- **Auto-generating placeholders from a program/speaker listing** — explicit out-of-scope per the feature spec. A separate tool will handle this later; v1 is the substrate it'll write to.
- **Sync-time replacement** (e.g., "if a zero-byte file lands at the destination, swap it for a custom template"). The user flagged this as a possible future option but agreed it would complicate sync logic disproportionately. v1 lets the user choose the placeholder shape at the source; sync just mirrors it.
- **Search panel integration**. The presentation search panel could badge placeholder hits, but that's a small follow-up and not load-bearing for the workflow this feature targets.
- **Per-source placeholder lists**. Placeholders are a workspace-level concept — the same registry applies regardless of which source folder a file lives in.
- **Live re-render of currently-open viewer panels** when the placeholder set changes. The current viewer is read-only and panels are short-lived; users will re-open or refresh as needed.

## Schema

Extend `Snapshot` in `src/sync/snapshot.ts`:

```ts
export interface Snapshot {
  folders: SnapshotFolder[];
  settings: SnapshotSettings;
  placeholders: string[];   // NEW — sha256 hex strings, lowercase, user-managed
  capturedAt: string;
}
```

Add a module-level constant:

```ts
// Well-known sha256 of an empty byte sequence. Always treated as a placeholder.
export const EMPTY_FILE_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
```

Add a helper that consumers call:

```ts
export function effectivePlaceholderSet(snapshot: Snapshot | null): Set<string> {
  const set = new Set<string>([EMPTY_FILE_SHA256]);
  if (snapshot) for (const h of snapshot.placeholders) set.add(h.toLowerCase());
  return set;
}
```

Design note: the empty-file sha is **not** written to the on-disk array. It lives only in the consumer set produced by `effectivePlaceholderSet`. This keeps the on-disk file representing only what the user added, and makes the "cannot remove the default" UX a property of the UI rather than special-case logic in the writer.

`parseSnapshot` defaults `placeholders` to `[]` when the field is absent (back-compat with existing files). `snapshotsEqual` adds an order-insensitive array compare for the new field (compare as `Set<string>` so two snapshots that list the same hashes in different orders are equal — avoids no-op writes when the topology writer re-serialises). `marshalSnapshot` writes the array even when empty (so the file documents the schema).

## Milestones

### M1 — Snapshot schema extension (pure, tsx-testable)

**Files**
- `src/sync/snapshot.ts` — add `placeholders` to `Snapshot`, export `EMPTY_FILE_SHA256` and `effectivePlaceholderSet`. Update `parseSnapshot`, `marshalSnapshot`, `snapshotsEqual` (set-based array compare).
- `test/sync-snapshot.test.ts` — add cases:
  - parse legacy file with no `placeholders` field → defaults to `[]`
  - parse with a populated array → preserves entries, lowercases on read
  - parse normalises mixed-case hashes to lowercase
  - marshal round-trip preserves the array
  - `snapshotsEqual` returns true when arrays differ in order only
  - `snapshotsEqual` returns false when arrays differ in membership
  - `effectivePlaceholderSet` always contains `EMPTY_FILE_SHA256`, plus user entries
  - `effectivePlaceholderSet(null)` returns a set containing only the empty-file hash
- `schemas/sync.schema.json` — governs `.sync.jsonc`, not `.admin-sync.jsonc`. No schema file currently validates the admin snapshot. Leave it for now; added to the v1.1 follow-up list.

**Forward dependency note**: the wired pieces that ensure `captureCurrent()` and `writeSnapshot` preserve the placeholders array land in **M2**. M1 ships the pure foundations only.

**DoD**: `npm run test:sync-snapshot` green; no other tests touched.

### M2 — Admin editor: Placeholders card + snapshot preservation (wired)

This milestone has two intertwined pieces: the admin-editor UI for managing the placeholder array, and the snapshot-store changes that prevent the array from being silently wiped when other parts of the system (topology writer, Refresh button) recapture the snapshot from vscode state.

#### M2.1 — Snapshot preservation across recapture

**Problem**: `captureCurrent()` in `src/sync/snapshotStore.ts:157` builds a `Snapshot` from `vscode.workspace.workspaceFolders` and `KNOWN_WORKSPACE_KEYS` only — it has no concept of placeholders. The topology-change writer (`startSnapshotWriter` in `restoreFlow.ts:319`) and the admin editor's Refresh button (`refreshSnapshot` handler) both call this path. Without a fix, the next folder rename / Refresh would erase every custom placeholder hash the user added.

**Fix**:
- Modify `captureCurrent()` to take an optional `existingPlaceholders: string[]` parameter (default `[]`). The function copies that array verbatim into the returned `Snapshot`.
- In `snapshotStore.ts`, add a helper `readPlaceholdersFromDisk(folderUri): Promise<string[]>` that reads the existing `.admin-sync.jsonc` (via `parseSnapshot`) and returns its `placeholders` array, or `[]` if the file doesn't exist / fails to parse.
- The topology writer in `restoreFlow.ts:319` becomes: `const existing = await readPlaceholdersFromDisk(folderUri); const snap = captureCurrent(existing);` — i.e., recapture preserves what's on disk.
- `captureAndWriteSnapshot()` in `restoreFlow.ts:295` (used by the Refresh button) does the same.
- `KNOWN_WORKSPACE_KEYS` does **not** change — placeholders are a snapshot-only field, not a vscode workspace setting.

**Tests** (`test/sync-snapshot.test.ts` is pure; the wired `captureCurrent` change needs a separate adapter test):
- Reuse the existing snapshot-store test pattern if any. If not, add minimal coverage by exercising `captureCurrent({ existingPlaceholders: [...] })` directly with a stub `vscode` shim. (Most snapshot-store logic is hard to test without vscode; manual smoke remains the primary verification.)

#### M2.2 — Admin editor UI

**Files**
- `src/sync/adminEditorHtml.ts` (pure renderer):
  - Extend `AdminEditorViewModel` with `placeholders: PlaceholderRow[]` where the new exported type is:
    ```ts
    export interface PlaceholderRow {
      sha256: string;        // lowercase hex
      locked: boolean;       // true for the empty-file default; no [x] rendered
      label?: string;        // e.g., "(default — zero-byte file)" for the locked row
    }
    ```
    Export from `adminEditorHtml.ts` next to `AdminEditorViewModel`.
  - Render a new card between Settings and the embedded plan. Layout: header "Placeholders (N)" (N = count of *all* rows including the locked default), subheader "Files matching these hashes are treated as placeholders in plans and the viewer.", then a list:
    - Locked row first: `<sha first-12>… (default — zero-byte file)` with no `[x]`, faded styling (`.placeholder-row.locked`).
    - Custom rows: `<sha first-12>…` (full hash in the `title` attribute for hover) + `[x]` button (`.remove-btn`).
  - Below the list, an `<button id="add-placeholder">Add placeholder…</button>`.
  - CSS additions next to the existing `.folder-list` rules in `adminEditorHtml.ts`: `.placeholder-list`, `.placeholder-row.locked` (opacity 0.7), `.placeholder-row .remove-btn` (small, themed via `--vscode-button-secondaryBackground` / `--vscode-button-secondaryForeground`).
  - Client-side JS additions (inside the existing `CLIENT_JS` block): handlers for the `add-placeholder` button and the per-row `[x]` buttons that post messages to the extension. Don't optimistically remove rows from the DOM; let the document update + re-render confirm the state change.

- `src/sync/adminEditor.ts` (wired provider):
  - In the view-model builder, parse the document text via `parseSnapshot`, take its `placeholders: string[]`, and produce:
    ```ts
    [
      { sha256: EMPTY_FILE_SHA256, locked: true, label: '(default — zero-byte file)' },
      ...userPlaceholders.map(sha256 => ({ sha256, locked: false })),
    ]
    ```
  - Two new message types in the `WebviewMessage` union: `addPlaceholderFromSample` (no payload) and `removePlaceholder` (`{ sha256: string }`).
  - **`addPlaceholderFromSample` handler**:
    1. `const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Pick placeholder sample', filters: { 'PowerPoint': ['pptx', 'ppt'], 'All files': ['*'] } });`
    2. If cancelled, bail silently.
    3. Read bytes: `const bytes = await vscode.workspace.fs.readFile(picked[0]);`
    4. Hash: use `hashFileAtUri(fs, picked[0], undefined, { needBytes: true })` so the existing hash cache absorbs the result. (No cache instance passed because the file picked from outside the workspace won't be in any walk's URI-keyed cache anyway. If a cache singleton is conveniently accessible, pass it; otherwise the result is still correct.)
    5. If sha equals `EMPTY_FILE_SHA256` → `vscode.window.showInformationMessage('Zero-byte files are placeholders by default; no entry needed.')` and bail.
    6. Re-read the current `.admin-sync.jsonc` text from `document.getText()`, run `parseSnapshot`, mutate `snapshot.placeholders` (append unique, normalise lowercase), marshal via `marshalSnapshot`, write via `store.writeSnapshot(folderUri, snapshot)`. The store routes through `applyEdit + save` when a TextDocument is open at the target (which it is — that's the admin editor), preserving the panel.
    7. The `onDidChangeTextDocument` subscription re-renders the panel; the new row appears.
  - **`removePlaceholder` handler**: same flow — read document text, parse, filter out the matching sha, marshal, write. The lockedness of the default row is enforced by **not exposing it as a user array entry**, so a malicious / scripted `removePlaceholder` message with the empty-file sha is a no-op (the filter just doesn't find it).
  - **Duplicate add**: silently dedupe in step 6 (set semantics); no toast. Adding the same file twice is benign.

**Tests** (`test/sync-admin-editor.test.ts` — renderer-only; message-handler behaviour is manual smoke):
- Renderer produces the locked default row even when `placeholders` is empty.
- Renderer renders `[x]` only on non-locked rows.
- Renderer escapes hashes via the existing `escapeHtml` helper (sanity check — hashes are hex only, but the test guards against future regressions).
- View-model builder produces the locked-then-custom ordering.

**DoD**:
- `npm run test:sync-snapshot` and `npm run test:sync-admin-editor` green.
- Manual smoke on vscode.sophtwhere.com:
  1. Open `.admin-sync.jsonc` → see the Placeholders card with the locked default row.
  2. Click "Add placeholder…", pick a sample `.pptx`, confirm it appears in the list and lands in the on-disk JSON.
  3. Click `[x]` on the new row, confirm it disappears from both UI and disk.
  4. Add a folder via "Add Folder to Workspace…", confirm the topology writer fires and the placeholders array is *preserved* (not wiped) in the resulting file.
  5. Click the admin editor's Refresh button — placeholders again preserved.

### M3 — Placeholder registry (wired singleton, FileSystemWatcher)

The planner, scoped plan builders, viewer, and search panel all need to ask "is this sha a placeholder?" without each re-parsing `.admin-sync.jsonc` on every call. A single registry module owns the cached set + invalidation.

**Files**
- `src/sync/placeholderRegistry.ts` (new module, wired):
  ```ts
  // High-level API:
  export function activatePlaceholderRegistry(
    context: vscode.ExtensionContext,
  ): vscode.Disposable;

  // Async, always safe. Returns the current effective set
  // (empty-file hash + user-added entries). Reads from disk on
  // first call after invalidation; otherwise returns the cache.
  export async function getActivePlaceholderSet(): Promise<Set<string>>;

  // Sync read for render-time paths that can't await. Returns the
  // current cached set if available, or just {EMPTY_FILE_SHA256} if
  // the registry hasn't loaded yet. Callers that need correctness
  // should prefer the async variant.
  export function getActivePlaceholderSetSync(): Set<string>;

  // Test helper — reset the cache.
  export function _resetForTesting(): void;
  ```
- Activation behaviour:
  - On `activatePlaceholderRegistry()`: locate `.admin-sync.jsonc` at `workspaceFolders[0]/.admin-sync.jsonc` (re-evaluate when topology changes — see below). Read and parse via `parseSnapshot`. Cache the resulting `Set<string>` from `effectivePlaceholderSet(snap)`.
  - Set up a `vscode.workspace.createFileSystemWatcher` on the `.admin-sync.jsonc` URI. `onDidCreate` / `onDidChange` / `onDidDelete` → invalidate cache, re-read async, fire an internal `EventEmitter<Set<string>>` (`onDidChange`) so live consumers can subscribe.
  - Also subscribe to `vscode.workspace.onDidChangeWorkspaceFolders` — when `workspaceFolders[0]` changes, the watcher's target URI changes; recreate the watcher.
  - If `workspaceFolders` is empty (folderless tab), the registry holds the empty-default set (`{EMPTY_FILE_SHA256}`). The viewer can still open `.pptx` files in a folderless context; the set is just minimal.

- Wire activation into `src/extension.ts`:
  - Call `activatePlaceholderRegistry(context)` during `activate()`, after the SyncManager activation. Push the returned `Disposable` to `context.subscriptions`.

- Test file `test/sync-placeholder-registry.test.ts`:
  - The registry itself is wired (touches `vscode.workspace`), but the cache logic can be tested by extracting a pure helper `computeEffectiveSetFromText(text: string): Set<string>` that runs `parseSnapshot` + `effectivePlaceholderSet`. Tests cover:
    - Empty / missing text → set with only the empty-file hash.
    - JSONC with `placeholders: ["aaa", "BBB"]` → set with `EMPTY_FILE_SHA256`, `aaa`, `bbb` (lowercase).
    - Malformed JSONC → falls back to empty-default set + logs (verifiable via the existing parseSnapshot error path).
  - The watcher / cache invalidation flow is manual smoke only.

**DoD**: `npm run test:sync-placeholder-registry` green; manual smoke — add a custom placeholder via the admin editor, immediately open a fresh plan webview, confirm the new sha is reflected (i.e., the registry picked up the change without needing an extension reload).

### M4 — Planner classifier: per-item `isPlaceholder` annotation (pure + wired thread-through)

**Files**
- `src/sync/plan.ts` (pure):
  - Extend `PlanItem` with `isPlaceholder?: boolean`.
  - Extend `classifyFiles` signature with an optional `placeholders: Set<string>` parameter (default `new Set()`).
  - Per-category hash precedence — use the *current identity* hash for each category:
    - `create` → `sourceHash`
    - `update-tracked` / `update-collision` → `sourceHash` (source is what's being written)
    - `skip` → `sourceHash` (equals `destHash` by definition of skip)
    - `destination-only` → `destHash` (no source available)
    - `delete-tracked` → `manifestHash` (no current source/dest read)
  - Implement as: `const identityHash = item.sourceHash ?? item.destHash ?? item.manifestHash; item.isPlaceholder = identityHash ? placeholders.has(identityHash) : false;`. The `??` chain naturally produces the right precedence for every category.

- `src/sync/planner.ts` (wired):
  - Accept `placeholders: Set<string>` in `buildDryRunPlan` options. Thread through `planForSource` to `classifyFiles`.
  - At the call site in `planView.ts` etc., obtain the set via `await getActivePlaceholderSet()` from the M3 registry.

- `src/sync/scopedPlan.ts` (wired): same options thread-through for `buildScopedDryRunPlan`.

- `src/sync/planView.ts` (wired):
  - Before building plans, `const placeholders = await getActivePlaceholderSet();`. Pass into `buildDryRunPlan`.
  - Same in `openScopedPlanPanel` callers.

- `src/sync/previewContext.ts` (wired): when building the scoped plan for the viewer's sync-target section, pass the placeholder set.

- `src/sync/adminEditor.ts` (wired): the embedded plan inside the admin editor — pass the placeholder set when rebuilding plans (via `await getActivePlaceholderSet()`).

- Tests:
  - `test/sync-plan.test.ts`: add cases — item with matching `sourceHash` flagged; `destination-only` item with matching `destHash` flagged; `delete-tracked` item with matching `manifestHash` flagged; item with no hash not flagged; empty placeholder set leaves all items unflagged.
  - `test/sync-scoped-plan.test.ts`: confirm scope filtering preserves the flag (the set is workspace-level, not scoped).

**DoD**: `npm run test:sync-plan` and `npm run test:sync-scoped-plan` green.

### M5 — Plan view rendering: `[P]` badge + count metric (pure renderer + tests)

**Files**
- `src/sync/planHtml.ts` (pure):
  - Extend `PlanRowView` with `isPlaceholder?: boolean`.
  - Extend `PlanTotals` with `placeholders: number`.
  - In `toRow`, copy `isPlaceholder` from `PlanItem`.
  - In `toViewModel`, count placeholders across all items into `PlanTotals.placeholders`.
  - In `renderRow`, after the filename / warning badge, emit `<span class="chip chip-placeholder" title="placeholder">P</span>` when flagged.
  - In the totals chip strip (search for the existing `.chip-ok` / `.chip-warn` chip row), conditionally render `<span class="chip chip-placeholder" title="N placeholder file(s)">P ${count}</span>` when `count > 0`.
  - In `renderFooter`, when `placeholders > 0`, add a line above the button stack: `${count} of ${total} files are placeholders (missing content).` Singular form when `count === 1`: `${count} of ${total} files is a placeholder (missing content).`
  - CSS — add adjacent to the existing `.chip-ok` / `.chip-warn` / `.chip-block` / `.chip-mute` block (grep for `.chip-ok` in `planHtml.ts` to locate):
    ```css
    .chip-placeholder {
      background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 18%, transparent);
      color: var(--vscode-charts-blue, #3794ff);
      border: 1px solid color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 40%, transparent);
    }
    ```
    Inherit `padding`, `border-radius`, `font-size`, `font-family` from the shared `.chip` base rule (already defined alongside the other chip variants).

- `test/sync-planview.test.ts`:
  - With a placeholder item in the plan, the rendered HTML contains `chip-placeholder` on the right row.
  - Totals strip shows the count chip when > 0, omits it when 0.
  - Footer shows the metric line when > 0, omits when 0.
  - Singular / plural footer text rendered correctly (1 file vs N files).

**DoD**: `npm run test:sync-planview` green; manual smoke — open the workspace plan, see a `[P]` chip on the right rows and the count in the footer; right-click a source folder → Sync this folder, confirm scoped plan shows the same.

### M6 — Pptx viewer: placeholder banner replacement (wired)

**Files**
- `src/provider.ts` (the `CustomReadonlyEditorProvider`):
  - After parsing the file but before calling `renderHtml`, look up the file's sha256 against the registry: `const placeholders = await getActivePlaceholderSet(); const isPlaceholder = placeholders.has(parseResult.sha256);`.
  - Extend the `renderHtml` call signature to accept `isPlaceholder`.

- `src/webview.ts`:
  - Extend `renderHtml` to accept `isPlaceholder: boolean`.
  - Banner precedence:
    - `isPlaceholder === true` → render `<div class="banner info">This is a placeholder file — content not yet uploaded.</div>`. **Suppress** the validation section (same as the existing `parseError` suppression — the three validation flags are meaningless for placeholder content). Suppress the corrupt-file banner even if `parseError` is set.
    - `isPlaceholder === false` and `parseError` set → existing red corrupt banner (no regression).
    - `isPlaceholder === false` and no `parseError` → normal viewer (no regression).
  - The `.banner.info` CSS class already exists in `webview.ts` (verified around line 1565). Reuse it — no new CSS.
  - The rest of the page (filename, size, hash, download button, Save As) renders normally so the operator can still identify and act on the file. Just the banner + validation flags change.

- `test/viewer-render.test.ts`:
  - `isPlaceholder=true` + `parseError=null` → info banner present, no corrupt warning, no validation flags.
  - `isPlaceholder=true` + `parseError='ZIP corrupt'` → info banner present, corrupt warning suppressed (placeholder takes precedence).
  - `isPlaceholder=false` + `parseError='ZIP corrupt'` → red corrupt banner present (no regression).
  - `isPlaceholder=false` + no error → normal view (no regression).

**Notes**
- The registry lookup is async, but `provider.ts` already does async work (parse, hash) before calling `renderHtml`. Adding one more `await` is cost-free.
- Currently-open viewer panels don't live-refresh when the placeholder set changes (out of scope per "What ships in v1"). Re-opening a file picks up the new state via the fresh `getActivePlaceholderSet()` call.

**DoD**: `npm run test:viewer-render` green; manual smoke:
- Open a 0-byte `.pptx` → placeholder banner (not corrupt warning).
- Open a real broken `.pptx` (not registered) → corrupt warning unchanged.
- Add a custom hash via admin editor, then open a matching file → placeholder banner.
- Remove the custom hash, re-open the file → corrupt banner if parseable; normal viewer if parseable.

### M7 — Sign-off + substrate update

- Run every local test suite touched by this work: `npm run test:sync-snapshot`, `test:sync-admin-editor`, `test:sync-placeholder-registry`, `test:sync-plan`, `test:sync-scoped-plan`, `test:sync-planview`, `test:viewer-render`, plus `test:parse` and `test:sync-executor` for regression coverage.
- Manual end-to-end walkthrough on vscode.sophtwhere.com:
  1. Create a zero-byte `.pptx` in a source folder → viewer shows placeholder banner; plan view shows `[P]`.
  2. Open admin editor → add a custom placeholder by browsing to a stub deck.
  3. Open that stub deck in the viewer → placeholder banner.
  4. Rename a workspace folder → admin file rewrites, placeholders array preserved.
  5. Dry-run a sync → plan view shows `[P]` chips and the footer count.
  6. Proceed the sync → destination receives the placeholder files; manifest writes succeed; the destination's plan re-rendered after sync still shows `[P]` chips on the now-mirrored files.
  7. Remove the custom hash via `[x]` → re-open the stub → viewer no longer shows placeholder banner.
- Update CLAUDE.md "What's currently shipping" with a paragraph for the placeholder feature (matching the cadence and style of the existing M1-M6 bullets for folder sync).
- Sign-off this plan with a "Shipped 2026-MM-DD at <commit-sha>" line at the top.

### M8 — Context report (handoff artifact)

Write `placeholder-files-v1-report.md` at the repo root, modelled on `pptx-search-v1-report.md` (≈30-50 lines). Sections:

- **What it is** — one paragraph describing user-visible behaviour.
- **Where it lives** — bullet list of pure modules and wired modules + tests.
- **Integration points** — how it threads into snapshot, planner, viewer, hash cache. Cite the registry as the single source of truth for "is this file a placeholder?".
- **Scope rules (load-bearing)** — the empty-file sha is locked-default, custom hashes are additive, workspace-level (not per-source).
- **Out of scope (don't relitigate)** — auto-generation, sync-time replacement, search-panel badging, per-source lists, live viewer refresh.
- **Status** — shipped commit sha, DoD met, marketplace status.

Then update the CLAUDE.md "Pointers to other context" or "Project plans" section to reference the report.

**Why this exists as a milestone**: subsequent feature work that touches the snapshot schema, plan rendering, or viewer banner conventions should be able to pick up this feature's contribution by reading the report alone — full plan ingestion shouldn't be required.

**DoD**: report file present at repo root; reads cleanly without the full plan; CLAUDE.md updated to link it.

## Pointers to existing code

- Snapshot schema + parser: `src/sync/snapshot.ts` (`Snapshot` interface, `parseSnapshot`, `marshalSnapshot`, `snapshotsEqual`, `KNOWN_WORKSPACE_KEYS`).
- Snapshot writer with "editor open at target URI" handling: `src/sync/snapshotStore.ts:103` (`writeSnapshot`), `:157` (`captureCurrent`).
- Restore flow / topology writer: `src/sync/restoreFlow.ts:295` (`captureAndWriteSnapshot`), `:319` (`startSnapshotWriter`).
- Admin editor: `src/sync/adminEditor.ts:53` (provider), `:176-237` (message handler), `src/sync/adminEditorHtml.ts:58` (`renderAdminEditorHtml`), `AdminEditorViewModel`.
- Placeholder registry: **new** `src/sync/placeholderRegistry.ts` (lands in M3).
- Hash helper: `src/sync/hash.ts` (`hashFileAtUri`, signature already supports cache pass-through).
- Classifier and planner: `src/sync/plan.ts` (`PlanItem`, `classifyFiles`), `src/sync/planner.ts:271` (`classifyFiles` call site).
- Plan renderer: `src/sync/planHtml.ts` (`renderPlanHtml`, `toViewModel`, `PlanRowView`, `PlanTotals`, `renderRow`, `renderFooter`, `.chip-ok` / `.chip-warn` CSS block).
- Scoped plan: `src/sync/scopedPlan.ts`; preview context: `src/sync/previewContext.ts`.
- Viewer: `src/provider.ts`, `src/webview.ts` (banner rendering around line 76 for `parseError`, `.banner.info` CSS around line 1565).
- Parse result with sha256: `src/pptx.ts` (`ParseResult.sha256`).

## Open follow-ups (deferred to v1.1+)

- Search panel: badge placeholder hits in result rows.
- Live re-render of open viewer panels when the placeholder set changes (subscribe to the registry's `onDidChange` from `provider.ts` for each active panel).
- Sync-time replacement (zero-byte → custom template).
- Auto-generation from a program / speaker listing.
- JSON Schema for `.admin-sync.jsonc` (matching the existing `schemas/sync.schema.json` pattern) — would give IntelliSense + red squiggles for the new `placeholders` field if the user ever opens the file as text.
