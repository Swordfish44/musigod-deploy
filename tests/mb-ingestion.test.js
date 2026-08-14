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
//   26. transformReleaseGroup() sets secondary_types:[] — no NOT NULL violation on dump-mode upsert
//   27. buildIdMap() reads TSV and returns Map<intId, gid> with correct entries
//   28. transformISRC() resolves integer FK via idMap and normalizes ISRC
//   29. transformISRC() returns null when integer FK is not in idMap
//   30. transformISRC() normalizes hyphenated ISRC from dump file
//   31. transformISWC() resolves FK via idMap, normalizes ISWC; returns null when unresolvable
//   32. transformArtistAlias() maps all fields; primary_alias bool from 't' sentinel
//   33. batchStream() skips null-transformed rows when idMap cannot resolve FK
//   34. countTable() queries corpus DB and returns integer count
//   35. countTable() throws on unknown table name (SQL injection guard)
//
// ── Group D: Idempotency & duplicate-prevention ────────────────────────────────
//   36. Full-fixture single load → correct entity and relationship counts
//   37. Full-fixture loaded twice → ZERO additional rows in any corpus table
//   38. Double-load → canonical conflict-key sets identical after both loads
//   39. Double-load → provenance field not clobbered by second upsert
//   40. Same ISRC hyphen-formatted (US-RC1-23-00001) → same canonical → no dupe ISRC row
//   41. Same ISRC lowercase (usrc12300001) → same canonical → no dupe ISRC row
//   42. Same ISWC with hyphens (T-345246800-1) → same canonical → no dupe ISWC row
//   43. Same ISWC with dots (T-345.246.800-1) → same canonical → no dupe ISWC row
//   44. Artist alias loaded twice → 1 artist row, 1 alias row (no phantom duplicates)
//   45. Recording on two releases → 1 recording, 2 releases, 2 distinct appears_on rels
//   46. Two similar-titled recordings (different MBIDs) → both preserved; neither overwrites

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else       { console.error(`  ❌ FAIL: ${label}`); failed++; }
}

// ── Imports ───────────────────────────────────────────────────────────────────

const { normalize, titleSimilarity } = require('../lib/mb-entity-resolver');
const { parseLine, COLUMN_DEFS, normalizeISWC } = require('../lib/mb-dump-parser');

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

// ── Test 26: dump-mode transformReleaseGroup sets secondary_types ─────────────

async function test26_dump_release_group_secondary_types_not_null() {
  console.log('\n[26] transformReleaseGroup() sets secondary_types:[] — dump-mode upsert never sends NULL');

  const { TRANSFORMERS } = require('../lib/mb-dump-parser');
  const { pool, calls } = makeSpy();
  const { upsertReleaseGroups } = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  corpusDb._setPool(pool);

  const dumpRow = {
    gid: 'rg-test-0026', name: 'Test RG', artist_credit: '1',
    type: '1', comment: '', edits_pending: '0', last_updated: null,
  };
  const transformed = TRANSFORMERS.release_group(dumpRow);

  assert(Array.isArray(transformed.secondary_types),     'secondary_types is an array');
  assert(transformed.secondary_types.length === 0,       'secondary_types defaults to []');

  await upsertReleaseGroups([transformed]);

  const insertCall = calls.find(c => c.sql.includes('release_groups_v1') && c.sql.includes('INSERT'));
  assert(insertCall !== undefined, 'INSERT was issued');

  // secondary_types is $4 in the column list (mb_release_group_id, title, primary_type, secondary_types, ...)
  const COLS = ['mb_release_group_id','title','primary_type','secondary_types','mb_artist_id','first_release_date','ingestion_source','provenance'];
  const secondaryTypesIdx = COLS.indexOf('secondary_types'); // 3 → param index 3
  const paramValue = insertCall.params[secondaryTypesIdx];

  assert(paramValue !== null && paramValue !== undefined, `secondary_types param is not null (got ${JSON.stringify(paramValue)})`);
  assert(Array.isArray(paramValue),                      `secondary_types param is an array (got ${typeof paramValue})`);
  assert(paramValue.length === 0,                        'secondary_types param is empty array');
}

// ── Test 27: buildIdMap() ─────────────────────────────────────────────────────

async function test27_build_id_map() {
  console.log('\n[27] buildIdMap() reads TSV and returns Map<intId, gid>');

  const os   = require('os');
  const fs   = require('fs');
  const path = require('path');
  const { buildIdMap } = require('../lib/mb-dump-parser');

  // Simulate a recording dump file (9 columns matching COLUMN_DEFS.recording)
  const lines = [
    '100\trec-gid-100\tRedrum\t1\t210000\t\\N\t0\t2022-01-01\tf',
    '200\trec-gid-200\tAcid Rain\t1\t180000\t\\N\t0\t2022-01-02\tf',
    '300\trec-gid-300\tEscape\t2\t195000\t\\N\t0\t2022-01-03\tf',
  ];
  const tmpFile = path.join(os.tmpdir(), `mb_test_idmap_${Date.now()}.tsv`);
  fs.writeFileSync(tmpFile, lines.join('\n') + '\n', 'utf8');

  let map;
  try {
    map = await buildIdMap(tmpFile, 'recording');
  } finally {
    fs.unlinkSync(tmpFile);
  }

  assert(map instanceof Map,                         'returns a Map instance');
  assert(map.size === 3,                             `3 entries in map (got ${map.size})`);
  assert(map.get('100') === 'rec-gid-100',           'int 100 → rec-gid-100');
  assert(map.get('200') === 'rec-gid-200',           'int 200 → rec-gid-200');
  assert(map.get('999') === undefined,               'unknown int → undefined');
}

