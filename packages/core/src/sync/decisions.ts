// Pure parser + applier for per-row decision messages posted by the plan
// webview. No vscode import — the wired counterpart lives in planView.ts
// and just adds logging on top of these helpers.
//
// M5 Phase B: decisions are captured in-memory for the lifetime of the
// plan panel. Phase C persists them into the manifest's `decisions` map
// (see manifest-types.ts) and threads them into the executor.

import type { PlanItem } from './plan';
import { hasOverridableWarningOnly } from './plan';

/**
 * A single per-row decision captured from the webview. The id is the
 * stable identifier emitted by the renderer
 * (`${pairIndex}:${kind}:${relPath}`) — unique within a plan panel and
 * stable across DOM updates, which is what an in-memory map needs.
 *
 * Three kinds, one per category of risk the user is arming:
 *  - 'overwrite'        — collision row; user accepts overwriting the
 *                         destination's current bytes.
 *  - 'delete'           — destination-only row; user accepts removing the
 *                         file from the destination.
 *  - 'warning-override' — green-path row whose only warnings are 'override'
 *                         severity (e.g. pptx media-controls + embedded
 *                         video). User accepts shipping the file despite
 *                         the validator concern. Only emitted on rows that
 *                         AREN'T collisions — on a collision row, the
 *                         overwrite arming implicitly covers the warning.
 */
export interface RowDecision {
  id: string;
  kind: 'overwrite' | 'delete' | 'warning-override';
  relPath: string;
  /**
   * `true` when the user checked the box (opt-in to overwrite/delete);
   * `false` when they unchecked it (back to the safe default).
   */
  accepted: boolean;
  /**
   * `true` when the companion "Don't ask again" box is ticked alongside the
   * primary accept. Only meaningful when `accepted` is also true — the
   * webview script disables the companion box when the primary is unticked.
   * Phase C uses this flag to persist a `ManifestDecision` for the row.
   */
  remember: boolean;
}

/**
 * Validate an untyped webview message into a RowDecision, or return
 * `undefined` if anything's off. Untrusted input — every field is
 * checked before we hand the result to a downstream caller.
 */
export function parseDecisionMessage(msg: unknown): RowDecision | undefined {
  if (!msg || typeof msg !== 'object') return undefined;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'decision') return undefined;
  const id = typeof m.id === 'string' ? m.id : undefined;
  const kind =
    m.kind === 'overwrite' || m.kind === 'delete' || m.kind === 'warning-override'
      ? m.kind
      : undefined;
  const relPath = typeof m.relPath === 'string' ? m.relPath : undefined;
  const accepted = typeof m.accepted === 'boolean' ? m.accepted : undefined;
  if (!id || !kind || !relPath || accepted === undefined) return undefined;
  // `remember` is optional in the message — pre-Phase-C webviews never sent
  // it. Treat missing/non-boolean as `false`, and ignore the flag entirely
  // when `accepted` is false (remember-without-accept is not a thing).
  const remember = typeof m.remember === 'boolean' ? m.remember : false;
  return { id, kind, relPath, accepted, remember: accepted ? remember : false };
}

/**
 * Apply a decision to the in-memory map. Accepted = store; rejected =
 * delete (absence is the safe default, which Phase C reads as "skip this
 * row"). Returns the new map size — useful for the caller to log a count
 * without re-counting.
 */
export function applyDecision(
  decisions: Map<string, RowDecision>,
  decision: RowDecision,
): number {
  if (decision.accepted) {
    decisions.set(decision.id, decision);
  } else {
    decisions.delete(decision.id);
  }
  return decisions.size;
}

/**
 * Count the rows the user has armed (i.e. `accepted: true`). Absences and
 * explicit unticks are not counted.
 */
export function countAccepted(decisions: ReadonlyMap<string, RowDecision>): number {
  let n = 0;
  for (const d of decisions.values()) if (d.accepted) n++;
  return n;
}

/**
 * Validate-and-apply an untyped webview message in one call. The shared
 * shape every embedded plan surface uses: parse → apply → log. Pure module,
 * so the host supplies its own logger (vscode `log` channel writer). Returns
 * the applied decision when the message was well-formed and the map was
 * updated; returns `undefined` for malformed input (host is responsible for
 * reporting that, since severity / channel are host-specific).
 *
 * The logger callback receives a human-readable one-line summary suitable
 * for the host's debug channel — keeps the formatting consistent across the
 * standalone webview, admin editor, room editor, and pptx viewer.
 */
export function handleDecisionMessage(
  msg: unknown,
  decisions: Map<string, RowDecision>,
  log?: (line: string) => void,
): RowDecision | undefined {
  const decision = parseDecisionMessage(msg);
  if (!decision) {
    if (log) log('decision message rejected (malformed)');
    return undefined;
  }
  applyDecision(decisions, decision);
  if (log) {
    const rememberBit = decision.accepted && decision.remember ? ' (remember)' : '';
    log(
      `decision ${decision.accepted ? 'set' : 'cleared'}${rememberBit} — ` +
        `${decision.kind} ${decision.relPath} (total accepted: ${countAccepted(decisions)})`,
    );
  }
  return decision;
}

/**
 * Seed the in-memory decisions map from plan items that carry a remembered
 * "don't ask again" decision in the manifest. The renderer pre-checks these
 * rows in the HTML (`withDecision({ checked: true, remembered: true })`),
 * but a pre-checked DOM checkbox does NOT fire a `change` event on page
 * load — so without seeding, the extension's view of armed decisions stays
 * empty while the user thinks they're armed. Clicking Run Sync then runs
 * the executor with zero armed overrides and the safe-path skip logic
 * filters everything out. (Symptom: first orange click does nothing;
 * second click — after manually toggling the box — works.)
 *
 * Mirrors `toViewModel` in planHtml.ts: pairIndex is positional in the
 * plans array (same iteration order both sides use), and the decision id
 * is `${pairIndex}:${kind}:${relPath}`.
 *
 * Returns the number of decisions added — useful for the host's debug log.
 *
 * Structurally typed on the plan parameter so callers don't have to bring
 * in `PlanForDestination` (which transitively imports vscode types).
 */
export function seedRememberedDecisions(
  plans: readonly { readonly items: readonly PlanItem[] }[],
  decisions: Map<string, RowDecision>,
): number {
  let added = 0;
  let pairIndex = -1;
  for (const plan of plans) {
    pairIndex++;
    for (const item of plan.items) {
      if (!item.remembered?.accepted) continue;
      let kind: RowDecision['kind'];
      if (item.kind === 'update-collision') {
        kind = 'overwrite';
      } else if (item.kind === 'destination-only') {
        kind = 'delete';
      } else if (
        (item.kind === 'create' || item.kind === 'update-tracked') &&
        hasOverridableWarningOnly(item)
      ) {
        kind = 'warning-override';
      } else {
        continue;
      }
      const id = `${pairIndex}:${kind}:${item.relPath}`;
      decisions.set(id, {
        id,
        kind,
        relPath: item.relPath,
        accepted: true,
        remember: true,
      });
      added++;
    }
  }
  return added;
}
