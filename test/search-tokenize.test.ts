// Tests for src/search/tokenize.ts.
// Run with: npm run test:search-tokenize

import { strict as assert } from 'node:assert';
import { tokenize } from '../src/search/tokenize';

function test_empty(): void {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('   '), []);
  assert.deepEqual(tokenize('---'), []);
  console.log('  ok: empty / whitespace / pure-punct → []');
}

function test_simple_whitespace(): void {
  assert.deepEqual(tokenize('hello world'), ['hello', 'world']);
  console.log('  ok: simple whitespace split');
}

function test_camel_case(): void {
  assert.deepEqual(tokenize('MyPresentationDeck'), ['my', 'presentation', 'deck']);
  assert.deepEqual(tokenize('parseHTML'), ['parse', 'html']);
  console.log('  ok: camelCase split');
}

function test_snake_and_kebab(): void {
  assert.deepEqual(tokenize('snake_case_name'), ['snake', 'case', 'name']);
  assert.deepEqual(tokenize('kebab-case-name'), ['kebab', 'case', 'name']);
  console.log('  ok: snake_case + kebab-case split');
}

function test_punctuation(): void {
  assert.deepEqual(
    tokenize('Q4 Plan (Final).pptx'),
    ['q', '4', 'plan', 'final', 'pptx'],
  );
  console.log('  ok: punctuation separates tokens');
}

function test_letter_digit_split(): void {
  assert.deepEqual(tokenize('v2Final'), ['v', '2', 'final']);
  assert.deepEqual(tokenize('Q4Plan'), ['q', '4', 'plan']);
  console.log('  ok: letter↔digit transitions split');
}

function test_dedupe(): void {
  assert.deepEqual(tokenize('plan plan PLAN'), ['plan']);
  console.log('  ok: duplicates within a field dropped (first-wins order)');
}

function test_diacritics_folded(): void {
  // Latin diacritics drop; CJK passes through.
  assert.deepEqual(tokenize('Café Résumé'), ['cafe', 'resume']);
  console.log('  ok: tokens are folded');
}

function test_non_latin_scripts(): void {
  // Cyrillic + Japanese stay as content; camelCase rules don't trigger.
  // CJK words have no whitespace so "日本語" is a single token.
  assert.deepEqual(tokenize('Привет 日本語'), ['привет', '日本語']);
  console.log('  ok: non-Latin scripts kept as tokens');
}

function test_mixed_pptx_filename(): void {
  // The kind of input the search engine actually sees.
  assert.deepEqual(
    tokenize('2026-05-AlicePresentation_FinalDraft.pptx'),
    ['2026', '05', 'alice', 'presentation', 'final', 'draft', 'pptx'],
  );
  console.log('  ok: realistic filename tokenises sensibly');
}

function test_order_preserved(): void {
  assert.deepEqual(
    tokenize('Banana Apple Cherry'),
    ['banana', 'apple', 'cherry'],
  );
  console.log('  ok: first-appearance order preserved');
}

async function main(): Promise<void> {
  console.log('search-tokenize:');
  test_empty();
  test_simple_whitespace();
  test_camel_case();
  test_snake_and_kebab();
  test_punctuation();
  test_letter_digit_split();
  test_dedupe();
  test_diacritics_folded();
  test_non_latin_scripts();
  test_mixed_pptx_filename();
  test_order_preserved();
  console.log('all search-tokenize tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
