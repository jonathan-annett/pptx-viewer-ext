// Pure inspector for a title-slide template .pptx.
//
// Reads the zip, walks the presentation's <p:sldIdLst> in order, classifies
// visible slides by role (walk-in / template / supplementary), and extracts
// addressable text frames from the template slide. No vscode imports;
// tested under Node via tsx.
//
// Visible-slide role rules (verified against samples/title-templates/):
//   1 visible  → template only (no walk-in, no supplementary)
//   2 visible  → walk-in + template
//   3+ visible → walk-in + template + supplementary[]
//
// "Visible" = the <p:sld> root tag has no `show="0"` attribute. Hidden
// slides (and their order) are preserved as raw refs in `hidden[]` for
// callers that want to know about them (e.g. binding UI tip "you have N
// hidden variants you could swap in").

import { unzipSync, strFromU8 } from 'fflate';

// ───── Types ─────────────────────────────────────────────────────────────

/** Pointer into the source zip for one slide. */
export interface SlideRef {
  /** e.g. `ppt/slides/slide2.xml` */
  slideKey: string;
  /** e.g. `ppt/slides/_rels/slide2.xml.rels` */
  relsKey: string;
  /** Original `<p:sldId id>` from presentation.xml (integer in 256..2^31-1). */
  origSldId: number;
  /** Whether the source slide had `show="0"`. Always false for slides
   *  returned in `walkIn`/`template`/`supplementary`; can be true for `hidden`. */
  hidden: boolean;
}

