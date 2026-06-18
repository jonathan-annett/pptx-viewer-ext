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
import { sha256Hex } from '../../sync/hash';

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
  /** Pre-computed sha256(templateBytes). M4 hashes the template once and
   *  reuses across all (room, day) decks; tests and one-off callers omit. */
  precomputedTemplateHash?: string;
  /** Deck version (1, 2, 3, …). Default 1 — first generation. M4 computes
   *  via `nextDeckVersion(previousFingerprint, newHashes)`. */
  deckVersion?: number;
  /** Optional ISO-8601 timestamp embedded alongside the hashes for human
   *  reference (`generated-at=` in the comment). NOT part of the hash —
   *  byte-identical output for stable inputs is preserved when omitted.
   *  M4 typically passes `new Date().toISOString()`. */
  generatedAt?: string;
  /** Optional JPEG bytes for `docProps/thumbnail.jpeg`. When provided the
   *  embed path also wires in the Content_Types Override + root-rels
   *  Relationship needed for OS-level thumbnail rendering (Finder /
   *  Explorer). Rendered by the wired layer (`thumbnail.ts` via
   *  OffscreenCanvas); the bytes are NOT part of the data hash so
   *  thumbnail-only changes don't bump deck-version. */
  thumbnailBytes?: Uint8Array;
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
  /** Deterministic fingerprint of the inputs that drove this build.
   *  Embedded in docProps/core.xml's <dc:description>; M4's stale-check
   *  reads it back via `readDeckFingerprint`. */
  fingerprint: DeckFingerprint;
}

/**
 * Format version for the fingerprint block embedded in <dc:description>.
 * Bumped only when the *embedding format* changes (e.g. we add new fields
 * or restructure). Independent of `deckVersion` (the regen counter for
 * this specific deck's data).
 */
export const FINGERPRINT_FORMAT_VERSION = 1;

export interface DeckFingerprint {
  /** Format version of the embedded block (always `FINGERPRINT_FORMAT_VERSION`
   *  for blocks this build emits). Older format versions stay parseable. */
  formatVersion: number;
  /** Regen counter for THIS deck — bumps each time the underlying data
   *  changes. v1 on first generation. */
  deckVersion: number;
  /** sha256(templateBytes). Flips when the operator changes the template. */
  templateHash: string;
  /** sha256(canonicalJson(per-deck inputs)). Flips when speakers / sessions
   *  / binding change for this specific (room, day). */
  dataHash: string;
  /** ISO-8601 timestamp of the build, if the caller passed `generatedAt`.
   *  NOT part of the hashes — purely human-readable. */
  generatedAt?: string;
}

// ───── Public entry point ────────────────────────────────────────────────

export async function buildTitleDeck(input: DeckBuildInput): Promise<DeckBuildOutput> {
  const { templateBytes, inspection, binding, sessions, day, roomName } = input;
  const ext = normaliseExtension(input.extension ?? '.pptx');
  const warnings: string[] = [];

  validateBindingFrames(binding, inspection, warnings);

  // Compute the fingerprint up-front so we can embed it after slide
  // assembly. Hashes are over canonical inputs (timestamp excluded), so
  // identical schedules produce identical bytes regardless of when run.
  const hashes = await computeDeckHashes(input);
  const fingerprint: DeckFingerprint = {
    formatVersion: FINGERPRINT_FORMAT_VERSION,
    deckVersion: input.deckVersion ?? 1,
    templateHash: hashes.templateHash,
    dataHash: hashes.dataHash,
  };
  if (input.generatedAt !== undefined) fingerprint.generatedAt = input.generatedAt;

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

  // Embed fingerprint in docProps/core.xml's <dc:description>. Creates
  // the file + Content_Types Override + root rels entry if the template
  // didn't carry core props (Google Slides exports often omit them).
  embedFingerprint(zip, fingerprint);

  // Optional thumbnail (M4.2). Caller renders the bytes (typically a
  // version-stamped sticker via OffscreenCanvas); we just embed.
  if (input.thumbnailBytes) {
    embedThumbnail(zip, input.thumbnailBytes);
  }

  return { bytes: zipSync(zip), warnings, fingerprint };
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

// ───── Fingerprint: compute, embed, read, version-bump ──────────────────

/**
 * Compute the template + data hashes for a deck without building it.
 * M4's stale-check uses this to decide whether to skip an unchanged
 * (room, day) without paying the full build cost. Pure (no I/O).
 *
 * The `templateHash` is sha256 of the raw .pptx bytes — caches via
 * `input.precomputedTemplateHash` when provided (typical M4 flow:
 * compute once across N decks for the same template).
 *
 * The `dataHash` is sha256 of a canonical JSON of every input that
 * affects output bytes: binding (fields sorted for stability,
 * distributeEvenly), day, roomName, extension, and per-session
 * (title, timeslot, day, roomId, paginated speaker pages).
 */
export async function computeDeckHashes(input: DeckBuildInput): Promise<{
  templateHash: string;
  dataHash: string;
}> {
  const templateHash = input.precomputedTemplateHash
    ?? (await sha256Hex(input.templateBytes));
  const canonical = canonicalDeckInput(input);
  const dataBytes = new TextEncoder().encode(canonicalJson(canonical));
  const dataHash = await sha256Hex(dataBytes);
  return { templateHash, dataHash };
}

/**
 * Decide the next deck version based on the previous fingerprint (if any)
 * and the new hashes. Pure.
 *
 *   - No previous deck → v1, changed.
 *   - Hashes match previous → same version, NOT changed (M4 should skip).
 *   - Hashes differ → version+1, changed.
 */
export function nextDeckVersion(
  previous: DeckFingerprint | null,
  next: { templateHash: string; dataHash: string },
): { version: number; changed: boolean } {
  if (!previous) return { version: 1, changed: true };
  if (
    previous.templateHash === next.templateHash &&
    previous.dataHash === next.dataHash
  ) {
    return { version: previous.deckVersion, changed: false };
  }
  return { version: previous.deckVersion + 1, changed: true };
}

/**
 * Read the embedded fingerprint from an existing deck. Returns null when
 * the file isn't a deck we generated (no docProps/core.xml, no
 * <dc:description>, or the description doesn't carry our format header).
 *
 * Sync: only zip-read + string parse. No hashing happens here, so this
 * is cheap to call across many candidate files.
 */
export function readDeckFingerprint(pptxBytes: Uint8Array): DeckFingerprint | null {
  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(pptxBytes);
  } catch {
    return null;
  }
  const core = zip['docProps/core.xml'];
  if (!core) return null;
  const xml = strFromU8(core);
  const match = xml.match(/<dc:description\b[^>]*>([\s\S]*?)<\/dc:description>/);
  if (!match) return null;
  return parseFingerprintComment(unescapeXmlBasic(match[1]));
}

