// Parse a .pptx (a zip) into the small data shape the webview needs.
//
// Design notes:
// - We unzip with fflate (small, pure JS, works in a web worker).
// - For each datum we only decode the entries we need, and use targeted
//   regex/substring searches rather than a full XML parser. Real pptx files
//   are noisy; tolerant scanning is more robust than strict parsing.
// - Anything we cannot find resolves to "unknown" / empty rather than throwing.
//   The whole point of the tool is to inspect potentially-malformed files.

import { unzipSync, strFromU8 } from 'fflate';

export interface MediaEntry {
  mime: string;
  count: number;
}

/**
 * One row per embedded media part, joined to the slides that reference it.
 * Sibling of MediaEntry (which stays as a per-mime aggregate used by the
 * "Embedded media" metadata row + the showMediaControls validator). The
 * per-file shape is what the viewer's Extract media affordance needs — a
 * dropdown of individual files, each annotated with the slides that play
 * them.
 *
 * `slides` is sorted ascending; an empty array means the part is in the zip
 * but no slide rel references it (an "orphan" — still extractable, just
 * unused by the deck).
 *
 * `sizeBytes` reflects the unzipped (inflated) length of the part — fflate
 * gives us the decompressed bytes, which is what extraction actually writes.
 */
export interface MediaFileEntry {
  mediaPath: string;   // e.g. 'ppt/media/media1.mp4'
  mime: string;
  sizeBytes: number;
  slides: number[];
}

export interface Thumbnail {
  mime: string;   // image/jpeg | image/png | image/gif | image/webp
  dataUrl: string;
  /**
   * True when this thumbnail was synthesised by the M-VE-3 fallback path
   * (coloured box + title text) rather than extracted from
   * `docProps/thumbnail.*` in the zip. Diagnostic only — the viewer treats
   * both kinds identically. Absent on real thumbnails extracted from the
   * file; absent on records written before M-VE-3 landed (interpreted as
   * "real" by the renderer).
   */
  synthesised?: boolean;
}

/**
 * Hint emitted by parsePptx when a file has no embeddable thumbnail in the
 * zip (no `docProps/thumbnail.{jpg,jpeg,png,gif,webp}`, or only an .emf the
 * viewer can't render). The webview consumes the hint, renders a fallback
 * thumbnail on canvas, and posts the result back; the extension caches the
 * synthesised data URL into the parse cache keyed by sha256 so subsequent
 * opens of the same content don't re-render.
 *
 * Set ONLY when `thumbnail` is undefined AND `parseError` is undefined —
 * a file the parser couldn't unzip at all has nothing meaningful to title.
 */
export interface SynthesisHint {
  /**
   * Slide-1 title text if `extractFirstSlideTitle` found one; absent
   * otherwise. The webview falls back to the filename (minus extension)
   * then "Untitled" — those display-side decisions don't belong in the
   * cached content-determined shape.
   */
  title?: string;
}

export interface Flag {
  ok: boolean; // true = pass, false = warn
  label: string;
  detail: string;
}

/**
 * Per-phase timings (milliseconds) collected during a single parsePptx call.
 * Populated unconditionally so the host can decide what to log — used by the
 * pptx viewer to surface a one-line breakdown that informs the parse-cache
 * design (which steps actually dominate on a 100MB+ deck).
 *
 * Phases:
 *  - hashMs       sha256 of the original bytes (crypto.subtle).
 *  - unzipMs      fflate `unzipSync` over the full payload.
 *  - xmlDecodeMs  strFromU8 on the 4 small XML parts we read directly
 *                 (Content_Types, core.xml, presProps.xml, presentation.xml).
 *                 Slide-rels lookups inside parseEmbeddedMedia decode on
 *                 demand and land in `mediaMs` below.
 *  - slideScanMs  listing slide entries + hidden-flag substring check on each
 *                 (we decode just enough to find `show="0"`).
 *  - metadataMs   author + lastModifiedBy regex extraction from core.xml.
 *  - mediaMs      embeddedMedia walk + thumbnail extract + linked-media scan
 *                 (the last includes a regex over every slide's _rels file).
 *  - showPropsMs  parseShowType + parseShowMediaControls.
 *  - totalMs      end-to-end parsePptx wall time (slightly larger than the
 *                 sum: object construction + the ParseResult assembly itself).
 *
 * The integers here are `performance.now()` deltas, so sub-millisecond noise
 * is normal; the absolute values matter, not the precision.
 */
