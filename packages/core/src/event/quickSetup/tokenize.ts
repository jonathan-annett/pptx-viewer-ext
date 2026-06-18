// Tokenization rules for the Quick Setup New Event wizard's free-text
// inputs (day labels, timeslot labels, room names). Pure module — zero
// vscode imports — so the rules can be exercised under plain Node via
// tsx (see test/quickSetup-tokenize.test.ts).
//
// The wizard surfaces validation errors back to the user as inline
// `showInputBox` validateInput strings. The error messages here are
// the strings the user actually sees, so they're kept terse but
// specific.
//
// See `event-quick-setup-v1-plan.md` for the rule rationale.

/** Filesystem-unsafe characters stripped silently during sanitization. */
const FORBIDDEN_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/** Control characters (`\x00`-`\x1f` + DEL `\x7f`) — also stripped. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/**
 * Sanitize a single raw token. Rules:
 *
 * 1. Strip `\/:*?"<>|` and control chars silently.
 * 2. Trim leading + trailing whitespace.
 * 3. If the trimmed result has no embedded whitespace, preserve casing
 *    exactly and return.
 * 4. Otherwise camelCase across whitespace: preserve the first word's
 *    casing untouched, capitalize the first character of every
 *    subsequent word, drop the separating whitespace.
 *
 * `"May Day 1"` → `"MayDay1"`, `"may day 1"` → `"mayDay1"`,
 * `"MAY day 1"` → `"MAYDay1"`, `"MON"` → `"MON"`, `"  spaced  "` → `"spaced"`.
 *
 * Returns the empty string for inputs that sanitize down to nothing
 * (whitespace-only, forbidden-chars-only). Callers should treat empty
 * output as an invalid input.
 */
export function sanitizeToken(raw: string): string {
  const stripped = raw
    .replace(FORBIDDEN_FILENAME_CHARS, '')
    .replace(CONTROL_CHARS, '');
  const trimmed = stripped.trim();
  if (trimmed.length === 0) return '';

  // Split on any internal whitespace run. The trim above guarantees
  // there are no leading/trailing empty words from this split.
  const words = trimmed.split(/\s+/);
  if (words.length === 1) return words[0];

  let out = words[0];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.length === 0) continue;
    out += w[0].toUpperCase() + w.slice(1);
  }
  return out;
}

/**
 * Split a comma-separated wizard input into raw entries: trim each
 * piece, drop empties. Callers feed the result into {@link sanitizeToken}
 * + {@link detectCollisions} to turn it into validated tokens.
 *
 * Whitespace surrounding commas is forgiving (`"MON, TUE"` parses as
 * `["MON", "TUE"]`). Whitespace *inside* a token survives so
 * sanitizeToken can camelCase it (`"May Day 1, Day 2"` parses as
 * `["May Day 1", "Day 2"]`).
 */