/** EMU (English Metric Units, 914400 per inch). */
export interface FrameGeometry {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

/** A text-bearing shape on the template slide, addressable by its zero-based
 *  index in document order. */
export interface TextFrame {
  /** Zero-based position among text-bearing shapes on the template slide. */
  index: number;
  /** `<p:cNvPr id>` from the shape — useful when we want to inject a
   *  hyperlink on the shape itself in M2. */
  shapeId: number;
  /** `<p:cNvPr name>` — display label for the bind UI. Often
   *  `Google Shape;NNNN;pXX` for Google Slides exports; can be more
   *  descriptive ("Title 1", "Speaker Name") for hand-authored decks. */
  shapeName: string;
  /** Geometry from `<p:spPr><a:xfrm>`. Absent when the shape doesn't
   *  carry its own xfrm (inherits from layout — uncommon but possible). */
  geometry?: FrameGeometry;
  /** One entry per `<a:p>` paragraph in document order. Empty strings
   *  retained — they're legitimate "blank line for spacing" cases an
   *  author may want to address. */
  lines: string[];
  /** Convenience: `lines.join('\n')`. The "sample text" the bind UI
   *  shows to help the user identify a frame. */
  sampleText: string;
}

export interface TemplateInspectResult {
  /** Visible slide before the template (in document order). Absent when
   *  there's only one visible slide. */
  walkIn?: SlideRef;
  /** The slide whose text frames the binding addresses. */
  template: SlideRef;
  /** Visible slides after the template, in document order. Empty unless
   *  the template has 3+ visible slides. */
  supplementary: SlideRef[];
  /** Hidden slides preserved in source order (informational; the
   *  generator ignores these). */
  hidden: SlideRef[];
  /** Text-bearing shapes on the `template` slide. Index = position in
   *  document order. Decorative shapes (no `<p:txBody>`) are filtered out. */
  textFrames: TextFrame[];
}

// ───── Public entry point ────────────────────────────────────────────────

export function inspectTemplate(pptxBytes: Uint8Array): TemplateInspectResult {
  const zip = unzipSync(pptxBytes);

  const presKey = 'ppt/presentation.xml';
  const presRelsKey = 'ppt/_rels/presentation.xml.rels';
  if (!zip[presKey]) throw new Error(`Template missing ${presKey}`);
  if (!zip[presRelsKey]) throw new Error(`Template missing ${presRelsKey}`);

  const presXml = strFromU8(zip[presKey]);
  const presRelsXml = strFromU8(zip[presRelsKey]);

  // Resolve r:id → slide path via presentation.xml.rels.
  const slidePathByRid = parseSlideRelationships(presRelsXml);

  // Walk <p:sldIdLst> in document order; for each entry resolve to a
  // SlideRef, classify visible/hidden, and collect text frames if it
  // ends up as the template slide.
  const sldOrder = parseSldIdLst(presXml);
  const allRefs: SlideRef[] = [];
  for (const { sldId, rId } of sldOrder) {
    const slidePath = slidePathByRid.get(rId);
    if (!slidePath) {
      // Slide entry with a dangling rels reference — skip rather than throw.
      // Real-world templates can have orphan sldIdLst entries after
      // edits in some authoring tools.
      continue;
    }
    const slideKey = resolveSlidePath(slidePath);   // → "ppt/slides/slide2.xml"
    const relsKey = slideRelsKey(slideKey);          // → "ppt/slides/_rels/slide2.xml.rels"
    if (!zip[slideKey]) continue;                    // missing file → skip
    const slideXml = strFromU8(zip[slideKey]);
    const hidden = isSlideHidden(slideXml);
    allRefs.push({ slideKey, relsKey, origSldId: sldId, hidden });
  }

  const visible = allRefs.filter(r => !r.hidden);
  const hidden = allRefs.filter(r => r.hidden);
  if (visible.length === 0) {
    throw new Error('Template has no visible slides (all <p:sld> have show="0")');
  }

  // Classify by visible count.
  let walkIn: SlideRef | undefined;
  let template: SlideRef;
  let supplementary: SlideRef[];
  if (visible.length === 1) {
    template = visible[0];
    supplementary = [];
  } else if (visible.length === 2) {
    walkIn = visible[0];
    template = visible[1];
    supplementary = [];
  } else {
    walkIn = visible[0];
    template = visible[1];
    supplementary = visible.slice(2);
  }

  // Extract text frames from the template slide.
  const templateXml = strFromU8(zip[template.slideKey]);
  const textFrames = extractTextFrames(templateXml);

  return { walkIn, template, supplementary, hidden, textFrames };
}

// ───── Internals: presentation-level parsing ─────────────────────────────

interface SldIdEntry {
  sldId: number;
  rId: string;
}

function parseSldIdLst(presXml: string): SldIdEntry[] {
  // <p:sldIdLst>
  //   <p:sldId id="256" r:id="rId6"/>
  //   <p:sldId id="257" r:id="rId7"/>
  // </p:sldIdLst>
  const inner = presXml.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/);
  if (!inner) return [];
  const out: SldIdEntry[] = [];
  const entryRe = /<p:sldId\s+id="(\d+)"\s+r:id="([^"]+)"\s*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(inner[1]))) {
    out.push({ sldId: Number(m[1]), rId: m[2] });
  }
  return out;
}

function parseSlideRelationships(presRelsXml: string): Map<string, string> {
  // <Relationship Id="rId6" Type=".../slide" Target="slides/slide1.xml"/>
  // Returns rId → Target. Only slide relationships are collected.
  //
  // Note: the attribute capture must allow `/` inside attributes (Type URLs
  // contain "http://" — using [^/>] would stop at the first slash). We
  // anchor on the closing `/>` instead.
  const out = new Map<string, string>();
  const re = /<Relationship\s+([^>]+?)\s*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(presRelsXml))) {
    const attrs = m[1];
    const id = attrs.match(/Id="([^"]+)"/);
    const type = attrs.match(/Type="([^"]+)"/);
    const target = attrs.match(/Target="([^"]+)"/);
    if (!id || !type || !target) continue;
    if (!type[1].endsWith('/relationships/slide')) continue;
    out.set(id[1], target[1]);
  }
  return out;
}

function resolveSlidePath(relTarget: string): string {
  // presentation.xml.rels Target is relative to ppt/ — e.g. "slides/slide1.xml".
  // Absolute targets ("/ppt/slides/slide1.xml") are rare but tolerated.
  if (relTarget.startsWith('/')) return relTarget.slice(1);
  return `ppt/${relTarget}`;
}

