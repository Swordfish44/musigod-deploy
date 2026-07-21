'use strict';
// tests/graph-rls.test.js
//
// Authorization and idempotency tests for the graph RLS lockdown patch
// (supabase/migrations/20260721_graph_rls_lockdown.sql).
//
// These tests cover two properties:
//
//   AUTHORIZATION — every enrichment write call goes to public schema
//   (rpc_upsert_recording_enrichment), carries the service_role key, and
//   does NOT directly access graph.* or works.* tables via REST.
//
//   IDEMPOTENCY — calling syncEnrichmentToGraph twice with identical data
//   produces the same result: same node_id used, COALESCE semantics so the
//   second run does not clobber values written by the first.
//
// Run: node tests/graph-rls.test.js

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else       { console.error(`  ❌ FAIL: ${label}`); failed++; }
}

const SB_URL = 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const REC_UUID = 'aaaaaaaa-1111-0000-0000-000000000001';
const WORK_UUID = 'bbbbbbbb-2222-0000-0000-000000000002';

function loadFreshGraphSync() {
  delete require.cache[require.resolve('../api/graph-sync')];
  return require('../api/graph-sync');
}

// Standard mock: handles the public RPC and the guard GET calls (graph.nodes).
// graph_upsert_node is deliberately absent — any call to it from the enrichment
// path is an unexpected call and will throw so the test catches the regression.
function makeRlsMock({ calls = [], existingNodeId = null, rpcNodeId = REC_UUID } = {}) {
  return async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body });

    // New public RPC — used by the enrichment write path.
    if (url.includes('/rpc/rpc_upsert_recording_enrichment')) {
      return { ok: true, text: async () => JSON.stringify({ node_id: rpcNodeId }) };
    }

    // graph.nodes GET — used by duplicate-row guards in syncEnrichmentToGraph.
    // service_role can still read this even after the lockdown.
    if ((opts.method === 'GET' || !opts.method) && url.includes('/rest/v1/nodes')) {
      const row = existingNodeId ? [{ id: existingNodeId }] : [];
      return { ok: true, text: async () => JSON.stringify(row) };
    }

    // OLD enrichment paths — should NOT appear after the patch.
    if (url.includes('/rpc/graph_upsert_node')) {
      throw new Error(`REGRESSION: graph_upsert_node called from enrichment path (${url})`);
    }
    if (opts.method === 'POST' && url.includes('/rest/v1/recordings')) {
      throw new Error(`REGRESSION: direct POST to /v1/recordings from enrichment path (${url})`);
    }
    if (opts.method === 'PATCH' && url.includes('/v1/compositions')) {
      return { ok: true, text: async () => '' }; // composition patch is still allowed
    }

    throw new Error(`Unexpected fetch: ${opts.method || 'GET'} ${url}`);
  };
}

// ── AUTH-1: enrichment write uses public schema, not graph or works ──────────

async function test_auth1_rpc_in_public_schema() {
  console.log('\n[AUTH-1] Public schema — enrichment write goes to /rpc/rpc_upsert_recording_enrichment');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

  const calls = [];
  global.fetch = makeRlsMock({ calls });
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Test Track', isrcs: ['USAAA1234567'], recordingMBID: null,
  }]);

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(!!rpcCall, 'rpc_upsert_recording_enrichment called');
  assert(rpcCall?.url === `${SB_URL}/rest/v1/rpc/rpc_upsert_recording_enrichment`,
    `exact URL is the public-schema RPC endpoint (got "${rpcCall?.url}")`);

  const illegalSchemaHeaders = calls.filter(c =>
    c.headers?.['Accept-Profile'] === 'graph' ||
    c.headers?.['Accept-Profile'] === 'works' ||
    c.headers?.['Content-Profile'] === 'graph' ||
    c.headers?.['Content-Profile'] === 'works'
  ).filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(illegalSchemaHeaders.length === 0,
    'new RPC call does not send Accept-Profile: graph or works header');
}

// ── AUTH-2: service_role key present on every call ───────────────────────────

