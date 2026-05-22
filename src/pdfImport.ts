/// <reference lib="dom" />
// PDF → PPTX conversion pipeline.
//
// Ported from pdf2pptx/pdfToPptx.js and split into three phases so the webview
// can cache between them:
//
//   1. renderPdfPages       — turn PDF bytes into per-page canvases at a derived
//                              pixel scale. Browser-only: needs PDF.js + DOM.
//   2. encodeCanvasesToBlobs — encode canvases to PNG/JPEG bytes. Browser-only:
//                              needs HTMLCanvasElement.toBlob.
//   3. buildPptxFromImages   — package already-encoded images into a .pptx zip.
//                              Pure (no DOM): runnable under Node + tsx for tests.
//
// The split lets the live-preview re-encode loop re-run only (2) when the user
// changes format/quality, and re-run (1)+(2)+(3) only when they change
// resolution/aspect. The pure phase 3 is what the test/pdf-import.test.ts
// exercises directly with synthetic image bytes.
//
// See also src/pdfImportLayout.ts for the pure letterbox/scale math that
// callers use to derive each page's `imagePxW`, `imagePxH`, `renderScale`,
// and EMU offsets before invoking the pipeline.

import { zip, strToU8, type AsyncZippable, type AsyncZipOptions } from 'fflate';

// 1 PostScript point = 12700 EMU (English Metric Units, OOXML's internal unit).
// EMU_PER_INCH = 914400; PDF points are 72/inch, so 914400/72 = 12700.
export const EMU_PER_POINT = 12700;
export const EMU_PER_INCH = 914400;

// PowerPoint's stock slide sizes in EMU. 16:9 is the widescreen default since
// Office 2013; 4:3 is the legacy standard.
export const SLIDE_SIZE_16x9_EMU = { cx: 12192000, cy: 6858000 } as const; // 13.333" × 7.5"
export const SLIDE_SIZE_4x3_EMU = { cx: 9144000, cy: 6858000 } as const; //  10"     × 7.5"

// Promisified fflate.zip — runs in a Worker by default so the UI thread stays
// responsive on big decks.
function zipAsync(files: AsyncZippable, opts: AsyncZipOptions = {}): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, opts, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// Coerce ArrayBuffer / Uint8Array / typed-array view → Uint8Array (fflate's
// required input). Mirrors the helper in the original pdfToPptx.js.
function toU8(x: ArrayBuffer | ArrayBufferView | Uint8Array): Uint8Array {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError('Image must be ArrayBuffer or Uint8Array');
}

// ──────────────────────────────────────────────────────────────────────────
// Types — kept minimal so the module stays test-friendly. PDF.js is shaped via
// `unknown` at the boundary and the caller passes its imported `pdfjsLib`.
// ──────────────────────────────────────────────────────────────────────────

export interface RenderedPage {
  /**
   * The rendered canvas. Kept as the live HTMLCanvasElement so the encode
   * phase can read pixels directly — avoids double-allocating a copy.
   *
   * Typed loosely so the test runner (Node + tsx) doesn't pull a DOM lib;
   * the encode phase narrows via `instanceof HTMLCanvasElement` at runtime.
   */
  canvas: unknown;
  /** PDF page's natural width in points (1pt = 1/72"). */
  widthPt: number;
  /** PDF page's natural height in points. */
  heightPt: number;
  /** Pixel width of the rendered canvas (== ceil(widthPt × renderScale)). */
  widthPx: number;
  /** Pixel height of the rendered canvas. */
  heightPx: number;
}

export interface EncodedImage {
  bytes: Uint8Array;
  sizeBytes: number;
  widthPx: number;
  heightPx: number;
  /** PDF page natural size carried through for the EMU math in phase 3. */
  widthPt: number;
  heightPt: number;
}

