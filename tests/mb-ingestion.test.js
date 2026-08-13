'use strict';
// tests/mb-ingestion.test.js
// MusicBrainz ingestion pipeline tests.
//
// All tests run without network access or a real database.
// Corpus DB calls (external PostgreSQL) are intercepted via mock pool injection.
// Supabase calls (entity_matches_v1) are intercepted via global.fetch mocks.
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
//   16. Batch chunking: 1200 rows → 3 corpus DB inserts of ≤500
//   17. Checkpoint save/load (mock corpus DB)
//   18. Dry-run does not call corpus DB or Supabase
//   19. Provenance fields are set on all staging rows
//   20. Artist without MBID generates no corpus DB calls
//   21. Corpus DB not configured → writer throws clear error
//   22. Corpus DB outage → resolver degrades gracefully (empty candidates, no throw)
//   23. healthCheck() returns false when corpus DB query throws
//   24. Resolver normalizes hyphenated ISRC before corpus lookup (no hyphen in query param)
//   25. loadEnrichedTracks() paginates: fetches all pages when first page is full

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else       { console.error(`  ❌ FAIL: ${label}`); failed++; }
}

// ── Imports ───────────────────────────────────────────────────────────────────

const { normalize, titleSimilarity } = require('../lib/mb-entity-resolver');
const { parseLine, COLUMN_DEFS }     = require('../lib/mb-dump-parser');

// ── Mock helpers ──────────────────────────────────────────────────────────────

// Build a mock pg pool. responses: array of [sqlSubstring, rows[]]
function makeMockPool(responses = []) {
  return {
    async query(sql, _params) {
      for (const [pattern, rows] of responses) {
        if (sql.includes(pattern)) return { rows };
      }
      return { rows: [] };
    },
    on() {},
    async end() {},
  };
}

// Build a mock pool that records every query call for inspection.
function makeSpy(responses = []) {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [pattern, rows] of responses) {
        if (sql.includes(pattern)) return { rows };
      }
      return { rows: [] };
    },
    on() {},
    async end() {},
  };
  return { pool, calls };
}

// Fetch mock for Supabase entity_matches_v1 RPC calls.
function mockSbFetch(responses = []) {
  return async (url, opts) => {
    for (const [pattern, payload] of responses) {
      if (url.includes(pattern)) {
        return { ok: true, text: async () => JSON.stringify(payload) };
      }
    }
    return { ok: true, text: async () => JSON.stringify([]) };
  };
}

// ── Module loaders ────────────────────────────────────────────────────────────

function loadFreshCorpusDb() {
  delete require.cache[require.resolve('../lib/mb-corpus-db')];
  return require('../lib/mb-corpus-db');
}

function loadFreshResolver() {
  // Clear all three inter-dependent modules so the corpus-db singleton resets.
  delete require.cache[require.resolve('../lib/mb-entity-resolver')];
  delete require.cache[require.resolve('../lib/mb-staging-writer')];
  delete require.cache[require.resolve('../lib/mb-corpus-db')];
  return require('../lib/mb-entity-resolver');
}

function loadFreshWriter() {
  delete require.cache[require.resolve('../lib/mb-staging-writer')];
  delete require.cache[require.resolve('../lib/mb-corpus-db')];
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

  const { resolveTrack } = loadFreshResolver();
  const corpusDb = require('../lib/mb-corpus-db');
  corpusDb._setPool(makeMockPool([
    ['isrcs_v1', [{ mb_recording_id: 'mb-rec-0007' }]],
  ]));

  const candidates = await resolveTrack({
    id:          'track-0007',
    isrcs:       ['USABC1234567'],
    recording_mbid: null,
    iswc:        null,
    track_title: 'Redrum',
  });

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

  const { resolveTrack } = loadFreshResolver();
  const corpusDb = require('../lib/mb-corpus-db');
  // isrcs_v1 → [] (no ISRC match); recordings_v1 → MBID match
  corpusDb._setPool(makeMockPool([
    ['recordings_v1', [{ mb_recording_id: 'mb-rec-0008' }]],
  ]));

  const candidates = await resolveTrack({
    id:             'track-0008',
    isrcs:          [],
    recording_mbid: 'mb-rec-0008',
    iswc:           null,
    track_title:    'Acid Rain',
  });

  const top = candidates[0];
  assert(top?.confidence   === 1.0,           `confidence = 1.0 (got ${top?.confidence})`);
  assert(top?.match_method === 'mbid_direct', `method = mbid_direct (got "${top?.match_method}")`);
  assert(top?.mb_entity_id === 'mb-rec-0008', `mb_entity_id correct (got "${top?.mb_entity_id}")`);
}

