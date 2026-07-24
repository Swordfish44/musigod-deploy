'use strict';
// tests/registration-readiness.test.js
// Verifies the registration readiness evaluation engine.
// No external network calls. No DB access. No submissions to any society.

const {
  evaluateReadiness,
  evaluateAllDestinations,
  DESTINATIONS,
  RULESET_VERSION,
} = require('../lib/registration-readiness');

const { generateGapsReport, assertExportReady } = require('../lib/generate-registration-files');

let passed = 0;
let failed = 0;

function assert(condition, label, detail) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function writerWithIPI(name, pro = null, ipi = '00000000001') {
  return { name, ipi, pro, role: 'CA', source: 'musicbrainz' };
}

function writerNoIPI(name) {
  return { name, ipi: null, pro: null, role: 'CA', source: 'musicbrainz' };
}

// Ready ASCAP candidate: writers with IPI, confirmed splits, no PRO conflict
function readyASCAPTrack() {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    track_title: 'Ready Track',
    artist_name: 'Test Artist',
    isrcs: ['USABC0100001'],
    iswc: null,   // ISWC absent — should be WARNING only, not blocking
    writers: [writerWithIPI('Jane Doe', 'ASCAP', '00000000001')],
    enriched: true,
    enrichment_source: 'musicbrainz',
    enrichment_error: null,
    splits_validated: true,
    master_rights_holder: 'Test Artist',
    publisher_ipi: '00099999999',
    publisher_name: 'MusiGod Publishing Administration',
  };
}

// Ready BMI candidate
function readyBMITrack() {
  return {
    ...readyASCAPTrack(),
    id: 'aaaaaaaa-0000-0000-0000-000000000002',
    writers: [writerWithIPI('John Smith', 'BMI', '00000000002')],
  };
}

// Ready MLC candidate (ASCAP writer, splits confirmed, publisher identity present)
function readyMLCTrack() {
  return {
    ...readyASCAPTrack(),
    id: 'aaaaaaaa-0000-0000-0000-000000000003',
  };
}

// Ready SoundExchange candidate
function readySoundExchangeTrack() {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000004',
    track_title: 'Sound Track',
    artist_name: 'Test Artist',
    isrcs: ['USABC0100004'],
    iswc: null,
    writers: [],
    enriched: true,
    enrichment_error: null,
    splits_validated: false,
    master_rights_holder: 'Test Artist LLC',
    publisher_ipi: null,
    publisher_name: null,
  };
}

// ── Test 1: Writer name present but IPI missing → BLOCKED ─────────────────────

function test1_writer_no_ipi_blocked() {
  console.log('\n[1] Writer name present but IPI missing → BLOCKED for ASCAP, BMI, MLC');
  const track = {
    ...readyASCAPTrack(),
    writers: [writerNoIPI('Unknown Writer')],
  };

  for (const dest of ['ASCAP', 'BMI', 'MLC']) {
    const r = evaluateReadiness(track, dest);
    assert(r.decision === 'BLOCKED', `${dest}: decision is BLOCKED (got "${r.decision}")`);
    assert(
      r.blockers.some(b => b.code === 'MISSING_WRITER_IPI'),
      `${dest}: MISSING_WRITER_IPI blocker present`,
      `blockers: ${r.blockers.map(b => b.code).join(', ')}`
    );
    assert(
      r.blockers.find(b => b.code === 'MISSING_WRITER_IPI')?.severity === 'BLOCKING',
      `${dest}: MISSING_WRITER_IPI is BLOCKING severity`
    );
  }
}

// ── Test 2: Writer and IPI present but PRO missing → NEEDS_REVIEW ─────────────

function test2_writer_ipi_present_no_pro_needs_review() {
  console.log('\n[2] Writer + IPI present but PRO missing → NEEDS_REVIEW for ASCAP/BMI (not READY, not BLOCKED)');
  const track = {
    ...readyASCAPTrack(),
    writers: [{ name: 'Jane Doe', ipi: '00000000001', pro: null, role: 'CA', source: 'musicbrainz' }],
    splits_validated: true,
  };

  for (const dest of ['ASCAP', 'BMI']) {
    const r = evaluateReadiness(track, dest);
    assert(r.decision === 'NEEDS_REVIEW', `${dest}: decision is NEEDS_REVIEW (got "${r.decision}")`);
    assert(
      r.blockers.some(b => b.code === 'MISSING_PRO_AFFILIATION'),
      `${dest}: MISSING_PRO_AFFILIATION signal present`,
      `blockers: ${r.blockers.map(b => b.code).join(', ')}`
    );
    assert(r.decision !== 'READY', `${dest}: NOT READY — PRO affiliation unconfirmed`);
  }
}

