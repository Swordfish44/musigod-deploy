// tests/graph-sync-identity.test.js
//
// Unit tests for the Finding 1 + 2 fix in api/graph-sync.js:
//   Finding 2: graph node external_id / external_id_ns MUST NOT be overwritten
//              when an ISRC is discovered during enrichment.
//   Finding 1: recording MBID written to works_recordings_v1.musicbrainz_recording_id,
//              bridging catalog_enriched_tracks_v1.recording_mbid to the formal graph.
//
// Pure unit tests — no network, no Supabase connection needed.
// Run: node tests/graph-sync-identity.test.js

'use strict';

let passed = 0; let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else           { console.error(`  ❌ FAIL: ${label}`); failed++; }
}

// ─── Shared test fixtures ─────────────────────────────────────────────────────

const WORK_NODE_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';
const REC_NODE_UUID  = 'bbbbbbbb-0000-0000-0000-000000000002';

function makeMockFetch(calls) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body   = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });

    if (method === 'GET' && url.includes('graph_nodes_v1')) {
      // Recording node via ISRC namespace (new multi-strategy: ISRC ns tried first)
      if (url.includes('USABC1234567') && url.includes('external_id_ns=eq.isrc')) {
        return ok([{ id: REC_NODE_UUID }]);
      }
      // Recording node via rec_{catalogId} fallback in musigod_catalog
      if (url.includes('rec_my-catalog-id') && url.includes('musigod_catalog')) {
        return ok([{ id: REC_NODE_UUID }]);
      }
      // Work node via catalog_id in musigod_catalog
      if (url.includes('my-catalog-id') && url.includes('musigod_catalog')) {
        return ok([{ id: WORK_NODE_UUID }]);
      }
      // All other lookups (iswc namespace, unknown fingerprints) → not found
      return ok([]);
    }
    // Any PATCH to works_compositions_v1
    if (method === 'PATCH' && url.includes('works_compositions_v1')) return ok(null);
    // Any PATCH to works_recordings_v1
    if (method === 'PATCH' && url.includes('works_recordings_v1'))   return ok(null);
    // Any PATCH to graph_nodes_v1 (should NOT be called after fix)
    if (method === 'PATCH' && url.includes('graph_nodes_v1'))        return ok(null);
    // Unmatched non-GET → fail loudly so tests catch unexpected calls
    return { ok: false, status: 404, text: async () => `{"error":"unexpected mock call: ${method} ${url}"}` };
  };
}

function ok(data) {
  return { ok: true, status: data === null ? 204 : 200, text: async () => data === null ? '' : JSON.stringify(data) };
}

function loadFreshGraphSync() {
  const mod = require.resolve('../api/graph-sync');
  delete require.cache[mod];
  return require('../api/graph-sync');
}

function baseTrack(overrides = {}) {
  return { catalog_id: 'my-catalog-id', title: 'Test Track', ...overrides };
}

// ─── Test 1: PATCH to graph_nodes_v1 never called (Finding 2) ────────────────

async function test_no_node_external_id_overwrite() {
  console.log('\n[1] Finding 2 — PATCH graph_nodes_v1 NOT called when ISRC discovered');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [baseTrack({ isrc: 'USABC1234567' })]);

  const nodePatches = calls.filter(c =>
    c.method === 'PATCH' && c.url.includes('graph_nodes_v1')
  );
  assert(nodePatches.length === 0,
    `PATCH to graph_nodes_v1 not called (got ${nodePatches.length})`);
  nodePatches.forEach(c =>
    console.error(`    → unexpectedly called: ${c.url} body=${JSON.stringify(c.body)}`));
}

// ─── Test 2: ISRC written to works_recordings_v1 (regression guard) ──────────

async function test_isrc_written_to_recordings_table() {
  console.log('\n[2] Finding 2 — isrc still written to works_recordings_v1.isrc');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [baseTrack({ isrc: 'usabc1234567' })]);

  const recPatch = calls.find(c =>
    c.method === 'PATCH' && c.url.includes('works_recordings_v1'));
  assert(!!recPatch, 'PATCH to works_recordings_v1 was made');
  assert(recPatch?.body?.isrc === 'USABC1234567',
    `isrc uppercased correctly (got "${recPatch?.body?.isrc}")`);
}

// ─── Test 3: snake_case recording_mbid bridges to musicbrainz_recording_id ───