function slideRelsKey(slideKey: string): string {
  // ppt/slides/slide2.xml → ppt/slides/_rels/slide2.xml.rels
  const slash = slideKey.lastIndexOf('/');
  const dir = slideKey.slice(0, slash);
  const file = slideKey.slice(slash + 1);
  return `${dir}/_rels/${file}.rels`;
}

function isSlideHidden(slideXml: string): boolean {
  // <p:sld xmlns:... ... show="0">  → hidden
  // Anything else (show absent or show="1") → visible
  const root = slideXml.match(/<p:sld\b[^>]*>/);
  if (!root) return false;
  return /\sshow="0"/.test(root[0]);
}

// ───── Internals: text-frame extraction ──────────────────────────────────

function extractTextFrames(slideXml: string): TextFrame[] {
  const frames: TextFrame[] = [];
  // Walk top-level <p:sp> shapes (not <p:cxnSp>, not <p:grpSp> children).
  // The naive non-greedy match works because <p:sp> blocks don't nest
  // inside each other in practice (groups use <p:grpSp> wrapping).
  const spRe = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let m: RegExpExecArray | null;
  let textFrameIndex = 0;
  while ((m = spRe.exec(slideXml))) {
    const body = m[1];
    if (!body.includes('<p:txBody>')) continue;   // decorative shape
    const cNvPr = body.match(/<p:cNvPr\s+id="(\d+)"\s+name="([^"]*)"/);
    if (!cNvPr) continue;
    const geometry = extractGeometry(body);
    const lines = extractLines(body);
    // Skip shapes that have an empty <p:txBody> AND no <a:t> at all —
    // these are placeholder hulls without addressable content. Empty
    // *paragraphs* within a non-empty frame are kept (they represent
    // blank lines in a multi-line speaker box).
    if (lines.length === 0) continue;
    frames.push({
      index: textFrameIndex++,
      shapeId: Number(cNvPr[1]),
      shapeName: cNvPr[2],
      geometry,
      lines,
      sampleText: lines.join('\n'),
    });
  }
  return frames;
}

function extractGeometry(shapeBody: string): FrameGeometry | undefined {
  const off = shapeBody.match(/<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"\s*\/>/);
  const ext = shapeBody.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/);
  if (!off || !ext) return undefined;
  return {
    x: Number(off[1]),
    y: Number(off[2]),
    cx: Number(ext[1]),
    cy: Number(ext[2]),
  };
}

function extractLines(shapeBody: string): string[] {
  // Each <a:p>...</a:p> is one line. Within a paragraph, concat all <a:t>
  // contents from <a:r> runs. <a:br/> inside a paragraph becomes a line
  // break — we treat it as if it were a paragraph boundary for the lines
  // array, since visually that's what the audience sees.
  const txBody = shapeBody.match(/<p:txBody>([\s\S]*?)<\/p:txBody>/);
  if (!txBody) return [];
  const inner = txBody[1];
  const paragraphs: string[] = [];
  const pRe = /<a:p>([\s\S]*?)<\/a:p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(inner))) {
    const pBody = m[1];
    // Split on <a:br/> first so each break starts a new "line".
    const segments = pBody.split(/<a:br\b[^/]*\/>/);
    for (const seg of segments) {
      // Concat all <a:t> text within the segment.
      const tParts: string[] = [];
      const tRe = /<a:t>([^<]*)<\/a:t>/g;
      let t: RegExpExecArray | null;
      while ((t = tRe.exec(seg))) {
        tParts.push(unescapeXml(t[1]));
      }
      paragraphs.push(tParts.join(''));
    }
  }
  // Drop trailing empty paragraphs (very common — PowerPoint's
  // <a:endParaRPr/> shows up as an empty <a:p>). Interior empties stay.
  while (paragraphs.length > 0 && paragraphs[paragraphs.length - 1] === '') {
    paragraphs.pop();
  }
  return paragraphs;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