async function test_auth2_service_role_key_on_every_call() {
  console.log('\n[AUTH-2] Service-role key sent on every fetch call');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

  const calls = [];
  global.fetch = makeRlsMock({ calls });
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Test Track', isrcs: ['USAAA1234567'], recordingMBID: 'mbid-auth2-0000',
  }]);

  const noKey = calls.filter(c =>
    c.headers?.['Authorization'] !== 'Bearer test-service-role-key' ||
    c.headers?.['apikey'] !== 'test-service-role-key'
  );
  assert(noKey.length === 0,
    `all ${calls.length} fetch calls include Authorization + apikey service_role headers`);
}

// ── AUTH-3: no direct REST access to graph.nodes for writes ─────────────────

async function test_auth3_no_direct_write_to_graph_tables() {
  console.log('\n[AUTH-3] No direct REST write (POST/PATCH/DELETE) to graph.* or works.* tables');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

  const calls = [];
  global.fetch = makeRlsMock({ calls });
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('TestArtist', [
    { trackTitle: 'Track A', isrcs: ['USAAA1111111'], recordingMBID: 'mbid-a' },
    { trackTitle: 'Track B', isrcs: [],               recordingMBID: 'mbid-b' },
  ]);

  const directTableWrites = calls.filter(c =>
    ['POST', 'PATCH', 'DELETE', 'PUT'].includes(c.method) &&
    (c.headers?.['Accept-Profile'] === 'graph' || c.headers?.['Content-Profile'] === 'graph' ||
     c.headers?.['Accept-Profile'] === 'works'  || c.headers?.['Content-Profile'] === 'works') &&
    !c.url.includes('/rpc/')
  );
  assert(directTableWrites.length === 0,
    `no direct table writes to graph or works schemas (found ${directTableWrites.length})`);
}

// ── AUTH-4: guard reads (GET graph.nodes) carry service_role key ─────────────

async function test_auth4_guard_reads_carry_service_role_key() {
  console.log('\n[AUTH-4] Duplicate-row guard GETs to graph.nodes carry service_role key');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

  const calls = [];
  const mbid = 'mbid-auth4-0000';
  global.fetch = makeRlsMock({ calls, existingNodeId: null });
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Test', isrcs: ['USAAA9999999'], recordingMBID: mbid,
  }]);

  const guardGets = calls.filter(c =>
    (c.method === 'GET' || !c.method) &&
    c.url.includes('/rest/v1/nodes')
  );
  assert(guardGets.length >= 1, 'at least one guard GET to graph.nodes was made');
  const allHaveKey = guardGets.every(c =>
    c.headers?.['Authorization'] === 'Bearer test-service-role-key'
  );
  assert(allHaveKey, 'all guard GETs carry the service_role Authorization header');
}

// ── IDEM-1: same track twice → same node_id, RPC called twice ────────────────

async function test_idem1_same_track_twice_same_node_id() {
  console.log('\n[IDEM-1] Idempotency — same track synced twice uses the same node_id');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  // upsertRecordingEnrichment always returns the same UUID (DB-level idempotency).
  global.fetch = makeRlsMock({ calls, rpcNodeId: REC_UUID });
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  const track = { trackTitle: 'Idempotent Track', isrcs: ['USIDEM000001'], recordingMBID: null };
  await syncEnrichmentToGraph('TestArtist', [track]);
  await syncEnrichmentToGraph('TestArtist', [track]);

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCalls.length === 2, `RPC called once per run — 2 total (got ${rpcCalls.length})`);

  const externalIds = rpcCalls.map(c => c.body?.p_external_id);
  assert(externalIds[0] === 'USIDEM000001' && externalIds[1] === 'USIDEM000001',
    'both calls use the same external_id (ISRC)');

  const schemas = rpcCalls.map(c => c.body?.p_external_id_ns);
  assert(schemas.every(s => s === 'isrc'), `both calls use isrc namespace (got ${JSON.stringify(schemas)})`);
}

// ── IDEM-2: composition_node_id sent on first run, absent on second ──────────

