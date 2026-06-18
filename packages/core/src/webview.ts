// Render a ParseResult into the static HTML shown inside the webview.
//
// Styling notes (for the human learning CSS):
// - VS Code exposes its current theme via CSS custom properties prefixed with
//   --vscode-*. We use those instead of hardcoded colours so the panel matches
//   light/dark/high-contrast themes automatically.
// - The layout uses a 2-column CSS grid for the metadata table: the property
//   name is auto-sized, the value column grows to fill the rest. Grids are the
//   right tool when you want columns that align across many rows without
//   building a real <table>.
// - Warnings are visually distinct via:
//     1. a coloured left border (data ink — draws the eye)
//     2. a "WARN" pill that uses --vscode-errorForeground for high contrast
//     3. background tint using a low-opacity error colour
//   Three signals so the warn/pass distinction survives colour-blindness and
//   themes where the error colour is muted.
//
// Beyond rendering, this module also hosts the inline <script> that powers:
//   - Save As… (existing — routes through the extension host because the
//     web-webview iframe drops anchor-driven downloads on vscode.dev).
//   - Update… (file picker) — user-initiated replace; bytes posted to the
//     extension which parses + hashes + writes when the sha256 differs.
//   - Drag-and-drop ingest — drop a .pptx anywhere on the panel; same parse
//     + hash but with a confirmation modal because the user did not pick
//     this file from a dialog.
//
// The modal HTML is rendered on the extension side (see
// src/sync/compareModalHtml.ts) and posted to the webview as a string; the
// host container is a fixed-position overlay that the script toggles.

import type { Flag, MediaEntry, MediaFileEntry, ParseResult } from './pptx';
import { compareModalCss } from './sync/compareModalHtml';
import { decisionWiringScript } from './sync/planHtml';
import { pdfImportConfigCss } from './pdfImportConfigHtml';

// Placeholder string. esbuild's pdfimport-webview-bundle plugin substitutes
// the entire quoted literal (quotes included) with a JSON.stringify of the
// dist/pdfImport.webview.js source after every build, so the viewer can serve
// pdfjs-dist + the import pipeline inline inside a nonced <script> tag. Keep
// this constant's literal value in sync with esbuild.config.js's
// PDF_IMPORT_BUNDLE_PLACEHOLDER.
const PDF_IMPORT_WEBVIEW_BUNDLE_PLACEHOLDER =
  '__PPTX_PDFIMPORT_WEBVIEW_BUNDLE_PLACEHOLDER__';

export interface RenderOptions {
  /** Pre-rendered HTML for the "Sync target" section, or null/undefined for
   *  none (file is outside any workspace). Passed verbatim — the caller is
   *  responsible for HTML safety on its inputs. Mutually exclusive with
   *  `syncTargetLoading`; if both are set, `syncTargetLoading` wins. */
  syncTargetHtml?: string | null;
  /** Render an empty Sync-target section with a "Computing…" placeholder so
   *  the caller can post a `sync-target-html` message later to swap the
   *  built dry-run HTML into the page without re-rendering the whole panel.
   *  The placeholder section carries a stable id `sync-target-section`. */
  syncTargetLoading?: boolean;
  /** Pre-populated status text shown in the action row. Used after a
   *  successful Update / drop-confirm to surface "Updated" without needing
   *  the new script to receive a postMessage that may race the re-render. */
  initialStatus?: string;
  /**
   * True when this file's sha256 matches the workspace placeholder set
   * (empty-file default + user-added shas in `.admin-sync.jsonc`). Replaces
   * the corrupt-file warn banner with an info banner reading "This is a
   * placeholder file — content not yet uploaded." and suppresses the three
   * validation flags (which are meaningless for placeholder content).
   * Resolved by the wired provider via the placeholder registry.
   */
  isPlaceholder?: boolean;
  /**
   * Extra CSS injected into the viewer's <style> block. The extension passes
   * `uploadModalCss()` here so the upload-modal styling lives with the upload
   * feature (extension-only) rather than coupling this core builder to it. The
   * PWA omits it (no upload in v1). Empty when unset.
   */
  extraHeadCss?: string;
  /**
   * Output shape. `'webview'` (default) returns a full HTML document with the
   * VS Code webview CSP + the inline <script> bundle, for the extension. `'dom'`
   * returns a fragment — `<style>…</style>` + the body markup only, no doctype/
   * head/CSP and **no scripts** — for the PWA, which mounts it into a shadow
   * root and wires the (formerly inline-script) behaviour as direct DOM.
   */
  host?: 'webview' | 'dom';
}

