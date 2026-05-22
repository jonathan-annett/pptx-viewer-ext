// Bundle the extension entrypoint for the VS Code web worker context.
// Output: dist/extension.js (single file, CommonJS so the VS Code loader can require it).
//
// Notes:
// - platform: 'browser' and target: 'es2022' produce code that runs in a web worker.
// - `vscode` is external — the host provides it at runtime.
// - We mark the bundle as CommonJS because VS Code's web extension loader uses
//   AMD/CommonJS-style `require`. esbuild's default IIFE format would break that.
//
// Two-bundle layout (M-VE-1):
//   (1) dist/pdfImport.webview.js — IIFE bundle containing pdfjs-dist + the
//       three-phase pipeline + the config-modal renderer. Runs inside the
//       webview iframe, where DOM APIs are available. Exposes
//       `window.__pptxPdfImport`. Built first.
//   (2) dist/extension.js — the extension worker bundle. The build-info
//       plugin (existing) text-replaces a placeholder with build metadata.
//       The new pdf-import-bundle plugin text-replaces a second placeholder
//       with the entire contents of dist/pdfImport.webview.js as a JS string
//       literal, so the viewer can serve it inline inside a nonced <script>.
//
// Watch mode runs both contexts so an edit in either source tree triggers
// rebuilds of the downstream artefact.

const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const watch = process.argv.includes('--watch');

// ──────────────────────────────────────────────────────────────────────────
// Placeholders rewritten in dist/extension.js after each (re)build.
// Why post-process instead of esbuild's `define`: esbuild caches `define`
// values at context creation. Mutating them in onStart has no effect on
// watch-mode rebuilds — the substitution is frozen at watcher start. Reading
// the output file and rewriting in onEnd dodges this entirely. The rewrite
// targets dist/, which isn't watched, so there's no feedback loop.
// ──────────────────────────────────────────────────────────────────────────

const BUILD_INFO_PLACEHOLDER = '__PPTX_BUILD_INFO_PLACEHOLDER__';
const PDF_IMPORT_BUNDLE_PLACEHOLDER = '__PPTX_PDFIMPORT_WEBVIEW_BUNDLE_PLACEHOLDER__';

const PDFIMPORT_WEBVIEW_OUTFILE = path.join(__dirname, 'dist', 'pdfImport.webview.js');
const EXTENSION_OUTFILE = path.join(__dirname, 'dist', 'extension.js');

function currentBuildInfo() {
  let sha = 'unknown';
  try {
    sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // leave as 'unknown'
  }
  return { buildTime: new Date().toISOString(), gitSha: sha };
}

// JSON-encoded text can contain " and \ characters that need re-escaping
// for the JS string literal context they're being substituted into.
function escapeForJsString(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Build a regex that matches the placeholder inside *either* a single-quoted
// or double-quoted JS string literal — whichever esbuild chose for the source
// `'__PPTX_PDFIMPORT_WEBVIEW_BUNDLE_PLACEHOLDER__'`. We replace the entire
// quoted literal (quotes included) with a JSON.stringify result, which yields
// a syntactically valid double-quoted JS string with all required escapes
// handled (backslash, double-quote, control chars, line/paragraph
// separators). This is robust regardless of which quote style esbuild emits
// and avoids the brittleness of trying to escape into a specific context.
const PDF_IMPORT_BUNDLE_QUOTED_RE = new RegExp(
  `(["'])${PDF_IMPORT_BUNDLE_PLACEHOLDER}\\1`,
);

// ──────────────────────────────────────────────────────────────────────────
// Plugins for the extension bundle.
// ──────────────────────────────────────────────────────────────────────────

const buildInfoPlugin = {
  name: 'build-info',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      const outfile = build.initialOptions.outfile;
      if (!outfile || !fs.existsSync(outfile)) return;
      const original = fs.readFileSync(outfile, 'utf8');
      const payload = JSON.stringify(currentBuildInfo());
      const updated = original.replace(
        BUILD_INFO_PLACEHOLDER,
        escapeForJsString(payload),
      );
      if (updated !== original) fs.writeFileSync(outfile, updated);
    });
  },
};

