// Version-stamped thumbnail synthesised via OffscreenCanvas.
//
// Embedded into the generated deck at `docProps/thumbnail.jpeg` by the
// wired generator (M4.4) so that Finder / Explorer / vscode's file
// list show "v3 / 17:55:22" without anyone opening the file. PowerPoint
// regenerates the thumbnail from slide 1 the first time the file is
// opened-and-saved, so this version sticker shows up only until the
// deck is touched by PowerPoint itself — which is the expected
// lifecycle (the operator opens once to play, never to save).
//
// No vscode imports; uses web-platform OffscreenCanvas which is
// available in both the extension's web worker host AND in browser
// contexts. Not unit-testable under Node (no canvas), so we keep the
// renderer thin and split the date-formatting helper out as
// `formatThumbnailTime` for standalone testing.

// ───── Public API ────────────────────────────────────────────────────────

export interface ThumbnailOpts {
  /** Deck version (positive integer). Rendered as `v3`. */
  version: number;
  /** ISO-8601 timestamp; the renderer extracts HH:MM:SS in local time
   *  for the bottom line. Omit to skip the time line. */
  generatedAt?: string;
  /** Day token (`MON`) — top line. */
  day: string;
  /** Room display name (`Room 1`) — top line. */
  roomName: string;
}

const WIDTH = 256;
const HEIGHT = 192;

/**
 * Render a version-stamped thumbnail as JPEG bytes. Throws if
 * OffscreenCanvas / 2D context aren't available (caller falls back to
 * skipping thumbnail).
 */
export async function renderVersionThumbnail(opts: ThumbnailOpts): Promise<Uint8Array> {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas not available in this context');
  }
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context not available');

  // Background — dark slate so the bright text reads in OS file lists
  // that overlay a translucent panel on top.
  ctx.fillStyle = '#22324a';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Subtle accent stripe across the top.
  ctx.fillStyle = '#3a5378';
  ctx.fillRect(0, 0, WIDTH, 36);

  // Top line: "DAY / Room Name" — bold, slightly muted white.
  ctx.fillStyle = '#e8edf5';
  ctx.font = 'bold 18px -apple-system, Segoe UI, Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${opts.day} / ${truncate(opts.roomName, 18)}`, WIDTH / 2, 18);

  // Big centre: "v3" — large, white, dominant.
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 72px -apple-system, Segoe UI, Helvetica, Arial, sans-serif';
  ctx.fillText(`v${opts.version}`, WIDTH / 2, HEIGHT / 2 + 4);

  // Bottom line — generated-at time, or "Title Slides" label as fallback.
  ctx.fillStyle = '#9bb1d1';
  ctx.font = '500 16px -apple-system, Segoe UI, Helvetica, Arial, sans-serif';
  const bottomLine = opts.generatedAt
    ? formatThumbnailTime(opts.generatedAt)
    : 'Title Slides';
  ctx.fillText(bottomLine, WIDTH / 2, HEIGHT - 22);

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

// ───── Pure helpers (testable under Node) ───────────────────────────────

/**
 * Extract HH:MM:SS (local time) from an ISO-8601 string. Returns the empty
 * string for unparseable input so the renderer can degrade gracefully.
 */
export function formatThumbnailTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}