export function renderHtml(r: ParseResult, nonce: string, opts: RenderOptions = {}): string {
  const metadataRows: Array<[string, string]> = [
    ['File name', r.fileName],
    ['Size', `${r.sizeHuman} (${r.size.toLocaleString()} bytes)`],
    ['Modified', r.mtimeHuman],
    ['SHA-256', r.sha256],
    ['Slides', String(r.slideCount)],
    ['Hidden slides', String(r.hiddenSlideCount)],
    ['Author', r.author],
    ['Last modified by', r.lastModifiedBy],
    ['Embedded media', formatMedia(r.embeddedMedia)],
  ];

  // Banner precedence — placeholder wins over corrupt, and replaces the
  // validation section regardless of parseError:
  //   isPlaceholder=true              → info banner; no corrupt banner; no
  //                                     validation flags (meaningless for a
  //                                     stub deck whose bytes the operator
  //                                     deliberately ignores).
  //   isPlaceholder=false + parseError → existing red corrupt banner; no
  //                                      validation flags (we couldn't parse).
  //   isPlaceholder=false + no error   → normal viewer.
  const errorBanner = opts.isPlaceholder
    ? `<div class="banner info">This is a placeholder file — content not yet uploaded.</div>`
    : r.parseError
    ? `<div class="banner warn">${escapeHtml(r.parseError)}</div>`
    : '';

  // Validation section is dropped when parsing failed — the three OK/WARN
  // flags rely on having parsed the deck, so reading "OK Linked media" off
  // a file we couldn't unzip would just be misleading. Also dropped for
  // placeholders — the flags would describe the stub template's properties,
  // not anything the user cares about.
  const validationSection = opts.isPlaceholder || r.parseError
    ? ''
    : `<section>
      <h2>Validation</h2>
      <ul class="flags">
        ${flagLi(r.flags.linkedMedia)}
        ${flagLi(r.flags.showType)}
        ${flagLi(r.flags.showMediaControls)}
      </ul>
    </section>`;

  // Sync target section. Three states:
  //   - syncTargetLoading=true  → placeholder with "Computing…"; the webview
  //                               will swap real HTML in via a postMessage
  //                               handler when the dry-run completes.
  //   - syncTargetHtml truthy   → render the supplied HTML directly (used
  //                               by tests and any legacy synchronous caller).
  //   - otherwise               → no section.
  // Stable ids: `sync-target-section` is the host; `sync-target-content`
  // wraps the inner HTML so the postMessage handler can swap only the body
  // (leaving the <h2> heading static in the DOM, which also keeps the
  // "Sync target" string out of the inline-script literal that would
  // otherwise trip the renderHtml test for the no-section case).
  const syncTargetSection = opts.syncTargetLoading
    ? `<section id="sync-target-section" class="sync-target-pending">
      <h2>Sync target</h2>
      <div id="sync-target-content">
        <p class="sync-target-pending-msg">Computing\u2026</p>
      </div>
    </section>`
    : opts.syncTargetHtml
    ? `<section id="sync-target-section">
      <h2>Sync target</h2>
      <div id="sync-target-content">
        ${opts.syncTargetHtml}
      </div>
    </section>`
    : '';

  const initialStatus = opts.initialStatus ? escapeHtml(opts.initialStatus) : '';
  // Compute the synth-hint payload once. Emitted as its own nonced <script>
  // before viewerScript so the latter can read window.__pptxSynthHint on init.
  const synthHint = synthHintScript(r);

  // `upload-btn` is webview-only (the upload-to-update relay is extension-only).
  const uploadBtn =
    opts.host === 'dom'
      ? ''
      : `<button id="upload-btn" class="action-btn action-btn-secondary" type="button">Upload to Update\u2026</button>`;

  const bodyMarkup = `  <main>
    <h1>${escapeHtml(r.fileName)}</h1>
    <div class="actions">
      <button id="save-as-btn" class="action-btn" type="button">Save As\u2026</button>
      <button id="update-btn" class="action-btn action-btn-secondary" type="button">Browse to Update\u2026</button>
      ${uploadBtn}
      <span id="action-status" class="action-status" aria-live="polite">${initialStatus}</span>
    </div>
    <input id="update-input" type="file" accept=".pptx,.pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/pdf" style="display:none">
    ${extractMediaRow(r)}
    ${thumbnailImg(r)}
    ${errorBanner}

    <section>
      <h2>Metadata</h2>
      <dl class="meta">
        ${metadataRows.map(([k, v]) => row(k, v)).join('\n')}
      </dl>
    </section>

    ${validationSection}

    ${syncTargetSection}
  </main>
  <div id="modal-host" class="modal-host" aria-hidden="true"></div>
  <div id="drop-overlay" class="drop-overlay" aria-hidden="true">
    <div class="drop-overlay-inner">
      <div class="drop-overlay-title">Drop a .pptx or .pdf to compare or update</div>
      <div class="drop-overlay-sub">Hold <kbd>Shift</kbd> while dropping &mdash; otherwise VS Code opens it as a new tab</div>
    </div>
  </div>`;

  // PWA fragment: styles + body only. No doctype/head/CSP, no inline scripts \u2014
  // the PWA mounts this in a shadow root and wires behaviour as direct DOM.
  if (opts.host === 'dom') {
    return `<style>${css(opts.extraHeadCss ?? '')}</style>\n${bodyMarkup}`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<title>${escapeHtml(r.fileName)}</title>
<style>${css(opts.extraHeadCss ?? '')}</style>
</head>
<body>
${bodyMarkup}
  <script nonce="${nonce}">${PDF_IMPORT_WEBVIEW_BUNDLE_PLACEHOLDER}</script>
  ${synthHint ? `<script nonce="${nonce}">${synthHint}</script>` : ''}
  <script nonce="${nonce}">${viewerScript()}</script>
  <script nonce="${nonce}">${decisionWiringScript()}</script>
</body>
</html>`;
}

export function renderError(path: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>Pptx error</title>
<style>${css()}</style>
</head>
<body>
  <main>
    <h1>Could not open file</h1>
    <p class="path">${escapeHtml(path)}</p>
    <div class="banner warn">${escapeHtml(message)}</div>
  </main>
</body>
</html>`;
}

// ---------- pieces ----------

// Render the Extract media row when the deck has at least one embedded
// video. Audio is excluded for v1 (controls flag only warns on video; users
// asked for video-routing-to-external-playout first). Orphaned videos are
// included — still extractable, just not referenced by any slide.
//
// Affordances:
//   - <select> populated from videos, with slide-of-use annotations.
//     The placeholder option (value="") keeps the Extract button disabled
//     until the user makes a deliberate choice.
//   - <button> disabled until a real option is selected.
//   - <span> for transient status text, same affordance as #action-status.
//
// The section is omitted entirely when there are no videos, so the page
// layout is unchanged for the typical no-media deck.
function extractMediaRow(r: ParseResult): string {
  const videos = (r.mediaFiles ?? []).filter((m) => /^video\//i.test(m.mime));
  if (videos.length === 0) return '';

  const options = videos
    .map((m) => `<option value="${escapeHtml(m.mediaPath)}">${escapeHtml(extractOptionLabel(m))}</option>`)
    .join('');

  return `<div class="extract-actions">
    <label class="extract-label" for="extract-select">Extract media:</label>
    <select id="extract-select" class="extract-select">
      <option value="">Select a video\u2026</option>
      ${options}
    </select>
    <button id="extract-btn" class="action-btn action-btn-secondary" type="button" disabled>Extract</button>
    <span id="extract-status" class="action-status" aria-live="polite"></span>
  </div>`;
}

function extractOptionLabel(m: MediaFileEntry): string {
  const base = basename(m.mediaPath);
  if (m.slides.length === 0) return `${base} \u2014 unused`;
  if (m.slides.length === 1) return `${base} \u2014 slide ${m.slides[0]}`;
  return `${base} \u2014 slides ${m.slides.join(', ')}`;
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function thumbnailImg(r: ParseResult): string {
  // Real in-file thumbnail — bare <img>, no badge, no wrap. Layout unchanged
  // from before the M-VE-3 badge addition.
  if (r.thumbnail && r.thumbnail.synthesised !== true) {
    // alt="" because the image is decorative — the filename above already labels
    // the content. A non-empty alt would just be read twice by a screen reader.
    return `<img id="thumbnail-img" class="thumbnail" src="${r.thumbnail.dataUrl}" alt="">`;
  }
  // From here on the thumbnail is (or will be) synthesised. Two sub-cases:
  //   (a) cache hit on a previously-synthesised entry — r.thumbnail is set
  //       with synthesised:true, render straight to <img>.
  //   (b) first encounter, parsePptx emitted a synthesisHint — render the
  //       placeholder div; the viewer script swaps it once the canvas pass
  //       completes (host.replaceWith(img)).
  // In both cases the image lives inside a .thumbnail-wrap so the
  // .thumbnail-badge sibling survives the swap. The badge tells the user
  // the preview is generated rather than the deck's actual first slide.
  let inner = '';
  if (r.thumbnail) {
    inner = `<img id="thumbnail-img" class="thumbnail" src="${r.thumbnail.dataUrl}" alt="">`;
  } else if (r.synthesisHint) {
    inner = `<div id="thumbnail-host" class="thumbnail thumbnail-placeholder" aria-hidden="true"></div>`;
  } else {
    return '';
  }
  const badge = `<div class="thumbnail-badge" title="This file has no embedded thumbnail; the viewer generated this preview from the slide title.">Generated preview</div>`;
  return `<div class="thumbnail-wrap">${inner}${badge}</div>`;
}

/**
 * Inline <script> that publishes the synthesised-thumbnail hint payload to
 * the page so the viewerScript can read it on load. Emitted only when the
 * parse result actually wants a fallback (synthesisHint present, no real
 * thumbnail), so the typical case adds zero bytes to the page.
 *
 * The fileName-without-extension is computed here at render time because
 * it's a display-side decision; the cached synthesisHint only carries the
 * content-determined slide title (when found). Order in the page:
 *
 *   <div id="thumbnail-host">            ← placeholder
 *   <script>window.__pptxSynthHint=…<script>   ← THIS — must come BEFORE viewerScript
 *   <script>${viewerScript()}<script>    ← reads window.__pptxSynthHint on init
 */
function synthHintScript(r: ParseResult): string {
  if (r.thumbnail || !r.synthesisHint) return '';
  const fileNameNoExt = r.fileName.replace(/\.[a-z0-9]+$/i, '');
  const payload = {
    sha256: r.sha256,
    title: r.synthesisHint.title ?? null,
    fileNameNoExt,
  };
  // JSON.stringify is safe to inline inside a <script> tag here because
  // CSP forbids any cross-origin script execution and the values come
  // from parsePptx output (already-decoded XML text) + the file path.
  // None can contain a literal </script> sequence without first surviving
  // the parser's XML-entity decode, which doesn't introduce raw '<'. To be
  // belt-and-braces, escape `<` to `\u003c` so a pathological title can't
  // close the <script> tag.
  const safe = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `window.__pptxSynthHint = ${safe};`;
}

function row(key: string, value: string): string {
  return `<div class="row">
    <dt>${escapeHtml(key)}</dt>
    <dd>${escapeHtml(value)}</dd>
  </div>`;
}

function flagLi(f: Flag): string {
  const cls = f.ok ? 'pass' : 'warn';
  const tag = f.ok ? 'OK' : 'WARN';
  return `<li class="flag ${cls}">
    <span class="pill">${tag}</span>
    <span class="label">${escapeHtml(f.label)}</span>
    <span class="detail">${escapeHtml(f.detail)}</span>
  </li>`;
}

function formatMedia(media: MediaEntry[]): string {
  if (media.length === 0) return 'none';
  return media.map((m) => `${m.mime} × ${m.count}`).join(', ');
}

// Inline script consolidates all webview-side behaviour:
//
//   - Save As… → postMessage({type:'save-as'}), wait for save-as-result.
//   - Update… → click hidden <input type="file"> → on change post
//     {type:'ingest', source:'picker', fileName, bytes}.
//   - Drag/drop → on full-window drop, post {type:'ingest', source:'drop', …}
//     if the file passes a quick PK\x03\x04 magic-bytes check.
//   - Modal driver: when the extension replies with drop-result/different or
//     drop-result/identical, populate #modal-host via innerHTML (no nonce
//     needed — the modal HTML carries no scripts), wire the buttons, and
//     post confirm-update / cancel-update back.
//
// The save flow does NOT do a browser-native blob download — vscode.dev's
// web-webview iframe silently drops anchor-driven downloads (sandbox /
// cross-origin policy), even with a live user-activation token. Routing
// through the extension host bypasses the iframe restriction entirely.
function viewerScript(): string {
  return `(function(){
  // Cache the API on window so decisionWiringScript (loaded after us) can
  // reuse it. acquireVsCodeApi() throws if called twice in the same page.
  const vscode = (window.__decisionVscode = window.__decisionVscode || acquireVsCodeApi());
  const saveBtn = document.getElementById('save-as-btn');
  const updateBtn = document.getElementById('update-btn');
  const uploadBtn = document.getElementById('upload-btn');
  const updateInput = document.getElementById('update-input');
  const status = document.getElementById('action-status');
  const modalHost = document.getElementById('modal-host');
  const dropOverlay = document.getElementById('drop-overlay');
  // The Run Sync buttons + hint live inside the Sync target section, which
  // may or may not be rendered — all nullable. Re-resolved each render
  // because the whole webview HTML is replaced on every renderWithSyncTarget.
  // Extract media row — null when the section was omitted (no embedded video).
  const extractSelect = document.getElementById('extract-select');
  const extractBtn = document.getElementById('extract-btn');
  const extractStatus = document.getElementById('extract-status');
  // Sync-target action elements are re-resolved on demand rather than cached:
  // the section starts as a "Computing…" placeholder and gets innerHTML-swapped
  // when the dry-run completes, at which point any cached references would
  // point at orphaned elements.
  function getSyncRunBtn() { return document.getElementById('sync-run-btn'); }
  function getSyncRunSafeBtn() { return document.getElementById('sync-run-safe-btn'); }
  function getSyncRunHint() { return document.getElementById('sync-run-hint'); }

  // M5.1: live armed-count display on the orange button. Mirrors the
  // admin/config editor's refreshOrangeButton(). Hooked into the shared
  // decisionWiringScript via window.__decisionWiring so we get a callback
  // after every per-row checkbox toggle.
  function refreshOrangeButton() {
    var syncRunSafeBtn = getSyncRunSafeBtn();
    if (!syncRunSafeBtn || syncRunSafeBtn.hidden) return;
    var n = 0;
    var cbs = document.querySelectorAll('.decision-input');
    for (var i = 0; i < cbs.length; i++) if (cbs[i].checked) n++;
    syncRunSafeBtn.textContent = n === 0
      ? 'Run Sync (safe items only)'
      : 'Run Sync (with ' + n + ' override' + (n === 1 ? '' : 's') + ')';
  }
  window.__decisionWiring = refreshOrangeButton;
  refreshOrangeButton();

  function vlog(msg){
    try { vscode.postMessage({type:'viewer-log', message: msg}); } catch (_) {}
  }

  // ----- M-VE-3 synthesised-thumbnail render -----
  // Runs once on script load when window.__pptxSynthHint is set (which the
  // extension does only when the file lacks an in-file thumbnail and parsing
  // otherwise succeeded). The render is purely canvas-based — no network,
  // no DOM beyond the placeholder div — so it's safe to run synchronously
  // before any other init. We post the resulting data URL back to the
  // extension; it caches the bytes keyed by sha256, then pings back with
  // {type:'thumbnail-set'} to swap the placeholder for an <img>.
  function synthesiseThumbnailFromHint() {
    var hint = window.__pptxSynthHint;
    if (!hint || typeof hint !== 'object') return;
    var host = document.getElementById('thumbnail-host');
    if (!host) return; // placeholder absent — extension's render didn't ask for synthesis
    var canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    var ctx = canvas.getContext('2d');
    if (!ctx) {
      vlog('synth: 2d context unavailable; skipping fallback render');
      return;
    }

    // Background colour deterministic from sha — first 6 hex chars as hue.
    // Saturation/lightness fixed at mid-tones so the result reads against
    // both light and dark themes (the thumbnail can't follow theme — it's
    // baked into the JPEG once).
    var sha = String(hint.sha256 || '');
    var hue = /^[0-9a-fA-F]{6}/.test(sha) ? parseInt(sha.slice(0, 6), 16) % 360 : 200;
    ctx.fillStyle = 'hsl(' + hue + ', 60%, 45%)';
    ctx.fillRect(0, 0, 1920, 1080);

    // Title text — fallback chain: parsed title → filename without ext → "Untitled".
    var title = (typeof hint.title === 'string' && hint.title.trim().length > 0)
      ? hint.title.trim()
      : (typeof hint.fileNameNoExt === 'string' && hint.fileNameNoExt.length > 0)
        ? hint.fileNameNoExt
        : 'Untitled';

    // Word-wrap inside 90% canvas width; shrink font in 4px steps from
    // 128 → 32 until lines fit AND lineCount ≤ 4. measureText is the
    // canvas API — same algorithm as src/thumbnailSynth.ts computeTitleLayout,
    // inlined here because the webview can't import TS modules at runtime.
    var maxWidth = 1920 * 0.9;
    var maxLines = 4;
    var startFontPx = 128;
    var minFontPx = 32;
    function fontSpec(px) {
      return '600 ' + px + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
    }
    function measureAt(text, px) {
      ctx.font = fontSpec(px);
      return ctx.measureText(text).width;
    }
    function wrapAt(words, px) {
      var lines = [];
      var current = '';
      for (var i = 0; i < words.length; i++) {
        var candidate = current ? current + ' ' + words[i] : words[i];
        if (measureAt(candidate, px) <= maxWidth) {
          current = candidate;
        } else {
          if (current) lines.push(current);
          current = words[i];
        }
      }
      if (current) lines.push(current);
      return lines;
    }
    var words = title.split(/\\s+/).filter(function(w){ return w.length > 0; });
    if (words.length === 0) words = ['Untitled'];
    var lines = [title];
    var fontPx = minFontPx;
    for (var px = startFontPx; px >= minFontPx; px -= 4) {
      var attempt = wrapAt(words, px);
      var fits = attempt.length <= maxLines;
      if (fits) {
        for (var l = 0; l < attempt.length; l++) {
          if (measureAt(attempt[l], px) > maxWidth) { fits = false; break; }
        }
      }
      if (fits) { lines = attempt; fontPx = px; break; }
      // Floor: even if it doesn't fit, retain the minFontPx attempt clipped
      // to maxLines — better to show something than nothing.
      if (px === minFontPx) { lines = attempt.slice(0, maxLines); fontPx = minFontPx; }
    }

    // Draw text — white with a 1px dark drop shadow so anti-aliased edges
    // stay legible against any background hue we picked.
    ctx.font = fontSpec(fontPx);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    var lineHeight = Math.round(fontPx * 1.25);
    var totalH = lineHeight * lines.length;
    var startY = 540 - totalH / 2 + lineHeight / 2;
    for (var li = 0; li < lines.length; li++) {
      ctx.fillText(lines[li], 960, startY + li * lineHeight);
    }

    var dataUrl;
    try {
      dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    } catch (err) {
      vlog('synth: toDataURL failed: ' + (err && err.message || err));
      return;
    }
    vlog('synth: rendered ' + lines.length + ' line(s) at ' + fontPx + 'px, ' + dataUrl.length + ' chars');
    // Swap the placeholder immediately so the user sees the result without
    // waiting for the extension round-trip. The extension's reply
    // (thumbnail-set) is redundant for this render but still useful because
    // the extension caches the bytes keyed by sha256 for next time.
    setHostToImage(host, dataUrl);
    try {
      vscode.postMessage({
        type: 'thumbnail-synthesised',
        sha256: sha,
        dataUrl: dataUrl,
        mime: 'image/jpeg',
      });
    } catch (err) {
      vlog('synth: postMessage failed: ' + (err && err.message || err));
    }
  }

  function setHostToImage(host, dataUrl) {
    // Replace the placeholder div with an <img>. Re-use the .thumbnail
    // class so the post-swap render matches a real in-file thumbnail
    // visually — same height/border/radius treatment. Give the img the
    // 'thumbnail-img' id so subsequent thumbnail-set messages can find
    // and update it (the host element is gone after replaceWith).
    var img = document.createElement('img');
    img.id = 'thumbnail-img';
    img.className = 'thumbnail';
    img.alt = '';
    img.src = dataUrl;
    host.replaceWith(img);
  }

  // Kick off synthesis on next tick so the rest of the page wiring (modal,
  // buttons, drag/drop) finishes first. Canvas + measureText on a 1920×1080
  // box is fast (≪50ms in practice) but defer anyway — the placeholder
  // background tint covers the gap.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(synthesiseThumbnailFromHint);
  } else {
    setTimeout(synthesiseThumbnailFromHint, 0);
  }
  window.addEventListener('error', function(ev){
    vlog('window error: ' + (ev.message || ev.error || 'unknown'));
  });

  function setStatus(text){ if (status) status.textContent = text || ''; }
  function setExtractStatus(text){ if (extractStatus) extractStatus.textContent = text || ''; }

  function setBusy(busy){
    if (saveBtn) saveBtn.disabled = busy;
    if (updateBtn) updateBtn.disabled = busy;
    if (uploadBtn) uploadBtn.disabled = busy;
  }

  function openModal(html){
    if (!modalHost) return;
    modalHost.innerHTML = html;
    modalHost.classList.add('open');
    modalHost.setAttribute('aria-hidden', 'false');
    // Bind whichever buttons the modal contains. The IDs are stable;
    // see src/sync/compareModalHtml.ts.
    const okBtn = document.getElementById('compare-ok-btn');
    const updateBtnInModal = document.getElementById('compare-update-btn');
    const cancelBtnInModal = document.getElementById('compare-cancel-btn');
    if (okBtn) okBtn.addEventListener('click', function(){
      closeModal(); setStatus('');
    });
    if (cancelBtnInModal) cancelBtnInModal.addEventListener('click', function(){
      closeModal(); setStatus('');
      try { vscode.postMessage({type:'cancel-update'}); } catch (_) {}
    });
    if (updateBtnInModal) updateBtnInModal.addEventListener('click', function(){
      updateBtnInModal.disabled = true;
      if (cancelBtnInModal) cancelBtnInModal.disabled = true;
      // Read the auto-sync checkbox state at click time. The extension uses
      // this both to persist the next-time default and to decide whether to
      // run the per-file sync immediately after the write.
      var autoSyncCb = document.getElementById('compare-auto-sync');
      var autoSync = !!(autoSyncCb && autoSyncCb.checked);
      setStatus('Updating\u2026');
      try { vscode.postMessage({type:'confirm-update', autoSync: autoSync}); } catch (_) {}
    });
  }

  function closeModal(){
    if (!modalHost) return;
    modalHost.classList.remove('open');
    modalHost.setAttribute('aria-hidden', 'true');
    modalHost.innerHTML = '';
  }

  // ----- Save As… -----
  if (saveBtn) saveBtn.addEventListener('click', function(){
    setBusy(true);
    setStatus('Saving\u2026');
    vlog('click → save-as');
    try { vscode.postMessage({type: 'save-as'}); } catch (_) {}
  });

  // ----- Update… (file picker) -----
  if (updateBtn && updateInput) {
    updateBtn.addEventListener('click', function(){
      // Reset value first so picking the same filename twice still fires change.
      try { updateInput.value = ''; } catch (_) {}
      updateInput.click();
    });
    updateInput.addEventListener('change', async function(){
      const file = updateInput.files && updateInput.files[0];
      if (!file) return;
      vlog('picker → ' + file.name + ' (' + file.size + ' bytes)');
      // PDF branch: open the import config modal instead of round-tripping
      // the bytes to the extension. The pdfjs+pipeline bundle lives in
      // window.__pptxPdfImport (inlined by esbuild — see esbuild.config.js).
      if (/\\.pdf$/i.test(file.name)) {
        await handlePdfFile(file, 'picker');
        return;
      }
      setBusy(true);
      setStatus('Checking\u2026');
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        vscode.postMessage({type:'ingest', source:'picker', fileName: file.name, bytes: buf});
      } catch (err) {
        setBusy(false);
        setStatus('Could not read file');
        vlog('picker read error: ' + (err && err.message || err));
      }
    });
  }

  // ----- Upload to Update… (M5: dropbox-server-mediated phone upload) -----
  // Clicking opens a server-side WebSocket session via the extension host.
  // The host owns the WS + protocol state machine and posts re-rendered
  // modal HTML for each transition; this script's job is just to drop the
  // HTML into #modal-host and rebind the well-known button ids. The host
  // tears the session down on cancel/close/retry messages.
  if (uploadBtn) {
    uploadBtn.addEventListener('click', function(){
      vlog('click → upload-open');
      setBusy(true);
      setStatus('Connecting\u2026');
      try { vscode.postMessage({type:'uploadOpen'}); } catch (_) {}
    });
  }

  // openUploadModal mirrors openModal() above but binds the upload modal's
  // own four button ids (see src/upload/uploadModalHtml.ts renderActions).
  // Each click posts a typed message back to the host; the host decides
  // whether to dismiss / re-render / reopen the WS.
  function openUploadModal(html){
    if (!modalHost) return;
    // The host re-renders the whole modal on every state transition AND
    // every countdown tick (once per second). Innocuous for the QR/code
    // section but corrosive for the OTP <input>: its value and focus would
    // be wiped each second. Snapshot before the swap and restore after.
    var prevOtpInput = document.getElementById('upload-otp-input');
    var prevOtpValue = prevOtpInput ? prevOtpInput.value : null;
    var prevOtpHadFocus = prevOtpInput && document.activeElement === prevOtpInput;
    var prevOtpSelStart = prevOtpInput ? prevOtpInput.selectionStart : null;
    var prevOtpSelEnd = prevOtpInput ? prevOtpInput.selectionEnd : null;
    modalHost.innerHTML = html;
    modalHost.classList.add('open');
    modalHost.setAttribute('aria-hidden', 'false');
    var newOtpInput = document.getElementById('upload-otp-input');
    if (newOtpInput && prevOtpValue !== null && !newOtpInput.disabled) {
      newOtpInput.value = prevOtpValue;
      if (prevOtpHadFocus) {
        try {
          newOtpInput.focus();
          if (prevOtpSelStart !== null && prevOtpSelEnd !== null) {
            newOtpInput.setSelectionRange(prevOtpSelStart, prevOtpSelEnd);
          }
        } catch (_) {}
      }
    }
    var cancelBtn = document.getElementById('upload-cancel-btn');
    var closeBtn = document.getElementById('upload-close-btn');
    var retryBtn = document.getElementById('upload-retry-btn');
    var copyBtn = document.getElementById('upload-copy-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', function(){
      // Disable immediately so a double-click doesn't fire twice. The host
      // is idempotent on cancel but the UI shouldn't suggest otherwise.
      cancelBtn.disabled = true;
      try { vscode.postMessage({type:'uploadCancel'}); } catch (_) {}
    });
    if (closeBtn) closeBtn.addEventListener('click', function(){
      // Close from a terminal state (expired/error). The host has nothing
      // more to do; we dismiss the modal locally and tell the host to
      // dispose of the (already-closed) WS so it doesn't leak.
      try { vscode.postMessage({type:'uploadClose'}); } catch (_) {}
      closeModal();
      setBusy(false);
      setStatus('');
    });
    if (retryBtn) retryBtn.addEventListener('click', function(){
      // Don't dismiss the modal — the host's first re-render after retry
      // arrives almost immediately and swaps the contents in place.
      try { vscode.postMessage({type:'uploadRetry'}); } catch (_) {}
    });
    if (copyBtn) copyBtn.addEventListener('click', function(){
      // The URL is on the <a id="upload-url"> in the waiting phase. Read
      // the href (preferred — already absolute and normalised) and fall
      // back to textContent if for some reason the href is missing.
      var urlEl = document.getElementById('upload-url');
      if (!urlEl) return;
      var url = urlEl.getAttribute('href') || urlEl.textContent || '';
      try {
        navigator.clipboard.writeText(url);
        copyBtn.textContent = 'Copied';
        setTimeout(function(){
          try { copyBtn.textContent = 'Copy'; } catch (_) {}
        }, 1500);
      } catch (err) {
        vlog('upload copy failed: ' + (err && err.message || err));
      }
    });

    // OTP entry — present only in the waiting phase with status other than
    // accepted. The host renderer decides whether the input is in the DOM;
    // we just attach listeners if it is. Both the submit button and Enter
    // inside the input post the same message.
    var otpInput = document.getElementById('upload-otp-input');
    var otpSubmitBtn = document.getElementById('upload-otp-submit-btn');
    function submitOtpFromInput(){
      if (!otpInput) return;
      var raw = (otpInput.value || '').trim();
      if (!/^\\d{6}$/.test(raw)) {
        // Local-side guard so we don't bounce a postMessage that the host
        // will obviously reject. Final source of truth is uploadFlow.
        // (Double-backslash on \\d because this code lives inside the
        // viewerScript() template literal — \\d in source becomes \d in
        // the emitted JS, which is what the RegExp actually needs.)
        otpInput.focus();
        otpInput.select();
        return;
      }
      try { vscode.postMessage({type:'uploadOtpSubmit', otp: raw}); } catch (_) {}
    }
    if (otpInput) {
      // Autofocus on first render of the waiting phase, but not on re-renders
      // (the countdown ticks once a second and would steal focus mid-typing).
      // We detect "fresh insertion" by checking whether the input already
      // has a value set or is currently focused — if neither, it's new.
      if (document.activeElement !== otpInput && !otpInput.value) {
        try { otpInput.focus(); } catch (_) {}
      }
      otpInput.addEventListener('keydown', function(ev){
        if (ev.key === 'Enter') {
          ev.preventDefault();
          submitOtpFromInput();
        }
      });
      // Strip non-digit characters on input so the user can't paste in junk.
      // maxlength on the element handles length; this handles content.
      // (\\D not \D — see above, this is inside the viewerScript() template.)
      otpInput.addEventListener('input', function(){
        var cleaned = otpInput.value.replace(/\\D+/g, '');
        if (cleaned !== otpInput.value) otpInput.value = cleaned;
      });
    }
    if (otpSubmitBtn) {
      otpSubmitBtn.addEventListener('click', submitOtpFromInput);
    }
  }

  // ----- Extract media (dropdown + button) -----
  // The button starts disabled because the placeholder option (value="") is
  // the initial selection. Change events flip the disabled state; the actual
  // round-trip with the extension is wired below in the message listener.
  if (extractSelect && extractBtn) {
    extractSelect.addEventListener('change', function(){
      extractBtn.disabled = !extractSelect.value;
      setExtractStatus('');
    });
    extractBtn.addEventListener('click', function(){
      if (!extractSelect.value || extractBtn.disabled) return;
      var mediaPath = extractSelect.value;
      var suggestedName = mediaPath.replace(/^.*\\//, '');
      extractBtn.disabled = true;
      extractSelect.disabled = true;
      setExtractStatus('Extracting\u2026');
      vlog('click → extractMedia ' + mediaPath);
      try { vscode.postMessage({type:'extractMedia', mediaPath: mediaPath, suggestedName: suggestedName}); } catch (_) {}
    });
  }

  // ----- PDF import (drop or picker) -----
  // The PDF→PPTX pipeline lives in window.__pptxPdfImport — bundled by
  // esbuild as a separate IIFE and inlined into the viewer HTML by the
  // pdfimport-webview-bundle plugin (see esbuild.config.js).
  //
  // Flow:
  //   1. Snapshot PDF bytes.
  //   2. Open the config modal with default settings (16:9, 1920, letterbox,
  //      JPEG q=0.85). The modal renderer also lives on the api global.
  //   3. First render: PDF.js → canvases → encode → PPTX bytes. Status row
  //      reports progress at each phase.
  //   4. User tweaks knobs:
  //        - format/quality change → re-encode only (cheap; canvases cached)
  //        - aspect/resolution/letterbox change → enable Re-render button
  //   5. Import → post bytes through the existing 'ingest' channel as if a
  //      .pptx had been picked. The extension's ingest handler does its
  //      usual sha256/identical/different check and routes from there.
  async function handlePdfFile(file, source){
    const api = window.__pptxPdfImport;
    if (!api) {
      setStatus('PDF import not available (bundle missing)');
      vlog('pdfimport: window.__pptxPdfImport is undefined');
      return;
    }

    var pdfBytes;
    try {
      pdfBytes = new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      setStatus('Could not read PDF');
      vlog('pdfimport: read error: ' + (err && err.message || err));
      return;
    }

    // Derived pptx filename — sample.pdf → sample.pptx. Used both for the
    // ingest message and for the eventual Save As suggestion downstream.
    var pptxFileName = file.name.replace(/\\.pdf$/i, '') + '.pptx';

    // The mutable state for this import session. Re-rendered on every UI
    // event; never crosses async boundaries with unchecked staleness because
    // we serialise async operations via state.* "in progress" flags.
    var state = {
      config: Object.assign({}, api.DEFAULT_PDF_IMPORT_CONFIG),
      pageCount: undefined,         // undefined until first render
      rendered: null,               // RenderedPage[] from phase 1
      encoded: null,                // EncodedImage[] from phase 2
      pptxBytes: null,              // Uint8Array from phase 3
      rendering: false,
      encoding: false,
      building: false,
      // Key identifying the last (aspect|resolution|letterbox) combination
      // that has been rendered. When the current config's key differs, the
      // Re-render button is enabled.
      lastRenderKey: null,
    };

    // Effective long-edge pixel width of the device's screen, factoring in
    // devicePixelRatio. Surfaces a "Device (NNNN)" radio if it's not already
    // one of the fixed presets — useful for matching a HiDPI projector.
    var devicePxW = window.screen && window.screen.width
      ? Math.round(window.screen.width * (window.devicePixelRatio || 1))
      : undefined;

    function renderKeyOf(cfg){
      return cfg.aspect + '|' + cfg.resolution + '|' + (cfg.letterbox ? 'L' : 'S');
    }

    function formatBytes(n){
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    function totalSize(arr){
      var t = 0;
      for (var i = 0; i < arr.length; i++) t += arr[i].sizeBytes;
      return t;
    }

    function buildStatusLine(progress){
      if (progress) return progress;
      if (state.rendering) return 'Rendering PDF\u2026';
      if (state.encoding) return 'Encoding\u2026';
      if (state.building) return 'Packaging .pptx\u2026';
      var cfg = state.config;
      var pages = state.rendered ? state.rendered.length : 0;
      if (state.encoded && state.encoded.length === pages && pages > 0) {
        var size = formatBytes(totalSize(state.encoded));
        var label = cfg.format.toUpperCase() +
          (cfg.format === 'jpeg' ? ' q=' + Math.round(cfg.quality * 100) : '');
        return pages + ' pages \u00B7 ' + cfg.aspect + ' \u00B7 ' +
          cfg.resolution + 'px \u00B7 ' + label + ' \u2014 ' + size;
      }
      if (pages > 0) return pages + ' pages rendered.';
      return '';
    }

    // Selector helpers ------------------------------------------------------
    // Calls into modalHost rather than document so the lookups are scoped to
    // our modal even if other parts of the viewer reuse similar ids later.
    function $(id){ return modalHost ? modalHost.querySelector('#' + id) : null; }
    function $$(name){ return modalHost ? modalHost.querySelectorAll('input[name="' + name + '"]') : []; }

    // Re-renders the modal HTML from current state. Called after every event
    // that changes the visible config or the pipeline phase. Re-building the
    // HTML is cheaper than fine-grained DOM patching at this scale (~50 nodes)
    // and keeps the renderer pure for testing.
    var rerenderingDom = false;
    function rerenderModal(progress){
      if (!modalHost) return;
      rerenderingDom = true;
      var html = api.renderPdfImportConfigHtml({
        fileName: file.name,
        pageCount: state.pageCount,
        config: state.config,
        status: buildStatusLine(progress),
        rerenderDisabled: state.rendering || state.encoding || state.building ||
          state.lastRenderKey === renderKeyOf(state.config),
        importDisabled: state.rendering || state.encoding || state.building ||
          !state.pptxBytes,
        devicePxW: devicePxW,
      });
      modalHost.innerHTML = html;
      modalHost.classList.add('open');
      modalHost.setAttribute('aria-hidden', 'false');
      bindEvents();
      rerenderingDom = false;
    }

    function readConfigFromDom(){
      var cfg = Object.assign({}, state.config);
      var aspectRadios = $$('pdfimport-aspect');
      for (var i = 0; i < aspectRadios.length; i++) {
        if (aspectRadios[i].checked) { cfg.aspect = aspectRadios[i].value; break; }
      }
      var resRadios = $$('pdfimport-resolution');
      for (var j = 0; j < resRadios.length; j++) {
        if (resRadios[j].checked) { cfg.resolution = parseInt(resRadios[j].value, 10); break; }
      }
      var fitRadios = $$('pdfimport-fit');
      for (var k = 0; k < fitRadios.length; k++) {
        if (fitRadios[k].checked) { cfg.letterbox = fitRadios[k].value === 'letterbox'; break; }
      }
      var fmtRadios = $$('pdfimport-format');
      for (var l = 0; l < fmtRadios.length; l++) {
        if (fmtRadios[l].checked) { cfg.format = fmtRadios[l].value; break; }
      }
      var qSlider = $('pdfimport-quality');
      if (qSlider) cfg.quality = parseFloat(qSlider.value);
      return cfg;
    }

    function bindEvents(){
      var cancelBtn = $('pdfimport-cancel-btn');
      if (cancelBtn) cancelBtn.addEventListener('click', function(){
        vlog('pdfimport: cancel');
        closeModal();
      });

      var rerenderBtn = $('pdfimport-rerender-btn');
      if (rerenderBtn) rerenderBtn.addEventListener('click', function(){
        if (rerenderBtn.disabled) return;
        runRenderEncodeBuild();
      });

      var importBtn = $('pdfimport-import-btn');
      if (importBtn) importBtn.addEventListener('click', function(){
        if (importBtn.disabled || !state.pptxBytes) return;
        vlog('pdfimport: import → ' + pptxFileName + ' (' + state.pptxBytes.byteLength + ' bytes)');
        closeModal();
        // Always go through the 'picker' source: the modal was the user's
        // explicit confirmation; we skip the compare-modal step the 'drop'
        // source would trigger.
        try {
          vscode.postMessage({
            type: 'ingest',
            source: 'picker',
            fileName: pptxFileName,
            bytes: state.pptxBytes
          });
        } catch (err) {
          vlog('pdfimport: postMessage failed: ' + (err && err.message || err));
        }
      });

      // Form change → cascade. Format/quality affect only the encode+build
      // phases; aspect/resolution/letterbox affect render too (gated behind
      // Re-render button).
      var quality = $('pdfimport-quality');
      var qualityValueEl = $('pdfimport-quality-value');
      if (quality && qualityValueEl) {
        quality.addEventListener('input', function(){
          if (rerenderingDom) return;
          var q = parseFloat(quality.value);
          qualityValueEl.textContent = Math.round(q * 100) + '%';
        });
        quality.addEventListener('change', function(){
          if (rerenderingDom) return;
          onConfigChanged();
        });
      }

      // All radios → onConfigChanged on change. The radio set is small so a
      // single delegated listener on the form would be cleaner, but per-input
      // wiring keeps this loop a flat tree we can grep for.
      var radios = modalHost ? modalHost.querySelectorAll('input[type="radio"]') : [];
      for (var i = 0; i < radios.length; i++) {
        radios[i].addEventListener('change', function(){
          if (rerenderingDom) return;
          onConfigChanged();
        });
      }
    }

    function onConfigChanged(){
      var prev = state.config;
      state.config = readConfigFromDom();
      // Render-key change → just enable Re-render. Don't auto-rerender —
      // PDF render is the slow phase, user clicks the button explicitly.
      var rkOld = renderKeyOf(prev);
      var rkNew = renderKeyOf(state.config);
      if (rkOld !== rkNew) {
        // Render-affecting knob changed. Rerender the modal so the button
        // gets enabled and the placement preview (status line) updates.
        rerenderModal();
        return;
      }
      // Format/quality change → re-encode only when we have cached canvases.
      if (state.rendered && !state.rendering && !state.encoding && !state.building) {
        runEncodeAndBuild();
      } else {
        rerenderModal();
      }
    }

    async function runRenderEncodeBuild(){
      if (state.rendering || state.encoding || state.building) return;
      state.rendering = true;
      state.encoded = null;
      state.pptxBytes = null;
      rerenderModal('Rendering page 1\u2026');

      // Per-page layout — fixes slide size, derives renderScale + EMU offsets.
      var slideSizeEmu = state.config.aspect === '4:3'
        ? api.SLIDE_SIZE_4x3_EMU
        : api.SLIDE_SIZE_16x9_EMU;
      var targetPxW = api.targetPxWFor(slideSizeEmu, state.config.resolution);

      try {
        // Read page sizes first via a temporary getDocument call. PDF.js
        // doesn't expose page sizes without instantiating a doc, so we open
        // it once for the layout pass and discard. The render pass below
        // does its own getDocument call (pdfImport.ts encapsulates that).
        var doc = await api.pdfjsLib.getDocument({ data: pdfBytes.slice(), disableWorker: true }).promise;
        state.pageCount = doc.numPages;
        var perPageLayouts = [];
        var perPageScales = [];
        for (var i = 1; i <= doc.numPages; i++) {
          var p = await doc.getPage(i);
          var vp = p.getViewport({ scale: 1 });
          var layout = api.computePageLayout(
            { widthPt: vp.width, heightPt: vp.height },
            slideSizeEmu,
            { targetPxW: targetPxW, letterbox: state.config.letterbox }
          );
          perPageLayouts.push(layout);
          perPageScales.push(layout.renderScale);
        }
        try { doc.destroy(); } catch (_) {}

        // Phase 1: render each page to a canvas.
        var rendered = await api.renderPdfPages(pdfBytes.slice(), {
          pdfjsLib: api.pdfjsLib,
          renderScale: perPageScales,
          onProgress: function(p){
            rerenderModal('Rendering page ' + p.current + ' of ' + p.total + '\u2026');
          }
        });
        state.rendered = rendered;
        state.rendering = false;
        state.lastRenderKey = renderKeyOf(state.config);
        // Stash the layouts alongside each rendered page so the build phase
        // can read them back without re-deriving.
        for (var k = 0; k < rendered.length; k++) {
          rendered[k]._placement = perPageLayouts[k].placement;
          rendered[k]._slideSizeEmu = slideSizeEmu;
        }
        await runEncodeAndBuild();
      } catch (err) {
        state.rendering = false;
        vlog('pdfimport: render error: ' + (err && err.message || err));
        rerenderModal('Render failed: ' + (err && err.message || 'unknown'));
      }
    }

    async function runEncodeAndBuild(){
      if (!state.rendered || state.encoding || state.building) return;
      state.encoding = true;
      state.pptxBytes = null;
      rerenderModal();
      var cfg = state.config;
      try {
        var encoded = await api.encodeCanvasesToBlobs(state.rendered, {
          format: cfg.format,
          quality: cfg.quality,
          onProgress: function(p){
            rerenderModal('Encoding page ' + p.current + ' of ' + p.total + '\u2026');
          }
        });
        state.encoded = encoded;
        state.encoding = false;
        state.building = true;
        rerenderModal();

        var placements = [];
        for (var i = 0; i < encoded.length; i++) {
          placements.push(Object.assign({}, encoded[i], {
            placement: state.rendered[i]._placement
          }));
        }
        var pptxBytes = await api.buildPptxFromImages(placements, {
          format: cfg.format,
          slideSizeEmu: state.rendered[0]._slideSizeEmu,
          letterbox: cfg.letterbox
        });
        state.pptxBytes = pptxBytes;
        state.building = false;
        rerenderModal();
      } catch (err) {
        state.encoding = false;
        state.building = false;
        vlog('pdfimport: encode/build error: ' + (err && err.message || err));
        rerenderModal('Encode failed: ' + (err && err.message || 'unknown'));
      }
    }

    vlog('pdfimport: opening config for ' + file.name + ' (' + file.size + ' bytes, source=' + source + ')');
    // First open — modal shows "Reading…" until the initial render completes.
    rerenderModal();
    // Kick off the initial render immediately. The user can change knobs
    // while it runs; once it lands, format/quality changes re-encode in place.
    runRenderEncodeBuild();
  }

  // ----- Drag and drop -----
  // dragenter/dragover need preventDefault to opt into a drop. We toggle a
  // body class so the overlay shows; dragleave is debounced via a counter
  // because dragleave fires on every child during a single drag.
  let dragDepth = 0;
  function showOverlay(){ if (dropOverlay) dropOverlay.classList.add('open'); }
  function hideOverlay(){ if (dropOverlay) dropOverlay.classList.remove('open'); }

  window.addEventListener('dragenter', function(e){
    e.preventDefault();
    dragDepth++;
    showOverlay();
  });
  window.addEventListener('dragover', function(e){
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', function(){
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideOverlay();
  });
  window.addEventListener('drop', async function(e){
    e.preventDefault();
    dragDepth = 0;
    hideOverlay();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    // First gate: extension. Accept .pptx and .pdf. Anything else bails
    // without round-tripping bytes through the extension host.
    const isPptx = /\\.pptx$/i.test(file.name);
    const isPdf = /\\.pdf$/i.test(file.name);
    if (!isPptx && !isPdf) {
      vlog('drop: ignored non-pptx/non-pdf ' + file.name);
      return;
    }
    // Second gate: magic bytes. PPTX is a zip (PK\\x03\\x04); PDF starts with
    // "%PDF-". Catches mismatched extensions and gives us a sane error
    // before the heavier parsing pipeline runs.
    try {
      const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
      if (isPptx) {
        if (head[0] !== 0x50 || head[1] !== 0x4B || head[2] !== 0x03 || head[3] !== 0x04) {
          vlog('drop: ignored bad pptx magic ' + file.name);
          return;
        }
      } else {
        // %PDF-  →  0x25 0x50 0x44 0x46 0x2D
        if (head[0] !== 0x25 || head[1] !== 0x50 || head[2] !== 0x44 || head[3] !== 0x46 || head[4] !== 0x2D) {
          vlog('drop: ignored bad pdf magic ' + file.name);
          return;
        }
      }
    } catch (err) {
      vlog('drop: head read error: ' + (err && err.message || err));
      return;
    }
    vlog('drop → ' + file.name + ' (' + file.size + ' bytes)');
    if (isPdf) {
      await handlePdfFile(file, 'drop');
      return;
    }
    setBusy(true);
    setStatus('Checking\u2026');
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      vscode.postMessage({type:'ingest', source:'drop', fileName: file.name, bytes: buf});
    } catch (err) {
      setBusy(false);
      setStatus('Could not read dropped file');
      vlog('drop read error: ' + (err && err.message || err));
    }
  });

  // ----- Per-file Run Sync (buttons live inside the Sync target section) -----
  // Both buttons post the same {type:'run-sync'}; the extension decides what
  // to do based on the in-memory decisions Map. Orange differs from green
  // only in that the user has armed some per-row overrides before clicking.
  //
  // The clicks are delegated on document so the handlers survive the
  // sync-target-html innerHTML swap (the buttons don't exist when this
  // script runs — they arrive with the dry-run result).
  function lockSyncButtons(label){
    var syncRunBtn = getSyncRunBtn();
    var syncRunSafeBtn = getSyncRunSafeBtn();
    var syncRunHint = getSyncRunHint();
    if (syncRunBtn) {
      syncRunBtn.disabled = true;
      syncRunBtn.textContent = label;
    }
    if (syncRunSafeBtn) {
      syncRunSafeBtn.disabled = true;
      syncRunSafeBtn.textContent = label;
    }
    if (syncRunHint) syncRunHint.textContent = '';
    setBusy(true);
    setStatus(label);
  }
  document.addEventListener('click', function(ev){
    var t = ev.target;
    if (!t) return;
    var id = t.id;
    if (id !== 'sync-run-btn' && id !== 'sync-run-safe-btn') return;
    if (t.disabled) return;
    vlog('click → run-sync (' + (id === 'sync-run-btn' ? 'green' : 'orange / safe items only') + ')');
    lockSyncButtons('Syncing\u2026');
    try { vscode.postMessage({type:'run-sync'}); } catch (_) {}
  });

  // ----- Extension → webview messages -----
  window.addEventListener('message', function(e){
    const m = e.data;
    if (!m || typeof m !== 'object') return;

    if (m.type === 'save-as-result') {
      setBusy(false);
      if (m.status === 'ok') {
        setStatus('Saved.');
        vlog('saved to ' + (m.target || '(unknown)'));
      } else if (m.status === 'cancelled') {
        setStatus('');
        vlog('save cancelled');
      } else {
        setStatus('Save failed: ' + (m.message || 'unknown'));
        vlog('save error: ' + (m.message || 'unknown'));
      }
      return;
    }

    if (m.type === 'picker-result') {
      setBusy(false);
      if (m.outcome === 'invalid') {
        setStatus('Not a valid pptx file');
      } else if (m.outcome === 'identical') {
        setStatus('Not updated \u2014 identical content');
      } else if (m.outcome === 'error') {
        setStatus('Update failed: ' + (m.message || 'unknown'));
      }
      // outcome='updated' → the extension re-renders the panel; this script
      // is about to be replaced. No status update needed here.
      return;
    }

    if (m.type === 'sync-status') {
      // The typical post-runSync path re-renders the whole webview, replacing
      // this script entirely. These messages only land if the extension chose
      // not to re-render (defensive no-currentResult case, or an error before
      // the re-render fires).
      var syncRunBtn = getSyncRunBtn();
      var syncRunSafeBtn = getSyncRunSafeBtn();
      var syncRunHint = getSyncRunHint();
      if (m.status === 'running') {
        lockSyncButtons('Syncing\u2026');
      } else if (m.status === 'done') {
        setBusy(false);
        setStatus(m.failed ? 'Sync partially failed' : 'Synced');
        if (syncRunBtn) {
          syncRunBtn.disabled = true;
          syncRunBtn.textContent = 'Run Sync';
        }
        if (syncRunSafeBtn) {
          syncRunSafeBtn.disabled = true;
          syncRunSafeBtn.textContent = 'Run Sync (safe items only)';
        }
        refreshOrangeButton();
      } else if (m.status === 'error') {
        setBusy(false);
        setStatus('Sync failed: ' + (m.message || 'unknown'));
        if (syncRunBtn) {
          syncRunBtn.disabled = false;
          syncRunBtn.textContent = 'Run Sync';
        }
        if (syncRunSafeBtn && !syncRunSafeBtn.hidden) {
          syncRunSafeBtn.disabled = false;
          syncRunSafeBtn.textContent = 'Run Sync (safe items only)';
        }
        refreshOrangeButton();
        if (syncRunHint) syncRunHint.textContent = '';
      }
      return;
    }

    if (m.type === 'sync-target-html') {
      // Async dry-run finished — swap the "Computing…" placeholder for the
      // real plan HTML, or remove the section entirely when the file has no
      // sync coverage (extension posts null in that case). Buttons inside
      // the swapped HTML are reached via event delegation, so no rewiring
      // is needed here beyond refreshing the orange button label (it counts
      // freshly-rendered armed checkboxes).
      var section = document.getElementById('sync-target-section');
      if (!section) return;
      if (typeof m.html === 'string' && m.html.length > 0) {
        var content = document.getElementById('sync-target-content');
        if (!content) return;
        section.classList.remove('sync-target-pending');
        content.innerHTML = m.html;
        refreshOrangeButton();
      } else {
        section.remove();
      }
      return;
    }

    if (m.type === 'extract-result') {
      if (extractBtn) extractBtn.disabled = !extractSelect || !extractSelect.value;
      if (extractSelect) extractSelect.disabled = false;
      if (m.status === 'ok') {
        setExtractStatus('Saved.');
        vlog('extracted ' + (m.mediaPath || '?') + ' → ' + (m.target || '(unknown)'));
      } else if (m.status === 'cancelled') {
        setExtractStatus('');
        vlog('extract cancelled');
      } else {
        setExtractStatus('Extract failed: ' + (m.message || 'unknown'));
        vlog('extract error: ' + (m.message || 'unknown'));
      }
      return;
    }

    if (m.type === 'thumbnail-set' && typeof m.dataUrl === 'string') {
      // Extension ACK / cache-hit push. The webview may have already
      // swapped the placeholder (setHostToImage runs eagerly after synth),
      // so we re-resolve the host element each time: if the placeholder
      // is still around, swap; otherwise update the existing <img>.
      var host = document.getElementById('thumbnail-host');
      if (host) {
        setHostToImage(host, m.dataUrl);
      } else {
        var img = document.getElementById('thumbnail-img');
        if (img) img.src = m.dataUrl;
      }
      return;
    }

    if (m.type === 'uploadModal' && typeof m.html === 'string') {
      // Host pushed a fresh modal HTML — replace the modal contents and
      // re-bind buttons. Per-tick countdown updates land here as well as
      // phase transitions; the cost of full-modal innerHTML rewrites at
      // 1 Hz is negligible.
      openUploadModal(m.html);
      return;
    }

    if (m.type === 'uploadModalClose') {
      // Host signalled terminal-but-no-action-needed (e.g. WS closed after
      // a cancel round-trip). Drop the modal and clear the busy state.
      closeModal();
      setBusy(false);
      setStatus('');
      return;
    }

    if (m.type === 'uploadedBytes' && m.bytes) {
      // Bytes are in hand from the dropbox-server. Decide whether they're
      // a .pptx (route through ingest) or a .pdf (route through the existing
      // pdf-import modal). The check is filename-extension-first with a
      // %PDF magic-bytes fallback so a phone that drops the extension still
      // routes correctly.
      var bytes = m.bytes instanceof Uint8Array ? m.bytes : new Uint8Array(m.bytes);
      var uploadedName = String(m.fileName || 'upload');
      var looksLikePdfByMagic = bytes.byteLength >= 4 &&
        bytes[0] === 0x25 && bytes[1] === 0x50 &&
        bytes[2] === 0x44 && bytes[3] === 0x46; // '%PDF'
      var isPdf = /\\.pdf$/i.test(uploadedName) || looksLikePdfByMagic;
      vlog('upload bytes received: ' + uploadedName + ' (' + bytes.byteLength + ' bytes), ' +
        (isPdf ? 'routing to pdf-import' : 'routing to ingest'));
      // Dismiss the upload modal before opening the PDF modal or kicking
      // off ingest so the user doesn't see two modals stacked / a stale
      // "Done" splash hanging around.
      closeModal();
      if (isPdf) {
        // The PDF pipeline expects a File-like with arrayBuffer(); the
        // simplest cross-environment construct is an actual File built
        // from a Blob over the bytes. vscode.dev's webview iframe has
        // the File constructor available.
        setBusy(false);
        setStatus('');
        try {
          var fakeFile = new File([bytes], uploadedName, { type: 'application/pdf' });
          handlePdfFile(fakeFile, 'upload');
        } catch (err) {
          setStatus('PDF import failed: ' + (err && err.message || err));
          vlog('upload pdf wrap error: ' + (err && err.message || err));
        }
        return;
      }
      // PPTX branch — round-trip through ingest so the existing sha256
      // + identical/different check applies. source='upload' tells the
      // provider this was user-affirmed (no compare modal), same as picker.
      setStatus('Updating\u2026');
      try {
        vscode.postMessage({type:'ingest', source:'upload', fileName: uploadedName, bytes: bytes});
      } catch (err) {
        setBusy(false);
        setStatus('Could not deliver bytes: ' + (err && err.message || err));
      }
      return;
    }

    if (m.type === 'drop-result') {
      setBusy(false);
      if (m.outcome === 'invalid') {
        setStatus('Dropped file is not a valid pptx');
        return;
      }
      if (m.outcome === 'error') {
        setStatus('Update failed: ' + (m.message || 'unknown'));
        return;
      }
      if (m.outcome === 'identical' && typeof m.modalHtml === 'string') {
        setStatus('');
        openModal(m.modalHtml);
        return;
      }
      if (m.outcome === 'different' && typeof m.modalHtml === 'string') {
        setStatus('');
        openModal(m.modalHtml);
        return;
      }
      // outcome='updated' → panel re-render; nothing more to do.
      return;
    }
  });
})();`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function css(extraHeadCss = ''): string {
  return `
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family, system-ui);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.5;
    }
    main { max-width: 900px; margin: 0 auto; padding: 24px; }
    h1 {
      font-size: 1.4em;
      margin: 0 0 16px;
      word-break: break-all;
    }
    /* Thumbnail styling:
       - Fixed height (240px) with width:auto gives every thumbnail the same
         vertical footprint while preserving aspect ratio. Landscape slides
         (the overwhelming common case) all render at 240px tall, width
         scaling by their native aspect — no more "small file = small thumb,
         big file = big thumb" inconsistency.
       - max-width:100% is the safety hatch for the rare portrait or
         extreme-aspect image inside a narrow panel.
       - object-fit:contain is belt-and-braces for any future case where
         both dimensions get constrained simultaneously; it does nothing
         when width:auto is in play, but means we won't ever squish the
         aspect ratio if a future change adds a width constraint.
       - The subtle border + radius matches the rest of the panel's chrome
         and keeps a near-white slide image from bleeding into a light
         theme background.
    */
    .thumbnail {
      display: block;
      height: 240px;
      width: auto;
      max-width: 100%;
      object-fit: contain;
      margin: 0 0 16px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 4px;
      background: var(--vscode-editor-background);
    }
    /* Wrap around the thumbnail when a "Generated preview" badge is shown.
       inline-block so the wrap's width tracks the image's natural width
       (240px tall * native aspect), which keeps the badge centred under
       the image rather than spanning the full panel. The wrap owns the
       16px bottom gutter; the inner .thumbnail's margin-bottom is collapsed
       to 4px in this context so the badge sits tight to the image. */
    .thumbnail-wrap {
      display: inline-block;
      max-width: 100%;
      margin: 0 0 16px;
    }
    .thumbnail-wrap .thumbnail {
      margin: 0 0 4px;
    }
    /* The badge itself: muted italic small-caps under the image, centred to
       match the inline-block wrap. Uses descriptionForeground so it stays
       readable in both light and dark themes without competing with the
       primary metadata table below. */
    .thumbnail-badge {
      font-size: 11px;
      font-style: italic;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      letter-spacing: 0.02em;
    }
    /* Synthesised-thumbnail placeholder (M-VE-3):
       The viewer reserves a 16:9 box at the thumbnail's natural height so
       the page layout doesn't reflow when the canvas-rendered fallback
       lands. aspect-ratio + height work together — width auto-computes to
       240 * 16/9 ≈ 427px, matching what the eventual <img> will occupy.
       Background is a subtle theme-tinted shade until the image swaps in
       (not a flash of bright white in light themes). */
    .thumbnail-placeholder {
      aspect-ratio: 16 / 9;
      background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
    }
    h2 {
      font-size: 1.05em;
      margin: 24px 0 8px;
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    .path {
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
      word-break: break-all;
      margin-top: -8px;
    }
    .banner {
      padding: 8px 12px;
      border-radius: 4px;
      margin: 12px 0;
    }
    .banner.warn {
      background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
      border-left: 3px solid var(--vscode-errorForeground);
      color: var(--vscode-foreground);
    }
    .banner.info {
      background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 10%, transparent);
      border-left: 3px solid var(--vscode-charts-blue, #3794ff);
      color: var(--vscode-foreground);
    }

    /* Metadata: 2-col grid (label | value). 'auto 1fr' = label hugs content, value fills. */
    dl.meta {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 4px 16px;
      margin: 0;
    }
    dl.meta .row {
      display: contents; /* lets <dt>/<dd> participate directly in the grid */
    }
    dl.meta dt {
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    dl.meta dd {
      margin: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      word-break: break-all;
    }

    /* Validation flags. Each row is a flexbox with a status pill + label + detail. */
    ul.flags {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .flag {
      display: grid;
      grid-template-columns: max-content max-content 1fr;
      gap: 12px;
      align-items: baseline;
      padding: 8px 12px;
      border-radius: 4px;
      border-left: 3px solid transparent;
    }
    .flag.pass {
      background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
      border-left-color: var(--vscode-charts-green, #4caf50);
    }
    .flag.warn {
      background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent);
      border-left-color: var(--vscode-errorForeground);
    }
    .pill {
      font-size: 0.75em;
      font-weight: 700;
      letter-spacing: 0.05em;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .flag.pass .pill {
      background: var(--vscode-charts-green, #4caf50);
      color: var(--vscode-editor-background);
    }
    .flag.warn .pill {
      background: var(--vscode-errorForeground);
      color: var(--vscode-editor-background);
    }
    .label { font-weight: 600; }
    .detail { color: var(--vscode-descriptionForeground); }

    /* Action row (Save As + Update + transient status text).
       - flex with align-items:center keeps the status text vertically centred on the button.
       - --vscode-button-* matches VS Code's primary-button styling across themes,
         so the button looks native rather than bolted on. */
    .actions {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 0 0 16px;
      flex-wrap: wrap;
    }
    .action-btn {
      font-family: inherit;
      font-size: inherit;
      padding: 6px 14px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid transparent;
      border-radius: 2px;
      cursor: pointer;
    }
    .action-btn:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    .action-btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .action-btn:disabled {
      opacity: 0.6;
      cursor: default;
    }
    /* Secondary variant for Update — same shape, muted palette so Save As
       reads as the primary action. */
    .action-btn-secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border-color: var(--vscode-panel-border, rgba(128,128,128,0.4));
    }
    .action-btn-secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground, color-mix(in srgb, var(--vscode-foreground) 8%, transparent));
    }
    .action-status {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }

    /* Extract media row.
       - Sits directly below the .actions row; same flex layout so the
         dropdown + button + status read as a sibling affordance.
       - The <select> uses --vscode-dropdown-* so it picks up VS Code's
         native dropdown styling in light/dark/high-contrast themes.
       - The label is muted (--vscode-descriptionForeground) so it doesn't
         compete visually with the primary Save As / Update buttons above. */
    .extract-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 0 0 16px;
      flex-wrap: wrap;
    }
    .extract-label {
      color: var(--vscode-descriptionForeground);
      font-size: 0.95em;
    }
    .extract-select {
      font-family: inherit;
      font-size: inherit;
      padding: 4px 8px;
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      background: var(--vscode-dropdown-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, rgba(128,128,128,0.4)));
      border-radius: 2px;
      min-width: 240px;
      max-width: 100%;
    }
    .extract-select:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    /* ----- Sync target section ------------------------------------------- */
    /* The section reuses the plan-content selectors emitted by
       src/sync/planHtml.ts when the file is in a source-covered folder, plus
       lightweight banners for the uncovered/orphan/error states. */
    .sync-banner {
      padding: 10px 12px;
      border-radius: 4px;
      border-left: 3px solid var(--vscode-charts-blue, #3794ff);
      background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 10%, transparent);
      color: var(--vscode-foreground);
    }
    .sync-banner.muted {
      border-left-color: var(--vscode-panel-border, rgba(128,128,128,0.5));
      background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
      color: var(--vscode-descriptionForeground);
    }
    .sync-attribution {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
      margin: 0 0 8px;
    }
    .sync-attribution code {
      font-family: var(--vscode-editor-font-family, monospace);
      background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
      padding: 0 4px;
      border-radius: 3px;
    }
    /* Per-file Run Sync action row inside the Sync target section. Mirrors
       the admin/config editor's Run Sync visually so all three surfaces feel
       like siblings — green button, descriptive hint to its right. */
    .sync-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
      flex-wrap: wrap;
    }
    /* "Computing…" placeholder rendered while the dry-run is in flight.
       Muted because it's transient; the real section replaces it within
       a few hundred ms on typical workspaces. */
    .sync-target-pending-msg {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    .sync-run-btn {
      background: var(--vscode-charts-green, #4caf50);
      color: #fff;
      border-color: transparent;
    }
    .sync-run-btn:hover:not(:disabled) {
      background: var(--vscode-charts-green, #4caf50);
      filter: brightness(1.1);
    }
    .sync-run-btn:disabled,
    .sync-run-safe-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    /* Orange variant — same pattern as admin/config editor's .btn-orange. The
       button is hidden unless the plan has blocks; the renderRunSyncRow emits
       the 'hidden' attribute on the element so we don't need a class toggle. */
    .sync-run-safe-btn {
      background: var(--vscode-charts-orange, #d97706);
      color: #fff;
      border-color: transparent;
    }
    .sync-run-safe-btn:hover:not(:disabled) {
      filter: brightness(1.1);
    }
    ${syncPlanEmbedCss()}

    /* ----- Drag-and-drop overlay ----------------------------------------- */
    .drop-overlay {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--vscode-focusBorder, #0e639c) 18%, transparent);
      pointer-events: none; /* the drop event still fires on window */
      z-index: 900;
    }
    .drop-overlay.open { display: flex; }
    .drop-overlay-inner {
      padding: 16px 24px;
      border: 2px dashed var(--vscode-focusBorder, #0e639c);
      border-radius: 6px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      text-align: center;
    }
    .drop-overlay-title {
      font-weight: 600;
      margin-bottom: 6px;
    }
    .drop-overlay-sub {
      font-weight: 400;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    /* kbd pill — mimics VS Code's keybinding affordance so the Shift hint
       reads as a key rather than a word. */
    .drop-overlay-sub kbd {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
      padding: 1px 6px;
      border-radius: 3px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.4));
      background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
      color: var(--vscode-foreground);
    }

    /* ----- Modal overlay (compare / identical) --------------------------- */
    ${compareModalCss()}

    /* ----- PDF import config modal --------------------------------------- */
    ${pdfImportConfigCss()}

    /* ----- Host-injected extra CSS (e.g. extension's upload modal) -------- */
    ${extraHeadCss}
  `;
}

/**
 * Minimal subset of the plan-view CSS needed when embedding plan markup into
 * the viewer's Sync target section. Keeps the rules colocated so the viewer
 * has no runtime import-cycle risk with planHtml.ts (which is otherwise a
 * sibling pure module). Mirrors `planContentCss()` from planHtml.ts; if the
 * two drift far apart we can swap to importing `planContentStyles()` from
 * planHtml directly.
 */
function syncPlanEmbedCss(): string {
  return `
    .sync-target .pair {
      margin: 8px 0;
      padding: 10px 14px;
      border-left: 3px solid var(--vscode-panel-border, rgba(128,128,128,0.4));
      background: color-mix(in srgb, var(--vscode-foreground) 3%, transparent);
      border-radius: 0 4px 4px 0;
    }
    .sync-target .pair-head {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: baseline;
      margin-bottom: 6px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .sync-target .pair-head .src { font-weight: 600; }
    .sync-target .pair-head .arrow,
    .sync-target .pair-head .dst { color: var(--vscode-descriptionForeground); }
    .sync-target .sec {
      margin: 6px 0;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 4px;
      background: var(--vscode-editor-background);
    }
    .sync-target .sec summary {
      list-style: none;
      cursor: pointer;
      padding: 5px 10px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      user-select: none;
    }
    .sync-target .sec summary::-webkit-details-marker { display: none; }
    .sync-target .sec summary::before {
      content: '\u25B6';
      font-size: 0.75em;
      color: var(--vscode-descriptionForeground);
      transition: transform 0.12s ease;
    }
    .sync-target .sec[open] summary::before { transform: rotate(90deg); }
    .sync-target .sec-block summary { color: var(--vscode-errorForeground); }
    .sync-target .sec-count {
      margin-left: auto;
      font-weight: 400;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .sync-target ul.rows {
      list-style: none;
      margin: 0;
      padding: 4px 10px 10px;
    }
    .sync-target ul.rows .row {
      padding: 2px 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
    }
    /* Flex (not grid) so trailing cells — size, hashes, warning badge,
       decision checkboxes — flow naturally as the vocabulary grows. Mirrors
       planContentCss()'s .row-main in the standalone plan webview. */
    .sync-target ul.rows .row-main {
      display: flex;
      align-items: baseline;
      gap: 12px;
      flex-wrap: wrap;
    }
    .sync-target ul.rows .row-main .path { flex: 1 1 auto; min-width: 0; }
    .sync-target ul.rows .path { word-break: break-all; }
    .sync-target ul.rows .size,
    .sync-target ul.rows .hashes {
      color: var(--vscode-descriptionForeground);
    }
    .sync-target ul.rows .hashes { opacity: 0.8; }
    /* Warning badge — same chip palette as the standalone plan webview so a
       file warned in the workspace plan looks identical here. */
    .sync-target ul.rows .warn-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 0.85em;
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 18%, transparent);
      border: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 50%, transparent);
      color: var(--vscode-editorWarning-foreground, #cca700);
      cursor: help;
    }
    .sync-target ul.rows .warn-list {
      list-style: none;
      margin: 4px 0 4px 16px;
      padding: 0;
      font-size: 0.9em;
    }
    .sync-target ul.rows .warn-item {
      padding: 1px 0 1px 12px;
      color: var(--vscode-editorWarning-foreground, #cca700);
      position: relative;
    }
    .sync-target ul.rows .warn-item::before {
      content: '\u26A0';
      position: absolute;
      left: -2px;
      font-size: 0.85em;
    }
    /* Per-row decision checkboxes — mirror the standalone webview palette so
       the affordance reads the same in both surfaces. */
    .sync-target ul.rows .decision,
    .sync-target ul.rows .decision-remember {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      user-select: none;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      padding: 0 4px;
      border-radius: 3px;
    }
    .sync-target ul.rows .decision-remember { font-size: 0.85em; }
    .sync-target ul.rows .decision:hover,
    .sync-target ul.rows .decision-remember:hover {
      background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
    }
    .sync-target ul.rows .decision-input,
    .sync-target ul.rows .decision-remember-input { margin: 0; cursor: pointer; }
    .sync-target ul.rows .decision-overwrite .decision-label { color: var(--vscode-errorForeground); }
    .sync-target ul.rows .decision-delete .decision-label,
    .sync-target ul.rows .decision-warning-override .decision-label {
      color: var(--vscode-editorWarning-foreground, #cca700);
    }
    .sync-target ul.rows .decision-input:checked + .decision-label { font-weight: 600; }
    .sync-target ul.rows .decision-remember-input:disabled,
    .sync-target ul.rows .decision-remember-input:disabled + .decision-remember-label {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .sync-target .banner.ok   { background: color-mix(in srgb, var(--vscode-charts-green, #4caf50) 10%, transparent); border-left-color: var(--vscode-charts-green, #4caf50); }
  `;
}
