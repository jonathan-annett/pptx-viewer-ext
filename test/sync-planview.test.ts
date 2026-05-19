// Smoke tests for the pure plan-view renderer.
// Run with: npm run test:sync-planview
//
// The renderer is a pure function from view model → HTML string. We don't
// parse the HTML — we just assert that the key strings show up where they
// should (CSP, nonce, scope label, section headers, file paths, counts).
// That keeps the test cheap and gives clear failure messages when the
// surface changes unintentionally.

import { strict as assert } from 'node:assert';
import { renderPlanHtml, toViewModel, humanSize } from '../src/sync/planHtml';
import { summarisePlan, type PlanItem, type PlanWarning } from '../src/sync/plan';
import type { PlanForDestination } from '../src/sync/planner';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

// ───── fixtures ──────────────────────────────────────────────────────────
//
// The view-model converter only reads a small subset of PlanForDestination
// (summary, destination.name, destination.subpath, skippedReason — source
// labels come from the labelSource callback). We cast minimal fixtures
// rather than constructing real vscode.Uri instances, which would pull the
// vscode module into the test.

function fakePlan(opts: {
  destName: string;
  subpath?: string;
  items?: PlanItem[];
  skippedReason?: string;
}): PlanForDestination {
  const items = opts.items ?? [];
  const summary = summarisePlan(items);
  const plan = {
    destination: {
      name: opts.destName,
      subpath: opts.subpath ?? '',
    },
    items,
    summary,
    ...(opts.skippedReason ? { skippedReason: opts.skippedReason } : {}),
  };
  return plan as unknown as PlanForDestination;
}

function item(kind: PlanItem['kind'], relPath: string, extras: Partial<PlanItem> = {}): PlanItem {
  return { kind, relPath, ...extras };
}

const FIXED_LABEL = (): string => 'projects/alpha';

// ───── view model totals ─────────────────────────────────────────────────

test('toViewModel sums totals across pairs', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [
        item('create', 'a.txt', { sourceSize: 100, sourceHash: 'aaaaaaaa11' }),
        item('create', 'b.txt', { sourceSize: 50, sourceHash: 'bbbbbbbb22' }),
        item('skip', 'c.txt', { sourceSize: 10, sourceHash: 'cccc', destHash: 'cccc' }),
      ],
    }),
    fakePlan({
      destName: 'archive',
      subpath: 'snapshots',
      items: [
        item('update-collision', 'a.txt', {
          sourceSize: 100,
          sourceHash: 'aaaaaaaa11',
          destHash: 'dddddddd33',
        }),
      ],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  assert.equal(vm.pairs.length, 2);
  assert.equal(vm.totals.create, 2);
  assert.equal(vm.totals.skip, 1);
  assert.equal(vm.totals.updateCollision, 1);
  assert.equal(vm.totals.warnings, 0);
  assert.equal(vm.totals.skipped, 0);
  // Single source name across both plans → 1 source × 2 destinations.
  assert.ok(/1 source × 2 destinations/.test(vm.scopeLabel), `scope was: ${vm.scopeLabel}`);
});

test('toViewModel surfaces skipped pairs', () => {
  const plans = [fakePlan({ destName: 'missing', skippedReason: "destination 'missing' is not in the workspace" })];
  const vm = toViewModel(plans, FIXED_LABEL);
  assert.equal(vm.totals.skipped, 1);
  assert.equal(vm.pairs[0].skippedReason, "destination 'missing' is not in the workspace");
});

test('toViewModel: empty plan produces zero pairs and a useful scope label', () => {
  const vm = toViewModel([], FIXED_LABEL);
  assert.equal(vm.pairs.length, 0);
  assert.ok(/no sources configured/.test(vm.scopeLabel));
});

test('toViewModel: subpath is concatenated into the destination label', () => {
  const plans = [fakePlan({ destName: 'backup', subpath: 'projects/alpha' })];
  const vm = toViewModel(plans, FIXED_LABEL);
  assert.equal(vm.pairs[0].destLabel, 'backup /projects/alpha');
});

