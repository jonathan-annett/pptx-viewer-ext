// Workaround for Termux/Android: Node reports process.platform === 'android',
// but playwright-core (a transitive dep of @vscode/test-web) throws
// "Unsupported platform: android" at import time, before any flags can take
// effect. Termux is essentially Linux underneath, so spoofing the platform to
// 'linux' lets the module load. We pass --browserType=none anyway, so no
// chromium binary is ever resolved or launched.
//
// Preload via: node --require ./scripts/fix-platform.cjs <real entrypoint>
//
// Scoped narrowly: only used by the `open-in-browser` script, never imported
// by the extension source itself.
if (process.platform === 'android') {
  Object.defineProperty(process, 'platform', {
    value: 'linux',
    configurable: true,
    writable: false,
    enumerable: true,
  });
}