// ── Test 3: BMI writer not automatically ASCAP-ready → BLOCKED ────────────────

function test3_bmi_writer_not_ascap_ready() {
  console.log('\n[3] BMI writer not automatically ASCAP-ready → BLOCKED for ASCAP');
  const track = { ...readyBMITrack() };

  const r = evaluateReadiness(track, 'ASCAP');
  assert(r.decision === 'BLOCKED', `ASCAP: BLOCKED for BMI-affiliated writer (got "${r.decision}")`);
  assert(
    r.blockers.some(b => b.code === 'WRONG_PRO_AFFILIATION'),
    'ASCAP: WRONG_PRO_AFFILIATION blocker present',
    `blockers: ${r.blockers.map(b => b.code).join(', ')}`
  );
  assert(r.blockers.find(b => b.code === 'WRONG_PRO_AFFILIATION')?.severity === 'BLOCKING',
    'WRONG_PRO_AFFILIATION is BLOCKING severity');
}

// ── Test 4: ASCAP writer not automatically BMI-ready → BLOCKED ────────────────

function test4_ascap_writer_not_bmi_ready() {
  console.log('\n[4] ASCAP writer not automatically BMI-ready → BLOCKED for BMI');
  const track = { ...readyASCAPTrack() };

  const r = evaluateReadiness(track, 'BMI');
  assert(r.decision === 'BLOCKED', `BMI: BLOCKED for ASCAP-affiliated writer (got "${r.decision}")`);
  assert(
    r.blockers.some(b => b.code === 'WRONG_PRO_AFFILIATION'),
    'BMI: WRONG_PRO_AFFILIATION blocker present'
  );
}

// ── Test 5: Missing ISWC is not universally blocking ──────────────────────────

function test5_missing_iswc_not_universally_blocking() {
  console.log('\n[5] Missing ISWC is not universally blocking — warning only for ASCAP/BMI/MLC');
  const track = {
    ...readyASCAPTrack(),
    iswc: null,
    writers: [writerWithIPI('Jane Doe', 'ASCAP', '00000000001')],
    splits_validated: true,
  };

  for (const dest of ['ASCAP', 'BMI']) {
    const r = evaluateReadiness(track, dest);
    // ISWC missing → warning, but NOT a blocking item
    assert(
      !r.blockers.some(b => b.code === 'MISSING_ISWC' && b.severity === 'BLOCKING'),
      `${dest}: MISSING_ISWC is not a BLOCKING blocker (it's a warning)`
    );
    assert(
      r.warnings.some(w => w.code === 'MISSING_ISWC'),
      `${dest}: MISSING_ISWC appears in warnings`
    );
  }

  // SOUNDEXCHANGE and NEIGHBORING_RIGHTS don't even check ISWC
  const se = evaluateReadiness({ ...readySoundExchangeTrack() }, 'SOUNDEXCHANGE');
  assert(
    !se.blockers.some(b => b.code === 'MISSING_ISWC'),
    'SOUNDEXCHANGE: MISSING_ISWC not present at all (not applicable for sound recording)'
  );
}

// ── Test 6: Missing ISRC blocks SoundExchange and Neighboring Rights ──────────

function test6_missing_isrc_blocks_soundexchange_and_neighboring() {
  console.log('\n[6] Missing ISRC blocks SoundExchange and NEIGHBORING_RIGHTS');
  const track = {
    ...readySoundExchangeTrack(),
    isrcs: [],
  };

  for (const dest of ['SOUNDEXCHANGE', 'NEIGHBORING_RIGHTS']) {
    const r = evaluateReadiness(track, dest);
    assert(r.decision === 'BLOCKED', `${dest}: BLOCKED when ISRC missing (got "${r.decision}")`);
    assert(
      r.blockers.some(b => b.code === 'MISSING_ISRC'),
      `${dest}: MISSING_ISRC blocker present`
    );
  }

  // Missing ISRC should NOT block composition destinations
  const ascapTrack = { ...readyASCAPTrack(), isrcs: [] };
  const ra = evaluateReadiness(ascapTrack, 'ASCAP');
  assert(
    !ra.blockers.some(b => b.code === 'MISSING_ISRC'),
    'ASCAP: missing ISRC does not block composition registration'
  );
}