// ───── rendering surface ─────────────────────────────────────────────────

test('renderPlanHtml: CSP, nonce, scope label, totals chips appear', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [item('create', 'a.txt', { sourceSize: 100, sourceHash: 'aabbccdd11' })],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  const html = renderPlanHtml(vm, 'NONCE123');

  assert.ok(html.includes("Content-Security-Policy"), 'CSP meta tag missing');
  assert.ok(html.includes("default-src 'none'"), 'CSP default-src missing');
  assert.ok(html.includes("script-src 'nonce-NONCE123'"), 'CSP nonce missing');
  assert.ok(html.includes('nonce="NONCE123"'), '<script> nonce missing');
  assert.ok(html.includes('1 source × 1 destination'), 'scope label not rendered');
  assert.ok(html.includes('create: 1'), 'create chip not rendered');
  assert.ok(html.includes('a.txt'), 'file path not rendered');
  assert.ok(html.includes('aabbccdd'), 'short source hash not rendered');
});

test('renderPlanHtml: clean plan with work shows enabled green Proceed + Cancel', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [item('create', 'a.txt', { sourceSize: 100, sourceHash: 'h' })],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  const html = renderPlanHtml(vm, 'n');

  // Scope to <button> tags — the CSS contains the class names as selectors too.
  // In M4, a clean plan with work to do has an enabled Proceed button so the
  // user can run the sync. Disabled-state assertions live in the no-work and
  // collision-block tests below.
  assert.ok(/<button[^>]*class="btn btn-green"/.test(html), 'green proceed button missing');
  assert.ok(html.includes('id="proceed-btn"'), 'proceed-btn id missing');
  assert.ok(!/<button[^>]*id="proceed-btn"[^>]*disabled/.test(html), 'proceed should not be disabled');
  assert.ok(html.includes('id="cancel-btn"'), 'cancel button missing');
  assert.ok(!/<button[^>]*btn-orange/.test(html), 'orange button leaked into clean plan');
});

test('renderPlanHtml: clean plan with NO work shows Close + disabled "Nothing to do"', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [item('skip', 'a.txt', { sourceSize: 1, sourceHash: 'h', destHash: 'h' })],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  const html = renderPlanHtml(vm, 'n');

  // No actionable work → no proceed-btn id; the green button is just an
  // informational "Nothing to do" placeholder; cancel doubles as Close.
  assert.ok(!html.includes('id="proceed-btn"'), 'proceed-btn must be absent on no-op plan');
  assert.ok(/<button[^>]*class="btn btn-green"[^>]*disabled[^>]*>Nothing to do</.test(html), 'disabled "Nothing to do" missing');
  assert.ok(/<button[^>]*id="cancel-btn"[^>]*>Close</.test(html), 'Close button missing');
});

test('renderPlanHtml: plan with collisions shows orange + red, no green', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [
        item('update-collision', 'a.txt', {
          sourceSize: 200,
          sourceHash: 'aaaaaaaa',
          destHash: 'dddddddd',
        }),
      ],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  const html = renderPlanHtml(vm, 'n');

  assert.ok(/<button[^>]*btn-orange/.test(html), 'orange button missing for collision plan');
  assert.ok(/<button[^>]*btn-red/.test(html), 'red cancel button missing for collision plan');
  assert.ok(!/<button[^>]*btn-green/.test(html), 'green proceed leaked into block plan');
  assert.ok(html.includes('Collisions — needs confirmation'), 'collisions section header missing');
  assert.ok(/sec-block[^>]* open/.test(html), 'collisions section not initially expanded');
});

