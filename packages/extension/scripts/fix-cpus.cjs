// Workaround for Termux/Android: os.cpus() returns an empty array because
// /proc/cpuinfo is not accessible from the app sandbox. Many Node tools
// (including @secretlint/node, which vsce uses) read os.cpus().length as a
// default concurrency and pass it to p-map, which rejects 0.
//
// Preload this with `node --require` to clamp os.cpus() to at least one entry.
// os.availableParallelism() does work on Termux (returns the real core count)
// so we prefer that when patching.
const os = require('os');
const originalCpus = os.cpus.bind(os);
os.cpus = function () {
  const result = originalCpus();
  if (Array.isArray(result) && result.length > 0) return result;
  const n = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 1;
  // Minimal shape; consumers only ever read .length for our purposes.
  return Array.from({ length: Math.max(n, 1) }, () => ({
    model: 'unknown',
    speed: 0,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  }));
};
