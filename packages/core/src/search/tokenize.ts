// Tokeniser for search projections + queries.
//
// Splits an input string into search tokens with these rules:
//   - whitespace separates tokens
//   - punctuation and symbols separate tokens (anything not a Unicode
//     letter \p{L} or number \p{N} is a separator)
//   - hyphens and underscores are separators
//   - camelCase splits at lower→upper transitions
//     ("MyPresentation" → ["my","presentation"])
//   - letter↔digit transitions split ("v2Final" → ["v","2","final"])
//   - empty strings and pure-punctuation tokens are dropped
//   - all output tokens are folded (lowercased + NFD + diacritic-stripped)
//   - duplicate tokens within the same field are deduped (first-wins order)
//
// The scorer relies on tokens being short, folded, and unique per field —
// a query term "foo" matches a field by linear-scanning its token array
// for any token that starts with or contains "foo".
//
// Pure module — no vscode, no DOM. tsx-testable.

import { fold } from './fold';

/**
 * Split `input` into the canonical search tokens for a single field.
 *
 * Approach:
 *   1. Insert spaces at camelCase + letter/digit boundaries on the *raw*
 *      input (lowercasing happens after, so the upper→lower signal would
 *      be gone if we folded first).
 *   2. Fold the whole thing.
 *   3. Split on runs of non-letter / non-digit codepoints.
 *   4. Drop empties; dedupe preserving first-appearance order.
 *
 * Returns an empty array for empty / whitespace-only / pure-punctuation
 * input. Non-Latin scripts (Cyrillic, Greek, CJK …) survive intact:
 * they're kept as token content via \p{L}, and camelCase boundary
 * insertion uses ASCII-only patterns so it doesn't misfire on them.
 */
export function tokenize(input: string): string[] {
  if (!input) return [];
  // Insert boundaries on raw input. camelCase + letter/digit only — these
  // are Latin-script signals; doing this on the folded (lowercased) string
  // wouldn't work because the upper/lower distinction is gone.
  const withBoundaries = input
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2');
  const folded = fold(withBoundaries);
  // Anything that isn't a Unicode letter or number is a separator.
  const parts = folded.split(/[^\p{L}\p{N}]+/u);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of parts) {
    if (t.length === 0) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