// ── Test 7: ISRC with no master rights holder blocked for SoundExchange ───────

function test7_isrc_no_master_rights_holder_blocked() {
  console.log('\n[7] ISRC present but no master rights holder → BLOCKED for SoundExchange');
  const track = {
    ...readySoundExchangeTrack(),
    isrcs: ['USABC0100007'],
    master_rights_holder: null,
  };

  const r = evaluateReadiness(track, 'SOUNDEXCHANGE');
  assert(r.decision === 'BLOCKED', `SOUNDEXCHANGE: BLOCKED (got "${r.decision}")`);
  assert(
    r.blockers.some(b => b.code === 'MISSING_MASTER_RIGHTS_HOLDER'),
    'SOUNDEXCHANGE: MISSING_MASTER_RIGHTS_HOLDER blocker present'
  );
}

// ── Test 8: Unresolved writer conflict blocks ─────────────────────────────────

function test8_writer_conflict_blocks() {
  console.log('\n[8] Unresolved writer conflict → BLOCKED for composition destinations');
  const track = {
    ...readyASCAPTrack(),
    enrichment_error: '[conflict] incoming writers contradict existing — kept existing; review required',
  };

  for (const dest of ['ASCAP', 'BMI', 'MLC']) {
    const r = evaluateReadiness(track, dest);
    assert(r.decision === 'BLOCKED', `${dest}: BLOCKED on writer conflict (got "${r.decision}")`);
    assert(
      r.blockers.some(b => b.code === 'WRITER_CONFLICT'),
      `${dest}: WRITER_CONFLICT blocker present`
    );
  }
}

// ── Test 9: No confirmed splits fails closed for composition destinations ──────

function test9_no_confirmed_splits_blocks_composition() {
  console.log('\n[9] No confirmed splits → BLOCKED for ASCAP, BMI, MLC');
  const track = {
    ...readyASCAPTrack(),
    splits_validated: false,
  };

  for (const dest of ['ASCAP', 'BMI', 'MLC']) {
    const r = evaluateReadiness(track, dest);
    assert(r.decision === 'BLOCKED', `${dest}: BLOCKED when splits not confirmed (got "${r.decision}")`);
    assert(
      r.blockers.some(b => b.code === 'MISSING_CONFIRMED_SPLITS'),
      `${dest}: MISSING_CONFIRMED_SPLITS blocker present`
    );
  }

  // SoundExchange: splits not applicable — should not appear
  const seTrack = { ...readySoundExchangeTrack(), splits_validated: false };
  const se = evaluateReadiness(seTrack, 'SOUNDEXCHANGE');
  assert(
    !se.blockers.some(b => b.code === 'MISSING_CONFIRMED_SPLITS'),
    'SOUNDEXCHANGE: MISSING_CONFIRMED_SPLITS not applicable'
  );
}

// ── Test 10: Existing registration requiring amendment is not treated as new ───

function test10_existing_registration_amendment() {
  console.log('\n[10] Existing registration requiring amendment → BLOCKED with EXISTING_REGISTRATION_AMENDMENT');
  const track = {
    ...readyASCAPTrack(),
    requires_amendment: true,
  };

  for (const dest of ['ASCAP', 'BMI', 'MLC']) {
    const r = evaluateReadiness(track, dest);
    assert(r.decision === 'BLOCKED', `${dest}: BLOCKED when amendment required (got "${r.decision}")`);
    assert(
      r.blockers.some(b => b.code === 'EXISTING_REGISTRATION_AMENDMENT'),
      `${dest}: EXISTING_REGISTRATION_AMENDMENT blocker present`
    );
  }
}

// ── Test 11: Identical reevaluation is idempotent ─────────────────────────────