// ───── Canonicalization + hash helpers (pure) ────────────────────────────

function canonicalDeckInput(input: DeckBuildInput): unknown {
  // Sort the binding fields for stable serialisation. Within a role,
  // sort by frame (then by position for speakers).
  const sortedFields = [...input.binding.fields].sort((a, b) => {
    if (a.role !== b.role) return a.role < b.role ? -1 : 1;
    if (a.frame !== b.frame) return a.frame - b.frame;
    const ap = (a as { position?: number }).position ?? 0;
    const bp = (b as { position?: number }).position ?? 0;
    return ap - bp;
  });
  return {
    extension: normaliseExtension(input.extension ?? '.pptx'),
    day: input.day,
    roomName: input.roomName,
    binding: {
      fields: sortedFields,
      distributeEvenly: input.binding.distributeEvenly === true,
    },
    sessions: input.sessions.map((s) => ({
      title: s.title,
      timeslot: s.timeslot,
      day: s.session.day,
      roomId: s.session.roomId,
      speakerPages: s.speakerPages.map((page) =>
        page.map((sp) => ({ slot: sp.slot, speakerName: sp.speakerName })),
      ),
    })),
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicalize(obj[key]);
  }
  return out;
}

// ───── Fingerprint comment: render + parse ───────────────────────────────

function renderFingerprintComment(fp: DeckFingerprint): string {
  const lines = [
    `pptx-title-deck format=${fp.formatVersion}`,
    `deck-version=${fp.deckVersion}`,
    `template-sha256=${fp.templateHash}`,
    `data-sha256=${fp.dataHash}`,
  ];
  if (fp.generatedAt) lines.push(`generated-at=${fp.generatedAt}`);
  return lines.join('\n');
}

function parseFingerprintComment(text: string): DeckFingerprint | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const headerMatch = lines[0].match(/^pptx-title-deck\s+format=(\d+)$/);
  if (!headerMatch) return null;
  const fp: Partial<DeckFingerprint> = { formatVersion: Number(headerMatch[1]) };
  for (const line of lines.slice(1)) {
    const m = line.match(/^([a-z][a-z0-9-]*)=(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'deck-version') {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 1) fp.deckVersion = n;
    } else if (key === 'template-sha256' && /^[0-9a-f]{64}$/i.test(val)) {
      fp.templateHash = val.toLowerCase();
    } else if (key === 'data-sha256' && /^[0-9a-f]{64}$/i.test(val)) {
      fp.dataHash = val.toLowerCase();
    } else if (key === 'generated-at') {
      fp.generatedAt = val;
    }
  }
  if (
    fp.deckVersion === undefined ||
    fp.templateHash === undefined ||
    fp.dataHash === undefined
  ) {
    return null;
  }
  return fp as DeckFingerprint;
}

// ───── Fingerprint embed: mutate or create docProps/core.xml ─────────────

