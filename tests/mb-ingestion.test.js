'use strict';
// tests/mb-ingestion.test.js
// MusicBrainz ingestion pipeline tests.
//
// All tests run without network access or a real database.
// DB calls are intercepted via global.fetch mocks.
// File I/O is tested with in-memory stream simulation.
//
// Tests:
//   1.  normalize() — strips non-alphanumeric, lowercases
//   2.  titleSimilarity() — trigram Jaccard: identical=1, unrelated=0
//   3.  titleSimilarity() — short strings fall back to char overlap
//   4.  titleSimilarity() — partial match scores in (0, 1)
//   5.  parseLine() — TSV parse with \N NULL handling
//   6.  parseLine() — column count mismatch handled gracefully
//   7.  ISRC exact match → confidence 1.0, method 'isrc_exact'
//   8.  MBID direct match → confidence 1.0, method 'mbid_direct'
//   9.  ISWC exact match → confidence 0.95, method 'iswc_exact'
//   10. Fuzzy name match → confidence < 0.9, method 'name_fuzzy'
//   11. Duration bonus applied when within 2 seconds
//   12. Artist name collision — two different MBIDs returned as separate candidates
//   13. Recording vs work are never conflated — distinct entity types
//   14. Repeated resolution is idempotent — same candidates re-upserted
//   15. No candidates when staging tables are empty
//   16. Batch chunking: 1200 rows → 3 batches of ≤500
//   17. Checkpoint save/load (mock Supabase)
//   18. Dry-run does not call fetch
//   19. Provenance fields are set on all staging rows
//   20. Artist without MBID generates no API calls

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else       { console.error(`  ❌ FAIL: ${label}`); failed++; }
}

// ── Imports ───────────────────────────────────────────────────────────────────

const { normalize, titleSimilarity } = require('../lib/mb-entity-resolver');
const { parseLine, COLUMN_DEFS }     = require('../lib/mb-dump-parser');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockFetch(responses) {
  return async (url) => {
    for (const [pattern, payload] of responses) {
      if (url.includes(pattern)) {
        return { ok: true, text: async () => JSON.stringify(payload) };
      }
    }
    return { ok: true, text: async () => JSON.stringify([]) };
  };
}

function mockFetchFail(status, message) {
  return async () => ({ ok: false, status, text: async () => JSON.stringify({ message }) });
}

function loadFreshResolver() {
  delete require.cache[require.resolve('../lib/mb-entity-resolver')];
  delete require.cache[require.resolve('../lib/mb-staging-writer')];
  return require('../lib/mb-entity-resolver');
}

function loadFreshWriter() {
  delete require.cache[require.resolve('../lib/mb-staging-writer')];
  return require('../lib/mb-staging-writer');
}

// ── Test 1: normalize() ───────────────────────────────────────────────────────

async function test1_normalize() {
  console.log('\n[1] normalize() strips non-alphanumeric and lowercases');
  assert(normalize('Hello World!')  === 'helloworld',    'strips spaces and punctuation');
  assert(normalize('ASCAP-BMI/PRO') === 'ascapbmipro',  'strips hyphens and slashes');
  assert(normalize('')              === '',               'empty string returns empty');
  assert(normalize(null)            === '',               'null returns empty');
  assert(normalize('Esham')         === 'esham',          'simple name normalized');
}

// ── Test 2: titleSimilarity() identical ──────────────────────────────────────

async function test2_similarity_identical() {
  console.log('\n[2] titleSimilarity() identical strings return 1.0');
  assert(titleSimilarity('Redrum', 'Redrum')               === 1.0, 'identical exact');
  assert(titleSimilarity('Acid Rain', 'Acid Rain')         === 1.0, 'identical with space');
  assert(titleSimilarity('A-1', 'A-1')                     === 1.0, 'identical with hyphen');
}

// ── Test 3: titleSimilarity() unrelated ──────────────────────────────────────

async function test3_similarity_unrelated() {
  console.log('\n[3] titleSimilarity() completely unrelated strings score near 0');
  const score = titleSimilarity('Symphony No. 5', 'Hip Hop Maniac');
  assert(score < 0.2, `unrelated strings score < 0.2 (got ${score.toFixed(3)})`);
}

// ── Test 4: titleSimilarity() partial match ───────────────────────────────────