function test11_idempotent_reevaluation() {
  console.log('\n[11] Identical reevaluation is idempotent — same input produces same decision');
  const track = { ...readyASCAPTrack() };

  for (const dest of DESTINATIONS) {
    const r1 = evaluateReadiness(track, dest);
    const r2 = evaluateReadiness(track, dest);
    assert(r1.decision === r2.decision, `${dest}: decision identical on both runs`);
    assert(r1.ruleset_version === r2.ruleset_version, `${dest}: ruleset_version identical`);
    assert(
      JSON.stringify(r1.blockers.map(b => b.code).sort()) ===
      JSON.stringify(r2.blockers.map(b => b.code).sort()),
      `${dest}: blocker codes identical on both runs`
    );
  }
}

// ── Test 12: Evidence changes produce a deterministic new decision ─────────────

function test12_evidence_changes_produce_new_decision() {
  console.log('\n[12] Evidence change (IPI added) produces different decision deterministically');
  const before = {
    ...readyASCAPTrack(),
    writers: [writerNoIPI('Jane Doe')],
    splits_validated: true,
  };
  const after = {
    ...readyASCAPTrack(),
    writers: [writerWithIPI('Jane Doe', 'ASCAP', '00000000001')],
    splits_validated: true,
  };

  const r1 = evaluateReadiness(before, 'ASCAP');
  const r2 = evaluateReadiness(after, 'ASCAP');

  assert(r1.decision === 'BLOCKED', 'Before IPI: BLOCKED');
  // after: writer has IPI + PRO='ASCAP' + splits_validated=true → READY for ASCAP destination
  assert(r2.decision === 'READY', `After IPI + PRO=ASCAP added: READY for ASCAP destination (got "${r2.decision}")`);
  assert(r2.decision !== r1.decision, 'Decision changed after evidence update');
}

// ── Test 13: Blocked track cannot generate a submission-ready CSV ──────────────

function test13_blocked_track_cannot_export() {
  console.log('\n[13] Blocked track cannot generate a submission-ready CSV — assertExportReady throws');
  const track = { trackTitle: 'Blocked Track', writers: [], isrcs: [], iswc: null, enriched: false };
  const readinessMap = new Map([
    ['blocked track', { decision: 'BLOCKED', blockers: [{ code: 'MISSING_WRITERS', severity: 'BLOCKING', message: 'No writers' }] }]
  ]);

  let threw = false;
  let err = null;
  try {
    assertExportReady([track], readinessMap);
  } catch (e) {
    threw = true;
    err = e;
  }

  assert(threw, 'assertExportReady throws for BLOCKED track');
  assert(err?.code === 'EXPORT_BLOCKED', `error.code is EXPORT_BLOCKED (got "${err?.code}")`);
  assert(Array.isArray(err?.nonReady) && err.nonReady.length === 1, 'nonReady has 1 entry');
  assert(err?.nonReady[0]?.trackTitle === 'Blocked Track', 'nonReady references correct track');
}

// ── Test 14: Mixed ready/blocked export fails with blocker details ─────────────

function test14_mixed_ready_blocked_export_fails() {
  console.log('\n[14] Mixed ready/blocked selection → export fails with blocker details on blocked tracks');
  const tracks = [
    { trackTitle: 'Good Track',    writers: [], isrcs: [], iswc: null, enriched: true },
    { trackTitle: 'Problem Track', writers: [], isrcs: [], iswc: null, enriched: false },
  ];
  const readinessMap = new Map([
    ['good track',    { decision: 'READY',   blockers: [] }],
    ['problem track', { decision: 'BLOCKED', blockers: [{ code: 'MISSING_WRITERS', severity: 'BLOCKING', message: 'No writers' }] }],
  ]);

  let err = null;
  try {
    assertExportReady(tracks, readinessMap);
  } catch (e) {
    err = e;
  }

  assert(err?.code === 'EXPORT_BLOCKED', 'Export blocked for mixed selection');
  assert(err?.nonReady?.length === 1, `Only the blocked track in nonReady (got ${err?.nonReady?.length})`);
  assert(err?.nonReady[0]?.trackTitle === 'Problem Track', 'Blocked track identified by title');
  assert(
    err?.nonReady[0]?.blockers?.some(b => b.code === 'MISSING_WRITERS'),
    'Blocker codes returned with export error'
  );
}

// ── Test 15: Unauthorized write/reevaluation is rejected ──────────────────────

