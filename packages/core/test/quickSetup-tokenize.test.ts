// Tests for the wizard's pure tokenization helpers. Pure module — no
// vscode shim needed. Run with: npm run test:quick-setup-tokenize
//
// Covers every example from the plan's tokenization rules section,
// plus edge cases (whitespace-only, forbidden-chars-only, unicode,
// duplicate detection variations).

import { strict as assert } from 'node:assert';
import {
  detectCollisions,
  isTimeslotInputValid,
  sanitizeToken,
  splitCommaInput,
  validateCommaList,
  validateEventName,
  validateSpeakerNames,
} from '../src/event/quickSetup/tokenize';

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void): void => {
  tests.push([name, fn]);
};

// ───── sanitizeToken — casing preservation ────────────────────────────

test('sanitizeToken preserves casing on single-word input', () => {
  // The "no embedded spaces → preserve exactly" branch — covers the
  // common case where the user types short tokens (MON, RM001, PLENARY).
  assert.equal(sanitizeToken('MON'), 'MON');
  assert.equal(sanitizeToken('Mon'), 'Mon');
  assert.equal(sanitizeToken('mon'), 'mon');
  assert.equal(sanitizeToken('RM001'), 'RM001');
  assert.equal(sanitizeToken('PLENARY'), 'PLENARY');
  assert.equal(sanitizeToken('MAY30'), 'MAY30');
});

test('sanitizeToken trims surrounding whitespace before single-word check', () => {
  // The user types comma-separated lists; splitCommaInput trims each
  // piece, but sanitizeToken should also be safe to call on raws with
  // ambient whitespace.
  assert.equal(sanitizeToken('  MON  '), 'MON');
  assert.equal(sanitizeToken('\tRM001\n'), 'RM001');
});

// ───── sanitizeToken — camelCase across spaces ────────────────────────

test('sanitizeToken camelCases embedded spaces — first-word casing preserved', () => {
  // The three plan examples, verbatim:
  assert.equal(sanitizeToken('May Day 1'), 'MayDay1');
  assert.equal(sanitizeToken('may day 1'), 'mayDay1');
  assert.equal(sanitizeToken('MAY day 1'), 'MAYDay1');
});

test('sanitizeToken collapses multiple whitespace between words', () => {
  // Multiple spaces / tabs / mixed — same single-camelCase output.
  assert.equal(sanitizeToken('May   Day  1'), 'MayDay1');
  assert.equal(sanitizeToken('May\tDay\t1'), 'MayDay1');
});

test('sanitizeToken capitalises subsequent words but leaves rest of word untouched', () => {
  // "dAy" stays "dAy" past its first char's capitalization — i.e.
  // the rule only touches the first character of each non-first word.
  assert.equal(sanitizeToken('first dAy oNe'), 'firstDAyONe');
});

// ───── sanitizeToken — forbidden chars ────────────────────────────────

test('sanitizeToken strips forbidden filename chars silently', () => {
  // `\/:*?"<>|` are stripped without warning; the caller surfaces a
  // distinct error only when the result is empty.
  assert.equal(sanitizeToken('R:M/0*0?1'), 'RM001');
  assert.equal(sanitizeToken('a"b<c>d|e'), 'abcde');
});

test('sanitizeToken strips control chars silently', () => {
  assert.equal(sanitizeToken('M\x00O\x1fN'), 'MON');
  assert.equal(sanitizeToken('R\x7fM\x01001'), 'RM001');
});

test('sanitizeToken returns empty string when only forbidden chars present', () => {
  // The empty return signals "nothing usable" to the caller; the
  // validation layer turns this into a user-facing error.
  assert.equal(sanitizeToken(':::'), '');
  assert.equal(sanitizeToken('  /\\  '), '');
  assert.equal(sanitizeToken(''), '');
  assert.equal(sanitizeToken('   '), '');
});

