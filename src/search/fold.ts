// Case + diacritic folding for search matching.
//
// "Sören" → "soren", "Café" → "cafe", "Åse" → "ase". The fold is applied
// once per field at index time and once per query at search time; the
// stored projection holds already-folded strings, so search itself is
// just a substring/prefix scan on the result.
//
// Approach: NFD-normalise (so "é" decomposes to "e" + COMBINING ACUTE
// ACCENT), then strip every Unicode combining mark via the `\p{M}`
// property class, then lowercase. NFD + \p{M} together cover Latin,
// Greek, Cyrillic, Hebrew, Arabic, Devanagari, etc.
//
// `ß → ss` is NOT folded — `String.prototype.normalize('NFD')` keeps it
// as 'ß' and `toLowerCase()` keeps it as 'ß'. The German lowercase rules
// are special-cased and we deliberately don't try to be clever; a user
// searching for "Strasse" won't match a filename "Straße" and vice
// versa. If this comes up in practice, layer it in.
//
// Pure module — no vscode, no DOM. Runs identically in Node (tests) and
// the web worker (extension host).

/**
 * Lowercase + NFD + strip combining marks. Result is a string suitable
 * for substring/prefix comparison against another `fold()`-ed string.
 *
 * Idempotent: `fold(fold(s)) === fold(s)` for every `s`. Tests rely on
 * that property to assert correctness of the projection layer's
 * pre-folding invariant.
 *
 * Empty input → empty output.
 */
export function fold(input: string): string {
  if (!input) return '';
  return input.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}