async function test_idem2_composition_node_id_coalesce() {
  console.log('\n[IDEM-2] Idempotency — p_composition_node_id passed when known, null on re-run leaves DB unchanged');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  // Simulate: first run has a work node (WORK_UUID); second run has no iswc/catalogId
  // so workNodeId resolves to null. The DB-side COALESCE should preserve the first run's value.
  let callIndex = 0;
  global.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body });

    if (url.includes('/rpc/rpc_upsert_recording_enrichment')) {
      callIndex++;
      return { ok: true, text: async () => JSON.stringify({ node_id: REC_UUID }) };
    }
    if ((opts.method === 'GET' || !opts.method) && url.includes('/rest/v1/nodes')) {
      // First call: work node found; subsequent: not found (run 2 no longer has iswc).
      if (callIndex === 0 && url.includes('musigod_catalog')) {
        return { ok: true, text: async () => JSON.stringify([{ id: WORK_UUID }]) };
      }
      return { ok: true, text: async () => JSON.stringify([]) };
    }
    throw new Error(`Unexpected: ${opts.method || 'GET'} ${url}`);
  };

  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  // Run 1: has catalog_id → work node found → composition_node_id set.
  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Coalesce Track',
    catalog_id: 'cat-coalesce-01',
    isrcs: ['USCOA0000002'],
    recordingMBID: null,
  }]);

  // Run 2: no catalog_id, no iswc → work node not found → composition_node_id is null.
  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Coalesce Track',
    isrcs: ['USCOA0000002'],
    recordingMBID: null,
  }]);

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCalls.length === 2, `two RPC calls made (got ${rpcCalls.length})`);
  assert(rpcCalls[0]?.body?.p_composition_node_id === WORK_UUID,
    `run 1: p_composition_node_id = WORK_UUID (got "${rpcCalls[0]?.body?.p_composition_node_id}")`);
  assert(rpcCalls[1]?.body?.p_composition_node_id === null,
    `run 2: p_composition_node_id = null (DB COALESCE will preserve run-1 value) (got "${rpcCalls[1]?.body?.p_composition_node_id}")`);
}

// ── IDEM-3: guard path sends p_existing_node_id, not p_external_id ───────────

async function test_idem3_guard_path_sends_existing_node_id() {
  console.log('\n[IDEM-3] Guard path — p_existing_node_id sent when prior node found; p_external_id is null');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const MBID_UUID = 'cccccccc-3333-0000-0000-000000000003';
  const mbid = 'mbid-guard-idem3-0000';
  const calls = [];

  global.fetch = makeRlsMock({ calls, existingNodeId: MBID_UUID });
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  // Track has ISRC (so guard fires) + MBID (guard finds MBID_UUID).
  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Guard Track', isrcs: ['USGUARD00003'], recordingMBID: mbid,
  }]);

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(!!rpcCall, 'RPC was called');
  assert(rpcCall?.body?.p_existing_node_id === MBID_UUID,
    `p_existing_node_id is the guard-found UUID (got "${rpcCall?.body?.p_existing_node_id}")`);
  assert(rpcCall?.body?.p_external_id === null,
    `p_external_id is null when existing node known (got "${rpcCall?.body?.p_external_id}")`);
  assert(rpcCall?.body?.p_recording_patch?.isrc === 'USGUARD00003',
    `ISRC still in recording_patch for works.recordings update (got "${rpcCall?.body?.p_recording_patch?.isrc}")`);
}

// ── IDEM-4: no isrc + no mbid → RPC never called ────────────────────────────

async function test_idem4_no_identifiers_no_rpc() {
  console.log('\n[IDEM-4] No ISRC or MBID → public RPC never called');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  // Only allow guard GETs and composition patch; throw on anything else.
  global.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body });
    if ((opts.method === 'GET' || !opts.method) && url.includes('/rest/v1/nodes'))
      return { ok: true, text: async () => JSON.stringify([]) };
    if (opts.method === 'PATCH' && url.includes('/v1/compositions'))
      return { ok: true, text: async () => '' };
    if (url.includes('/rpc/rpc_upsert_recording_enrichment'))
      throw new Error('REGRESSION: RPC called with no ISRC/MBID');
    throw new Error(`Unexpected: ${opts.method || 'GET'} ${url}`);
  };

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  await syncEnrichmentToGraph('TestArtist', [
    { trackTitle: 'No IDs', iswc: 'T-111.222.333-C' },  // only iswc, no isrc/mbid
  ]);

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCalls.length === 0, 'rpc_upsert_recording_enrichment NOT called when no ISRC/MBID');
}

