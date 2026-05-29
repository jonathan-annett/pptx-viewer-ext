// Pure deck builder for one title-slide .pptx (per room, per day).
//
// Composes the M0-verified XML primitives (clone slide, substitute
// `<a:t>`, shape-attached hyperlink on `<p:cNvPr>`) into a single
// build pass over the template zip. Output is byte-for-byte
// deterministic for stable inputs — important because the wired
// generator (M4) writes to a fixed filename and overwrites on re-run,
// so identical inputs should hash identically.
//
// No vscode imports. Tested under Node via tsx against the three
// samples in `samples/title-templates/`.
//
// What this module owns:
//   - field substitution (single-frame + line-bound)
//   - shape-attached hyperlink injection for single-frame speakers
//   - per-slide rels assembly (drop notes, add hyperlinks)
//   - deck-level scaffolding rebuild (Content_Types, presentation.xml,
//     presentation.xml.rels)
//
// What this module does NOT do (deferred, see plan):
//   - per-line overlay hyperlinks for line-bound speakers (v1: warn instead)
//   - URL-encoding hyperlink targets (raw spaces work in PowerPoint, per M0)
//   - any I/O (caller passes bytes in, gets bytes out)

import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import type { TemplateInspectResult } from './templateInspect';
import type {
  TitleSlidesBinding,
  TitleSlideFieldBinding,
} from './binding';
import { titleSlideFieldsByRole } from './binding';
import type { EventSession, SessionSpeakerSlot } from '../schedule';
import { sessionSpeakerFilename, normaliseExtension } from '../eventFolders';

// ───── Types ─────────────────────────────────────────────────────────────

export interface DeckBuildInput {
  /** Raw bytes of the template .pptx. */
  templateBytes: Uint8Array;
  /** Result of `inspectTemplate(templateBytes)`. Caller computes once,
   *  reuses across all (room, day) decks for the same template. */
  inspection: TemplateInspectResult;
  /** The binding. `binding.templatePath` is informational only here;
   *  the actual bytes are passed via `templateBytes`. */
  binding: TitleSlidesBinding;
  /** Sessions for this (room, day), in timeslot order, with pre-paginated
   *  speaker pages from `pagination.splitSpeakers`. */
  sessions: SessionForDeck[];
  /** Day token, e.g. "MON" — substituted into any `role: 'day'` binding. */
  day: string;
  /** Room display name, e.g. "Room 1" — substituted into any
   *  `role: 'roomName'` binding. */
  roomName: string;
  /** Extension for hyperlink target filenames (default ".pptx").
   *  Should match what `eventFolders.planEventFolders` used to lay out
   *  the placeholder files this deck links into. */
  extension?: string;
}

export interface SessionForDeck {
  /** Display title — caller applies `displayTitleForSession` fallback
   *  before passing in. Substituted into any `role: 'sessionTitle'` binding. */
  title: string;
  /** Timeslot label (e.g. "A"). Substituted into any `role: 'timeslot'`
   *  binding, AND used as the parent folder name in hyperlink targets. */
  timeslot: string;
  /** One entry per generated slide for this session, from
   *  `splitSpeakers(session.speakers, capacity, distributeEvenly)`. */
  speakerPages: SessionSpeakerSlot[][];
  /** Full session — needed by `sessionSpeakerFilename` (uses day,
   *  roomId, timeslot, speaker.slot, speaker.speakerName). */
  session: EventSession;
}

export interface DeckBuildOutput {
  bytes: Uint8Array;
  /** Non-fatal issues encountered during build. Empty when everything
   *  bound cleanly. Surfaces in the M4 result modal. */
  warnings: string[];
}

// ───── Public entry point ────────────────────────────────────────────────