export interface ParseTimings {
  hashMs: number;
  unzipMs: number;
  xmlDecodeMs: number;
  slideScanMs: number;
  metadataMs: number;
  mediaMs: number;
  showPropsMs: number;
  totalMs: number;
}

export interface ParseResult {
  fileName: string;
  size: number;
  sizeHuman: string;
  mtime: number;
  mtimeHuman: string;
  sha256: string;
  slideCount: number;
  hiddenSlideCount: number;
  author: string;
  lastModifiedBy: string;
  embeddedMedia: MediaEntry[];
  /**
   * Per-file list of embedded media parts joined to the slides that
   * reference them. Sibling of `embeddedMedia` (which aggregates by mime
   * type). Consumed by the viewer's Extract media affordance; the validator
   * and metadata-row paths use `embeddedMedia`.
   */
  mediaFiles: MediaFileEntry[];
  thumbnail?: Thumbnail;
  /**
   * M-VE-3 fallback hint. Emitted when the zip has no usable thumbnail and
   * the parser otherwise succeeded — the webview uses it to render a
   * coloured box + title on canvas. Content-determined, so it rides
   * through the parse cache via parseCache.project/hydrate.
   */
  synthesisHint?: SynthesisHint;
  /**
   * Concatenated text from every `<a:t>` run on the first non-hidden
   * slide — title placeholder, body, text boxes, table cells, grouped
   * shapes all included. Excludes speaker notes and master-slide
   * content (footers, slide numbers) by construction — we only read
   * `ppt/slides/slideN.xml`, never `ppt/notesSlides/` or
   * `ppt/slideMasters/`.
   *
   * Empty string when:
   *   - no visible slides exist
   *   - first visible slide has no `<a:t>` runs (image-only intro)
   *   - parsePptx failed earlier (parseError set)
   *
   * Used by the pptx-search subsystem (`src/search/`) to build the
   * per-file projection. Content-determined, so it rides through
   * parseCache.project/hydrate alongside the other parsed fields.
   *
   * Whitespace is collapsed and the result is capped at 4 KB to bound
   * IDB write size on slides that contain unusually large transcripts.
   */
  firstVisibleSlideText: string;
  flags: {
    linkedMedia: Flag;
    showType: Flag;
    showMediaControls: Flag;
  };
  parseError?: string;
  /**
   * Per-phase timings. Always populated by parsePptx — informational only,
   * does not affect rendering or sync behaviour. See ParseTimings above for
   * what each phase covers.
   */
  timings?: ParseTimings;
}

export interface FileInfo {
  fileName: string;
  size: number;
  mtime: number;
}

const UNKNOWN = 'unknown';

/**
 * Well-known SHA-256 of an empty byte sequence. Inlined here so the zero-byte
 * short-circuit can skip the actual hash compute. Kept in sync with
 * `EMPTY_FILE_SHA256` in `src/sync/snapshot.ts` (the placeholder registry's
 * implicit default). The value is mathematically fixed — never edit either.
 */