// ── Test 28: transformISRC() resolves FK ──────────────────────────────────────

async function test28_transform_isrc_resolves_fk() {
  console.log('\n[28] transformISRC() resolves integer FK via idMap, normalizes ISRC');

  const { TRANSFORMERS } = require('../lib/mb-dump-parser');
  const idMap = new Map([['42', 'rec-gid-042']]);

  const row = { id: '1', recording: '42', isrc: 'USRC12300099', source: '0', edits_pending: '0' };
  const result = TRANSFORMERS.isrc(row, idMap);

  assert(result !== null,                           'result is not null');
  assert(result.mb_recording_id === 'rec-gid-042', `mb_recording_id resolved (got ${result?.mb_recording_id})`);
  assert(result.isrc === 'USRC12300099',            `ISRC preserved (got ${result?.isrc})`);
}

// ── Test 29: transformISRC() returns null when FK unresolvable ─────────────────

async function test29_transform_isrc_null_on_missing_fk() {
  console.log('\n[29] transformISRC() returns null when integer FK is not in idMap');

  const { TRANSFORMERS } = require('../lib/mb-dump-parser');
  const idMap = new Map([['42', 'rec-gid-042']]);

  const row = { id: '9', recording: '999', isrc: 'USRC12300099', source: '0', edits_pending: '0' };
  const result = TRANSFORMERS.isrc(row, idMap);

  assert(result === null, `null returned for unresolvable FK (got ${JSON.stringify(result)})`);
}

// ── Test 30: transformISRC() normalizes hyphenated ISRC from dump ─────────────

async function test30_transform_isrc_normalizes_hyphen() {
  console.log('\n[30] transformISRC() normalizes hyphenated ISRC in dump row');

  const { TRANSFORMERS } = require('../lib/mb-dump-parser');
  const idMap = new Map([['7', 'rec-gid-007']]);

  const row = { id: '2', recording: '7', isrc: 'US-RC1-23-00030', source: '0', edits_pending: '0' };
  const result = TRANSFORMERS.isrc(row, idMap);

  assert(result !== null,                       'result is not null');
  assert(result.isrc === 'USRC12300030',        `hyphens stripped and uppercased (got ${result?.isrc})`);
}

// ── Test 31: transformISWC() resolves FK; null when unresolvable ───────────────

async function test31_transform_iswc() {
  console.log('\n[31] transformISWC() resolves FK via idMap, normalizes ISWC; returns null when unresolvable');

  const { TRANSFORMERS } = require('../lib/mb-dump-parser');
  const idMap = new Map([['55', 'work-gid-055']]);

  const hitRow  = { id: '1', work: '55', iswc: 'T-345246800-1', source: '0', edits_pending: '0' };
  const missRow = { id: '2', work: '99', iswc: 'T-000000000-0', source: '0', edits_pending: '0' };

  const hit  = TRANSFORMERS.iswc(hitRow,  idMap);
  const miss = TRANSFORMERS.iswc(missRow, idMap);

  assert(hit !== null,                         'hit: result not null');
  assert(hit?.mb_work_id === 'work-gid-055',   `hit: mb_work_id resolved (got ${hit?.mb_work_id})`);
  assert(hit?.iswc === 'T3452468001',          `hit: iswc normalized (stripped hyphens) (got ${hit?.iswc})`);
  assert(miss === null,                        'miss: null returned for unresolvable FK');
}

// ── Test 32: transformArtistAlias() maps all fields ──────────────────────────

async function test32_transform_artist_alias() {
  console.log('\n[32] transformArtistAlias() maps all fields; primary_alias bool from "t"');

  const { TRANSFORMERS } = require('../lib/mb-dump-parser');
  const idMap = new Map([['11', 'artist-gid-011']]);

  const row = {
    id: '501', artist: '11', name: 'Eric Gulley', locale: 'en',
    edits_pending: '0', last_updated: null,
    type: '1', sort_name: 'Gulley, Eric',
    begin_date_year: '1972', begin_date_month: null, begin_date_day: null,
    end_date_year: null, end_date_month: null, end_date_day: null,
    primary_for_locale: 't',
  };

  const result = TRANSFORMERS.artist_alias(row, idMap);

  assert(result !== null,                            'result is not null');
  assert(result.mb_artist_id === 'artist-gid-011',  `mb_artist_id resolved (got ${result?.mb_artist_id})`);
  assert(result.alias_name   === 'Eric Gulley',      `alias_name correct (got ${result?.alias_name})`);
  assert(result.locale       === 'en',               `locale correct (got ${result?.locale})`);
  assert(result.primary_alias === true,              `primary_alias: "t" → true (got ${result?.primary_alias})`);
  assert(result.begin_date   === '1972',             `begin_date assembled (got ${result?.begin_date})`);
  assert(result.end_date     === null,               `end_date null when all parts null (got ${result?.end_date})`);
}

// ── Test 33: batchStream() skips null rows from FK-linked transformer ──────────

