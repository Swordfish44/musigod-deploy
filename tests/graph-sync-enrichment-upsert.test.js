'use strict';
// tests/graph-sync-enrichment-upsert.test.js
// Regression suite for the syncEnrichmentToGraph upsert path.
//
// After the v2 RPC redesign, the JS layer passes all three identity keys
// (p_isrc, p_recording_mbid, p_catalog_track_id) to a single public RPC.
// The RPC owns lookup + upsert atomically inside Postgres — no graph-schema
// REST calls (Accept-Profile: graph) are made from JS at all.
//
// Tests:
//   1-4.  Core correctness and idempotency via public RPC
//   5.    syncEnrichmentToGraph awaited before res.json() (enrich-artist.js)
//   6.    Existing rows updated safely; ISRC/MBID preserved by COALESCE
//   7.    MBID-first → ISRC-later: single RPC call with both params, no JS guard
//   8.    Catalog-keyed → ISRC on enrichment: single RPC call, no JS guard
//   9.    MBID-only (no ISRC, no catalogId): direct RPC, no graph.nodes GET
//   10.   Worker path calls and awaits graph sync
//   11.   Worker path returns ERROR (not DONE) when graph sync throws
//   12.   enrich-artist.js captures graphSynced/graphSyncFailed in DONE result
//   13.   enrich-artist.js still returns DONE when graph sync throws
//   14.   catalog_track_id-only (third identity tier, no ISRC/MBID)
//   15.   All three identifiers: single RPC call with all params
//   16.   Unauthorized (RPC 403): failed count incremented, syncEnrichmentToGraph does not throw

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else       { console.error(`  ❌ FAIL: ${label}`); failed++; }
}

// ── Constants ────────────────────────────────────────────────────────────────

const SB = 'https://uykzkrnoetcldeuxzqyy.supabase.co';

const REC_NODE_UUID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const WORK_NODE_UUID = 'bbbbbbbb-0000-0000-0000-000000000002';

// ── Module helpers ────────────────────────────────────────────────────────────

function loadFreshGraphSync() {
  delete require.cache[require.resolve('../api/graph-sync')];
  return require('../api/graph-sync');
}

// ── Standard mock fetch ───────────────────────────────────────────────────────
//
// After the v2 RPC fix, syncEnrichmentToGraph makes exactly ONE type of fetch
// call: POST /rpc/rpc_upsert_recording_enrichment. No graph.nodes GETs, no
// compositions PATCHes, no graph_upsert_node calls.

function makeMockFetch({ calls = [], rpcUuids = [REC_NODE_UUID] } = {}) {
  let rpcCallIndex = 0;
  return async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body });

    if (url.includes('/rpc/rpc_upsert_recording_enrichment')) {
      const uuid = rpcUuids[Math.min(rpcCallIndex, rpcUuids.length - 1)];
      rpcCallIndex++;
      return { ok: true, text: async () => JSON.stringify({ node_id: uuid }) };
    }

    // graph.nodes GET must NOT be called from enrichment path after v2 fix
    if (url.includes('/rest/v1/nodes') && (opts.method === 'GET' || !opts.method)) {
      throw new Error(`REGRESSION: graph.nodes GET from enrichment path — lookup must be inside RPC: ${url}`);
    }

    if (url.includes('/rpc/graph_upsert_node')) {
      throw new Error('REGRESSION: graph_upsert_node called from enrichment path');
    }
    if (url.endsWith('/rest/v1/recordings') && opts.method === 'POST') {
      throw new Error('REGRESSION: direct POST to /v1/recordings from enrichment path');
    }

    throw new Error(`Unexpected fetch in test: ${opts.method || 'GET'} ${url}`);
  };
}

// ── Shared track fixture ──────────────────────────────────────────────────────

function trackWithIsrcAndMbid(overrides = {}) {
  return {
    trackTitle:       'Test Track',
    isrcs:            ['USABC0100001'],
    recordingMBID:    'mbid-rec-0000-0000-0000-000000000001',
    catalog_id:       null,
    writers:          [],
    enriched:         true,
    enrichmentSource: 'musicbrainz',
    ...overrides,
  };
}

// ── Test 1: RPC called with correct identity params ───────────────────────────

async function test1_rpc_called_with_isrc_and_mbid() {
  console.log('\n[1] RPC called with p_isrc and p_recording_mbid — no p_recording_patch or p_external_id');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = makeMockFetch({ calls });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  await syncEnrichmentToGraph('TestArtist', [trackWithIsrcAndMbid()]);

  global.fetch = origFetch;

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCalls.length === 1, `rpc_upsert_recording_enrichment called once (got ${rpcCalls.length})`);

  const b = rpcCalls[0]?.body;
  assert(b?.p_isrc === 'USABC0100001',
    `p_isrc is normalized ISRC (got "${b?.p_isrc}")`);
  assert(b?.p_recording_mbid === 'mbid-rec-0000-0000-0000-000000000001',
    `p_recording_mbid is MBID (got "${b?.p_recording_mbid}")`);
  assert(!('p_external_id' in (b || {})),
    'p_external_id not present in new RPC body');
  assert(!('p_existing_node_id' in (b || {})),
    'p_existing_node_id not present in new RPC body');
  assert(!('p_recording_patch' in (b || {})),
    'p_recording_patch not present in new RPC body');

  const nodeCalls = calls.filter(c => c.url.includes('/rest/v1/nodes'));
  assert(nodeCalls.length === 0,
    `no graph.nodes GET calls from JS (got ${nodeCalls.length})`);
}

