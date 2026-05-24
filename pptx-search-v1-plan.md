# pptx-search-v1-plan

Search across `.pptx` files in workspace source folders by filename, author, and first-visible-slide text. New webview panel. IDB-backed projection index for performance.

---

## Status

**Not started.** Plan signed off 2026-05-24. Next: implement M1.

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

### M1 — Pure projection + tokenizer + scorer

Land the deterministic core with tests. No vscode, no IDB.

- `src/search/fold.ts` — NFD normalize + lowercase + strip combining marks.
- `src/search/tokenize.ts` — split on whitespace/punct/hyphens/camelCase/snake_case, drop empties, dedupe per field.
- `src/search/projection.ts` — given a `ParseResult` (from `src/pptx.ts`) and a filename, produce a `SearchProjection`. Extracts first-visible-slide text from the parser output. **May require extending the parser** to expose per-slide text — see "Parser extension" below.
- `src/search/score.ts` — query tokens × projection → `{score, matchedFields}`. AND across query terms, OR across fields. Prefix > substring. Shorter token > longer. Filename/author > slideText.
- Tests for each module.

DoD: `npm run test:search-fold test:search-tokenize test:search-projection test:search-score` all pass; coverage includes the camelCase + diacritic + AND/OR + ranking cases.

### M2 — Parser extension (if needed)

Check `src/pptx.ts`. The author field is already extracted (per substrate). First-slide visible text probably isn't — the existing test `pptx-title-extract.test.ts` suggests there's *some* slide-text extraction. If extraction of slide-1 text doesn't exist, add it as a *new* field on `ParseResult` (don't change existing fields — viewer + sync depend on them).

Naming: `firstVisibleSlideText: string` on `ParseResult`. Empty string if no visible slides or no text shapes.

DoD: `npm run test:parse` still passes; new test cases for first-visible-slide extraction (hidden first slide → second is used; image-only first slide → empty string; text inside groups + tables → included).

### M3 — IDB store + engine

- `src/search/indexStore.ts` — open `pptxSearchIndex` store via existing `idbAdapter.ts`. CRUD: `getBySha`, `putProjection`, `deleteBySha`, `getAll`. Bump IDB version, handle `onupgradeneeded`.
- `src/search/searchEngine.ts` — in-memory `Map<sha256, SearchProjection>` + `Map<uriString, sha256>` reverse index. `load(projections)`, `addOrUpdate(uri, projection)`, `removeUri(uri)`, `search(query) → SearchHit[]`.
- Tests for the engine logic (the IDB layer is harder to unit-test cleanly; a probe command can verify behavior in vscode.dev — see M-search probe in M5).

DoD: engine handles dedup-by-sha (same projection at two URIs → one hit with both URIs), removal cascade (last URI removed → projection dropped), and basic ranking sanity.

### M4 — Wired indexer + activation

- `src/search/indexer.ts` — walk source folders, glob pptx, use hashFileAtUri + getProjectionForSha to build entries, populate engine. Progress events for the panel.
- Wire into `extension.ts` activation: open IDB store, load existing projections into engine, register FileSystemWatcher.
- `getProjectionForSha(sha256, uri)` abstraction:
  ```ts
  // miss path today: parse bytes, project, write to indexStore
  // miss path future: read from parseCache (M5.3), project, return
  ```
- Source-folder filter: pull from `SyncManager`. Need to confirm the manager exposes a "destination folder URIs" set; if not, derive from `topology` + `manager.onDidChange`. Update on topology change.

DoD: opening the panel triggers a full walk; indexing 500 files completes in reasonable time (target: <5s warm, <30s cold-on-IDB-miss). Watcher updates surface within ~1s of a file change.

### M5 — Webview panel UI

- `src/search/searchPanelHtml.ts` — render the panel HTML (CSP with nonce per substrate convention). Input box at the top, results list below, footer showing "N of M presentations indexed".
- `src/search/searchPanel.ts` — `WebviewPanel` registration. Message protocol:
  - panel → ext: `{type:'search', query}`, `{type:'open', uri}`, `{type:'reindex'}`
  - ext → panel: `{type:'results', hits}`, `{type:'indexProgress', done, total}`, `{type:'indexComplete'}`
- Command: `pptxSearch.openPanel` ("Presentation Search: Open").
- Diagnostic command: `pptxSearch.probeIndex` (logs index size, store size, sample entries to output channel — for M5 sign-off, removed at M6 polish).

DoD: type-as-you-search debounce works, results clickable to open files, index progress visible during cold population, no CSP violations in DevTools.

### M6 — Polish + sign-off

- Status surface: empty-state message ("No source folders to search — add a workspace folder or check your `.sync.jsonc` setup"), error state, in-progress state.
- Remove `pptxSearch.probeIndex` diagnostic command.
- Update `CLAUDE.md` "What's currently shipping" section with the search feature.
- Substrate update: note the abstraction-layer pattern for the eventual M5.3 swap.
- Commit signoff message.

DoD: feature works end-to-end on vscode.sophtwhere.com; no console errors; substrate updated.

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

1. **Does `src/pptx.ts` already extract first-visible-slide text?** Check `pptx-title-extract.test.ts` and the `ParseResult` shape. Influences M2 scope.
2. **Does `parseCache.ts` already implement M5.3?** If yes, `getProjectionForSha` derives from it; if no, projection.ts parses directly. Determines M3 wiring.
3. **Does `SyncManager` expose a "destination folder URIs" getter?** If not, derive from topology in M4 and consider adding a typed getter as a small bonus.
4. **What IDB DB name + current version?** Look in `src/sync/idbAdapter.ts` — search needs to be added as a new object store at the next version bump.

---

## Definition of Done for v1

1. Command `pptxSearch.openPanel` opens a webview panel.
2. Indexing source folders works on cold start (no IDB cache); subsequent opens hydrate from IDB.
3. Search is case-insensitive, diacritic-folded, AND across query terms, OR across fields.
4. Results show filename + author and are clickable to open the pptx in the viewer.
5. Watcher keeps the index live as files are added / modified / deleted in source folders.
6. Destination folders are excluded from the indexed scope.
7. All pure modules have tsx-runnable tests under `test/search-*.test.ts`.
8. No CSP violations in DevTools when the panel is open.
9. Substrate (`CLAUDE.md`) updated with the search feature.
10. Sign-off commit pushed; pre-release republished if user agrees.
