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

// Standard mock for tests 1-13 (syncEnrichmentToGraph only):
//   rpc_upsert_recording_enrichment → { node_id: REC_NODE_UUID }
//   graph_nodes_v1 GET              → REGRESSION THROW (v2 fix: no JS-level lookup)
//   compositions PATCH              → REGRESSION THROW (v2 fix: removed from enrichment path)
//   graph_nodes_v1 PATCH            → null  (trap — should never be called after Finding 2 fix)
//   graph_upsert_node               → 403   (trap — must not be called from enrichment path)
//   recordings POST                 → 403   (trap — must not be called from enrichment path)
function makeMockFetch(calls) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body   = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });

    // Public RPC — single authorised entry point for enrichment recording writes.
    if (url.includes('/rpc/rpc_upsert_recording_enrichment')) return ok({ node_id: REC_NODE_UUID });

    // graph.nodes GET must NOT happen from enrichment path after v2 fix.
    // All identity lookup now runs inside the SECURITY DEFINER RPC.
    if (method === 'GET' && url.includes('/rest/v1/nodes')) {
      throw new Error(`REGRESSION: graph.nodes GET from enrichment path — must be inside RPC: ${url}`);
    }
    // Compositions PATCH removed from syncEnrichmentToGraph in v2.
    if (method === 'PATCH' && url.includes('/v1/compositions')) {
      throw new Error('REGRESSION: compositions PATCH from enrichment path — removed in v2');
    }
    // graph_nodes_v1 PATCH should NEVER be called after Finding 2 fix
    if (method === 'PATCH' && url.includes('graph_nodes_v1'))   return ok(null);
    // graph_upsert_node must NOT be called from the enrichment path after RLS patch
    if (url.includes('/rpc/graph_upsert_node'))
      return { ok: false, status: 403, text: async () => '{"error":"graph_upsert_node must not be called from enrichment path"}' };
    // Direct recordings POST must NOT be called from the enrichment path after RLS patch
    if (method === 'POST' && url.includes('/v1/recordings'))
      return { ok: false, status: 403, text: async () => '{"error":"direct recordings POST must not be called from enrichment path"}' };
    // Unmatched → fail loudly so tests catch unexpected calls
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

// ─── Test 2: ISRC written via p_isrc param (regression guard) ────────────────

async function test_isrc_written_to_recordings_table() {
  console.log('\n[2] Finding 2 — isrc uppercased and passed as p_isrc to rpc_upsert_recording_enrichment');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [baseTrack({ isrc: 'usabc1234567' })]);

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(!!rpcCall, 'rpc_upsert_recording_enrichment was called');
  assert(rpcCall?.body?.p_isrc === 'USABC1234567',
    `isrc uppercased correctly in p_isrc (got "${rpcCall?.body?.p_isrc}")`);
}

// ─── Test 3: snake_case recording_mbid → p_recording_mbid ───────────────────

async function test_snake_case_recording_mbid_bridges() {
  console.log('\n[3] Finding 1 — snake_case recording_mbid → p_recording_mbid param');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  const mbid = 'cccccccc-dddd-eeee-ffff-000000000003';
  await syncEnrichmentToGraph('test-artist', [
    baseTrack({ isrc: 'USABC1234567', recording_mbid: mbid }),
  ]);

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCall?.body?.p_recording_mbid === mbid,
    `p_recording_mbid set from snake_case field (got "${rpcCall?.body?.p_recording_mbid}")`);
  assert(rpcCall?.body?.p_isrc === 'USABC1234567',
    'p_isrc also present');
}

// ─── Test 4: camelCase recordingMBID (enrichArtistCatalog shape) → p_recording_mbid

async function test_camelcase_recordingMBID_bridges() {
  console.log('\n[4] Finding 1 — camelCase recordingMBID → p_recording_mbid param');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  const mbid = 'cccccccc-dddd-eeee-ffff-000000000004';
  await syncEnrichmentToGraph('test-artist', [
    baseTrack({ isrc: 'USABC1234567', recordingMBID: mbid }),
  ]);

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCall?.body?.p_recording_mbid === mbid,
    `p_recording_mbid set from camelCase recordingMBID (got "${rpcCall?.body?.p_recording_mbid}")`);
}

// ─── Test 5: recording_mbid without ISRC → p_recording_mbid, p_isrc null ─────