// ── Test 2: Repeated enrichment is idempotent ─────────────────────────────────

async function test2_repeated_enrichment_is_idempotent() {
  console.log('\n[2] Repeated enrichment is idempotent — p_isrc identical on both runs');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = makeMockFetch({ calls, rpcUuids: [REC_NODE_UUID, REC_NODE_UUID] });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  const track = trackWithIsrcAndMbid();

  await syncEnrichmentToGraph('TestArtist', [track]);
  await syncEnrichmentToGraph('TestArtist', [track]);

  global.fetch = origFetch;

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCalls.length === 2, `RPC called once per run (got ${rpcCalls.length})`);

  const isrcs = rpcCalls.map(c => c.body?.p_isrc);
  assert(isrcs[0] === 'USABC0100001' && isrcs[1] === 'USABC0100001',
    `same p_isrc on both runs (got ${JSON.stringify(isrcs)})`);
  assert(rpcCalls.every(c => c.body?.p_recording_mbid === 'mbid-rec-0000-0000-0000-000000000001'),
    'same p_recording_mbid on both runs');
}

// ── Test 3: ISRC and MBID are distinct params ─────────────────────────────────

async function test3_isrc_and_mbid_are_distinct_params() {
  console.log('\n[3] ISRC and MBID are separate RPC params — not conflated');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = makeMockFetch({ calls });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  await syncEnrichmentToGraph('TestArtist', [
    trackWithIsrcAndMbid({
      isrcs:         ['USXYZ9999999'],
      recordingMBID: 'mbid-distinct-0000-0000-000000000003',
    }),
  ]);

  global.fetch = origFetch;

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCall !== undefined, 'rpc_upsert_recording_enrichment was called');
  assert(rpcCall?.body?.p_isrc === 'USXYZ9999999',
    `p_isrc set to ISRC value (got "${rpcCall?.body?.p_isrc}")`);
  assert(rpcCall?.body?.p_recording_mbid === 'mbid-distinct-0000-0000-000000000003',
    `p_recording_mbid set to MBID (got "${rpcCall?.body?.p_recording_mbid}")`);
  assert(rpcCall?.body?.p_isrc !== rpcCall?.body?.p_recording_mbid,
    'ISRC and MBID are different values — not conflated');
  assert(!String(rpcCall?.body?.p_isrc || '').startsWith('mbid-'), 'p_isrc does not contain a MusicBrainz ID');
  assert(!String(rpcCall?.body?.p_recording_mbid || '').startsWith('US'), 'p_recording_mbid does not contain an ISRC');
}

// ── Test 4: No duplicate rows — same p_isrc on all runs ──────────────────────

async function test4_no_duplicate_rows() {
  console.log('\n[4] No duplicate rows — same p_isrc on all 3 runs; DB ON CONFLICT handles dedup');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = makeMockFetch({ calls, rpcUuids: [REC_NODE_UUID, REC_NODE_UUID, REC_NODE_UUID] });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  const track = trackWithIsrcAndMbid({ isrcs: ['USDUP0000001'] });

  await syncEnrichmentToGraph('TestArtist', [track]);
  await syncEnrichmentToGraph('TestArtist', [track]);
  await syncEnrichmentToGraph('TestArtist', [track]);

  global.fetch = origFetch;

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCalls.length === 3, `3 RPC calls across 3 runs (got ${rpcCalls.length})`);

  const uniqueIsrcs = [...new Set(rpcCalls.map(c => c.body?.p_isrc))];
  assert(uniqueIsrcs.length === 1 && uniqueIsrcs[0] === 'USDUP0000001',
    `all 3 RPC calls use same p_isrc (got ${JSON.stringify(uniqueIsrcs)})`);
}

// ── Test 5: syncEnrichmentToGraph is awaited before res.json() ───────────────

