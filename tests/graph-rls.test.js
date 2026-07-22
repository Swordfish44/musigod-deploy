'use strict';
// tests/graph-rls.test.js
//
// Authorization and idempotency tests for the graph RLS lockdown patch
// (supabase/migrations/20260721_graph_rls_lockdown.sql) and the v2
// recording enrichment RPC
// (supabase/migrations/20260722_rpc_recording_enrichment_v2.sql).
//
// These tests cover two properties:
//
//   AUTHORIZATION — every enrichment write call goes to public schema
//   (rpc_upsert_recording_enrichment), carries the service_role key, and
//   does NOT directly access graph.* or works.* tables via REST.
//
//   IDEMPOTENCY — calling syncEnrichmentToGraph twice with identical data
//   produces the same result: same identity keys passed, COALESCE semantics
//   in the DB so the second run does not clobber values from the first.
//
// v2 design change: identity lookup (ISRC → MBID → catalog_track_id) moved
// inside the SECURITY DEFINER function. JS no longer makes GET /rest/v1/nodes
// calls from the enrichment path — any such call is a regression.
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

function loadFreshGraphSync() {
  delete require.cache[require.resolve('../api/graph-sync')];
  return require('../api/graph-sync');
}

// Standard mock: handles the public RPC only.
// GET /rest/v1/nodes throws — any JS-level graph.nodes lookup is a regression
// (identity resolution now lives inside the SECURITY DEFINER function).
// graph_upsert_node and direct table writes also throw.
function makeRlsMock({ calls = [], rpcNodeId = REC_UUID } = {}) {
  return async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body });

    // New public RPC — used by the enrichment write path.
    if (url.includes('/rpc/rpc_upsert_recording_enrichment')) {
      return { ok: true, text: async () => JSON.stringify({ node_id: rpcNodeId }) };
    }

    // REGRESSION guards — these must never appear from the enrichment path in v2.
    if ((opts.method === 'GET' || !opts.method) && url.includes('/rest/v1/nodes')) {
      throw new Error(`REGRESSION: graph.nodes GET called from enrichment path — lookup must be inside SECURITY DEFINER function (${url})`);
    }
    if (url.includes('/rpc/graph_upsert_node')) {
      throw new Error(`REGRESSION: graph_upsert_node called from enrichment path (${url})`);
    }
    if (opts.method === 'POST' && url.includes('/rest/v1/recordings')) {
      throw new Error(`REGRESSION: direct POST to /v1/recordings from enrichment path (${url})`);
    }
    if (opts.method === 'PATCH' && url.includes('/v1/compositions')) {
      throw new Error(`REGRESSION: direct PATCH to /v1/compositions from enrichment path (${url})`);
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

// ── AUTH-4: no JS-level guard GETs — lookup lives inside the DB ─────────────

async function test_auth4_no_js_guard_reads() {
  console.log('\n[AUTH-4] No JS-level guard GETs — identity lookup is inside the SECURITY DEFINER function');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

  const calls = [];
  const mbid = 'mbid-auth4-0000';
  global.fetch = makeRlsMock({ calls });
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Test', isrcs: ['USAAA9999999'], recordingMBID: mbid,
  }]);

  const guardGets = calls.filter(c =>
    (c.method === 'GET' || !c.method) && c.url.includes('/rest/v1/nodes')
  );
  assert(guardGets.length === 0,
    `zero graph.nodes GETs from JS enrichment path (got ${guardGets.length})`);

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(!!rpcCall, 'RPC IS called with both identity keys');
  assert(rpcCall?.body?.p_isrc === 'USAAA9999999',
    `p_isrc passed to RPC (got "${rpcCall?.body?.p_isrc}")`);
  assert(rpcCall?.body?.p_recording_mbid === mbid,
    `p_recording_mbid passed to RPC (got "${rpcCall?.body?.p_recording_mbid}")`);
}

// ── IDEM-1: same track twice → same identity key sent both times ─────────────

