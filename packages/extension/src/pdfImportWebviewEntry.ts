/// <reference lib="dom" />
// Webview-side entry for PDF import.
//
// This file is bundled by esbuild as a SEPARATE IIFE bundle (see
// esbuild.config.js → buildOptionsWebview). The output is then text-inlined
// into dist/extension.js by the main extension build's placeholder-rewrite
// plugin. At runtime, the viewer HTML serves this bundle inline inside a
// nonced <script> tag, so:
//
//   - pdfjs-dist runs in the webview iframe's DOM context (where it works)
//   - no extra files need to be fetched at runtime (vscode.dev webviews
//     can't reliably load extension-owned assets without widening the CSP)
//   - the eager bundle cost lands only when the viewer panel is open
//
// We use PDF.js's fake-worker fallback (workerSrc unset) — slower than a
// real worker, but it sidesteps having to plumb a vscode-resource: URL for
// pdf.worker.mjs through the webview's CSP. The plan accepts the trade.
//
// The bundle exposes one global so the viewer script can call into it:
//
//   window.__pptxPdfImport = { ...api }
//
// Everything else is internal to this entry.

import * as pdfjsLib from 'pdfjs-dist';
// Side-effect import: pdfjs-dist v5's pdf.worker.mjs top-level code assigns
// `globalThis.pdfjsWorker = { WorkerMessageHandler }`. PDFWorker checks for
// that before trying to load `GlobalWorkerOptions.workerSrc`, so with the
// handler present in main-thread globals the library uses its fake-worker
// path without ever fetching a worker URL — which is what we need inside
// vscode.dev's webview sandbox (no asset URLs reachable for worker fetch).
//
// In pdfjs v5, the old `disableWorker: true` getDocument option is no longer
// honoured (the constructor accepts only `name`/`port`/`verbosity`), so this
// side-effect import is now the *only* way to get fake-worker mode.
//
// Cost: bundles the worker module's code (~1.2MB minified) into this IIFE.
// Acceptable because the IIFE is text-inlined into the extension bundle and
// only ever evaluated when the pptx viewer panel is open.
import 'pdfjs-dist/build/pdf.worker.min.mjs';

import {
  renderPdfPages,
  encodeCanvasesToBlobs,
  buildPptxFromImages,
  EMU_PER_POINT,
  EMU_PER_INCH,
  SLIDE_SIZE_16x9_EMU,
  SLIDE_SIZE_4x3_EMU,
  type PdfjsLib,
  type EncodedImage,
  type PageEmuPlacement,
  type RenderedPage,
  type BuildOptions,
} from 'pptx-tools-core/pdfImport';

import {
  computePageLayout,
  targetPxWFor,
  estimateCanvasBytes,
  type PageLayout,
  type LayoutOptions,
} from 'pptx-tools-core/pdfImportLayout';

import {
  renderPdfImportConfigHtml,
  pdfImportConfigCss,
  DEFAULT_PDF_IMPORT_CONFIG,
  RESOLUTION_PRESETS,
  type PdfImportConfig,
  type ConfigRenderOptions,
} from 'pptx-tools-core/pdfImportConfigHtml';

// Belt-and-braces: pdfjs's static initialiser only sets workerSrc on Node, but
// some setup paths still read GlobalWorkerOptions.workerSrc. We assign an
// empty string up-front so any access doesn't throw a "not specified" error
// before the main-thread WorkerMessageHandler fast-path is reached.
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pdfjsLib as any).GlobalWorkerOptions.workerSrc = '';
} catch {
  // Older pdfjs builds don't expose GlobalWorkerOptions — ignore.
}

/**
 * Wraps `renderPdfPages` to keep the v4-era `disableWorker: true` flag on
 * each getDocument call. In pdfjs v5 the flag is silently ignored (the
 * constructor only honours `name`/`port`/`verbosity`), but we leave it for
 * any future downgrade. The actual fake-worker switch comes from the
 * `pdf.worker.min.mjs` side-effect import above.
 */
async function renderPdfPagesWrapped(
  file: Blob | ArrayBuffer | Uint8Array,
  opts: Parameters<typeof renderPdfPages>[1],
): ReturnType<typeof renderPdfPages> {
  const baseLib = opts.pdfjsLib;
  const shimmed: PdfjsLib = {
    getDocument(arg) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (baseLib as any).getDocument({ ...arg, disableWorker: true });
    },
  };
  return renderPdfPages(file, { ...opts, pdfjsLib: shimmed });
}

// The single global the viewer script reaches into.
const api = {
  // PDF.js library (used by callers to construct getDocument args).
  pdfjsLib,

  // Pipeline phases.
  renderPdfPages: renderPdfPagesWrapped,
  encodeCanvasesToBlobs,
  buildPptxFromImages,

  // Layout helpers.
  computePageLayout,
  targetPxWFor,
  estimateCanvasBytes,

  // Config-modal renderer (the viewer script injects this HTML into the
  // modal host when the user drops a PDF).
  renderPdfImportConfigHtml,
  pdfImportConfigCss,
  DEFAULT_PDF_IMPORT_CONFIG,
  RESOLUTION_PRESETS,

  // Constants used by the viewer when constructing build options.
  EMU_PER_POINT,
  EMU_PER_INCH,
  SLIDE_SIZE_16x9_EMU,
  SLIDE_SIZE_4x3_EMU,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__pptxPdfImport = api;

// Re-export types so editor tooling can resolve them through this module if
// useful — not load-bearing for the bundle.
export type {
  PdfImportConfig,
  ConfigRenderOptions,
  RenderedPage,
  EncodedImage,
  PageEmuPlacement,
  BuildOptions,
  PageLayout,
  LayoutOptions,
  PdfjsLib,
};

export type PptxPdfImportApi = typeof api;
