# pptx-search-v1-plan

Search across `.pptx` files in workspace source folders by filename, author, and first-visible-slide text. New webview panel. IDB-backed projection index for performance.

---

## Status

**v1 SHIPPED — all milestones (M1–M5, M-MULTI, M-PDF-OR, post-M-PDF-OR follow-ups, M-PDF-VIEW, M6) complete and live on the VPS test harness. All 10 DoD bullets met. Substrate (`CLAUDE.md`) updated.**

Progress:

- **M1** — pure projection + tokenizer + scorer. Commit `673ec79`. Files: `src/search/{fold,tokenize,score,projection,index-types}.ts`. Tests: `test/search-{fold,tokenize,score,projection}.test.ts`.
- **M2** — parser extension for first-visible-slide text. Same commit `673ec79`. `extractAllSlideText` added to `src/pptx.ts`; `ParseResult.firstVisibleSlideText: string` is now a required field (defaults to '' for old IDB cache hydration via `parseCacheIdb` v5→v6 bump). Tests: `test/pptx-first-visible-slide-text.test.ts`.
- **M3** — IDB store + in-memory engine. Commit `1517e41`. Files: `src/search/{indexStore,searchEngine}.ts`. Dedicated `pptxSearch.index` IDB DB (separate from hash + parse cache DBs — independent lifecycle). Engine holds three coordinated maps (`sha→projection`, `uri→sha`, `sha→Set<uri>`) exposing `load / addOrUpdate / removeUri / search / stats / getShaForUri / getAllUris`. Tests: `test/search-engine.test.ts`.
- **M4** — wired indexer + activation. Commit `c0afc34`. Files: `src/search/{indexer,scope}.ts`. Layered cache walk per URI: `indexStore.getBySha` → `parseCache.lookup` → fresh parse via `parsePptxCached`. `vscode.workspace.findFiles(new RelativePattern(folder, '**/*.pptx'))` per in-scope folder. `FileSystemWatcher('**/*.pptx')` filters via `isUnderScope`. Activation in `extension.ts` opens the store, warm-loads the engine, starts the indexer, and logs `search-index: idb=<state> warm-entries=<N>` / `search-index: scope folders=<N>`. Tests: `test/search-scope.test.ts`.
- **M5** — webview panel UI. Commit `1a87138` (+ post-M5 follow-ups, see below). Files: `src/search/{searchPanelHtml,searchPanel}.ts`. Pure renderer emits the panel shell + a single nonce-tagged inline script that drives debounced search, result rendering, click-to-open, and reindex. Wired layer owns a singleton `WebviewPanel`, dispatches the four message types, and forwards `IndexerProgress` to the panel as `indexProgress` / `indexComplete`. Commands `pptxSearch.openPanel` + `pptxSearch.probeIndex` register only when the search subsystem init succeeded. Tests: `test/search-panel-html.test.ts`.

Post-M5 follow-ups (between M5 and M6 sign-off):

- **Display-string fix** — commit `b9a928a`. The panel was showing the folded URI-encoded basename (`wed%20206%20mr%20simon%20santosha.pptx`) and the folded author. Added `displayFilename` + `displayAuthor` to `SearchProjection` (and `SearchHit`), bumped `SEARCH_PROJECTION_SCHEMA_VERSION` 1→2 so v1 IDB entries auto-evict and re-project. Tokens now derive from the decoded display name so they split on the human form, not on percent-encoded bytes. Panel also decodes URIs for display with a try/catch fallback.
- **Group by top-level folder** — commit `66b3482`. Pure `groupHitsByFolder(hits, scope)` in `src/search/scope.ts` buckets hits by longest-matching scope folder URI; buckets come out in scope order (= workspace-folder declaration order). Wired layer groups before postMessage so the panel only sees pre-bucketed data. Inline script renders one `<section class="hit-group">` per group with `:nth-of-type(even)` alternating tinted background (via `--vscode-editorWidget-background`).
- **Fan out duplicate-content hits** — commit `1c036ea`. Same deck copied byte-for-byte into two source folders comes back as one hit (deduped by sha) with two URIs. `groupHitsByFolder` now partitions each hit's URIs by folder and emits a per-folder copy with only the URIs that live in that folder — so the deck shows up under both folder headers, not just under the first URI's folder.
- **Retain context when hidden** — commit `6e639eb`. `retainContextWhenHidden: true` on the panel so clicking a result and tabbing back doesn't tear the webview down and lose the input + results.

All commits pushed and live on `vscode.sophtwhere.com`. All 10 v1 DoD bullets met after M6 (substrate update + sign-off).

This plan was written deliberately self-contained so it can be resumed in a fresh session without re-reading the full project substrate. Read `CLAUDE.md` only when you need wider context (other features, dev workflow, dead ends). The "Pointers into the existing codebase" section below lists every existing file you need to know about for this feature.

---

## What this feature is

A workspace-wide presentation finder. The user types partial names; matching `.pptx` files appear ranked by relevance. Use case: locating a person's slide deck when they vaguely remember the presenter's name, the talk title, or part of the filename. Three things get matched:

1. **OS filename** (basename of the file URI)
2. **Author** — `dc:creator` from `docProps/core.xml`
3. **First-visible-slide text** — concatenated `<a:t>` runs from the first non-hidden slide, covering title placeholder, body, text boxes, table cells, and grouped shapes. *Excluded*: speaker notes, master-slide content (footers, slide numbers).

If a deck's first non-hidden slide has no text (image-only intro), that field is empty for indexing and search falls back to filename + author.

---

## Decision: architecture