async function test_idem1_same_track_twice_same_node_id() {
  console.log('\n[IDEM-1] Idempotency — same track synced twice sends the same identity key');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  global.fetch = makeRlsMock({ calls, rpcNodeId: REC_UUID });
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  const track = { trackTitle: 'Idempotent Track', isrcs: ['USIDEM000001'], recordingMBID: null };
  await syncEnrichmentToGraph('TestArtist', [track]);
  await syncEnrichmentToGraph('TestArtist', [track]);

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCalls.length === 2, `RPC called once per run — 2 total (got ${rpcCalls.length})`);

  const isrcs = rpcCalls.map(c => c.body?.p_isrc);
  assert(isrcs[0] === 'USIDEM000001' && isrcs[1] === 'USIDEM000001',
    `both calls send p_isrc = USIDEM000001 (got ${JSON.stringify(isrcs)})`);

  const mbids = rpcCalls.map(c => c.body?.p_recording_mbid);
  assert(mbids.every(m => m === null || m === undefined),
    `p_recording_mbid is null on both calls (got ${JSON.stringify(mbids)})`);

  const guardGets = calls.filter(c =>
    (c.method === 'GET' || !c.method) && c.url.includes('/rest/v1/nodes')
  );
  assert(guardGets.length === 0, `no graph.nodes GETs made (got ${guardGets.length})`);
}

// ── IDEM-2: composition_node_id always null from JS — DB COALESCE handles it ─

async function test_idem2_composition_node_id_null_from_js() {
  console.log('\n[IDEM-2] Idempotency — composition_node_id always null from JS (DB COALESCE preserves prior value)');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  global.fetch = makeRlsMock({ calls, rpcNodeId: REC_UUID });
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  // Run 1: has catalog_id — in v2 the JS layer no longer looks up a work node.
  // composition_node_id is always null from JS; the DB COALESCE ensures a prior
  // value from another code path is never overwritten by a null.
  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Coalesce Track',
    catalog_id: 'cat-coalesce-01',
    isrcs: ['USCOA0000002'],
    recordingMBID: null,
  }]);

  // Run 2: same track, same result.
  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Coalesce Track',
    isrcs: ['USCOA0000002'],
    recordingMBID: null,
  }]);

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCalls.length === 2, `two RPC calls made (got ${rpcCalls.length})`);
  assert(rpcCalls[0]?.body?.p_composition_node_id === null,
    `run 1: p_composition_node_id is null — work-node lookup removed from JS (got "${rpcCalls[0]?.body?.p_composition_node_id}")`);
  assert(rpcCalls[1]?.body?.p_composition_node_id === null,
    `run 2: p_composition_node_id is null (got "${rpcCalls[1]?.body?.p_composition_node_id}")`);

  const guardGets = calls.filter(c =>
    (c.method === 'GET' || !c.method) && c.url.includes('/rest/v1/nodes')
  );
  assert(guardGets.length === 0, `no graph.nodes GETs on either run (got ${guardGets.length})`);
}

// ── IDEM-3: ISRC + MBID track → both keys forwarded, no JS guard lookup ──────

async function test_idem3_both_keys_forwarded_no_guard_lookup() {
  console.log('\n[IDEM-3] ISRC + MBID track — both keys forwarded to RPC, zero JS-level guard lookups');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const mbid = 'mbid-guard-idem3-0000';
  const calls = [];

  global.fetch = makeRlsMock({ calls });
  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Guard Track', isrcs: ['USGUARD00003'], recordingMBID: mbid,
  }]);

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(!!rpcCall, 'RPC was called');
  assert(rpcCall?.body?.p_isrc === 'USGUARD00003',
    `p_isrc forwarded to RPC (got "${rpcCall?.body?.p_isrc}")`);
  assert(rpcCall?.body?.p_recording_mbid === mbid,
    `p_recording_mbid forwarded to RPC (got "${rpcCall?.body?.p_recording_mbid}")`);

  const guardGets = calls.filter(c =>
    (c.method === 'GET' || !c.method) && c.url.includes('/rest/v1/nodes')
  );
  assert(guardGets.length === 0,
    `zero guard GETs from JS — lookup is inside DB function (got ${guardGets.length})`);

  // Old params must not be present in the RPC body
  assert(!('p_existing_node_id' in (rpcCall?.body || {})),
    'p_existing_node_id absent from RPC body (old param removed)');
  assert(!('p_external_id' in (rpcCall?.body || {})),
    'p_external_id absent from RPC body (old param removed)');
}

