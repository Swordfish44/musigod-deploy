// tests/graph-sync-identity.test.js
//
// Unit tests for the Finding 1 + 2 fix in api/graph-sync.js:
//   Finding 2: graph node external_id / external_id_ns MUST NOT be overwritten
//              when an ISRC is discovered during enrichment.
//   Finding 1: recording MBID written to works_recordings_v1.musicbrainz_recording_id,
//              bridging catalog_enriched_tracks_v1.recording_mbid to the formal graph.
//
// Updated for upsert redesign: syncEnrichmentToGraph now uses upsertNode (RPC) +
// POST recordings?Prefer=resolution=merge-duplicates instead of lookup+PATCH.
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

// Standard mock for tests 1-8, 13, 15:
//   graph_upsert_node RPC  → REC_NODE_UUID  (recording upsert, new path)
//   graph_nodes_v1 GET     → work node by catalog_id; empty for everything else
//   compositions PATCH     → null
//   recordings POST        → null  (new: was PATCH)
//   graph_nodes_v1 PATCH   → null  (trap — should never be called after fix)
function makeMockFetch(calls) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body   = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });

    // graph_upsert_node RPC — upsert recording node (new path)
    if (url.includes('/rpc/graph_upsert_node')) return ok(REC_NODE_UUID);

    if (method === 'GET' && url.includes('graph_nodes_v1')) {
      // Work node lookup: external_id=eq.my-catalog-id (no rec_ prefix).
      // Must NOT match the recording catalog guard (external_id=eq.rec_my-catalog-id)
      // which also contains 'my-catalog-id' as a substring.
      if (url.includes('external_id=eq.my-catalog-id') &&
          !url.includes('rec_my-catalog-id') &&
          url.includes('musigod_catalog')) {
        return ok([{ id: WORK_NODE_UUID }]);
      }
      // All other lookups (iswc, MBID, rec_my-catalog-id, fingerprints) → not found
      return ok([]);
    }
    // Work composition PATCH (unchanged)
    if (method === 'PATCH' && url.includes('/v1/compositions')) return ok(null);
    // Recording upsert (new: POST not PATCH)
    if (method === 'POST'  && url.includes('/v1/recordings'))   return ok(null);
    // graph_nodes_v1 PATCH should NEVER be called after Finding 2 fix
    if (method === 'PATCH' && url.includes('graph_nodes_v1'))   return ok(null);
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

// ─── Test 2: ISRC written to works.recordings (regression guard) ──────────────

async function test_isrc_written_to_recordings_table() {
  console.log('\n[2] Finding 2 — isrc written to works.recordings.isrc via /v1/recordings');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [baseTrack({ isrc: 'usabc1234567' })]);

  const recPost = calls.find(c =>
    c.method === 'POST' && c.url.includes('/v1/recordings'));
  assert(!!recPost, 'POST to /v1/recordings (works.recordings) was made');
  assert(recPost?.body?.isrc === 'USABC1234567',
    `isrc uppercased correctly (got "${recPost?.body?.isrc}")`);
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

  const recPost = calls.find(c =>
    c.method === 'POST' && c.url.includes('/v1/recordings'));
  assert(recPost?.body?.musicbrainz_recording_id === mbid,
    `musicbrainz_recording_id set from snake_case field (got "${recPost?.body?.musicbrainz_recording_id}")`);
  assert(recPost?.body?.isrc === 'USABC1234567',
    'isrc also present in same POST');
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

  const recPost = calls.find(c =>
    c.method === 'POST' && c.url.includes('/v1/recordings'));
  assert(recPost?.body?.musicbrainz_recording_id === mbid,
    `musicbrainz_recording_id set from camelCase field (got "${recPost?.body?.musicbrainz_recording_id}")`);
}

// ─── Test 5: recording_mbid without ISRC still upserts (no ISRC required) ────