test('renderPlanHtml: skipped pair surfaces reason as a warn banner', () => {
  const plans = [fakePlan({ destName: 'missing', skippedReason: 'not in workspace' })];
  const vm = toViewModel(plans, FIXED_LABEL);
  const html = renderPlanHtml(vm, 'n');
  assert.ok(html.includes('Skipped: not in workspace'), 'skipped reason missing');
  assert.ok(/banner[^"]*warn/.test(html), 'warn banner class missing');
});

test('renderPlanHtml: empty plan renders the empty-state banner', () => {
  const vm = toViewModel([], FIXED_LABEL);
  const html = renderPlanHtml(vm, 'n');
  assert.ok(html.includes('No source/destination pairs to plan'), 'empty banner missing');
  assert.ok(html.includes('.sync.jsonc'), 'authoring hint missing');
});

test('renderPlanHtml: hostile path is HTML-escaped', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [item('create', '<script>alert(1)</script>.txt', { sourceSize: 1, sourceHash: 'h' })],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  const html = renderPlanHtml(vm, 'n');
  assert.ok(!html.includes('<script>alert(1)'), 'unescaped <script> leaked into HTML');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;.txt'), 'expected escaped path missing');
});

// ───── validator warnings (M5 Phase A) ──────────────────────────────────
//
// Phase A renders warnings as totals, an inline ⚠ badge on primary-category
// rows, and a dedicated "Validation warnings" section listing full messages.
// It explicitly does NOT change the footer — green proceeds even when
// warnings are present. That gate moves in Phase B/D.

const WARN_KIOSK: PlanWarning = {
  severity: 'warn',
  code: 'show-type',
  message: 'Show type is kiosk',
};
const WARN_LINKED: PlanWarning = {
  severity: 'warn',
  code: 'linked-media',
  message: 'External media link present',
};

test('toViewModel: warnings total counts items with non-empty warnings', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [
        item('create', 'a.pptx', { sourceSize: 10, sourceHash: 'h1', warnings: [WARN_KIOSK] }),
        item('create', 'b.pptx', { sourceSize: 10, sourceHash: 'h2', warnings: [WARN_KIOSK, WARN_LINKED] }),
        item('create', 'c.txt', { sourceSize: 10, sourceHash: 'h3' }),
      ],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  assert.equal(vm.totals.create, 3);
  assert.equal(vm.totals.warnings, 2);
});

test('renderPlanHtml: warnings chip appears and "Validation warnings" section renders', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [
        item('create', 'kiosk.pptx', { sourceSize: 1000, sourceHash: 'h1', warnings: [WARN_KIOSK] }),
        item('create', 'linked.pptx', { sourceSize: 2000, sourceHash: 'h2', warnings: [WARN_LINKED] }),
      ],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  const html = renderPlanHtml(vm, 'n');

  assert.ok(html.includes('warnings: 2'), 'warnings chip not rendered');
  assert.ok(html.includes('Validation warnings'), 'Validation warnings section header missing');
  assert.ok(/sec-warn[^>]* open/.test(html), 'warnings section not initially expanded');
  // Full message text must appear in the dedicated section.
  assert.ok(html.includes('Show type is kiosk'), 'full kiosk warning message missing');
  assert.ok(html.includes('External media link present'), 'full linked-media message missing');
});

test('renderPlanHtml: inline ⚠ badge appears on primary-section rows with warnings', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [item('create', 'a.pptx', { sourceSize: 1, sourceHash: 'h', warnings: [WARN_KIOSK] })],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  const html = renderPlanHtml(vm, 'n');

  // The badge string "⚠ 1" lands in the To-create section; primary-section
  // rows show count only, not the message itself.
  assert.ok(html.includes('warn-badge'), 'warn-badge class missing');
  assert.ok(html.includes('⚠ 1'), 'inline warning badge "⚠ 1" missing');
  // Tooltip on the badge carries the code:message pair.
  assert.ok(html.includes('show-type: Show type is kiosk'), 'badge tooltip content missing');
});

test('renderPlanHtml: row without warnings has no badge', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [item('create', 'a.txt', { sourceSize: 1, sourceHash: 'h' })],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  const html = renderPlanHtml(vm, 'n');
  // The CSS always defines `.warn-badge` as a selector — assert on the
  // element markup instead so we detect a leaked badge, not the rule.
  assert.ok(!html.includes('class="warn-badge"'), 'warn-badge element leaked onto clean row');
  assert.ok(!html.includes('Validation warnings'), 'empty Validation warnings section rendered');
});