test('sanitizeToken preserves unicode letters across camelCase boundary', () => {
  // Non-ASCII letters survive intact. The rule "capitalize first char
  // of each subsequent word" uses JS's String.prototype.toUpperCase
  // which handles Unicode reasonably for most scripts.
  assert.equal(sanitizeToken('café break'), 'caféBreak');
  assert.equal(sanitizeToken('día uno'), 'díaUno');
});

// ───── splitCommaInput ────────────────────────────────────────────────

test('splitCommaInput parses a clean comma list', () => {
  assert.deepEqual(splitCommaInput('MON,TUE,WED'), ['MON', 'TUE', 'WED']);
});

test('splitCommaInput trims whitespace around each entry', () => {
  // The "MON, TUE, WED" shape with spaces after commas is what users
  // naturally type — trim each piece.
  assert.deepEqual(
    splitCommaInput('MON, TUE,  WED'),
    ['MON', 'TUE', 'WED'],
  );
});

test('splitCommaInput preserves whitespace inside an entry', () => {
  // The space INSIDE a token (e.g. "May Day 1") survives so that
  // sanitizeToken can camelCase it.
  assert.deepEqual(
    splitCommaInput('May Day 1, Day 2'),
    ['May Day 1', 'Day 2'],
  );
});

test('splitCommaInput drops empty entries', () => {
  // Stray commas (trailing, doubled) don't produce empty raws.
  assert.deepEqual(splitCommaInput('MON,,TUE,'), ['MON', 'TUE']);
});

// ───── detectCollisions ───────────────────────────────────────────────

test('detectCollisions: no collision when sanitized tokens differ', () => {
  // "Mon" and "MON" sanitize to distinct tokens — no collision, even
  // though they're case-insensitively the same string.
  const r = detectCollisions(['Mon', 'MON']);
  assert.deepEqual(r.tokens, ['Mon', 'MON']);
  assert.deepEqual(r.collisions, []);
});

test('detectCollisions: spaces vs no-spaces that sanitize to same token', () => {
  // The plan's stated collision case: "Room 1" and "Room1" both
  // sanitize to "Room1" → must collide.
  const r = detectCollisions(['Room 1', 'Room1']);
  assert.deepEqual(r.tokens, ['Room1', 'Room1']);
  assert.equal(r.collisions.length, 1);
  assert.equal(r.collisions[0].token, 'Room1');
  assert.deepEqual(r.collisions[0].raws, ['Room 1', 'Room1']);
});

test('detectCollisions: three-way collision groups all three raws together', () => {
  // Same token from 3+ raws → all in one CollisionInfo entry.
  const r = detectCollisions(['Room 1', 'Room1', 'Ro/om1']);
  assert.equal(r.collisions.length, 1);
  assert.deepEqual(r.collisions[0].raws, ['Room 1', 'Room1', 'Ro/om1']);
});

test('detectCollisions: ignores empty-sanitized entries in collision count', () => {
  // Two entries both sanitize to "" — those are surfaced as "invalid
  // entry" by validateCommaList, not as a collision (so the error
  // points at the actual problem, not a confusing "two empties
  // collide on ''").
  const r = detectCollisions([':::', '/\\/']);
  assert.deepEqual(r.tokens, ['', '']);
  assert.deepEqual(r.collisions, []);
});

// ───── isTimeslotInputValid ───────────────────────────────────────────

test("isTimeslotInputValid rejects ':' anywhere in the raw", () => {
  // The wizard surfaces `:` rejection explicitly so the user
  // understands the chronological-sort constraint — rather than
  // silently stripping like the other forbidden chars.
  const r = isTimeslotInputValid('09:30,16:00');
  assert.equal(r.ok, false);
  if (r.ok === false) {
    assert.ok(r.reason.includes(':'));
    assert.ok(r.reason.includes('0930') || r.reason.includes('09_30'));
  }
});