function test15_unauthorized_write_rejected() {
  console.log('\n[15] evaluate-readiness returns 401 when x-admin-key is wrong');
  const handler = require('../api/evaluate-readiness');

  return new Promise(resolve => {
    const origKey = process.env.AUDIT_ADMIN_KEY;
    process.env.AUDIT_ADMIN_KEY = 'secret-key-123';

    const res = {
      setHeader: () => {},
      status: (code) => ({
        json: (body) => {
          assert(code === 401, `401 returned for wrong admin key (got ${code})`);
          assert(body.error === 'Unauthorized', `error message is "Unauthorized" (got "${body.error}")`);
          if (origKey !== undefined) process.env.AUDIT_ADMIN_KEY = origKey;
          else delete process.env.AUDIT_ADMIN_KEY;
          resolve();
        },
        end: () => resolve(),
      }),
    };
    const req = {
      method: 'POST',
      headers: { 'x-admin-key': 'wrong-key' },
      body: { artist_name: 'Test' },
    };

    handler(req, res);
  });
}

// ── Test 16: Private schemas remain unexposed ──────────────────────────────────

function test16_private_schemas_unexposed() {
  console.log('\n[16] evaluate-readiness and get-readiness do not expose graph or works schemas');
  const evalSrc = require('fs').readFileSync(
    require('path').join(__dirname, '../api/evaluate-readiness.js'), 'utf8'
  );
  const getSrc = require('fs').readFileSync(
    require('path').join(__dirname, '../api/get-readiness.js'), 'utf8'
  );

  for (const [file, src] of [['evaluate-readiness', evalSrc], ['get-readiness', getSrc]]) {
    assert(
      !src.includes("Accept-Profile': 'graph'") && !src.includes('Accept-Profile: graph'),
      `${file}: does not send Accept-Profile: graph header`
    );
    assert(
      !src.includes("Accept-Profile': 'works'") && !src.includes('Accept-Profile: works'),
      `${file}: does not send Accept-Profile: works header`
    );
    assert(
      !src.includes('/rest/v1/nodes') && !src.includes('/rest/v1/edges'),
      `${file}: does not query graph.nodes or graph.edges directly`
    );
  }
}

// ── Test 17: Existing graph-sync tests remain green (import check) ────────────

function test17_graph_sync_tests_remain_importable() {
  console.log('\n[17] Graph sync module still imports cleanly after changes');
  let threw = false;
  try {
    delete require.cache[require.resolve('../api/graph-sync')];
    const mod = require('../api/graph-sync');
    assert(typeof mod.syncEnrichmentToGraph === 'function', 'syncEnrichmentToGraph still exported');
    assert(typeof mod.syncCatalogToGraph === 'function', 'syncCatalogToGraph still exported');
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'api/graph-sync imports without error');
}

// ── Test 18: generateGapsReport no longer uses readyToRegister ────────────────

function test18_gaps_report_no_ready_to_register() {
  console.log('\n[18] generateGapsReport no longer exposes "readyToRegister" — replaced with writersPresent');
  const tracks = [
    { writers: ['writer A'], isrcs: ['USABC001'], iswc: 'T-123', enriched: true },
    { writers: [],           isrcs: [],           iswc: null,    enriched: false },
  ];
  const report = generateGapsReport(tracks);

  assert(!('readyToRegister' in report), 'readyToRegister key no longer present in gaps report');
  assert('writersPresent' in report, 'writersPresent key is present');
  assert(report.writersPresent === 1, `writersPresent = 1 (got ${report.writersPresent})`);
  assert(report.totalTracks === 2, `totalTracks = 2 (got ${report.totalTracks})`);
  assert(report.missingWriters === 1, `missingWriters = 1 (got ${report.missingWriters})`);
}

// ── Test 19: NOT_EVALUATED tracks block export (fail closed) ──────────────────

function test19_not_evaluated_blocks_export() {
  console.log('\n[19] Track with no readiness row → NOT_EVALUATED → export blocked (fail closed)');
  const track = { trackTitle: 'Unreviewed Track', writers: [], isrcs: [], iswc: null, enriched: true };
  const emptyMap = new Map();  // No readiness data for this track

  let err = null;
  try {
    assertExportReady([track], emptyMap);
  } catch (e) {
    err = e;
  }

  assert(err?.code === 'EXPORT_BLOCKED', 'Export blocked when readiness not evaluated');
  assert(
    err?.nonReady[0]?.decision === 'NOT_EVALUATED',
    `decision is NOT_EVALUATED (got "${err?.nonReady[0]?.decision}")`
  );
  assert(
    err?.nonReady[0]?.blockers?.some(b => b.code === 'NOT_EVALUATED'),
    'NOT_EVALUATED blocker code returned'
  );
}

