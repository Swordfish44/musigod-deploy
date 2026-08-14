'use strict';

const assert = require('assert');
const {
  buildValidatedSplitsMap,
  mergeValidatedSplitEvidence,
} = require('../lib/readiness-evidence-adapter');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✅ ${name}`);
}

console.log('\n═══ Readiness Evidence Adapter Test ═══');

test('validated splits replace inferred writers and preserve matching PRO evidence', () => {
  const map = buildValidatedSplitsMap([{
    track_title: ' My Song ',
    validated: true,
    writers: [
      { name: 'Jane Doe', split_pct: 60, role: 'CA', ipi: '123' },
      { name: 'John Doe', split_pct: 40, role: 'C', ipi: '456' },
    ],
  }]);
  const result = mergeValidatedSplitEvidence({
    track_title: 'my song',
    writers: [{ name: 'Jane Doe', pro: 'ASCAP', source: 'musicbrainz' }],
  }, map);
  assert.equal(result.splits_validated, true);
  assert.equal(result.writers.length, 2);
  assert.equal(result.writers[0].pro, 'ASCAP');
  assert.equal(result.writers[0].ipi, '123');
  assert.equal(result.writers[0].source, 'validated_split');
});

test('unvalidated rows remain fail-closed', () => {
  const map = buildValidatedSplitsMap([{
    track_title: 'My Song',
    validated: false,
    writers: [{ name: 'Jane Doe', split_pct: 100 }],
  }]);
  const result = mergeValidatedSplitEvidence({ track_title: 'My Song', writers: [] }, map);
  assert.equal(result.splits_validated, false);
});

test('validated rows with invalid totals remain fail-closed', () => {
  const map = buildValidatedSplitsMap([{
    track_title: 'My Song',
    validated: true,
    writers: [{ name: 'Jane Doe', split_pct: 90 }],
  }]);
  const result = mergeValidatedSplitEvidence({ track_title: 'My Song', writers: [] }, map);
  assert.equal(result.splits_validated, false);
});

test('duplicate normalized titles do not silently overwrite first evidence row', () => {
  const map = buildValidatedSplitsMap([
    {
      track_title: 'My Song',
      validated: true,
      writers: [{ name: 'Jane Doe', split_pct: 100, ipi: '123' }],
    },
    {
      track_title: ' my song ',
      validated: true,
      writers: [{ name: 'Wrong Writer', split_pct: 100, ipi: '999' }],
    },
  ]);
  const result = mergeValidatedSplitEvidence({ track_title: 'MY SONG', writers: [] }, map);
  assert.equal(result.writers[0].name, 'Jane Doe');
});

console.log(`\n${passed} assertions | ${passed} passed | 0 failed`);