async function test5_sync_awaited_before_response() {
  console.log('\n[5] syncEnrichmentToGraph is awaited before the HTTP response is sent');

  const realSetTimeout = global.setTimeout;

  let syncCompleted  = false;
  let syncDoneAtResJson = null;

  const fakeCatalog = {
    enrichedTracks: [trackWithIsrcAndMbid()],
    mbid: 'mb-fake-artist',
    artistName: 'TestArtist',
    totalReleases: 1,
    processedReleases: 1,
    totalTracks: 1,
    generatedAt: new Date().toISOString(),
  };

  const modPaths = {
    enrichCatalog:  require.resolve('../lib/enrich-catalog'),
    graphSync:      require.resolve('../api/graph-sync'),
    persistTracks:  require.resolve('../lib/persist-enriched-tracks'),
    generateFiles:  require.resolve('../lib/generate-registration-files'),
    enrichArtist:   require.resolve('../api/enrich-artist'),
  };

  const savedCache = {};
  for (const [k, p] of Object.entries(modPaths)) {
    savedCache[k] = require.cache[p];
    delete require.cache[p];
  }

  require.cache[modPaths.enrichCatalog] = {
    id: modPaths.enrichCatalog, filename: modPaths.enrichCatalog, loaded: true,
    exports: { enrichArtistCatalog: async () => fakeCatalog },
  };

  require.cache[modPaths.graphSync] = {
    id: modPaths.graphSync, filename: modPaths.graphSync, loaded: true,
    exports: {
      syncEnrichmentToGraph: async () => {
        await new Promise(r => realSetTimeout(r, 15));
        syncCompleted = true;
      },
      syncCatalogToGraph:  async () => {},
      syncArtistToGraph:   async () => {},
    },
  };

  require.cache[modPaths.persistTracks] = {
    id: modPaths.persistTracks, filename: modPaths.persistTracks, loaded: true,
    exports: { persistEnrichedTracks: async () => ({ persisted: 1, failed: 0, errors: [] }) },
  };

  require.cache[modPaths.generateFiles] = {
    id: modPaths.generateFiles, filename: modPaths.generateFiles, loaded: true,
    exports: {
      generateASCAPCSV:      () => '',
      generateBMICSV:        () => '',
      generateMLCCSV:        () => '',
      generateMasterCatalogCSV: () => '',
      generateGapsReport:    () => ({ gaps: [] }),
    },
  };

  const handler = require('../api/enrich-artist');

  const origFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('catalog_enrichments_v1') && !url.includes('?'))
      return { ok: true, json: async () => [{ id: 'job-test-5' }], text: async () => JSON.stringify([{ id: 'job-test-5' }]) };
    return { ok: true, json: async () => null, text: async () => '' };
  };

  let responseCode = null;
  const res = {
    setHeader: () => {},
    status: (code) => ({
      json: (data) => {
        responseCode = code;
        syncDoneAtResJson = syncCompleted;
        return data;
      },
      end: () => {},
    }),
  };
  const req = { method: 'POST', headers: {}, body: { artistName: 'TestArtist', maxReleases: 1 } };

  try {
    await handler(req, res);
  } finally {
    for (const [k, p] of Object.entries(modPaths)) {
      if (savedCache[k]) require.cache[p] = savedCache[k];
      else delete require.cache[p];
    }
    global.fetch = origFetch;
  }

  assert(responseCode === 200, `handler returns 200 (got ${responseCode})`);
  assert(syncCompleted === true, 'syncEnrichmentToGraph fully completed before handler returned');
  assert(syncDoneAtResJson === true, 'syncEnrichmentToGraph was done when res.json() was called');
}

// ── Test 6: Existing rows updated safely ─────────────────────────────────────

async function test6_existing_rows_updated_safely() {
  console.log('\n[6] Existing works.recordings row — MBID added via RPC; ISRC preserved by COALESCE in DB');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = makeMockFetch({ calls, rpcUuids: [REC_NODE_UUID] });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  await syncEnrichmentToGraph('TestArtist', [
    trackWithIsrcAndMbid({
      isrcs:         ['USEXI0000006'],
      recordingMBID: 'mbid-existing-row-00000000000006',
    }),
  ]);

  global.fetch = origFetch;

  const rpcCall = calls.find(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCall !== undefined, 'rpc_upsert_recording_enrichment called for existing row');
  assert(rpcCall?.body?.p_isrc === 'USEXI0000006',
    `p_isrc carries ISRC (got "${rpcCall?.body?.p_isrc}")`);
  assert(rpcCall?.body?.p_recording_mbid === 'mbid-existing-row-00000000000006',
    `p_recording_mbid carries MBID (got "${rpcCall?.body?.p_recording_mbid}")`);
}

// ── Test 7: MBID-first → ISRC-later — single RPC call, guard now in DB ───────
//
// Previously the JS guard called findNodeByExternalId (GET /rest/v1/nodes with
// Accept-Profile: graph) which 406'd. After v2 fix, JS just passes both ISRC
// and MBID to the RPC; the DB resolves deduplication internally.

async function test7_mbid_first_isrc_later_single_rpc_no_js_guard() {
  console.log('\n[7] MBID-first → ISRC-later: single RPC call with both params; no JS graph.nodes lookup');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const mbid = 'mbid-transition-0000-0000-000000000007';
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = makeMockFetch({ calls, rpcUuids: [REC_NODE_UUID, REC_NODE_UUID] });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  // Run 1: MBID only — no ISRC yet
  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Transition Track',
    isrcs: [],
    recordingMBID: mbid,
  }]);

  // Run 2: ISRC now available — both ISRC and MBID passed to RPC
  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Transition Track',
    isrcs: ['USTRT0000007'],
    recordingMBID: mbid,
  }]);

  global.fetch = origFetch;

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  const nodeCalls = calls.filter(c => c.url.includes('/rest/v1/nodes'));

  assert(nodeCalls.length === 0,
    `no graph.nodes GET calls — guard is inside RPC now (got ${nodeCalls.length})`);
  assert(rpcCalls.length === 2,
    `RPC called once per run (got ${rpcCalls.length})`);

  // Run 1: MBID only
  assert(rpcCalls[0]?.body?.p_recording_mbid === mbid,
    `run 1: p_recording_mbid is MBID (got "${rpcCalls[0]?.body?.p_recording_mbid}")`);
  assert(!rpcCalls[0]?.body?.p_isrc,
    `run 1: p_isrc is null/empty — no ISRC yet (got "${rpcCalls[0]?.body?.p_isrc}")`);

  // Run 2: both ISRC and MBID — RPC resolves existing node internally
  assert(rpcCalls[1]?.body?.p_isrc === 'USTRT0000007',
    `run 2: p_isrc set (got "${rpcCalls[1]?.body?.p_isrc}")`);
  assert(rpcCalls[1]?.body?.p_recording_mbid === mbid,
    `run 2: p_recording_mbid still present (got "${rpcCalls[1]?.body?.p_recording_mbid}")`);
}

