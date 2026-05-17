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

// Plugin: after every (re)build, write dist/build-info.json with a fresh
// timestamp + git SHA. The extension reads it at activation and logs both,
// so the user can confirm at a glance that a push has been picked up and
// that the browser isn't serving a cached older bundle.
//
// Notes:
// - onEnd runs on every successful build, including watch-mode rebuilds,
//   so the timestamp stays accurate across incremental rebuilds. Using
//   define/banner instead would freeze the value at context creation.
// - git rev-parse is best-effort; if it fails (e.g. detached state, no git)
//   we record "unknown" rather than blowing up the build.
const buildInfoPlugin = {
  name: 'build-info',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      let sha = 'unknown';
      try {
        sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .trim();
      } catch {
        // leave as 'unknown'
      }
      const info = { buildTime: new Date().toISOString(), gitSha: sha };
      const out = path.join(__dirname, 'dist', 'build-info.json');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(info));
    });
  },
};

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
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
