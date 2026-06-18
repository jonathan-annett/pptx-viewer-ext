// Pure helpers for the M-VE-3 synthesised-thumbnail path.
//
// Why this module exists:
//   - The actual canvas render happens in the webview (the extension-host
//     worker has no DOM). But the *math* — how to pick a colour from a sha,
//     how to lay text out on the canvas — is pure and benefits from being
//     tested under plain Node via tsx.
//   - Keeping the deterministic parts here also means we have a single
//     source of truth for "same file → same thumbnail across sessions";
//     the webview just calls these helpers and draws the result.
//
// No DOM, no vscode, no Node-only APIs — runs under both web-worker and
// plain Node.

/**
 * Deterministic HSL triple from the first 6 hex characters of a sha256.
 *
 *   - Hue: 0–359, derived from the leading 24 bits as a modulo. Same sha
 *     always yields the same hue across sessions and machines.
 *   - Saturation/lightness: fixed mid-tones (60% / 45%) chosen so the
 *     resulting box reads well in both light and dark VS Code themes
 *     without needing to follow the theme. The thumbnail is encoded as
 *     JPEG at synthesis time — we can't recolour later.
 *
 * Callers that want a CSS string can format as `hsl(${h} ${s}% ${l}%)`.
 */
export function deterministicHslFromSha(sha256: string): { h: number; s: number; l: number } {
  // Accept the full 64-char hash or any prefix ≥ 6 chars. Anything shorter
  // is a programmer error; we throw rather than silently picking grey.
  if (!/^[0-9a-f]{6}/i.test(sha256)) {
    throw new Error(`deterministicHslFromSha: need at least 6 hex chars, got ${sha256.slice(0, 6)}`);
  }
  const n = parseInt(sha256.slice(0, 6), 16);
  return { h: n % 360, s: 60, l: 45 };
}

/**
 * Line-fitting layout for synthesised thumbnail text.
 *
 * Inputs:
 *   - text: the title (or fallback). Stripped + collapsed-whitespace by the
 *     caller; we don't re-normalise.
 *   - opts.maxWidth: pixel width the text must not exceed (per line).
 *   - opts.maxLines: hard cap on the number of lines (≥ 1).
 *   - opts.startFontPx: starting font size in pixels.
 *   - opts.minFontPx: smallest font we'll shrink to (≥ 6). Below this we
 *     stop shrinking and accept that the last line may be truncated by the
 *     caller (we still return a layout, just with the smallest font).
 *   - opts.measureText: callback that returns the rendered width of a
 *     string at a given font size. The webview wires this to a
 *     CanvasRenderingContext2D; tests stub it with a simple px-per-char
 *     model.
 *
 * Output:
 *   - lines: array of strings (≤ maxLines), word-broken on spaces.
 *   - fontPx: the font size at which lines fit (between minFontPx and
 *     startFontPx).
 *
 * Algorithm:
 *   - Greedy word-wrap at the current font size; if the resulting line
 *     count exceeds maxLines or any line exceeds maxWidth, shrink by 4px
 *     and retry. Stops at minFontPx — the caller is on the hook for
 *     truncating any over-long line if the layout still doesn't fit.
 *   - Word-wrap is purely whitespace-based; we don't attempt hyphenation
 *     or character-level breaking. A single word longer than maxWidth at
 *     minFontPx is left as-is; the canvas draw clips at the right edge,
 *     which is acceptable for the pathological case.
 *
 * Determinism: same inputs (including measureText) → same output. The
 * webview's measureText is browser-canvas-dependent, so synthesised
 * thumbnails may differ slightly across browsers — but for a given
 * (browser, sha, title) combination the result is stable across sessions.
 */
export interface LayoutOptions {
  maxWidth: number;
  maxLines: number;
  startFontPx: number;
  minFontPx: number;
  measureText: (text: string, fontPx: number) => number;
}

export interface LayoutResult {
  lines: string[];
  fontPx: number;
}

export function computeTitleLayout(text: string, opts: LayoutOptions): LayoutResult {
  if (opts.maxLines < 1) throw new Error('computeTitleLayout: maxLines must be ≥ 1');
  if (opts.minFontPx < 6) throw new Error('computeTitleLayout: minFontPx must be ≥ 6');
  if (opts.startFontPx < opts.minFontPx) {
    throw new Error('computeTitleLayout: startFontPx must be ≥ minFontPx');
  }

  // Word-broken units. Multiple consecutive spaces collapse to one — display
  // text only, so we don't need to preserve formatting. Treat the empty
  // string as one empty word so we always return at least one line.
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) {
    return { lines: [''], fontPx: opts.startFontPx };
  }

  for (let fontPx = opts.startFontPx; fontPx >= opts.minFontPx; fontPx -= 4) {
    const lines = wrapWords(words, fontPx, opts.maxWidth, opts.measureText);
    if (lines.length <= opts.maxLines && lines.every((l) => opts.measureText(l, fontPx) <= opts.maxWidth)) {
      return { lines, fontPx };
    }
  }
  // Floor: re-wrap once at minFontPx so the lines reflect the final font,
  // even if the result still overflows. The caller decides what to do.
  const lines = wrapWords(words, opts.minFontPx, opts.maxWidth, opts.measureText);
  return { lines: lines.slice(0, opts.maxLines), fontPx: opts.minFontPx };
}

function wrapWords(
  words: string[],
  fontPx: number,
  maxWidth: number,
  measureText: (text: string, fontPx: number) => number,
): string[] {
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (measureText(candidate, fontPx) <= maxWidth) {
      current = candidate;
      continue;
    }
    // Word doesn't fit on current line; flush + start a new line with it.
    if (current) lines.push(current);
    current = w;
  }
  if (current) lines.push(current);
  return lines;
}