const EMPTY_FILE_SHA256_LITERAL =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export async function parsePptx(bytes: Uint8Array, info: FileInfo): Promise<ParseResult> {
  // Zero-byte short-circuit. Such files are always placeholders (the empty
  // sha is the registry's implicit default) and the rest of the parse pipe
  // can only produce a misleading "Could not unzip" error from the failed
  // unzipSync attempt. Skipping it shaves the crypto.subtle hash compute,
  // the throwing unzip, and the cascade of zero-valued field reads. The
  // viewer's banner-precedence logic (isPlaceholder beats parseError beats
  // normal) then renders the info banner cleanly without leaning on the
  // "placeholder beats parseError" fallback.
  if (bytes.length === 0) {
    return emptyFileParseResult(info);
  }
  // Phase timings collected via performance.now() — see ParseTimings above
  // for what each phase covers. Pure measurement: no parse behaviour changes,
  // and the host decides whether to surface them.
  const t0 = performance.now();

  const tHashStart = performance.now();
  const sha256 = await sha256Hex(bytes);
  const hashMs = performance.now() - tHashStart;

  let entries: Record<string, Uint8Array> = {};
  let parseError: string | undefined;
  const tUnzipStart = performance.now();
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    parseError = `Could not unzip file: ${err instanceof Error ? err.message : String(err)}`;
  }
  const unzipMs = performance.now() - tUnzipStart;

  const tXmlStart = performance.now();
  const contentTypes = readText(entries['[Content_Types].xml']);
  const core = readText(entries['docProps/core.xml']);
  // <p:showPr> is written by PowerPoint into ppt/presProps.xml, NOT
  // ppt/presentation.xml. We also fall back to presentation.xml for tolerance
  // — the element shape is the same and some tooling writes it there.
  const presProps = readText(entries['ppt/presProps.xml']);
  const presentation = readText(entries['ppt/presentation.xml']);
  const showSettingsXml = presProps || presentation;
  const xmlDecodeMs = performance.now() - tXmlStart;

  const tSlideStart = performance.now();
  const slideNames = Object.keys(entries)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(naturalSort);

  let hiddenSlideCount = 0;
  let firstVisibleSlideName: string | undefined;
  for (const name of slideNames) {
    if (isHiddenSlide(entries[name])) {
      hiddenSlideCount++;
    } else if (firstVisibleSlideName === undefined) {
      firstVisibleSlideName = name;
    }
  }
  const firstVisibleSlideText = firstVisibleSlideName
    ? extractAllSlideText(entries[firstVisibleSlideName])
    : '';
  const slideScanMs = performance.now() - tSlideStart;

  const tMetaStart = performance.now();
  const author = extractElementText(core, 'dc:creator') ?? UNKNOWN;
  const lastModifiedBy = extractElementText(core, 'cp:lastModifiedBy') ?? UNKNOWN;
  const metadataMs = performance.now() - tMetaStart;

  const tMediaStart = performance.now();
  const embeddedMedia = parseEmbeddedMedia(contentTypes, entries);
  const mediaFiles = buildMediaFileEntries(contentTypes, entries);
  const thumbnail = extractThumbnail(entries);
  const linkedMediaFound = anyLinkedMedia(entries);
  // M-VE-3: when there's no in-file thumbnail and parsing otherwise worked,
  // emit a hint so the webview can synthesise a fallback. Extraction is
  // best-effort — extractFirstSlideTitle returns undefined for missing /
  // malformed slide XML and we just drop the title from the hint, leaving
  // the webview to fall back to the filename.
  const synthesisHint: SynthesisHint | undefined =
    !thumbnail && !parseError
      ? (() => {
          const title = extractFirstSlideTitle(entries);
          return title ? { title } : {};
        })()
      : undefined;
  const mediaMs = performance.now() - tMediaStart;

  const tShowStart = performance.now();
  const showType = parseShowType(showSettingsXml);
  const mediaControlsOn = parseShowMediaControls(showSettingsXml);
  const showPropsMs = performance.now() - tShowStart;
  // showMediaCtrls only matters when there's embedded video for the controls
  // to attach to. A file with the setting on but no video has nothing to
  // show — so we don't warn. Audio doesn't get an on-screen controls bar in
  // PowerPoint slideshow mode, so audio-only files are excluded here too.
  const hasEmbeddedVideo = embeddedMedia.some((m) => m.mime.startsWith('video/') && m.count > 0);

  return {
    fileName: info.fileName,
    size: info.size,
    sizeHuman: humanSize(info.size),
    mtime: info.mtime,
    mtimeHuman: formatTime(info.mtime),
    sha256,
    slideCount: slideNames.length,
    hiddenSlideCount,
    author,
    lastModifiedBy,
    embeddedMedia,
    mediaFiles,
    thumbnail,
    synthesisHint,
    firstVisibleSlideText,
    flags: {
      linkedMedia: linkedMediaFound
        ? { ok: false, label: 'Linked media', detail: 'External video/audio/media relationship present on at least one slide' }
        : { ok: true, label: 'Linked media', detail: 'No external media relationships found' },
      showType:
        showType === 'kiosk'
          ? { ok: false, label: 'Show type', detail: 'Kiosk mode (<p:kiosk/>) is set' }
          : showType === 'browse'
          ? { ok: false, label: 'Show type', detail: 'Window/browse mode (<p:browse/>) is set' }
          : { ok: true, label: 'Show type', detail: 'Presenter mode (default)' },
      showMediaControls:
        mediaControlsOn && hasEmbeddedVideo
          ? {
              ok: false,
              label: 'Show media controls',
              detail: 'showMediaCtrls is enabled (val="1") or unset (PowerPoint default), and embedded video is present',
            }
          : !mediaControlsOn
          ? {
              ok: true,
              label: 'Show media controls',
              detail: 'showMediaCtrls is explicitly disabled (val="0")',
            }
          : {
              ok: true,
              label: 'Show media controls',
              detail: 'showMediaCtrls is on, but no embedded video — controls have nothing to attach to',
            },
    },
    parseError,
    timings: {
      hashMs,
      unzipMs,
      xmlDecodeMs,
      slideScanMs,
      metadataMs,
      mediaMs,
      showPropsMs,
      totalMs: performance.now() - t0,
    },
  };
}