**Option B with a thin abstraction layer.** Search ships with its own dedicated `pptxSearchIndex` IDB store holding a tiny per-file projection (filename, author, first-slide-text tokens, sizeBytes, mtime). Indexing happens via a `getProjectionForSha(sha256, uri) → SearchProjection` function that today parses on miss and writes to the projection store; if/when M5.3 (sha256 → full ParseResult cache) lands, that function transparently switches to deriving the projection from the cached ParseResult.

Considered and rejected: rolling M5.3 into the same effort (Option A). Reasons:
- M5.3's design surface is bigger than search needs (embedded media lists, validation flags, possible thumbnail bytes, schema versioning across parser evolution).
- Fat ParseResult entries (10–100KB+) make IDB writes slower than tiny projection writes (1–5KB).
- Coupling search shipping to M5.3 design means waiting longer for less.
- The abstraction layer preserves the option to consolidate later without a rewrite.

Other decisions baked in:

- **Tokenize on index, prefix-or-substring match on search.** No Levenshtein typo-tolerance in v1. Token splits on whitespace, punctuation, hyphens, camelCase, snake_case. AND across query terms (all must match somewhere), OR across fields (a term hits if it matches any field's tokens).
- **Case-insensitive, NFD diacritic-fold.** "Søren" matches "soren".
- **Ranking:** prefix > substring; shorter matching token > longer; filename/author hits > slide-text hits.
- **Debounced as-you-type** (~150ms).
- **Webview panel only for v1.** Indexer + tokenizer + scorer are pure modules so a future QuickPick / sidebar tree / status-bar command can call the same search function. No QuickPick in v1.
- **Linear scan in memory.** Workspaces top out at ~3000 files (~500 typical). Sub-millisecond per query at that scale. No inverted index. No external library (fuse.js / minisearch); ~50 LOC of hand-rolled tokenize + score, zero deps.
- **Searchable scope = workspace folders that are NOT destinations in any active `.sync.jsonc`.** A folder can be both source and destination across different configs; if a folder is *anywhere* a destination, it's excluded from the search scope. Workspace folders with no `.sync.jsonc` at all are included.

Out of scope for v1:

- True Levenshtein typo-tolerance ("jhon" → "John")
- Other UI surfaces (QuickPick, sidebar tree, status bar)
- Indexing destinations (they're outputs, not what you're searching for)
- Speaker notes, master slide content, slides beyond the first visible one
- Slide thumbnails in results (might revisit in v2)
- M5.3 ParseResult cache (separate effort)

---

## Architecture sketch

### Data model

```ts
// Pure types, in src/search/index-types.ts
interface SearchProjection {
  sha256: string;        // primary key
  filename: string;      // basename only, lowercased + folded once at index time
  author: string;        // dc:creator, lowercased + folded
  slideText: string;     // concatenated first-visible-slide text, lowercased + folded
  filenameTokens: string[];
  authorTokens: string[];
  slideTextTokens: string[];
  sizeBytes: number;
  mtime: number;
  schemaVersion: 1;
}

interface SearchHit {
  sha256: string;
  uris: vscode.Uri[];    // same sha256 can live at multiple paths
  filename: string;
  author: string;
  score: number;
  matchedFields: ('filename'|'author'|'slideText')[];
}
```

Entries are sha256-keyed so identical content at multiple paths is deduplicated naturally — one index entry, multiple URIs surfaced in the hit.

### Module layout

Mirror the `src/sync/` pattern. New directory `src/search/`:

```
src/search/
  index-types.ts        pure: SearchProjection, SearchHit, SearchQuery types
  tokenize.ts           pure: string → token[], handles camelCase / snake_case / punctuation
  fold.ts               pure: NFD + lowercase + strip combining marks
  score.ts              pure: query tokens × projection → score, matchedFields
  projection.ts         pure: ParseResult → SearchProjection (extracts first-visible-slide text)
  indexStore.ts         IDB-backed CRUD over pptxSearchIndex store
  indexer.ts            vscode-wired: walk source folders, populate index via getProjectionForSha
  searchEngine.ts       in-memory copy of all projections + search function (the scan)
  searchPanel.ts        vscode-wired: webview panel provider, message protocol
  searchPanelHtml.ts    pure: SearchPanelState → HTML string
```

Tests (`test/search-*.test.ts`), one per pure module, tsx-runnable:

```
test/search-tokenize.test.ts
test/search-fold.test.ts
test/search-score.test.ts
test/search-projection.test.ts
test/search-engine.test.ts
test/search-panel-html.test.ts
```

### Lifecycle

1. **Activation:** open IDB store, load all projections into in-memory engine, register command + panel provider, register FileSystemWatcher.
2. **First panel open:** kick off background indexer if not run this session. Reports progress to the panel.
3. **Indexer walk:**
   - Get source-folder set from `SyncManager` (workspace folders minus those that are destinations in any config).
   - For each source folder, glob `**/*.pptx`.
   - For each `.pptx`, call `hashFileAtUri(fs, uri, hashCache, { needBytes: false })` — cache hit avoids re-read.
   - Call `getProjectionForSha(sha256, uri)` — store hit returns projection; miss reads bytes, parses, projects, writes.
   - Update in-memory engine as entries land.
4. **Watcher events:**
   - `onDidCreate` / `onDidChange`: re-hash (mtime change invalidates the URI hash cache), call `getProjectionForSha`.
   - `onDidDelete`: drop URI from engine; if no other URI maps to that sha256, drop the projection entry too.
5. **Search:** panel posts `{type:'search', query}`. Engine tokenizes, scans in-memory projections, returns ranked hits. Panel renders.
6. **Result click:** panel posts `{type:'open', uri}`. Extension calls `vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(uri))`.

### IDB integration

Reuse `src/sync/idbAdapter.ts` (already opened by the hash cache and parse cache). Add a new object store `pptxSearchIndex`, keyPath `sha256`. The adapter handles `onupgradeneeded` for adding the store; bump the DB version.

If `parseCache.ts` / `parseCacheIdb.ts` already implement the M5.3 ParseResult cache (check during M1 — these files exist but I haven't read them yet), `getProjectionForSha` can derive from there instead of doing its own parse. If they're a different cache or stub, do the parse directly in projection.ts.

### Pure / wired split

Every module above marked `pure` has zero vscode imports and is tsx-testable. Specifically:

- **`searchEngine.ts` is pure** even though it holds state — it takes projections in via a load() call, exposes search(), and emits no I/O.
- **`indexer.ts` is wired** because it talks to `vscode.workspace.fs`, FileSystemWatcher, SyncManager.
- **`searchPanel.ts` is wired**; the HTML render lives in `searchPanelHtml.ts` for snapshot testability.

---

## Milestones

### M1 — Pure projection + tokenizer + scorer ✅ DONE (commit `673ec79`)

Land the deterministic core with tests. No vscode, no IDB.

- `src/search/fold.ts` — NFD normalize + lowercase + strip combining marks.
- `src/search/tokenize.ts` — split on whitespace/punct/hyphens/camelCase/snake_case, drop empties, dedupe per field.
- `src/search/projection.ts` — given a `ParseResult` (from `src/pptx.ts`) and a filename, produce a `SearchProjection`. Extracts first-visible-slide text from the parser output. **May require extending the parser** to expose per-slide text — see "Parser extension" below.
- `src/search/score.ts` — query tokens × projection → `{score, matchedFields}`. AND across query terms, OR across fields. Prefix > substring. Shorter token > longer. Filename/author > slideText.
- Tests for each module.

DoD: `npm run test:search-fold test:search-tokenize test:search-projection test:search-score` all pass; coverage includes the camelCase + diacritic + AND/OR + ranking cases.

### M2 — Parser extension ✅ DONE (commit `673ec79`)

Check `src/pptx.ts`. The author field is already extracted (per substrate). First-slide visible text probably isn't — the existing test `pptx-title-extract.test.ts` suggests there's *some* slide-text extraction. If extraction of slide-1 text doesn't exist, add it as a *new* field on `ParseResult` (don't change existing fields — viewer + sync depend on them).

Naming: `firstVisibleSlideText: string` on `ParseResult`. Empty string if no visible slides or no text shapes.

DoD: `npm run test:parse` still passes; new test cases for first-visible-slide extraction (hidden first slide → second is used; image-only first slide → empty string; text inside groups + tables → included).

### M3 — IDB store + engine ✅ DONE (commit `1517e41`)

- `src/search/indexStore.ts` — opens a **dedicated** `pptxSearch.index` DB (store `projections`, key = sha256, version 1). The plan originally suggested sharing a DB with hash/parse caches; M3 chose a separate DB to keep schema-bump cadence and reset lifecycles independent — same pattern as `folderSync.hashCache` vs `folderSync.parseCache`. Surface: `getBySha`, `putProjection`, `deleteBySha`, `getAll`, `clear`, `count`, `close`. Schema-version drift handled at read (mismatched-version entries silently dropped, indexer re-projects on next pass); `DB_VERSION` bumps reserved for actual IDB schema changes.
- `src/search/searchEngine.ts` — three coordinated maps (`sha→projection`, `uri→sha`, `sha→Set<uri>`) with documented I1/I2/I3 invariants. Pure module, no IDB/vscode imports. Surface: `load`, `addOrUpdate`, `removeUri`, `getProjection`, `getUrisForSha`, `search`, `stats`. Plus exported `parseQuery`. Hit ordering: score desc → filename asc → sha asc (deterministic).
- `src/sync/idbAdapter.ts` — added `getAll(): Promise<V[]>` to `IdbStore`. The hash + parse caches deliberately don't use it (they're lookup-on-demand); search is the warm-load consumer. Test fakes in `test/sync-{hash,parse}-cache.test.ts` gained `getAll()` stubs.
- `test/search-engine.test.ts` — 17 cases. DoD bullets all covered: dedup-by-sha, removal cascade (last URI removed → projection dropped), URI re-sha (orphan-drop + shared-keep variants), AND across terms, filename-beats-slideText, prefix-beats-substring.