async function test_snake_case_recording_mbid_bridges() {
  console.log('\n[3] Finding 1 — snake_case recording_mbid → musicbrainz_recording_id');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  const mbid = 'cccccccc-dddd-eeee-ffff-000000000003';
  await syncEnrichmentToGraph('test-artist', [
    baseTrack({ isrc: 'USABC1234567', recording_mbid: mbid }),
  ]);

  const recPatch = calls.find(c =>
    c.method === 'PATCH' && c.url.includes('works_recordings_v1'));
  assert(recPatch?.body?.musicbrainz_recording_id === mbid,
    `musicbrainz_recording_id set from snake_case field (got "${recPatch?.body?.musicbrainz_recording_id}")`);
  assert(recPatch?.body?.isrc === 'USABC1234567',
    'isrc also present in same PATCH');
}

// ─── Test 4: camelCase recordingMBID (enrichArtistCatalog shape) also bridges

async function test_camelcase_recordingMBID_bridges() {
  console.log('\n[4] Finding 1 — camelCase recordingMBID (enrichArtistCatalog) → musicbrainz_recording_id');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  const mbid = 'cccccccc-dddd-eeee-ffff-000000000004';
  await syncEnrichmentToGraph('test-artist', [
    baseTrack({ isrc: 'USABC1234567', recordingMBID: mbid }),
  ]);

  const recPatch = calls.find(c =>
    c.method === 'PATCH' && c.url.includes('works_recordings_v1'));
  assert(recPatch?.body?.musicbrainz_recording_id === mbid,
    `musicbrainz_recording_id set from camelCase field (got "${recPatch?.body?.musicbrainz_recording_id}")`);
}

// ─── Test 5: recording_mbid without ISRC still patches (no ISRC required) ────

async function test_mbid_only_patches() {
  console.log('\n[5] Finding 1 — recording_mbid patches works_recordings_v1 even without ISRC');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  const mbid = 'cccccccc-dddd-eeee-ffff-000000000005';
  await syncEnrichmentToGraph('test-artist', [
    baseTrack({ recording_mbid: mbid }),  // no isrc
  ]);

  const recPatch = calls.find(c =>
    c.method === 'PATCH' && c.url.includes('works_recordings_v1'));
  assert(!!recPatch, 'PATCH to works_recordings_v1 made when only recording_mbid present');
  assert(recPatch?.body?.musicbrainz_recording_id === mbid,
    `musicbrainz_recording_id set correctly`);
  assert(!recPatch?.body?.isrc, 'isrc not included in patch when not provided');
}

// ─── Test 6: node namespace never changed to isrc (full regression guard) ────

async function test_external_id_ns_never_changed_to_isrc() {
  console.log('\n[6] Finding 2 — external_id_ns never changed to "isrc" at any point');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [
    baseTrack({ isrc: 'USABC1234567', recording_mbid: 'cccccccc-dddd-eeee-ffff-000000000006' }),
  ]);

  const nsPoison = calls.find(c =>
    c.method === 'PATCH' &&
    c.url.includes('graph_nodes_v1') &&
    c.body?.external_id_ns === 'isrc');
  assert(!nsPoison, 'external_id_ns never set to "isrc" on any node PATCH');

  const externalIdPoison = calls.find(c =>
    c.method === 'PATCH' &&
    c.url.includes('graph_nodes_v1') &&
    typeof c.body?.external_id === 'string');
  assert(!externalIdPoison, 'external_id never overwritten on any node PATCH');
}

// ─── Test 7: no ISRC and no MBID → works_recordings_v1 not patched ───────────

async function test_no_isrc_no_mbid_no_patch() {
  console.log('\n[7] Edge case — no isrc, no recording_mbid → works_recordings_v1 not patched');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [
    baseTrack({ iswc: 'T-123.456.789-C' }),  // only iswc, no isrc or mbid
  ]);

  const recPatch = calls.find(c =>
    c.method === 'PATCH' && c.url.includes('works_recordings_v1'));
  assert(!recPatch, 'works_recordings_v1 not patched when no isrc or recording_mbid');
}

// ─── Test 8: single PATCH (not two) when both ISRC and MBID present ──────────

async function test_single_patch_when_both_present() {
  console.log('\n[8] Efficiency — single PATCH to works_recordings_v1 when both isrc and mbid present');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [
    baseTrack({
      isrc:          'USABC1234567',
      recording_mbid: 'cccccccc-dddd-eeee-ffff-000000000008',
    }),
  ]);

  const recPatches = calls.filter(c =>
    c.method === 'PATCH' && c.url.includes('works_recordings_v1'));
  assert(recPatches.length === 1,
    `exactly 1 PATCH to works_recordings_v1 (got ${recPatches.length})`);
  assert(!!recPatches[0]?.body?.isrc && !!recPatches[0]?.body?.musicbrainz_recording_id,
    'single PATCH contains both isrc and musicbrainz_recording_id');
}