// ── Test 8: Catalog-keyed → ISRC — single RPC call, no JS guard ──────────────
//
// Previously the JS guard called findNodeByExternalId to find the catalog-keyed
// node, then passed p_existing_node_id. After v2 fix, JS passes both ISRC and
// catalog_track_id to the RPC; the DB resolves deduplication internally.

async function test8_catalog_keyed_isrc_on_enrichment_single_rpc_no_js_guard() {
  console.log('\n[8] Catalog-keyed node + ISRC on enrichment: single RPC call with p_isrc + p_catalog_track_id');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const catalogId = 'cat-track-00000008';
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = makeMockFetch({ calls, rpcUuids: [REC_NODE_UUID] });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle:    'Catalog Track',
    catalog_id:    catalogId,
    isrcs:         ['USCAT0000008'],
    recordingMBID: null,
  }]);

  global.fetch = origFetch;

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  const nodeCalls = calls.filter(c => c.url.includes('/rest/v1/nodes'));

  assert(nodeCalls.length === 0,
    `no graph.nodes GET calls — guard is inside RPC (got ${nodeCalls.length})`);
  assert(rpcCalls.length === 1,
    `rpc_upsert_recording_enrichment called once (got ${rpcCalls.length})`);
  assert(rpcCalls[0]?.body?.p_isrc === 'USCAT0000008',
    `p_isrc carries ISRC (got "${rpcCalls[0]?.body?.p_isrc}")`);
  assert(rpcCalls[0]?.body?.p_catalog_track_id === catalogId,
    `p_catalog_track_id carries catalogId (got "${rpcCalls[0]?.body?.p_catalog_track_id}")`);
  assert(!('p_existing_node_id' in (rpcCalls[0]?.body || {})),
    'p_existing_node_id absent from RPC body — guard is in DB');
}

// ── Test 9: MBID-only — idempotent, no graph.nodes GET ───────────────────────

async function test9_mbid_only_no_isrc_no_catalogid_idempotent() {
  console.log('\n[9] MBID-only (no ISRC, no catalog_id) — idempotent; no graph.nodes GET');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const MBID_UUID = 'eeeeeeee-9999-0000-0000-000000000009';
  const mbid = 'mbid-only-0000-0000-0000-000000000009';
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = makeMockFetch({ calls, rpcUuids: [MBID_UUID, MBID_UUID] });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  const track = { trackTitle: 'MBID Only Track', isrcs: [], recordingMBID: mbid };

  await syncEnrichmentToGraph('TestArtist', [track]);
  await syncEnrichmentToGraph('TestArtist', [track]);

  global.fetch = origFetch;

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  const nodeCalls = calls.filter(c => c.url.includes('/rest/v1/nodes'));

  assert(nodeCalls.length === 0,
    `no graph.nodes GETs — MBID-only path skips guard entirely (got ${nodeCalls.length})`);
  assert(rpcCalls.length === 2,
    `RPC called once per run (got ${rpcCalls.length})`);

  const mbids = rpcCalls.map(c => c.body?.p_recording_mbid);
  assert(mbids.every(id => id === mbid),
    `both calls use MBID as p_recording_mbid (got ${JSON.stringify(mbids)})`);
  assert(rpcCalls.every(c => !c.body?.p_isrc),
    'p_isrc absent on both runs (no ISRC on this track)');
  assert(rpcCalls.every(c => !c.body?.p_catalog_track_id),
    'p_catalog_track_id absent on both runs (no catalog_id on this track)');
}

// ── Test 10: Worker path calls and awaits graph sync ─────────────────────────