async function test_mbid_only_upserts() {
  console.log('\n[5] Finding 1 — recording_mbid triggers RPC even without ISRC; p_isrc is null');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  const mbid = 'cccccccc-dddd-eeee-ffff-000000000005';
  await syncEnrichmentToGraph('test-artist', [
    baseTrack({ recording_mbid: mbid }),  // no isrc
  ]);

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(!!rpcCall, 'rpc_upsert_recording_enrichment called when only recording_mbid present');
  assert(rpcCall?.body?.p_recording_mbid === mbid,
    `p_recording_mbid set correctly (got "${rpcCall?.body?.p_recording_mbid}")`);
  assert(!rpcCall?.body?.p_isrc, 'p_isrc null/empty when no ISRC provided');
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

// ─── Test 7: no ISRC, no MBID, no catalog_id → RPC not called ────────────────
//
// After v2: the guard is (normalIsrc || recordingMbid || catalogId). A track
// with only work-level data (iswc) and no recording identity is skipped.
// Note: baseTrack has catalog_id — use a bare object here to test the no-op.

async function test_no_isrc_no_mbid_no_recording_write() {
  console.log('\n[7] Edge case — no isrc, no recording_mbid, no catalog_id → RPC not called');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [
    { title: 'Work Only Track', iswc: 'T-123.456.789-C' },  // no catalog_id, no isrc, no mbid
  ]);

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(!rpcCall, 'RPC not called when no isrc, no recording_mbid, and no catalog_id');
}

// ─── Test 8: single RPC call with both p_isrc and p_recording_mbid ───────────

async function test_single_post_when_both_present() {
  console.log('\n[8] Efficiency — single RPC call when both isrc and mbid present; both passed as params');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  const mbid = 'cccccccc-dddd-eeee-ffff-000000000008';
  await syncEnrichmentToGraph('test-artist', [
    baseTrack({
      isrc:           'USABC1234567',
      recording_mbid: mbid,
    }),
  ]);

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCalls.length === 1,
    `exactly 1 RPC call — got ${rpcCalls.length}`);
  assert(rpcCalls[0]?.body?.p_isrc === 'USABC1234567',
    `p_isrc present (got "${rpcCalls[0]?.body?.p_isrc}")`);
  assert(rpcCalls[0]?.body?.p_recording_mbid === mbid,
    `p_recording_mbid present (got "${rpcCalls[0]?.body?.p_recording_mbid}")`);
}

// ─── Tests 9-12: enrichArtistCatalog() camelCase payload shape ───────────────
//
// These cover the field-name mismatch bug (Task C):
//   enrichArtistCatalog() produces { trackTitle, isrcs[], recordingMBID }
//   The old syncEnrichmentToGraph expected { title, isrc, catalog_id }
//   → complete silent no-op. These tests prove the fix works.

// Mock for camelCase-shape enrichment tracks (tests 9-12).
// After v2 fix: no graph.nodes GETs, no compositions PATCHes — only RPC calls.
const ENRICH_WORK_NODE_UUID = 'eeeeeeee-0000-0000-0000-000000000099';
const ENRICH_REC_NODE_UUID  = 'ffffffff-0000-0000-0000-000000000099';

function makeMockFetchEnrich(calls) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body   = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });

    // Public RPC — single entry point for enrichment recording writes.
    if (url.includes('/rpc/rpc_upsert_recording_enrichment')) return ok({ node_id: ENRICH_REC_NODE_UUID });

    // graph.nodes GET must NOT happen from enrichment path after v2 fix.
    if (method === 'GET' && url.includes('/rest/v1/nodes')) {
      throw new Error(`REGRESSION: graph.nodes GET from enrichment path: ${url}`);
    }
    // Compositions PATCH removed from enrichment path in v2.
    if (method === 'PATCH' && url.includes('/v1/compositions')) {
      throw new Error('REGRESSION: compositions PATCH from enrichment path — removed in v2');
    }
    if (method === 'PATCH' && url.includes('graph_nodes_v1'))   return ok(null);
    if (url.includes('/rpc/graph_upsert_node'))
      return { ok: false, status: 403, text: async () => '{"error":"graph_upsert_node must not be called from enrichment path"}' };
    if (method === 'POST' && url.includes('/v1/recordings'))
      return { ok: false, status: 403, text: async () => '{"error":"direct recordings POST must not be called from enrichment path"}' };
    return { ok: false, status: 404, text: async () => `{"error":"unexpected mock call: ${method} ${url}"}` };
  };
}

