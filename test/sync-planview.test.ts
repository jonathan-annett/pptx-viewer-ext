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
import { summarisePlan, type PlanItem } from '../src/sync/plan';
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
  assert.ok(html.includes('.sync.yaml'), 'authoring hint missing');
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
