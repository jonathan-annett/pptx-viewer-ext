// Bundle the extension entrypoint for the VS Code web worker context.
// Output: dist/extension.js (single file, CommonJS so the VS Code loader can require it).
//
// Notes:
// - platform: 'browser' and target: 'es2022' produce code that runs in a web worker.
// - `vscode` is external — the host provides it at runtime.
// - We mark the bundle as CommonJS because VS Code's web extension loader uses
//   AMD/CommonJS-style `require`. esbuild's default IIFE format would break that.

const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const watch = process.argv.includes('--watch');

// The source contains this literal string; the plugin's onEnd hook rewrites
// it in the output bundle with a fresh JSON payload after every (re)build.
const PLACEHOLDER = '__PPTX_BUILD_INFO_PLACEHOLDER__';

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

// Plugin: post-process the emitted bundle to swap the placeholder string for
// the current build's metadata.
//
// Why post-process instead of esbuild's `define`: esbuild caches `define`
// values at context creation. Mutating them in onStart has no effect on
// watch-mode rebuilds — the substitution is frozen at watcher start. Reading
// the output file and rewriting in onEnd dodges this entirely. The rewrite
// targets dist/, which isn't watched, so there's no feedback loop.
//
// The placeholder is a unique constant; we replace only the first occurrence
// so source-map line counts aren't disturbed.
const buildInfoPlugin = {
  name: 'build-info',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      const outfile = build.initialOptions.outfile;
      if (!outfile || !fs.existsSync(outfile)) return;
      const original = fs.readFileSync(outfile, 'utf8');
      const payload = JSON.stringify(currentBuildInfo());
      // The placeholder appears inside a string literal in extension.ts, so
      // replacing it with the JSON text yields a still-valid string literal.
      const updated = original.replace(PLACEHOLDER, escapeForJsString(payload));
      if (updated !== original) fs.writeFileSync(outfile, updated);
    });
  },
};

// JSON-encoded text can contain " and \ characters that need re-escaping
// for the JS string literal context they're being substituted into.
function escapeForJsString(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: path.join(__dirname, 'dist', 'extension.js'),
  platform: 'browser',
  target: 'es2022',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
  minify: false,
  plugins: [buildInfoPlugin],
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('esbuild: watching...');
  } else {
    await esbuild.build(buildOptions);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