async function test10_worker_path_calls_and_awaits_graph_sync() {
  console.log('\n[10] Worker path — run-enrichment-job.js calls and awaits syncEnrichmentToGraph');

  const realSetTimeout = global.setTimeout;
  let syncCompleted = false;
  let syncDoneAtResJson = null;

  const fakeCatalog = {
    enrichedTracks: [trackWithIsrcAndMbid()],
    mbid: 'mb-fake-artist',
    totalReleases: 1,
    processedReleases: 1,
    totalTracks: 1,
    generatedAt: new Date().toISOString(),
  };

  const modPaths = {
    enrichCatalog: require.resolve('../lib/enrich-catalog'),
    graphSync:     require.resolve('../api/graph-sync'),
    persistTracks: require.resolve('../lib/persist-enriched-tracks'),
    generateFiles: require.resolve('../lib/generate-registration-files'),
    runJob:        require.resolve('../api/run-enrichment-job'),
  };

  const savedCache = {};
  for (const [k, p] of Object.entries(modPaths)) {
    savedCache[k] = require.cache[p];
    delete require.cache[p];
  }

  require.cache[modPaths.enrichCatalog] = {
    id: modPaths.enrichCatalog, filename: modPaths.enrichCatalog, loaded: true,
    exports: { enrichArtistCatalog: async () => fakeCatalog },
  };
  require.cache[modPaths.graphSync] = {
    id: modPaths.graphSync, filename: modPaths.graphSync, loaded: true,
    exports: {
      syncEnrichmentToGraph: async () => {
        await new Promise(r => realSetTimeout(r, 15));
        syncCompleted = true;
      },
      syncCatalogToGraph: async () => {},
      syncArtistToGraph:  async () => {},
    },
  };
  require.cache[modPaths.persistTracks] = {
    id: modPaths.persistTracks, filename: modPaths.persistTracks, loaded: true,
    exports: { persistEnrichedTracks: async () => ({ persisted: 1, failed: 0, errors: [] }) },
  };
  require.cache[modPaths.generateFiles] = {
    id: modPaths.generateFiles, filename: modPaths.generateFiles, loaded: true,
    exports: {
      generateASCAPCSV:         () => '',
      generateBMICSV:           () => '',
      generateMLCCSV:           () => '',
      generateMasterCatalogCSV: () => '',
      generateGapsReport:       () => ({ gaps: [] }),
    },
  };

  const handler = require('../api/run-enrichment-job');

  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => null, text: async () => '' });

  const savedN8n   = process.env.N8N_ENRICH_TOKEN;
  const savedAdmin = process.env.AUDIT_ADMIN_KEY;
  delete process.env.N8N_ENRICH_TOKEN;
  delete process.env.AUDIT_ADMIN_KEY;

  let responseCode = null;
  const res = {
    setHeader: () => {},
    status: (code) => ({
      json: (data) => { responseCode = code; syncDoneAtResJson = syncCompleted; return data; },
      end: () => {},
    }),
  };
  const req = { method: 'POST', headers: {}, body: { job_id: 'job-test-10', artistName: 'TestArtist', maxReleases: 1 } };

  try {
    await handler(req, res);
  } finally {
    for (const [k, p] of Object.entries(modPaths)) {
      if (savedCache[k]) require.cache[p] = savedCache[k];
      else delete require.cache[p];
    }
    global.fetch = origFetch;
    if (savedN8n   !== undefined) process.env.N8N_ENRICH_TOKEN = savedN8n;
    else delete process.env.N8N_ENRICH_TOKEN;
    if (savedAdmin !== undefined) process.env.AUDIT_ADMIN_KEY  = savedAdmin;
    else delete process.env.AUDIT_ADMIN_KEY;
  }

  assert(responseCode === 200, `worker handler returns 200 (got ${responseCode})`);
  assert(syncCompleted === true, 'syncEnrichmentToGraph fully completed before handler returned');
  assert(syncDoneAtResJson === true, 'sync was done when res.json() fired');
}

// ── Test 11: Worker path — ERROR returned when graph sync throws ──────────────

async function test11_worker_error_not_done_on_graph_sync_failure() {
  console.log('\n[11] Worker path — ERROR (not DONE) when syncEnrichmentToGraph throws');

  const fakeCatalog = {
    enrichedTracks: [trackWithIsrcAndMbid()],
    mbid: 'mb-fake-artist',
    totalReleases: 1,
    processedReleases: 1,
    totalTracks: 1,
    generatedAt: new Date().toISOString(),
  };

  const modPaths = {
    enrichCatalog: require.resolve('../lib/enrich-catalog'),
    graphSync:     require.resolve('../api/graph-sync'),
    persistTracks: require.resolve('../lib/persist-enriched-tracks'),
    generateFiles: require.resolve('../lib/generate-registration-files'),
    runJob:        require.resolve('../api/run-enrichment-job'),
  };

  const savedCache = {};
  for (const [k, p] of Object.entries(modPaths)) {
    savedCache[k] = require.cache[p];
    delete require.cache[p];
  }

  let syncCalled = false;

  require.cache[modPaths.enrichCatalog] = {
    id: modPaths.enrichCatalog, filename: modPaths.enrichCatalog, loaded: true,
    exports: { enrichArtistCatalog: async () => fakeCatalog },
  };
  require.cache[modPaths.graphSync] = {
    id: modPaths.graphSync, filename: modPaths.graphSync, loaded: true,
    exports: {
      syncEnrichmentToGraph: async () => { syncCalled = true; throw new Error('simulated graph sync failure'); },
      syncCatalogToGraph: async () => {},
      syncArtistToGraph:  async () => {},
    },
  };
  require.cache[modPaths.persistTracks] = {
    id: modPaths.persistTracks, filename: modPaths.persistTracks, loaded: true,
    exports: { persistEnrichedTracks: async () => ({ persisted: 1, failed: 0, errors: [] }) },
  };
  require.cache[modPaths.generateFiles] = {
    id: modPaths.generateFiles, filename: modPaths.generateFiles, loaded: true,
    exports: {
      generateASCAPCSV:         () => '',
      generateBMICSV:           () => '',
      generateMLCCSV:           () => '',
      generateMasterCatalogCSV: () => '',
      generateGapsReport:       () => ({ gaps: [] }),
    },
  };

  const handler = require('../api/run-enrichment-job');

  const sbPatchBodies = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (url.includes('catalog_enrichments_v1') && opts?.method === 'PATCH') {
      sbPatchBodies.push(JSON.parse(opts.body));
    }
    return { ok: true, json: async () => null, text: async () => '' };
  };

  const savedN8n   = process.env.N8N_ENRICH_TOKEN;
  const savedAdmin = process.env.AUDIT_ADMIN_KEY;
  delete process.env.N8N_ENRICH_TOKEN;
  delete process.env.AUDIT_ADMIN_KEY;

  let responseCode = null;
  let responseBody = null;
  const res = {
    setHeader: () => {},
    status: (code) => ({
      json: (data) => { responseCode = code; responseBody = data; return data; },
      end: () => {},
    }),
  };
  const req = { method: 'POST', headers: {}, body: { job_id: 'job-test-11', artistName: 'TestArtist', maxReleases: 1 } };

  try {
    await handler(req, res);
  } finally {
    for (const [k, p] of Object.entries(modPaths)) {
      if (savedCache[k]) require.cache[p] = savedCache[k];
      else delete require.cache[p];
    }
    global.fetch = origFetch;
    if (savedN8n   !== undefined) process.env.N8N_ENRICH_TOKEN = savedN8n;
    else delete process.env.N8N_ENRICH_TOKEN;
    if (savedAdmin !== undefined) process.env.AUDIT_ADMIN_KEY  = savedAdmin;
    else delete process.env.AUDIT_ADMIN_KEY;
  }

  assert(syncCalled === true, 'syncEnrichmentToGraph was called on worker path');
  assert(responseCode === 500, `handler returns 500 on graph sync failure (got ${responseCode})`);
  assert(responseBody?.status === 'ERROR', `response status is ERROR (got "${responseBody?.status}")`);
  assert(responseBody?.status !== 'DONE', 'response status is NOT DONE');

  const donePatches = sbPatchBodies.filter(b => b.status === 'DONE');
  assert(donePatches.length === 0, `Supabase never patched with DONE on failure (got ${donePatches.length})`);

  const errorPatches = sbPatchBodies.filter(b => b.status === 'ERROR');
  assert(errorPatches.length >= 1, `Supabase patched with ERROR (got ${errorPatches.length})`);
}

