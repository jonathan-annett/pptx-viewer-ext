// Pure HTML rendering of the M2 plan structure for the M3 webview.
//
// No vscode import — this module is a pure transform from
// PlanForDestination[] (via a serialisable view model) into an HTML string.
// That makes the renderer smoke-testable under plain Node alongside the
// other sync tests; the vscode-touching half lives in planView.ts.

import type { PlanForDestination } from './planner';
import type { PlanItem, PlanWarning } from './plan';
import { hasBlockingWarning, hasOverridableWarningOnly } from './plan';

// ───── view model ────────────────────────────────────────────────────────
//
// The view model is a serializable subset of the plan — everything the
// renderer needs and nothing it doesn't. Keeping it free of vscode.Uri
// makes the rendering function testable under plain Node.

export interface PlanRowView {
  relPath: string;
  /**
   * Size to display. Sourced from sourceSize when available (creates,
   * updates, skips), or destSize (delete-tracked, destination-only).
   */
  sizeBytes?: number;
  sourceHashShort?: string;
  destHashShort?: string;
  manifestHashShort?: string;
  /**
   * Validator warnings attached to the source file. Rendered inline as a
   * sub-list beneath the path row when present. The Validation warnings
   * section uses the same renderRow path — it's a derived "all items with
   * a warning" view, deduplicated from the primary category sections.
   */
  warnings?: PlanWarningView[];
  /**
   * Interactive decision attached at view-model time for collision and
   * destination-only rows. The webview emits a `<input type=checkbox>`
   * keyed to `id`; the webview script tracks the state, posts toggles to
   * the extension, and recomputes the "all blocks decided" flag that drives
   * the footer's traffic-light state. Other rows (creates, skips, updates,
   * delete-tracked) have no decision affordance — they're either always
   * safe (greens) or already accounted for by the manifest.
   */
  decision?: PlanRowDecisionView;
}

export interface PlanWarningView {
  code: string;
  message: string;
}

export interface PlanRowDecisionView {
  /**
   * Stable across renders within the same plan view, so the webview script
   * can persist toggle state across DOM updates if it ever rebuilds the
   * row list. Format: `${pairIndex}:${kind}:${relPath}`.
   */
  id: string;
  /**
   * Which user-intent this row collects:
   *  - 'overwrite'        — collision row; arm to overwrite destination bytes.
   *  - 'delete'           — destination-only row; arm to delete from dest.
   *  - 'warning-override' — green-path row with override-severity warnings;
   *                         arm to ship despite the validator concern.
   */
  kind: 'overwrite' | 'delete' | 'warning-override';
  /** Checkbox-adjacent label, e.g. "Overwrite" or "Sync anyway". */
  label: string;
  /**
   * Initial checked state for the input. Set to `true` when the manifest
   * already records a "don't ask again" decision for this file — the user
   * can still untick to opt out for this run, but the box starts armed.
   */
  checked?: boolean;
  /**
   * Initial state for the companion "Don't ask again" checkbox. Only ever
   * `true` for rows whose remembered decision came from the manifest — a
   * fresh row never starts with Remember pre-armed.
   */
  remembered?: boolean;
}

export interface PlanPairView {
  sourceLabel: string;
  destLabel: string;
  /** Skipped reason from the planner (e.g. unresolved destination). */
  skippedReason?: string;
  sections: {
    create: PlanRowView[];
    updateTracked: PlanRowView[];
    updateCollision: PlanRowView[];
    skip: PlanRowView[];
    deleteTracked: PlanRowView[];
    destinationOnly: PlanRowView[];
    /** Derived view: items from the categories above that carry warnings. */
    warnings: PlanRowView[];
  };
}

export interface PlanTotals {
  create: number;
  updateTracked: number;
  updateCollision: number;
  skip: number;
  deleteTracked: number;
  destinationOnly: number;
  /**
   * All items carrying at least one validator warning — the union of
   * blocking + overridable below. Footer + chips use the breakdown; this
   * total stays here for back-compat with embedded callers that just want
   * "is there a validator concern at all?".
   */
  warnings: number;
  /**
   * Items with at least one 'block'-severity warning (e.g. kiosk show mode,
   * externally-linked media). These can never ship — no per-file override
   * exists; the user must fix the source file and re-plan.
   */
  blockingWarnings: number;
  /**
   * Items whose only warnings are 'override' severity (e.g. media-controls
   * + embedded video). These can ship via the "Sync anyway" affordance on
   * the row, which arms a warning-override decision for the executor.
   */
  overridableWarnings: number;
  /** Source/destination pairs that couldn't be planned (unresolved, etc). */
  skipped: number;
}