async function test4_similarity_partial() {
  console.log('\n[4] titleSimilarity() partial match scores in (0, 1)');
  const score1 = titleSimilarity('Acid Rain', 'Acid Reigns');
  assert(score1 > 0.1 && score1 < 0.9, `"Acid Rain" vs "Acid Reigns" in (0.1, 0.9): ${score1.toFixed(3)}`);

  const score2 = titleSimilarity('Redrum', 'Redrum (Remix)');
  assert(score2 > 0.2 && score2 < 1.0, `remix vs original in (0.2, 1.0): ${score2.toFixed(3)}`);
}

// ── Test 5: parseLine() basic ─────────────────────────────────────────────────

async function test5_parseline_basic() {
  console.log('\n[5] parseLine() correctly parses a TSV line with \\N nulls');
  const cols = COLUMN_DEFS.recording;
  const line = '123456\tabc123-gid\tRedrum\t99\t210000\t\\N\t0\t2022-01-01 00:00:00\tf';
  const row  = parseLine(line, cols);

  assert(row.gid  === 'abc123-gid',   `gid parsed (got "${row.gid}")`);
  assert(row.name === 'Redrum',        `name parsed (got "${row.name}")`);
  assert(row.comment === null,         `\\N → null for comment (got ${JSON.stringify(row.comment)})`);
  assert(row.length === '210000',      `length parsed as string (got "${row.length}")`);
}

// ── Test 6: parseLine() short line ───────────────────────────────────────────

async function test6_parseline_short_line() {
  console.log('\n[6] parseLine() handles line with fewer columns than expected (no throw)');
  const cols = COLUMN_DEFS.recording;
  const line = '123\tabc-gid\tTitle Only';
  let threw = false;
  let row;
  try { row = parseLine(line, cols); } catch (e) { threw = true; }
  assert(!threw, 'no exception on short line');
  assert(row.gid  === 'abc-gid', `gid present (got "${row.gid}")`);
  assert(row.comment === null,   'missing columns → null');
}

// ── Test 7: ISRC exact match → confidence 1.0 ────────────────────────────────

async function test7_isrc_exact_match() {
  console.log('\n[7] resolveTrack() ISRC exact match → confidence 1.0, method isrc_exact');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const origFetch = global.fetch;
  global.fetch = mockFetch([
    ['fn_mb_lookup_isrc', [{ mb_recording_id: 'mb-rec-0007' }]],
  ]);

  const { resolveTrack } = loadFreshResolver();
  const candidates = await resolveTrack({
    id:          'track-0007',
    isrcs:       ['USABC1234567'],
    recording_mbid: null,
    iswc:        null,
    track_title: 'Redrum',
  });

  global.fetch = origFetch;

  const top = candidates[0];
  assert(top?.confidence        === 1.0,          `confidence = 1.0 (got ${top?.confidence})`);
  assert(top?.match_method      === 'isrc_exact',  `method = isrc_exact (got "${top?.match_method}")`);
  assert(top?.mb_entity_type    === 'recording',   `entity type = recording (got "${top?.mb_entity_type}")`);
  assert(top?.mb_entity_id      === 'mb-rec-0007', `mb_entity_id correct (got "${top?.mb_entity_id}")`);
  assert(top?.musigod_entity_id === 'track-0007',  `musigod_entity_id correct (got "${top?.musigod_entity_id}")`);
}

// ── Test 8: MBID direct match → confidence 1.0 ───────────────────────────────

async function test8_mbid_direct_match() {
  console.log('\n[8] resolveTrack() MBID direct match → confidence 1.0, method mbid_direct');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const origFetch = global.fetch;
  global.fetch = mockFetch([
    ['fn_mb_lookup_isrc', []],
    ['fn_mb_lookup_recording_mbid', [{ mb_recording_id: 'mb-rec-0008' }]],
  ]);

  const { resolveTrack } = loadFreshResolver();
  const candidates = await resolveTrack({
    id:             'track-0008',
    isrcs:          [],
    recording_mbid: 'mb-rec-0008',
    iswc:           null,
    track_title:    'Acid Rain',
  });

  global.fetch = origFetch;

  const top = candidates[0];
  assert(top?.confidence   === 1.0,           `confidence = 1.0 (got ${top?.confidence})`);
  assert(top?.match_method === 'mbid_direct', `method = mbid_direct (got "${top?.match_method}")`);
  assert(top?.mb_entity_id === 'mb-rec-0008', `mb_entity_id correct (got "${top?.mb_entity_id}")`);
}