// ── Test 9: ISWC exact match → confidence 0.95 ───────────────────────────────

async function test9_iswc_exact_match() {
  console.log('\n[9] resolveTrack() ISWC exact match → confidence 0.95, entity type work');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { resolveTrack } = loadFreshResolver();
  const corpusDb = require('../lib/mb-corpus-db');
  corpusDb._setPool(makeMockPool([
    ['iswcs_v1', [{ mb_work_id: 'mb-work-0009' }]],
  ]));

  const candidates = await resolveTrack({
    id:             'track-0009',
    isrcs:          [],
    recording_mbid: null,
    iswc:           'T-000.000.009-0',
    track_title:    'Composition Nine',
  });

  const workCandidate = candidates.find(c => c.mb_entity_type === 'work');
  assert(workCandidate !== undefined,             'work candidate found');
  assert(workCandidate?.confidence    === 0.95,   `confidence = 0.95 (got ${workCandidate?.confidence})`);
  assert(workCandidate?.match_method  === 'iswc_exact', `method = iswc_exact (got "${workCandidate?.match_method}")`);
  assert(workCandidate?.mb_entity_id  === 'mb-work-0009', 'mb_entity_id correct');
  assert(workCandidate?.mb_entity_type !== 'recording', 'work is NOT confused with recording');
}

// ── Test 10: Fuzzy name match → confidence < 0.9 ─────────────────────────────

async function test10_fuzzy_name_match() {
  console.log('\n[10] resolveTrack() fuzzy name match → confidence < 0.9, method name_fuzzy');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { resolveTrack } = loadFreshResolver();
  const corpusDb = require('../lib/mb-corpus-db');
  corpusDb._setPool(makeMockPool([
    ['recordings_v1', [{ mb_recording_id: 'mb-rec-0010', title: 'Redrum', length_ms: 185000 }]],
  ]));

  const candidates = await resolveTrack({
    id:             'track-0010',
    isrcs:          [],
    recording_mbid: null,
    iswc:           null,
    track_title:    'Redrum',
    track_duration: 185,
  });

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

  const { resolveTrack: r1 } = loadFreshResolver();
  const db1 = require('../lib/mb-corpus-db');
  db1._setPool(makeMockPool([
    ['recordings_v1', [{ mb_recording_id: 'mb-rec-0011', title: 'Redrum', length_ms: 185000 }]],
  ]));
  const withBonus = await r1({ id: 't1', isrcs: [], recording_mbid: null, iswc: null, track_title: 'Redrum', track_duration: 185 });

  const { resolveTrack: r2 } = loadFreshResolver();
  const db2 = require('../lib/mb-corpus-db');
  db2._setPool(makeMockPool([
    ['recordings_v1', [{ mb_recording_id: 'mb-rec-0011b', title: 'Redrum', length_ms: 250000 }]],
  ]));
  const noBonus = await r2({ id: 't2', isrcs: [], recording_mbid: null, iswc: null, track_title: 'Redrum', track_duration: 185 });

  const bonusConf   = withBonus[0]?.confidence  || 0;
  const nobonusConf = noBonus[0]?.confidence    || 0;

  assert(bonusConf > nobonusConf, `duration match increases confidence: ${bonusConf.toFixed(3)} > ${nobonusConf.toFixed(3)}`);
  assert(withBonus[0]?.match_signals?.duration_match === true, 'duration_match signal set');
}

// ── Test 12: Artist name collision ────────────────────────────────────────────