// Inlines dist/pdfImport.webview.js into dist/extension.js by replacing the
// placeholder JS string literal with a JSON.stringify of the bundle source.
// JSON.stringify produces a valid double-quoted JS string, sidestepping any
// fragile per-context escaping.
//
// If the webview bundle hasn't been built yet (e.g. very first build, race
// condition in watch mode), we leave the placeholder alone and log a warning.
// A subsequent rebuild will fill it in.
const pdfImportBundlePlugin = {
  name: 'pdfimport-webview-bundle',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      const outfile = build.initialOptions.outfile;
      if (!outfile || !fs.existsSync(outfile)) return;
      if (!fs.existsSync(PDFIMPORT_WEBVIEW_OUTFILE)) {
        console.warn(
          `[esbuild] ${PDFIMPORT_WEBVIEW_OUTFILE} not built yet — placeholder left as-is. Build the webview bundle, then rebuild.`,
        );
        return;
      }
      const bundleSrc = fs.readFileSync(PDFIMPORT_WEBVIEW_OUTFILE, 'utf8');
      const original = fs.readFileSync(outfile, 'utf8');
      const updated = original.replace(
        PDF_IMPORT_BUNDLE_QUOTED_RE,
        () => JSON.stringify(bundleSrc),
      );
      if (updated === original) {
        // No match — likely already substituted or placeholder was elided.
        return;
      }
      fs.writeFileSync(outfile, updated);
      const kb = (bundleSrc.length / 1024).toFixed(0);
      console.log(`[esbuild] inlined pdfImport.webview.js (${kb} KB) → extension.js`);
    });
  },
};

// In watch mode, when the webview bundle is rebuilt, re-run the extension
// build so the placeholder gets refreshed. esbuild watch contexts don't
// share filesystem dependency graphs, so we wire this with a small filesystem
// poll on the webview output's mtime, signalling the extension context via
// its public `rebuild()` API.
function chainWebviewToExtensionRebuild(extensionCtx) {
  let lastMtime = 0;
  try {
    lastMtime = fs.statSync(PDFIMPORT_WEBVIEW_OUTFILE).mtimeMs;
  } catch {
    /* file may not exist yet */
  }
  setInterval(() => {
    try {
      const m = fs.statSync(PDFIMPORT_WEBVIEW_OUTFILE).mtimeMs;
      if (m !== lastMtime) {
        lastMtime = m;
        extensionCtx.rebuild().catch((err) => {
          console.error('[esbuild] extension rebuild after webview change failed:', err);
        });
      }
    } catch {
      /* race; try again on next tick */
    }
  }, 500).unref();
}

// ──────────────────────────────────────────────────────────────────────────
// Build option records.
// ──────────────────────────────────────────────────────────────────────────

const buildOptionsExtension = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: EXTENSION_OUTFILE,
  platform: 'browser',
  target: 'es2022',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
  minify: false,
  plugins: [buildInfoPlugin, pdfImportBundlePlugin],
};

const buildOptionsWebview = {
  entryPoints: ['src/pdfImportWebviewEntry.ts'],
  bundle: true,
  outfile: PDFIMPORT_WEBVIEW_OUTFILE,
  platform: 'browser',
  target: 'es2022',
  // IIFE keeps the bundle self-contained for inline-script embedding inside
  // the viewer iframe. No imports, no requires; just side-effect assignment
  // to globalThis.__pptxPdfImport from the entry file.
  format: 'iife',
  // No global name — the entry file does its own `globalThis.X = api` so we
  // don't need esbuild to wrap the bundle in a named-IIFE return.
  sourcemap: false,
  logLevel: 'info',
  // Minify the webview bundle since it's pdfjs-heavy; this is purely a size
  // win for the inlined string. The extension bundle stays unminified.
  minify: true,
};

(async () => {
  if (watch) {
    // Order matters: build webview first so the extension build can inline
    // its output on its very first run.
    const webviewCtx = await esbuild.context(buildOptionsWebview);
    await webviewCtx.rebuild();
    await webviewCtx.watch();
    const extensionCtx = await esbuild.context(buildOptionsExtension);
    await extensionCtx.rebuild();
    await extensionCtx.watch();
    chainWebviewToExtensionRebuild(extensionCtx);
    console.log('esbuild: watching (extension + pdfimport-webview)…');
  } else {
    await esbuild.build(buildOptionsWebview);
    await esbuild.build(buildOptionsExtension);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
