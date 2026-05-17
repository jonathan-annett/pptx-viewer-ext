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

export interface Thumbnail {
  mime: string;   // image/jpeg | image/png | image/gif | image/webp
  dataUrl: string;
}

export interface Flag {
  ok: boolean; // true = pass, false = warn
  label: string;
  detail: string;
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
  thumbnail?: Thumbnail;
  flags: {
    linkedMedia: Flag;
    showType: Flag;
    showMediaControls: Flag;
  };
  parseError?: string;
}

export interface FileInfo {
  fileName: string;
  size: number;
  mtime: number;
}

const UNKNOWN = 'unknown';

export async function parsePptx(bytes: Uint8Array, info: FileInfo): Promise<ParseResult> {
  const sha256 = await sha256Hex(bytes);

  let entries: Record<string, Uint8Array> = {};
  let parseError: string | undefined;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    parseError = `Could not unzip file: ${err instanceof Error ? err.message : String(err)}`;
  }

  const contentTypes = readText(entries['[Content_Types].xml']);
  const core = readText(entries['docProps/core.xml']);
  // <p:showPr> is written by PowerPoint into ppt/presProps.xml, NOT
  // ppt/presentation.xml. We also fall back to presentation.xml for tolerance
  // — the element shape is the same and some tooling writes it there.
  const presProps = readText(entries['ppt/presProps.xml']);
  const presentation = readText(entries['ppt/presentation.xml']);
  const showSettingsXml = presProps || presentation;

  const slideNames = Object.keys(entries)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(naturalSort);

  let hiddenSlideCount = 0;
  for (const name of slideNames) {
    if (isHiddenSlide(entries[name])) hiddenSlideCount++;
  }

  const author = extractElementText(core, 'dc:creator') ?? UNKNOWN;
  const lastModifiedBy = extractElementText(core, 'cp:lastModifiedBy') ?? UNKNOWN;

  const embeddedMedia = parseEmbeddedMedia(contentTypes);
  const thumbnail = extractThumbnail(entries);

  const linkedMediaFound = anyLinkedMedia(entries);
  const showType = parseShowType(showSettingsXml);
  const mediaControlsOn = parseShowMediaControls(showSettingsXml);

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
    thumbnail,
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
      showMediaControls: mediaControlsOn
        ? { ok: false, label: 'Show media controls', detail: 'showMediaCtrls is enabled (val="1") or unset — PowerPoint default is on' }
        : { ok: true, label: 'Show media controls', detail: 'showMediaCtrls is explicitly disabled (val="0")' },
    },
    parseError,
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

function humanSize(n: number): string {
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

function formatTime(ms: number): string {
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

function parseEmbeddedMedia(contentTypesXml: string): MediaEntry[] {
  if (!contentTypesXml) return [];
  const counts = new Map<string, number>();
  // ContentType attribute can appear before or after PartName; match either.
  const re = /ContentType="((?:audio|video)\/[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(contentTypesXml))) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mime, count]) => ({ mime, count }));
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

function bytesToBase64(bytes: Uint8Array): string {
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