export function splitCommaInput(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface CollisionInfo {
  /** The token both raws sanitize to. */
  token: string;
  /** The two-or-more raw inputs that collided. Original order preserved. */
  raws: string[];
}

export interface CollisionResult {
  /** Sanitized token per input, same order + length as `raws` argument. */
  tokens: string[];
  /** Empty when no collisions. One entry per colliding token group. */
  collisions: CollisionInfo[];
}

/**
 * Sanitize each raw and report any post-sanitization collisions. The
 * wizard refuses to proceed when collisions are non-empty — see plan
 * tokenization rule 3.
 *
 * Tokens are compared by exact string match — `"mon"` and `"MON"` do
 * NOT collide (they sanitize to distinct tokens). Empty tokens
 * (sanitized down to nothing) appear in `tokens` but don't produce
 * collisions; the wizard surfaces them as "invalid entry" via a
 * separate check.
 */
export function detectCollisions(raws: readonly string[]): CollisionResult {
  const tokens = raws.map(sanitizeToken);
  const groups = new Map<string, string[]>();
  tokens.forEach((tok, i) => {
    if (tok.length === 0) return;
    const list = groups.get(tok) ?? [];
    list.push(raws[i]);
    groups.set(tok, list);
  });
  const collisions: CollisionInfo[] = [];
  for (const [token, group] of groups) {
    if (group.length > 1) collisions.push({ token, raws: group });
  }
  return { tokens, collisions };
}

/**
 * Timeslot-specific pre-sanitization check. `:` is filesystem-unsafe
 * on Windows and Mac, so it would be stripped silently — but the
 * wizard explains the chronological-sort constraint explicitly so the
 * user understands *why* `"9:30"` isn't accepted.
 *
 * Returns `{ ok: false, reason }` if the raw contains `:`; otherwise
 * `{ ok: true }`. The wizard surfaces `reason` via validateInput.
 */
export function isTimeslotInputValid(
  raw: string,
): { ok: true } | { ok: false; reason: string } {
  if (raw.includes(':')) {
    return {
      ok: false,
      reason:
        "`:` isn't filename-safe — use `0930` or `09_30` so the OS sorts " +
        'timeslots chronologically.',
    };
  }
  return { ok: true };
}

export interface ValidationError {
  /** User-facing message string. Wizard returns this from validateInput. */
  message: string;
}

/**
 * Validate a comma-separated list input end-to-end: split, sanitize,
 * check that there is at least one usable entry, surface any empty
 * entries (forbidden-chars-only raws), surface collisions. Used by
 * the wizard's day-labels / timeslot-labels / room-names steps.
 *
 * `kind` is the noun shown in error messages ("day", "timeslot",
 * "room") so the user knows which input they're looking at.
 *
 * Returns either the validated sanitized tokens or a single error
 * string suitable for `showInputBox`'s validateInput callback.
 */
export function validateCommaList(
  raw: string,
  kind: 'day' | 'timeslot' | 'room',
): { ok: true; tokens: string[] } | { ok: false; reason: string } {
  if (kind === 'timeslot') {
    const tsCheck = isTimeslotInputValid(raw);
    if (!tsCheck.ok) return { ok: false, reason: tsCheck.reason };
  }
  const raws = splitCommaInput(raw);
  if (raws.length === 0) {
    return { ok: false, reason: `Enter at least one ${kind} label.` };
  }
  const { tokens, collisions } = detectCollisions(raws);

  // Surface any entry that sanitized down to nothing first — the
  // collision check skips empties, so this catches forbidden-chars-only
  // before "no collisions" passes silently.
  const emptyIndices = tokens
    .map((t, i) => (t.length === 0 ? i : -1))
    .filter((i) => i >= 0);
  if (emptyIndices.length > 0) {
    const raw0 = raws[emptyIndices[0]];
    return {
      ok: false,
      reason: `"${raw0}" has no usable characters after stripping \\/:*?"<>|.`,
    };
  }

  if (collisions.length > 0) {
    const c = collisions[0];
    return {
      ok: false,
      reason: `${
        c.raws.length
      } entries collide on token "${c.token}": ${c.raws
        .map((r) => `"${r}"`)
        .join(', ')}. Edit one before continuing.`,
    };
  }

  return { ok: true, tokens };
}

/**
 * Validate the event-name input. Distinct from the comma-list path
 * because it's a single token, not a list. Required (non-empty after
 * sanitize), length-capped to keep the resulting folder name sane.
 */
export function validateEventName(
  raw: string,
): { ok: true; token: string } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'Enter an event name.' };
  }
  if (trimmed.length > 64) {
    return {
      ok: false,
      reason: `Event name is ${trimmed.length} chars; keep it ≤ 64.`,
    };
  }
  const token = sanitizeToken(trimmed);
  if (token.length === 0) {
    return {
      ok: false,
      reason: `"${trimmed}" has no usable characters after stripping \\/:*?"<>|.`,
    };
  }
  return { ok: true, token };
}

/**
 * Validate the speakers input. Optional (empty input is fine). When
 * present, splits the comma list, checks that each name has *some*
 * filesystem-safe content (the names go into the .eventSchedule
 * verbatim, so they can carry spaces + casing — but a name made up
 * entirely of forbidden chars is still a typo).
 *
 * Speaker names are NOT sanitized; the raw display name is preserved.
 * Only validated for "has at least one non-forbidden char". Duplicate
 * names *are* refused — two "John Smith" entries would produce
 * indistinguishable speaker rows in the editor.
 */
export function validateSpeakerNames(
  raw: string,
): { ok: true; names: string[] } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, names: [] };
  const names = splitCommaInput(trimmed);
  if (names.length === 0) return { ok: true, names: [] };

  for (const n of names) {
    const stripped = n
      .replace(FORBIDDEN_FILENAME_CHARS, '')
      .replace(CONTROL_CHARS, '')
      .trim();
    if (stripped.length === 0) {
      return {
        ok: false,
        reason: `"${n}" has no usable characters after stripping \\/:*?"<>|.`,
      };
    }
  }

  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) {
      return {
        ok: false,
        reason: `"${n}" appears twice. Speaker names must be unique.`,
      };
    }
    seen.add(n);
  }

  return { ok: true, names };
}
