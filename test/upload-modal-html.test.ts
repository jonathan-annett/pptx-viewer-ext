// Snapshot-style tests for the Upload modal HTML renderer.
//
// Asserts structural properties of the emitted string rather than
// byte-for-byte snapshots — same approach as test/pdf-import-config-html.test.ts.
// Each test pins one observable behaviour per phase of the modal state
// machine; the helpers cover countdowns, percentages, and byte formatting
// which are exported for reuse by the wiring layer (M5).
//
// Run with: npm run test:upload-modal-html

import {
  renderUploadModalHtml,
  uploadModalCss,
  formatCountdown,
  progressPercent,
  formatBytes,
  type UploadModalState,
} from '../src/upload/uploadModalHtml';

const tests: Array<[string, () => void | Promise<void>]> = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push([name, fn]);
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// ─── fixtures ───────────────────────────────────────────────────────────

const FIXED_NOW = Date.parse('2026-05-23T10:15:00.000Z');
const EXPIRES_AT = '2026-05-23T10:25:00.000Z'; // +10 minutes
const SAMPLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25"><path d="M0 0h25v25H0z"/></svg>';

function waitingState(): UploadModalState {
  return {
    phase: 'waiting',
    code: 'ABCDE',
    url: 'https://vscode.sophtwhere.com/dropbox/ABCDE',
    qrSvg: SAMPLE_SVG,
    expiresAt: EXPIRES_AT,
  };
}

// ─── phase: connecting ──────────────────────────────────────────────────

test('connecting: shows spinner and connecting copy', () => {
  const html = renderUploadModalHtml({
    fileName: 'sample.pptx',
    state: { phase: 'connecting' },
  });
  assert(/upload-spinner/.test(html), 'spinner div present');
  assert(/Connecting to upload server/.test(html), 'connecting copy present');
  // Cancel button while connecting
  assert(/id="upload-cancel-btn"/.test(html), 'cancel button visible');
  assert(!/upload-retry-btn/.test(html), 'retry button absent');
});

// ─── phase: waiting ─────────────────────────────────────────────────────

test('waiting: injects QR SVG verbatim', () => {
  const html = renderUploadModalHtml({
    fileName: 'sample.pptx',
    state: waitingState(),
    nowMs: FIXED_NOW,
  });
  assert(html.includes(SAMPLE_SVG), 'SVG injected verbatim');
});

test('waiting: shows code, URL, copy button, countdown', () => {
  const html = renderUploadModalHtml({
    fileName: 'sample.pptx',
    state: waitingState(),
    nowMs: FIXED_NOW,
  });
  assert(/id="upload-code">ABCDE</.test(html), 'code rendered');
  assert(/id="upload-url"[^>]*href="https:\/\/vscode.sophtwhere.com\/dropbox\/ABCDE"/.test(html), 'URL href rendered');
  assert(/id="upload-copy-btn"/.test(html), 'copy button rendered');
  assert(/id="upload-countdown">expires in 10:00</.test(html), 'countdown rendered');
});

test('waiting: countdown updates with nowMs', () => {
  // 1 minute + 7 seconds before expiry
  const now = Date.parse(EXPIRES_AT) - (67 * 1000);
  const html = renderUploadModalHtml({
    fileName: 'sample.pptx',
    state: waitingState(),
    nowMs: now,
  });
  assert(/expires in 1:07/.test(html), 'countdown reflects nowMs');
});

test('waiting: countdown floors at 0:00 when expired', () => {
  const past = Date.parse(EXPIRES_AT) + 5000;
  const html = renderUploadModalHtml({
    fileName: 'sample.pptx',
    state: waitingState(),
    nowMs: past,
  });
  assert(/expires in 0:00/.test(html), 'countdown floor at 0:00');
});

// ─── phase: uploading ───────────────────────────────────────────────────

test('uploading: shows percentage and byte counts when sizeBytes known', () => {
  const html = renderUploadModalHtml({
    fileName: 'sample.pptx',
    state: { phase: 'uploading', bytesReceived: 524288, sizeBytes: 1048576 },
  });
  assert(/Receiving from phone/.test(html), 'phase label');
  // 524288/1048576 = 50
  assert(/style="width: 50%"/.test(html), 'bar width matches percentage');
  assert(/512.0 KB \/ 1.0 MB/.test(html), 'byte counts visible');
  assert(!/upload-bar-indeterminate/.test(html), 'determinate bar');
});

