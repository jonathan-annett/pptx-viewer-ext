/**
 * pdfToPptx.mjs — pure client-side PDF → .pptx (one PNG per slide).
 *
 * Browser usage (in your PWA):
 *   import { pdfToPptx } from './pdfToPptx.js';
 *   const blob = await pdfToPptx(file, { scale: 2, onProgress: (p) => ... });
 *
 * Test note: this file is also runnable in Node for verification — see
 * the bottom export `buildPptxFromPngs` which skips the PDF rendering step
 * and just packages an array of PNG buffers.
 */

import { zip, strToU8 } from 'fflate';

// 1 PostScript point = 12700 EMU (English Metric Units, OOXML's internal unit)
const EMU_PER_POINT = 12700;

// Promisified fflate.zip — runs in a worker so it doesn't block the UI
function zipAsync(files, opts = {}) {
  return new Promise((resolve, reject) => {
    zip(files, opts, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// Coerce ArrayBuffer / Uint8Array / Buffer → Uint8Array (fflate's required input)
function toU8(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError('Image must be ArrayBuffer or Uint8Array');
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

/**
 * Convert a PDF File/Blob to a .pptx Blob (browser only — needs pdfjs-dist).
 * @param {File|Blob} pdfFile
 * @param {object} opts
 * @param {number} [opts.scale=2]        Render scale (1 ≈ 72 DPI, 2 ≈ 144, ~4.17 ≈ 300)
 * @param {'png'|'jpeg'} [opts.format='png']  Image format. JPEG is ~5-10× smaller for
 *                                            photo-heavy pages but lossy.
 * @param {number} [opts.quality=0.85]   JPEG quality 0..1 (ignored for PNG)
 * @param {(p:{phase:string,current:number,total:number})=>void} [opts.onProgress]
 * @param {object} [opts.pdfjsLib]       Pass your imported pdfjs-dist module
 * @returns {Promise<Blob>}
 */
export async function pdfToPptx(pdfFile, {
  scale = 2,
  format = 'png',
  quality = 0.85,
  onProgress,
  pdfjsLib,
} = {}) {
  if (!pdfjsLib) throw new Error('Pass pdfjsLib (import * as pdfjsLib from "pdfjs-dist")');
  if (format !== 'png' && format !== 'jpeg') {
    throw new Error(`Unsupported format: ${format} (use 'png' or 'jpeg')`);
  }

  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';

  const data = await pdfFile.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const numPages = pdf.numPages;

  const pages = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const natural = page.getViewport({ scale: 1 });   // page size in points
    const render = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(render.width);
    canvas.height = Math.ceil(render.height);
    const ctx = canvas.getContext('2d');

    // JPEG has no alpha channel — fill white first or transparent pixels
    // become black. Harmless for PNG but still a sensible default for PDFs.
    if (format === 'jpeg') {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    await page.render({ canvasContext: ctx, viewport: render }).promise;

    const blob = await new Promise((res) =>
      canvas.toBlob(res, mimeType, format === 'jpeg' ? quality : undefined)
    );
    pages.push({
      image: await blob.arrayBuffer(),
      widthPt: natural.width,
      heightPt: natural.height,
    });

    page.cleanup();
    onProgress?.({ phase: 'render', current: i, total: numPages });
  }

  return buildPptxFromImages(pages, { format, onProgress });
}

/**
 * Pure packager — takes already-rendered images + their page sizes in points
 * and returns a .pptx Blob. Used by pdfToPptx() and by the Node test below.
 *
 * @param {Array<{image: ArrayBuffer|Uint8Array, widthPt: number, heightPt: number}>} pages
 * @param {object} [opts]
 * @param {'png'|'jpeg'} [opts.format='png']
 * @param {(p:{phase:string,current:number,total:number})=>void} [opts.onProgress]
 */
export async function buildPptxFromImages(pages, { format = 'png', onProgress } = {}) {
  if (!pages?.length) throw new Error('No pages provided');
  if (format !== 'png' && format !== 'jpeg') {
    throw new Error(`Unsupported format: ${format} (use 'png' or 'jpeg')`);
  }
  const n = pages.length;
  const ext = format;
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';

  // Slide size = first page's natural size in EMU. Every image is stretched
  // to fill, so subsequent pages with different ratios will distort slightly.
  const cx = Math.round(pages[0].widthPt * EMU_PER_POINT);
  const cy = Math.round(pages[0].heightPt * EMU_PER_POINT);

  // Build the file tree. fflate accepts:
  //   filename: Uint8Array                    (use default compression)
  //   filename: [Uint8Array, { level: 0..9 }] (per-file compression level)
  //
  // PNG/JPEG payloads are already compressed, so we set level: 0 (store mode).
  // XML compresses well at default level 6.
  const files = {
    '[Content_Types].xml':                          strToU8(contentTypesXml(n, ext, mime)),
    '_rels/.rels':                                  strToU8(topRelsXml()),
    'ppt/presentation.xml':                         strToU8(presentationXml(n, cx, cy)),
    'ppt/_rels/presentation.xml.rels':              strToU8(presentationRelsXml(n)),
    'ppt/theme/theme1.xml':                         strToU8(themeXml()),
    'ppt/slideMasters/slideMaster1.xml':            strToU8(slideMasterXml()),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': strToU8(slideMasterRelsXml()),
    'ppt/slideLayouts/slideLayout1.xml':            strToU8(slideLayoutXml()),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(slideLayoutRelsXml()),
  };

  for (let i = 0; i < n; i++) {
    const idx = i + 1;
    // Images: store-only (already compressed). Avoids 5-15% CPU for ~0% gain.
    files[`ppt/media/image${idx}.${ext}`] = [toU8(pages[i].image), { level: 0 }];
    files[`ppt/slides/slide${idx}.xml`] = strToU8(slideXml(cx, cy));
    files[`ppt/slides/_rels/slide${idx}.xml.rels`] = strToU8(slideRelsXml(idx, ext));
    onProgress?.({ phase: 'package', current: idx, total: n });
  }

  // fflate.zip is callback-based but runs in a Web Worker by default,
  // so the UI thread stays responsive even on big decks.
  const zipped = await zipAsync(files, { level: 6 });

  return new Blob([zipped], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}

// ──────────────────────────────────────────────────────────────────────────
// XML templates — minimal but valid OOXML
// ──────────────────────────────────────────────────────────────────────────

function contentTypesXml(n, ext, mime) {
  const slides = Array.from({ length: n }, (_, i) =>
    `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
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

function topRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;
}

function presentationXml(n, cx, cy) {
  const ids = Array.from({ length: n }, (_, i) =>
    `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${ids}</p:sldIdLst>
<p:sldSz cx="${cx}" cy="${cy}"/>
<p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}

function presentationRelsXml(n) {
  const slideRels = Array.from({ length: n }, (_, i) =>
    `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${slideRels}
<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`;
}

function slideXml(cx, cy) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:pic>
<p:nvPicPr><p:cNvPr id="2" name="Picture"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
</p:pic>
</p:spTree></p:cSld>
</p:sld>`;
}

function slideRelsXml(idx, ext) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${idx}.${ext}"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`;
}

function slideMasterXml() {
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

function slideMasterRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}

function slideLayoutXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="Blank"><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}

function slideLayoutRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
}

function themeXml() {
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