export interface BuildOptions {
  /** Image extension used in the OOXML package. Matches the encoder choice. */
  format: 'png' | 'jpeg';
  /** Fixed slide size for the whole deck (EMU). Chosen by the user (16:9/4:3). */
  slideSizeEmu: { cx: number; cy: number };
  /** When true, each picture is centred within the slide; the background
   *  shows through as letterbox bars. When false, the picture stretches to
   *  fill the slide. The page-layout helper drives this decision per page. */
  letterbox: boolean;
}

export type ProgressFn = (p: { current: number; total: number }) => void;

/**
 * Minimal structural shape we use from `pdfjs-dist`. We keep this loose so the
 * module compiles without the dep being declared as a typed import (it's
 * dynamically imported at the call site in the webview).
 */
export interface PdfjsLib {
  getDocument(arg: { data: ArrayBuffer | Uint8Array }): {
    promise: Promise<PdfjsDocument>;
  };
}

export interface PdfjsDocument {
  readonly numPages: number;
  getPage(n: number): Promise<PdfjsPage>;
}

export interface PdfjsPage {
  getViewport(arg: { scale: number }): { width: number; height: number };
  render(arg: { canvasContext: unknown; viewport: { width: number; height: number } }): {
    promise: Promise<void>;
  };
  cleanup?(): void;
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 1 — render PDF → canvases
// ──────────────────────────────────────────────────────────────────────────

/**
 * Render each PDF page to a canvas at the requested pixel scale. `renderScale`
 * may be a single number (applied to every page) or an array of per-page scales
 * (the derived-layout model passes per-page so portrait pages render at a
 * different scale to landscape).
 *
 * Browser-only: requires `document.createElement('canvas')`. The Node test
 * suite does not exercise this phase.
 */
export async function renderPdfPages(
  file: File | Blob | ArrayBuffer | Uint8Array,
  opts: {
    pdfjsLib: PdfjsLib;
    /** Either a single scale or one per page (1-indexed; we use [i-1]). */
    renderScale: number | number[];
    /** Letterbox bar / canvas-background color. Defaults to white (PowerPoint
     *  default slide bg). Only used when format=='jpeg' or when stretch mode
     *  pads the canvas — see encodeCanvasesToBlobs. Passed through so callers
     *  can experiment with black bars later. */
    backgroundColor?: string;
    onProgress?: ProgressFn;
  },
): Promise<RenderedPage[]> {
  const { pdfjsLib, renderScale, backgroundColor = '#FFFFFF', onProgress } = opts;
  if (!pdfjsLib) throw new Error('Pass pdfjsLib (import * as pdfjsLib from "pdfjs-dist")');

  const data = await toArrayBuffer(file);
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const numPages = pdf.numPages;
  const pages: RenderedPage[] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const natural = page.getViewport({ scale: 1 });
    const scale = Array.isArray(renderScale) ? renderScale[i - 1] : renderScale;
    if (!(scale > 0)) throw new Error(`Invalid renderScale for page ${i}: ${String(scale)}`);
    const render = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(render.width);
    canvas.height = Math.ceil(render.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D canvas context');

    // Always pre-fill — JPEG has no alpha (transparent pixels become black)
    // and PNG is harmless. Same default as the original tool.
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport: render }).promise;

    pages.push({
      canvas,
      widthPt: natural.width,
      heightPt: natural.height,
      widthPx: canvas.width,
      heightPx: canvas.height,
    });

    page.cleanup?.();
    onProgress?.({ current: i, total: numPages });
  }

  return pages;
}