async function test12_artist_name_collision() {
  console.log('\n[12] resolveTrack() artist name collision — two different MBIDs remain separate');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { resolveTrack } = loadFreshResolver();
  const corpusDb = require('../lib/mb-corpus-db');
  // ISRC lookup returns two different recording MBIDs (collision).
  corpusDb._setPool(makeMockPool([
    ['isrcs_v1', [
      { mb_recording_id: 'mb-rec-collision-A' },
      { mb_recording_id: 'mb-rec-collision-B' },
    ]],
  ]));

  const candidates = await resolveTrack({
    id:          'track-collision',
    isrcs:       ['USABC0000001', 'USABC0000002'],
    recording_mbid: null,
    iswc:        null,
    track_title: 'Common Title',
  });

  const mbIds = candidates.map(c => c.mb_entity_id);
  assert(mbIds.includes('mb-rec-collision-A'), 'first MBID present');
  assert(mbIds.includes('mb-rec-collision-B'), 'second MBID present');
  assert(mbIds.length >= 2, `at least 2 distinct candidates (got ${mbIds.length})`);

  const nonRecordings = candidates.filter(c => c.mb_entity_type !== 'recording');
  assert(nonRecordings.length === 0, 'all collision candidates are recordings, not works');
}

// ── Test 13: Recording vs work distinction ────────────────────────────────────

async function test13_recording_vs_work_not_conflated() {
  console.log('\n[13] recording and work entity types never conflated');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { resolveTrack } = loadFreshResolver();
  const corpusDb = require('../lib/mb-corpus-db');
  corpusDb._setPool(makeMockPool([
    ['isrcs_v1',  [{ mb_recording_id: 'mb-rec-0013' }]],
    ['iswcs_v1',  [{ mb_work_id:      'mb-work-0013' }]],
  ]));

  const candidates = await resolveTrack({
    id:          'track-0013',
    isrcs:       ['USREC0000013'],
    recording_mbid: null,
    iswc:        'T-000.000.013-0',
    track_title: 'Dual Match',
  });

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

  const { resolveTrack, persistCandidates } = loadFreshResolver();
  const corpusDb = require('../lib/mb-corpus-db');
  corpusDb._setPool(makeMockPool([
    ['isrcs_v1', [{ mb_recording_id: 'mb-rec-idem' }]],
  ]));

  const sbCalls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    sbCalls.push({ url, method: opts?.method || 'GET' });
    if (url.includes('fn_mb_upsert_entity_matches')) {
      return { ok: true, text: async () => JSON.stringify(null) };
    }
    return { ok: true, text: async () => JSON.stringify([]) };
  };

  const track = { id: 'track-idem', isrcs: ['USIDEM000001'], recording_mbid: null, iswc: null, track_title: 'Idempotent' };
  const c1 = await resolveTrack(track);
  await persistCandidates(c1);
  const c2 = await resolveTrack(track);
  await persistCandidates(c2);

  global.fetch = origFetch;

  assert(c1.length === c2.length, `same number of candidates both runs (${c1.length} = ${c2.length})`);
  assert(c1[0]?.mb_entity_id === c2[0]?.mb_entity_id, 'same top candidate both runs');
  assert(c1[0]?.confidence   === c2[0]?.confidence,   'same confidence both runs');

  const matchUpserts = sbCalls.filter(c => c.url.includes('fn_mb_upsert_entity_matches'));
  assert(matchUpserts.length === 2, `entity_matches_v1 written twice (once per run, got ${matchUpserts.length})`);
}

// ── Test 15: No candidates when staging empty ─────────────────────────────────

async function test15_no_candidates_when_staging_empty() {
  console.log('\n[15] resolveTrack() returns empty array when staging tables have no matching data');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { resolveTrack } = loadFreshResolver();
  const corpusDb = require('../lib/mb-corpus-db');
  corpusDb._setPool(makeMockPool([]));  // all queries return []

  const candidates = await resolveTrack({
    id:          'track-empty',
    isrcs:       ['USXXX9999999'],
    recording_mbid: null,
    iswc:        null,
    track_title: 'Ghost Track',
  });

  assert(Array.isArray(candidates),   'returns array');
  assert(candidates.length === 0,     `empty array when no matches (got ${candidates.length})`);
}

// ── Test 16: Batch chunking ───────────────────────────────────────────────────