async function test_mbid_only_upserts() {
  console.log('\n[5] Finding 1 — recording_mbid upserts works.recordings even without ISRC');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  const mbid = 'cccccccc-dddd-eeee-ffff-000000000005';
  await syncEnrichmentToGraph('test-artist', [
    baseTrack({ recording_mbid: mbid }),  // no isrc
  ]);

  const recPost = calls.find(c =>
    c.method === 'POST' && c.url.includes('/v1/recordings'));
  assert(!!recPost, 'POST to /v1/recordings (works.recordings) made when only recording_mbid present');
  assert(recPost?.body?.musicbrainz_recording_id === mbid,
    `musicbrainz_recording_id set correctly`);
  assert(!recPost?.body?.isrc, 'isrc not included in POST when not provided');
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

// ─── Test 7: no ISRC and no MBID → works.recordings not touched ──────────────

async function test_no_isrc_no_mbid_no_recording_write() {
  console.log('\n[7] Edge case — no isrc, no recording_mbid → works.recordings not patched');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [
    baseTrack({ iswc: 'T-123.456.789-C' }),  // only iswc, no isrc or mbid
  ]);

  const recWrite = calls.find(c =>
    (c.method === 'POST' || c.method === 'PATCH') && c.url.includes('/v1/recordings'));
  assert(!recWrite, 'works.recordings not patched when no isrc or recording_mbid');

  const rpcCall = calls.find(c => c.url.includes('/rpc/graph_upsert_node'));
  assert(!rpcCall, 'graph_upsert_node RPC not called when no isrc or recording_mbid');
}

// ─── Test 8: single POST (not two) when both ISRC and MBID present ───────────

async function test_single_post_when_both_present() {
  console.log('\n[8] Efficiency — single POST to works.recordings when both isrc and mbid present');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [
    baseTrack({
      isrc:           'USABC1234567',
      recording_mbid: 'cccccccc-dddd-eeee-ffff-000000000008',
    }),
  ]);

  const recPosts = calls.filter(c =>
    c.method === 'POST' && c.url.includes('/v1/recordings'));
  assert(recPosts.length === 1,
    `exactly 1 POST to /v1/recordings (works.recordings) — got ${recPosts.length}`);
  assert(!!recPosts[0]?.body?.isrc && !!recPosts[0]?.body?.musicbrainz_recording_id,
    'single POST contains both isrc and musicbrainz_recording_id');
}

// ─── Tests 9-12: enrichArtistCatalog() camelCase payload shape ───────────────
//
// These cover the field-name mismatch bug (Task C):
//   enrichArtistCatalog() produces { trackTitle, isrcs[], recordingMBID }
//   The old syncEnrichmentToGraph expected { title, isrc, catalog_id }
//   → complete silent no-op. These tests prove the fix works.

// Mock tuned to camelCase-shape inputs: all work GETs return empty (no catalogId on
// enrichment-only tracks), RPC returns ENRICH_REC_NODE_UUID for recording upsert.
const ENRICH_WORK_NODE_UUID = 'eeeeeeee-0000-0000-0000-000000000099';
const ENRICH_REC_NODE_UUID  = 'ffffffff-0000-0000-0000-000000000099';

function makeMockFetchEnrich(calls) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body   = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });

    // graph_upsert_node RPC — recording upsert (new path)
    if (url.includes('/rpc/graph_upsert_node')) return ok(ENRICH_REC_NODE_UUID);

    // Work node via title fingerprint in musigod_catalog (only when catalogId present)
    if (method === 'GET' && url.includes('graph_nodes_v1') &&
        url.includes('rebelrap') && url.includes('musigod_catalog')) {
      return ok([{ id: ENRICH_WORK_NODE_UUID }]);
    }
    // All other GETs (iswc lookup, etc.) → not found
    if (method === 'GET' && url.includes('graph_nodes_v1')) return ok([]);

    if (method === 'PATCH' && url.includes('/v1/compositions')) return ok(null);
    if (method === 'POST'  && url.includes('/v1/recordings'))   return ok(null);
    if (method === 'PATCH' && url.includes('graph_nodes_v1'))   return ok(null);
    return { ok: false, status: 404, text: async () => `{"error":"unexpected mock call: ${method} ${url}"}` };
  };
}

// ─── Test 9: trackTitle normalised — field-name mismatch fixed ───────────────

async function test_camelcase_trackTitle_normalised() {
  console.log('\n[9] Field mismatch fix — trackTitle normalised, recording upsert fires for camelCase shape');

  const calls = [];
  global.fetch = makeMockFetchEnrich(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [{
    trackTitle:    'Rebel Rap',
    isrcs:         ['USABC9999999'],
    recordingMBID: 'eeeeeeee-ffff-0000-1111-222222222222',
    iswc:          null,
    // no catalog_id — enrichment-only track; work fingerprint lookup skipped (guard)
  }]);

  // Work fingerprint lookup must NOT fire (no iswc, no catalogId — new guard)
  const workFingerLookup = calls.find(c =>
    c.method === 'GET' && c.url.includes('rebelrap') && c.url.includes('musigod_catalog'));
  assert(!workFingerLookup, 'work fingerprint lookup skipped for enrichment-only track (no iswc/catalogId)');

  // Recording upsert must fire with correctly normalised title
  const recPost = calls.find(c =>
    c.method === 'POST' && c.url.includes('/v1/recordings'));
  assert(!!recPost, 'recording POST fires for enrichArtistCatalog camelCase shape');
  assert(recPost?.body?.title === 'Rebel Rap',
    `title normalised from trackTitle (got "${recPost?.body?.title}")`);
  assert(recPost?.body?.isrc === 'USABC9999999',
    `isrcs[0] written to recordings.isrc (got "${recPost?.body?.isrc}")`);
}