test('renderPlanHtml: Phase A — warnings do NOT block green Proceed', () => {
  // Crucial Phase A invariant: warnings alone keep the footer green. The
  // orange-only proceed path lands in Phase B/D, so this assertion is the
  // canary that prevents premature gating.
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [item('create', 'a.pptx', { sourceSize: 1, sourceHash: 'h', warnings: [WARN_KIOSK, WARN_LINKED] })],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  const html = renderPlanHtml(vm, 'n');

  assert.ok(/<button[^>]*class="btn btn-green"/.test(html), 'green proceed button missing despite warnings');
  assert.ok(html.includes('id="proceed-btn"'), 'proceed-btn id missing despite warnings');
  assert.ok(!/<button[^>]*id="proceed-btn"[^>]*disabled/.test(html), 'proceed-btn should not be disabled on warnings alone');
  assert.ok(!/<button[^>]*btn-orange/.test(html), 'orange button leaked when only warnings present');
});

test('renderPlanHtml: warning messages are HTML-escaped', () => {
  const HOSTILE: PlanWarning = {
    severity: 'warn',
    code: 'show-type',
    message: '<img src=x onerror=alert(1)>',
  };
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [item('create', 'a.pptx', { sourceSize: 1, sourceHash: 'h', warnings: [HOSTILE] })],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  const html = renderPlanHtml(vm, 'n');
  assert.ok(!html.includes('<img src=x'), 'unescaped warning message leaked into HTML');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'escaped warning message missing');
});

// ───── decision checkboxes (M5 Phase B) ─────────────────────────────────
//
// Phase B adds an inline checkbox on collision rows ("Overwrite") and
// destination-only rows ("Delete from destination"). Other categories
// (create / update-tracked / skip / delete-tracked / warnings) get no
// checkbox — they're either always-safe or already accounted for by the
// manifest.

test('toViewModel: collision rows carry an overwrite decision', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [
        item('update-collision', 'a.txt', { sourceSize: 1, sourceHash: 'h1', destHash: 'h2' }),
      ],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  const row = vm.pairs[0].sections.updateCollision[0];
  assert.equal(row.decision?.kind, 'overwrite');
  assert.equal(row.decision?.label, 'Overwrite');
  // ID format is `${pairIndex}:${kind}:${relPath}` — stable across re-renders.
  assert.equal(row.decision?.id, '0:overwrite:a.txt');
});

test('toViewModel: destination-only rows carry a delete decision', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [
        item('destination-only', 'user.txt', { destSize: 100, destHash: 'h' }),
      ],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  const row = vm.pairs[0].sections.destinationOnly[0];
  assert.equal(row.decision?.kind, 'delete');
  assert.equal(row.decision?.label, 'Delete from destination');
  assert.equal(row.decision?.id, '0:delete:user.txt');
});