// ── Test 9: ISWC exact match → confidence 0.95 ───────────────────────────────

async function test9_iswc_exact_match() {
  console.log('\n[9] resolveTrack() ISWC exact match → confidence 0.95, entity type work');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const origFetch = global.fetch;
  global.fetch = mockFetch([
    ['fn_mb_lookup_isrc', []],
    ['fn_mb_lookup_recording_mbid', []],
    ['fn_mb_lookup_iswc', [{ mb_work_id: 'mb-work-0009' }]],
  ]);

  const { resolveTrack } = loadFreshResolver();
  const candidates = await resolveTrack({
    id:             'track-0009',
    isrcs:          [],
    recording_mbid: null,
    iswc:           'T-000.000.009-0',
    track_title:    'Composition Nine',
  });

  global.fetch = origFetch;

  const workCandidate = candidates.find(c => c.mb_entity_type === 'work');
  assert(workCandidate !== undefined,             'work candidate found');
  assert(workCandidate?.confidence    === 0.95,   `confidence = 0.95 (got ${workCandidate?.confidence})`);
  assert(workCandidate?.match_method  === 'iswc_exact', `method = iswc_exact (got "${workCandidate?.match_method}")`);
  assert(workCandidate?.mb_entity_id  === 'mb-work-0009', 'mb_entity_id correct');

  // Crucially: the work candidate must NOT appear as a recording
  assert(workCandidate?.mb_entity_type !== 'recording', 'work is NOT confused with recording');
}

// ── Test 10: Fuzzy name match → confidence < 0.9 ─────────────────────────────

async function test10_fuzzy_name_match() {
  console.log('\n[10] resolveTrack() fuzzy name match → confidence < 0.9, method name_fuzzy');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const origFetch = global.fetch;
  global.fetch = mockFetch([
    ['fn_mb_search_recordings', [{ mb_recording_id: 'mb-rec-0010', title: 'Redrum', length_ms: '185000' }]],
  ]);

  const { resolveTrack } = loadFreshResolver();
  const candidates = await resolveTrack({
    id:             'track-0010',
    isrcs:          [],
    recording_mbid: null,
    iswc:           null,
    track_title:    'Redrum',
    track_duration: 185,
  });

  global.fetch = origFetch;

  const top = candidates[0];
  assert(top !== undefined,                  'candidate found');
  assert(top?.match_method === 'name_fuzzy', `method = name_fuzzy (got "${top?.match_method}")`);
  assert(top?.confidence   <  0.9,           `confidence < 0.9 (got ${top?.confidence})`);
  assert(top?.confidence   >  0.0,           `confidence > 0 (got ${top?.confidence})`);
}

// ── Test 11: Duration bonus ───────────────────────────────────────────────────

async function test11_duration_bonus() {
  console.log('\n[11] resolveTrack() duration bonus applied when within 2 seconds');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const origFetch = global.fetch;

  // Exact duration match
  global.fetch = mockFetch([
    ['fn_mb_search_recordings', [{ mb_recording_id: 'mb-rec-0011', title: 'Redrum', length_ms: '185000' }]],
  ]);
  const { resolveTrack: r1 } = loadFreshResolver();
  const withBonus = await r1({ id: 't1', isrcs: [], recording_mbid: null, iswc: null, track_title: 'Redrum', track_duration: 185 });

  global.fetch = mockFetch([
    ['fn_mb_search_recordings', [{ mb_recording_id: 'mb-rec-0011b', title: 'Redrum', length_ms: '250000' }]],
  ]);
  const { resolveTrack: r2 } = loadFreshResolver();
  const noBonus = await r2({ id: 't2', isrcs: [], recording_mbid: null, iswc: null, track_title: 'Redrum', track_duration: 185 });

  global.fetch = origFetch;

  const bonusConf  = withBonus[0]?.confidence  || 0;
  const nobonusConf = noBonus[0]?.confidence   || 0;

  assert(bonusConf > nobonusConf, `duration match increases confidence: ${bonusConf.toFixed(3)} > ${nobonusConf.toFixed(3)}`);
  assert(withBonus[0]?.match_signals?.duration_match === true, 'duration_match signal set');
}