DoD achieved.

### M4 — Wired indexer + activation ✅ DONE (commit `c0afc34`)

- `src/search/indexer.ts` — walk source folders, glob `**/*.pptx` via `RelativePattern`, layered cache lookup per URI: `indexStore.getBySha` → `parseCache.lookup` → fresh parse via `parsePptxCached`. Emits `IndexerProgress` events the panel forwards to the footer.
- `src/search/scope.ts` — pure scope computation. `computeSearchScope({ workspaceFolderUris, destinationWorkspaceFolderUris })` returns the folder set to walk. `isUnderScope` + `urisLeavingScope` for the watcher / topology-change path. (Grouping helper `groupHitsByFolder` was layered in post-M5 — see follow-ups above.)
- Wired into `extension.ts` activation: opens the dedicated IDB store, warm-loads the engine, starts the indexer, registers `FileSystemWatcher('**/*.pptx')` filtered through `isUnderScope`. Activation logs `search-index: idb=<state> warm-entries=<N>` / `search-index: scope folders=<N>`.
- `getProjectionForSha` derives from `parseCache.lookup` first (M5.3 cache already shipped), falling back to a fresh `parsePptxCached` on miss — the "abstraction layer" is the layered lookup itself.
- Source-folder filter pulled from `SyncManager.topology`: each source contributes; any folder claimed as a destination *anywhere* is excluded. Updates on `manager.onDidChange`.

DoD achieved: cold walk completes well under target; watcher updates surface promptly; tests in `test/search-scope.test.ts` (18 cases incl. grouping fan-out).