// ── Test 12: enrich-artist.js captures graph stats in DONE result ─────────────

async function test12_enrich_artist_captures_graph_stats_in_done() {
  console.log('\n[12] enrich-artist.js — graphSynced/graphSyncFailed captured in DONE result');

  const fakeCatalog = {
    enrichedTracks: [trackWithIsrcAndMbid(), trackWithIsrcAndMbid({ isrcs: ['USABC0100002'] })],
    mbid: 'mb-test-artist-12',
    totalReleases: 1,
    processedReleases: 1,
    totalTracks: 2,
    generatedAt: new Date().toISOString(),
  };

  const modPaths = {
    enrichCatalog: require.resolve('../lib/enrich-catalog'),
    graphSync:     require.resolve('../api/graph-sync'),
    persistTracks: require.resolve('../lib/persist-enriched-tracks'),
    generateFiles: require.resolve('../lib/generate-registration-files'),
    enrichArtist:  require.resolve('../api/enrich-artist'),
  };

  const savedCache = {};
  for (const [k, p] of Object.entries(modPaths)) {
    savedCache[k] = require.cache[p];
    delete require.cache[p];
  }

  require.cache[modPaths.enrichCatalog] = {
    id: modPaths.enrichCatalog, filename: modPaths.enrichCatalog, loaded: true,
    exports: { enrichArtistCatalog: async () => fakeCatalog },
  };
  require.cache[modPaths.graphSync] = {
    id: modPaths.graphSync, filename: modPaths.graphSync, loaded: true,
    exports: {
      syncEnrichmentToGraph: async () => ({ synced: 0, failed: 2 }),
      syncCatalogToGraph:    async () => {},
      syncArtistToGraph:     async () => {},
    },
  };
  require.cache[modPaths.persistTracks] = {
    id: modPaths.persistTracks, filename: modPaths.persistTracks, loaded: true,
    exports: { persistEnrichedTracks: async () => ({ persisted: 2, failed: 0, errors: [] }) },
  };
  require.cache[modPaths.generateFiles] = {
    id: modPaths.generateFiles, filename: modPaths.generateFiles, loaded: true,
    exports: {
      generateASCAPCSV:         () => '',
      generateBMICSV:           () => '',
      generateMLCCSV:           () => '',
      generateMasterCatalogCSV: () => '',
      generateGapsReport:       () => ({ gaps: [] }),
    },
  };

  const handler = require('../api/enrich-artist');

  const sbPatchBodies = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (url.includes('catalog_enrichments_v1') && opts?.method === 'POST') {
      return { ok: true, json: async () => [{ id: 'job-test-12' }], text: async () => JSON.stringify([{ id: 'job-test-12' }]) };
    }
    if (url.includes('catalog_enrichments_v1') && opts?.method === 'PATCH') {
      sbPatchBodies.push(JSON.parse(opts.body));
    }
    return { ok: true, json: async () => null, text: async () => '' };
  };

  const savedAuditKey = process.env.AUDIT_ADMIN_KEY;
  delete process.env.AUDIT_ADMIN_KEY;

  let responseCode = null;
  let responseBody = null;
  const res = {
    setHeader: () => {},
    status: (code) => ({
      json: (data) => { responseCode = code; responseBody = data; return data; },
      end:  () => {},
    }),
  };
  const req = { method: 'POST', headers: {}, body: { artistName: 'TestArtist12', maxReleases: 1 } };

  try {
    await handler(req, res);
  } finally {
    for (const [k, p] of Object.entries(modPaths)) {
      if (savedCache[k]) require.cache[p] = savedCache[k];
      else delete require.cache[p];
    }
    global.fetch = origFetch;
    if (savedAuditKey !== undefined) process.env.AUDIT_ADMIN_KEY = savedAuditKey;
    else delete process.env.AUDIT_ADMIN_KEY;
  }

  assert(responseCode === 200, `handler returns 200 (got ${responseCode})`);

  const donePatches = sbPatchBodies.filter(b => b.status === 'DONE');
  assert(donePatches.length >= 1, 'Supabase patched with status=DONE');

  const donePatch = donePatches[0];
  assert(donePatch?.result?.graphSynced === 0,
    `result.graphSynced is 0 (got ${donePatch?.result?.graphSynced})`);
  assert(donePatch?.result?.graphSyncFailed === 2,
    `result.graphSyncFailed is 2 (got ${donePatch?.result?.graphSyncFailed})`);
}