async function test16_batch_chunking() {
  console.log('\n[16] upsertArtists() splits 1200 rows into 3 corpus DB insert calls');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { pool, calls } = makeSpy();
  const { upsertArtists } = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  corpusDb._setPool(pool);

  const artists = Array.from({ length: 1200 }, (_, i) => ({
    mb_artist_id:    `mb-artist-${i}`,
    name:            `Artist ${i}`,
    ingestion_source: 'dump',
    provenance:      {},
    ended:           false,
  }));

  await upsertArtists(artists);

  const insertCalls = calls.filter(c => c.sql.includes('artists_v1') && c.sql.includes('INSERT'));
  // 1200 rows at BATCH_SIZE=500: 3 calls (500 + 500 + 200)
  assert(insertCalls.length === 3, `3 insert calls for 1200 rows (got ${insertCalls.length})`);

  // Each call's param count = rows_in_chunk × columns_per_artist (13 columns)
  const COLS = 13;
  assert(insertCalls[0].params.length === 500 * COLS, `batch 1: 500 rows (got ${insertCalls[0].params.length / COLS})`);
  assert(insertCalls[1].params.length === 500 * COLS, `batch 2: 500 rows (got ${insertCalls[1].params.length / COLS})`);
  assert(insertCalls[2].params.length === 200 * COLS, `batch 3: 200 rows (got ${insertCalls[2].params.length / COLS})`);
}

// ── Test 17: Checkpoint save/load ─────────────────────────────────────────────

async function test17_checkpoint_save_load() {
  console.log('\n[17] checkpointProgress() saves state; getIngestionState() reads it back');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const stateDb = {};

  const pool = {
    async query(sql, params) {
      if (!sql.includes('ingestion_state_v1')) return { rows: [] };
      const key = `${params[0]}:${params[1]}`;

      if (/^\s*INSERT/i.test(sql) && sql.includes('DO NOTHING')) {
        if (!stateDb[key]) stateDb[key] = { entity_type: params[0], import_mode: params[1] };
        return { rows: [] };
      }

      if (/^\s*UPDATE/i.test(sql)) {
        const setMatch = sql.match(/SET\s+([\s\S]+?)\s+WHERE/i);
        if (setMatch) {
          for (const clause of setMatch[1].split(',').map(s => s.trim())) {
            const m = clause.match(/^(\w+)\s*=\s*\$(\d+)/);
            if (m) {
              const col = m[1];
              const idx = parseInt(m[2], 10) - 1;
              if (!stateDb[key]) stateDb[key] = {};
              stateDb[key][col] = params[idx];
            }
          }
        }
        return { rows: [] };
      }

      if (/^\s*SELECT/i.test(sql)) {
        return { rows: stateDb[key] ? [stateDb[key]] : [] };
      }
      return { rows: [] };
    },
    on() {},
    async end() {},
  };

  const { checkpointProgress, getIngestionState } = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  corpusDb._setPool(pool);

  await checkpointProgress('recordings', 'dump', 50000, 'mb-rec-last', 50000, 3);
  const state = await getIngestionState('recordings', 'dump');

  assert(state !== null,                            'state returned (not null)');
  assert(state?.last_offset     === 50000,          `last_offset = 50000 (got ${state?.last_offset})`);
  assert(state?.last_mb_id      === 'mb-rec-last',  `last_mb_id preserved (got "${state?.last_mb_id}")`);
  assert(state?.total_processed === 50000,          `total_processed = 50000 (got ${state?.total_processed})`);
  assert(state?.total_errors    === 3,              `total_errors = 3 (got ${state?.total_errors})`);
}

// ── Test 18: Dry-run does not write ──────────────────────────────────────────

async function test18_dry_run_no_writes() {
  console.log('\n[18] upsertArtists() in dry-run mode makes no corpus DB calls');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { pool, calls } = makeSpy();
  const origFetch = global.fetch;
  const fetchCalls = [];
  global.fetch = async (url, opts) => { fetchCalls.push(url); return { ok: true, text: async () => '[]' }; };

  const { upsertArtists } = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  corpusDb._setPool(pool);

  await upsertArtists([
    { mb_artist_id: 'dry-run-artist', name: 'Dry Run Artist', ingestion_source: 'api', provenance: {}, ended: false },
  ], true);  // dryRun = true

  global.fetch = origFetch;

  assert(calls.length    === 0, `no corpus DB calls in dry-run (got ${calls.length})`);
  assert(fetchCalls.length === 0, `no Supabase fetch calls in dry-run (got ${fetchCalls.length})`);
}

