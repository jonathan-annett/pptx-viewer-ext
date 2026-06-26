// Tests for src/search/archiveName.ts (archive-on-remove name disambiguation).
// Run with: npm run test:search-archive-name

import { strict as assert } from 'node:assert';
import { disambiguateFileName } from '../src/search/archiveName';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

test('returns the name unchanged when not taken', () => {
  assert.equal(disambiguateFileName('deck.pptx', new Set()), 'deck.pptx');
  assert.equal(disambiguateFileName('deck.pptx', new Set(['other.pptx'])), 'deck.pptx');
});

test('appends " (2)" before the extension on first clash', () => {
  assert.equal(disambiguateFileName('deck.pptx', new Set(['deck.pptx'])), 'deck (2).pptx');
});

test('skips occupied suffixes until a free one is found', () => {
  const taken = new Set(['deck.pptx', 'deck (2).pptx', 'deck (3).pptx']);
  assert.equal(disambiguateFileName('deck.pptx', taken), 'deck (4).pptx');
});

test('handles names with no extension', () => {
  assert.equal(disambiguateFileName('README', new Set(['README'])), 'README (2)');
});

test('handles multi-dot names — splits on the last dot only', () => {
  assert.equal(
    disambiguateFileName('my.deck.final.pptx', new Set(['my.deck.final.pptx'])),
    'my.deck.final (2).pptx',
  );
});

test('treats a leading-dot dotfile name as all-stem', () => {
  assert.equal(disambiguateFileName('.pptx', new Set(['.pptx'])), '.pptx (2)');
});

test('never overwrites — the result is always free', () => {
  const taken = new Set(['a.pptx', 'a (2).pptx']);
  const out = disambiguateFileName('a.pptx', taken);
  assert.ok(!taken.has(out), 'disambiguated name must not collide');
  assert.equal(out, 'a (3).pptx');
});

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
console.log('all search-archive-name tests passed');