async function toArrayBuffer(file: File | Blob | ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  if (file instanceof ArrayBuffer) return file;
  if (file instanceof Uint8Array) {
    // Copy into a standalone ArrayBuffer because PDF.js may retain the slice.
    const out = new ArrayBuffer(file.byteLength);
    new Uint8Array(out).set(file);
    return out;
  }
  // File | Blob
  return await (file as Blob).arrayBuffer();
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 2 — encode canvases to PNG/JPEG bytes
// ──────────────────────────────────────────────────────────────────────────

/**
 * Re-encode every canvas at the chosen format/quality. Cheap relative to PDF
 * render — flipping the radio from PNG to JPEG in the config panel can re-run
 * just this phase against the cached canvases from phase 1.
 *
 * Browser-only: needs HTMLCanvasElement.toBlob.
 */
export async function encodeCanvasesToBlobs(
  pages: RenderedPage[],
  opts: {
    format: 'png' | 'jpeg';
    /** 0..1 — only meaningful for JPEG. Default matches the plan's spec. */
    quality?: number;
    onProgress?: ProgressFn;
  },
): Promise<EncodedImage[]> {
  const { format, quality = 0.85, onProgress } = opts;
  if (format !== 'png' && format !== 'jpeg') {
    throw new Error(`Unsupported format: ${format} (use 'png' or 'jpeg')`);
  }
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const out: EncodedImage[] = [];
  const total = pages.length;

  for (let i = 0; i < total; i++) {
    const page = pages[i];
    const canvas = page.canvas as HTMLCanvasElement;
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, mime, format === 'jpeg' ? quality : undefined);
    });
    if (!blob) throw new Error(`canvas.toBlob returned null for page ${i + 1}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    out.push({
      bytes,
      sizeBytes: bytes.byteLength,
      widthPx: canvas.width,
      heightPx: canvas.height,
      widthPt: page.widthPt,
      heightPt: page.heightPt,
    });
    onProgress?.({ current: i + 1, total });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 3 — pack encoded images into a .pptx zip (pure; no DOM)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Per-page geometry within the fixed slide. Computed by the layout helper from
 * (slideAspect, targetPxW, pageAspectR); see src/pdfImportLayout.ts.
 *
 * The build phase needs the slide-relative EMU rectangle for each picture so
 * portrait pages get centred with white letterbox bars rather than stretched.
 */
export interface PageEmuPlacement {
  /** EMU rectangle origin within the slide. */
  offsetEmuX: number;
  offsetEmuY: number;
  /** EMU rectangle size within the slide. */
  imageEmuW: number;
  imageEmuH: number;
}

/**
 * Pure packager — takes already-encoded images plus their per-page EMU
 * placement and returns raw .pptx bytes. No DOM, no PDF.js — runnable under
 * Node + tsx for testing.
 *
 * When `letterbox` is true (default usage), every page's `placement` should
 * reflect the centred rectangle within the slide. When `letterbox` is false
 * (stretch), every placement should be `{0, 0, slideSizeEmu.cx, slideSizeEmu.cy}`.
 */
export async function buildPptxFromImages(
  pages: Array<EncodedImage & { placement: PageEmuPlacement }>,
  opts: BuildOptions,
): Promise<Uint8Array> {
  const { format, slideSizeEmu } = opts;
  if (!pages?.length) throw new Error('No pages provided');
  if (format !== 'png' && format !== 'jpeg') {
    throw new Error(`Unsupported format: ${format} (use 'png' or 'jpeg')`);
  }
  const n = pages.length;
  const ext = format;
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const { cx, cy } = slideSizeEmu;

  // fflate accepts either a Uint8Array (default compression) or a tuple
  // [Uint8Array, {level: 0..9}] for per-file overrides. PNG/JPEG payloads are
  // already compressed, so we store them at level 0 to save 5-15% CPU for ~0%
  // size gain. XML compresses well at default level 6.
  // The first slide's image doubles as the package thumbnail. We re-use the
  // same encoded bytes (a deliberate ~one-slide-image-sized addition to the
  // zip) rather than encoding a downsampled variant — keeps the build path
  // simple and the viewer's docProps/thumbnail.<ext> extractor renders the
  // result regardless of dimensions. Only the constructed-here pptx ever gets
  // its thumbnail written this way; other files in the workspace are never
  // mutated (see plan §M-VE-3).
  const files: AsyncZippable = {
    '[Content_Types].xml': strToU8(contentTypesXml(n, ext, mime)),
    '_rels/.rels': strToU8(topRelsXml(ext)),
    'ppt/presentation.xml': strToU8(presentationXml(n, cx, cy)),
    'ppt/_rels/presentation.xml.rels': strToU8(presentationRelsXml(n)),
    'ppt/theme/theme1.xml': strToU8(themeXml()),
    'ppt/slideMasters/slideMaster1.xml': strToU8(slideMasterXml()),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': strToU8(slideMasterRelsXml()),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(slideLayoutXml()),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(slideLayoutRelsXml()),
    [`docProps/thumbnail.${ext}`]: [toU8(pages[0].bytes), { level: 0 as const }],
  };

  for (let i = 0; i < n; i++) {
    const idx = i + 1;
    const p = pages[i];
    files[`ppt/media/image${idx}.${ext}`] = [toU8(p.bytes), { level: 0 as const }];
    files[`ppt/slides/slide${idx}.xml`] = strToU8(slideXml(p.placement));
    files[`ppt/slides/_rels/slide${idx}.xml.rels`] = strToU8(slideRelsXml(idx, ext));
  }

  return await zipAsync(files, { level: 6 });
}

// ──────────────────────────────────────────────────────────────────────────
// XML templates — minimal but valid OOXML. Mirrors pdf2pptx/pdfToPptx.js with
// the only behavioural change being per-slide picture placement (offset/ext)
// in place of the original "stretch the picture to fill the slide" assumption.
// ──────────────────────────────────────────────────────────────────────────

function contentTypesXml(n: number, ext: string, mime: string): string {
  const slides = Array.from({ length: n }, (_, i) =>
    `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="${ext}" ContentType="${mime}"/>
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slides}
</Types>`;
}

function topRelsXml(thumbnailExt: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.${thumbnailExt}"/>
</Relationships>`;
}