// ─── Test 9: trackTitle normalised → p_label, isrcs[0] → p_isrc ─────────────

async function test_camelcase_trackTitle_normalised() {
  console.log('\n[9] Field mismatch fix — trackTitle → p_label, isrcs[0] → p_isrc (camelCase shape)');

  const calls = [];
  global.fetch = makeMockFetchEnrich(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [{
    trackTitle:    'Rebel Rap',
    isrcs:         ['USABC9999999'],
    recordingMBID: 'eeeeeeee-ffff-0000-1111-222222222222',
    iswc:          null,
    // no catalog_id — enrichment-only track
  }]);

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(!!rpcCall, 'rpc_upsert_recording_enrichment fires for enrichArtistCatalog camelCase shape');
  assert(rpcCall?.body?.p_label === 'Rebel Rap',
    `p_label set from trackTitle (got "${rpcCall?.body?.p_label}")`);
  assert(rpcCall?.body?.p_isrc === 'USABC9999999',
    `p_isrc set from isrcs[0] (got "${rpcCall?.body?.p_isrc}")`);
  assert(!rpcCall?.body?.p_catalog_track_id,
    'p_catalog_track_id null for enrichment-only track (no catalog_id)');
}

// ─── Test 10: isrcs[0] uppercased → p_isrc ───────────────────────────────────

async function test_isrcs_array_normalised() {
  console.log('\n[10] Field mismatch fix — isrcs[0] uppercased and passed as p_isrc');

  const calls = [];
  global.fetch = makeMockFetchEnrich(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [{
    trackTitle: 'Rebel Rap',
    isrcs:      ['usabc9999999'],  // lowercase to test uppercasing
    recordingMBID: null,
  }]);

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(!!rpcCall, 'rpc_upsert_recording_enrichment called when ISRC provided via isrcs[]');
  assert(rpcCall?.body?.p_isrc === 'USABC9999999',
    `isrcs[0] uppercased correctly in p_isrc (got "${rpcCall?.body?.p_isrc}")`);
}

// ─── Test 11: No ISRC — MBID passed as p_recording_mbid; RPC resolves key ────
//
// Old behavior: JS chose external_id = MBID, external_id_ns = 'musicbrainz_recording'.
// New behavior: JS passes p_recording_mbid = MBID; the RPC resolves which key to use.

