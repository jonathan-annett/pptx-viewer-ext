// Query → projection scorer.
//
// Inputs: a folded+tokenised SearchQuery and a SearchProjection.
// Output: { score, matchedFields }. A score of 0 (with empty
// matchedFields) means "no match" — the engine drops these hits.
//
// Matching rules:
//   - AND across query terms (default). Every term in the query must
//     match at least one field; if any term fails to match anywhere, the
//     whole projection scores 0.
//   - OR across query terms (when query.op === 'or'). Any term hitting
//     any field qualifies the projection. Files that match more terms
//     still score higher because each hitting term adds to the running
//     total — so ranking still favours the most-relevant results, the
//     mode just widens what counts as a result at all.
//   - OR across fields (regardless of op). A term hits if it matches
//     `filename` OR `author` OR `slideText`. Each term records every
//     field it hit (so a term matching both filename and author
//     contributes to both, boosting the score).
//   - Prefix beats substring. A token starting with the term scores
//     higher than a token merely containing it. Exact-equal beats both.
//   - Shorter matching token beats longer (so "Soren" beats "Sorenson"
//     when the query is "soren").
//   - Field weight: filename ≈ author ≫ slideText. The use case is
//     "find the deck"; slide-body matches are a long-tail signal.
//
// The numeric scale of `score` has no fixed meaning — only the ordering
// matters. We keep it integer-friendly so the engine's sort is stable
// across runtimes.
//
// Pure module — no vscode, no DOM, no I/O. tsx-testable.

import type { SearchField, SearchProjection, SearchQuery } from './index-types';

// ───── per-field weights ─────────────────────────────────────────────────
// Filename + author dominate. SlideText is a tiebreaker / long-tail
// signal. The numbers are chosen so a single filename-prefix hit
// (BASE + PREFIX_BONUS = 1000 + 500 = 1500, × FILENAME_WEIGHT 3 = 4500)
// outscores three slideText-substring hits (1000 × 1 × 3 = 3000).
const FIELD_WEIGHT: Record<SearchField, number> = {
  filename: 3,
  author: 3,
  slideText: 1,
};

const BASE_MATCH = 1000;
const PREFIX_BONUS = 500;
const EXACT_BONUS = 1500;
// Penalty per extra character of the matching token beyond the term
// length. "soren" matching token "soren" gets BASE+PREFIX+EXACT;
// matching "sorenson" gets BASE+PREFIX − (8-5)*LENGTH_PENALTY.
const LENGTH_PENALTY = 5;

/** Score a single term against a single field's token array.
 *  Returns 0 when the term doesn't match any token. Otherwise returns
 *  the highest-scoring single-token match for that term in that field. */
function scoreTermAgainstField(term: string, tokens: string[]): number {
  if (term.length === 0) return 0;
  let best = 0;
  for (const tok of tokens) {
    if (tok.length === 0) continue;
    const idx = tok.indexOf(term);
    if (idx < 0) continue;
    let s = BASE_MATCH;
    if (idx === 0) s += PREFIX_BONUS;
    if (tok === term) s += EXACT_BONUS;
    // Subtract a fraction of the gap between token length and term
    // length so "soren" → "soren" beats "soren" → "sorenson".
    const extra = tok.length - term.length;
    if (extra > 0) s -= Math.min(extra * LENGTH_PENALTY, BASE_MATCH - 1);
    if (s > best) best = s;
  }
  return best;
}

export interface ScoreResult {
  score: number;
  matchedFields: SearchField[];
}

/**
 * Score `projection` against `query`. AND across query terms; OR across
 * fields per term. A term that matches no field anywhere zeroes the
 * whole score (the projection is not a hit).
 *
 * The empty query (no terms) returns score 0 with no matched fields;
 * the engine special-cases that to "show nothing" rather than "show
 * everything", since a search panel with a blank input shouldn't dump
 * the entire index.
 */
export function scoreProjection(
  projection: SearchProjection,
  query: SearchQuery,
): ScoreResult {
  if (query.terms.length === 0) return { score: 0, matchedFields: [] };

  const fieldsHit = new Set<SearchField>();
  let total = 0;
  // OR mode: surviving a single hitting term qualifies the projection. We
  // still walk every term so ranking benefits from multi-term matches.
  const orMode = query.op === 'or';

  for (const term of query.terms) {
    const fileScore = scoreTermAgainstField(term, projection.filenameTokens);
    const authorScore = scoreTermAgainstField(term, projection.authorTokens);
    const slideScore = scoreTermAgainstField(term, projection.slideTextTokens);

    const weighted =
      fileScore * FIELD_WEIGHT.filename +
      authorScore * FIELD_WEIGHT.author +
      slideScore * FIELD_WEIGHT.slideText;

    if (weighted === 0) {
      // AND short-circuit — one missed term means no match. In OR mode
      // we just skip this term and keep tallying the rest.
      if (orMode) continue;
      return { score: 0, matchedFields: [] };
    }
    total += weighted;
    if (fileScore > 0) fieldsHit.add('filename');
    if (authorScore > 0) fieldsHit.add('author');
    if (slideScore > 0) fieldsHit.add('slideText');
  }

  // Deterministic field ordering for the UI.
  const matchedFields: SearchField[] = [];
  if (fieldsHit.has('filename')) matchedFields.push('filename');
  if (fieldsHit.has('author')) matchedFields.push('author');
  if (fieldsHit.has('slideText')) matchedFields.push('slideText');

  return { score: total, matchedFields };
}
