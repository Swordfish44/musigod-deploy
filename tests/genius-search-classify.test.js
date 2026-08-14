'use strict';
// tests/genius-search-classify.test.js
//
// Regression tests for Genius search result classification and title
// normalization helpers in scripts/diagnose-zero-writer-tracks.js.
//
// Does NOT make real API calls — all tests use in-process logic only.
// Safe to run without SUPABASE_SERVICE_KEY or GENIUS_ACCESS_TOKEN.

const {
  classifyGeniusResult,
  normTitle,
  collapseRepeats,
  titleVariants,
} = require('../scripts/diagnose-zero-writer-tracks');

console.log('\n=== genius-search-classify.test.js ===\n');

let passed = 0;
let failed = 0;

function assert(label, got, expected) {
  const ok = got === expected;
  if (ok) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    console.log(`       got:      ${JSON.stringify(got)}`);
    failed++;
  }
}

function assertIncludes(label, arr, value) {
  const ok = Array.isArray(arr) && arr.includes(value);
  if (ok) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    console.log(`       array: ${JSON.stringify(arr)}`);
    console.log(`       missing: ${JSON.stringify(value)}`);
    failed++;
  }
}

// ── [1] normTitle ─────────────────────────────────────────────────────────────
console.log('[1] normTitle — strip non-alphanumeric and lowercase');

assert('lowercases ASCII',
  normTitle('ESHAM'), 'esham');
assert('strips spaces and hyphens',
  normTitle('As I Rock-N-Roll'), 'asirocknroll');
assert('strips apostrophe',
  normTitle("Youknowucan'tride"), 'youknowucantride');
assert('strips punctuation and parens',
  normTitle('"Bootleg" (From The Lost Vault)'), 'bootlegfromthelostvault');
assert('empty string',
  normTitle(''), '');
assert('null-safe — returns empty string for null',
  normTitle(null), '');
assert('null-safe — returns empty string for undefined',
  normTitle(undefined), '');

// ── [2] collapseRepeats ───────────────────────────────────────────────────────
console.log('\n[2] collapseRepeats — collapse consecutive repeated characters');

assert('triple k collapses to single k',
  collapseRepeats('skkkk'), 'sk');
assert('double l collapses to single l',
  collapseRepeats('ll'), 'l');
assert('no repeats — string unchanged',
  collapseRepeats('abc'), 'abc');
assert('single char — unchanged',
  collapseRepeats('a'), 'a');

// The central regression: our DB title and the Genius album URL spelling
// must both collapse to the same string.
assert('DB title "helterskkkellter" collapses correctly',
  collapseRepeats('helterskkkellter'), 'helterskelter');
assert('Genius album "hellterskkkelter" collapses correctly',
  collapseRepeats('hellterskkkelter'), 'helterskelter');
assert('DB and Genius album spellings collapse to identical string',
  collapseRepeats(normTitle('Helterskkkellter')) ===
  collapseRepeats(normTitle('Hellterskkkelter')),
  true);

// ── [3] titleVariants ─────────────────────────────────────────────────────────
console.log('\n[3] titleVariants — normalized + collapsed forms, deduplicated');

const hv = titleVariants('Helterskkkellter');
assertIncludes('includes exact normalized form',
  hv, 'helterskkkellter');
assertIncludes('includes collapsed form',
  hv, 'helterskelter');
assert('returns an array',
  Array.isArray(hv), true);

// When norm and collapsed are identical (no repeats), deduplication fires.
const plain = titleVariants('Esham');
assert('deduplicates when norm === collapsed',
  plain.length, 1);
assert('deduplicated array contains the normalized form',
  plain[0], 'esham');

// ── [4] classifyGeniusResult — FOUND_WITH_WRITERS ────────────────────────────
console.log('\n[4] classifyGeniusResult — FOUND_WITH_WRITERS');

assert('found=true, one writer → FOUND_WITH_WRITERS',
  classifyGeniusResult({ found: true, writers: [{ name: 'Esham' }] }),
  'FOUND_WITH_WRITERS');
assert('found=true, two writers → FOUND_WITH_WRITERS',
  classifyGeniusResult({ found: true, writers: [{ name: 'A' }, { name: 'B' }] }),
  'FOUND_WITH_WRITERS');
assert('EXACT confidence does not change classification',
  classifyGeniusResult({ found: true, confidence: 'EXACT', writers: [{ name: 'Esham' }] }),
  'FOUND_WITH_WRITERS');
assert('NORMALIZED confidence does not change classification',
  classifyGeniusResult({ found: true, confidence: 'NORMALIZED', writers: [{ name: 'Esham' }] }),
  'FOUND_WITH_WRITERS');

// ── [5] classifyGeniusResult — FOUND_UNCREDITED (key regression) ──────────────
console.log('\n[5] classifyGeniusResult — FOUND_UNCREDITED');
console.log('    Regression: song found with writer_artists=[] must never return NOT_FOUND');

assert('found=true writers=[] → FOUND_UNCREDITED, not NOT_FOUND',
  classifyGeniusResult({ found: true, writers: [] }),
  'FOUND_UNCREDITED');
assert('EXACT match, empty writers → FOUND_UNCREDITED',
  classifyGeniusResult({
    found: true, confidence: 'EXACT', writers: [],
    geniusTitle: 'As I Rock-N-Roll', geniusUrl: 'https://genius.com/Esham-as-i-rock-n-roll-lyrics',
  }),
  'FOUND_UNCREDITED');
assert('NORMALIZED match, empty writers → FOUND_UNCREDITED',
  classifyGeniusResult({
    found: true, confidence: 'NORMALIZED', writers: [],
    geniusTitle: 'Helterskkkellter',
  }),
  'FOUND_UNCREDITED');
assert('geniusStatus field set correctly on result object',
  (() => {
    const r = { found: true, writers: [] };
    r.geniusStatus = classifyGeniusResult(r);
    return r.geniusStatus;
  })(),
  'FOUND_UNCREDITED');

// ── [6] classifyGeniusResult — NOT_FOUND ──────────────────────────────────────
console.log('\n[6] classifyGeniusResult — NOT_FOUND');

assert('null → NOT_FOUND',
  classifyGeniusResult(null), 'NOT_FOUND');
assert('undefined → NOT_FOUND',
  classifyGeniusResult(undefined), 'NOT_FOUND');
assert('empty object (no found field) → NOT_FOUND',
  classifyGeniusResult({}), 'NOT_FOUND');
assert('found=false → NOT_FOUND',
  classifyGeniusResult({ found: false }), 'NOT_FOUND');
assert('found=false with topHits → NOT_FOUND',
  classifyGeniusResult({ found: false, topHits: [{ title: 'Something', url: 'https://genius.com/x' }] }),
  'NOT_FOUND');

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(53)}`);
console.log(`${passed + failed} assertions | ${passed} passed | ${failed} failed`);
console.log('');
if (failed > 0) {
  console.log('FAIL');
  process.exit(1);
} else {
  console.log('PASS');
}
