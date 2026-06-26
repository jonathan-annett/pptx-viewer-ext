// Lightweight timing helpers for the `sync-timing:` instrumentation.
//
// The parse path already emits a `parse-timing:` breakdown (see provider.ts);
// the sync path had none, so plan-build vs execute costs could only be inferred
// from wall-clock gaps between unrelated log lines. These helpers let the
// planner / runSync emit the same shape of line so the two big phases (the
// destination walk vs the actual copy) become directly measurable.
//
// Pure + host-agnostic: `performance.now()` exists in both the web-worker
// extension host and Node (desktop), with a `Date.now()` fallback.

export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Format a millisecond duration the same way the parse-timing line does: one
 * decimal under 10ms (so sub-millisecond phases stay visible), an integer
 * above that.
 */
export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '?';
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}