function presentationXml(n: number, cx: number, cy: number): string {
  const ids = Array.from({ length: n }, (_, i) =>
    `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`,
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${ids}</p:sldIdLst>
<p:sldSz cx="${cx}" cy="${cy}"/>
<p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}

function presentationRelsXml(n: number): string {
  const slideRels = Array.from({ length: n }, (_, i) =>
    `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${slideRels}
<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`;
}

function slideXml(p: PageEmuPlacement): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:pic>
<p:nvPicPr><p:cNvPr id="2" name="Picture"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm><a:off x="${p.offsetEmuX}" y="${p.offsetEmuY}"/><a:ext cx="${p.imageEmuW}" cy="${p.imageEmuH}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
</p:pic>
</p:spTree></p:cSld>
</p:sld>`;
}

function slideRelsXml(idx: number, ext: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${idx}.${ext}"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`;
}

function slideMasterXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`;
}

function slideMasterRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}

function slideLayoutXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="Blank"><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}

function slideLayoutRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
}

function themeXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
<a:themeElements>
<a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1F497D"/></a:dk2>
<a:lt2><a:srgbClr val="EEECE1"/></a:lt2>
<a:accent1><a:srgbClr val="4F81BD"/></a:accent1>
<a:accent2><a:srgbClr val="C0504D"/></a:accent2>
<a:accent3><a:srgbClr val="9BBB59"/></a:accent3>
<a:accent4><a:srgbClr val="8064A2"/></a:accent4>
<a:accent5><a:srgbClr val="4BACC6"/></a:accent5>
<a:accent6><a:srgbClr val="F79646"/></a:accent6>
<a:hlink><a:srgbClr val="0000FF"/></a:hlink>
<a:folHlink><a:srgbClr val="800080"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="Office">
<a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="Office">
<a:fillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:fillStyleLst>
<a:lnStyleLst>
<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
<a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
<a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
</a:lnStyleLst>
<a:effectStyleLst>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
</a:effectStyleLst>
<a:bgFillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>`;
}