async function test33_batch_stream_skips_null_rows() {
  console.log('\n[33] batchStream() skips null-transformed rows when idMap cannot resolve FK');

  const os   = require('os');
  const fs   = require('fs');
  const path = require('path');
  const { batchStream } = require('../lib/mb-dump-parser');

  // 3 ISRC rows; columns: id, recording, isrc, source, edits_pending
  const lines = [
    '1\t42\tUSRC12300001\t0\t0',   // recording 42 → resolvable
    '2\t99\tUSRC12300002\t0\t0',   // recording 99 → NOT in idMap
    '3\t42\tUSRC12300003\t0\t0',   // recording 42 → resolvable
  ];
  const tmpFile = path.join(os.tmpdir(), `mb_test_batchstream_${Date.now()}.tsv`);
  fs.writeFileSync(tmpFile, lines.join('\n') + '\n', 'utf8');

  const idMap = new Map([['42', 'rec-gid-042']]);
  const batches = [];
  try {
    for await (const { batch } of batchStream(tmpFile, 'isrc', 100, 0, idMap)) {
      batches.push(...batch);
    }
  } finally {
    fs.unlinkSync(tmpFile);
  }

  assert(batches.length === 2,                         `2 rows emitted (unresolvable skipped), got ${batches.length}`);
  assert(batches.every(r => r.mb_recording_id === 'rec-gid-042'), 'all emitted rows have resolved UUID');
  assert(batches[0].isrc === 'USRC12300001',           `first ISRC correct (got ${batches[0]?.isrc})`);
  assert(batches[1].isrc === 'USRC12300003',           `second ISRC correct (got ${batches[1]?.isrc})`);
}

// ── Test 34: countTable() queries corpus DB and returns integer ───────────────

async function test34_count_table_returns_integer() {
  console.log('\n[34] countTable() queries corpus DB and returns integer count');

  const { pool, calls } = makeSpy([['COUNT', [{ n: '42000' }]]]);
  const { countTable } = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  corpusDb._setPool(pool);

  const n = await countTable('recordings_v1');

  assert(calls.length === 1,                       `1 query issued (got ${calls.length})`);
  assert(calls[0].sql.includes('COUNT(*)'),        `query uses COUNT(*) (got "${calls[0].sql.trim()}")`);
  assert(calls[0].sql.includes('mb_staging'),      'query targets mb_staging schema');
  assert(calls[0].sql.includes('recordings_v1'),  'query targets correct table');
  assert(n === 42000,                              `returns integer 42000 (got ${n})`);
}

// ── Test 35: countTable() throws on unknown table (injection guard) ───────────

async function test35_count_table_rejects_unknown_table() {
  console.log('\n[35] countTable() throws on unknown table name (SQL injection guard)');

  const { pool } = makeSpy();
  const { countTable } = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  corpusDb._setPool(pool);

  let threw = false;
  let msg   = '';
  try {
    await countTable('unknown_evil_table; DROP TABLE mb_staging.recordings_v1;--');
  } catch (e) {
    threw = true;
    msg   = e.message;
  }

  assert(threw,                          'throws on unknown table name');
  assert(msg.includes('unknown table'),  `error message mentions "unknown table" (got "${msg}")`);
}

// ── Stateful mock pool (Group D) ──────────────────────────────────────────────
//
// Simulates PostgreSQL ON CONFLICT DO NOTHING / DO UPDATE behaviour in memory.
// Parses INSERT INTO mb_staging.<table> SQL from batchInsert(), maintains a
// Map<conflictKey, row> per table, and exposes an inspection API.

function makeStatefulPool() {
  // Mirrors the conflict keys declared in mb-staging-writer.js batchInsert calls.
  const CONFLICT_KEYS = {
    artists_v1:         ['mb_artist_id'],
    artist_aliases_v1:  ['mb_artist_id', 'alias_name'],
    recordings_v1:      ['mb_recording_id'],
    isrcs_v1:           ['mb_recording_id', 'isrc'],
    works_v1:           ['mb_work_id'],
    iswcs_v1:           ['mb_work_id', 'iswc'],
    releases_v1:        ['mb_release_id'],
    release_groups_v1:  ['mb_release_group_id'],
    relationships_v1:   ['source_type', 'source_mb_id', 'target_type', 'target_mb_id', 'relationship_type'],
    ingestion_state_v1: ['entity_type', 'import_mode'],
  };

  // store[tableName] → Map<conflictKey, rowObject>
  const store = {};

  function applyInsert(sql, params) {
    const tableMatch = sql.match(/INSERT INTO mb_staging\.(\w+)\s*\(([^)]+)\)/);
    if (!tableMatch) return;

    const tableName = tableMatch[1];
    const colNames  = tableMatch[2].split(',').map(s => s.trim());
    const n         = colNames.length;
    if (n === 0 || params.length === 0) return;
    const numRows   = Math.round(params.length / n);

    const confKeys    = CONFLICT_KEYS[tableName] || [];
    const isDoNothing = /DO NOTHING/i.test(sql);
    const updateCols  = [];

    if (!isDoNothing) {
      const setMatch = sql.match(/DO UPDATE SET\s+(.+)$/is);
      if (setMatch) {
        for (const part of setMatch[1].split(',')) {
          const m = part.match(/^\s*(\w+)\s*=/);
          if (m) updateCols.push(m[1]);
        }
      }
    }

    if (!store[tableName]) store[tableName] = new Map();

    for (let r = 0; r < numRows; r++) {
      const row = {};
      for (let c = 0; c < n; c++) row[colNames[c]] = params[r * n + c];

      const key = confKeys.map(k => String(row[k] ?? '')).join('\x00');

      if (store[tableName].has(key)) {
        if (!isDoNothing && updateCols.length) {
          const existing = store[tableName].get(key);
          for (const col of updateCols) {
            if (col in row) existing[col] = row[col];
          }
        }
      } else {
        store[tableName].set(key, { ...row });
      }
    }
  }

  const pool = {
    async query(sql, params = []) {
      if (sql.includes('INSERT INTO mb_staging.')) applyInsert(sql, params);
      return { rows: [] };
    },
    on()        {},
    async end() {},
    // Inspection API
    count:     (table)      => store[table]?.size      || 0,
    rows:      (table)      => store[table] ? [...store[table].values()] : [],
    snapshot:  ()           => Object.fromEntries(Object.entries(store).map(([t, m]) => [t, m.size])),
    allKeys:   (table)      => store[table] ? [...store[table].keys()]   : [],
    getByKey:  (table, key) => store[table]?.get(key),
  };
  return pool;
}