// ── IDEM-5: MBID-only path → keyed by musicbrainz_recording namespace ────────

async function test_idem5_mbid_only_keyed_by_mbid_ns() {
  console.log('\n[IDEM-5] MBID-only track — RPC uses musicbrainz_recording namespace');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const mbid = 'mbid-only-idem5-0000';
  const calls = [];
  global.fetch = makeRlsMock({ calls });
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('TestArtist', [
    { trackTitle: 'MBID Only', isrcs: [], recordingMBID: mbid },
  ]);

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(!!rpcCall, 'RPC called for MBID-only track');
  assert(rpcCall?.body?.p_external_id === mbid,
    `p_external_id is the MBID (got "${rpcCall?.body?.p_external_id}")`);
  assert(rpcCall?.body?.p_external_id_ns === 'musicbrainz_recording',
    `p_external_id_ns is musicbrainz_recording (got "${rpcCall?.body?.p_external_id_ns}")`);
  assert(rpcCall?.body?.p_existing_node_id === null,
    `p_existing_node_id is null (no guard on MBID-only path) (got "${rpcCall?.body?.p_existing_node_id}")`);
  assert(rpcCall?.body?.p_recording_patch?.musicbrainz_recording_id === mbid,
    `p_recording_patch.musicbrainz_recording_id correct (got "${rpcCall?.body?.p_recording_patch?.musicbrainz_recording_id}")`);
}

// ── IDEM-6: RPC missing (404) → synced=0, failed=N, no throw ────────────────

async function test_idem6_rpc_missing_fails_gracefully() {
  console.log('\n[IDEM-6] RPC missing (404) → syncEnrichmentToGraph returns {synced:0,failed:N}, does not throw');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  global.fetch = async (url, opts = {}) => {
    if (url.includes('/rpc/rpc_upsert_recording_enrichment')) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'function does not exist' }) };
    }
    if ((opts.method === 'GET' || !opts.method) && url.includes('/rest/v1/nodes'))
      return { ok: true, text: async () => JSON.stringify([]) };
    return { ok: false, status: 404, text: async () => '{"error":"unexpected"}' };
  };

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  let result; let threw = false;
  try {
    result = await syncEnrichmentToGraph('TestArtist', [
      { trackTitle: 'Track A', isrcs: ['USRPC0000001'] },
      { trackTitle: 'Track B', isrcs: ['USRPC0000002'] },
    ]);
  } catch (e) {
    threw = true;
  }

  assert(!threw,            'syncEnrichmentToGraph does not throw when RPC missing');
  assert(result?.synced === 0, `synced is 0 (got ${result?.synced})`);
  assert(result?.failed === 2, `failed equals track count: 2 (got ${result?.failed})`);
}

// ── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== graph-rls.test.js ===');
  console.log('Migration: 20260721_graph_rls_lockdown.sql\n');

  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

  await test_auth1_rpc_in_public_schema();
  await test_auth2_service_role_key_on_every_call();
  await test_auth3_no_direct_write_to_graph_tables();
  await test_auth4_guard_reads_carry_service_role_key();
  await test_idem1_same_track_twice_same_node_id();
  await test_idem2_composition_node_id_coalesce();
  await test_idem3_guard_path_sends_existing_node_id();
  await test_idem4_no_identifiers_no_rpc();
  await test_idem5_mbid_only_keyed_by_mbid_ns();
  await test_idem6_rpc_missing_fails_gracefully();

  console.log(`\n${'─'.repeat(50)}`);
  const total = passed + failed;
  if (failed > 0) {
    console.error(`${total} assertions | ${passed} passed | ${failed} FAILED`);
  } else {
    console.log(`${total} assertions | ${total} passed`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