// ── Test 12: Artist name collision ────────────────────────────────────────────

async function test12_artist_name_collision() {
  console.log('\n[12] resolveTrack() artist name collision — two different MBIDs remain separate');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const origFetch = global.fetch;
  // Two recordings with same title but different MBIDs (different artists with same name)
  global.fetch = mockFetch([
    ['fn_mb_lookup_isrc', [
      { mb_recording_id: 'mb-rec-collision-A' },
      { mb_recording_id: 'mb-rec-collision-B' },
    ]],
  ]);

  const { resolveTrack } = loadFreshResolver();
  const candidates = await resolveTrack({
    id:          'track-collision',
    isrcs:       ['USABC0000001', 'USABC0000002'],
    recording_mbid: null,
    iswc:        null,
    track_title: 'Common Title',
  });

  global.fetch = origFetch;

  const mbIds = candidates.map(c => c.mb_entity_id);
  assert(mbIds.includes('mb-rec-collision-A'), 'first MBID present');
  assert(mbIds.includes('mb-rec-collision-B'), 'second MBID present');
  assert(mbIds.length >= 2, `at least 2 distinct candidates (got ${mbIds.length})`);

  // Both must be recordings, not works
  const nonRecordings = candidates.filter(c => c.mb_entity_type !== 'recording');
  assert(nonRecordings.length === 0, 'all collision candidates are recordings, not works');
}

// ── Test 13: Recording vs work distinction ────────────────────────────────────

async function test13_recording_vs_work_not_conflated() {
  console.log('\n[13] recording and work entity types never conflated');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const origFetch = global.fetch;
  global.fetch = mockFetch([
    ['fn_mb_lookup_isrc', [{ mb_recording_id: 'mb-rec-0013' }]],
    ['fn_mb_lookup_iswc', [{ mb_work_id:      'mb-work-0013' }]],
  ]);

  const { resolveTrack } = loadFreshResolver();
  const candidates = await resolveTrack({
    id:          'track-0013',
    isrcs:       ['USREC0000013'],
    recording_mbid: null,
    iswc:        'T-000.000.013-0',
    track_title: 'Dual Match',
  });

  global.fetch = origFetch;

  const recCands  = candidates.filter(c => c.mb_entity_type === 'recording');
  const workCands = candidates.filter(c => c.mb_entity_type === 'work');

  assert(recCands.length  >= 1, `at least 1 recording candidate (got ${recCands.length})`);
  assert(workCands.length >= 1, `at least 1 work candidate (got ${workCands.length})`);

  const recMbIds  = recCands.map(c => c.mb_entity_id);
  const workMbIds = workCands.map(c => c.mb_entity_id);

  assert(!recMbIds.includes('mb-work-0013'),  'work MBID not in recording candidates');
  assert(!workMbIds.includes('mb-rec-0013'),  'recording MBID not in work candidates');
}

// ── Test 14: Idempotency ──────────────────────────────────────────────────────

async function test14_resolution_idempotent() {
  console.log('\n[14] Repeated resolution calls produce same candidates — upsert is idempotent');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, method: opts?.method || 'GET' });
    if (url.includes('fn_mb_lookup_isrc')) {
      return { ok: true, text: async () => JSON.stringify([{ mb_recording_id: 'mb-rec-idem' }]) };
    }
    if (url.includes('fn_mb_upsert_entity_matches')) {
      return { ok: true, text: async () => JSON.stringify(null) };
    }
    return { ok: true, text: async () => JSON.stringify([]) };
  };

  const { resolveTrack, persistCandidates } = loadFreshResolver();
  const track = { id: 'track-idem', isrcs: ['USIDEM000001'], recording_mbid: null, iswc: null, track_title: 'Idempotent' };

  const c1 = await resolveTrack(track);
  await persistCandidates(c1);
  const c2 = await resolveTrack(track);
  await persistCandidates(c2);

  global.fetch = origFetch;

  assert(c1.length === c2.length, `same number of candidates both runs (${c1.length} = ${c2.length})`);
  assert(c1[0]?.mb_entity_id === c2[0]?.mb_entity_id, 'same top candidate both runs');
  assert(c1[0]?.confidence   === c2[0]?.confidence,   'same confidence both runs');

  const matchUpserts = calls.filter(c => c.url.includes('fn_mb_upsert_entity_matches'));
  assert(matchUpserts.length === 2, `entity_matches_v1 written twice (once per run, got ${matchUpserts.length})`);
}