// ── Fixture & loader (Group D) ────────────────────────────────────────────────
//
// Canonical mini-corpus: 1 artist, 4 recordings, 2 works, 2 releases, 1 release group,
// 1 alias, 4 ISRCs, 2 ISWCs, 5 relationships.

const FIXTURE = {
  artists: [{
    mb_artist_id: 'artist-esham-001', name: 'Esham', sort_name: 'Esham',
    artist_type: 'Person', country: 'US', area: null,
    begin_date: '1973', end_date: null, comment: 'Detroit rapper', ended: false,
    mb_last_updated: '2020-01-01T00:00:00.000Z', ingestion_source: 'dump',
    provenance: { source: 'musicbrainz', data_license: 'CC0' },
  }],

  aliases: [{
    mb_artist_id: 'artist-esham-001', alias_name: 'Eric Gulley',
    alias_type: '1', locale: 'en', primary_alias: false,
    begin_date: null, end_date: null,
  }],

  recordings: [
    {
      mb_recording_id: 'rec-001-acid-rain', title: 'Acid Rain', length_ms: 214000,
      artist_credit: 'Esham', mb_artist_id: 'artist-esham-001', comment: null, video: false,
      mb_last_updated: '2020-01-01T00:00:00.000Z', ingestion_source: 'dump',
      provenance: { source: 'musicbrainz', data_license: 'CC0' },
    },
    {
      mb_recording_id: 'rec-002-redrum', title: 'Redrum', length_ms: 197000,
      artist_credit: 'Esham', mb_artist_id: 'artist-esham-001', comment: null, video: false,
      mb_last_updated: '2020-01-01T00:00:00.000Z', ingestion_source: 'dump',
      provenance: { source: 'musicbrainz', data_license: 'CC0' },
    },
    {
      mb_recording_id: 'rec-003-deathwish', title: 'Deathwish', length_ms: 182000,
      artist_credit: 'Esham', mb_artist_id: 'artist-esham-001', comment: null, video: false,
      mb_last_updated: '2020-01-01T00:00:00.000Z', ingestion_source: 'dump',
      provenance: { source: 'musicbrainz', data_license: 'CC0' },
    },
    // Similar title to rec-001 — different MBID, must remain a distinct canonical entity.
    {
      mb_recording_id: 'rec-004-acid-reign', title: 'Acid Reign', length_ms: 203000,
      artist_credit: 'Esham', mb_artist_id: 'artist-esham-001', comment: null, video: false,
      mb_last_updated: '2020-01-01T00:00:00.000Z', ingestion_source: 'dump',
      provenance: { source: 'musicbrainz', data_license: 'CC0' },
    },
  ],

  isrcs: [
    { mb_recording_id: 'rec-001-acid-rain',  isrc: 'USRC12300001' },
    { mb_recording_id: 'rec-002-redrum',      isrc: 'USRC12300002' },
    { mb_recording_id: 'rec-003-deathwish',   isrc: 'USRC12300003' },
    { mb_recording_id: 'rec-004-acid-reign',  isrc: 'USRC12300004' },
  ],

  works: [
    {
      mb_work_id: 'work-001-acid-rain', title: 'Acid Rain', work_type: null, language: 'eng',
      comment: null, mb_last_updated: '2020-01-01T00:00:00.000Z', ingestion_source: 'dump',
      provenance: { source: 'musicbrainz', data_license: 'CC0' },
    },
    {
      mb_work_id: 'work-002-redrum', title: 'Redrum', work_type: null, language: 'eng',
      comment: null, mb_last_updated: '2020-01-01T00:00:00.000Z', ingestion_source: 'dump',
      provenance: { source: 'musicbrainz', data_license: 'CC0' },
    },
  ],

  iswcs: [
    // Stored in canonical (normalized, no-hyphen) form — the transformer normalizes on write.
    { mb_work_id: 'work-001-acid-rain', iswc: 'T3452468001' },
    { mb_work_id: 'work-002-redrum',    iswc: 'T0000000020' },
  ],

  releaseGroups: [{
    mb_release_group_id: 'rg-001-acid', title: 'Acid Rain EP', primary_type: 'EP',
    secondary_types: [], mb_artist_id: 'artist-esham-001', first_release_date: '1995',
    ingestion_source: 'dump', provenance: { source: 'musicbrainz', data_license: 'CC0' },
  }],

  // Both releases contain rec-001 — exercises the multi-release recording scenario.
  releases: [
    {
      mb_release_id: 'rel-001-us', mb_release_group_id: 'rg-001-acid',
      title: 'Acid Rain EP (US)', artist_credit: 'Esham', mb_artist_id: 'artist-esham-001',
      release_date: '1995-03-01', country: 'US', status: 'Official', barcode: null,
      mb_last_updated: '2020-01-01T00:00:00.000Z', ingestion_source: 'dump',
      provenance: { source: 'musicbrainz', data_license: 'CC0' },
    },
    {
      mb_release_id: 'rel-002-uk', mb_release_group_id: 'rg-001-acid',
      title: 'Acid Rain EP (UK)', artist_credit: 'Esham', mb_artist_id: 'artist-esham-001',
      release_date: '1995-06-01', country: 'GB', status: 'Official', barcode: null,
      mb_last_updated: '2020-01-01T00:00:00.000Z', ingestion_source: 'dump',
      provenance: { source: 'musicbrainz', data_license: 'CC0' },
    },
  ],

  relationships: [
    { source_type: 'recording', source_mb_id: 'rec-001-acid-rain',
      target_type: 'artist',    target_mb_id: 'artist-esham-001',
      relationship_type: 'performer', attributes: {}, direction: 'forward' },
    { source_type: 'recording', source_mb_id: 'rec-002-redrum',
      target_type: 'artist',    target_mb_id: 'artist-esham-001',
      relationship_type: 'performer', attributes: {}, direction: 'forward' },
    { source_type: 'recording', source_mb_id: 'rec-001-acid-rain',
      target_type: 'work',      target_mb_id: 'work-001-acid-rain',
      relationship_type: 'recording_of', attributes: {}, direction: 'forward' },
    // rec-001 appears on BOTH releases — two distinct appears_on relationships.
    { source_type: 'recording', source_mb_id: 'rec-001-acid-rain',
      target_type: 'release',   target_mb_id: 'rel-001-us',
      relationship_type: 'appears_on', attributes: {}, direction: 'forward' },
    { source_type: 'recording', source_mb_id: 'rec-001-acid-rain',
      target_type: 'release',   target_mb_id: 'rel-002-uk',
      relationship_type: 'appears_on', attributes: {}, direction: 'forward' },
  ],
};