// ─── Test 10: isrcs[0] used as isrc — ISRC propagated ───────────────────────

async function test_isrcs_array_normalised() {
  console.log('\n[10] Field mismatch fix — isrcs[0] normalised to isrc, written to works.recordings');

  const calls = [];
  global.fetch = makeMockFetchEnrich(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [{
    trackTitle: 'Rebel Rap',
    isrcs:      ['usabc9999999'],  // lowercase to test uppercasing
    recordingMBID: null,
  }]);

  const recPost = calls.find(c =>
    c.method === 'POST' && c.url.includes('/v1/recordings'));
  assert(!!recPost, 'POST to /v1/recordings (works.recordings) when ISRC provided via isrcs[]');
  assert(recPost?.body?.isrc === 'USABC9999999',
    `isrcs[0] uppercased correctly (got "${recPost?.body?.isrc}")`);
}

// ─── Test 11: No ISRC — uses MusicBrainz recording ID as external key ─────────
//
// Old behavior: ISRC lookup fails → title fingerprint lookup → PATCH node.
// New behavior: upsertNode with external_id = recordingMBID, external_id_ns =
// 'musicbrainz_recording'. No lookup needed; upsert is the canonical path.

async function test_mbid_as_external_key_when_no_isrc() {
  console.log('\n[11] Field mismatch fix — MBID used as graph node key when no ISRC present');

  const calls = [];
  global.fetch = makeMockFetchEnrich(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  const mbid = 'eeeeeeee-ffff-0000-1111-333333333333';
  await syncEnrichmentToGraph('test-artist', [{
    trackTitle:    'Rebel Rap',
    isrcs:         [],           // no ISRC
    recordingMBID: mbid,
  }]);

  // upsertNode must be called with MBID as the external identity
  const rpcCall = calls.find(c => c.url.includes('/rpc/graph_upsert_node'));
  assert(!!rpcCall, 'graph_upsert_node RPC called');
  assert(rpcCall?.body?.p_external_ns === 'musicbrainz_recording',
    `upsertNode uses musicbrainz_recording namespace (got "${rpcCall?.body?.p_external_ns}")`);
  assert(rpcCall?.body?.p_external_id === mbid,
    `upsertNode external_id is the MBID (got "${rpcCall?.body?.p_external_id}")`);

  // recordings POST must carry the MBID in the correct column
  const recPost = calls.find(c =>
    c.method === 'POST' && c.url.includes('/v1/recordings'));
  assert(!!recPost, 'recording POST succeeds via MBID-keyed upsert');
  assert(recPost?.body?.musicbrainz_recording_id === mbid,
    'musicbrainz_recording_id written in correct column');
}

// ─── Test 12: Recording upsert fires even when work node not found ────────────

async function test_recording_upsert_independent_of_work_node() {
  console.log('\n[12] Field mismatch fix — recording upsert fires even when work node not found');

  const calls = [];
  const mockNoWorkNode = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body   = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });

    if (url.includes('/rpc/graph_upsert_node')) return ok(ENRICH_REC_NODE_UUID);
    // All work-node GETs → not found
    if (method === 'GET' && url.includes('graph_nodes_v1')) return ok([]);
    if (method === 'POST'  && url.includes('/v1/recordings'))  return ok(null);
    if (method === 'PATCH' && url.includes('/v1/compositions')) return ok(null);
    return { ok: false, status: 404, text: async () => 'unexpected' };
  };
  global.fetch = mockNoWorkNode;
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  const mbid = 'eeeeeeee-ffff-0000-1111-444444444444';
  await syncEnrichmentToGraph('test-artist', [{
    trackTitle:    'Unknown Title',
    isrcs:         ['USABC9999999'],
    recordingMBID: mbid,
  }]);

  const workPatch = calls.find(c =>
    c.method === 'PATCH' && c.url.includes('/v1/compositions'));
  assert(!workPatch, 'work patch not called when work node not found (expected)');

  const recPost = calls.find(c =>
    c.method === 'POST' && c.url.includes('/v1/recordings'));
  assert(!!recPost, 'recording POST still fires even when work node lookup returns null');
  assert(recPost?.body?.musicbrainz_recording_id === mbid,
    'musicbrainz_recording_id still written despite work node miss');
}