/**
 * Synthesise a ParseResult for a zero-byte file. Such files never carry
 * pptx structure but they are real artifacts in the workspace (Explorer's
 * "New PowerPoint Presentation" right-click creates them, and operators
 * use them as agenda placeholders). The placeholder registry's implicit
 * default sha catches every zero-byte file, so the viewer renders the
 * info banner and the sync engine treats it like any other deck.
 *
 * All flags default to OK (there is nothing to validate); parseError is
 * intentionally undefined so the banner-precedence logic doesn't fall
 * through to the corrupt path; timings are zero (we did no work).
 */
function emptyFileParseResult(info: FileInfo): ParseResult {
  return {
    fileName: info.fileName,
    size: info.size,
    sizeHuman: humanSize(info.size),
    mtime: info.mtime,
    mtimeHuman: formatTime(info.mtime),
    sha256: EMPTY_FILE_SHA256_LITERAL,
    slideCount: 0,
    hiddenSlideCount: 0,
    author: UNKNOWN,
    lastModifiedBy: UNKNOWN,
    embeddedMedia: [],
    mediaFiles: [],
    firstVisibleSlideText: '',
    flags: {
      linkedMedia: { ok: true, label: 'Linked media', detail: 'Empty file' },
      showType: { ok: true, label: 'Show type', detail: 'Empty file' },
      showMediaControls: { ok: true, label: 'Show media controls', detail: 'Empty file' },
    },
    timings: {
      hashMs: 0,
      unzipMs: 0,
      xmlDecodeMs: 0,
      slideScanMs: 0,
      metadataMs: 0,
      mediaMs: 0,
      showPropsMs: 0,
      totalMs: 0,
    },
  };
}

// ---------- helpers ----------