async function test_mbid_as_external_key_when_no_isrc() {
  console.log('\n[11] Field mismatch fix — MBID-only: p_recording_mbid set, p_isrc null, no graph.nodes GET');

  const calls = [];
  global.fetch = makeMockFetchEnrich(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  const mbid = 'eeeeeeee-ffff-0000-1111-333333333333';
  await syncEnrichmentToGraph('test-artist', [{
    trackTitle:    'Rebel Rap',
    isrcs:         [],           // no ISRC
    recordingMBID: mbid,
  }]);

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(!!rpcCall, 'rpc_upsert_recording_enrichment called');
  assert(rpcCall?.body?.p_recording_mbid === mbid,
    `p_recording_mbid is the MBID (got "${rpcCall?.body?.p_recording_mbid}")`);
  assert(!rpcCall?.body?.p_isrc,
    `p_isrc is null when no ISRC (got "${rpcCall?.body?.p_isrc}")`);
  assert(!('p_external_id' in (rpcCall?.body || {})),
    'p_external_id absent from v2 RPC body');
  assert(!('p_external_id_ns' in (rpcCall?.body || {})),
    'p_external_id_ns absent from v2 RPC body');
}

// ─── Test 12: Recording upsert fires (compositions PATCH no longer in path) ───
//
// In v2, syncEnrichmentToGraph never calls compositions PATCH. The recording
// RPC always fires if a recording identifier is present, regardless of work node.

async function test_recording_upsert_independent_of_work_node() {
  console.log('\n[12] Field mismatch fix — recording RPC fires; compositions PATCH absent from enrichment v2');

  const calls = [];
  global.fetch = makeMockFetchEnrich(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  const mbid = 'eeeeeeee-ffff-0000-1111-444444444444';
  await syncEnrichmentToGraph('test-artist', [{
    trackTitle:    'Unknown Title',
    isrcs:         ['USABC9999999'],
    recordingMBID: mbid,
  }]);

  const workPatch = calls.find(c =>
    c.method === 'PATCH' && c.url.includes('/v1/compositions'));
  assert(!workPatch, 'compositions PATCH absent from enrichment path in v2');

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(!!rpcCall, 'rpc_upsert_recording_enrichment fires');
  assert(rpcCall?.body?.p_recording_mbid === mbid,
    `p_recording_mbid correct (got "${rpcCall?.body?.p_recording_mbid}")`);
}

// ─── Tests 13-14: Confirmed base table name regression ───────────────────────
//
// works.works_recordings_v1 does NOT exist in production.
// The confirmed base table is works.recordings.
// public.works_recordings_v1 is a VIEW over works.recordings (read via PostgREST
// default schema, no Accept-Profile header).

// ─── Test 13: syncEnrichmentToGraph URL never references works_recordings_v1 ──

async function test_enrichment_never_hits_works_recordings_v1() {
  console.log('\n[13] Base table — syncEnrichmentToGraph uses rpc_upsert_recording_enrichment, never works_recordings_v1');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('test-artist', [
    baseTrack({ isrc: 'USABC1234567', recordingMBID: 'cccccccc-dddd-eeee-ffff-000000000013' }),
  ]);

  const wrongCalls = calls.filter(c => c.url.includes('works_recordings_v1'));
  assert(wrongCalls.length === 0,
    `no call references works_recordings_v1 (nonexistent relation) — got ${wrongCalls.length}`);

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCalls.length === 1,
    `exactly 1 call to rpc_upsert_recording_enrichment — got ${rpcCalls.length}`);
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
    if (method === 'GET' && url.includes('/rest/v1/nodes')) return ok([]);
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

// ─── Test 15: syncEnrichmentToGraph — no compositions PATCH in v2 ─────────────
//
// In v2, the compositions PATCH section is removed from syncEnrichmentToGraph.
// A track with iswc + catalog_id (but no ISRC/MBID) triggers the recording RPC
// via catalog_track_id, but never PATCHes compositions.

async function test_enrichment_never_hits_works_compositions_v1() {
  console.log('\n[15] v2 — compositions PATCH removed from enrichment path; RPC called for catalog_track_id');

  const calls = [];
  global.fetch = makeMockFetch(calls);
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  // baseTrack has catalog_id 'my-catalog-id'; no isrc/mbid.
  // v2: guard is (normalIsrc || recordingMbid || catalogId) → true (catalogId set).
  await syncEnrichmentToGraph('test-artist', [
    baseTrack({ iswc: 'T-123.456.789-C' }),
  ]);

  const wrongCalls = calls.filter(c => c.url.includes('works_compositions_v1'));
  assert(wrongCalls.length === 0,
    `no call references works_compositions_v1 — got ${wrongCalls.length}`);

  const compositionPatches = calls.filter(c =>
    c.method === 'PATCH' && c.url.includes('/v1/compositions'));
  assert(compositionPatches.length === 0,
    `compositions PATCH NOT called in v2 enrichment path — got ${compositionPatches.length}`);

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCalls.length === 1,
    `recording RPC called once for catalog_track_id identity — got ${rpcCalls.length}`);
  assert(rpcCalls[0]?.body?.p_catalog_track_id === 'my-catalog-id',
    `p_catalog_track_id set (got "${rpcCalls[0]?.body?.p_catalog_track_id}")`);
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
    if (method === 'GET' && url.includes('/rest/v1/nodes')) return ok([]);
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

// ─── Test 17: syncCatalogToGraph uses canonical edge types (no recorded_as/performed_by) ──

async function test_catalog_sync_canonical_edge_types() {
  console.log('\n[17] syncCatalogToGraph: has_recording (work→rec) and performed (artist→rec), no recorded_as/performed_by');

  const ARTIST_UUID  = 'eeeeeeee-1700-0000-0000-000000000017';
  const CREATOR_UUID = 'ffffffff-1700-0000-0000-000000000017';
  const WORK_UUID    = 'aaaaaaaa-1700-0000-0000-000000000017';
  const REC_UUID     = 'bbbbbbbb-1700-0000-0000-000000000017';
  const edgeBodies   = [];
  let nodeUpsertCount = 0;

  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body   = opts.body ? JSON.parse(opts.body) : null;

    if (url.includes('/rpc/graph_upsert_node')) {
      nodeUpsertCount++;
      return ok(nodeUpsertCount === 1 ? WORK_UUID : REC_UUID);
    }
    if (url.includes('/rpc/graph_upsert_edge')) {
      edgeBodies.push(body);
      return ok(null);
    }
    if (method === 'GET' && url.includes('/rest/v1/nodes')) {
      if (url.includes('external_id=eq.artist-id-17') && url.includes('musigod_artist') && !url.includes('creator_')) {
        return ok([{ id: ARTIST_UUID }]);
      }
      if (url.includes('external_id=eq.creator_artist-id-17')) {
        return ok([{ id: CREATOR_UUID }]);
      }
      return ok([]);
    }
    if (method === 'POST' && url.includes('/v1/compositions')) return ok(null);
    if (method === 'POST' && url.includes('/v1/recordings'))   return ok(null);
    return { ok: false, status: 404, text: async () => `unexpected: ${method} ${url}` };
  };

  const { syncCatalogToGraph } = loadFreshGraphSync();
  await syncCatalogToGraph('artist-id-17', [{
    catalog_id:  'cat-edge-17',
    track_title: 'Edge Type Test',
  }]);

  const hasRecEdge = edgeBodies.find(b => b?.p_edge_type === 'has_recording');
  assert(!!hasRecEdge, 'has_recording edge created');
  if (hasRecEdge) {
    assert(hasRecEdge.p_from_node_id === WORK_UUID,
      `has_recording: from_node_id is work UUID (${hasRecEdge.p_from_node_id})`);
    assert(hasRecEdge.p_to_node_id === REC_UUID,
      `has_recording: to_node_id is recording UUID (${hasRecEdge.p_to_node_id})`);
  }

  const performedEdge = edgeBodies.find(b => b?.p_edge_type === 'performed');
  assert(!!performedEdge, 'performed edge created');
  if (performedEdge) {
    assert(performedEdge.p_from_node_id === ARTIST_UUID,
      `performed: from_node_id is artist UUID (${performedEdge.p_from_node_id})`);
    assert(performedEdge.p_to_node_id === REC_UUID,
      `performed: to_node_id is recording UUID (${performedEdge.p_to_node_id})`);
  }

  const invalidEdges = edgeBodies.filter(b =>
    b?.p_edge_type === 'recorded_as' || b?.p_edge_type === 'performed_by');
  assert(invalidEdges.length === 0,
    `no recorded_as or performed_by edge calls (got ${invalidEdges.length})`);
}

// ─── Test 18: RPC missing (404) — syncEnrichmentToGraph returns failed stats, does not throw ──

async function test_rpc_missing_returns_failed_stats_not_throw() {
  console.log('\n[18] RPC missing (404) — syncEnrichmentToGraph returns {synced:0, failed:N}, does not throw');

  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  global.fetch = async (url, opts = {}) => {
    if (url.includes('/rpc/rpc_upsert_recording_enrichment')) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'function public.rpc_upsert_recording_enrichment() does not exist' }) };
    }
    if ((opts.method === 'GET' || !opts.method) && url.includes('/rest/v1/nodes')) return ok([]);
    return { ok: false, status: 404, text: async () => '{"error":"unexpected"}' };
  };

  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  let result;
  let threw = false;
  try {
    result = await syncEnrichmentToGraph('artist-rpc-missing', [
      { trackTitle: 'Track One', isrcs: ['USRPC0000001'], recordingMBID: 'mbid-rpc-0001' },
      { trackTitle: 'Track Two', isrcs: ['USRPC0000002'], recordingMBID: 'mbid-rpc-0002' },
    ]);
  } catch (e) {
    threw = true;
  }

  assert(!threw,             'syncEnrichmentToGraph does NOT throw when RPC is missing');
  assert(result?.synced === 0, `synced count is 0 (got ${result?.synced})`);
  assert(result?.failed === 2, `failed count equals track count: 2 (got ${result?.failed})`);
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
    await test_catalog_sync_canonical_edge_types();
    await test_rpc_missing_returns_failed_stats_not_throw();
  } finally {
    // nothing to restore
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
