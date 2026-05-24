# Presentation Search v1 — Context Report

Condensed handoff for an agent picking up the main project plan
(`folder-sync-v1-plan.md`) without needing to read the full
`pptx-search-v1-plan.md`.

## What it is
Workspace-wide search panel for `.pptx` (and `.pdf` by filename). Command palette → **Presentation Search: Open** (`pptxSearch.openPanel`). Singleton webview; debounced as-you-type; matches filename / `dc:creator` author / first-visible-slide text; AND across terms by default with an "Any term (OR)" checkbox. Results group by workspace folder, dedupe by sha256 with fan-out into each containing folder, and surface a colour-coded hash-pairing badge when the same content lives in multiple places.

## Where it lives
- **Pure modules** (`src/search/`, all tsx-tested): `fold.ts`, `tokenize.ts`, `score.ts`, `projection.ts`, `index-types.ts`, `scope.ts`, `searchEngine.ts`, `searchPanelHtml.ts`, `updateModalHtml.ts`.
- **Wired modules**: `indexer.ts` (workspace walk + FileSystemWatcher + topology subscription), `indexStore.ts` (dedicated `pptxSearch.index` IDB DB v1, keyed by sha256), `searchPanel.ts` (singleton webview + message dispatch).
- **Tests**: `test/search-*.test.ts` per module, plus `test/pptx-first-visible-slide-text.test.ts` for the parser extension.

## Integration points
- **Parse cache** (`src/sync/parseCache.ts`): layered lookup `indexStore.getBySha → parseCache.lookup → fresh parsePptxCached`. Search added `firstVisibleSlideText` as a required ParseResult field (parse cache schema bumped 5→6).
- **Hash cache** (`src/sync/hashCache.ts`): `hashFileAtUri` with `needBytes:false` for cheap walks.
- **SyncManager topology**: scope = workspace folders minus any folder that's a destination in any active `.sync.jsonc`. Search subscribes to `manager.onDidChange` and re-walks on topology changes.
- **PDF viewer** (`src/pdfViewer.ts`, `src/pdfViewerHtml.ts`): registered for `*.pdf` with `priority: "default"` so click-through from search doesn't dump raw bytes.
- **PDF→PPTX update flow**: search panel hands PDF sources off to the viewer's existing import modal via `requestPdfImportIntoViewer` (exported from `src/provider.ts`) — search never writes PDF bytes itself.

## Scope rules (load-bearing)
- Destinations excluded from indexing entirely.
- First scope folder (canonical) is PPTX-only — PDFs in `folders[0]` skipped at both walk and watcher level. Guarantees the multi-select update target is always a PPTX.
- Other folders index both `.pptx` and `.pdf`.

## Out of scope (don't relitigate)
Levenshtein typo-tolerance · QuickPick / sidebar tree surfaces · indexing destinations · speaker notes, master content, slides past the first visible one · thumbnails in results · third-party search libs (fuse.js / minisearch) · inverted index (linear scan over ~3000 files is sub-millisecond) · PDF text/metadata extraction (no DOM in the extension host).

## Status
v1 shipped at `d81ef08`. All 10 DoD bullets met. Live on `vscode.sophtwhere.com`. Marketplace pre-release not yet republished.

Full plan: `pptx-search-v1-plan.md`. Substrate bullet: CLAUDE.md "What's currently shipping" → "Presentation Search v1 shipped".