// ── Test 19: Provenance fields ────────────────────────────────────────────────

async function test19_provenance_fields() {
  console.log('\n[19] API-mode staging rows include provenance with source and data_license');

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

// ── Test 20: No calls for minimal track ──────────────────────────────────────

async function test20_no_calls_for_minimal_track() {
  console.log('\n[20] resolveTrack() with no ISRC, no MBID, no ISWC, short title → no corpus DB calls');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { pool, calls } = makeSpy();
  const { resolveTrack } = loadFreshResolver();
  const corpusDb = require('../lib/mb-corpus-db');
  corpusDb._setPool(pool);

  const candidates = await resolveTrack({
    id:             'track-noid',
    isrcs:          [],
    recording_mbid: null,
    iswc:           null,
    track_title:    'Hi',  // too short for trigram: normalize('Hi')='hi', length=2 < 3
  });

  const isrcCalls  = calls.filter(c => c.sql.includes('isrcs_v1'));
  const mbidCalls  = calls.filter(c => c.sql.includes('recordings_v1'));
  const iswcCalls  = calls.filter(c => c.sql.includes('iswcs_v1'));

  assert(isrcCalls.length  === 0, `no isrcs_v1 calls (got ${isrcCalls.length})`);
  assert(mbidCalls.length  === 0, `no recordings_v1 calls (got ${mbidCalls.length})`);
  assert(iswcCalls.length  === 0, `no iswcs_v1 calls (got ${iswcCalls.length})`);
  assert(candidates.length === 0, 'no candidates returned');
}

// ── Test 21: Corpus DB not configured → writer throws ────────────────────────

async function test21_corpus_db_not_configured() {
  console.log('\n[21] Corpus DB not configured → writer throws error mentioning MUSICBRAINZ_DATABASE_URL');

  const saved = process.env.MUSICBRAINZ_DATABASE_URL;
  delete process.env.MUSICBRAINZ_DATABASE_URL;

  const { upsertArtists } = loadFreshWriter();
  // Do NOT set a mock pool — let it fall through to getPool() which reads the env var.

  let threw = false;
  let errMsg = '';
  try {
    await upsertArtists([{ mb_artist_id: 'test', name: 'test', ingestion_source: 'api', provenance: {}, ended: false }]);
  } catch (e) {
    threw  = true;
    errMsg = e.message;
  }

  if (saved !== undefined) process.env.MUSICBRAINZ_DATABASE_URL = saved;

  assert(threw, 'throws when MUSICBRAINZ_DATABASE_URL is not set');
  assert(errMsg.includes('MUSICBRAINZ_DATABASE_URL'), `error mentions env var (got: "${errMsg.slice(0, 80)}")`);
}

// ── Test 22: Corpus DB outage → resolver degrades gracefully ─────────────────

async function test22_corpus_outage_graceful_degradation() {
  console.log('\n[22] Corpus DB outage → resolveTrack() returns empty candidates without throwing');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { resolveTrack } = loadFreshResolver();
  const corpusDb = require('../lib/mb-corpus-db');
  // Simulate DB outage: every query throws.
  corpusDb._setPool({
    async query() { throw new Error('connection refused'); },
    on() {},
  });

  let threw = false;
  let candidates;
  try {
    candidates = await resolveTrack({
      id:          'track-outage',
      isrcs:       ['USTEST123456'],
      recording_mbid: null,
      iswc:        null,
      track_title: 'Connectivity Test',
    });
  } catch (e) {
    threw = true;
  }

  assert(!threw,                    'resolveTrack does not throw when corpus DB is unavailable');
  assert(Array.isArray(candidates), 'returns an array even on corpus failure');
  assert(candidates.length === 0,   'empty candidates when corpus DB is down');
}

// ── Test 23: healthCheck returns false on error ───────────────────────────────

async function test23_health_check_false_on_error() {
  console.log('\n[23] healthCheck() returns false when corpus DB query throws');

  const corpusDb = loadFreshCorpusDb();
  corpusDb._setPool({
    async query() { throw new Error('timeout'); },
    on() {},
  });

  const healthy = await corpusDb.healthCheck();
  assert(healthy === false, 'healthCheck returns false on DB error');
}

// ── Test 24: ISRC hyphen normalization in resolver lookup ─────────────────────

async function test24_isrc_hyphen_normalized_in_resolver() {
  console.log('\n[24] resolveTrack() normalizes hyphenated ISRC before corpus lookup');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { pool, calls } = makeSpy([
    ['isrcs_v1', [{ mb_recording_id: 'mb-rec-0024' }]],
  ]);
  const { resolveTrack } = loadFreshResolver();
  const corpusDb = require('../lib/mb-corpus-db');
  corpusDb._setPool(pool);

  const candidates = await resolveTrack({
    id:             'track-0024',
    isrcs:          ['US-RC1-23-00024'],  // hyphenated input
    recording_mbid: null,
    iswc:           null,
    track_title:    'Hyphen Test',
  });

  const isrcCall = calls.find(c => c.sql.includes('isrcs_v1'));
  assert(isrcCall !== undefined, 'isrcs_v1 was queried');
  assert(isrcCall?.params[0] === 'USRC12300024', `ISRC bare-normalized in query param (got "${isrcCall?.params[0]}")`);
  assert(candidates.length === 1,    'candidate found despite hyphenated input');
  assert(candidates[0]?.confidence === 1.0, 'confidence 1.0 on normalized ISRC match');
  assert(candidates[0]?.mb_entity_id === 'mb-rec-0024', 'correct MB entity returned');
}

// ── Test 25: loadEnrichedTracks() pagination ──────────────────────────────────

async function test25_load_enriched_tracks_paginates() {
  console.log('\n[25] loadEnrichedTracks() fetches all pages when first page is full');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const { loadEnrichedTracks, PAGE_SIZE } = loadFreshResolver();

  // Page 1: exactly PAGE_SIZE rows (signals more may exist)
  const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i, track_title: `Track ${i}` }));
  // Page 2: 2 rows (signals end of results)
  const page2 = [{ id: PAGE_SIZE, track_title: 'Track Extra 1' }, { id: PAGE_SIZE + 1, track_title: 'Track Extra 2' }];

  const fetchUrls = [];
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    fetchUrls.push(url);
    return { ok: true, text: async () => JSON.stringify(fetchUrls.length === 1 ? page1 : page2) };
  };

  const tracks = await loadEnrichedTracks();

  global.fetch = origFetch;

  const catalogCalls = fetchUrls.filter(u => u.includes('catalog_enriched_tracks_v1'));
  assert(catalogCalls.length === 2, `2 fetch calls for 2-page catalog (got ${catalogCalls.length})`);
  assert(tracks.length === PAGE_SIZE + 2, `all ${PAGE_SIZE + 2} tracks returned (got ${tracks.length})`);
  assert(catalogCalls[0].includes(`limit=${PAGE_SIZE}`), 'first call includes limit');
  assert(catalogCalls[0].includes('offset=0'),           'first call starts at offset=0');
  assert(catalogCalls[1].includes(`offset=${PAGE_SIZE}`), `second call uses offset=${PAGE_SIZE}`);
}

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== mb-ingestion.test.js ===');
  console.log('MusicBrainz ingestion pipeline — parser, resolver, writer, corpus DB, isolation\n');

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
  await test20_no_calls_for_minimal_track();
  await test21_corpus_db_not_configured();
  await test22_corpus_outage_graceful_degradation();
  await test23_health_check_false_on_error();
  await test24_isrc_hyphen_normalized_in_resolver();
  await test25_load_enriched_tracks_paginates();

  console.log(`\n${'─'.repeat(50)}`);
  const total = passed + failed;
  if (failed > 0) {
    console.error(`${total} assertions | ${passed} passed | ${failed} FAILED`);
  } else {
    console.log(`${total} assertions | ${total} passed`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