// ─── Tests 13-14: Confirmed base table name regression ───────────────────────
//
// works.works_recordings_v1 does NOT exist in production.
// The confirmed base table is works.recordings.
// public.works_recordings_v1 is a VIEW over works.recordings (read via PostgREST
// default schema, no Accept-Profile header).

// ─── Test 13: syncEnrichmentToGraph URL never references works_recordings_v1 ──

async function test_enrichment_never_hits_works_recordings_v1() {
  console.log('\n[13] Base table — syncEnrichmentToGraph targets /v1/recordings, never works_recordings_v1');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [
    baseTrack({ isrc: 'USABC1234567', recordingMBID: 'cccccccc-dddd-eeee-ffff-000000000013' }),
  ]);

  const wrongCalls = calls.filter(c => c.url.includes('works_recordings_v1'));
  assert(wrongCalls.length === 0,
    `no call references works_recordings_v1 (nonexistent relation) — got ${wrongCalls.length}`);

  const correctPost = calls.filter(c =>
    c.method === 'POST' && c.url.includes('/v1/recordings'));
  assert(correctPost.length === 1,
    `exactly 1 POST to /v1/recordings (confirmed base table) — got ${correctPost.length}`);
}

// ─── Test 14: syncCatalogToGraph POST targets recordings, not works_recordings_v1

async function test_catalog_sync_uses_recordings_not_works_recordings_v1() {
  console.log('\n[14] Base table — syncCatalogToGraph POSTs to /v1/recordings, never to works_recordings_v1');

  const calls = [];
  const WORK_UUID = 'cccccccc-0000-0000-0000-000000000014';
  const REC_UUID  = 'dddddddd-0000-0000-0000-000000000014';
  let upsertCount = 0;

  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body   = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });

    if (url.includes('/rpc/graph_upsert_node')) {
      upsertCount++;
      return ok(upsertCount === 1 ? WORK_UUID : REC_UUID);
    }
    if (url.includes('/rpc/graph_upsert_edge'))  return ok(null);
    if (method === 'GET' && url.includes('graph_nodes_v1')) return ok([]);
    if (method === 'POST' && url.includes('/v1/compositions')) return ok(null);
    if (method === 'POST' && url.includes('/v1/recordings'))  return ok(null);
    if (method === 'POST' && url.includes('works_recordings_v1')) return ok(null); // trap wrong target
    return { ok: false, status: 404, text: async () => `unexpected: ${method} ${url}` };
  };

  const { syncCatalogToGraph } = loadFreshGraphSync();
  await syncCatalogToGraph('artist-id-14', [{
    catalog_id:   'cat-track-14',
    track_title:  'Test Catalog Track',
    isrc:         'USXXX1234514',
    release_date: '2020-01-01',
  }]);

  const wrongPosts = calls.filter(c =>
    c.method === 'POST' && c.url.includes('works_recordings_v1'));
  assert(wrongPosts.length === 0,
    `no POST to works_recordings_v1 (nonexistent relation) — got ${wrongPosts.length}`);

  const correctPost = calls.find(c =>
    c.method === 'POST' && c.url.includes('/v1/recordings'));
  assert(!!correctPost, 'POST to /v1/recordings (confirmed base table) was made');

  if (correctPost) {
    assert(correctPost.body?.node_id === REC_UUID,
      `POST body node_id is recording node UUID (got "${correctPost.body?.node_id}")`);
    assert(correctPost.body?.isrc === 'USXXX1234514',
      `POST body isrc uppercased correctly (got "${correctPost.body?.isrc}")`);
    assert('composition_node_id' in (correctPost.body || {}),
      'POST body contains composition_node_id field');
  }
}

// ─── Tests 15-16: Confirmed base table name for compositions ─────────────────
//
// works.works_compositions_v1 does NOT exist in production.
// The confirmed base table is works.compositions.

// ─── Test 15: syncEnrichmentToGraph PATCH targets /v1/compositions ────────────

