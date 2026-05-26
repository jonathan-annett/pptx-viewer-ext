# Shipped features — pptx-viewer-ext

Reference doc for every feature live on `vscode.sophtwhere.com`. Captures the as-shipped surface — UX, module layout, message flows, hard-won gotchas — so an agent can pick up adjacent work without reconstructing context from `git log`.

The substrate doc (`CLAUDE.md`) carries one-line summaries pointing here. Where a feature has its own plan + handoff report (e.g. `pptx-search-v1-plan.md` + `pptx-search-v1-report.md`), that pair is the authoritative source for the *design rationale*; this doc captures the *as-shipped surface* so subsequent work can interoperate without digging.

---

## Pptx viewer family

### Custom editor

Verified working on the live URL. Shows file name, size, mtime, SHA-256, slide count, hidden slide count, author, last-modified-by, embedded media list, and three validation flags:

- **Linked media** — warn when any slide has a `Relationship` with a media type and `TargetMode="External"`.
- **Show type** — warn when `<p:showPr>` contains `<p:kiosk/>` or `<p:browse/>`. Presenter mode (default) is the pass case.
- **Show media controls** — warn only when *both* `showMediaCtrls` resolves to on (explicit `val="1"`, or absent — PowerPoint's ECMA-376 default is on) *and* at least one embedded video part exists. Controls-on with no embedded video, or audio-only files, are intentional passes — there is no on-screen controls bar to worry about.

### Real-world samples

Five `.pptx` files in `samples/` covering each flag state (kiosk, browse/window, controls explicitly off, controls implicit-on with no video, controls implicit-on with embedded video). Checked into the repo and exercised by `testRealSamples` in `test/parse.test.ts` alongside the synthetic-zip cases.

### Thumbnail extraction

Pulls `docProps/thumbnail.{jpg,jpeg,png,gif,webp}` from the zip and renders it as a `data:` URL `<img>` under the filename. EMF thumbnails are deliberately skipped — browsers can't render them. When no in-file thumbnail is present, the M-VE-3 synthesised fallback takes over (see below).

### Synthesised fallback thumbnails (M-VE-3, 2026-05-23 — commit `37a3309`)

When the in-file thumbnail is absent (no `docProps/thumbnail.*` or only `.emf`), the viewer renders a coloured-box + first-slide-title image instead of a bare filename. The hard constraint from the user: **never modify the pptx file to add a thumbnail** — the file's sha256 is identity for the parse cache, URI hash cache, planner, and (forthcoming) misfiling guard.

- `src/pptx.ts` — `extractFirstSlideTitle(entries)` walks `ppt/slides/slide1.xml` for `<p:ph type="title">` or `"ctrTitle"`; falls back to filename, then to "Untitled". Adds `synthesisHint?: { title, sha256 }` to `ParseResult` when the in-file thumbnail is absent.
- `src/thumbnailSynth.ts` (pure) — `deterministicColourFromSha` (first 6 hex chars of sha → HSL hue) + line-fitting math; tsx-testable via `test/thumbnail-synth.test.ts`.
- `src/webview.ts` — renders the canvas when `synthesisHint` is present (1920×1080, JPEG q=0.85, auto-fit text), posts `{ type: 'thumbnail-synthesised', sha256, dataUrl }` back.
- `src/provider.ts` — message handler writes the data URL into the parse cache + in-memory `ParseResult` and sends `{ type: 'thumbnail-set', dataUrl }` to swap the placeholder image in-place. Cache record carries `synthesised: true` (diagnostic).
- `src/sync/parseCacheIdb.ts` — additive `synthesised?: boolean` field on the thumbnail record. No DB version bump (additive).

Cache survives PWA refresh and is content-addressed — editing the file changes its sha256 and triggers a fresh synth automatically.

### Build-info logged at activation

`[pptx-viewer] build: <ISO timestamp> sha=<short git SHA>` printed to the Pptx Info output channel and DevTools console. Implemented by an esbuild `onEnd` plugin that text-replaces a placeholder string in the emitted bundle on every (re)build; the runtime side reads the inlined JSON. Lets the user instantly tell whether a stale browser cache is serving an old bundle.

### Per-file parse log

`[pptx-viewer] parsed: <name> — <bytes> bytes, <N> slides (<M> hidden), <W> warning(s), thumbnail: <mime+size | none>` printed per file open. Diagnostic only — no behavioural effect.

### Save As / Update… / drag-and-drop ingest

Three paths to land bytes on disk from inside the viewer:

- **Save As** — primary-styled button under the filename. Click → webview posts `{type:'save-as'}` → extension reads bytes via `vscode.workspace.fs.readFile(document.uri)` → `vscode.window.showSaveDialog()` → `writeFile`. (Anchor-driven downloads from the webview iframe are blocked on vscode.dev — see Dead Ends in `CLAUDE.md`.)
- **Update…** — picks a `.pptx` via webview `<input type="file">`; bytes are parse+hash-validated; same sha → "Not updated — identical content"; different sha → write to `document.uri` + re-render; invalid → "Not a valid pptx file".
- **Drag-and-drop ingest** — full-window drop listener. Drops a `.pptx` → parse+hash. Identical sha → info modal "matches existing content". Different sha → side-by-side compare modal (Current vs Dropped: filename, size, mtime, sha256, slide count, author, embedded media, thumbnails). Update button writes + re-renders; Cancel dismisses. Auto-sync checkbox in the modal persists via `globalState.pptxViewer.autoSyncAfterDrop`.

### PDF → PPTX import (M-VE-1, 2026-05-23)

Drag a `.pdf` onto the viewer (or pick one via the Update… affordance) and a config modal appears inside the existing webview. Defaults: 16:9 aspect, 1920px long-edge resolution, letterbox on, JPEG @ quality 0.85.

- **Pipeline** — render → encode → build, split so format/quality tweaks re-encode in place without re-running PDF.js; aspect/resolution changes go through a "Re-render" button.
- **Output** — `.pptx` bytes posted through the existing `ingest` channel as `source: 'picker'`, so the compare-modal step is skipped (user just affirmed via the modal).
- **In-file thumbnail** — the first slide's already-encoded bytes are written verbatim to `docProps/thumbnail.<ext>` with the `metadata/thumbnail` relationship, so the viewer's existing thumbnail extractor picks it up on the immediate re-parse. **This is the only place we ever write a thumbnail *into* a pptx**; every other file stays byte-identical (hash stability is identity for the parse cache, URI hash cache, planner, and misfiling guard).
- **Cache eviction on import** — the picker path evicts the entry for the imported file's sha256 from the parse cache before writing, so the post-write `parsePptxCached` call misses and repopulates with the fresh result. Scoped *replace*, not flush.
- **Modules** — `src/pdfImport.ts` (three-phase pipeline), `src/pdfImportLayout.ts` (pure letterbox math), `src/pdfImportConfigHtml.ts` (pure modal renderer), `src/pdfImportWebviewEntry.ts` (the IIFE entry that loads pdfjs-dist).
- **Bundle** — separate esbuild target (`buildOptionsWebview` in `esbuild.config.js`) text-inlined into `dist/extension.js` via a `pdfImportBundlePlugin` placeholder rewrite — pdfjs-dist runs in the DOM-having webview iframe, no asset URLs need to traverse vscode.dev's CSP. New dep: `pdfjs-dist@^5.7.284`. Bundle size: `dist/extension.js` ~2.0 MB (was ~366KB pre-M-VE-1); the +1.6 MB is the inlined webview IIFE, of which ~1.2 MB is the `pdf.worker.min.mjs` side-effect import that puts the fake-worker handler on `globalThis`. The bundle only lands when the viewer panel opens, not on activation.
- **Thumbnail layout** — fixed 240px height with `width: auto` so every file's thumbnail occupies the same vertical slot regardless of source dimensions.

### Extract embedded media (M-VE-2, commit `a4b03f7`)

When a deck has at least one embedded video, an "Extract media:" row appears below the action buttons: a dropdown lists each video as `${basename} — slide N` / `slides N, M` / `unused` (orphan), and the Extract button writes the chosen entry via the extension-side `vscode.window.showSaveDialog` + `vscode.workspace.fs.writeFile` (same pattern as Save As — anchor downloads from the webview iframe are blocked on vscode.dev).

- **Parser side** (`src/pptx.ts`) — walks `ppt/slides/_rels/slide*.xml.rels` and builds a sibling field `mediaFiles: MediaFileEntry[]` (`{mediaPath, mime, sizeBytes, slides: number[]}`) alongside the existing aggregate `embeddedMedia`. Orphan entries (no slide rels reference) are included with `slides: []` and are still extractable.
- **Scope** — v1 is video mimes only; audio/image parts are filtered out of the dropdown but still counted in the aggregate row.
- **No media cache** — re-reads + re-unzips the file on each click.
- **Log** — `[pptx-viewer] extracted: <path> — <bytes> bytes → <target>` per successful extraction.

---

## Folder Sync v1 (complete — DoD signed off 2026-05-23)

Full milestone history + design rationale in `folder-sync-v1-plan.md`. As-shipped surface below.

### M1–M4.5 — Config + plan + executor + JSONC pivot + minimal authoring UI

- `.sync.jsonc` (post-M4.5 pivot from `.sync.yaml`) discovery, topology resolution with hot reload, status bar item.
- Categorised plan webview (`folderSync.openPlan`) — six operation categories as collapsible `<details>` sections, traffic-light footer (green Proceed wired for clean plans; orange+red on collisions).
- Executor (writes + manifest persistence) — atomic tmp + rename, per-file error isolation, completion notification.
- M4.5 custom text editor for `.sync.jsonc` (`folderSync.configEditor`): form fields for destinations (dropdowns of workspace folder names), subpath, include/exclude textareas, form↔text two-way sync via `jsonc-parser`'s `modify()` API. Bundled JSON Schema at `schemas/sync.schema.json` provides IntelliSense + red squiggles in the raw-text editor. "Dry run" opens the workspace-wide plan webview in a separate panel.

### M4.6 — Silent restore + admin editor

Workspace snapshot system that persists the open-folder set + known workspace settings to `.admin-sync.jsonc` at the root of `workspaceFolders[0]`, with a `context.globalState.folderSync.snapshotPointer` cold-start hint. On a folderless activation (the state vscode.dev refreshes into), the extension reads the pointer, re-mounts the folders via `updateWorkspaceFolders`, applies known settings, and surfaces a single `Workspace restored from snapshot · Undo` toast. The capture path subscribes to `SyncManager.onDidChange` and atomically writes when the captured shape differs from on-disk — no-op writes skipped via `snapshotsEqual`. Settings capture is restricted to `KNOWN_WORKSPACE_KEYS` (`files.readonlyInclude`, `files.readonlyExclude`); full-blob capture is M4.6 follow-up work.

Module layout (pure/wired):
- `src/sync/snapshot.ts` — types, marshal/parse JSONC, equality. tsx-testable, no vscode import.
- `src/sync/snapshotStore.ts` — globalState pointer + atomic file I/O + `captureCurrent()` from vscode state.
- `src/sync/restoreFlow.ts` — orchestrates cold-restore + post-restart settings apply + the topology-change writer + the Show/Clear commands. Exports `captureAndWriteSnapshot()` for force-recapture (used by the admin editor's Refresh button).
- `src/sync/adminEditorHtml.ts` / `src/sync/adminEditor.ts` — pure renderer + wired `CustomTextEditorProvider` for `.admin-sync.jsonc`. View-only by design; affordances are Rename-folder per row, Refresh, Clear, and Reopen as text.
- `src/sync/probe.ts` — throwaway `folderSync.probeColdRead` diagnostic; stays in the tree until M4.6 is fully signed off.

Commands: `folderSync.showSnapshot`, `folderSync.clearSnapshot`, `folderSync.openAdminConfig`.

### M5.2.5 — URI hash cache

Two-tier cache keyed by `(uri, size, mtime) → sha256`, sitting between the planner/executor and `vscode.workspace.fs.readFile`. In-memory tier is a bounded `Map<string, …>` keyed by `uri.toString()`; IndexedDB tier (`src/sync/hashCacheIdb.ts`) is a write-through layer that survives browser refresh and silently degrades to in-memory-only if IDB isn't reachable.

- Public entrypoint: `hashFileAtUri(fs, uri, cache?, { needBytes? })` in `src/sync/hash.ts`. Callers needing bytes (viewer, executor) pass `needBytes: true`; callers needing only the hash (destination walks) pass `false` and skip the read entirely on cache hit.
- Wired into `planner.ts` source + destination walks and `executor.ts` pre-write verify. Singleton set at activation in `extension.ts`, read by planner/runSync via `getHashCacheSingleton`.
- Activation log: `hash-cache: idb=<available|unavailable> warm-entries=<N>`. Per-sync-run log surfaces hits/total + bytes saved per destination.
- Same IDB adapter is the foundation for M5.3's `sha256 → ParseResult` cache.

### M5.3 — Content-hashed parse cache (Phases A, B, C shipped; D unwired)

`sha256 → ParseResult` content-addressed cache. `parsePptx` already computes sha256 of input bytes at the top of the function before any other work, so the key is free. Content-addressed means no invalidation: same bytes → same result, forever.

- **Phase A** (`bf1f3f3`) — `InMemoryParseCache` LRU in `src/sync/parseCache.ts`, `parsePptxCached` entrypoint, module singleton. Wired into the viewer's three parse sites (open / ingest / refresh). `(cached)` suffix on parse log lines for hit visibility.
- **Phase B** (`81a948f`, `6b028ac`) — IDB-backed `IndexedDbParseCache` in `src/sync/parseCacheIdb.ts`, two object stores under `folderSync.parseCache`: `parseResults` (dense metadata, identity-index foundation) + `thumbnails` (heavy data URLs). Write-through over the in-memory LRU. `openParseCache` factory degrades silently to in-memory if IDB unavailable.
- **Phase C** (`05b40d5`) — `validatePptxBytes` in `src/sync/validators.ts` takes optional `{ sha256, cache }`. Hit path: build warnings from the cached flags + parseError. Miss path: parse, record the projection, return warnings. Corrupt-zip results cache too — same bytes, same parseError, no re-parse. Planner threads the singleton through `walkAndHash` → `runValidators`.
- **Phase D — unwired.** Identity store + misfiling guard infrastructure landed (`7fdc1c9`) then activation pulled (`705ed32`) — schema extends `ParseResultRecord` with optional `knownAt?: string[]`, DB_VERSION 2→3, `lookupIdentity`/`recordIdentity` on `ParseResultCache`, pure `src/sync/misfile.ts`. Re-enabling is a small `planner.ts` diff when a future iteration wants it.

### Batched IDB reads (post-sign-off polish, commit `33e5d26`, 2026-05-26)

Cross-cutting optimisation that landed during placeholder-files-v1 sign-off. Per-file `cache.lookup(uri, size, mtime)` round-trips were the dominant cost on cold-cache walks. Both `UriHashCache` and `ParseResultCache` gained a `snapshot()` method that returns a synchronous in-memory `Map`, populated from a single IDB `getAll()` (or `getAllEntries()` for the hash cache, which needs the URI as key). The IDB adapter (`src/sync/idbAdapter.ts`) grew a new `getAllEntries()` method.

- Helpers `snapshotLookup` + `snapshotHashLookup` consult the snapshot first and fall through to per-call `lookup()` on miss — single-file `FileSystemWatcher` events still take the fall-through path (no batch benefit for one file).
- Planner — `planForSource` takes both snapshots once before the source + destination walks; reuses them across both walks for that source.
- Search indexer — `doFullPass` takes both before the per-URI loop.
- 13 new tests across `test/sync-hash-cache.test.ts` + `test/sync-parse-cache.test.ts`.
- Diagnostic log lines: `sync: parse-cache snapshot: N entries`, `sync: hash-cache snapshot: N entries`.
- **Headline impact (PWA, real workspace):** viewer-open of a non-placeholder `.pptx` drops from ~2.5s to sub-100ms on warm caches.

### M6 — Polish (six phases, all shipped 2026-05-23)

- **M6.A — Status bar primary action.** Clicking opens the workspace plan (`folderSync.openPlan`) in the healthy state, falls back to `showTopology` for empty/error states.
- **M6.B — Explorer context menu + folder-scoped invocation.** `folderSync.syncThisFolder` registered under `7_modification@10` with `when` = `explorerResourceIsFolder && folderSync.hasAnySource` (context key written from `manager.onDidChange`). Source-side clicks open the scoped plan against the nearest enclosing source; destination-side clicks reverse-map through `destRootUri` to the equivalent source path. `openPlanPanel` takes optional `{ scope, title }` so scoped panels live alongside the workspace-wide one with folder-specific tab titles.
- **M6.C — Orphan `.tmp` cleanup.** `**/*.tmp` added to `BUILT_IN_IGNORES` so an interrupted atomic write no longer surfaces as a fake destination-only entry. Pre-execute sweep in `runSync.ts` walks each `destRootUri` and removes orphan `*.tmp` files before the run. Pure `sweepOrphanTmpFiles` in `src/sync/orphanSweep.ts` (tsx-tested) + thin vscode-wired adapter in `src/sync/orphanSweepWired.ts`.
- **M6.D — Manifest version-mismatch refusal.** `readManifest` returns a discriminated `ManifestReadResult` (`{ kind: 'ok' }` / `{ kind: 'version-mismatch', actual }`). Planner surfaces mismatches as `skippedReason`; `runSync` collects them into `summary.manifestVersionMismatches`. Both green-path proceed surfaces (workspace plan panel + per-file sync from the viewer) show a warning toast via `surfaceManifestVersionMismatches()` in `planView.ts` with `Open Manifest` / `Show Details` actions.
- **M6.E — Manifest custom editor.** `folderSync.manifestEditor` registered for `**/.foldersync-manifest.json`. View-only tabular renderer: header (version + lastSync + destination root), sorted entries table (key / dest path / humanised size / sha-first-12 with tooltip / relative-time synced-at), sorted decisions table (✓/– flag glyphs + decided-at), version-mismatch banner replacing tables when `readManifest` returns the mismatch variant, Reopen-as-text escape hatch. Pure renderer + view-model in `src/sync/manifestEditorHtml.ts`, wired provider in `src/sync/manifestEditor.ts` re-rendering full HTML on `onDidChangeTextDocument` so the executor's mid-sync writes refresh the editor live. Parse helper extracted into `manifest-types.ts` as `parseManifestText` / `normaliseManifest` so the editor and `readManifest` share one parser.
- **M6.F — DoD walkthrough + sign-off.** All 9 v1 DoD bullets verified against the code.

---

## Presentation Search v1

Workspace-wide search panel for `.pptx` (and `.pdf` by filename) with debounced as-you-type matching across filename / `dc:creator` / first-visible-slide text. Open via `pptxSearch.openPanel` (command palette).

Modules under `src/search/` follow the pure/wired split:
- **Pure:** `fold.ts` (NFD + lowercase), `tokenize.ts` (whitespace + camelCase + snake_case splits), `score.ts` (AND/OR across terms with prefix > substring > field-weight ranking), `projection.ts` (`ParseResult` → tiny `SearchProjection`), `searchEngine.ts` (three-map sha↔URI in-memory store), `scope.ts` (workspace folders minus sync destinations + group-by-folder helper).
- **Wired:** `indexer.ts` (workspace walks + `FileSystemWatcher` + topology subscription), `indexStore.ts` (dedicated `pptxSearch.index` IDB DB v1, keyed by sha256), `searchPanel.ts` + `searchPanelHtml.ts` (singleton webview, debounced search, click-to-open, multi-select update flow, hash-pairing badge, OR-mode toggle, error-count + scope-changed-to-zero footer surfaces).

Per-URI layered cache walk: `indexStore.getBySha` → `parseCache.lookup` → fresh `parsePptxCached`. Keeps cold walks cheap and reuses the M5.3 parse cache when warm.

PDFs index filename-only (no DOM in the extension host); they're excluded from the canonical (first) workspace folder so the multi-select update flow only ever writes PPTX targets. PDF-source / PPTX-target pairs route into the viewer's existing PDF import modal via `requestPdfImportIntoViewer` rather than a search-side write. A basic read-only PDF custom editor (`pptxViewer.pdfViewer` registered with `priority: "default"` for `*.pdf`) renders page 1 via the existing inlined pdfjs-dist bundle so click-through from search doesn't dump raw binary into a text editor.

Plan + sign-off history: `pptx-search-v1-plan.md`.

---

## Placeholder files v1

Workspace-level "this file is a stub, not real content yet" registry. Threads through plan UI + viewer banner. Operators dropping zero-byte `.pptx` stubs (Windows Explorer's "New PowerPoint Presentation") or custom blank-template decks need to know which destination files are still placeholders when content lands.

### Storage

`.admin-sync.jsonc` gains a `placeholders: string[]` field (lowercase sha256 hex; the empty-file sha is the implicit default and never written to disk — the locked default row in the admin editor is a UI property only).

### Admin editor card

New Placeholders card lists the default plus user entries with an `[x]` remove button and an "Add placeholder…" file picker that hashes the chosen sample via `hashFileAtUri(vscodeFs(), …)`. Snapshot recapture preserves the array — `captureCurrent()` takes an optional `existingPlaceholders` param and the topology writer + Refresh button read it off disk via `readPlaceholdersFromDisk()` before recapturing.

### Registry

Single workspace-wide registry (`src/sync/placeholderRegistry.ts`) caches the effective set; `FileSystemWatcher` on `.admin-sync.jsonc` + `onDidChangeWorkspaceFolders` keep it current. Public API: `getActivePlaceholderSet()` (async, always correct) and `getActivePlaceholderSetSync()` (cold-tolerant for render-time paths). Pure helper `computeEffectiveSetFromText` lives in `snapshot.ts` so it stays tsx-testable.

### Classifier integration

`classifyFiles` annotates `PlanItem.isPlaceholder?` by category-appropriate identity hash (`sourceHash ?? destHash ?? manifestHash`) — `create`/`update-*`/`skip` use the source hash, `destination-only` uses the dest hash, `delete-tracked` uses the manifest hash. `BuildPlanOptions.placeholders` threads the set through every call site: `planView.openPlanPanel`, `adminEditor`/`configEditor`/`provider` embedded plans, and the `folderSync.dryRunPlan` command.

### Plan rendering

- Per-row `[P]` chip in `.row-lead` (paired with the warning badge and decision controls).
- `placeholders: N` chip in the totals strip (per-pair operation count, consistent with other operation-count chips).
- Three-state footer line in the standalone plan webview (deduped per source):
  - `N=0, M>0` → green **"All M source files have content."**
  - `N=M, M>0` → blue **"All M source files are placeholders (no content received yet)."**
  - `0<N<M`  → blue **"N of M source files {is|are} placeholders (missing content)."**
  - `M=0`    → silent (no source files mapped; nothing to say).
- Footer counts are **deduped per source** — a single source file mirrored to 3 destinations counts once, not three times — because the operator-facing question is "how many speakers still owe me content?" not "how many per-pair operations are queued?". `destinationOnly` and `deleteTracked` are excluded from the footer counts; they remain in the per-pair totals chip.
- `PlanTotals.uniqueSourceFiles` + `uniqueSourcePlaceholders` carry the deduped numbers.
- Embedded callers (admin editor, config editor, viewer scoped plan) inherit the chips via `planContentStyles()`. Footer line is standalone-only.

### M5.5 row layout refactor

`renderRow` markup split into `.row-lead` (path + chips/badges/decisions, grows + wraps) and `.row-meta` (size + hashes, intrinsic-width, anchors right) so size/hash columns stay aligned across rows regardless of how many lead-side affordances appear. Layout-regression test guards against drift.

### Viewer banner precedence

- `isPlaceholder=true` → blue info banner "This is a placeholder file — content not yet uploaded." + validation flags suppressed (regardless of `parseError`).
- `isPlaceholder=false` + `parseError` → existing red corrupt banner.
- `isPlaceholder=false` + no error → unchanged.

`provider.renderWithSyncTarget` skips the per-file scoped sync-target build for placeholders entirely (the workspace plan view's `[P]` chip is the right place to see sync state for a stub; the viewer for a placeholder is a fast operator confirmation glance).

### Zero-byte short-circuit

`parsePptx` short-circuits for `bytes.length === 0` — synthesises a result with the well-known empty digest, no `parseError`, no hash compute, no `unzipSync` attempt. `parsePptxCached` short-circuits before the IDB lookup too. Zero-byte placeholders open without any backing-store round-trip.

Plan + sign-off history: `placeholder-files-v1-plan.md`. Handoff context: `placeholder-files-v1-report.md`.

---

## Cross-cutting patterns

### Layered-cache abstraction

When a new derived-data store wants to sit alongside an existing content cache, prefer a layered lookup over a coordinated rewrite. Search's projection layer was originally designed to abstract over "M5.3 ships / doesn't ship" via a `getProjectionForSha(sha, uri)` function; by the time M4 wired up, M5.3 had shipped, so the indexer threaded the layered lookup directly (`indexStore` → `parseCache` → fresh parse).

The IDB adapter (`src/sync/idbAdapter.ts`) is shared infrastructure but each subsystem owns its own DB name + schema version so lifecycles (eviction, upgrades, full clears) stay independent — search uses `pptxSearch.index`, sync uses `folderSync.hashCache` + `folderSync.parseCache`.

### Row layout: chips next to path, meta anchors right

In any per-file row UI, place chips/badges/decisions right after the filename; size + hash stay in a stable right-anchored column. Established by the M5.5 row layout refactor (`.row-lead` / `.row-meta` split in `src/sync/planHtml.ts`). Don't slip back to size-between-path-and-affordances.