function readText(bytes: Uint8Array | undefined): string {
  if (!bytes) return '';
  try {
    return strFromU8(bytes);
  } catch {
    return '';
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // crypto.subtle is available in the VS Code web worker context.
  // Cast to BufferSource — TS 5.7's generic Uint8Array<ArrayBufferLike> doesn't
  // satisfy the BufferSource constraint directly, but the runtime value is fine.
  // Cast through `unknown` to sidestep TS 5.7's generic Uint8Array<ArrayBufferLike>
  // vs BufferSource (which requires ArrayBuffer, not SharedArrayBuffer). The runtime
  // value is a normal Uint8Array — fine for crypto.subtle.
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
}

export function formatTime(ms: number): string {
  if (!ms) return UNKNOWN;
  try {
    return new Date(ms).toISOString();
  } catch {
    return UNKNOWN;
  }
}

function naturalSort(a: string, b: string): number {
  const na = parseInt(a.match(/(\d+)\.xml$/)?.[1] ?? '0', 10);
  const nb = parseInt(b.match(/(\d+)\.xml$/)?.[1] ?? '0', 10);
  return na - nb;
}

function extractElementText(xml: string, tag: string): string | undefined {
  if (!xml) return undefined;
  // Escape `:` and other characters by using a literal alternation. `:` is fine in regex.
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)</${escaped}>`);
  const m = xml.match(re);
  if (!m) return undefined;
  const inner = decodeXmlEntities(m[1]).trim();
  return inner.length > 0 ? inner : undefined;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Count embedded audio/video parts.
//
// OOXML's [Content_Types].xml has two forms:
//   <Default Extension="mp4" ContentType="video/mp4"/>     — one tag, applies
//                                                            to every .mp4 part
//                                                            in the zip
//   <Override PartName="/ppt/media/clip1.mp4" ContentType="video/mp4"/>
//                                                          — one tag per part
//
// PowerPoint uses Default-by-extension for binary media (the per-extension
// declaration is shorter than one Override per part). Counting raw
// ContentType="..." occurrences therefore under-counts Default-form files
// dramatically: two .mp4 parts share a single Default entry and got reported
// as "video/mp4 × 1". We resolve Default entries against the actual zip
// listing (parts under ppt/media/) so the count reflects reality.
function parseEmbeddedMedia(contentTypesXml: string, entries: Record<string, Uint8Array>): MediaEntry[] {
  if (!contentTypesXml) return [];
  const counts = new Map<string, number>();

  // Pass 1 — collect PartNames covered by an <Override>. The OOXML spec says
  // Override takes precedence over Default for a given PartName; we exclude
  // those parts from the Default count so we don't double-count.
  const overriddenParts = new Set<string>();
  const overrideRe = /<Override\b([^>]*?)\/?>/g;
  let om: RegExpExecArray | null;
  while ((om = overrideRe.exec(contentTypesXml))) {
    const pn = /\bPartName="([^"]+)"/.exec(om[1])?.[1];
    if (pn) overriddenParts.add(pn);
  }

  // Bucket zip parts under ppt/media/ by lowercase extension. (Media parts
  // live there in real-world pptx; restricting here avoids counting non-media
  // parts that happen to share an extension.) Skip parts covered by Override.
  const partsByExt = new Map<string, number>();
  for (const name of Object.keys(entries)) {
    const em = /^ppt\/media\/[^/]+\.([a-z0-9]+)$/i.exec(name);
    if (!em) continue;
    if (overriddenParts.has('/' + name)) continue;
    const ext = em[1].toLowerCase();
    partsByExt.set(ext, (partsByExt.get(ext) ?? 0) + 1);
  }

  // Pass 2 — Default entries. Add `partsByExt[ext]` to that mime's count.
  const defaultRe = /<Default\b([^>]*?)\/?>/g;
  let dm: RegExpExecArray | null;
  while ((dm = defaultRe.exec(contentTypesXml))) {
    const attrs = dm[1];
    const ext = /\bExtension="([^"]+)"/.exec(attrs)?.[1]?.toLowerCase();
    const mime = /\bContentType="((?:audio|video)\/[^"]+)"/.exec(attrs)?.[1];
    if (!ext || !mime) continue;
    const n = partsByExt.get(ext) ?? 0;
    if (n > 0) counts.set(mime, (counts.get(mime) ?? 0) + n);
  }

  // Pass 3 — Override entries. Each audio/video Override is exactly one part.
  const overrideMimeRe = /<Override\b([^>]*?)\/?>/g;
  let oom: RegExpExecArray | null;
  while ((oom = overrideMimeRe.exec(contentTypesXml))) {
    const mime = /\bContentType="((?:audio|video)\/[^"]+)"/.exec(oom[1])?.[1];
    if (!mime) continue;
    counts.set(mime, (counts.get(mime) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mime, count]) => ({ mime, count }));
}

// Build the per-file media list with slide-of-use annotations.
//
// Why this is separate from parseEmbeddedMedia: the aggregate counts there
// answer "what kinds of media are in the deck and how many of each" (used by
// the metadata row + the showMediaControls validator). The Extract media UI
// needs a different shape: one row per part, with the slides that play it.
// Keeping the two passes separate keeps each readable; the cost is one extra
// O(entries) loop, which is irrelevant next to unzip + hash.
//
// MIME resolution mirrors parseEmbeddedMedia (Override wins per-part; Default
// fills in by extension). We only emit rows for parts under ppt/media/ with a
// resolvable audio/* or video/* mime — image parts are ignored here, since
// the Extract UI is scoped to video for v1 and the aggregate row already
// shows "image/png × N" for the curious.
//
// Slides are joined by parsing each ppt/slides/_rels/slideN.xml.rels:
// Relationship entries whose Target resolves to a ppt/media/<basename> get
// pushed into the matching media row's slides[]. Targets are typically
// '../media/foo.mp4' (relative to ppt/slides/); we resolve them against the
// rels file's directory before matching against the absolute media path.
function buildMediaFileEntries(
  contentTypesXml: string,
  entries: Record<string, Uint8Array>,
): MediaFileEntry[] {
  // Resolve mime for each ppt/media/* part. Same precedence as parseEmbeddedMedia:
  //   - Override PartName="/ppt/media/foo.mp4" wins
  //   - else Default Extension="mp4" applies
  //   - else the part is skipped (we only care about audio/video here)
  const overrideByPart = new Map<string, string>();
  if (contentTypesXml) {
    const overrideRe = /<Override\b([^>]*?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = overrideRe.exec(contentTypesXml))) {
      const partName = /\bPartName="([^"]+)"/.exec(m[1])?.[1];
      const mime = /\bContentType="([^"]+)"/.exec(m[1])?.[1];
      if (partName && mime) overrideByPart.set(partName, mime);
    }
  }
  const defaultByExt = new Map<string, string>();
  if (contentTypesXml) {
    const defaultRe = /<Default\b([^>]*?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = defaultRe.exec(contentTypesXml))) {
      const ext = /\bExtension="([^"]+)"/.exec(m[1])?.[1]?.toLowerCase();
      const mime = /\bContentType="([^"]+)"/.exec(m[1])?.[1];
      if (ext && mime) defaultByExt.set(ext, mime);
    }
  }

  // First pass: collect candidate media parts (audio/video only).
  const rows = new Map<string, MediaFileEntry>(); // keyed by mediaPath
  for (const name of Object.keys(entries)) {
    const em = /^ppt\/media\/[^/]+\.([a-z0-9]+)$/i.exec(name);
    if (!em) continue;
    const ext = em[1].toLowerCase();
    const mime = overrideByPart.get('/' + name) ?? defaultByExt.get(ext);
    if (!mime) continue;
    if (!/^audio\//i.test(mime) && !/^video\//i.test(mime)) continue;
    rows.set(name, {
      mediaPath: name,
      mime,
      sizeBytes: entries[name].byteLength,
      slides: [],
    });
  }
  if (rows.size === 0) return [];

  // Second pass: walk every slide's rels file, push the slide number onto any
  // row whose mediaPath the Target resolves to. Slides without rels (some
  // tooling omits the file when there are no relationships) just don't
  // contribute.
  const slidesByMedia = new Map<string, Set<number>>();
  for (const name of Object.keys(entries)) {
    const relsMatch = /^ppt\/slides\/_rels\/slide(\d+)\.xml\.rels$/.exec(name);
    if (!relsMatch) continue;
    const slideNumber = parseInt(relsMatch[1], 10);
    const relsXml = readText(entries[name]);
    if (!relsXml) continue;
    // Iterate relationships; resolve each Target against the rels file's
    // directory (ppt/slides/_rels/) so '../media/foo.mp4' becomes
    // 'ppt/media/foo.mp4' for the lookup. Skip external (TargetMode="External")
    // — those are handled by anyLinkedMedia and don't refer to zip parts.
    const relRe = /<Relationship\b([^>]*)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = relRe.exec(relsXml))) {
      const attrs = m[1];
      if (/\bTargetMode="External"/.test(attrs)) continue;
      const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
      if (!target) continue;
      const resolved = resolveRelTarget('ppt/slides/_rels/', target);
      if (!rows.has(resolved)) continue;
      let set = slidesByMedia.get(resolved);
      if (!set) {
        set = new Set();
        slidesByMedia.set(resolved, set);
      }
      set.add(slideNumber);
    }
  }

  for (const [mediaPath, slideSet] of slidesByMedia) {
    const row = rows.get(mediaPath);
    if (row) row.slides = Array.from(slideSet).sort((a, b) => a - b);
  }

  // Stable order: by mediaPath ascending so output is deterministic across
  // runs and zip iteration order changes.
  return Array.from(rows.values()).sort((a, b) =>
    a.mediaPath.localeCompare(b.mediaPath),
  );
}

// Resolve a rels Target (e.g. '../media/foo.mp4') against the directory that
// contains the rels file ('ppt/slides/_rels/'). Strips leading './', handles
// '../' by popping a path segment, ignores absolute Targets (starting with
// '/') by treating them as already-zip-absolute minus the leading slash.
function resolveRelTarget(relsDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  // Normalise relsDir to a trailing slash and split into segments. Rels live
  // alongside the part they describe: ppt/slides/_rels/slide1.xml.rels →
  // the Target is resolved from ppt/slides/ (one level up from _rels/), since
  // the rels file itself "annotates" ppt/slides/slide1.xml. We model this by
  // popping `_rels/` from the directory before walking.
  const baseSegs = relsDir.replace(/\/+$/, '').split('/');
  if (baseSegs[baseSegs.length - 1] === '_rels') baseSegs.pop();
  const segs = baseSegs.slice();
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segs.length > 0) segs.pop();
      continue;
    }
    segs.push(part);
  }
  return segs.join('/');
}

function anyLinkedMedia(entries: Record<string, Uint8Array>): boolean {
  for (const name of Object.keys(entries)) {
    if (!/^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name)) continue;
    const xml = readText(entries[name]);
    if (!xml) continue;
    if (relsHasExternalMedia(xml)) return true;
  }
  return false;
}

function relsHasExternalMedia(relsXml: string): boolean {
  // Iterate <Relationship .../> tags; check Type and TargetMode independently
  // so we don't depend on attribute order.
  const re = /<Relationship\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(relsXml))) {
    const attrs = m[1];
    const typeMatch = /\bType="[^"]*\/(video|audio|media)"/.test(attrs);
    const external = /\bTargetMode="External"/.test(attrs);
    if (typeMatch && external) return true;
  }
  return false;
}

function getShowPrBlock(presXml: string): string | null {
  if (!presXml) return null;
  // Self-closing form: <p:showPr ... />
  const selfClose = presXml.match(/<p:showPr\b[^>]*\/>/);
  if (selfClose) return selfClose[0];
  const full = presXml.match(/<p:showPr\b[^>]*>[\s\S]*?<\/p:showPr>/);
  return full ? full[0] : null;
}

function parseShowType(presXml: string): 'presenter' | 'browse' | 'kiosk' {
  const block = getShowPrBlock(presXml);
  if (!block) return 'presenter';
  if (/<p:kiosk\b/.test(block)) return 'kiosk';
  if (/<p:browse\b/.test(block)) return 'browse';
  return 'presenter';
}

// PowerPoint encodes the "show media controls during slideshow" setting as a
// p14 extension element nested inside <p:showPr>:
//
//   <p:showPr>
//     <p:extLst>
//       <p:ext uri="{2FDB2607-1784-4EEB-B798-7EB5836EED8A}">
//         <p14:showMediaCtrls val="1"/>     (or val="0")
//
// Note: element name is "showMediaCtrls" (no -ols), with val="0|1|true|false".
// Per ECMA-376 the value defaults to true when absent — and that matches the
// samples in samples/: "Has media controls.pptx" has no <p:showPr> at all but
// the user named it as the warn case. So:
//   - showPr absent, or showPr present without a showMediaCtrls element → ON
//   - explicit val="0" / "false"                                         → OFF
//   - explicit val="1" / "true"                                          → ON
// We also keep a tolerant fallback for an attribute-style spelling on showPr
// in case some other tool writes it that way.
function parseShowMediaControls(presXml: string): boolean {
  const block = getShowPrBlock(presXml);
  if (!block) return true;
  // Attribute-style fallback (not used by PowerPoint but harmless to support).
  const attr = block.match(/\bshowMediaControls="(1|0|true|false)"/i);
  if (attr) return attr[1] === '1' || attr[1].toLowerCase() === 'true';
  // p14 extension element form (what PowerPoint actually writes).
  const ext = block.match(/<(?:[A-Za-z0-9_-]+:)?showMediaCtrls\b[^>]*\bval="(1|0|true|false)"/i);
  if (ext) return ext[1] === '1' || ext[1].toLowerCase() === 'true';
  // Element present but no val (rare): defaults to true.
  if (/<(?:[A-Za-z0-9_-]+:)?showMediaCtrls\b/i.test(block)) return true;
  // showPr present but no explicit setting → ECMA-376 default = true.
  return true;
}

// Pull docProps/thumbnail.<ext> out of the zip and turn it into a data URL.
// PowerPoint usually writes thumbnail.jpeg; older/Office variants sometimes
// emit .emf, which browsers can't render — those are skipped. A pptx with no
// thumbnail (e.g. one synthesised in tests) just returns undefined.
function extractThumbnail(entries: Record<string, Uint8Array>): Thumbnail | undefined {
  const supported: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  for (const name of Object.keys(entries)) {
    const m = /^docProps\/thumbnail\.([a-z0-9]+)$/i.exec(name);
    if (!m) continue;
    const mime = supported[m[1].toLowerCase()];
    if (!mime) continue; // skip emf etc.
    const bytes = entries[name];
    if (!bytes || bytes.length === 0) continue;
    return { mime, dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}` };
  }
  return undefined;
}