// ── IDEM-4: no isrc + no mbid + no catalog_id → RPC never called ─────────────

async function test_idem4_no_identifiers_no_rpc() {
  console.log('\n[IDEM-4] No ISRC, MBID, or catalog_id → public RPC never called');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body });
    if (url.includes('/rpc/rpc_upsert_recording_enrichment'))
      throw new Error('REGRESSION: RPC called with no ISRC/MBID/catalog_id');
    if ((opts.method === 'GET' || !opts.method) && url.includes('/rest/v1/nodes'))
      throw new Error('REGRESSION: graph.nodes GET called from enrichment path');
    if (opts.method === 'PATCH' && url.includes('/v1/compositions'))
      throw new Error('REGRESSION: compositions PATCH called from enrichment path');
    throw new Error(`Unexpected: ${opts.method || 'GET'} ${url}`);
  };

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  await syncEnrichmentToGraph('TestArtist', [
    { trackTitle: 'No IDs', iswc: 'T-111.222.333-C' },  // only iswc, no isrc/mbid/catalog_id
  ]);

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCalls.length === 0, 'rpc_upsert_recording_enrichment NOT called when no ISRC/MBID/catalog_id');
}

// ── IDEM-5: MBID-only path → keyed by p_recording_mbid ───────────────────────

async function test_idem5_mbid_only_keyed_by_mbid_param() {
  console.log('\n[IDEM-5] MBID-only track — RPC called with p_recording_mbid set, p_isrc null');
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
  assert(rpcCall?.body?.p_recording_mbid === mbid,
    `p_recording_mbid is the MBID (got "${rpcCall?.body?.p_recording_mbid}")`);
  assert(rpcCall?.body?.p_isrc === null || rpcCall?.body?.p_isrc === undefined,
    `p_isrc is null/absent (no ISRC on this track) (got "${rpcCall?.body?.p_isrc}")`);
  assert(rpcCall?.body?.p_catalog_track_id === null || rpcCall?.body?.p_catalog_track_id === undefined,
    `p_catalog_track_id is null/absent (got "${rpcCall?.body?.p_catalog_track_id}")`);

  const guardGets = calls.filter(c =>
    (c.method === 'GET' || !c.method) && c.url.includes('/rest/v1/nodes')
  );
  assert(guardGets.length === 0, `zero guard GETs from JS for MBID-only track (got ${guardGets.length})`);

  // Old params must not be present
  assert(!('p_external_id' in (rpcCall?.body || {})),
    'p_external_id absent from RPC body (old param removed)');
  assert(!('p_external_id_ns' in (rpcCall?.body || {})),
    'p_external_id_ns absent from RPC body (old param removed)');
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
      throw new Error('REGRESSION: graph.nodes GET called from enrichment path');
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
  console.log('Migrations: 20260721_graph_rls_lockdown.sql + 20260722_rpc_recording_enrichment_v2.sql\n');

  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

  await test_auth1_rpc_in_public_schema();
  await test_auth2_service_role_key_on_every_call();
  await test_auth3_no_direct_write_to_graph_tables();
  await test_auth4_no_js_guard_reads();
  await test_idem1_same_track_twice_same_node_id();
  await test_idem2_composition_node_id_null_from_js();
  await test_idem3_both_keys_forwarded_no_guard_lookup();
  await test_idem4_no_identifiers_no_rpc();
  await test_idem5_mbid_only_keyed_by_mbid_param();
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