async function test_enrichment_never_hits_works_compositions_v1() {
  console.log('\n[15] Base table — syncEnrichmentToGraph PATCHes /v1/compositions, never works_compositions_v1');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  // Track with iswc forces the work patch to fire.
  // catalog_id 'my-catalog-id' → makeMockFetch returns WORK_NODE_UUID for work node.
  // No isrc or recordingMBID → recording upsert path skipped (no RPC call).
  await syncEnrichmentToGraph('test-artist', [
    baseTrack({ iswc: 'T-123.456.789-C' }),
  ]);

  const wrongCalls = calls.filter(c => c.url.includes('works_compositions_v1'));
  assert(wrongCalls.length === 0,
    `no call references works_compositions_v1 (nonexistent relation) — got ${wrongCalls.length}`);

  const correctPatch = calls.filter(c =>
    c.method === 'PATCH' && c.url.includes('/v1/compositions'));
  assert(correctPatch.length === 1,
    `exactly 1 PATCH to /v1/compositions (confirmed base table) — got ${correctPatch.length}`);
  assert(correctPatch[0]?.body?.iswc === 'T-123.456.789-C',
    `PATCH body carries iswc correctly (got "${correctPatch[0]?.body?.iswc}")`);
  assert(correctPatch[0]?.url.includes(`node_id=eq.${WORK_NODE_UUID}`),
    'PATCH targets the correct work node_id');
}

// ─── Test 16: syncCatalogToGraph POST targets /v1/compositions ────────────────

async function test_catalog_sync_uses_compositions_not_works_compositions_v1() {
  console.log('\n[16] Base table — syncCatalogToGraph POSTs to /v1/compositions, never to works_compositions_v1');

  const calls = [];
  const WORK_UUID = 'cccccccc-0000-0000-0000-000000000016';
  const REC_UUID  = 'dddddddd-0000-0000-0000-000000000016';
  let upsertCount = 0;

  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body   = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });

    if (url.includes('/rpc/graph_upsert_node')) {
      upsertCount++;
      return ok(upsertCount === 1 ? WORK_UUID : REC_UUID);
    }
    if (url.includes('/rpc/graph_upsert_edge'))  return ok(null);
    if (method === 'GET' && url.includes('graph_nodes_v1')) return ok([]);
    if (method === 'POST' && url.includes('/v1/compositions')) return ok(null);
    if (method === 'POST' && url.includes('/v1/recordings'))  return ok(null);
    if (method === 'POST' && url.includes('works_compositions_v1')) return ok(null); // trap wrong target
    return { ok: false, status: 404, text: async () => `unexpected: ${method} ${url}` };
  };

  const { syncCatalogToGraph } = loadFreshGraphSync();
  await syncCatalogToGraph('artist-id-16', [{
    catalog_id:   'cat-comp-16',
    track_title:  'Composition Track',
    iswc:         'T-999.888.777-C',
    release_date: '2021-01-01',
  }]);

  const wrongPosts = calls.filter(c =>
    c.method === 'POST' && c.url.includes('works_compositions_v1'));
  assert(wrongPosts.length === 0,
    `no POST to works_compositions_v1 (nonexistent relation) — got ${wrongPosts.length}`);

  const correctPost = calls.find(c =>
    c.method === 'POST' && c.url.includes('/v1/compositions'));
  assert(!!correctPost, 'POST to /v1/compositions (confirmed base table) was made');

  if (correctPost) {
    assert(correctPost.body?.node_id === WORK_UUID,
      `POST body node_id is work node UUID (got "${correctPost.body?.node_id}")`);
    assert(correctPost.body?.title === 'Composition Track',
      `POST body title correct (got "${correctPost.body?.title}")`);
    assert(correctPost.body?.work_type === 'original',
      `POST body work_type is 'original' (got "${correctPost.body?.work_type}")`);
    assert('iswc' in (correctPost.body || {}),
      'POST body contains iswc field');
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== graph-sync identity fix: unit tests ===');
  console.log('Finding 2: external_id_ns overwrite removed');
  console.log('Finding 1: recording_mbid bridges to works.recordings.musicbrainz_recording_id');
  console.log('Task C:    enrichArtistCatalog() camelCase field-name mismatch fixed');
  console.log('Schema:    confirmed base tables works.recordings + works.compositions\n');

  try {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

    await test_no_node_external_id_overwrite();
    await test_isrc_written_to_recordings_table();
    await test_snake_case_recording_mbid_bridges();
    await test_camelcase_recordingMBID_bridges();
    await test_mbid_only_upserts();
    await test_external_id_ns_never_changed_to_isrc();
    await test_no_isrc_no_mbid_no_recording_write();
    await test_single_post_when_both_present();
    await test_camelcase_trackTitle_normalised();
    await test_isrcs_array_normalised();
    await test_mbid_as_external_key_when_no_isrc();
    await test_recording_upsert_independent_of_work_node();
    await test_enrichment_never_hits_works_recordings_v1();
    await test_catalog_sync_uses_recordings_not_works_recordings_v1();
    await test_enrichment_never_hits_works_compositions_v1();
    await test_catalog_sync_uses_compositions_not_works_compositions_v1();
  } finally {
    // nothing to restore
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