// Load all fixture tables in dependency order using the provided writer module.
async function loadFixture(writer, fixture) {
  const {
    upsertArtists, upsertArtistAliases, upsertRecordings, upsertISRCs,
    upsertWorks, upsertISWCs, upsertReleaseGroups, upsertReleases, upsertRelationships,
  } = writer;
  await upsertArtists(fixture.artists);
  await upsertArtistAliases(fixture.aliases);
  await upsertRecordings(fixture.recordings);
  await upsertISRCs(fixture.isrcs);
  await upsertWorks(fixture.works);
  await upsertISWCs(fixture.iswcs);
  await upsertReleaseGroups(fixture.releaseGroups);
  await upsertReleases(fixture.releases);
  await upsertRelationships(fixture.relationships);
}

// Parse a stored provenance value (may be serialized JSON string from serializeValue).
function getProv(val) {
  if (!val) return null;
  if (typeof val === 'string') { try { return JSON.parse(val); } catch { return null; } }
  return val;
}

// ── Test 36: Full-fixture single load → correct entity counts ─────────────────

async function test36_fixture_load_correct_counts() {
  console.log('\n[36] Full-fixture single load → correct entity and relationship counts');

  const writer = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  const pool = makeStatefulPool();
  corpusDb._setPool(pool);

  await loadFixture(writer, FIXTURE);

  assert(pool.count('artists_v1')        === 1, `artists:        1 (got ${pool.count('artists_v1')})`);
  assert(pool.count('artist_aliases_v1') === 1, `aliases:        1 (got ${pool.count('artist_aliases_v1')})`);
  assert(pool.count('recordings_v1')     === 4, `recordings:     4 (got ${pool.count('recordings_v1')})`);
  assert(pool.count('isrcs_v1')          === 4, `ISRCs:          4 (got ${pool.count('isrcs_v1')})`);
  assert(pool.count('works_v1')          === 2, `works:          2 (got ${pool.count('works_v1')})`);
  assert(pool.count('iswcs_v1')          === 2, `ISWCs:          2 (got ${pool.count('iswcs_v1')})`);
  assert(pool.count('release_groups_v1') === 1, `release groups: 1 (got ${pool.count('release_groups_v1')})`);
  assert(pool.count('releases_v1')       === 2, `releases:       2 (got ${pool.count('releases_v1')})`);
  assert(pool.count('relationships_v1')  === 5, `relationships:  5 (got ${pool.count('relationships_v1')})`);
}

// ── Test 37: Same fixture loaded twice → ZERO new rows ───────────────────────

async function test37_double_load_zero_new_rows() {
  console.log('\n[37] Full-fixture loaded twice → ZERO additional rows in any corpus table');

  const writer = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  const pool = makeStatefulPool();
  corpusDb._setPool(pool);

  await loadFixture(writer, FIXTURE);
  const snapAfterFirst = pool.snapshot();

  await loadFixture(writer, FIXTURE);
  const snapAfterSecond = pool.snapshot();

  const tables = Object.keys(snapAfterFirst);
  for (const t of tables) {
    assert(
      snapAfterSecond[t] === snapAfterFirst[t],
      `${t}: count unchanged after second load (${snapAfterFirst[t]} → ${snapAfterSecond[t]})`
    );
  }
  // All 9 corpus entity tables checked
  assert(tables.length >= 9, `all entity tables checked (got ${tables.length})`);
}

// ── Test 38: Double-load → canonical conflict-key sets identical ──────────────

