// Pure filename-disambiguation for the archive-on-remove flow.
//
// When the search panel's "Update & remove source" archives a removed source
// deck, a file of the same name may already exist in the archive folder. The
// archive policy is "keep both, numbered suffix" — never overwrite — so we
// pick the first free `name (n).ext` variant.

/**
 * Return `name` unchanged when it isn't already taken; otherwise the first
 * `stem (n).ext` (n starting at 2) that isn't in `taken`. The extension is the
 * substring from the last dot (only when the dot isn't the first character, so
 * dotfiles keep their whole name as the stem). Comparison is exact/case-
 * sensitive — `taken` should hold the archive folder's real entry names.
 */
export function disambiguateFileName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  let candidate = `${stem} (${n})${ext}`;
  while (taken.has(candidate)) {
    n++;
    candidate = `${stem} (${n})${ext}`;
  }
  return candidate;
}
