# pptx-search-v1-plan

Search across `.pptx` files in workspace source folders by filename, author, and first-visible-slide text. New webview panel. IDB-backed projection index for performance.

---

## Status

**M1+M2+M3 complete (local commits, unpushed). Next: M4.**

Progress:

- **M1** — pure projection + tokenizer + scorer. Shipped in commit `673ec79` (local). Files: `src/search/{fold,tokenize,score,projection,index-types}.ts`. Tests: `test/search-{fold,tokenize,score,projection}.test.ts` — all pass via `npm run test:search-*`.
- **M2** — parser extension for first-visible-slide text. Shipped in the same commit `673ec79`. `extractAllSlideText` added to `src/pptx.ts`; `ParseResult.firstVisibleSlideText: string` is now a required field (defaults to '' for old IDB cache hydration via `parseCacheIdb` v5→v6 bump). Tests: `test/pptx-first-visible-slide-text.test.ts`.
- **M3** — IDB store + in-memory engine. Shipped in commit `1517e41` (local). Files: `src/search/{indexStore,searchEngine}.ts`. The IDB store wraps a dedicated `pptxSearch.index` DB with a `projections` store (separate from the hash + parse cache DBs — independent lifecycle). The engine holds three coordinated maps (`sha→projection`, `uri→sha`, `sha→Set<uri>`) and exposes `load / addOrUpdate / removeUri / search / stats`. `getAll()` was added to the `IdbStore` interface in `src/sync/idbAdapter.ts` (with fake-store updates in the affected hash + parse cache tests). DoD scenarios — dedup-by-sha, removal cascade, ranking sanity — all covered by `test/search-engine.test.ts` (17 cases, all green).

Both commits are local-only; push timing is up to the user.

**Next session: implement M4** (wired indexer + activation). See the milestone below. Open question 3 from this plan ("does `SyncManager` expose a destination-folder-URIs getter?") needs answering at the start of M4.

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

1. **Does `src/pptx.ts` already extract first-visible-slide text?** ✅ *Resolved during M1: no, only the title placeholder via `extractFirstSlideTitle`. M2 added `extractAllSlideText` + `ParseResult.firstVisibleSlideText` as a new required field.*
2. **Does `parseCache.ts` already implement M5.3?** ✅ *Resolved during M1: yes — full ParseResult cache shipped (in-memory LRU + IDB write-through + Phase D identity index). For M4, `getProjectionForSha` should derive projections via `parsePptxCached` (the cache-aware parser) and `projectFromCached` / `projectFromParseResult` rather than re-implementing a separate parse path.*
3. **Does `SyncManager` expose a "destination folder URIs" getter?** *Still open — answer at the start of M4 by reading `src/sync/manager.ts`. If not present, derive from topology + `onDidChange` for now.*
4. **What IDB DB name + current version?** ✅ *Resolved during M3: separate DB `pptxSearch.index` v1 with store `projections`. Did not coexist with `folderSync.parseCache` (which is now at v6 after the M2 `firstVisibleSlideText` field landed) for the reasons in M3 above.*

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
