// Pure parser + applier for per-row decision messages posted by the plan
// webview. No vscode import — the wired counterpart lives in planView.ts
// and just adds logging on top of these helpers.
//
// M5 Phase B: decisions are captured in-memory for the lifetime of the
// plan panel. Phase C persists them into the manifest's `decisions` map
// (see manifest-types.ts) and threads them into the executor.

/**
 * A single per-row decision captured from the webview. The id is the
 * stable identifier emitted by the renderer
 * (`${pairIndex}:${kind}:${relPath}`) — unique within a plan panel and
 * stable across DOM updates, which is what an in-memory map needs.
 */
export interface RowDecision {
  id: string;
  kind: 'overwrite' | 'delete';
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
  const kind = m.kind === 'overwrite' || m.kind === 'delete' ? m.kind : undefined;
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