// ── Test 20: Unit tests make no external submissions ──────────────────────────

function test20_no_external_submissions() {
  console.log('\n[20] evaluation library is side-effect-free — produces no network calls');
  const track = readyASCAPTrack();
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return {}; };

  try {
    evaluateAllDestinations(track);
  } finally {
    global.fetch = originalFetch;
  }

  assert(!fetchCalled, 'evaluateAllDestinations made no network calls');
}

// ── Bonus: evaluate all destinations for a completely incomplete track ─────────

function testBonus_completely_incomplete_track() {
  console.log('\n[Bonus] Completely incomplete track → BLOCKED for all composition/recording destinations');
  const track = {
    id: 'zzzzzzzz-0000-0000-0000-000000000099',
    track_title: 'Ghost Track',
    artist_name: 'Unknown',
    isrcs: [],
    iswc: null,
    writers: [],
    enriched: false,
    enrichment_error: null,
    splits_validated: false,
    master_rights_holder: null,
    publisher_ipi: null,
    publisher_name: null,
  };

  const decisions = evaluateAllDestinations(track);
  assert(decisions.length === 5, `All 5 destinations evaluated (got ${decisions.length})`);

  for (const d of decisions) {
    assert(d.decision === 'BLOCKED', `${d.destination}: BLOCKED for completely incomplete track (got "${d.decision}")`);
    assert(d.blockers.length > 0, `${d.destination}: has blockers`);
    assert(typeof d.evaluated_at === 'string', `${d.destination}: evaluated_at is a string`);
    assert(d.ruleset_version === RULESET_VERSION, `${d.destination}: ruleset_version is ${RULESET_VERSION}`);
  }
}

// ── Bonus: evaluate contract shape ────────────────────────────────────────────

function testBonus_decision_contract_shape() {
  console.log('\n[Bonus] Decision object has all required contract fields');
  const track = readyASCAPTrack();
  const r = evaluateReadiness(track, 'ASCAP');

  const requiredFields = [
    'catalog_track_id', 'destination', 'decision',
    'evaluated_at', 'ruleset_version', 'blockers', 'warnings',
    'evidence_summary', 'existing_registration',
  ];
  for (const field of requiredFields) {
    assert(field in r, `contract field "${field}" present`);
  }
  assert(Array.isArray(r.blockers), 'blockers is an array');
  assert(Array.isArray(r.warnings), 'warnings is an array');
  assert(typeof r.evidence_summary === 'object', 'evidence_summary is an object');
  assert(['READY','BLOCKED','NEEDS_REVIEW','NOT_APPLICABLE'].includes(r.decision),
    `decision is a valid enum value (got "${r.decision}")`);
}

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== registration-readiness.test.js ===');
  console.log(`Ruleset: ${RULESET_VERSION}\n`);

  test1_writer_no_ipi_blocked();
  test2_writer_ipi_present_no_pro_needs_review();
  test3_bmi_writer_not_ascap_ready();
  test4_ascap_writer_not_bmi_ready();
  test5_missing_iswc_not_universally_blocking();
  test6_missing_isrc_blocks_soundexchange_and_neighboring();
  test7_isrc_no_master_rights_holder_blocked();
  test8_writer_conflict_blocks();
  test9_no_confirmed_splits_blocks_composition();
  test10_existing_registration_amendment();
  test11_idempotent_reevaluation();
  test12_evidence_changes_produce_new_decision();
  test13_blocked_track_cannot_export();
  test14_mixed_ready_blocked_export_fails();
  await test15_unauthorized_write_rejected();
  test16_private_schemas_unexposed();
  test17_graph_sync_tests_remain_importable();
  test18_gaps_report_no_ready_to_register();
  test19_not_evaluated_blocks_export();
  test20_no_external_submissions();
  testBonus_completely_incomplete_track();
  testBonus_decision_contract_shape();

  console.log(`\n${'─'.repeat(50)}`);
  const total = passed + failed;
  if (failed > 0) {
    console.error(`${total} assertions | ${passed} passed | ${failed} FAILED`);
    process.exit(1);
  } else {
    console.log(`${total} assertions | ${total} passed`);
    process.exit(0);
  }
})();