export interface PlanViewModel {
  /** Human-readable scope summary, e.g. "Sync everything — 2 sources × 3 destinations". */
  scopeLabel: string;
  pairs: PlanPairView[];
  totals: PlanTotals;
}

export interface ToViewModelOpts {
  /**
   * When `true` (default), collision rows get an Overwrite checkbox and
   * destination-only rows get a Delete checkbox — wired up by the
   * standalone plan webview's footer script. Embedded callers (config
   * editor preview, admin editor, viewer sync-target preview) pass
   * `false`: they show the same row data read-only, with no decision UI,
   * because they have no message channel back to the plan controller.
   */
  interactive?: boolean;
}

/**
 * Turn the planner's output into a serializable view model. The `labelSource`
 * callback resolves a source's display label — supplied by the caller so
 * this function stays vscode-free.
 */
export function toViewModel(
  plans: readonly PlanForDestination[],
  labelSource: (plan: PlanForDestination) => string,
  opts: ToViewModelOpts = {},
): PlanViewModel {
  const interactive = opts.interactive !== false;
  const pairs: PlanPairView[] = [];
  const totals: PlanTotals = {
    create: 0,
    updateTracked: 0,
    updateCollision: 0,
    skip: 0,
    deleteTracked: 0,
    destinationOnly: 0,
    warnings: 0,
    blockingWarnings: 0,
    overridableWarnings: 0,
    skipped: 0,
  };

  let destCount = 0;
  const seenSources = new Set<string>();

  let pairIndex = -1;
  for (const plan of plans) {
    pairIndex++;
    const srcKey = labelSource(plan);
    seenSources.add(srcKey);
    destCount++;

    const destLabel = plan.destination.subpath
      ? `${plan.destination.name} /${plan.destination.subpath}`
      : plan.destination.name;

    if (plan.skippedReason) {
      totals.skipped++;
      pairs.push({
        sourceLabel: srcKey,
        destLabel,
        skippedReason: plan.skippedReason,
        sections: emptySections(),
      });
      continue;
    }

    const s = plan.summary;
    totals.create += s.create.length;
    totals.updateTracked += s.updateTracked.length;
    totals.updateCollision += s.updateCollision.length;
    totals.skip += s.skip.length;
    totals.deleteTracked += s.deleteTracked.length;
    totals.destinationOnly += s.destinationOnly.length;
    totals.warnings += s.warnings.length;
    // Severity breakdown for chip rendering + embedded editor hints. An item
    // with any 'block'-severity warning is blocking (even if it also has
    // override warnings — block trumps); an item whose warnings are all
    // 'override' is overridable.
    for (const w of s.warnings) {
      if (hasBlockingWarning(w)) totals.blockingWarnings++;
      else if (hasOverridableWarningOnly(w)) totals.overridableWarnings++;
    }

    // Collision rows offer an "Overwrite" decision; destination-only rows
    // offer a "Delete from destination" decision. Both default unchecked —
    // the user has to actively opt in. Suppressed entirely when the caller
    // requested a non-interactive view (no message channel back).
    //
    // When the manifest already records a "don't ask again" decision for a
    // file (item.remembered), both the primary and the Remember checkboxes
    // start armed. The user can still untick to opt out of this run; Phase C
    // persists the new state on Proceed.
    const overwriteDecision = (item: PlanItem): PlanRowView =>
      interactive
        ? withDecision(toRow(item), {
            id: `${pairIndex}:overwrite:${item.relPath}`,
            kind: 'overwrite',
            label: 'Overwrite',
            ...(item.remembered?.accepted ? { checked: true, remembered: true } : {}),
          })
        : toRow(item);
    const deleteDecision = (item: PlanItem): PlanRowView =>
      interactive
        ? withDecision(toRow(item), {
            id: `${pairIndex}:delete:${item.relPath}`,
            kind: 'delete',
            label: 'Delete from destination',
            ...(item.remembered?.accepted ? { checked: true, remembered: true } : {}),
          })
        : toRow(item);
    // Green-path rows (create / update-tracked) with override-only warnings
    // get a "Sync anyway" arming affordance. Block-only or mixed-severity
    // warnings get no affordance — the row can't ship at all. Collision
    // rows skip this entirely; their overwrite arming covers any override
    // warning on the same file.
    const greenWithMaybeWarningOverride = (item: PlanItem): PlanRowView => {
      const row = toRow(item);
      if (!interactive) return row;
      if (!hasOverridableWarningOnly(item)) return row;
      return withDecision(row, {
        id: `${pairIndex}:warning-override:${item.relPath}`,
        kind: 'warning-override',
        label: 'Sync anyway',
        ...(item.remembered?.accepted ? { checked: true, remembered: true } : {}),
      });
    };
    // Warnings section is a derived view of files already shown in their
    // primary category. We deliberately DON'T duplicate the decision
    // affordance here — the checkbox belongs in the primary section
    // (Collisions for overwrite-arming, Create / To update for warning-
    // override). Duplicating would put two checkboxes with the same id in
    // the DOM and the user's clicks would silently disagree across them.
    // The Warnings section's job is to expand the full message text so the
    // user can read it without scanning the rest of the plan.

    pairs.push({
      sourceLabel: srcKey,
      destLabel,
      sections: {
        create: s.create.map(greenWithMaybeWarningOverride),
        updateTracked: s.updateTracked.map(greenWithMaybeWarningOverride),
        updateCollision: s.updateCollision.map(overwriteDecision),
        skip: s.skip.map(toRow),
        deleteTracked: s.deleteTracked.map(toRow),
        destinationOnly: s.destinationOnly.map(deleteDecision),
        warnings: s.warnings.map(toRow),
      },
    });
  }

  const sourceCount = seenSources.size;
  const scopeLabel =
    plans.length === 0
      ? 'Sync everything — no sources configured'
      : `Sync everything — ${sourceCount} source${sourceCount === 1 ? '' : 's'} × ${destCount} destination${destCount === 1 ? '' : 's'}`;

  return { scopeLabel, pairs, totals };
}