// ── Test 13: enrich-artist.js returns DONE even when graph sync throws ─────────

async function test13_enrich_artist_done_with_failed_stats_on_graph_throw() {
  console.log('\n[13] enrich-artist.js — DONE returned even when graph sync throws; graphSyncFailed = track count');

  const fakeCatalog = {
    enrichedTracks: [trackWithIsrcAndMbid()],
    mbid: 'mb-test-artist-13',
    totalReleases: 1,
    processedReleases: 1,
    totalTracks: 1,
    generatedAt: new Date().toISOString(),
  };

  const modPaths = {
    enrichCatalog: require.resolve('../lib/enrich-catalog'),
    graphSync:     require.resolve('../api/graph-sync'),
    persistTracks: require.resolve('../lib/persist-enriched-tracks'),
    generateFiles: require.resolve('../lib/generate-registration-files'),
    enrichArtist:  require.resolve('../api/enrich-artist'),
  };

  const savedCache = {};
  for (const [k, p] of Object.entries(modPaths)) {
    savedCache[k] = require.cache[p];
    delete require.cache[p];
  }

  require.cache[modPaths.enrichCatalog] = {
    id: modPaths.enrichCatalog, filename: modPaths.enrichCatalog, loaded: true,
    exports: { enrichArtistCatalog: async () => fakeCatalog },
  };
  require.cache[modPaths.graphSync] = {
    id: modPaths.graphSync, filename: modPaths.graphSync, loaded: true,
    exports: {
      syncEnrichmentToGraph: async () => { throw new Error('catastrophic graph failure'); },
      syncCatalogToGraph:    async () => {},
      syncArtistToGraph:     async () => {},
    },
  };
  require.cache[modPaths.persistTracks] = {
    id: modPaths.persistTracks, filename: modPaths.persistTracks, loaded: true,
    exports: { persistEnrichedTracks: async () => ({ persisted: 1, failed: 0, errors: [] }) },
  };
  require.cache[modPaths.generateFiles] = {
    id: modPaths.generateFiles, filename: modPaths.generateFiles, loaded: true,
    exports: {
      generateASCAPCSV:         () => '',
      generateBMICSV:           () => '',
      generateMLCCSV:           () => '',
      generateMasterCatalogCSV: () => '',
      generateGapsReport:       () => ({ gaps: [] }),
    },
  };

  const handler = require('../api/enrich-artist');

  const sbPatchBodies = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (url.includes('catalog_enrichments_v1') && opts?.method === 'POST') {
      return { ok: true, json: async () => [{ id: 'job-test-13' }], text: async () => JSON.stringify([{ id: 'job-test-13' }]) };
    }
    if (url.includes('catalog_enrichments_v1') && opts?.method === 'PATCH') {
      sbPatchBodies.push(JSON.parse(opts.body));
    }
    return { ok: true, json: async () => null, text: async () => '' };
  };

  const savedAuditKey = process.env.AUDIT_ADMIN_KEY;
  delete process.env.AUDIT_ADMIN_KEY;

  let responseCode = null;
  let responseBody = null;
  const res = {
    setHeader: () => {},
    status: (code) => ({
      json: (data) => { responseCode = code; responseBody = data; return data; },
      end:  () => {},
    }),
  };
  const req = { method: 'POST', headers: {}, body: { artistName: 'TestArtist13', maxReleases: 1 } };

  try {
    await handler(req, res);
  } finally {
    for (const [k, p] of Object.entries(modPaths)) {
      if (savedCache[k]) require.cache[p] = savedCache[k];
      else delete require.cache[p];
    }
    global.fetch = origFetch;
    if (savedAuditKey !== undefined) process.env.AUDIT_ADMIN_KEY = savedAuditKey;
    else delete process.env.AUDIT_ADMIN_KEY;
  }

  assert(responseCode === 200, `handler still returns 200 when graph sync throws (got ${responseCode})`);

  const donePatches = sbPatchBodies.filter(b => b.status === 'DONE');
  assert(donePatches.length >= 1, 'Supabase patched with DONE despite graph sync throw');

  const donePatch = donePatches[0];
  assert(donePatch?.result?.graphSynced === 0, `result.graphSynced is 0 (got ${donePatch?.result?.graphSynced})`);
  assert(donePatch?.result?.graphSyncFailed === 1,
    `result.graphSyncFailed = track count (1) on catastrophic throw (got ${donePatch?.result?.graphSyncFailed})`);
}

// ── Test 14: catalog_track_id-only (third identity tier, no ISRC/MBID) ────────