test('toViewModel: pairIndex is unique across multiple pairs', () => {
  const plans = [
    fakePlan({
      destName: 'first',
      items: [item('update-collision', 'a.txt', { sourceSize: 1, sourceHash: 'h', destHash: 'd' })],
    }),
    fakePlan({
      destName: 'second',
      items: [item('update-collision', 'a.txt', { sourceSize: 1, sourceHash: 'h', destHash: 'd' })],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  // Same relPath in two different pairs → distinct decision ids.
  assert.equal(vm.pairs[0].sections.updateCollision[0].decision?.id, '0:overwrite:a.txt');
  assert.equal(vm.pairs[1].sections.updateCollision[0].decision?.id, '1:overwrite:a.txt');
});

test('toViewModel: non-decisional rows have no decision attached', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [
        item('create', 'a.txt', { sourceSize: 1, sourceHash: 'h' }),
        item('skip', 'b.txt', { sourceSize: 1, sourceHash: 'h', destHash: 'h' }),
        item('update-tracked', 'c.txt', { sourceSize: 1, sourceHash: 'h2', destHash: 'h1', manifestHash: 'h1' }),
        item('delete-tracked', 'd.txt', { destSize: 1, destHash: 'h', manifestHash: 'h' }),
      ],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  const s = vm.pairs[0].sections;
  assert.equal(s.create[0].decision, undefined);
  assert.equal(s.skip[0].decision, undefined);
  assert.equal(s.updateTracked[0].decision, undefined);
  assert.equal(s.deleteTracked[0].decision, undefined);
});

test('renderPlanHtml: collision row emits an Overwrite checkbox with data attributes', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [item('update-collision', 'a.txt', { sourceSize: 1, sourceHash: 'h1', destHash: 'h2' })],
    }),
  ];
  const html = renderPlanHtml(toViewModel(plans, FIXED_LABEL), 'n');
  assert.ok(html.includes('class="decision-input"'), 'decision-input class missing');
  assert.ok(html.includes('data-decision-id="0:overwrite:a.txt"'), 'data-decision-id missing');
  assert.ok(html.includes('data-decision-kind="overwrite"'), 'data-decision-kind missing');
  assert.ok(html.includes('data-decision-rel-path="a.txt"'), 'data-decision-rel-path missing');
  assert.ok(/decision decision-overwrite/.test(html), 'decision wrapper class missing');
});

test('renderPlanHtml: destination-only row emits a Delete checkbox', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [item('destination-only', 'user.txt', { destSize: 1, destHash: 'h' })],
    }),
  ];
  const html = renderPlanHtml(toViewModel(plans, FIXED_LABEL), 'n');
  assert.ok(html.includes('data-decision-kind="delete"'), 'delete data-decision-kind missing');
  assert.ok(/decision decision-delete/.test(html), 'decision wrapper class missing');
  assert.ok(html.includes('Delete from destination'), 'delete label missing');
});

test('renderPlanHtml: clean row has no decision checkbox', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [item('create', 'a.txt', { sourceSize: 1, sourceHash: 'h' })],
    }),
  ];
  const html = renderPlanHtml(toViewModel(plans, FIXED_LABEL), 'n');
  assert.ok(!html.includes('class="decision-input"'), 'decision-input leaked onto clean row');
});

test('renderPlanHtml: orange button carries proceed-orange-btn id for live label updates', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [item('update-collision', 'a.txt', { sourceSize: 1, sourceHash: 'h1', destHash: 'h2' })],
    }),
  ];
  const html = renderPlanHtml(toViewModel(plans, FIXED_LABEL), 'n');
  assert.ok(html.includes('id="proceed-orange-btn"'), 'orange button id missing — script can\'t update label');
  assert.ok(html.includes('Proceed with safe items only'), 'initial orange label missing');
  // Phase C: orange button is enabled (no `disabled` attribute) and no longer
  // carries the Phase B "decisions captured but execution is pending" tooltip.
  assert.ok(
    !/id="proceed-orange-btn"[^>]*\bdisabled\b/.test(html),
    'orange button should be enabled now that Phase C wires execution',
  );
  assert.ok(
    !/title="Decisions captured/.test(html),
    'Phase B explanatory tooltip should be gone',
  );
});

test('toViewModel: PlanItem.remembered.accepted threads through to decision.checked + remembered', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [
        item('update-collision', 'a.txt', {
          sourceSize: 1,
          sourceHash: 'h1',
          destHash: 'h2',
          remembered: { accepted: true },
        }),
        item('destination-only', 'b.txt', {
          destSize: 1,
          destHash: 'h',
          remembered: { accepted: true },
        }),
        // Control row — no remembered → decision starts unchecked.
        item('update-collision', 'c.txt', {
          sourceSize: 1,
          sourceHash: 'h3',
          destHash: 'h4',
        }),
      ],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL);
  const collisionA = vm.pairs[0].sections.updateCollision.find((r) => r.relPath === 'a.txt');
  const destB = vm.pairs[0].sections.destinationOnly[0];
  const collisionC = vm.pairs[0].sections.updateCollision.find((r) => r.relPath === 'c.txt');
  assert.equal(collisionA?.decision?.checked, true);
  assert.equal(collisionA?.decision?.remembered, true);
  assert.equal(destB.decision?.checked, true);
  assert.equal(destB.decision?.remembered, true);
  assert.equal(collisionC?.decision?.checked, undefined);
  assert.equal(collisionC?.decision?.remembered, undefined);
});