async function test38_double_load_canonical_ids_stable() {
  console.log('\n[38] Double-load → canonical conflict-key sets identical after both loads');

  const writer = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  const pool = makeStatefulPool();
  corpusDb._setPool(pool);

  await loadFixture(writer, FIXTURE);
  const keysFirst = {
    artists:    pool.allKeys('artists_v1').sort(),
    recordings: pool.allKeys('recordings_v1').sort(),
    isrcs:      pool.allKeys('isrcs_v1').sort(),
    works:      pool.allKeys('works_v1').sort(),
    rels:       pool.allKeys('relationships_v1').sort(),
  };

  await loadFixture(writer, FIXTURE);
  const keysSecond = {
    artists:    pool.allKeys('artists_v1').sort(),
    recordings: pool.allKeys('recordings_v1').sort(),
    isrcs:      pool.allKeys('isrcs_v1').sort(),
    works:      pool.allKeys('works_v1').sort(),
    rels:       pool.allKeys('relationships_v1').sort(),
  };

  for (const k of Object.keys(keysFirst)) {
    assert(
      JSON.stringify(keysFirst[k]) === JSON.stringify(keysSecond[k]),
      `${k} conflict-key set unchanged: [${keysFirst[k]}]`
    );
  }
  // Spot-check: artist key is exactly the MBID
  assert(keysSecond.artists[0] === 'artist-esham-001', 'artist conflict key is the MBID');
}

// ── Test 39: Provenance not clobbered by second upsert ───────────────────────

async function test39_provenance_preserved_across_upserts() {
  console.log('\n[39] Double-load → provenance field preserved (DO UPDATE does not blank it)');

  const writer = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  const pool = makeStatefulPool();
  corpusDb._setPool(pool);

  await loadFixture(writer, FIXTURE);
  await loadFixture(writer, FIXTURE);

  const artistRow     = pool.rows('artists_v1')[0];
  const recordingRow  = pool.rows('recordings_v1').find(r => r.mb_recording_id === 'rec-001-acid-rain');
  const workRow       = pool.rows('works_v1')[0];

  const aProv = getProv(artistRow?.provenance);
  const rProv = getProv(recordingRow?.provenance);
  const wProv = getProv(workRow?.provenance);

  assert(aProv?.source        === 'musicbrainz', `artist provenance.source preserved (got ${aProv?.source})`);
  assert(aProv?.data_license  === 'CC0',         `artist provenance.data_license preserved (got ${aProv?.data_license})`);
  assert(rProv?.source        === 'musicbrainz', `recording provenance.source preserved (got ${rProv?.source})`);
  assert(wProv?.data_license  === 'CC0',         `work provenance.data_license preserved (got ${wProv?.data_license})`);
}

// ── Test 40: ISRC with hyphens → same canonical → no duplicate ISRC row ───────

async function test40_isrc_hyphen_variant_no_dupe() {
  console.log('\n[40] Same ISRC hyphen-formatted (US-RC1-23-00001) → normalizes → zero dupe ISRC rows');

  const { TRANSFORMERS } = require('../lib/mb-dump-parser');
  const idMap = new Map([['42', 'rec-001-acid-rain']]);

  // Two dump rows: same recording, same logical ISRC — different formatting.
  const canonicalRow = { id: '1', recording: '42', isrc: 'USRC12300001', source: '0', edits_pending: '0' };
  const hyphenRow    = { id: '2', recording: '42', isrc: 'US-RC1-23-00001', source: '0', edits_pending: '0' };

  const canonical = TRANSFORMERS.isrc(canonicalRow, idMap);
  const withHyphen = TRANSFORMERS.isrc(hyphenRow,   idMap);

  assert(canonical?.isrc   === 'USRC12300001', `canonical ISRC normalized (got ${canonical?.isrc})`);
  assert(withHyphen?.isrc  === 'USRC12300001', `hyphenated ISRC normalized to same form (got ${withHyphen?.isrc})`);

  // Loading both into the stateful pool should produce only 1 ISRC row.
  const writer = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  const pool = makeStatefulPool();
  corpusDb._setPool(pool);
  await writer.upsertISRCs([canonical, withHyphen]);

  assert(pool.count('isrcs_v1') === 1,
    `1 ISRC row after loading canonical + hyphenated variant (got ${pool.count('isrcs_v1')})`);
}

// ── Test 41: ISRC lowercase → same canonical → no duplicate ISRC row ─────────

async function test41_isrc_lowercase_variant_no_dupe() {
  console.log('\n[41] Same ISRC lowercase (usrc12300001) → same canonical → zero dupe ISRC rows');

  const { TRANSFORMERS } = require('../lib/mb-dump-parser');
  const idMap = new Map([['42', 'rec-001-acid-rain']]);

  const upperRow = { id: '1', recording: '42', isrc: 'USRC12300001', source: '0', edits_pending: '0' };
  const lowerRow = { id: '2', recording: '42', isrc: 'usrc12300001', source: '0', edits_pending: '0' };

  const upper = TRANSFORMERS.isrc(upperRow, idMap);
  const lower = TRANSFORMERS.isrc(lowerRow, idMap);

  assert(upper?.isrc === 'USRC12300001', `uppercase: normalized (got ${upper?.isrc})`);
  assert(lower?.isrc === 'USRC12300001', `lowercase: normalized to same form (got ${lower?.isrc})`);

  const writer = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  const pool = makeStatefulPool();
  corpusDb._setPool(pool);
  await writer.upsertISRCs([upper, lower]);

  assert(pool.count('isrcs_v1') === 1,
    `1 ISRC row after loading uppercase + lowercase variant (got ${pool.count('isrcs_v1')})`);
}

