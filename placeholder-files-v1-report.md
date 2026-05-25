# Placeholder files v1 — Context Report

Condensed handoff for an agent picking up subsequent work (e.g. the next
folder-sync milestone, search-panel polish, or a future placeholder follow-up)
without needing to read the full `placeholder-files-v1-plan.md`.

## What it is
Workspace-level "this file is a stub, not real content yet" registry, surfaced in three places:
- **Admin editor (`.admin-sync.jsonc`)** — new Placeholders card. Locked default row (the zero-byte sha) plus user-added rows; "Add placeholder…" file picker hashes the chosen sample, `[x]` removes a custom entry.
- **Plan view** — per-row blue `[P]` chip, `placeholders: N` chip in the totals strip, and a footer line `"N of M files {is a placeholder | are placeholders} (missing content)."` in the standalone plan webview only.
- **Pptx viewer** — blue info banner "This is a placeholder file — content not yet uploaded." replaces the corrupt-file banner; validation flags suppressed (meaningless for stub content).

Operators use the workflow to mark which destination files are still placeholders so they know what's outstanding when real content lands. The zero-byte sha (`e3b0c442…`) is the implicit default — Explorer's "New PowerPoint Presentation" right-click always produces one — and is never written to the on-disk array.

## Where it lives
- **Pure modules** (tsx-testable):
  - `src/sync/snapshot.ts` — `Snapshot.placeholders: string[]`, `EMPTY_FILE_SHA256`, `effectivePlaceholderSet(snap)`, `computeEffectiveSetFromText(text)`, snapshot equality treats placeholders as a set.
  - `src/sync/plan.ts` — `PlanItem.isPlaceholder?`; `classifyFiles(..., placeholders?: Set<string>)` annotates by category-appropriate identity hash (`sourceHash ?? destHash ?? manifestHash`).
  - `src/sync/planHtml.ts` — `PlanRowView.isPlaceholder?`, `PlanTotals.placeholders`, chip rendering + footer line + `.row-lead`/`.row-meta` layout split.
  - `src/sync/adminEditorHtml.ts` — `PlaceholderRow` type, Placeholders card markup + client JS.