### M5 — Webview panel UI ✅ DONE (commit `1a87138` + post-M5 follow-ups)

- `src/search/searchPanelHtml.ts` — pure renderer. Emits panel shell (CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-<random>';`) + a single nonce-tagged inline script that drives debounced search (150ms), result rendering, click-to-open, and reindex. Footer shows "N of M presentations indexed" plus live indexer progress.
- `src/search/searchPanel.ts` — singleton `WebviewPanel` (one panel module-scope tracked). `retainContextWhenHidden: true` so navigating to an opened file and tabbing back preserves the input + results. Message protocol:
  - panel → ext: `{type:'search', query}`, `{type:'open', uri}`, `{type:'reindex'}`
  - ext → panel: `{type:'results', query, groups, truncated, totalMatches}`, `{type:'indexProgress', phase, done, total}`, `{type:'indexComplete', phase, done, total}`
  - Results are pre-bucketed via `groupHitsByFolder` before postMessage, capped at MAX_RESULTS=200.
- Commands `pptxSearch.openPanel` ("Presentation Search: Open") + `pptxSearch.probeIndex` (diagnostic) register only when the search subsystem init succeeded.
- Tests: `test/search-panel-html.test.ts` (15 cases — header, footer, hits, groups, empty state, escape).

Post-M5 follow-ups (display-string fix, group-by-folder, fan-out, retain-context) are listed in the Status section above.

DoD achieved.

### M-MULTI — Multi-select + Update file flow ✅ DONE (commits `b8154cc` + `f7f8785`)

The v1 panel originally shipped one action per row: click → open the file in the viewer. M-MULTI adds the "remote dropbox" workflow the user flagged in the [Next-session hook](#next-session-hook--multi-result-actions) section: locate the canonical file and the freshly-uploaded copy in the search results, confirm the swap via a side-by-side compare, then update (and optionally delete) in one click.

**User flow**

1. Shift-click any hit row → enter selection mode. The shift-clicked row is selected (yellow background). A toolbar appears above the results with a "Clear selection" button and a disabled "Update file…" button.
2. While in selection mode, every click toggles selection (shift no longer matters for the per-row interaction).
3. When exactly **2** rows are selected, **1 in the first group** (groups[0] — the canonical workspace folder), and **1 in another group** (a remote/dropbox staging folder), both rows turn lime green and the Update-file button enables.
4. Clicking Update-file pops a side-by-side modal showing both files' metadata, sha256, thumbnail, and slide/author info — same layout as the viewer's drop-update modal (CSS shared via `compareModalCss()`).
5. Three actions in the modal:
   - **Cancel** — dismiss; both rows stay lime green; the user can pick a different pair.
   - **Update file** — overwrite canonical with the incoming bytes; both rows go to dimmed/disabled state.
   - **Update & remove source** — same write, plus delete the source URI from disk; the source row turns dark-gray-with-red-tinge (line-through), the target row goes to dimmed/disabled.
6. If the two files have identical sha256 the modal is the "identical" variant — Cancel only, no destructive action offered.
7. Disabled rows are inert (pointer-events: none, no longer participate in selection). The dimming/red-tinge state persists for the lifetime of the current result set so the user can work through a batch one pair at a time without re-selecting the same files. Typing a new query resets all selection + disabled state.

**Reuses the existing update pipeline**

The wired layer mirrors `handleIngest`'s picker/upload path in `src/provider.ts`:

1. Read both files via `vscode.workspace.fs.readFile`.
2. Parse both via `parsePptxCached(getParseCacheSingleton())` — same cache-aware parser the viewer uses.
3. Compare sha256. If identical → identical-modal. Else → compare modal.
4. On confirm: `cache.forget(candidateSha)` → `vscode.workspace.fs.writeFile(targetUri, bytes)` → (optional) `vscode.workspace.fs.delete(sourceUri, { useTrash: false })` → `vscode.commands.executeCommand('vscode.open', targetUri, { viewColumn: Beside })`.

The viewer's `resolveCustomEditor` re-reads + re-parses the freshly-written file on open; no special "Updated" badge is set (that badge only fires inside an already-open viewer responding to its own ingest message). The user gets the viewer-side render of the new content as the success signal, plus the disabled state on the search panel rows.

**Files**

- `src/search/updateModalHtml.ts` — pure renderer for both modal variants. `renderSearchUpdateModalHtml` and `renderSearchUpdateIdenticalModalHtml`. CSS is shared with the viewer's compare modal via re-import of `compareModalCss()`.
- `src/search/searchPanelHtml.ts` — extended: CSS additions for `.hit.selected`, `.hit.selected.primed`, `.hit.disabled.{updated,removed}`, multi-select toolbar styles, and the modal-host overlay. Inline script gained `selectionMode` / `selectedKeys` / `disabledKeys` state, row-click selection logic, primed-state evaluator, toolbar reconciliation, and `updateModal`/`updateResult` message handling.
- `src/search/searchPanel.ts` — extended: `updateFile` handler reads + parses both files and posts the modal; `updateConfirm` handler runs the write pipeline (with optional delete); `updateCancel` handler clears the pending slot and dismisses the modal. Per-panel `pendingUpdate` slot holds the source bytes between modal open and confirm so the confirm path doesn't re-read.
- `src/search/scope.ts` — `folderLabelFor` exported (previously module-private) so the wired layer can derive modal column headers from the same logic the panel uses for group headers.
- `test/search-panel-html.test.ts` — 5 new cases covering toolbar markup, modal-host overlay, CSS class definitions, compareModalCss inlining, and script wiring. 20/20 green.

**Outbound message protocol additions** (panel → ext):

- `{type: 'updateFile', targetUri, sourceUri}` — primed-button click.
- `{type: 'updateConfirm', mode: 'update' | 'update-remove'}` — modal button click.
- `{type: 'updateCancel'}` — modal cancel.

**Inbound message protocol additions** (ext → panel):

- `{type: 'updateModal', html}` — shows the side-by-side (or identical) modal.
- `{type: 'updateModalClose'}` — dismisses the modal (used on cancel).
- `{type: 'updateResult', outcome: 'updated' | 'updated-removed' | 'identical' | 'error', targetUri?, sourceUri?, message?}` — applies disabled state and dismisses the modal.

**DoD achieved**: 22/22 `test:search-panel-html` green at sign-off; typecheck clean; dist bundle ships. Live verification of the shift-click → modal → write/delete loop done on `vscode.sophtwhere.com`. Follow-on commit `f7f8785` added the hash-pairing badge so duplicate-content rows are visually grouped at a glance — same-sha rows share a stable colour-coded badge derived from a small palette.

**Out of scope for M-MULTI**: routing PDFs through this flow. Picked up immediately after in M-PDF-OR below.

### M-PDF-OR — PDF indexing + OR-mode toggle ✅ DONE (commit `196a991`)

Two related additions shipped together in one cycle, both motivated by dog-fooding M-MULTI on real data:

1. **Index `.pdf` files alongside `.pptx`.** Filename-only — the extension host has no DOM, so PDF.js can't run there for metadata or text extraction. Filename matching is enough for the "find the file by a known fragment" use case the user actually has.
2. **"Any term (OR)" checkbox** beside the search input. Widens the AND-across-terms default so a single hitting term qualifies a file. Useful for fishing out a known filename fragment when other metadata isn't surfacing the hit.

**Indexer changes** (`src/search/indexer.ts`):

- Walk glob changed `**/*.pptx` → `**/*.{pptx,pdf}`; FileSystemWatcher pattern likewise.
- New fast path in `processUri`: if the basename ends in `.pdf`, hit `indexStore.getBySha` first (cheap refresh of URI fields on cache hit), else build a `projectFilenameOnly` projection — no parse, no read beyond the hash. The hash path stays shared with the pptx flow via `hashFileAtUri`.
- Pass-start log line updated to "pptx+pdf" so the OutputChannel reflects the wider scope.

**Projection changes** (`src/search/projection.ts`):

- New `projectFilenameOnly({sha256, fileName, sizeBytes, mtime})` that fills `author=''` and `slideText=''` and falls through to the same `buildProjection` used by pptx — keeps the schema identical (no `kind` field, no schema-version bump). Type-routing for downstream logic happens on the filename extension instead, via the `isPdfBasename` helper shared between `indexer.ts` and `searchPanel.ts`.

**OR-mode plumbing** (`src/search/{index-types,score,searchEngine}.ts`):

- `SearchQuery` gains `op: 'and' | 'or'` (default `'and'`).
- `parseQuery(raw, op?)` and `engine.search(raw, op?)` thread `op` through; defaults preserve all existing call sites.
- `scoreProjection` skips the AND short-circuit when `op === 'or'`. Per-term scores still accumulate, so a projection that hits both terms ranks above one that hits only one — the toggle changes what counts as a hit at all, not how hits are ranked relative to each other.

**Panel changes** (`src/search/searchPanelHtml.ts`):

- New `#or-mode` checkbox in the header (`<label class="search-option"><input type="checkbox">Any term (OR)</label>`), styled to sit alongside the search input.
- Inline script gained `currentOp()` helper + change listener; every outbound `search` message now carries an `op` field. Toggling the checkbox re-runs the active query.

**Update flow extension** (`src/search/searchPanel.ts`, `src/search/updateModalHtml.ts`):

- `handleUpdateFile` now type-routes on the canonical-target filename extension:
  - PPTX↔PPTX → existing parse+compare modal (`renderSearchUpdateModalHtml`).
  - PDF↔PDF → new thin compare modal (`renderSearchUpdatePdfModalHtml`) with just filename / size / mtime / sha256 — no parse, no thumbnail. Same 3 button IDs (`#search-update-{cancel,confirm,remove}-btn`) so the existing `handleUpdateConfirm` works unchanged for both file types.
  - Mixed pairs (one PDF, one PPTX) → refused with a `vscode.window.showWarningMessage` toast pointing the user at the viewer's drag-and-drop import path; the `updateResult` `error` outcome dismisses the modal cleanly.
- PDF compare path uses `hashFileAtUri` with `needBytes: true` on the source (to hand bytes to the write step) and `needBytes: false` on the target (only the sha needed for identical-check).
- Cache safety: `parseCache.forget(candidateSha)` on confirm is a no-op for PDFs (never inserted into the pptx parse cache).

**Tests added**:

- `test/search-score.test.ts` — 3 new cases (OR one-term hit, OR multi-term outranks single, OR no-hits → 0).
- `test/search-engine.test.ts` — 2 new cases (`parseQuery` op default + threading; OR end-to-end keeping the half-match).
- `test/search-panel-html.test.ts` — 2 new cases (`#or-mode` checkbox + label markup; inline script wires `currentOp` + `op` field into the search message).

All 6 `test:search-*` suites green; `npx tsc --noEmit` clean; `npm run bundle` clean (542.9 KB).

**Out of scope for M-PDF-OR (intentionally deferred)**:

- PDF metadata / text extraction via a hidden helper webview. PDF.js could run in a DOM-having webview iframe (same pattern as the pdfImport webview entry), but adds lifecycle complexity and bundle size. Filename-only is enough for current real-world usage. Revisit if a user signal warrants it.
- Schema-bumping the projection to carry a `kind: 'pptx'|'pdf'` discriminator. Today the consumer that needs the distinction (update-flow type-router) derives it cheaply from the filename extension; not worth the IDB eviction cost.

### Post-M-PDF-OR follow-ups ✅ DONE

Two adjustments landed after M-PDF-OR shipped, both motivated by dog-fooding the multi-select + PDF flow:

1. **Exclude PDFs from the canonical (first) scope folder.** Originally the indexer walked `**/*.{pptx,pdf}` for every in-scope folder. That meant a PDF could surface as the *canonical* side of a multi-select pair, opening the door to "update a PDF with a PDF" (out of scope) and "update a PDF with a PPTX" (would clobber the PDF). The fix:
   - Per-folder glob in `src/search/indexer.ts` `doFullPass`: `'**/*.pptx'` for `folders[0]`, `'**/*.{pptx,pdf}'` for the rest.
   - New pure `isUnderFirstScopeFolder(scope, fileUri)` in `src/search/scope.ts` (with `test_under_first_*` cases in `test/search-scope.test.ts`).
   - Watcher accept-filter in `indexer.ts`: PDFs under `folders[0]` are dropped before they reach `processUri`, so a freshly-added PDF in the canonical folder never makes it into the engine.

2. **PDF↔PPTX pairs route through the viewer's import pipeline instead of a search-side compare modal.** The original M-PDF-OR design had `handleUpdateFile` type-routing on the canonical filename: PPTX↔PPTX → parse modal; PDF↔PDF → thin compare modal; mixed → refused with toast. With PDFs gone from the canonical folder, the only remaining shape is "canonical PPTX + candidate PDF" — and the right destination for that is the existing PDF→PPTX import modal inside the pptx viewer, not a new compare path. Changes:
   - **Removed** `renderSearchUpdatePdfModalHtml`, `SearchUpdatePdfModalInput`, `PdfFileInfo`, `renderPdfColumn`, and `humanBytes` from `src/search/updateModalHtml.ts`. The PDF↔PDF compare modal is gone.
   - **Removed** `handleUpdateFilePdf` from `src/search/searchPanel.ts` along with its imports (`hashFileAtUri`, `getHashCacheSingleton`, `vscodeFs`).
   - **New** module-scope registries in `src/provider.ts`: `activePanels` (uri → currently-mounted viewer panel) and `pendingPdfImports` (uri → `{fileName, bytes}` stash for cold opens). Populated on `resolveCustomEditor` entry; deregistered on dispose; stash drained at end of the initial render by posting `{type:'uploadedBytes', fileName, bytes}` into the webview.
   - **New** exported entry point `requestPdfImportIntoViewer(targetUri, fileName, bytes)` in `src/provider.ts`. If a viewer is already mounted for `targetUri`, reveal it and post the bytes directly; otherwise stash + `vscode.commands.executeCommand('vscode.open', targetUri, …)` and let the resolve path drain the stash.
   - **New** `handleUpdatePptxFromPdf` in `src/search/searchPanel.ts` that reads PDF bytes via `vscode.workspace.fs.readFile` and calls `requestPdfImportIntoViewer`, then posts `{type:'updateResult', outcome:'pdf-import-routed', targetUri, sourceUri}` back to the panel.
   - **New** `updateResult` outcome `'pdf-import-routed'` handled in the panel's inline script (`src/search/searchPanelHtml.ts`): clears `selectedKeys` + selection mode and reconciles the toolbar. The disabled-state machinery (used by `'updated'` / `'updated-removed'`) is deliberately not applied here — the user's confirmation happens inside the viewer's import modal, not in the search panel.

Net effect: the search-side update flow is now PPTX↔PPTX (compare modal) or PPTX←PDF (viewer hand-off), with the canonical side guaranteed to be a PPTX by the indexer's per-folder glob. The `handleUpdateConfirm` path remains unchanged because PDF→PPTX writes never reach it — they happen later inside the viewer's existing `handleIngest` path with `source='picker'`.

### M-PDF-VIEW — Basic PDF viewer ✅ DONE

Strictly downstream of M-PDF-OR: indexing PDFs surfaced them in search results, and clicking through opened vscode.dev's plain-text editor — which renders binary PDF bytes as garbled noise. A minimal custom editor for `*.pdf` closes that loop.

**Files**

- `src/pdfViewerHtml.ts` (pure) — renderer. Same CSP/nonce pattern as the pptx viewer (`default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-<random>'`). Emits the metadata grid (filename / size / mtime / sha256 / page count) plus a preview placeholder + error states styled to match the pptx panel's chrome. Page count starts as an em-dash and is filled in by the inline script once the parse lands.
- `src/pdfViewer.ts` (vscode-wired) — `CustomReadonlyEditorProvider<PdfDocument>` registered as `pptxViewer.pdfViewer`. `resolveCustomEditor` reads bytes via `vscode.workspace.fs.readFile`, stats for size/mtime, computes sha256 via `sync/hash.sha256Hex`, renders the shell, then waits for the webview's `{type:'pdf-viewer-ready'}` ping before posting `{type:'pdfBytes', bytes}`. The ready-handshake avoids racing the iframe boot — there's no equivalent in the pptx viewer because that one inlines synthesis hints into the HTML rather than streaming bytes after render.

**Webview rendering**

Reuses the existing `__PPTX_PDFIMPORT_WEBVIEW_BUNDLE_PLACEHOLDER__` substitution so the inlined pdfjs-dist bundle is available as `window.__pptxPdfImport`. The inline script:

1. Receives bytes (coerces marshalled Uint8Array variants).
2. Calls `__pptxPdfImport.renderPdfPages(bytes, {pdfjsLib, renderScale: 1.5})` — renders every page; we use `pages[0]` for the preview. No page-range option exists today; the cost of rendering all pages just to throw most away is acceptable for a read-only preview surface.
3. Writes the page count into the metadata row via `[data-row="pages"] dd` (data-attribute selector picked so the renderer can move the row without breaking the script).
4. `canvas.toDataURL('image/png')` → `<img src="data:…">` swap into the placeholder. Canvas is dropped from the DOM after the swap; reasoning matches the pptx viewer's thumbnail handling.

**Wiring**

- `package.json` — registered as a fourth `contributes.customEditors` entry: `viewType: pptxViewer.pdfViewer`, `displayName: "PDF Preview"`, `filenamePattern: "*.pdf"`, `priority: "default"`.
- `src/extension.ts` — `PdfEditorProvider.register()` called immediately after the pptx provider registration; activation log line `activate: custom editor registered for *.pdf`.

**Build-system fix discovered during integration**

The `__PPTX_PDFIMPORT_WEBVIEW_BUNDLE_PLACEHOLDER__` literal now appears in two source modules (`src/webview.ts` for the pptx viewer + `src/pdfViewerHtml.ts` for the pdf viewer). `esbuild.config.js`'s `pdfImportBundlePlugin` substituted only the first quoted-literal occurrence because the regex was non-global — the pdf viewer's `<script>` tag rendered the bare placeholder string as a no-op, and the inline script reported "PDF renderer not available in this build." Fix: add the `g` flag to `PDF_IMPORT_BUNDLE_QUOTED_RE` so every declaration gets substituted. Future modules that declare the same placeholder constant inherit the fix.

**Out of scope for M-PDF-VIEW**

- Page navigation. Preview is page-1-only. The user's stated need ("currently it displays it as text") is met by any rendered page; pager UI can land if there's signal.
- IDB-cached PDF previews. The render runs on every panel open. Acceptable for current volumes; would plug into the same IDB pattern `parseCache` uses if it earns its keep.
- Author / title metadata from the PDF's info dict. PDF.js exposes it via `getMetadata()`; not surfaced today because the panel already shows the four fields the user wanted (filename / size / mtime / sha256 + page count). Easy add later.

**DoD achieved**: typecheck clean; `npm run bundle` clean (2.1MB extension.js after webview inline); existing `test:parse`, `test:viewer-render`, `test:search-scope` suites green; live-verified on `vscode.sophtwhere.com` after the regex fix landed.

### M6 — Polish + sign-off ✅ DONE

- **Status surface — all three states wired.** Empty-state ("No source folders to search…" with `.sync.jsonc` hint) was already in place from M5; in-progress ("Walking source folders…" / "Indexing N of M…") likewise. M6 added the missing **error state**: extended `IndexerProgress` with `errors` + `scopeFolderCount` (always populated by a `Pick<…>` wrapper in `emitProgress` so call sites stay short), forwarded both fields through `searchPanel.ts` into `indexProgress` / `indexComplete` messages, and updated the inline `updateFooter` script to append `· N error(s) (see Output → Pptx Info)` with a hover tooltip pointing at the Output Channel, plus a topology-reactive branch that flips the footer + results pane back to the empty-scope surface if `scopeFolderCount` drops to zero while the panel is open.
- **Removed `pptxSearch.probeIndex` diagnostic.** Command stripped from `package.json`, registration removed from `extension.ts`, `probeSearchIndex` function deleted from `src/search/searchPanel.ts`. The user-facing surface is now `pptxSearch.openPanel` only.
- **CLAUDE.md "What's currently shipping" updated.** New "Presentation Search v1 shipped" bullet covering modules, layered cache, scope rules, multi-select update flow, PDF handling, and PDF custom editor. Plus a "Layered-cache abstraction pattern" substrate note explaining why the M5.3 abstraction layer collapsed into a direct layered lookup, and the per-subsystem-DB convention (`pptxSearch.index` vs `folderSync.hashCache` vs `folderSync.parseCache`).
- **Tests.** Two new cases in `test/search-panel-html.test.ts` cover the error-count surface + the scope-changed-to-zero footer branch. All 26 panel-html cases green; the six other `test:search-*` suites + `test:parse` all green; `tsc --noEmit` clean; `npm run bundle` clean (`dist/extension.js` 554.7 KB, including the inlined pdfImport webview bundle).

DoD achieved.

---

## Pointers into the existing codebase

What you need to read in M1 / M2 to ground the implementation:

- `src/pptx.ts` — the parser. `ParseResult` shape, author extraction, slide-hidden detection. **Check whether first-slide text extraction already exists** before adding it in M2.
- `src/sync/hash.ts` — `hashFileAtUri(fs, uri, cache, opts)`. The `{needBytes:false}` option skips reads on cache hit.
- `src/sync/hashCache.ts`, `src/sync/hashCacheIdb.ts` — two-tier hash cache. Singleton accessed via `getHashCacheSingleton()` (set in `extension.ts` activation).
- `src/sync/idbAdapter.ts` — IDB plumbing. New store goes here; bump DB version in `onupgradeneeded`.
- `src/sync/parseCache.ts`, `src/sync/parseCacheIdb.ts` — **read these in M1**. They may already implement the M5.3 ParseResult cache or be a stub. If full, `getProjectionForSha` derives from them. If stub, do the parse in `projection.ts` directly.
- `src/sync/manager.ts` — `SyncManager`. Source/destination topology, `onDidChange` event, `folderSync.hasAnySource` context-key driver. Need to find or add a "destination folder URIs" getter.
- `src/sync/planView.ts` — reference for webview panel wiring (CSP nonce, message protocol patterns).
- `src/sync/manifestEditor.ts` + `src/sync/manifestEditorHtml.ts` — reference for pure-renderer + wired-provider split with live updates.
- `src/extension.ts` — activation entry; this is where the search subsystem gets wired in alongside sync + viewer.
- `esbuild.config.js` — single-bundle build. No webview entry needed for this feature (search panel is plain HTML/CSS/JS in the panel HTML string, no separate bundle like PDF import).

What you do **not** need to read for search work:

- `src/sync/executor.ts`, `runSync.ts` — execution layer, irrelevant to search.
- `src/sync/restoreFlow.ts`, `snapshot.ts`, `snapshotStore.ts` — M4.6 silent restore.
- `src/pdfImport*.ts` — PDF→PPTX import, separate feature.
- `src/sync/plan.ts`, `planner.ts` — sync planning, irrelevant.
- `src/sync/configEditor*.ts`, `adminEditor*.ts` — config editor surfaces.

If you need wider context (commit conventions, dev workflow, dead ends to avoid), `CLAUDE.md` at the repo root is the canonical substrate.

---

## Dead ends to avoid

- **Don't use a third-party search library.** No fuse.js, no minisearch, no flexsearch. The hand-rolled tokenize + scan is <50 LOC and the scale (3000 files max) doesn't justify the dependency. The "no frameworks unless they earn their keep" rule applies.
- **Don't build an inverted index in v1.** Linear scan over 3000 entries is sub-millisecond. Inverted indices add invalidation complexity and don't pay back until ~100k+ entries.
- **Don't add Levenshtein in v1.** Prefix + substring on tokens handles the stated use cases. If typo-tolerance is genuinely needed later, layer it in for terms ≥4 chars; don't apply to short terms (false-positive heavy).
- **Don't index destinations.** They're the *output* of sync, not what users search for. Filtering happens at the source-folder selection step, not in the search engine.
- **Don't store thumbnail bytes in the projection.** Bloats IDB writes. If v2 wants thumbnails in results, fetch lazily on render (and cache separately or wait for M5.3).
- **Don't share the parse path with the viewer in a way that pulls ParseResult into search.** Search needs a *projection*; the viewer needs the full ParseResult. They can both call the same `parsePptxCached` underneath, but search must not become "open the full ParseResult cache and read three fields" — that defeats the small-projection design.
- **Watch out for the atomic write / open-editor gotcha.** Per substrate, atomic tmp+rename writes close any custom editor open on the target. The search index file (if you ever decide to persist it as a workspace file instead of IDB-only) would need the same TextDocument-routing pattern that `snapshotStore.ts` uses. **Current design avoids this entirely** by keeping the index in IDB.
- **Don't activate on `**/*.pptx` file events alone.** The extension already activates `onStartupFinished`. Search uses the existing activation; no new activation events needed.

---

## Open questions to resolve before / during M1

1. **Does `src/pptx.ts` already extract first-visible-slide text?** ✅ *Resolved during M1: no, only the title placeholder via `extractFirstSlideTitle`. M2 added `extractAllSlideText` + `ParseResult.firstVisibleSlideText` as a new required field.*
2. **Does `parseCache.ts` already implement M5.3?** ✅ *Resolved during M1: yes — full ParseResult cache shipped (in-memory LRU + IDB write-through + Phase D identity index). For M4, `getProjectionForSha` should derive projections via `parsePptxCached` (the cache-aware parser) and `projectFromCached` / `projectFromParseResult` rather than re-implementing a separate parse path.*
3. **Does `SyncManager` expose a "destination folder URIs" getter?** ✅ *Resolved during M4: no dedicated getter; the indexer derives the destination URI set by walking `manager.topology.sources[].destinations[].workspaceFolderUri` and subscribing to `manager.onDidChange` for topology updates. `computeSearchScope` in `src/search/scope.ts` takes the resulting `destinationWorkspaceFolderUris` array and subtracts it from `workspaceFolderUris`.*
4. **What IDB DB name + current version?** ✅ *Resolved during M3: separate DB `pptxSearch.index` v1 with store `projections`. Did not coexist with `folderSync.parseCache` (which is now at v6 after the M2 `firstVisibleSlideText` field landed) for the reasons in M3 above.*

---

## Definition of Done for v1

1. ✅ Command `pptxSearch.openPanel` opens a webview panel.
2. ✅ Indexing source folders works on cold start (no IDB cache); subsequent opens hydrate from IDB.
3. ✅ Search is case-insensitive, diacritic-folded, AND across query terms (with optional OR-across-terms toggle), OR across fields.
4. ✅ Results show filename + author and are clickable to open the pptx in the viewer.
5. ✅ Watcher keeps the index live as files are added / modified / deleted in source folders.
6. ✅ Destination folders are excluded from the indexed scope.
7. ✅ All pure modules have tsx-runnable tests under `test/search-*.test.ts`.
8. ✅ No CSP violations in DevTools when the panel is open.
9. ✅ Substrate (`CLAUDE.md`) updated with the search feature.
10. ✅ Sign-off commit pushed. (Pre-release republish at the user's discretion.)

---

## Next-session hook — multi-result actions ✅ SHIPPED

This section originally captured an open hook: the user wanted to extend the panel with affordances around using multiple search results together before signing off v1. That work landed across M-MULTI (shift-click multi-select + side-by-side compare modal + update / update-and-remove flow + hash-pairing badge) and M-PDF-OR (filename indexing for PDFs so the multi-select flow covers both file types the user actually works with, plus the OR-mode toggle for fishing out a known filename fragment).

The hooks identified in the original write-up landed as follows:

- "Select N decks, then act on them" → shift-click selection model + 2-of-2 primed pair (one in canonical group, one elsewhere) + Update file / Update & remove source actions.
- "Cross-folder compare" → side-by-side compare modal sharing CSS with the viewer's drop-update modal.
- "Selection survives navigation" → `retainContextWhenHidden: true` plus disabled-state persistence for the lifetime of the result set.
- "Selection model per-hit vs per-uri" → resolved as per-uri (the fan-out flow already gives each URI its own row).

M6 sign-off (DoD bullets 9 + 10) closed out v1.