export function buildTitleDeck(input: DeckBuildInput): DeckBuildOutput {
  const { templateBytes, inspection, binding, sessions, day, roomName } = input;
  const ext = normaliseExtension(input.extension ?? '.pptx');
  const warnings: string[] = [];

  validateBindingFrames(binding, inspection, warnings);

  const zip = unzipSync(templateBytes);

  // Snapshot original slide + notes parts before stripping — we'll
  // reach back into this for walk-in / supplementary copies.
  const sources: Record<string, Uint8Array> = {};
  for (const key of Object.keys(zip)) {
    if (key.startsWith('ppt/slides/') || key.startsWith('ppt/notesSlides/')) {
      sources[key] = zip[key];
      delete zip[key];
    }
  }

  // Compose the output deck slide-by-slide.
  type OutputSlide = { slideXml: string; relsXml: string };
  const outputs: OutputSlide[] = [];

  // 1. Walk-in (verbatim, drop notes rel).
  if (inspection.walkIn) {
    outputs.push(copyOriginalSlide(sources, inspection.walkIn));
  }

  // 2. Session × speaker-page template clones.
  const templateXml = strFromU8(sources[inspection.template.slideKey]);
  const templateRels = stripNotesRel(
    sources[inspection.template.relsKey] !== undefined
      ? strFromU8(sources[inspection.template.relsKey])
      : EMPTY_RELS,
  );
  const fields = titleSlideFieldsByRole(binding);

  for (const sd of sessions) {
    for (const page of sd.speakerPages) {
      const built = buildSessionSlide({
        templateXml,
        templateRels,
        inspection,
        fields,
        session: sd.session,
        sessionTitle: sd.title,
        timeslot: sd.timeslot,
        day,
        roomName,
        speakers: page,
        extension: ext,
      });
      outputs.push({ slideXml: built.slideXml, relsXml: built.relsXml });
      warnings.push(...built.warnings);
    }
  }

  // 3. Supplementary (verbatim, drop notes rel).
  for (const supp of inspection.supplementary) {
    outputs.push(copyOriginalSlide(sources, supp));
  }

  // Write outputs as slide1.xml..slideN.xml in deck order + rebuild scaffolding.
  type SlideRefOut = { path: string; sldId: number; rId: string };
  const slideRefs: SlideRefOut[] = [];
  for (let i = 0; i < outputs.length; i++) {
    const num = i + 1;
    const slideKey = `ppt/slides/slide${num}.xml`;
    const relsKey = `ppt/slides/_rels/slide${num}.xml.rels`;
    zip[slideKey] = strToU8(outputs[i].slideXml);
    zip[relsKey] = strToU8(outputs[i].relsXml);
    slideRefs.push({
      path: `slide${num}.xml`,
      sldId: 256 + i,
      rId: `rId${1000 + i}`,
    });
  }

  zip['ppt/presentation.xml'] = strToU8(
    rebuildSldIdLst(strFromU8(zip['ppt/presentation.xml']), slideRefs),
  );
  zip['ppt/_rels/presentation.xml.rels'] = strToU8(
    rebuildPresentationRels(strFromU8(zip['ppt/_rels/presentation.xml.rels']), slideRefs),
  );
  zip['[Content_Types].xml'] = strToU8(
    rebuildContentTypes(strFromU8(zip['[Content_Types].xml']), slideRefs.map(r => r.path)),
  );

  return { bytes: zipSync(zip), warnings };
}

// ───── Slide-level builders ──────────────────────────────────────────────

function copyOriginalSlide(
  sources: Record<string, Uint8Array>,
  ref: { slideKey: string; relsKey: string },
): { slideXml: string; relsXml: string } {
  const slideXml = strFromU8(sources[ref.slideKey]);
  const relsRaw = sources[ref.relsKey] !== undefined
    ? strFromU8(sources[ref.relsKey])
    : EMPTY_RELS;
  return { slideXml, relsXml: stripNotesRel(relsRaw) };
}

interface SessionSlideArgs {
  templateXml: string;
  templateRels: string;
  inspection: TemplateInspectResult;
  fields: ReturnType<typeof titleSlideFieldsByRole>;
  session: EventSession;
  sessionTitle: string;
  timeslot: string;
  day: string;
  roomName: string;
  speakers: SessionSpeakerSlot[];   // one page (length ≤ capacity)
  extension: string;
}

function buildSessionSlide(args: SessionSlideArgs): {
  slideXml: string;
  relsXml: string;
  warnings: string[];
} {
  const { templateXml, templateRels, inspection, fields, session,
    sessionTitle, timeslot, day, roomName, speakers, extension } = args;
  let slideXml = templateXml;
  let relsXml = templateRels;
  const warnings: string[] = [];

  // Single-value substitutions.
  slideXml = maybeSubstitute(slideXml, inspection, fields.sessionTitle, sessionTitle);
  slideXml = maybeSubstitute(slideXml, inspection, fields.roomName, roomName);
  slideXml = maybeSubstitute(slideXml, inspection, fields.timeslot, timeslot);
  slideXml = maybeSubstitute(slideXml, inspection, fields.day, day);

  // Speaker substitutions + hyperlinks.
  // Hyperlink rIds start above the template's likely range (template rels
  // typically use rId1, rId2 for layout + notes — notes already stripped).
  let nextRid = 500;
  for (let i = 0; i < fields.speakers.length; i++) {
    const fb = fields.speakers[i];
    const speaker = speakers[i];   // may be undefined when page has fewer than capacity
    const shape = inspection.textFrames[fb.frame];
    if (!shape) continue;          // validate covered this; defensive
    const name = speaker ? speaker.speakerName : '';

    if (fb.line !== undefined) {
      // Line-bound: substitute that line's text only. Skip hyperlink + warn.
      slideXml = substituteLineText(slideXml, shape.shapeId, fb.line, name);
      if (speaker) {
        warnings.push(
          `Line-bound speaker bindings don't get hyperlinks in v1 ` +
          `(frame ${fb.frame}, line ${fb.line}, "${speaker.speakerName}").`,
        );
      }
    } else {
      // Single-frame: substitute the frame's text + attach hyperlink to the shape.
      slideXml = substituteShapeText(slideXml, shape.shapeId, name);
      if (speaker) {
        const rId = `rId${nextRid++}`;
        const target = titleDeckHyperlinkTarget(session, speaker, extension);
        slideXml = injectShapeHyperlink(slideXml, shape.shapeId, rId);
        relsXml = addHyperlinkRel(relsXml, rId, target);
      }
    }
  }

  return { slideXml, relsXml, warnings };
}