test('renderPlanHtml: remembered row emits checked primary + checked Remember', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [
        item('update-collision', 'a.txt', {
          sourceSize: 1,
          sourceHash: 'h1',
          destHash: 'h2',
          remembered: { accepted: true },
        }),
      ],
    }),
  ];
  const html = renderPlanHtml(toViewModel(plans, FIXED_LABEL), 'n');
  assert.ok(
    /class="decision-input"[^>]*\bchecked\b/.test(html),
    'remembered decision should render the primary checkbox pre-checked',
  );
  assert.ok(
    /class="decision-remember-input"[^>]*\bchecked\b/.test(html),
    'remembered decision should render the Don\'t-ask-again box pre-checked',
  );
  assert.ok(
    !/class="decision-remember-input"[^>]*\bdisabled\b/.test(html),
    'remember should not be disabled when primary is checked',
  );
});

test('renderPlanHtml: fresh (un-remembered) row emits Remember box disabled', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [item('update-collision', 'a.txt', { sourceSize: 1, sourceHash: 'h1', destHash: 'h2' })],
    }),
  ];
  const html = renderPlanHtml(toViewModel(plans, FIXED_LABEL), 'n');
  // Primary unchecked → Remember companion starts disabled so the user can't
  // tick a "remember unaccept" the manifest schema doesn't model.
  assert.ok(
    /class="decision-remember-input"[^>]*\bdisabled\b/.test(html),
    'Remember box should be disabled when primary is unchecked',
  );
  assert.ok(
    !/class="decision-input"[^>]*\bchecked\b/.test(html),
    'primary checkbox should not be pre-checked for a fresh row',
  );
});

test('toViewModel: interactive=false suppresses all decision affordances', () => {
  // Embedded read-only callers (viewer sync-target, config editor preview,
  // admin editor) pass this — they have no message channel back, so a
  // visible-but-inert checkbox would be confusing.
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [
        item('update-collision', 'a.txt', { sourceSize: 1, sourceHash: 'h1', destHash: 'h2' }),
        item('destination-only', 'b.txt', { destSize: 1, destHash: 'h' }),
      ],
    }),
  ];
  const vm = toViewModel(plans, FIXED_LABEL, { interactive: false });
  assert.equal(vm.pairs[0].sections.updateCollision[0].decision, undefined);
  assert.equal(vm.pairs[0].sections.destinationOnly[0].decision, undefined);

  const html = renderPlanHtml(vm, 'n');
  assert.ok(!html.includes('class="decision-input"'), 'inert checkbox leaked into non-interactive view');
});

test('renderPlanHtml: hostile relPath in decision attributes is HTML-escaped', () => {
  const plans = [
    fakePlan({
      destName: 'backup',
      items: [
        item('update-collision', '"><script>x</script>.txt', {
          sourceSize: 1,
          sourceHash: 'h1',
          destHash: 'h2',
        }),
      ],
    }),
  ];
  const html = renderPlanHtml(toViewModel(plans, FIXED_LABEL), 'n');
  // Unescaped relPath in the data attribute would break out of the
  // attribute quoting and inject a tag. Escape must survive into the
  // attribute value.
  assert.ok(!/data-decision-rel-path="[^"]*"><script/.test(html), 'attribute escape failed — script injection possible');
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;x&lt;/script&gt;.txt'), 'expected escaped relPath missing');
});

// ───── humanSize sanity ──────────────────────────────────────────────────

test('humanSize formats B / KB / MB', () => {
  assert.equal(humanSize(0), '0 B');
  assert.equal(humanSize(512), '512 B');
  assert.equal(humanSize(1024), '1.0 KB');
  assert.equal(humanSize(1024 * 1024), '1.0 MB');
});

// ───── runner ────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('all tests passed');