test('uploading: indeterminate when sizeBytes is null', () => {
  const html = renderUploadModalHtml({
    fileName: 'sample.pptx',
    state: { phase: 'uploading', bytesReceived: 4096, sizeBytes: null },
  });
  assert(/upload-bar-indeterminate/.test(html), 'indeterminate class set');
  assert(/4.0 KB received/.test(html), '"received" suffix instead of denominator');
  assert(!/style="width:/.test(html), 'no fixed width on indeterminate bar');
});

// ─── phase: applying ────────────────────────────────────────────────────

test('applying: shows applying label and progress', () => {
  const html = renderUploadModalHtml({
    fileName: 'sample.pptx',
    state: { phase: 'applying', bytesApplied: 2097152, totalBytes: 4194304 },
  });
  assert(/Applying/.test(html), 'applying label');
  assert(/style="width: 50%"/.test(html), 'applying bar reflects 50%');
  assert(/2.0 MB \/ 4.0 MB/.test(html), 'applying byte counts visible');
});

// ─── phase: expired ─────────────────────────────────────────────────────

test('expired: shows close + retry, no cancel', () => {
  const html = renderUploadModalHtml({
    fileName: 'sample.pptx',
    state: { phase: 'expired', code: 'ABCDE' },
  });
  assert(/Code expired/.test(html), 'expired headline');
  assert(/id="upload-close-btn"/.test(html), 'close button present');
  assert(/id="upload-retry-btn"/.test(html), 'retry button present');
  assert(!/id="upload-cancel-btn"/.test(html), 'cancel button gone in expired state');
});

// ─── phase: error ───────────────────────────────────────────────────────

test('error: shows escaped message and retry button', () => {
  const html = renderUploadModalHtml({
    fileName: 'sample.pptx',
    state: { phase: 'error', message: '<bad>&boom' },
  });
  assert(/Upload failed/.test(html), 'error headline');
  assert(html.includes('&lt;bad&gt;&amp;boom'), 'message HTML-escaped');
  assert(!/<bad>/.test(html), 'raw injected markup absent');
  assert(/id="upload-retry-btn"/.test(html), 'retry button present');
});

// ─── phase: done ────────────────────────────────────────────────────────

test('done: shows "Done" headline with no buttons', () => {
  const html = renderUploadModalHtml({
    fileName: 'sample.pptx',
    state: { phase: 'done' },
  });
  assert(/Done/.test(html), 'done headline');
  // The terminal state has no action buttons — the wiring layer closes the
  // modal once the host finishes feeding bytes through the ingest pipeline.
  assert(!/id="upload-cancel-btn"/.test(html), 'no cancel');
  assert(!/id="upload-retry-btn"/.test(html), 'no retry');
  assert(!/id="upload-close-btn"/.test(html), 'no close');
});

// ─── general / cross-phase ──────────────────────────────────────────────

test('always: filename appears in title block and is HTML-escaped', () => {
  const html = renderUploadModalHtml({
    fileName: 'a&b<c>.pptx',
    state: { phase: 'connecting' },
  });
  assert(html.includes('a&amp;b&lt;c&gt;.pptx'), 'filename escaped');
  assert(!/a&b<c>/.test(html), 'raw filename absent');
});

test('always: stable structural ids present for wiring', () => {
  const html = renderUploadModalHtml({
    fileName: 'sample.pptx',
    state: waitingState(),
    nowMs: FIXED_NOW,
  });
  for (const id of ['upload-modal-title', 'upload-modal-body', 'upload-status']) {
    assert(html.includes(`id="${id}"`), `missing id="${id}"`);
  }
});

// ─── helpers ────────────────────────────────────────────────────────────

test('formatCountdown: typical times', () => {
  const expires = '2026-01-01T00:10:00.000Z';
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  assert(formatCountdown(expires, t0) === 'expires in 10:00', '10:00 exactly');
  assert(formatCountdown(expires, t0 + 1000) === 'expires in 9:59', '9:59');
  assert(formatCountdown(expires, t0 + 9 * 60 * 1000) === 'expires in 1:00', '1:00');
  assert(formatCountdown(expires, t0 + 10 * 60 * 1000) === 'expires in 0:00', '0:00 boundary');
  assert(formatCountdown(expires, t0 + 100 * 60 * 1000) === 'expires in 0:00', 'floors at 0:00');
});

test('formatCountdown: pads seconds with leading zero', () => {
  const expires = '2026-01-01T00:00:08.000Z';
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  assert(formatCountdown(expires, t0) === 'expires in 0:08', 'leading zero');
});

test('formatCountdown: garbage expiresAt → graceful fallback', () => {
  const out = formatCountdown('not-a-date', Date.now());
  assert(out === 'expires soon', 'fallback string');
});

test('progressPercent: typical inputs', () => {
  assert(progressPercent(0, 100) === 0, '0%');
  assert(progressPercent(50, 100) === 50, '50%');
  assert(progressPercent(100, 100) === 100, '100%');
  assert(progressPercent(150, 100) === 100, 'clamped to 100');
  assert(progressPercent(50, 0) === 0, 'zero denom → 0');
  assert(progressPercent(50, null) === 0, 'null denom → 0');
});

test('formatBytes: scales to KB/MB/GB', () => {
  assert(formatBytes(0) === '0 B', '0 bytes');
  assert(formatBytes(512) === '512 B', '<1KB');
  assert(formatBytes(1024) === '1.0 KB', '1 KB');
  assert(formatBytes(1536) === '1.5 KB', '1.5 KB');
  assert(formatBytes(1024 * 1024) === '1.0 MB', '1 MB');
  assert(formatBytes(1024 * 1024 * 1024) === '1.0 GB', '1 GB');
});

test('formatBytes: negative or non-finite values → "0 B"', () => {
  assert(formatBytes(-5) === '0 B', 'negative');
  assert(formatBytes(NaN) === '0 B', 'NaN');
  assert(formatBytes(Infinity) === '0 B', 'Infinity');
});

// ─── css ────────────────────────────────────────────────────────────────

test('uploadModalCss: returns a non-empty CSS string', () => {
  const css = uploadModalCss();
  assert(typeof css === 'string', 'string');
  assert(css.length > 200, 'non-trivial length');
  assert(css.includes('.upload-modal'), '.upload-modal rule present');
  assert(css.includes('.upload-bar'), '.upload-bar rule present');
  assert(css.includes('upload-spin'), 'spinner keyframes present');
});

// ─── runner ─────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok: ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL: ${name}`);
      console.log(`    ${(e as Error).message}`);
    }
  }
  if (failed) {
    console.log(`\n${failed} test(s) failed`);
    process.exit(1);
  } else {
    console.log('all tests passed');
  }
}

run();