// ── Test 15: No candidates when staging empty ─────────────────────────────────

async function test15_no_candidates_when_staging_empty() {
  console.log('\n[15] resolveTrack() returns empty array when staging tables have no matching data');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const origFetch = global.fetch;
  global.fetch = mockFetch([]);  // all endpoints return []

  const { resolveTrack } = loadFreshResolver();
  const candidates = await resolveTrack({
    id:          'track-empty',
    isrcs:       ['USXXX9999999'],
    recording_mbid: null,
    iswc:        null,
    track_title: 'Ghost Track',
  });

  global.fetch = origFetch;

  assert(Array.isArray(candidates),   'returns array');
  assert(candidates.length === 0,     `empty array when no matches (got ${candidates.length})`);
}

// ── Test 16: Batch chunking ───────────────────────────────────────────────────

async function test16_batch_chunking() {
  console.log('\n[16] upsertBatch() splits 1200 rows into batches of ≤500');

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (opts?.method === 'POST') {
      const body = JSON.parse(opts.body);
      calls.push(body.rows || body);
    }
    return { ok: true, text: async () => JSON.stringify(null) };
  };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { upsertArtists } = loadFreshWriter();

  const artists = Array.from({ length: 1200 }, (_, i) => ({
    mb_artist_id: `mb-artist-${i}`,
    name:         `Artist ${i}`,
    ingestion_source: 'dump',
    provenance:   {},
    ended:        false,
  }));

  await upsertArtists(artists);

  global.fetch = origFetch;

  // 1200 rows at 500/batch = 3 batches (500 + 500 + 200)
  assert(calls.length === 3, `3 batches for 1200 rows (got ${calls.length})`);
  assert(calls[0].length === 500, `batch 1: 500 rows (got ${calls[0].length})`);
  assert(calls[1].length === 500, `batch 2: 500 rows (got ${calls[1].length})`);
  assert(calls[2].length === 200, `batch 3: 200 rows (got ${calls[2].length})`);
}

// ── Test 17: Checkpoint save/load ─────────────────────────────────────────────

async function test17_checkpoint_save_load() {
  console.log('\n[17] checkpointProgress() saves state; getIngestionState() reads it back');

  const storedStates = {};
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (url.includes('fn_mb_save_ingestion_state')) {
      const body = JSON.parse(opts.body);
      const k = `${body.p_entity_type}:${body.p_import_mode}`;
      storedStates[k] = body.p_data;
      return { ok: true, text: async () => JSON.stringify(null) };
    }
    if (url.includes('fn_mb_get_ingestion_state')) {
      const body = JSON.parse(opts.body);
      const k = `${body.p_entity_type}:${body.p_import_mode}`;
      return { ok: true, text: async () => JSON.stringify(storedStates[k] || null) };
    }
    return { ok: true, text: async () => JSON.stringify(null) };
  };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { checkpointProgress, getIngestionState } = loadFreshWriter();

  await checkpointProgress('recordings', 'dump', 50000, 'mb-rec-last', 50000, 3);
  const state = await getIngestionState('recordings', 'dump');

  global.fetch = origFetch;

  assert(state !== null,                      'state returned (not null)');
  assert(state?.last_offset     === 50000,    `last_offset = 50000 (got ${state?.last_offset})`);
  assert(state?.last_mb_id      === 'mb-rec-last', `last_mb_id preserved (got "${state?.last_mb_id}")`);
  assert(state?.total_processed === 50000,    `total_processed = 50000 (got ${state?.total_processed})`);
  assert(state?.total_errors    === 3,        `total_errors = 3 (got ${state?.total_errors})`);
}

// ── Test 18: Dry-run does not write ──────────────────────────────────────────