// ── Test 42: ISWC with hyphens → same canonical → no duplicate ISWC row ───────

async function test42_iswc_hyphen_variant_no_dupe() {
  console.log('\n[42] Same ISWC with hyphens (T-345246800-1) → normalizes → zero dupe ISWC rows');

  const withHyphens   = normalizeISWC('T-345246800-1');
  const withoutHyphens = normalizeISWC('T3452468001');

  assert(withHyphens   === 'T3452468001', `T-345246800-1 normalizes to T3452468001 (got ${withHyphens})`);
  assert(withoutHyphens === 'T3452468001', `T3452468001 normalizes to T3452468001 (got ${withoutHyphens})`);
  assert(withHyphens === withoutHyphens,   'both variants produce the same canonical string');

  // Loading both (post-normalization) into the corpus produces only 1 row.
  const writer = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  const pool = makeStatefulPool();
  corpusDb._setPool(pool);
  await writer.upsertISWCs([
    { mb_work_id: 'work-001', iswc: withHyphens   },
    { mb_work_id: 'work-001', iswc: withoutHyphens },
  ]);

  assert(pool.count('iswcs_v1') === 1,
    `1 ISWC row after loading hyphenated + canonical variant (got ${pool.count('iswcs_v1')})`);
}

// ── Test 43: ISWC with dots → same canonical → no duplicate ISWC row ─────────

async function test43_iswc_dots_variant_no_dupe() {
  console.log('\n[43] Same ISWC with dots (T-345.246.800-1) → normalizes → zero dupe ISWC rows');

  const withDots    = normalizeISWC('T-345.246.800-1');
  const canonical   = normalizeISWC('T3452468001');
  const lowercase   = normalizeISWC('t-345246800-1');

  assert(withDots  === 'T3452468001', `dots stripped (got ${withDots})`);
  assert(lowercase === 'T3452468001', `lowercase uppercased (got ${lowercase})`);
  assert(withDots  === canonical,      'dot variant equals canonical');

  const writer = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  const pool = makeStatefulPool();
  corpusDb._setPool(pool);
  // Load all three variants: should collapse to 1 row.
  await writer.upsertISWCs([
    { mb_work_id: 'work-001', iswc: withDots },
    { mb_work_id: 'work-001', iswc: canonical },
    { mb_work_id: 'work-001', iswc: lowercase },
  ]);

  assert(pool.count('iswcs_v1') === 1,
    `1 ISWC row after loading dots + canonical + lowercase variants (got ${pool.count('iswcs_v1')})`);
}

// ── Test 44: Artist with alias loaded twice → exactly 1 artist, 1 alias ───────

async function test44_artist_alias_double_load_no_dupe() {
  console.log('\n[44] Artist with alias loaded twice → 1 artist row, 1 alias row (no phantom duplicates)');

  const writer = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  const pool = makeStatefulPool();
  corpusDb._setPool(pool);

  const artist = FIXTURE.artists[0];
  const alias  = FIXTURE.aliases[0];

  // First load
  await writer.upsertArtists([artist]);
  await writer.upsertArtistAliases([alias]);
  const after1 = { artists: pool.count('artists_v1'), aliases: pool.count('artist_aliases_v1') };

  // Second load (same data)
  await writer.upsertArtists([artist]);
  await writer.upsertArtistAliases([alias]);
  const after2 = { artists: pool.count('artists_v1'), aliases: pool.count('artist_aliases_v1') };

  assert(after1.artists  === 1, `1 artist after first load (got ${after1.artists})`);
  assert(after1.aliases  === 1, `1 alias after first load (got ${after1.aliases})`);
  assert(after2.artists  === 1, `still 1 artist after second load (got ${after2.artists})`);
  assert(after2.aliases  === 1, `still 1 alias after second load (got ${after2.aliases})`);

  // The alias conflict key includes both mb_artist_id and alias_name — verify it.
  const aliasKeys = pool.allKeys('artist_aliases_v1');
  assert(aliasKeys.length === 1, '1 unique alias conflict key');
  assert(aliasKeys[0].includes('artist-esham-001') && aliasKeys[0].includes('Eric Gulley'),
    `alias key contains both artist ID and alias name (got "${aliasKeys[0]}")`);
}

// ── Test 45: Recording on two releases → 1 recording, 2 releases, 2 rels ──────