test('isTimeslotInputValid passes clean colon-free input', () => {
  assert.deepEqual(isTimeslotInputValid('0900,1600'), { ok: true });
  assert.deepEqual(isTimeslotInputValid('09_30'), { ok: true });
  assert.deepEqual(isTimeslotInputValid('A,B,C,D'), { ok: true });
  assert.deepEqual(isTimeslotInputValid('10.30'), { ok: true });
  assert.deepEqual(isTimeslotInputValid('10-30'), { ok: true });
});

// ───── validateCommaList ──────────────────────────────────────────────

test('validateCommaList: happy path for days', () => {
  const r = validateCommaList('MON, TUE, WED', 'day');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.tokens, ['MON', 'TUE', 'WED']);
});

test('validateCommaList: empty input rejected with kind in message', () => {
  const r = validateCommaList('', 'room');
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.toLowerCase().includes('room'));
});

test('validateCommaList: forbidden-chars-only entry surfaces as invalid, not collision', () => {
  // Two entries that both sanitize empty → the validator should
  // report the first as "no usable characters" rather than a
  // confusing "collide on ''" error.
  const r = validateCommaList(':::, ///', 'room');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.reason.includes('"???"') || r.reason.includes(':::'));
    assert.ok(r.reason.toLowerCase().includes('no usable'));
  }
});

test('validateCommaList: collision surfaces with both raws + the resulting token', () => {
  const r = validateCommaList('Room 1, Room1', 'room');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.reason.includes('"Room 1"'));
    assert.ok(r.reason.includes('"Room1"'));
    assert.ok(r.reason.includes('Room1'));
  }
});

test('validateCommaList: timeslot path rejects `:` explicitly', () => {
  const r = validateCommaList('09:30, 16:00', 'timeslot');
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.includes(':'));
});

test('validateCommaList: timeslot path passes for colon-free input', () => {
  const r = validateCommaList('0900, 1300, 1600', 'timeslot');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.tokens, ['0900', '1300', '1600']);
});

// ───── validateEventName ──────────────────────────────────────────────

test('validateEventName: happy path', () => {
  const r = validateEventName('TechConf 2026');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.token, 'TechConf2026');
});

test('validateEventName: rejects empty / whitespace', () => {
  for (const raw of ['', '   ', '\t\n']) {
    const r = validateEventName(raw);
    assert.equal(r.ok, false);
  }
});

test('validateEventName: rejects forbidden-chars-only', () => {
  const r = validateEventName(':::');
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.toLowerCase().includes('no usable'));
});

test('validateEventName: enforces length cap (≤ 64)', () => {
  const long = 'a'.repeat(65);
  const r = validateEventName(long);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.includes('65'));
});

test('validateEventName: 64-char input passes', () => {
  // Boundary — exactly the limit, accepted.
  const ok = 'a'.repeat(64);
  const r = validateEventName(ok);
  assert.equal(r.ok, true);
});

// ───── validateSpeakerNames ───────────────────────────────────────────

test('validateSpeakerNames: empty input is valid (speakers are optional)', () => {
  const r = validateSpeakerNames('');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.names, []);
});

test('validateSpeakerNames: preserves raw display names with spaces + casing', () => {
  // Speakers don't get camelCased — the EventSpeaker.name field is
  // the user-facing display name.
  const r = validateSpeakerNames('John Smith, jane doe, A. B. SINGH');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.names, ['John Smith', 'jane doe', 'A. B. SINGH']);
  }
});

test('validateSpeakerNames: rejects duplicate name entries', () => {
  // The plan calls for exact-string-match dedup on speaker names —
  // two "John Smith" entries would produce indistinguishable rows.
  const r = validateSpeakerNames('John Smith, Jane Doe, John Smith');
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.includes('John Smith'));
});

test('validateSpeakerNames: rejects forbidden-chars-only entry', () => {
  const r = validateSpeakerNames('Real Name, :::');
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.toLowerCase().includes('no usable'));
});

// ───── runner ─────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(
      `    ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
    );
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('all tests passed');