function maybeSubstitute(
  slideXml: string,
  inspection: TemplateInspectResult,
  fb: TitleSlideFieldBinding | undefined,
  value: string,
): string {
  if (!fb) return slideXml;
  const shape = inspection.textFrames[fb.frame];
  if (!shape) return slideXml;
  return substituteShapeText(slideXml, shape.shapeId, value);
}

/**
 * Public for callers that want to compute the link target without going
 * through the full builder (e.g. UI previews). Returns a relative path
 * suitable for a `<a:hlinkClick Target="...">`.
 *
 * Convention: `<timeslot>/<sessionSpeakerFilename>`. Spaces stay raw —
 * PowerPoint URI-decodes on resolve (verified M0). Encoding here would
 * actively break the link.
 */
export function titleDeckHyperlinkTarget(
  session: EventSession,
  speaker: SessionSpeakerSlot,
  extension: string = '.pptx',
): string {
  return `${session.timeslot}/${sessionSpeakerFilename(session, speaker, extension)}`;
}

// ───── XML primitives (M0-verified shapes) ───────────────────────────────

function substituteShapeText(slideXml: string, shapeId: number, newText: string): string {
  // Find the <p:sp>...</p:sp> whose <p:cNvPr id="shapeId" ...> appears inside.
  // Within that sp, replace the contents of the FIRST <a:t>...</a:t>.
  // Naive non-greedy match: <p:sp> blocks don't nest in practice.
  const spRe = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let m: RegExpExecArray | null;
  let out = slideXml;
  while ((m = spRe.exec(slideXml))) {
    const body = m[1];
    if (!body.includes(`id="${shapeId}"`)) continue;
    const before = `<p:sp>${body}</p:sp>`;
    const after = before.replace(
      /<a:t>[^<]*<\/a:t>/,
      `<a:t>${escapeXml(newText)}</a:t>`,
    );
    return out.replace(before, after);
  }
  return out;   // shape not found — silently no-op (validation should have caught)
}

function substituteLineText(
  slideXml: string,
  shapeId: number,
  lineIndex: number,
  newText: string,
): string {
  // Within the target shape's <p:txBody>, find the lineIndex-th <a:p>...</a:p>
  // and replace its first <a:t> content.
  const spRe = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let m: RegExpExecArray | null;
  let out = slideXml;
  while ((m = spRe.exec(slideXml))) {
    const body = m[1];
    if (!body.includes(`id="${shapeId}"`)) continue;
    const before = `<p:sp>${body}</p:sp>`;

    const txBodyMatch = body.match(/<p:txBody>([\s\S]*?)<\/p:txBody>/);
    if (!txBodyMatch) return out;
    const txBody = txBodyMatch[1];

    // Walk paragraphs; rebuild only the target.
    const pRe = /<a:p>[\s\S]*?<\/a:p>/g;
    let pMatch: RegExpExecArray | null;
    let pIdx = 0;
    let targetP: { full: string; replacement: string } | null = null;
    while ((pMatch = pRe.exec(txBody))) {
      if (pIdx === lineIndex) {
        const full = pMatch[0];
        const replacement = full.replace(
          /<a:t>[^<]*<\/a:t>/,
          `<a:t>${escapeXml(newText)}</a:t>`,
        );
        targetP = { full, replacement };
        break;
      }
      pIdx++;
    }
    if (!targetP) return out;   // lineIndex out of range — silent no-op
    const after = before.replace(targetP.full, targetP.replacement);
    return out.replace(before, after);
  }
  return out;
}