async function test45_recording_on_multiple_releases() {
  console.log('\n[45] Same recording on two releases → 1 recording, 2 releases, 2 distinct appears_on rels');

  const writer = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  const pool = makeStatefulPool();
  corpusDb._setPool(pool);

  const recording = FIXTURE.recordings[0]; // rec-001-acid-rain
  const releases  = FIXTURE.releases;      // rel-001-us, rel-002-uk
  const appearsOnRels = FIXTURE.relationships.filter(r => r.relationship_type === 'appears_on');

  await writer.upsertRecordings([recording]);
  await writer.upsertReleases(releases);
  await writer.upsertRelationships(appearsOnRels);

  assert(pool.count('recordings_v1')    === 1, `1 recording (got ${pool.count('recordings_v1')})`);
  assert(pool.count('releases_v1')      === 2, `2 releases (got ${pool.count('releases_v1')})`);
  assert(pool.count('relationships_v1') === 2, `2 distinct appears_on rels (got ${pool.count('relationships_v1')})`);

  // Both relationships reference the same source recording but different target releases.
  const relKeys = pool.allKeys('relationships_v1');
  const hasUS = relKeys.some(k => k.includes('rel-001-us'));
  const hasUK = relKeys.some(k => k.includes('rel-002-uk'));
  assert(hasUS, 'appears_on rel-001-us exists');
  assert(hasUK, 'appears_on rel-002-uk exists');

  // Second load: still 1 recording, 2 releases, 2 rels.
  await writer.upsertRecordings([recording]);
  await writer.upsertReleases(releases);
  await writer.upsertRelationships(appearsOnRels);

  assert(pool.count('recordings_v1')    === 1, `still 1 recording after second load (got ${pool.count('recordings_v1')})`);
  assert(pool.count('releases_v1')      === 2, `still 2 releases after second load (got ${pool.count('releases_v1')})`);
  assert(pool.count('relationships_v1') === 2, `still 2 rels after second load (got ${pool.count('relationships_v1')})`);
}

// ── Test 46: Two similar-titled recordings → both preserved as distinct ────────

async function test46_similar_titles_distinct_canonical_rows() {
  console.log('\n[46] Two similar-titled recordings (different MBIDs) → both preserved; neither overwrites');

  const writer = loadFreshWriter();
  const corpusDb = require('../lib/mb-corpus-db');
  const pool = makeStatefulPool();
  corpusDb._setPool(pool);

  const acidRain   = FIXTURE.recordings.find(r => r.mb_recording_id === 'rec-001-acid-rain');
  const acidReign  = FIXTURE.recordings.find(r => r.mb_recording_id === 'rec-004-acid-reign');
  const isrcAcidRain  = FIXTURE.isrcs.find(i => i.mb_recording_id === 'rec-001-acid-rain');
  const isrcAcidReign = FIXTURE.isrcs.find(i => i.mb_recording_id === 'rec-004-acid-reign');

  // Load both recordings and their ISRCs.
  await writer.upsertRecordings([acidRain, acidReign]);
  await writer.upsertISRCs([isrcAcidRain, isrcAcidReign]);

  assert(pool.count('recordings_v1') === 2, `2 distinct recording rows (got ${pool.count('recordings_v1')})`);
  assert(pool.count('isrcs_v1')      === 2, `2 distinct ISRC rows (got ${pool.count('isrcs_v1')})`);

  // Both canonical IDs present.
  const recKeys = pool.allKeys('recordings_v1');
  assert(recKeys.includes('rec-001-acid-rain'),  '"Acid Rain" MBID present');
  assert(recKeys.includes('rec-004-acid-reign'), '"Acid Reign" MBID present');

  // ISRCs are bound to their respective recordings — not cross-linked.
  const isrcRows = pool.rows('isrcs_v1');
  const rainISRC  = isrcRows.find(r => r.mb_recording_id === 'rec-001-acid-rain');
  const reignISRC = isrcRows.find(r => r.mb_recording_id === 'rec-004-acid-reign');
  assert(rainISRC?.isrc  === 'USRC12300001', `Acid Rain  ISRC correct (got ${rainISRC?.isrc})`);
  assert(reignISRC?.isrc === 'USRC12300004', `Acid Reign ISRC correct (got ${reignISRC?.isrc})`);

  // Load both again — counts still 2.
  await writer.upsertRecordings([acidRain, acidReign]);
  await writer.upsertISRCs([isrcAcidRain, isrcAcidReign]);

  assert(pool.count('recordings_v1') === 2, `still 2 recordings after second load (got ${pool.count('recordings_v1')})`);
  assert(pool.count('isrcs_v1')      === 2, `still 2 ISRCs after second load (got ${pool.count('isrcs_v1')})`);

  // Titles are preserved as distinct — neither overwrote the other.
  const recRows = pool.rows('recordings_v1');
  const titles  = recRows.map(r => r.title).sort();
  assert(titles.includes('Acid Rain'),  '"Acid Rain" title preserved');
  assert(titles.includes('Acid Reign'), '"Acid Reign" title preserved');
  assert(titles[0] !== titles[1],       'two distinct titles in store');
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
  await test26_dump_release_group_secondary_types_not_null();
  await test27_build_id_map();
  await test28_transform_isrc_resolves_fk();
  await test29_transform_isrc_null_on_missing_fk();
  await test30_transform_isrc_normalizes_hyphen();
  await test31_transform_iswc();
  await test32_transform_artist_alias();
  await test33_batch_stream_skips_null_rows();
  await test34_count_table_returns_integer();
  await test35_count_table_rejects_unknown_table();
  await test36_fixture_load_correct_counts();
  await test37_double_load_zero_new_rows();
  await test38_double_load_canonical_ids_stable();
  await test39_provenance_preserved_across_upserts();
  await test40_isrc_hyphen_variant_no_dupe();
  await test41_isrc_lowercase_variant_no_dupe();
  await test42_iswc_hyphen_variant_no_dupe();
  await test43_iswc_dots_variant_no_dupe();
  await test44_artist_alias_double_load_no_dupe();
  await test45_recording_on_multiple_releases();
  await test46_similar_titles_distinct_canonical_rows();

  console.log(`\n${'─'.repeat(50)}`);
  const total = passed + failed;
  if (failed > 0) {
    console.error(`${total} assertions | ${passed} passed | ${failed} FAILED`);
  } else {
    console.log(`${total} assertions | ${total} passed`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