function embedFingerprint(
  zip: Record<string, Uint8Array>,
  fp: DeckFingerprint,
): void {
  const commentText = renderFingerprintComment(fp);
  const corePath = 'docProps/core.xml';
  if (zip[corePath] !== undefined) {
    zip[corePath] = strToU8(
      replaceCoreDescription(strFromU8(zip[corePath]), commentText),
    );
    return;
  }
  // No core.xml in template (Google Slides exports skip it). Create the
  // full scaffolding: core.xml + Content_Types Override + root rels entry.
  zip[corePath] = strToU8(newCoreXml(commentText));
  zip['[Content_Types].xml'] = strToU8(
    addCoreContentTypeOverride(strFromU8(zip['[Content_Types].xml'])),
  );
  const rootRelsPath = '_rels/.rels';
  if (zip[rootRelsPath] !== undefined) {
    zip[rootRelsPath] = strToU8(
      addCoreRootRel(strFromU8(zip[rootRelsPath])),
    );
  }
}

function replaceCoreDescription(coreXml: string, commentText: string): string {
  const escaped = escapeXml(commentText);
  if (/<dc:description\b[^>]*>[\s\S]*?<\/dc:description>/.test(coreXml)) {
    return coreXml.replace(
      /<dc:description\b[^>]*>[\s\S]*?<\/dc:description>/,
      `<dc:description>${escaped}</dc:description>`,
    );
  }
  if (/<dc:description\s*\/>/.test(coreXml)) {
    return coreXml.replace(
      /<dc:description\s*\/>/,
      `<dc:description>${escaped}</dc:description>`,
    );
  }
  // Insert before </cp:coreProperties>.
  return coreXml.replace(
    /<\/cp:coreProperties>/,
    `<dc:description>${escaped}</dc:description></cp:coreProperties>`,
  );
}

function newCoreXml(commentText: string): string {
  const escaped = escapeXml(commentText);
  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"`,
    ` xmlns:dc="http://purl.org/dc/elements/1.1/"`,
    ` xmlns:dcterms="http://purl.org/dc/terms/"`,
    ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    `<dc:description>${escaped}</dc:description>`,
    `</cp:coreProperties>`,
  ].join('');
}

function addCoreContentTypeOverride(ctXml: string): string {
  // Don't double-add.
  if (/PartName="\/docProps\/core\.xml"/.test(ctXml)) return ctXml;
  const override =
    `<Override ContentType="application/vnd.openxmlformats-package.core-properties+xml" ` +
    `PartName="/docProps/core.xml"/>`;
  return ctXml.replace('</Types>', override + '</Types>');
}

function addCoreRootRel(rootRelsXml: string): string {
  // Don't double-add.
  if (/Type="http:\/\/schemas\.openxmlformats\.org\/package\/2006\/relationships\/metadata\/core-properties"/.test(rootRelsXml)) {
    return rootRelsXml;
  }
  // Pick an rId that doesn't clash with existing ones.
  const used = new Set<string>();
  const re = /Id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rootRelsXml))) used.add(m[1]);
  let n = 100;
  while (used.has(`rId${n}`)) n++;
  const rId = `rId${n}`;
  const rel =
    `<Relationship Id="${rId}" ` +
    `Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" ` +
    `Target="docProps/core.xml"/>`;
  return rootRelsXml.replace('</Relationships>', rel + '</Relationships>');
}

// ───── Thumbnail embed ──────────────────────────────────────────────────

function embedThumbnail(zip: Record<string, Uint8Array>, jpegBytes: Uint8Array): void {
  zip['docProps/thumbnail.jpeg'] = jpegBytes;
  zip['[Content_Types].xml'] = strToU8(
    addThumbnailContentTypeOverride(strFromU8(zip['[Content_Types].xml'])),
  );
  const rootRelsPath = '_rels/.rels';
  if (zip[rootRelsPath] !== undefined) {
    zip[rootRelsPath] = strToU8(
      addThumbnailRootRel(strFromU8(zip[rootRelsPath])),
    );
  }
}

function addThumbnailContentTypeOverride(ctXml: string): string {
  if (/PartName="\/docProps\/thumbnail\.jpeg"/.test(ctXml)) return ctXml;
  const override = `<Override ContentType="image/jpeg" PartName="/docProps/thumbnail.jpeg"/>`;
  return ctXml.replace('</Types>', override + '</Types>');
}

function addThumbnailRootRel(rootRelsXml: string): string {
  if (/Type="http:\/\/schemas\.openxmlformats\.org\/package\/2006\/relationships\/metadata\/thumbnail"/.test(rootRelsXml)) {
    return rootRelsXml;
  }
  const used = new Set<string>();
  const re = /Id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rootRelsXml))) used.add(m[1]);
  let n = 200;
  while (used.has(`rId${n}`)) n++;
  const rId = `rId${n}`;
  const rel =
    `<Relationship Id="${rId}" ` +
    `Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" ` +
    `Target="docProps/thumbnail.jpeg"/>`;
  return rootRelsXml.replace('</Relationships>', rel + '</Relationships>');
}

function unescapeXmlBasic(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
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