// ─── Tests 9-12: enrichArtistCatalog() camelCase payload shape ───────────────
//
// These cover the field-name mismatch bug (Task C):
//   enrichArtistCatalog() produces { trackTitle, isrcs[], recordingMBID }
//   The old syncEnrichmentToGraph expected { title, isrc, catalog_id }
//   → complete silent no-op. These tests prove the fix works.

// Mock tuned to camelCase-shape lookups:
//   work node:      fingerprint('Rebel Rap') = 'rebelrap' in musigod_catalog
//   recording node: 'USABC9999999' in isrc namespace
const ENRICH_WORK_NODE_UUID = 'eeeeeeee-0000-0000-0000-000000000099';
const ENRICH_REC_NODE_UUID  = 'ffffffff-0000-0000-0000-000000000099';

function makeMockFetchEnrich(calls) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body   = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });

    // Work node via title fingerprint in musigod_catalog (no catalog_id)
    if (method === 'GET' && url.includes('graph_nodes_v1') &&
        url.includes('rebelrap') && url.includes('musigod_catalog')) {
      return ok([{ id: ENRICH_WORK_NODE_UUID }]);
    }
    // Recording node via ISRC namespace
    if (method === 'GET' && url.includes('graph_nodes_v1') &&
        url.includes('USABC9999999') && url.includes('external_id_ns=eq.isrc')) {
      return ok([{ id: ENRICH_REC_NODE_UUID }]);
    }
    // Recording node fallback via fingerprint (when no ISRC match)
    if (method === 'GET' && url.includes('graph_nodes_v1') &&
        url.includes('rebelrap') && url.includes('musigod_catalog')) {
      return ok([{ id: ENRICH_REC_NODE_UUID }]);
    }
    if (method === 'PATCH' && url.includes('works_compositions_v1')) return ok(null);
    if (method === 'PATCH' && url.includes('works_recordings_v1'))   return ok(null);
    if (method === 'PATCH' && url.includes('graph_nodes_v1'))        return ok(null);
    // All other GETs (iswc lookup, etc.) return empty — not found
    if (method === 'GET' && url.includes('graph_nodes_v1')) return ok([]);
    return { ok: false, status: 404, text: async () => `{"error":"unexpected mock call: ${method} ${url}"}` };
  };
}

// ─── Test 9: trackTitle normalised — no silent no-op ─────────────────────────

async function test_camelcase_trackTitle_normalised() {
  console.log('\n[9] Field mismatch fix — trackTitle normalised, work node found via title fingerprint');

  const calls = [];
  global.fetch = makeMockFetchEnrich(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [{
    trackTitle: 'Rebel Rap',
    isrcs:      ['USABC9999999'],
    recordingMBID: 'eeeeeeee-ffff-0000-1111-222222222222',
    iswc:       null,
  }]);

  const workPatch = calls.find(c =>
    c.method === 'PATCH' && c.url.includes('works_compositions_v1'));
  // No iswc/ascap/bmi on this track — work patch may be skipped, but node lookup must have been attempted
  const workLookup = calls.find(c =>
    c.method === 'GET' && c.url.includes('rebelrap') && c.url.includes('musigod_catalog'));
  assert(!!workLookup, 'work node lookup attempted via title fingerprint (not a no-op)');

  const recPatch = calls.find(c =>
    c.method === 'PATCH' && c.url.includes('works_recordings_v1'));
  assert(!!recPatch, 'recording node patched from enrichArtistCatalog camelCase shape');
}

// ─── Test 10: isrcs[0] used as isrc — ISRC propagated ───────────────────────

async function test_isrcs_array_normalised() {
  console.log('\n[10] Field mismatch fix — isrcs[0] normalised to isrc, written to works_recordings_v1');

  const calls = [];
  global.fetch = makeMockFetchEnrich(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [{
    trackTitle: 'Rebel Rap',
    isrcs:      ['usabc9999999'],  // lowercase to test uppercasing
    recordingMBID: null,
  }]);

  const recPatch = calls.find(c =>
    c.method === 'PATCH' && c.url.includes('works_recordings_v1'));
  assert(!!recPatch, 'PATCH to works_recordings_v1 when ISRC provided via isrcs[]');
  assert(recPatch?.body?.isrc === 'USABC9999999',
    `isrcs[0] uppercased correctly (got "${recPatch?.body?.isrc}")`);
}

// ─── Test 11: No catalog_id — falls back to title fingerprint for rec lookup ──

