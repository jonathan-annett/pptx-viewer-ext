// Tests for src/search/updateModalHtml.ts — specifically the gating of the
// "Update & remove source" button on showRemoveOption.
// Run with: npm run test:search-update-modal

import { strict as assert } from 'node:assert';
import { renderSearchUpdateModalHtml } from '../src/search/updateModalHtml';
import type { ParseResult } from '../src/pptx';

function makeParse(overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    fileName: 'deck.pptx',
    size: 1234,
    sizeHuman: '1.2 KB',
    mtime: 0,
    mtimeHuman: '2026-01-01',
    sha256: 'a'.repeat(64),
    slideCount: 3,
    hiddenSlideCount: 0,
    author: 'Someone',
    lastModifiedBy: 'Someone',
    embeddedMedia: [],
    mediaFiles: [],
    ...overrides,
  } as ParseResult;
}

const baseInput = {
  target: makeParse({ fileName: 'target.pptx', sha256: 'a'.repeat(64) }),
  candidate: makeParse({ fileName: 'incoming.pptx', sha256: 'b'.repeat(64) }),
  targetFolderLabel: 'Canonical',
  candidateFolderLabel: 'Dropbox-In',
};

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

test('omits the remove button when showRemoveOption is absent', () => {
  const html = renderSearchUpdateModalHtml(baseInput);
  assert.doesNotMatch(html, /search-update-remove-btn/);
  // The other two actions are always present.
  assert.match(html, /search-update-cancel-btn/);
  assert.match(html, /search-update-confirm-btn/);
});

test('omits the remove button when showRemoveOption is false', () => {
  const html = renderSearchUpdateModalHtml({ ...baseInput, showRemoveOption: false });
  assert.doesNotMatch(html, /search-update-remove-btn/);
});

test('includes the remove button when showRemoveOption is true', () => {
  const html = renderSearchUpdateModalHtml({ ...baseInput, showRemoveOption: true });
  assert.match(html, /search-update-remove-btn/);
  assert.match(html, /Update &amp; remove source/);
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
console.log('all search-update-modal tests passed');
