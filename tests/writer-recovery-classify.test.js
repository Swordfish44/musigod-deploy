'use strict';
// tests/writer-recovery-classify.test.js
//
// Unit tests for the classify() function in scripts/restore-regressed-writers.js.
// Covers all four classification outcomes including the superset-as-CONFLICT rule.
// Zero network calls, zero DB access.
//
// Run: node tests/writer-recovery-classify.test.js

const { classify, normalizeWriterName, writerNormSet } =
  require('../scripts/restore-regressed-writers');

let passed = 0;
let failed = 0;

function ok(msg)          { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg, detail) {
  console.error(`  ❌ FAIL: ${msg}${detail ? ' — ' + detail : ''}`);
  failed++;
}
function assert(cond, msg, detail) { cond ? ok(msg) : fail(msg, detail); }
function eq(a, b, msg) {
  assert(a === b, msg, `got "${a}", expected "${b}"`);
}

function w(name, role = 'CA') { return { name, role, source: 'recovered_from_csv' }; }

// ─────────────────────────────────────────────────────────────────────────────

console.log('');
console.log('═══ writer-recovery-classify.test.js ═══');

// ── normalizeWriterName ───────────────────────────────────────────────────────
console.log('');
console.log('[1] normalizeWriterName');
eq(normalizeWriterName('Esham A. Smith'), 'eshamasmith',     'strips punctuation and lowercases');
eq(normalizeWriterName('esham a. smith'), 'eshamasmith',     'already-lower matches upper');
eq(normalizeWriterName('The Unholy (4)'), 'theunholy4',      'strips parens and space');
eq(normalizeWriterName(''),               '',                 'empty string returns empty');
eq(normalizeWriterName(null),             '',                 'null returns empty');
eq(normalizeWriterName(undefined),        '',                 'undefined returns empty');

// ── writerNormSet ─────────────────────────────────────────────────────────────
console.log('');
console.log('[2] writerNormSet');
{
  const s = writerNormSet([w('Esham A. Smith'), w('The Unholy (4)')]);
  assert(s.has('eshamasmith'),  'set contains normalized Esham');
  assert(s.has('theunholy4'),   'set contains normalized Unholy');
  assert(s.size === 2,          'cardinality is 2');
}
{
  const empty = writerNormSet([]);
  assert(empty.size === 0, 'empty array → empty set');
}
{
  const nullSet = writerNormSet(null);
  assert(nullSet.size === 0, 'null writers → empty set');
}

// ── classify: EXACT_MATCH ─────────────────────────────────────────────────────
console.log('');
console.log('[3] EXACT_MATCH — identical normalized sets');

eq(classify(
  [w('Esham A. Smith')],
  [w('Esham A. Smith')]
), 'EXACT_MATCH', 'single identical writer');

eq(classify(
  [w('Esham A. Smith'), w('The Unholy (4)')],
  [w('Esham A. Smith'), w('The Unholy (4)')]
), 'EXACT_MATCH', 'two identical writers');

eq(classify(
  [w('esham a. smith')],   // lowercase in DB
  [w('Esham A. Smith')]    // mixed case in CSV
), 'EXACT_MATCH', 'case-insensitive normalization produces EXACT_MATCH');

eq(classify(
  [w('The Unholy (4)'), w('Esham A. Smith')],  // different order
  [w('Esham A. Smith'), w('The Unholy (4)')]
), 'EXACT_MATCH', 'order does not matter — set equality');

// ── classify: WOULD_PATCH ─────────────────────────────────────────────────────
console.log('');
console.log('[4] WOULD_PATCH — current is a proper subset of authoritative');

eq(classify(
  [],                        // current empty
  [w('Esham A. Smith')]
), 'WOULD_PATCH', 'empty current, auth has 1 writer');

eq(classify(
  [],
  [w('Esham A. Smith'), w('The Unholy (4)')]
), 'WOULD_PATCH', 'empty current, auth has 2 writers');

eq(classify(
  [w('Esham A. Smith')],     // current has 1 of the 2 auth writers
  [w('Esham A. Smith'), w('The Unholy (4)')]
), 'WOULD_PATCH', 'current has subset of auth writers (missing co-writer)');

// ── classify: CONFLICT — superset (current has extra unsupported writer) ──────
console.log('');
console.log('[5] CONFLICT — current is a superset of authoritative');

eq(classify(
  [w('Esham A. Smith'), w('Unknown Producer')],  // extra unsupported writer
  [w('Esham A. Smith')]
), 'CONFLICT', 'current superset: extra writer not in auth');

eq(classify(
  [w('Esham A. Smith'), w('The Unholy (4)'), w('Extra Person')],
  [w('Esham A. Smith'), w('The Unholy (4)')]
), 'CONFLICT', 'current superset: three vs two auth writers');

eq(classify(
  [w('Extra Only')],         // current has one writer, auth has none of them
  []                         // auth is empty (no authoritative writers — edge case)
), 'CONFLICT', 'non-empty current vs empty auth is CONFLICT');

// ── classify: CONFLICT — bidirectional divergence ─────────────────────────────
console.log('');
console.log('[6] CONFLICT — bidirectional: both sides have unique identities');

eq(classify(
  [w('Wrong Person')],
  [w('Esham A. Smith')]
), 'CONFLICT', 'completely different single writers');

eq(classify(
  [w('Esham A. Smith'), w('Extra Person')],
  [w('Esham A. Smith'), w('The Unholy (4)')]
), 'CONFLICT', 'shared writer plus one unique each side');

eq(classify(
  [w('Writer A'), w('Writer B')],
  [w('Writer C'), w('Writer D')]
), 'CONFLICT', 'completely disjoint sets');

// ── UNRESOLVED — no authoritative data (caller responsibility, not classify()) ─
console.log('');
console.log('[7] UNRESOLVED — authoritative lookup returns null (caller sets status, not classify)');
// classify() is never called for UNRESOLVED tracks. Verify that classify()
// does NOT return 'UNRESOLVED' for any input so the caller contract is clear.

const notUnresolved = [
  classify([], [w('Esham A. Smith')]),
  classify([w('Esham A. Smith')], [w('Esham A. Smith')]),
  classify([w('Extra')], [w('Esham A. Smith')]),
  classify([w('A')], [w('B')]),
];
notUnresolved.forEach((result, i) => {
  assert(result !== 'UNRESOLVED',
    `classify() result[${i}] is never UNRESOLVED (got "${result}")`);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
console.log('─────────────────────────────────────────────────────');
const total = passed + failed;
console.log(`${total} assertions | ${passed} passed | ${failed} failed`);

if (failed > 0) {
  console.error('\nFAIL');
  process.exit(1);
} else {
  console.log('\nPASS');
}