async function test14_catalog_track_id_only_triggers_rpc() {
  console.log('\n[14] catalog_track_id-only (third tier) — RPC called with p_catalog_track_id, others null');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = makeMockFetch({ calls });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle:    'Catalog Only Track',
    catalog_id:    'cat-only-0000014',
    isrcs:         [],
    recordingMBID: null,
  }]);

  global.fetch = origFetch;

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  const nodeCalls = calls.filter(c => c.url.includes('/rest/v1/nodes'));

  assert(nodeCalls.length === 0, `no graph.nodes GETs (got ${nodeCalls.length})`);
  assert(rpcCalls.length === 1, `RPC called once (got ${rpcCalls.length})`);
  assert(rpcCalls[0]?.body?.p_catalog_track_id === 'cat-only-0000014',
    `p_catalog_track_id carries catalogId (got "${rpcCalls[0]?.body?.p_catalog_track_id}")`);
  assert(!rpcCalls[0]?.body?.p_isrc,
    `p_isrc is null/empty (got "${rpcCalls[0]?.body?.p_isrc}")`);
  assert(!rpcCalls[0]?.body?.p_recording_mbid,
    `p_recording_mbid is null/empty (got "${rpcCalls[0]?.body?.p_recording_mbid}")`);
}

// ── Test 15: All three identifiers — single RPC call with all params ──────────

async function test15_all_three_identifiers_single_rpc_call() {
  console.log('\n[15] All three identifiers (ISRC + MBID + catalog_id) — single RPC call; DB resolves priority');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = makeMockFetch({ calls });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle:    'Full Identity Track',
    catalog_id:    'cat-full-0000015',
    isrcs:         ['USFULL000015'],
    recordingMBID: 'mbid-full-0000-0000-0000-000000000015',
  }]);

  global.fetch = origFetch;

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  const nodeCalls = calls.filter(c => c.url.includes('/rest/v1/nodes'));

  assert(nodeCalls.length === 0, `no graph.nodes GETs — no JS-level guard (got ${nodeCalls.length})`);
  assert(rpcCalls.length === 1, `exactly 1 RPC call (got ${rpcCalls.length})`);

  const b = rpcCalls[0]?.body;
  assert(b?.p_isrc === 'USFULL000015',
    `p_isrc present (got "${b?.p_isrc}")`);
  assert(b?.p_recording_mbid === 'mbid-full-0000-0000-0000-000000000015',
    `p_recording_mbid present (got "${b?.p_recording_mbid}")`);
  assert(b?.p_catalog_track_id === 'cat-full-0000015',
    `p_catalog_track_id present (got "${b?.p_catalog_track_id}")`);
}

// ── Test 16: Unauthorized RPC (403) — failed count incremented, no throw ──────
//
// If the RPC returns 403 (e.g., called with wrong key in production),
// syncEnrichmentToGraph must catch the error per-track and return
// { synced: 0, failed: N } rather than throwing to the caller.

async function test16_unauthorized_rpc_increments_failed_count() {
  console.log('\n[16] Unauthorized RPC (403) — syncEnrichmentToGraph returns failed stats, does not throw');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const origFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/rpc/rpc_upsert_recording_enrichment')) {
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ message: 'permission denied for function rpc_upsert_recording_enrichment', code: '42501' }),
      };
    }
    return { ok: false, status: 404, text: async () => '{"error":"unexpected"}' };
  };

  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  let result;
  let threw = false;
  try {
    result = await syncEnrichmentToGraph('test-artist', [
      { trackTitle: 'Track A', isrcs: ['USUNAUTH0001'], recordingMBID: 'mbid-unauth-0001' },
      { trackTitle: 'Track B', isrcs: ['USUNAUTH0002'], recordingMBID: 'mbid-unauth-0002' },
    ]);
  } catch (e) {
    threw = true;
  }

  global.fetch = origFetch;

  assert(!threw,              'syncEnrichmentToGraph does NOT throw on 403');
  assert(result?.synced === 0, `synced count is 0 (got ${result?.synced})`);
  assert(result?.failed === 2, `failed count equals track count (got ${result?.failed})`);
}

// ── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== graph-sync-enrichment-upsert.test.js ===');
  console.log('v2 RPC: identity lookup merged into SECURITY DEFINER function\n');

  await test1_rpc_called_with_isrc_and_mbid();
  await test2_repeated_enrichment_is_idempotent();
  await test3_isrc_and_mbid_are_distinct_params();
  await test4_no_duplicate_rows();
  await test5_sync_awaited_before_response();
  await test6_existing_rows_updated_safely();
  await test7_mbid_first_isrc_later_single_rpc_no_js_guard();
  await test8_catalog_keyed_isrc_on_enrichment_single_rpc_no_js_guard();
  await test9_mbid_only_no_isrc_no_catalogid_idempotent();
  await test10_worker_path_calls_and_awaits_graph_sync();
  await test11_worker_error_not_done_on_graph_sync_failure();
  await test12_enrich_artist_captures_graph_stats_in_done();
  await test13_enrich_artist_done_with_failed_stats_on_graph_throw();
  await test14_catalog_track_id_only_triggers_rpc();
  await test15_all_three_identifiers_single_rpc_call();
  await test16_unauthorized_rpc_increments_failed_count();

  console.log(`\n${'─'.repeat(50)}`);
  const total = passed + failed;
  if (failed > 0) {
    console.error(`${total} assertions | ${passed} passed | ${failed} FAILED`);
  } else {
    console.log(`${total} assertions | ${total} passed`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
