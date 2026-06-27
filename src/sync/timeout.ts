// Bounded-await helper for folder I/O that can hang.
//
// On web (File System Access), an unavailable folder — revoked permission, a
// disconnected drive, an offline remote PC — makes stat/read/enumerate calls
// hang indefinitely rather than reject. A sync fans out to multiple
// destinations for REDUNDANCY, so one unreachable destination must never block
// or fail the reachable ones. Wrapping each per-destination I/O step in
// `withTimeout` bounds the hang; the caller treats a timeout like any other
// per-destination failure and carries on with the rest.

export class TimeoutError extends Error {
  constructor(
    public readonly label: string,
    public readonly ms: number,
  ) {
    super(`timed out after ${ms}ms: ${label}`);
    this.name = 'TimeoutError';
  }
}

/**
 * Resolve `p`, or reject with {@link TimeoutError} after `ms`. The underlying
 * promise keeps running (it can't be cancelled here) but its result is ignored
 * — fine for idempotent reads/walks. `label` is for the error message + logs.
 */
export async function withTimeout<T>(
  p: Thenable<T> | Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([Promise.resolve(p), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
