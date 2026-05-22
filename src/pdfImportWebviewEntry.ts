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
} from './pdfImport';

import {
  computePageLayout,
  targetPxWFor,
  estimateCanvasBytes,
  type PageLayout,
  type LayoutOptions,
} from './pdfImportLayout';

import {
  renderPdfImportConfigHtml,
  pdfImportConfigCss,
  DEFAULT_PDF_IMPORT_CONFIG,
  RESOLUTION_PRESETS,
  type PdfImportConfig,
  type ConfigRenderOptions,
} from './pdfImportConfigHtml';

// PDF.js v5 wants `workerSrc` to be set. Setting it to an empty string puts
// the library into its "fake worker" path which runs everything on the main
// thread inline. We also pass `disableWorker: true` to each getDocument call
// (in `renderPdfPagesWrapped` below) belt-and-braces. The cost is single-
// threaded PDF parsing, which is fine for the deck sizes we expect.
//
// We assign the empty string rather than leave it unset because some pdfjs
// builds throw a warning on "Setting up fake worker" without it.
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pdfjsLib as any).GlobalWorkerOptions.workerSrc = '';
} catch {
  // Older pdfjs builds don't expose GlobalWorkerOptions — ignore.
}

/**
 * Wraps `renderPdfPages` to always pass `disableWorker: true`. The base
 * function in pdfImport.ts doesn't know about pdf.js worker semantics
 * (it stays generic), so we inject the flag at the boundary.
 */
async function renderPdfPagesWrapped(
  file: Blob | ArrayBuffer | Uint8Array,
  opts: Parameters<typeof renderPdfPages>[1],
): ReturnType<typeof renderPdfPages> {
  // Shim the lib so `getDocument` always carries disableWorker:true.
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