/**
 * Pull the slide-1 title text from `ppt/slides/slide1.xml`, if it has one.
 *
 * Used by the M-VE-3 synthesised-thumbnail path: when the zip lacks a usable
 * thumbnail, the webview renders a coloured box with the title text on it,
 * falling back to the filename (caller's responsibility) when this returns
 * undefined.
 *
 * Heuristic, not a full slide-XML parser:
 *   - Walk every <p:sp> element on slide 1.
 *   - Pick the first one whose nvSpPr block contains
 *     `<p:ph type="title"/>` or `<p:ph type="ctrTitle"/>`. PowerPoint uses
 *     these placeholder types for the slide title; layout-defined titles
 *     without an explicit type are deliberately skipped (we can't tell
 *     them apart from arbitrary text shapes without a deeper parse).
 *   - Concatenate the text content of every `<a:t>` run inside that shape,
 *     separated by spaces so paragraph breaks don't glue runs together.
 *   - Decode XML entities, collapse whitespace, cap at 120 chars to dodge
 *     pathological inputs that would dominate the canvas.
 *
 * Tolerant of:
 *   - Missing slide1.xml → undefined.
 *   - Slides without a title placeholder → undefined.
 *   - Malformed XML — regex over the bytes; broken tags just fail to match.
 *   - Empty title text → undefined (treat as "no title").
 */
