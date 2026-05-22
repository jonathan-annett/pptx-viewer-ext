// Pure layout math for PDF → PPTX import.
//
// Given the user's fixed slide aspect/resolution and a single PDF page's
// natural dimensions, compute:
//   - imagePxW/H   — the canvas pixel size to render the page to
//   - renderScale  — the scale to pass to PDF.js getViewport({scale})
//   - placement    — the EMU rectangle (offset + extent) for the picture in
//                    the slide; centred for letterbox, or fill-slide for stretch
//
// No DOM, no PDF.js — pure arithmetic. Tested under Node + tsx in
// test/pdf-import-layout.test.ts.
//
// EMU = English Metric Unit, OOXML's internal unit. 914400 EMU per inch.
// 1 PostScript point (PDF's native unit) = 1/72 inch = 12700 EMU.

import { EMU_PER_POINT, type PageEmuPlacement } from './pdfImport';

/** PDF page's natural size in PostScript points (PDF.js viewport scale=1). */
export interface PageNaturalSize {
  widthPt: number;
  heightPt: number;
}

/** Slide size in EMU. From `SLIDE_SIZE_16x9_EMU` / `SLIDE_SIZE_4x3_EMU`. */
export interface SlideSizeEmu {
  cx: number;
  cy: number;
}

export interface LayoutOptions {
  /**
   * The slide's pixel width at "fill" density — i.e. how many CSS pixels the
   * slide's full width should map to when rendered at maximum quality. With a
   * 16:9 slide this is typically 1920 (so the slide is 1920×1080). The actual
   * rendered canvas may be narrower if the page is portrait-shaped and
   * letterboxed left/right.
   */
  targetPxW: number;
  /**
   * letterbox=true (default): fit the page inside the slide while preserving
   *   the page's natural aspect ratio. The slide's background colour shows
   *   through as bars on the sides or top/bottom.
   *
   * letterbox=false: stretch the page to fill the slide regardless of aspect.
   *   The picture is squashed if aspects differ; no bars.
   */
  letterbox?: boolean;
}

export interface PageLayout {
  /** Canvas dimensions to render this page at. */
  imagePxW: number;
  imagePxH: number;
  /**
   * Scale factor to pass to PDF.js `page.getViewport({ scale })`. Equals
   * `imagePxW / widthPt`. Always positive; same value applies to both axes
   * because getViewport is uniform.
   */
  renderScale: number;
  /** EMU placement to embed in the slide XML for this picture. */
  placement: PageEmuPlacement;
}

/**
 * Compute one page's layout. Pure; no allocations besides the result.
 *
 * Geometry:
 *   pageAspect  = widthPt / heightPt
 *   slideAspect = slide.cx / slide.cy
 *   - pageAspect >= slideAspect → page is wider (or equal); width-bound by
 *     the slide → bars at top + bottom (or no bars when equal).
 *   - else → page is taller → height-bound → bars at left + right.
 *
 * Render scale is chosen so the rendered canvas pixel-width equals the
 * proportion of `targetPxW` that the picture occupies in the slide. This
 * keeps pixel density constant whether the page fills the slide or is
 * letterboxed within it — letterboxed pages render at a lower pixel count
 * because they occupy fewer slide pixels, which is the right call (the
 * extra pixels would map onto the bars).
 */
export function computePageLayout(
  page: PageNaturalSize,
  slide: SlideSizeEmu,
  opts: LayoutOptions,
): PageLayout {
  const { widthPt, heightPt } = page;
  const { cx, cy } = slide;
  const { targetPxW, letterbox = true } = opts;

  if (!(widthPt > 0) || !(heightPt > 0)) {
    throw new Error(`Invalid page size: ${widthPt} × ${heightPt} pt`);
  }
  if (!(cx > 0) || !(cy > 0)) {
    throw new Error(`Invalid slide size: ${cx} × ${cy} EMU`);
  }
  if (!(targetPxW > 0)) {
    throw new Error(`Invalid targetPxW: ${targetPxW}`);
  }

  const pageAspect = widthPt / heightPt;
  const slideAspect = cx / cy;

  let imageEmuW: number;
  let imageEmuH: number;
  let offsetEmuX: number;
  let offsetEmuY: number;

  if (!letterbox) {
    // Stretch — picture fills the entire slide.
    imageEmuW = cx;
    imageEmuH = cy;
    offsetEmuX = 0;
    offsetEmuY = 0;
  } else if (pageAspect >= slideAspect) {
    // Width-bound: picture is as wide as the slide, shorter vertically.
    imageEmuW = cx;
    imageEmuH = Math.round(cx / pageAspect);
    offsetEmuX = 0;
    offsetEmuY = Math.round((cy - imageEmuH) / 2);
  } else {
    // Height-bound: picture is as tall as the slide, narrower horizontally.
    imageEmuH = cy;
    imageEmuW = Math.round(cy * pageAspect);
    offsetEmuX = Math.round((cx - imageEmuW) / 2);
    offsetEmuY = 0;
  }

  // Map the picture's EMU width onto the user's target-pixel budget.
  // imagePxW : targetPxW :: imageEmuW : cx.
  const imagePxW = Math.max(1, Math.round((targetPxW * imageEmuW) / cx));
  // For stretch we render at slide's aspect (distorts content); for letterbox
  // we render at picture's own aspect.
  const imagePxH = letterbox
    ? Math.max(1, Math.round(imagePxW / pageAspect))
    : Math.max(1, Math.round((imagePxW * cy) / cx));

  // PDF.js scale = pixels-per-point = imagePxW / widthPt. For stretch mode
  // there isn't a single uniform scale that preserves both axes (since we're
  // distorting), so we accept the horizontal scale and let the OOXML stretch
  // do the rest — the original pdf2pptx tool worked the same way.
  const renderScale = imagePxW / widthPt;

  return {
    imagePxW,
    imagePxH,
    renderScale,
    placement: { offsetEmuX, offsetEmuY, imageEmuW, imageEmuH },
  };
}

/**
 * Convenience: derive the "fill density" target pixel width from a slide
 * size and a user-chosen long-edge resolution (e.g. 1920). Returns the pixel
 * width of the slide's long edge; the short-edge pixel count is implied by
 * the slide's aspect ratio.
 *
 * Currently slides are always landscape (cx > cy in PowerPoint stock sizes),
 * so longEdgePx is the horizontal axis and equals `targetPxW`. Kept as a
 * named helper so the call site reads as `targetPxW: targetPxWFor(slide, 1920)`
 * rather than a bare number.
 */
export function targetPxWFor(slide: SlideSizeEmu, longEdgePx: number): number {
  if (!(longEdgePx > 0)) {
    throw new Error(`Invalid longEdgePx: ${longEdgePx}`);
  }
  // Landscape slide → long edge is cx → targetPxW is just longEdgePx.
  // Future-proof: if portrait slides ever land, switch on cx vs cy here.
  return slide.cx >= slide.cy ? longEdgePx : Math.round((longEdgePx * slide.cx) / slide.cy);
}

/**
 * Estimate the rendered canvas memory cost for a page at this layout, in
 * bytes. Always 4 bytes/pixel (RGBA, what HTMLCanvasElement uses internally).
 * Useful for warning the user before launching a huge render.
 */
export function estimateCanvasBytes(layout: PageLayout): number {
  return layout.imagePxW * layout.imagePxH * 4;
}

// EMU_PER_POINT is re-exported for callers that want it alongside the layout
// helper without a separate pdfImport import.
export { EMU_PER_POINT };