- **Wired modules**:
  - `src/sync/placeholderRegistry.ts` — singleton cache + FileSystemWatcher on `.admin-sync.jsonc`; `getActivePlaceholderSet()` (async) and `getActivePlaceholderSetSync()` (cold-tolerant).
  - `src/sync/snapshotStore.ts` — `captureCurrent(existingPlaceholders)`, `readPlaceholdersFromDisk(folderUri)`.
  - `src/sync/restoreFlow.ts` — topology writer + `captureAndWriteSnapshot` read placeholders from disk before recapturing.
  - `src/sync/adminEditor.ts` — view-model builder + `addPlaceholderFromSample` / `removePlaceholder` handlers (hash via `hashFileAtUri(vscodeFs(), …)`, write via `store.writeSnapshot` so the open editor panel survives).
  - `src/sync/planner.ts` — `BuildPlanOptions.placeholders` on `buildDryRunPlan` + `ScopedPlanOptions.placeholders` on `buildScopedDryRunPlan`.
  - `src/webview.ts` — `RenderOptions.isPlaceholder` + banner precedence.
  - `src/provider.ts` — viewer resolves the flag via the registry; **skips the per-file sync-target build for placeholders entirely** (the workspace plan view's `[P]` chip is where to see sync state for a stub).
  - `src/pptx.ts` — `parsePptx` zero-byte short-circuit (no hash compute, no `unzipSync`, synthesised result).
  - `src/sync/parseCache.ts` — `parsePptxCached` zero-byte short-circuit (no IDB lookup).
- **Tests**: `test/sync-snapshot.test.ts`, `test/sync-placeholder-registry.test.ts`, `test/sync-admin-editor.test.ts`, `test/sync-plan.test.ts`, `test/sync-scoped-plan.test.ts`, `test/sync-planview.test.ts`, `test/viewer-render.test.ts`, `test/parse.test.ts`, `test/sync-parse-cache.test.ts`. Run as `npm run test:<name>`.

## Integration points
- **Registry is the single source of truth for "is this sha a placeholder?"** — every consumer (planner thread-through, viewer banner) goes through `getActivePlaceholderSet()`. The pure helper `computeEffectiveSetFromText` lives in `snapshot.ts` (not the registry) so it stays tsx-testable.
- **Snapshot preservation**: every recapture path (`captureAndWriteSnapshot` for Refresh; topology writer for folder add/rename) reads `placeholders` off disk first and passes it back into `captureCurrent`. Vscode state doesn't model placeholders, so without this they'd be silently wiped on every topology event.
- **Open-document write path**: admin editor mutations go through `store.writeSnapshot`, which uses `applyEdit + save` when a TextDocument is open at the target URI. Atomic tmp+rename would close the open custom editor panel (the existing M4.6 gotcha).
- **Hash precedence in `classifyFiles`**: `sourceHash ?? destHash ?? manifestHash`. `create`/`update-*`/`skip` get the source hash; `destination-only` gets the dest hash; `delete-tracked` gets the manifest hash. Empty placeholder set → annotation loop skipped entirely.
- **Row layout (M5.5 refactor)**: `renderRow` markup is `<row-lead: path + chips/badges/decision>` + `<row-meta: size + hashes>`. The meta group is intrinsic-width and anchors right so size/hash columns line up across rows regardless of which lead-side affordances appear. Layout-regression test guards against future drift.

## Scope rules (load-bearing)
- **`EMPTY_FILE_SHA256` is locked as the implicit default**, never stored in the on-disk `placeholders` array. The locked admin-editor row is a UI property — a stray `removePlaceholder` for the empty sha just no-ops (filter doesn't find it).
- **Custom hashes are additive** — added to the effective set on top of the empty default.
- **Workspace-level, not per-source** — one registry per workspace; same set applies to every source folder.
- **Hashes are lowercase hex** on read (parser normalises) and on write (mutation paths lowercase before dedup).
- **`EMPTY_FILE_SHA256` is intentionally duplicated** between `src/sync/snapshot.ts` (the constant of record) and `src/pptx.ts` (`EMPTY_FILE_SHA256_LITERAL`, inlined to keep the pptx module free of backward sync imports). Cross-reference comments in both files; value is mathematically immutable so the duplication carries zero maintenance risk.

## Out of scope (don't relitigate)
- **Auto-generating placeholders from a program/speaker listing** — explicit out-of-scope per spec. A separate tool will write to this substrate later.
- **Sync-time replacement** (zero-byte at destination → swap for custom template) — user flagged as a possible future option but agreed it would complicate sync logic disproportionately. v1 lets the operator choose the placeholder shape at the source; sync just mirrors it.
- **Search panel integration** — placeholder badging in search results is a small follow-up; not load-bearing for the v1 workflow.
- **Per-source placeholder lists** — placeholders are a workspace concept; per-source scoping is unnecessary complexity.
- **Live re-render of open viewer panels** when the registry set changes — out of scope per the v1 spec. The viewer is read-only and panels are short-lived; users re-open files to pick up state changes. The registry's `onDidChangePlaceholderSet` event exists for future consumers but no caller subscribes yet.
- **JSON Schema for `.admin-sync.jsonc`** — would give IntelliSense + red squiggles when opened as raw text, matching `schemas/sync.schema.json` for `.sync.jsonc`. Filed as v1.1 follow-up.

## Status
v1 shipped at `d8bf688` on 2026-05-26. All M1–M8 milestones complete; sign-off line at the top of `placeholder-files-v1-plan.md`. Live on `vscode.sophtwhere.com`. Marketplace pre-release not yet republished.

Full plan + progress log: `placeholder-files-v1-plan.md`. Substrate bullet: CLAUDE.md "What's currently shipping" → "Placeholder files v1 shipped".