async function test_no_catalog_id_uses_title_fingerprint() {
  console.log('\n[11] Field mismatch fix — no catalog_id falls back to title fingerprint for recording lookup');

  const calls = [];
  // Mock where ISRC lookup returns empty (no ISRC ns node) so fallback fires
  const mockNoIsrcNode = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body   = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });

    // No ISRC-ns match
    if (method === 'GET' && url.includes('external_id_ns=eq.isrc')) return ok([]);
    // Fingerprint-based recording lookup
    if (method === 'GET' && url.includes('rebelrap') && url.includes('musigod_catalog')) {
      return ok([{ id: ENRICH_REC_NODE_UUID }]);
    }
    if (method === 'PATCH' && url.includes('works_recordings_v1')) return ok(null);
    if (method === 'PATCH' && url.includes('works_compositions_v1')) return ok(null);
    if (method === 'GET' && url.includes('graph_nodes_v1')) return ok([]);
    return { ok: false, status: 404, text: async () => 'unexpected' };
  };
  global.fetch = mockNoIsrcNode;
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [{
    trackTitle:    'Rebel Rap',
    isrcs:         ['USABC9999999'],
    recordingMBID: 'eeeeeeee-ffff-0000-1111-333333333333',
  }]);

  const fingerLookup = calls.find(c =>
    c.method === 'GET' && c.url.includes('rebelrap') && c.url.includes('musigod_catalog'));
  assert(!!fingerLookup, 'title fingerprint fallback attempted for recording node when ISRC ns returns empty');

  const recPatch = calls.find(c =>
    c.method === 'PATCH' && c.url.includes('works_recordings_v1'));
  assert(!!recPatch, 'recording patch succeeds via fingerprint fallback');
  assert(recPatch?.body?.musicbrainz_recording_id === 'eeeeeeee-ffff-0000-1111-333333333333',
    'musicbrainz_recording_id written via fingerprint-found node');
}

// ─── Test 12: Recording patch fires even when work node not found ─────────────

async function test_recording_patch_independent_of_work_node() {
  console.log('\n[12] Field mismatch fix — recording patch fires even when work node not found');

  const calls = [];
  const mockNoWorkNode = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body   = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });

    if (method === 'GET' && url.includes('graph_nodes_v1')) {
      // Recording node via ISRC namespace → hit
      if (url.includes('USABC9999999') && url.includes('external_id_ns=eq.isrc')) {
        return ok([{ id: ENRICH_REC_NODE_UUID }]);
      }
      // All other GETs (work lookups via iswc/musigod_catalog) → not found
      return ok([]);
    }
    if (method === 'PATCH' && url.includes('works_recordings_v1'))  return ok(null);
    if (method === 'PATCH' && url.includes('works_compositions_v1')) return ok(null);
    return { ok: false, status: 404, text: async () => 'unexpected' };
  };
  global.fetch = mockNoWorkNode;
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [{
    trackTitle:    'Unknown Title',
    isrcs:         ['USABC9999999'],
    recordingMBID: 'eeeeeeee-ffff-0000-1111-444444444444',
  }]);

  const workPatch = calls.find(c =>
    c.method === 'PATCH' && c.url.includes('works_compositions_v1'));
  assert(!workPatch, 'work patch not called when work node not found (expected)');

  const recPatch = calls.find(c =>
    c.method === 'PATCH' && c.url.includes('works_recordings_v1'));
  assert(!!recPatch, 'recording patch still fires even when work node lookup returns null');
  assert(recPatch?.body?.musicbrainz_recording_id === 'eeeeeeee-ffff-0000-1111-444444444444',
    'musicbrainz_recording_id still written despite work node miss');
}

// ─── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== graph-sync identity fix: unit tests ===');
  console.log('Finding 2: external_id_ns overwrite removed (api/graph-sync.js:190-209)');
  console.log('Finding 1: recording_mbid bridges to works_recordings_v1.musicbrainz_recording_id');
  console.log('Task C:    enrichArtistCatalog() camelCase field-name mismatch fixed\n');

  // Suppress console output from the module under test
  const origLog   = console.log;
  const origError = console.error;
  const origWarn  = console.warn;

  try {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

    await test_no_node_external_id_overwrite();
    await test_isrc_written_to_recordings_table();
    await test_snake_case_recording_mbid_bridges();
    await test_camelcase_recordingMBID_bridges();
    await test_mbid_only_patches();
    await test_external_id_ns_never_changed_to_isrc();
    await test_no_isrc_no_mbid_no_patch();
    await test_single_patch_when_both_present();
    await test_camelcase_trackTitle_normalised();
    await test_isrcs_array_normalised();
    await test_no_catalog_id_uses_title_fingerprint();
    await test_recording_patch_independent_of_work_node();
  } finally {
    console.log  = origLog;
    console.error = origError;
    console.warn  = origWarn;
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