function emptySections(): PlanPairView['sections'] {
  return {
    create: [],
    updateTracked: [],
    updateCollision: [],
    skip: [],
    deleteTracked: [],
    destinationOnly: [],
    warnings: [],
  };
}

function toRow(item: PlanItem): PlanRowView {
  return {
    relPath: item.relPath,
    sizeBytes: item.sourceSize ?? item.destSize,
    sourceHashShort: item.sourceHash?.slice(0, 8),
    destHashShort: item.destHash?.slice(0, 8),
    manifestHashShort: item.manifestHash?.slice(0, 8),
    ...(item.warnings && item.warnings.length > 0
      ? { warnings: item.warnings.map(toWarningView) }
      : {}),
  };
}

function toWarningView(w: PlanWarning): PlanWarningView {
  return { code: w.code, message: w.message };
}

function withDecision(row: PlanRowView, decision: PlanRowDecisionView): PlanRowView {
  return { ...row, decision };
}

// ───── rendering ─────────────────────────────────────────────────────────

/**
 * Render the plan as an HTML document for the webview. Pure function —
 * nonce is supplied by the caller. Inline `<script>` is gated by the nonce
 * so the webview's strict CSP can still allow exactly the script we ship.
 */
export function renderPlanHtml(vm: PlanViewModel, nonce: string): string {
  const t = vm.totals;
  // M5 Phase D: warnings block green alongside collisions. Two severities:
  //  - 'block' (kiosk show mode, externally-linked media) — no per-row
  //    override; the executor refuses, the orange path just skips them.
  //  - 'override' (media-controls + embedded video) — a per-row "Sync
  //    anyway" affordance arms the row, then the orange Proceed ships it.
  // Either category flips the footer to orange + red.
  const blocking = t.updateCollision + t.warnings;
  const hasWork =
    t.create + t.updateTracked + t.deleteTracked + t.updateCollision > 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<title>Folder Sync — plan</title>
<style>${css()}</style>
</head>
<body>
  <main>
    <header class="plan-head">
      <h1>${escapeHtml(vm.scopeLabel)}</h1>
      <div class="totals">${renderTotals(t)}</div>
    </header>

    ${renderPlanPairs(vm)}

    <footer class="plan-foot" role="group" aria-label="Plan actions">
      ${renderFooter(blocking, hasWork)}
    </footer>
  </main>
  <script nonce="${nonce}">${footerScript()}</script>
</body>
</html>`;
}

/**
 * Pure: render the totals chips strip as the inner HTML of a `.totals`
 * container. The standalone plan webview wraps it; the embedded callers
 * (config editor, admin editor) post just this string back into the page.
 */
export function renderPlanChips(t: PlanTotals): string {
  return renderTotals(t);
}

/**
 * Pure: render the per-pair sections (or the empty-state banner). Embedded
 * callers slot this into their own page chrome. Pairs and rows use the
 * `.pair`/`.sec`/`.rows` selectors emitted by `planContentStyles()`.
 */
export function renderPlanPairs(vm: PlanViewModel): string {
  return vm.pairs.length === 0
    ? renderEmpty()
    : vm.pairs.map(renderPair).join('\n');
}

/**
 * Pure: the subset of plan-view CSS needed when embedding into a host
 * webview. Excludes page-level resets (body/main/h1/code) and the standalone
 * footer/action buttons — the host already owns those concerns.
 */
export function planContentStyles(): string {
  return planContentCss();
}

function renderTotals(t: PlanTotals): string {
  // The totals are a compact at-a-glance summary across all source/dest pairs.
  // Each chip's class drives its colour so the user can spot at a glance
  // whether there's anything that needs attention.
  const chips: Array<[string, number, string]> = [
    ['create', t.create, 'ok'],
    ['update', t.updateTracked, 'ok'],
    ['delete', t.deleteTracked, 'ok'],
    ['collisions', t.updateCollision, 'block'],
    ['destination-only', t.destinationOnly, 'info'],
    // Two warning chips: blocking files (red — can't ship) and overridable
    // files (warn yellow — can ship with "Sync anyway"). Both default hidden
    // when zero, so a clean plan keeps the strip uncluttered.
    ['blocked', t.blockingWarnings, 'block'],
    ['needs override', t.overridableWarnings, 'warn'],
    ['skip', t.skip, 'mute'],
    ['skipped pairs', t.skipped, 'warn'],
  ];
  return chips
    .filter(([, n]) => n > 0)
    .map(([label, n, cls]) => `<span class="chip chip-${cls}">${escapeHtml(label)}: ${n}</span>`)
    .join('');
}

function renderPair(pair: PlanPairView): string {
  const head = `<div class="pair-head">
    <span class="src">${escapeHtml(pair.sourceLabel)}</span>
    <span class="arrow">→</span>
    <span class="dst">${escapeHtml(pair.destLabel)}</span>
  </div>`;

  if (pair.skippedReason) {
    return `<section class="pair">
  ${head}
  <div class="banner warn">Skipped: ${escapeHtml(pair.skippedReason)}</div>
</section>`;
  }

  const s = pair.sections;
  const sections = [
    section('To create', 'ok', s.create),
    section('To update (tracked)', 'ok', s.updateTracked),
    section('Collisions — needs confirmation', 'block', s.updateCollision),
    section('To delete (source removed)', 'ok', s.deleteTracked),
    section('Destination-only', 'info', s.destinationOnly),
    // Validation warnings is a derived view: every item already appears in
    // one of the categories above. The dedicated section gathers them with
    // full warning messages so the user can review reasons in one place
    // without scanning every other section for ⚠ badges.
    section('Validation warnings', 'warn', s.warnings, { expandWarnings: true }),
    section('Skip (unchanged)', 'mute', s.skip),
  ]
    .filter((html) => html !== '')
    .join('\n');

  const body =
    sections === ''
      ? '<div class="banner ok">Nothing to do — destination is in sync.</div>'
      : sections;

  return `<section class="pair">
  ${head}
  ${body}
</section>`;
}

interface SectionOpts {
  /**
   * When true, each row also renders its full warning message list beneath
   * the path. Off by default — primary-category sections just show a small
   * "⚠ N" badge so the user can spot affected files without duplicating
   * messages already shown in the dedicated Validation warnings section.
   */
  expandWarnings?: boolean;
}

function section(label: string, cls: string, rows: PlanRowView[], opts: SectionOpts = {}): string {
  if (rows.length === 0) return '';
  // <details>/<summary> gives us collapsibility for free: native widget,
  // keyboard-accessible, no script needed. The `open` attribute on
  // attention-worthy categories means the user doesn't have to expand them
  // to see what needs decisions.
  const initiallyOpen = cls === 'block' || cls === 'warn' || rows.length <= 10;
  return `<details class="sec sec-${cls}"${initiallyOpen ? ' open' : ''}>
    <summary><span class="sec-label">${escapeHtml(label)}</span><span class="sec-count">${rows.length}</span></summary>
    <ul class="rows">
      ${rows.map((r) => renderRow(r, opts)).join('\n      ')}
    </ul>
  </details>`;
}

function renderRow(row: PlanRowView, opts: SectionOpts = {}): string {
  const sizeStr = row.sizeBytes !== undefined ? humanSize(row.sizeBytes) : '?';

  // Hash fragments matter when investigating "why was this categorised this
  // way" — src/dst/manifest hashes at 8 chars give the user enough to
  // confirm a match by eyeball without bloating the row.
  const hashes: string[] = [];
  if (row.sourceHashShort) hashes.push(`src=${row.sourceHashShort}`);
  if (row.destHashShort) hashes.push(`dst=${row.destHashShort}`);
  if (row.manifestHashShort) hashes.push(`man=${row.manifestHashShort}`);
  const hashesStr = hashes.length > 0 ? ` <span class="hashes">${escapeHtml(hashes.join(' '))}</span>` : '';

  const warnings = row.warnings ?? [];
  // Primary sections (expandWarnings=false): tiny badge so the user knows
  // this file appears in the dedicated Validation warnings section below.
  // Warnings section (expandWarnings=true): no badge needed — the messages
  // themselves convey the count.
  const badge =
    warnings.length > 0 && !opts.expandWarnings
      ? ` <span class="warn-badge" title="${escapeHtml(warningTooltip(warnings))}">⚠ ${warnings.length}</span>`
      : '';

  const messages =
    warnings.length > 0 && opts.expandWarnings
      ? `\n        <ul class="warn-list">${warnings
          .map(
            (w) =>
              `<li class="warn-item warn-${escapeHtml(w.code)}">${escapeHtml(w.message)}</li>`,
          )
          .join('')}</ul>`
      : '';

  // Decision checkbox lands in the right-most grid cell, after hashes/badge.
  // The `data-decision-*` attributes carry everything the webview script
  // needs without parsing the id back into parts. Unchecked by default for
  // fresh rows; pre-checked when the manifest carries a remembered decision.
  //
  // The companion "Remember" checkbox only does work when the primary is
  // checked — the footer script enables/disables it on each toggle. It exists
  // as a sibling so a single click anywhere on the label flips just the box
  // the user pointed at.
  const decision = row.decision;
  const decisionHtml = decision
    ? ` <label class="decision decision-${escapeHtml(decision.kind)}">
          <input type="checkbox" class="decision-input"
            data-decision-id="${escapeHtml(decision.id)}"
            data-decision-kind="${escapeHtml(decision.kind)}"
            data-decision-rel-path="${escapeHtml(row.relPath)}"${decision.checked ? ' checked' : ''}>
          <span class="decision-label">${escapeHtml(decision.label)}</span>
        </label>
        <label class="decision-remember" title="Remember this choice across syncs (persisted to the manifest)">
          <input type="checkbox" class="decision-remember-input"
            data-remember-for="${escapeHtml(decision.id)}"${decision.remembered ? ' checked' : ''}${decision.checked ? '' : ' disabled'}>
          <span class="decision-remember-label">Don't ask again</span>
        </label>`
    : '';

  return `<li class="row${warnings.length > 0 ? ' row-warn' : ''}${decision ? ' row-decide' : ''}">
        <div class="row-main">
          <span class="path">${escapeHtml(row.relPath)}</span>
          <span class="size">${escapeHtml(sizeStr)}</span>${hashesStr}${badge}${decisionHtml}
        </div>${messages}
      </li>`;
}

function warningTooltip(warnings: PlanWarningView[]): string {
  // Title attribute uses newlines via &#10; — most browsers honour them in
  // tooltips. Keeps the badge hover-discoverable without committing the
  // primary section's vertical real estate to messages.
  return warnings.map((w) => `${w.code}: ${w.message}`).join('\n');
}

function renderEmpty(): string {
  return `<section class="pair">
  <div class="banner info">No source/destination pairs to plan. Author a <code>.sync.jsonc</code> file in a source folder and add the named destination to the workspace.</div>
</section>`;
}

function renderFooter(blocking: number, hasWork: boolean): string {
  // Traffic-light per folder-sync-v1-plan.md:
  // - No blocks: single green Proceed (wired in M4).
  // - Blocks present: orange Proceed (label reflects override count, updated
  //   live by footerScript) + red Cancel. Phase B keeps orange disabled and
  //   carries an explanatory tooltip; Phase C wires execution.
  if (blocking === 0) {
    if (!hasWork) {
      // No-op plan: nothing to do, only Cancel is meaningful.
      return `<button type="button" class="btn btn-cancel" id="cancel-btn">Close</button>
      <button type="button" class="btn btn-green" disabled>Nothing to do</button>`;
    }
    return `<button type="button" class="btn btn-cancel" id="cancel-btn">Cancel</button>
      <button type="button" class="btn btn-green" id="proceed-btn">Proceed</button>`;
  }
  return `<button type="button" class="btn btn-orange" id="proceed-orange-btn">Proceed with safe items only</button>
      <button type="button" class="btn btn-cancel btn-red" id="cancel-btn">Cancel</button>`;
}

function footerScript(): string {
  // M3 wired Cancel; M4 added Proceed; M5 Phase B added per-row decision
  // checkboxes; Phase C adds the "Don't ask again" companion + orange Proceed.
  //
  // Each .decision-input carries `data-decision-*` attributes identifying
  // the row + intent ('overwrite' for collisions, 'delete' for destination-
  // only). Its sibling .decision-remember-input shares the same id via
  // `data-remember-for` so a single change handler updates both.
  //
  // Posted message shape: {type:'decision', id, kind, relPath, accepted, remember}.
  // The extension stores accepted+remember in-memory; on Proceed it dispatches
  // the accepted rows into the executor and persists the remember subset.
  return `(function(){
    const vscode = acquireVsCodeApi();
    const cancelBtn = document.getElementById('cancel-btn');
    const proceedBtn = document.getElementById('proceed-btn');
    const orangeBtn = document.getElementById('proceed-orange-btn');
    const checkboxes = Array.from(document.querySelectorAll('.decision-input'));

    function rememberFor(id){
      return document.querySelector('.decision-remember-input[data-remember-for="' + id + '"]');
    }

    function lock(label){
      if (cancelBtn) cancelBtn.disabled = true;
      if (proceedBtn) {
        proceedBtn.disabled = true;
        if (label) proceedBtn.textContent = label;
      }
      if (orangeBtn) {
        orangeBtn.disabled = true;
        if (label) orangeBtn.textContent = label;
      }
      for (let i = 0; i < checkboxes.length; i++) {
        checkboxes[i].disabled = true;
        const r = rememberFor(checkboxes[i].dataset.decisionId);
        if (r) r.disabled = true;
      }
    }

    function overrideCount(){
      let n = 0;
      for (let i = 0; i < checkboxes.length; i++) if (checkboxes[i].checked) n++;
      return n;
    }

    function refreshOrangeLabel(){
      if (!orangeBtn) return;
      const n = overrideCount();
      orangeBtn.textContent = n === 0
        ? 'Proceed with safe items only'
        : 'Proceed with overrides (' + n + ')';
      // Phase C: orange is enabled whenever there are blocks; the user can
      // proceed with zero overrides to take the safe subset.
      orangeBtn.disabled = false;
      orangeBtn.removeAttribute('title');
    }

    function postDecision(cb){
      const id = cb.dataset.decisionId;
      const remember = rememberFor(id);
      try {
        vscode.postMessage({
          type: 'decision',
          id: id,
          kind: cb.dataset.decisionKind,
          relPath: cb.dataset.decisionRelPath,
          accepted: cb.checked,
          remember: !!(remember && remember.checked && cb.checked),
        });
      } catch (_) {}
    }

    if (cancelBtn) cancelBtn.addEventListener('click', function(){
      try { vscode.postMessage({type:'cancel'}); } catch (_) {}
    });
    if (proceedBtn) proceedBtn.addEventListener('click', function(){
      lock('Syncing\\u2026');
      try { vscode.postMessage({type:'proceed'}); } catch (_) {}
    });
    if (orangeBtn) orangeBtn.addEventListener('click', function(){
      lock('Syncing\\u2026');
      try { vscode.postMessage({type:'proceed'}); } catch (_) {}
    });

    for (let i = 0; i < checkboxes.length; i++) {
      const cb = checkboxes[i];
      cb.addEventListener('change', function(){
        // Remember is only meaningful when primary is checked. Untick + disable
        // the companion box on opt-out so the user can't accidentally persist
        // a "no, never overwrite" the manifest schema doesn't model.
        const remember = rememberFor(cb.dataset.decisionId);
        if (remember) {
          if (!cb.checked) remember.checked = false;
          remember.disabled = !cb.checked;
        }
        postDecision(cb);
        refreshOrangeLabel();
      });
      const remember = rememberFor(cb.dataset.decisionId);
      if (remember) {
        remember.addEventListener('change', function(){
          postDecision(cb);
        });
      }
    }
    refreshOrangeLabel();

    window.addEventListener('message', function(e){
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'status' && typeof m.label === 'string') {
        lock(m.label);
      }
    });
  })();`;
}

// ───── utilities ─────────────────────────────────────────────────────────

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function css(): string {
  // CSS notes (for the human learning CSS):
  // - We lean on VS Code's CSS custom properties (--vscode-*) so the panel
  //   matches the active theme without us defining colours twice.
  // - The pair list is a flow of <section>s; each section is its own card
  //   so the source/destination relationship reads as a discrete unit.
  // - The footer is `position: sticky; bottom: 0;` so it stays visible while
  //   the user scrolls through a long plan. Sticky is the lightweight cousin
  //   of position:fixed — it stays in flow until it hits its anchor edge.
  return planPageCss() + planContentCss() + planFooterCss();
}

function planPageCss(): string {
  // Page-level chrome only used by the standalone plan webview. Embedded
  // callers (config/admin editor) own their own body/main/h1/code styles
  // and would collide with these rules.
  return `
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family, system-ui);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.5;
    }
    main {
      max-width: 1000px;
      margin: 0 auto;
      padding: 24px 24px 80px;
    }
    h1 {
      font-size: 1.3em;
      margin: 0 0 8px;
    }
    code {
      font-family: var(--vscode-editor-font-family, monospace);
      background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
      padding: 0 4px;
      border-radius: 3px;
    }
  `;
}

function planContentCss(): string {
  return `
    .plan-head { margin-bottom: 16px; }

    /* Totals strip: small inline chips. Flex with wrap so the strip reflows
       gracefully on narrow widths. */
    .totals {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .chip {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 0.85em;
      border: 1px solid transparent;
    }
    .chip-ok    { background: color-mix(in srgb, var(--vscode-charts-green, #4caf50) 14%, transparent); border-color: color-mix(in srgb, var(--vscode-charts-green, #4caf50) 40%, transparent); }
    .chip-block { background: color-mix(in srgb, var(--vscode-errorForeground) 14%, transparent); border-color: color-mix(in srgb, var(--vscode-errorForeground) 50%, transparent); }
    .chip-info  { background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 14%, transparent); border-color: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 40%, transparent); }
    .chip-warn  { background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 14%, transparent); border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 50%, transparent); }
    .chip-mute  { background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent); color: var(--vscode-descriptionForeground); }

    /* Each (source × destination) pair is a card. The left border gives it a
       visual anchor without needing a heavier background. */
    .pair {
      margin: 16px 0;
      padding: 12px 16px;
      border-left: 3px solid var(--vscode-panel-border, rgba(128,128,128,0.4));
      background: color-mix(in srgb, var(--vscode-foreground) 3%, transparent);
      border-radius: 0 4px 4px 0;
    }
    .pair-head {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: baseline;
      margin-bottom: 8px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .pair-head .src { font-weight: 600; }
    .pair-head .arrow { color: var(--vscode-descriptionForeground); }
    .pair-head .dst { color: var(--vscode-descriptionForeground); }

    /* Banners reused from the pptx viewer pattern: padded box with a coloured
       left edge to mark severity. */
    .banner {
      padding: 8px 12px;
      border-radius: 4px;
      margin: 8px 0;
      border-left: 3px solid transparent;
    }
    .banner.ok   { background: color-mix(in srgb, var(--vscode-charts-green, #4caf50) 10%, transparent); border-left-color: var(--vscode-charts-green, #4caf50); }
    .banner.warn { background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); border-left-color: var(--vscode-errorForeground); }
    .banner.info { background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 10%, transparent); border-left-color: var(--vscode-charts-blue, #3794ff); }

    /* Sections inside a pair: native <details>/<summary> for collapsibility.
       The summary becomes the clickable header; the body is the <ul>. */
    .sec {
      margin: 8px 0;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 4px;
      background: var(--vscode-editor-background);
    }
    .sec summary {
      list-style: none;
      cursor: pointer;
      padding: 6px 10px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      user-select: none;
    }
    /* The default disclosure marker varies across browsers; we draw our own
       so light/dark themes look consistent. The ▶ rotates when [open]. */
    .sec summary::-webkit-details-marker { display: none; }
    .sec summary::before {
      content: '▶';
      font-size: 0.75em;
      color: var(--vscode-descriptionForeground);
      transition: transform 0.12s ease;
      display: inline-block;
    }
    .sec[open] summary::before { transform: rotate(90deg); }
    .sec-block summary { color: var(--vscode-errorForeground); }
    .sec-warn summary { color: var(--vscode-editorWarning-foreground, #cca700); }
    .sec-count {
      margin-left: auto;
      font-weight: 400;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
    }

    /* Row list: monospace-feeling layout where path / size / hashes line up
       without us building a real table. The grid sits inside .row-main so
       each <li> can also carry block-level children (e.g. the warn-list)
       without breaking the columnar layout above. */
    ul.rows {
      list-style: none;
      margin: 0;
      padding: 4px 10px 10px;
    }
    ul.rows .row {
      padding: 2px 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
    }
    /* Flex (not grid) so the row scales gracefully to any number of trailing
       cells — size, hashes, warning badge, decision checkbox — without us
       maintaining a column count as the row vocabulary grows. The path
       takes the slack via flex: 1, everything else is intrinsic-width and
       sits flush to the right. */
    ul.rows .row-main {
      display: flex;
      align-items: baseline;
      gap: 12px;
    }
    ul.rows .row-main .path { flex: 1 1 auto; min-width: 0; }
    ul.rows .path { word-break: break-all; }
    ul.rows .size { color: var(--vscode-descriptionForeground); }
    ul.rows .hashes {
      color: var(--vscode-descriptionForeground);
      opacity: 0.8;
    }
    /* Warning badge appears in the right-most grid cell of .row-main; the
       warn-list below is an indented sub-list. The badge uses the same chip
       palette as the totals strip so the visual vocabulary is consistent. */
    ul.rows .warn-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 0.85em;
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 18%, transparent);
      border: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 50%, transparent);
      color: var(--vscode-editorWarning-foreground, #cca700);
      cursor: help;
    }
    ul.rows .warn-list {
      list-style: none;
      margin: 4px 0 4px 16px;
      padding: 0;
      font-size: 0.9em;
    }
    ul.rows .warn-item {
      padding: 1px 0 1px 12px;
      color: var(--vscode-editorWarning-foreground, #cca700);
      position: relative;
    }
    /* Bullet-style marker drawn ourselves so colour matches the warning palette. */
    ul.rows .warn-item::before {
      content: '⚠';
      position: absolute;
      left: -2px;
      font-size: 0.85em;
    }

    /* Per-row decision checkbox. The label wraps the input + text so a click
       anywhere on the affordance toggles the box. Colour palette tracks the
       row's intent: collision rows get the error/red accent (overwrite is a
       destructive choice); destination-only rows get a muted accent (delete
       is also destructive but the row is in the info section, so we lean
       a bit warmer). */
    ul.rows .decision {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      user-select: none;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      padding: 0 4px;
      border-radius: 3px;
    }
    ul.rows .decision:hover {
      background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
    }
    ul.rows .decision-input {
      margin: 0;
      cursor: pointer;
    }
    ul.rows .decision-overwrite .decision-label {
      color: var(--vscode-errorForeground);
    }
    ul.rows .decision-delete .decision-label {
      color: var(--vscode-editorWarning-foreground, #cca700);
    }
    /* warning-override = "Sync anyway" on a green-path row whose only
       warnings are override severity (e.g. pptx media-controls). Same warn
       palette as the delete affordance — the action is "ship despite a
       quality concern", not destructive but not neutral either. */
    ul.rows .decision-warning-override .decision-label {
      color: var(--vscode-editorWarning-foreground, #cca700);
    }
    /* When the checkbox is checked we promote the label to full strength to
       reinforce that the row is now armed for action. */
    ul.rows .decision-input:checked + .decision-label {
      font-weight: 600;
    }
    /* Companion "Don't ask again" affordance sits next to the primary
       checkbox; mutes its text colour to keep the primary intent visually
       dominant. Disabled state (no primary checked) softens further so the
       row reads as "this control is inert right now". */
    ul.rows .decision-remember {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      user-select: none;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      padding: 0 4px;
      border-radius: 3px;
    }
    ul.rows .decision-remember:hover {
      background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
    }
    ul.rows .decision-remember-input { margin: 0; cursor: pointer; }
    ul.rows .decision-remember-input:disabled,
    ul.rows .decision-remember-input:disabled + .decision-remember-label {
      opacity: 0.4;
      cursor: not-allowed;
    }
  `;
}

function planFooterCss(): string {
  // Sticky footer + action button styles. The embedded plan sections don't
  // ship their own Proceed/Cancel — they delegate to the host editor (or
  // to the standalone "Open workspace-wide plan" button).
  return `
    /* Sticky footer = traffic-light controls. Stays put while you scroll.
       The blur background keeps text legible over the page content behind. */
    .plan-foot {
      position: sticky;
      bottom: 0;
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      padding: 12px 0;
      margin-top: 16px;
      background: linear-gradient(to top, var(--vscode-editor-background) 70%, transparent);
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
    }
    .btn {
      font-family: inherit;
      font-size: inherit;
      padding: 6px 14px;
      color: var(--vscode-button-foreground, #fff);
      background: var(--vscode-button-background, #0e639c);
      border: 1px solid transparent;
      border-radius: 2px;
      cursor: pointer;
      min-width: 92px;
    }
    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .btn-green { background: var(--vscode-charts-green, #4caf50); color: #fff; }
    .btn-orange { background: var(--vscode-editorWarning-foreground, #cca700); color: #1e1e1e; }
    .btn-red, .btn-cancel.btn-red { background: var(--vscode-errorForeground, #f14c4c); color: #fff; }
    .btn-cancel {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border-color: var(--vscode-panel-border, rgba(128,128,128,0.4));
    }
    .btn-cancel:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground, color-mix(in srgb, var(--vscode-foreground) 8%, transparent));
    }
  `;
}