export function extractFirstSlideTitle(entries: Record<string, Uint8Array>): string | undefined {
  const slideXml = readText(entries['ppt/slides/slide1.xml']);
  if (!slideXml) return undefined;
  // Iterate every <p:sp>...</p:sp> shape on the slide. The shape's full
  // content (including nested nvSpPr + txBody) lives between the tags;
  // self-closing <p:sp/> is not a valid shape so we skip it.
  const shapeRe = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g;
  let shapeMatch: RegExpExecArray | null;
  while ((shapeMatch = shapeRe.exec(slideXml))) {
    const shape = shapeMatch[1];
    // Title or centred-title placeholder. Match both self-closing and
    // open-form ph tags — both exist in the wild. Anchor on the type
    // attribute so we don't pick up body placeholders.
    if (!/<p:ph\b[^>]*\btype="(?:title|ctrTitle)"/.test(shape)) continue;
    // Collect every text run. <a:t>…</a:t> wraps the human-readable text;
    // <a:p> wraps paragraphs. Joining runs with a space is a deliberate
    // compromise — "Hello" + "world" → "Hello world", which reads correctly
    // even when the original was a single run that got split for styling.
    const runRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
    const parts: string[] = [];
    let runMatch: RegExpExecArray | null;
    while ((runMatch = runRe.exec(shape))) {
      const text = decodeXmlEntities(runMatch[1]);
      if (text.length > 0) parts.push(text);
    }
    if (parts.length === 0) return undefined;
    // Join with a single space, collapse internal whitespace runs, trim.
    let joined = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (joined.length === 0) return undefined;
    if (joined.length > 120) joined = joined.slice(0, 120);
    return joined;
  }
  return undefined;
}

