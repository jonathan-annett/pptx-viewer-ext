// Bundle the extension entrypoint for the VS Code web worker context.
// Output: dist/extension.js (single file, CommonJS so the VS Code loader can require it).
//
// Notes:
// - platform: 'browser' and target: 'es2022' produce code that runs in a web worker.
// - `vscode` is external — the host provides it at runtime.
// - We mark the bundle as CommonJS because VS Code's web extension loader uses
//   AMD/CommonJS-style `require`. esbuild's default IIFE format would break that.

const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

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