function injectShapeHyperlink(slideXml: string, shapeId: number, rId: string): string {
  // Shape-attached hyperlink (M0.4c — the working pattern).
  // <p:cNvPr id="..." name="..."/> → <p:cNvPr id="..." name="..."><a:hlinkClick r:id="..."/></p:cNvPr>
  const selfClosingRe = new RegExp(`<p:cNvPr id="${shapeId}"([^/]*)/>`);
  const openRe        = new RegExp(`<p:cNvPr id="${shapeId}"([^>]*)>`);
  if (selfClosingRe.test(slideXml)) {
    return slideXml.replace(
      selfClosingRe,
      `<p:cNvPr id="${shapeId}"$1><a:hlinkClick r:id="${rId}"/></p:cNvPr>`,
    );
  }
  if (openRe.test(slideXml)) {
    // Already open-form (would happen if a prior pass already injected on
    // this shape — shouldn't happen in normal flow, but tolerate).
    return slideXml.replace(
      openRe,
      `<p:cNvPr id="${shapeId}"$1><a:hlinkClick r:id="${rId}"/>`,
    );
  }
  return slideXml;
}

function addHyperlinkRel(relsXml: string, rId: string, target: string): string {
  const rel =
    `<Relationship Id="${rId}" ` +
    `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" ` +
    `Target="${escapeXml(target)}" TargetMode="External"/>`;
  return relsXml.replace('</Relationships>', rel + '</Relationships>');
}

// ───── Rels / scaffolding rebuild ────────────────────────────────────────

const EMPTY_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '</Relationships>';

function stripNotesRel(relsXml: string): string {
  // Drop any notesSlide relationships — output decks don't carry notes.
  return relsXml.replace(
    /<Relationship Id="[^"]+" Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/notesSlide" Target="[^"]+"\s*\/>/g,
    '',
  );
}

function rebuildSldIdLst(
  presXml: string,
  slideRefs: Array<{ sldId: number; rId: string }>,
): string {
  const inner = slideRefs
    .map(s => `<p:sldId id="${s.sldId}" r:id="${s.rId}"/>`)
    .join('');
  if (/<p:sldIdLst\s*\/>/.test(presXml)) {
    return presXml.replace(/<p:sldIdLst\s*\/>/, `<p:sldIdLst>${inner}</p:sldIdLst>`);
  }
  return presXml.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${inner}</p:sldIdLst>`);
}

function rebuildPresentationRels(
  presRelsXml: string,
  slideRefs: Array<{ path: string; rId: string }>,
): string {
  // Drop all existing slide rels (we own slide numbering now), preserve
  // everything else (theme, master, fonts, notes master, viewProps, presProps).
  const slideRelRe =
    /<Relationship Id="[^"]+" Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/slide" Target="[^"]+"\s*\/>/g;
  let out = presRelsXml.replace(slideRelRe, '');
  const newRels = slideRefs
    .map(
      s =>
        `<Relationship Id="${s.rId}" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" ` +
        `Target="slides/${s.path}"/>`,
    )
    .join('');
  return out.replace('</Relationships>', newRels + '</Relationships>');
}

function rebuildContentTypes(ctXml: string, keepSlidePaths: string[]): string {
  // Drop existing slide Overrides + all notesSlide Overrides (we drop notes).
  const slideOverrideRe =
    /<Override ContentType="application\/vnd\.openxmlformats-officedocument\.presentationml\.slide\+xml" PartName="[^"]+"\s*\/>/g;
  const notesOverrideRe =
    /<Override ContentType="application\/vnd\.openxmlformats-officedocument\.presentationml\.notesSlide\+xml" PartName="[^"]+"\s*\/>/g;
  let out = ctXml.replace(slideOverrideRe, '').replace(notesOverrideRe, '');
  const newOverrides = keepSlidePaths
    .map(
      p =>
        `<Override ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml" ` +
        `PartName="/ppt/slides/${p}"/>`,
    )
    .join('');
  return out.replace('</Types>', newOverrides + '</Types>');
}

// ───── Validation ────────────────────────────────────────────────────────

function validateBindingFrames(
  binding: TitleSlidesBinding,
  inspection: TemplateInspectResult,
  warnings: string[],
): void {
  const frameCount = inspection.textFrames.length;
  for (const f of binding.fields) {
    if (f.frame < 0 || f.frame >= frameCount) {
      throw new Error(
        `Binding references frame ${f.frame} but template has ${frameCount} text frame(s). ` +
        `Re-bind needed (template structure changed).`,
      );
    }
    if (f.role === 'speaker' && f.line !== undefined) {
      const shape = inspection.textFrames[f.frame];
      if (f.line < 0 || f.line >= shape.lines.length) {
        warnings.push(
          `Binding references frame ${f.frame} line ${f.line} but that frame has ` +
          `${shape.lines.length} line(s). Line skipped at build time.`,
        );
      }
    }
  }
}

// ───── XML escape ────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
