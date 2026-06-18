// Tests for src/search/fold.ts — case + diacritic folding.
// Run with: npm run test:search-fold

import { strict as assert } from 'node:assert';
import { fold } from '../src/search/fold';

function test_empty(): void {
  assert.equal(fold(''), '');
  console.log('  ok: empty input → empty output');
}

function test_lowercases_ascii(): void {
  assert.equal(fold('Hello WORLD'), 'hello world');
  console.log('  ok: ASCII lowercased');
}

function test_strips_latin_diacritics(): void {
  // "Søren Café" → "soren cafe" — only the diacritics are stripped, the
  // Danish ø is mapped to o by NFD? Actually ø does NOT decompose under
  // NFD — it's an atomic code point. Test the behaviour we actually get.
  // é = U+00E9 → NFD: 0065 0301 → strip → 'e'. Same for ñ, ü, …
  assert.equal(fold('Café'), 'cafe');
  assert.equal(fold('Résumé'), 'resume');
  assert.equal(fold('jalapeño'), 'jalapeno');
  assert.equal(fold('über'), 'uber');
  console.log('  ok: Latin diacritics stripped via NFD');
}

function test_idempotent(): void {
  const samples = ['Hello', 'Café résumé', 'Søren', 'JALAPEÑO', ''];
  for (const s of samples) {
    assert.equal(fold(fold(s)), fold(s), `fold idempotent on ${JSON.stringify(s)}`);
  }
  console.log('  ok: fold is idempotent');
}

function test_preserves_non_latin_scripts(): void {
  // No combining marks → just lowercases (most non-Latin scripts have
  // no case distinction, so they pass through verbatim).
  assert.equal(fold('Привет'), 'привет', 'Cyrillic lowercased');
  assert.equal(fold('日本語'), '日本語', 'CJK passes through');
  console.log('  ok: non-Latin scripts preserved');
}

function test_preserves_digits_and_punct(): void {
  assert.equal(fold('Q4-2026 Plan!'), 'q4-2026 plan!');
  console.log('  ok: digits + punctuation untouched');
}

function test_eth_not_decomposed(): void {
  // 'ø' is U+00F8, atomic — NFD does not decompose it. So fold('Søren')
  // gives 'søren' (lowercase) rather than 'soren'. Documenting the
  // limitation so we don't accidentally rely on "Søren" matching
  // "Soren" — they won't match as substrings, but tokenisation splits
  // them into different tokens anyway. A user typing "Søren" in the
  // search box will fold the same way, so consistent matching still
  // works for the common case.
  assert.equal(fold('Søren'), 'søren');
  console.log('  ok: atomic ø preserved (consistent across query + index)');
}

async function main(): Promise<void> {
  console.log('search-fold:');
  test_empty();
  test_lowercases_ascii();
  test_strips_latin_diacritics();
  test_idempotent();
  test_preserves_non_latin_scripts();
  test_preserves_digits_and_punct();
  test_eth_not_decomposed();
  console.log('all search-fold tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