/**
 * Pull every `<a:t>` text run out of a single slide's XML and return the
 * concatenated, whitespace-collapsed result. Powers the
 * `firstVisibleSlideText` field on ParseResult (used by the pptx-search
 * subsystem).
 *
 * Distinct from `extractFirstSlideTitle`, which only collects the title
 * placeholder. This one is broader on purpose: search wants body text,
 * text boxes, table cells, and grouped shapes as well — they all live as
 * `<a:t>` runs in the slide XML and get included.
 *
 * Notes-slides and master-slide content are NOT in slide XML — they live
 * at `ppt/notesSlides/notesSlideN.xml` and `ppt/slideMasters/*.xml`.
 * Callers passing the slide-N bytes therefore exclude them by
 * construction.
 *
 * Tolerant of:
 *   - Missing / empty input → ''
 *   - Malformed XML — regex over bytes; broken tags just fail to match.
 *
 * The output is whitespace-collapsed (any run of whitespace → single
 * space, leading/trailing stripped) and capped at 4 KB to bound IDB
 * write size for unusually large transcripts. The cap is well above
 * realistic slide-text sizes (a dense slide rarely exceeds ~1 KB of
 * extracted text) but small enough that pathological inputs don't blow
 * up the projection store.
 */
export function extractAllSlideText(slideBytes: Uint8Array | undefined): string {
  if (!slideBytes) return '';
  const xml = readText(slideBytes);
  if (!xml) return '';
  const runRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(xml))) {
    const text = decodeXmlEntities(m[1]);
    if (text.length > 0) parts.push(text);
  }
  if (parts.length === 0) return '';
  let joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (joined.length === 0) return '';
  const CAP_BYTES = 4096;
  if (joined.length > CAP_BYTES) joined = joined.slice(0, CAP_BYTES);
  return joined;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to keep String.fromCharCode argument list bounded — large
  // thumbnails would otherwise blow the call-stack limit on .apply.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  // btoa is available in the VS Code web worker context and in Node 16+.
  return btoa(binary);
}

function isHiddenSlide(bytes: Uint8Array | undefined): boolean {
  if (!bytes) return false;
  const head = strFromU8(bytes.subarray(0, Math.min(bytes.length, 500)));
  return /<p:sld\b[^>]*\bshow="0"/.test(head);
}
