// SHA-256 hashing via the Web Crypto API.
// The web-extension host has crypto.subtle; we don't use Node's crypto here
// because that module isn't available in the worker context.

/**
 * Compute the SHA-256 of a byte buffer and return a lowercase hex string.
 * Empty input yields the conventional empty-bytes digest.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // crypto.subtle.digest returns an ArrayBuffer of the digest bytes (32 for
  // SHA-256). Convert via Uint8Array → array of byte values → hex.
  // Slice into a fresh, owned ArrayBuffer to sidestep TS5's strict
  // ArrayBuffer vs SharedArrayBuffer typing on Uint8Array's underlying buffer.
  // Runtime cost is one copy of the input bytes per hash.
  const buf = bytes.slice().buffer;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    const b = view[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}