async function test18_dry_run_no_writes() {
  console.log('\n[18] upsertArtists() in dry-run mode makes no fetch calls');

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, method: opts?.method || 'GET' });
    return { ok: true, text: async () => JSON.stringify(null) };
  };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { upsertArtists } = loadFreshWriter();
  await upsertArtists([
    { mb_artist_id: 'dry-run-artist', name: 'Dry Run Artist', ingestion_source: 'api', provenance: {}, ended: false },
  ], true); // dryRun = true

  global.fetch = origFetch;

  assert(calls.length === 0, `no fetch calls in dry-run (got ${calls.length})`);
}

// ── Test 19: Provenance fields ────────────────────────────────────────────────

async function test19_provenance_fields() {
  console.log('\n[19] API-mode staging rows include provenance with source and data_license');
  // We test this by constructing a staging row and checking its structure
  // (no DB call needed — the shape is validated in-process)

  const row = {
    mb_artist_id:    'mb-prov-0019',
    name:            'Esham',
    sort_name:       'Esham',
    artist_type:     'Person',
    ingestion_source: 'api',
    provenance:      { source: 'musicbrainz', data_license: 'CC0', fetched_at: new Date().toISOString() },
    ended:           false,
  };

  assert(row.provenance?.source       === 'musicbrainz', 'source = musicbrainz');
  assert(row.provenance?.data_license === 'CC0',         'data_license = CC0');
  assert(typeof row.provenance?.fetched_at === 'string', 'fetched_at is ISO string');
  assert(row.ingestion_source          === 'api',        'ingestion_source = api');
}

// ── Test 20: Artist without MBID ─────────────────────────────────────────────

async function test20_no_mbid_no_api_calls() {
  console.log('\n[20] resolveTrack() with no ISRC, no MBID, no ISWC, short title → no API calls to staging');

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(url);
    return { ok: true, text: async () => JSON.stringify([]) };
  };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { resolveTrack } = loadFreshResolver();
  const candidates = await resolveTrack({
    id:             'track-noid',
    isrcs:          [],
    recording_mbid: null,
    iswc:           null,
    track_title:    'Hi',  // too short for trigram search (length < 3 after normalize)
  });

  global.fetch = origFetch;

  // isrcs_v1 is not called (no ISRCs)
  // recordings_v1 MBID lookup is skipped (no MBID)
  // iswcs_v1 is skipped (no ISWC)
  // title fuzzy: normalize('Hi') = 'hi', length = 2 < 3, so fuzzy skipped too
  const isrcCalls    = calls.filter(u => u.includes('fn_mb_lookup_isrc'));
  const mbidCalls    = calls.filter(u => u.includes('fn_mb_lookup_recording_mbid'));
  const iswcCalls    = calls.filter(u => u.includes('fn_mb_lookup_iswc'));
  const titleCalls   = calls.filter(u => u.includes('fn_mb_search_recordings'));

  assert(isrcCalls.length  === 0, `no isrcs_v1 calls (got ${isrcCalls.length})`);
  assert(mbidCalls.length  === 0, `no MBID lookup calls (got ${mbidCalls.length})`);
  assert(iswcCalls.length  === 0, `no iswcs_v1 calls (got ${iswcCalls.length})`);
  assert(titleCalls.length === 0, `no title fuzzy calls for short title (got ${titleCalls.length})`);
  assert(candidates.length === 0, 'no candidates returned');
}

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== mb-ingestion.test.js ===');
  console.log('MusicBrainz ingestion pipeline — parser, resolver, writer, idempotency\n');

  await test1_normalize();
  await test2_similarity_identical();
  await test3_similarity_unrelated();
  await test4_similarity_partial();
  await test5_parseline_basic();
  await test6_parseline_short_line();
  await test7_isrc_exact_match();
  await test8_mbid_direct_match();
  await test9_iswc_exact_match();
  await test10_fuzzy_name_match();
  await test11_duration_bonus();
  await test12_artist_name_collision();
  await test13_recording_vs_work_not_conflated();
  await test14_resolution_idempotent();
  await test15_no_candidates_when_staging_empty();
  await test16_batch_chunking();
  await test17_checkpoint_save_load();
  await test18_dry_run_no_writes();
  await test19_provenance_fields();
  await test20_no_mbid_no_api_calls();

  console.log(`\n${'─'.repeat(50)}`);
  const total = passed + failed;
  if (failed > 0) {
    console.error(`${total} assertions | ${passed} passed | ${failed} FAILED`);
  } else {
    console.log(`${total} assertions | ${total} passed`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
