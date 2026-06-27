// Stable per-destination identity (GUIDs) for `.sync.jsonc` destinations.
//
// No vscode import — pure text + crypto, runnable under plain Node via tsx
// (see test/sync-destination-id.test.ts). The wired reconnect flow
// (reconnectDestinations.ts) delegates the text edits back here so the JSONC
// formatting/comment-preserving behaviour is testable without a host.
//
// WHY a GUID alongside the URI: a destination is matched live by its `uri`
// (topology.ts), but on web the URI is an FSA handle string that changes when
// the folder is re-granted. The GUID is the durable identity that lets the
// reconnect flow rewrite a stale URI while still knowing it's "the same
// destination". Stamping is LAZY — written when a destination is reconnected
// or its config is saved through the form editor — never eagerly on load (a
// write-on-load pass would risk an FSA write-storm / reload re-entrancy).

import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser';

// Matches the formatting the config editor uses (configEditor.ts FORMATTING)
// so a stamp/rewrite produces edits consistent with the rest of the file.
const FORMATTING = { insertSpaces: true, tabSize: 2, eol: '\n' } as const;

/**
 * Generate an opaque destination id. Format: `d-` + 16 random bytes as hex
 * (mirrors the `makeNonce` idiom in provider.ts — `crypto.getRandomValues` is
 * available in both the web-extension worker and modern Node). The `d-` prefix
 * makes the value self-describing in a hand-read config.
 *
 * Injectable random source so tests are deterministic.
 */
export function generateDestinationId(
  randomBytes: (n: number) => Uint8Array = defaultRandomBytes,
): string {
  const arr = randomBytes(16);
  const hex = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  return `d-${hex}`;
}

function defaultRandomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

/** A destination entry as it appears positionally in a parsed config. */
export interface RawDestination {
  index: number;
  uri: string;
  id?: string;
}

/**
 * Parse just the `destinations` array out of raw `.sync.jsonc` text, preserving
 * each entry's array index (needed to target a precise `modify` path). Returns
 * `null` when the text doesn't parse or has no destinations array — the caller
 * treats that as "nothing to rewrite". Tolerant: a malformed individual entry
 * is skipped rather than failing the whole read.
 */
export function readRawDestinations(text: string): RawDestination[] | null {
  const errors: ParseError[] = [];
  const raw: unknown = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const destsRaw = (raw as Record<string, unknown>).destinations;
  if (!Array.isArray(destsRaw)) return null;
  const out: RawDestination[] = [];
  for (let i = 0; i < destsRaw.length; i++) {
    const e = destsRaw[i];
    if (e === null || typeof e !== 'object' || Array.isArray(e)) continue;
    const rec = e as Record<string, unknown>;
    if (typeof rec.uri !== 'string' || rec.uri.length === 0) continue;
    out.push({
      index: i,
      uri: rec.uri,
      id: typeof rec.id === 'string' && rec.id.length > 0 ? rec.id : undefined,
    });
  }
  return out;
}

/**
 * Locate the destination entry to act on. Prefers an `id` match (the durable
 * identity) and falls back to a `uri` match for entries not yet stamped. The
 * URI compared is the OLD/on-disk value — at reconnect time the file still
 * carries the stale URI, so `(configText, oldUri)` uniquely picks the entry.
 */
export function findDestination(
  dests: RawDestination[],
  match: { id?: string; uri: string },
): RawDestination | undefined {
  if (match.id) {
    const byId = dests.find((d) => d.id === match.id);
    if (byId) return byId;
  }
  return dests.find((d) => d.uri === match.uri);
}

export interface RewriteResult {
  /** New file text with the destination's URI (and id, if newly stamped) set. */
  text: string;
  /** The id now on the entry — pre-existing or freshly generated. */
  id: string;
  /** True when no matching destination was found (text returned unchanged). */
  notFound?: boolean;
}

/**
 * Rewrite one destination's `uri` to `newUri` and ensure it carries a stable
 * `id` (generating one if absent), via comment/format-preserving JSONC edits.
 * Used by the reconnect flow: the same edit both re-points the destination and
 * stamps its GUID so future reconnects are id-keyed.
 *
 * The match is by id-then-uri (see {@link findDestination}). If nothing
 * matches, returns the text unchanged with `notFound: true`.
 */
export function rewriteDestinationUri(
  text: string,
  match: { id?: string; uri: string },
  newUri: string,
  generateId: () => string = () => generateDestinationId(),
): RewriteResult {
  const dests = readRawDestinations(text);
  const target = dests ? findDestination(dests, match) : undefined;
  if (!target) {
    return { text, id: match.id ?? '', notFound: true };
  }
  const id = target.id ?? generateId();
  let out = text;
  out = applyEdits(
    out,
    modify(out, ['destinations', target.index, 'uri'], newUri, { formattingOptions: FORMATTING }),
  );
  if (!target.id) {
    out = applyEdits(
      out,
      modify(out, ['destinations', target.index, 'id'], id, { formattingOptions: FORMATTING }),
    );
  }
  return { text: out, id };
}

/**
 * Stamp every destination that lacks an `id` with a freshly-generated one,
 * preserving comments/formatting. Returns the new text and the number of
 * entries stamped (0 → text unchanged). Used to keep ids sticky when a config
 * is saved through the form editor and as a one-shot "assign ids" pass.
 */
export function stampMissingIds(
  text: string,
  generateId: () => string = () => generateDestinationId(),
): { text: string; stamped: number } {
  const dests = readRawDestinations(text);
  if (!dests) return { text, stamped: 0 };
  let out = text;
  let stamped = 0;
  // Indices are stable across `modify` calls here because adding an `id` key to
  // an object doesn't shift sibling array positions.
  for (const d of dests) {
    if (d.id) continue;
    out = applyEdits(
      out,
      modify(out, ['destinations', d.index, 'id'], generateId(), {
        formattingOptions: FORMATTING,
      }),
    );
    stamped++;
  }
  return { text: out, stamped };
}
