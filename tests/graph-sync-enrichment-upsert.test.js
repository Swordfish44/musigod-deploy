'use strict';
// tests/graph-sync-enrichment-upsert.test.js
// Regression suite for the syncEnrichmentToGraph upsert redesign.
//
// Tests:
//   1. Empty works.recordings — syncEnrichmentToGraph creates new rows
//   2. Repeated enrichment is idempotent (same node_id returned, merge-duplicates used)
//   3. ISRC and musicbrainz_recording_id remain separate fields
//   4. No duplicate rows (upsertNode idempotency + merge-duplicates)
//   5. syncEnrichmentToGraph is awaited before res.json() fires (enrich-artist.js)
//   6. Existing rows are updated safely when works.recordings already has matching node

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else       { console.error(`  ❌ FAIL: ${label}`); failed++; }
}

// ── Constants ────────────────────────────────────────────────────────────────

const SB = 'https://uykzkrnoetcldeuxzqyy.supabase.co';

// Fixed UUIDs used across tests
const REC_NODE_UUID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const WORK_NODE_UUID = 'bbbbbbbb-0000-0000-0000-000000000002';

// ── Module helpers ────────────────────────────────────────────────────────────

function loadFreshGraphSync() {
  delete require.cache[require.resolve('../api/graph-sync')];
  return require('../api/graph-sync');
}

// ── Fetch call tracker ────────────────────────────────────────────────────────

function makeCallTracker() {
  const calls = [];
  return {
    calls,
    async fetch(url, opts = {}) {
      const body = opts.body ? JSON.parse(opts.body) : undefined;
      calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body });
      return this._dispatch(url, opts);
    },
    _dispatch() { throw new Error('Base makeCallTracker has no dispatch — use makeMockFetch'); },
  };
}

// ── Standard mock fetch for syncEnrichmentToGraph tests ─────────────────────
//
// Returns:
//   graph_upsert_node RPC  → REC_NODE_UUID (for recording) or WORK_NODE_UUID (when title fingerprint present)
//   graph_nodes_v1 GET     → [] by default (no existing work node)
//   recordings POST        → null (minimal return)
//   compositions PATCH     → null (minimal return)
//
// Options:
//   workNodeId  — if truthy, graph_nodes_v1 GET returns this UUID (simulates existing work node)
//   rpcUuids    — array of UUIDs returned sequentially by graph_upsert_node calls

function makeMockFetch({ calls = [], workNodeId = null, rpcUuids = [REC_NODE_UUID] } = {}) {
  let rpcCallIndex = 0;
  return async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body });

    // Public RPC — single authorised entry point for enrichment recording writes.
    // Returns { node_id: <uuid> }; same UUID on every call for idempotency tests.
    if (url.includes('/rpc/rpc_upsert_recording_enrichment')) {
      const uuid = rpcUuids[Math.min(rpcCallIndex, rpcUuids.length - 1)];
      rpcCallIndex++;
      return { ok: true, text: async () => JSON.stringify({ node_id: uuid }) };
    }

    // graph.nodes GET (findNodeByExternalId guard reads) — returns existing node or empty.
    // service_role can still read graph.nodes after the lockdown.
    if (url.includes('/rest/v1/nodes') && (opts.method === 'GET' || !opts.method)) {
      const row = workNodeId ? [{ id: workNodeId }] : [];
      return { ok: true, text: async () => JSON.stringify(row) };
    }

    // compositions PATCH (works schema — still a direct REST call, unchanged)
    if (url.includes('/rest/v1/compositions') && opts.method === 'PATCH') {
      return { ok: true, text: async () => '' };
    }

    // graph_upsert_node and direct recordings POST must NOT be called from enrichment path
    if (url.includes('/rpc/graph_upsert_node')) {
      throw new Error(`REGRESSION: graph_upsert_node called from enrichment path`);
    }
    if (url.endsWith('/rest/v1/recordings') && opts.method === 'POST') {
      throw new Error(`REGRESSION: direct POST to /v1/recordings from enrichment path`);
    }

    throw new Error(`Unexpected fetch in test: ${opts.method || 'GET'} ${url}`);
  };
}

// ── Shared track fixtures ─────────────────────────────────────────────────────

function trackWithIsrcAndMbid(overrides = {}) {
  return {
    trackTitle:            'Test Track',
    isrcs:                 ['USABC0100001'],
    recordingMBID:         'mbid-rec-0000-0000-0000-000000000001',
    iswc:                  null,
    catalog_id:            null,
    writers:               [],
    enriched:              true,
    enrichmentSource:      'musicbrainz',
    ...overrides,
  };
}

// ── Test 1: Empty works.recordings receives new recording rows ───────────────

async function test1_creates_new_recording_rows() {
  console.log('\n[1] Empty works.recordings — syncEnrichmentToGraph creates new rows via public RPC');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = makeMockFetch({ calls });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  await syncEnrichmentToGraph('TestArtist', [trackWithIsrcAndMbid()]);

  global.fetch = origFetch;

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));

  assert(rpcCalls.length === 1, `rpc_upsert_recording_enrichment called once (got ${rpcCalls.length})`);
  assert(rpcCalls[0]?.body?.p_recording_patch?.isrc === 'USABC0100001',
    `p_recording_patch.isrc is ISRC (got "${rpcCalls[0]?.body?.p_recording_patch?.isrc}")`);
  assert(rpcCalls[0]?.body?.p_recording_patch?.musicbrainz_recording_id === 'mbid-rec-0000-0000-0000-000000000001',
    `p_recording_patch.musicbrainz_recording_id is MBID (got "${rpcCalls[0]?.body?.p_recording_patch?.musicbrainz_recording_id}")`);
  assert(rpcCalls[0]?.body?.p_external_id === 'USABC0100001',
    `p_external_id (node key) is ISRC (got "${rpcCalls[0]?.body?.p_external_id}")`);
  assert(rpcCalls[0]?.body?.p_external_id_ns === 'isrc',
    `p_external_id_ns is isrc (got "${rpcCalls[0]?.body?.p_external_id_ns}")`);
}

// ── Test 2: Repeated enrichment is idempotent ────────────────────────────────

async function test2_repeated_enrichment_is_idempotent() {
  console.log('\n[2] Repeated enrichment is idempotent — RPC called twice, same external_id both times');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = makeMockFetch({ calls, rpcUuids: [REC_NODE_UUID, REC_NODE_UUID, REC_NODE_UUID] });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  const track = trackWithIsrcAndMbid();

  await syncEnrichmentToGraph('TestArtist', [track]);
  await syncEnrichmentToGraph('TestArtist', [track]); // second run — must be safe

  global.fetch = origFetch;

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCalls.length === 2, `rpc_upsert_recording_enrichment called twice across two runs (got ${rpcCalls.length})`);

  // Both calls use the same external_id (ISRC) — DB ON CONFLICT idempotency handles deduplication
  const externalIds = rpcCalls.map(c => c.body?.p_external_id);
  assert(externalIds[0] === 'USABC0100001' && externalIds[1] === 'USABC0100001',
    `same p_external_id on both runs — same node targeted (got ${JSON.stringify(externalIds)})`);
}

// ── Test 3: ISRC and MBID are separate fields ────────────────────────────────

async function test3_isrc_and_mbid_are_separate_fields() {
  console.log('\n[3] ISRC and musicbrainz_recording_id remain separate, distinct fields in p_recording_patch');
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
  const patch = rpcCall?.body?.p_recording_patch;
  assert(patch?.isrc === 'USXYZ9999999',
    `p_recording_patch.isrc set to ISRC value (got "${patch?.isrc}")`);
  assert(patch?.musicbrainz_recording_id === 'mbid-distinct-0000-0000-000000000003',
    `p_recording_patch.musicbrainz_recording_id set to MBID (got "${patch?.musicbrainz_recording_id}")`);
  assert(patch?.isrc !== patch?.musicbrainz_recording_id,
    'ISRC and MBID are different values — not conflated');
  assert(!String(patch?.isrc || '').startsWith('mbid-'), 'isrc does not contain a MusicBrainz ID');
  assert(!String(patch?.musicbrainz_recording_id || '').startsWith('US'), 'musicbrainz_recording_id does not contain an ISRC');
}

// ── Test 4: No duplicate rows ────────────────────────────────────────────────

async function test4_no_duplicate_rows() {
  console.log('\n[4] No duplicate rows — RPC ON CONFLICT DO UPDATE prevents doubles; same external_id on all runs');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = makeMockFetch({ calls, rpcUuids: [REC_NODE_UUID, REC_NODE_UUID, REC_NODE_UUID] });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  const track = trackWithIsrcAndMbid({ isrcs: ['USDUP0000001'] });

  // Three enrichment runs on the same track
  await syncEnrichmentToGraph('TestArtist', [track]);
  await syncEnrichmentToGraph('TestArtist', [track]);
  await syncEnrichmentToGraph('TestArtist', [track]);

  global.fetch = origFetch;

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  assert(rpcCalls.length === 3, `3 RPC calls made across 3 runs (got ${rpcCalls.length})`);

  // All use the same external_id — DB-level ON CONFLICT ensures a single row
  const uniqueExtIds = [...new Set(rpcCalls.map(c => c.body?.p_external_id))];
  assert(uniqueExtIds.length === 1 && uniqueExtIds[0] === 'USDUP0000001',
    `all 3 RPC calls use same p_external_id (got ${JSON.stringify(uniqueExtIds)})`);
}

// ── Test 5: syncEnrichmentToGraph is awaited before res.json() ───────────────

async function test5_sync_awaited_before_response() {
  console.log('\n[5] syncEnrichmentToGraph is awaited before the HTTP response is sent');

  // Capture real setTimeout before any fast-sleep patches
  const realSetTimeout = global.setTimeout;

  let syncCompleted  = false;
  let syncDoneAtResJson = null; // value of syncCompleted when res.json() fires

  const fakeCatalog = {
    enrichedTracks: [trackWithIsrcAndMbid()],
    mbid: 'mb-fake-artist',
    artistName: 'TestArtist',
    totalReleases: 1,
    processedReleases: 1,
    totalTracks: 1,
    generatedAt: new Date().toISOString(),
  };

  // ── Module injection ──────────────────────────────────────────────────────
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
        // 15ms real delay — long enough that fire-and-forget would NOT be done at res.json()
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

  // Mock Supabase fetch for sbPost / sbPatch
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    // sbPost — must return [{ id }]
    if (url.includes('catalog_enrichments_v1') && !url.includes('?'))
      return { ok: true, json: async () => [{ id: 'job-test-5' }], text: async () => JSON.stringify([{ id: 'job-test-5' }]) };
    // sbPatch and any other Supabase calls
    return { ok: true, json: async () => null, text: async () => '' };
  };

  // Mock req / res
  let responseCode = null;
  const res = {
    setHeader: () => {},
    status: (code) => ({
      json: (data) => {
        responseCode = code;
        syncDoneAtResJson = syncCompleted; // snapshot: was sync done when response fired?
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
  assert(syncCompleted === true,
    'syncEnrichmentToGraph fully completed before handler returned');
  assert(syncDoneAtResJson === true,
    'syncEnrichmentToGraph was done when res.json() was called (not fire-and-forget)');
}

// ── Test 6: Existing rows are updated safely ──────────────────────────────────

async function test6_existing_rows_updated_safely() {
  console.log('\n[6] Existing works.recordings row — MBID added safely via RPC, ISRC preserved by COALESCE');
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
  const patch = rpcCall?.body?.p_recording_patch;
  assert(patch?.isrc === 'USEXI0000006',
    `ISRC in p_recording_patch (got "${patch?.isrc}")`);
  assert(patch?.musicbrainz_recording_id === 'mbid-existing-row-00000000000006',
    `MBID in p_recording_patch (got "${patch?.musicbrainz_recording_id}")`);
}

// ── Test 7: MBID-only first run → ISRC discovered later → same node_id ───────
//
// Proves the duplicate-row guard: when a recording was first written with
// only an MBID (no ISRC at the time), and a subsequent enrichment run
// discovers the ISRC, the existing MBID-keyed node_id is reused rather than
// creating a second ISRC-keyed row.

async function test7_mbid_first_isrc_later_reuses_same_node() {
  console.log('\n[7] Duplicate-row guard — MBID-first then ISRC-later passes p_existing_node_id on run 2');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const mbid     = 'mbid-transition-0000-0000-000000000007';
  const MBID_UUID = 'cccccccc-7777-0000-0000-000000000007';
  let mbidNodeCreated = false;
  const calls = [];
  const origFetch = global.fetch;

  global.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method || 'GET', body });

    // Public RPC — called on both runs
    if (url.includes('/rpc/rpc_upsert_recording_enrichment')) {
      mbidNodeCreated = true;
      return { ok: true, text: async () => JSON.stringify({ node_id: MBID_UUID }) };
    }
    // graph.nodes GET (guard) — returns the MBID node after run 1 created it
    if (url.includes('/rest/v1/nodes') && (opts.method === 'GET' || !opts.method)) {
      if (mbidNodeCreated && url.includes(encodeURIComponent(mbid)) && url.includes('musicbrainz_recording')) {
        return { ok: true, text: async () => JSON.stringify([{ id: MBID_UUID }]) };
      }
      return { ok: true, text: async () => JSON.stringify([]) };
    }
    throw new Error(`Unexpected: ${opts.method || 'GET'} ${url}`);
  };

  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  // Run 1: MBID only — no ISRC known yet; no guard fires (normalIsrc is null)
  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Transition Track',
    isrcs: [],
    recordingMBID: mbid,
  }]);

  // Run 2: ISRC now available; guard 1 finds MBID_UUID → p_existing_node_id set
  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Transition Track',
    isrcs: ['USTRT0000007'],
    recordingMBID: mbid,
  }]);

  global.fetch = origFetch;

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));

  assert(rpcCalls.length === 2,
    `RPC called once per run (got ${rpcCalls.length})`);
  assert(rpcCalls[0]?.body?.p_existing_node_id === null,
    `run 1: p_existing_node_id is null — new node created (got "${rpcCalls[0]?.body?.p_existing_node_id}")`);
  assert(rpcCalls[1]?.body?.p_existing_node_id === MBID_UUID,
    `run 2: p_existing_node_id is MBID_UUID — guard reused (got "${rpcCalls[1]?.body?.p_existing_node_id}")`);
  assert(rpcCalls[1]?.body?.p_recording_patch?.isrc === 'USTRT0000007',
    `run 2 p_recording_patch contains ISRC (got "${rpcCalls[1]?.body?.p_recording_patch?.isrc}")`);
  assert(rpcCalls[1]?.body?.p_recording_patch?.musicbrainz_recording_id === mbid,
    `run 2 p_recording_patch contains MBID (got "${rpcCalls[1]?.body?.p_recording_patch?.musicbrainz_recording_id}")`);
}

// ── Test 8: Catalog-submitted first → enrichment with ISRC → same node_id ────
//
// Proves the duplicate-row guard for the cross-path case: a track submitted
// through submit-catalog.js (keyed by rec_{catalog_id} in musigod_catalog ns)
// and then enriched with an ISRC by enrich-artist.js reuses the catalog node.

async function test8_catalog_keyed_first_isrc_on_enrichment_reuses_same_node() {
  console.log('\n[8] Duplicate-row guard — catalog-keyed node reused: p_existing_node_id set, no new node');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const catalogId    = 'cat-track-00000008';
  const CATALOG_UUID = 'dddddddd-8888-0000-0000-000000000008';
  const calls = [];
  const origFetch = global.fetch;

  global.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method || 'GET', body });

    if (url.includes('/rpc/rpc_upsert_recording_enrichment')) {
      return { ok: true, text: async () => JSON.stringify({ node_id: CATALOG_UUID }) };
    }
    if (url.includes('/rest/v1/nodes') && (opts.method === 'GET' || !opts.method)) {
      // Guard 2 finds the catalog-keyed recording node
      if (url.includes(`rec_${catalogId}`) && url.includes('musigod_catalog')) {
        return { ok: true, text: async () => JSON.stringify([{ id: CATALOG_UUID }]) };
      }
      return { ok: true, text: async () => JSON.stringify([]) };
    }
    throw new Error(`Unexpected: ${opts.method || 'GET'} ${url}`);
  };

  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle:    'Catalog Track',
    catalog_id:    catalogId,
    isrcs:         ['USCAT0000008'],
    recordingMBID: null,
  }]);

  global.fetch = origFetch;

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  const nodeRpcCalls = calls.filter(c => c.url.includes('/rpc/graph_upsert_node'));

  assert(nodeRpcCalls.length === 0,
    `graph_upsert_node NOT called — catalog-keyed node found and reused (got ${nodeRpcCalls.length})`);
  assert(rpcCalls.length === 1,
    `rpc_upsert_recording_enrichment called once (got ${rpcCalls.length})`);
  assert(rpcCalls[0]?.body?.p_existing_node_id === CATALOG_UUID,
    `p_existing_node_id is catalog UUID — no new ISRC-keyed node (got "${rpcCalls[0]?.body?.p_existing_node_id}")`);
  assert(rpcCalls[0]?.body?.p_recording_patch?.isrc === 'USCAT0000008',
    `ISRC in p_recording_patch for existing row update (got "${rpcCalls[0]?.body?.p_recording_patch?.isrc}")`);
  assert(rpcCalls[0]?.body?.p_external_id === null,
    `p_external_id is null — no new node creation (got "${rpcCalls[0]?.body?.p_external_id}")`);
}

// ── Test 9: MBID-only (no ISRC, no catalog_id) — idempotent, no duplicate rows ─
//
// When a track has only a recordingMBID (no ISRC, no catalog_id), the code
// takes the else-MBID-keyed path directly without any findNodeByExternalId
// guard. Two enrichment runs must produce the same node_id in both POST
// bodies — no duplicate rows.

async function test9_mbid_only_no_isrc_no_catalogid_idempotent() {
  console.log('\n[9] MBID-only (no ISRC, no catalog_id) — idempotent across two runs via public RPC');
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

  const rpcCalls   = calls.filter(c => c.url.includes('/rpc/rpc_upsert_recording_enrichment'));
  const getLookups = calls.filter(c => c.url.includes('/rest/v1/nodes') && (c.method === 'GET' || !c.method));

  assert(getLookups.length === 0,
    `no graph.nodes lookups — MBID-only path skips guard (got ${getLookups.length})`);
  assert(rpcCalls.length === 2,
    `rpc_upsert_recording_enrichment called once per run (got ${rpcCalls.length})`);

  const extIds = rpcCalls.map(c => c.body?.p_external_id);
  assert(extIds.every(id => id === mbid),
    `both calls use MBID as p_external_id (got ${JSON.stringify(extIds)})`);
  assert(rpcCalls[0]?.body?.p_external_id_ns === 'musicbrainz_recording',
    `node keyed with musicbrainz_recording namespace (got "${rpcCalls[0]?.body?.p_external_id_ns}")`);
  assert(rpcCalls.every(c => !c.body?.p_recording_patch?.isrc),
    'p_recording_patch.isrc absent on both runs (no ISRC on this track)');
  assert(rpcCalls.every(c => c.body?.p_recording_patch?.musicbrainz_recording_id === mbid),
    `MBID in p_recording_patch on both runs (got ${JSON.stringify(rpcCalls.map(c => c.body?.p_recording_patch?.musicbrainz_recording_id))})`);
}

// ── Test 10: Worker path (run-enrichment-job.js) calls and awaits graph sync ─
//
// Verifies that the n8n/worker handler (run-enrichment-job.js) calls
// syncEnrichmentToGraph and awaits it before sending the DONE response.

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
      json: (data) => {
        responseCode = code;
        syncDoneAtResJson = syncCompleted;
        return data;
      },
      end: () => {},
    }),
  };
  const req = {
    method: 'POST',
    headers: {},
    body: { job_id: 'job-test-10', artistName: 'TestArtist', maxReleases: 1 },
  };

  try {
    await handler(req, res);
  } finally {
    for (const [k, p] of Object.entries(modPaths)) {
      if (savedCache[k]) require.cache[p] = savedCache[k];
      else delete require.cache[p];
    }
    global.fetch = origFetch;
    if (savedN8n !== undefined) process.env.N8N_ENRICH_TOKEN = savedN8n;
    else delete process.env.N8N_ENRICH_TOKEN;
    if (savedAdmin !== undefined) process.env.AUDIT_ADMIN_KEY = savedAdmin;
    else delete process.env.AUDIT_ADMIN_KEY;
  }

  assert(responseCode === 200,
    `worker handler returns 200 (got ${responseCode})`);
  assert(syncCompleted === true,
    'syncEnrichmentToGraph fully completed before handler returned');
  assert(syncDoneAtResJson === true,
    'sync was done when res.json() fired — not fire-and-forget');
}

// ── Test 11: Worker path — ERROR returned (not DONE) when graph sync throws ──
//
// Verifies that if syncEnrichmentToGraph throws, the worker handler does NOT
// write status=DONE to Supabase and does NOT return HTTP 200. The production
// n8n path must fail loudly so the caller knows graph persistence did not occur.

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
      syncEnrichmentToGraph: async () => {
        syncCalled = true;
        throw new Error('simulated graph sync failure');
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
      json: (data) => {
        responseCode = code;
        responseBody = data;
        return data;
      },
      end: () => {},
    }),
  };
  const req = {
    method: 'POST',
    headers: {},
    body: { job_id: 'job-test-11', artistName: 'TestArtist', maxReleases: 1 },
  };

  try {
    await handler(req, res);
  } finally {
    for (const [k, p] of Object.entries(modPaths)) {
      if (savedCache[k]) require.cache[p] = savedCache[k];
      else delete require.cache[p];
    }
    global.fetch = origFetch;
    if (savedN8n !== undefined) process.env.N8N_ENRICH_TOKEN = savedN8n;
    else delete process.env.N8N_ENRICH_TOKEN;
    if (savedAdmin !== undefined) process.env.AUDIT_ADMIN_KEY = savedAdmin;
    else delete process.env.AUDIT_ADMIN_KEY;
  }

  assert(syncCalled === true,
    'syncEnrichmentToGraph was called on the worker path');
  assert(responseCode === 500,
    `handler returns 500 on graph sync failure (got ${responseCode})`);
  assert(responseBody?.status === 'ERROR',
    `response body status is ERROR (got "${responseBody?.status}")`);
  assert(responseBody?.status !== 'DONE',
    'response body status is NOT DONE');

  const donePatches = sbPatchBodies.filter(b => b.status === 'DONE');
  assert(donePatches.length === 0,
    `Supabase never patched with status=DONE on graph sync failure (got ${donePatches.length})`);

  const errorPatches = sbPatchBodies.filter(b => b.status === 'ERROR');
  assert(errorPatches.length >= 1,
    `Supabase patched with status=ERROR (got ${errorPatches.length})`);
}

// ── Test 12: enrich-artist.js UI path captures graph stats in DONE result ─────
//
// Verifies that when syncEnrichmentToGraph returns partial failures (e.g., all
// node upserts fail because the RPC is missing), enrich-artist.js includes
// graphSynced and graphSyncFailed in the DONE result rather than discarding them.

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
  const req = {
    method:  'POST',
    headers: {},
    body:    { artistName: 'TestArtist12', maxReleases: 1 },
  };

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

// ── Test 13: enrich-artist.js UI path still returns DONE when graph sync fails ─
//
// When syncEnrichmentToGraph throws (catastrophic failure, not per-track), the
// enrich-artist.js UI path must still return DONE — graph sync is non-fatal on
// this path — but graphSyncFailed must reflect the full track count.

async function test13_enrich_artist_done_with_failed_stats_on_graph_throw() {
  console.log('\n[13] enrich-artist.js — DONE returned even when graph sync throws; graphSyncFailed reflects track count');

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
  const req = {
    method:  'POST',
    headers: {},
    body:    { artistName: 'TestArtist13', maxReleases: 1 },
  };

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
  assert(donePatches.length >= 1, 'Supabase patched with status=DONE despite graph sync throw');

  const donePatch = donePatches[0];
  assert(donePatch?.result?.graphSynced === 0,
    `result.graphSynced is 0 (got ${donePatch?.result?.graphSynced})`);
  assert(donePatch?.result?.graphSyncFailed === 1,
    `result.graphSyncFailed equals track count (1) on catastrophic throw (got ${donePatch?.result?.graphSyncFailed})`);
}

// ── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== graph-sync-enrichment-upsert.test.js ===');
  console.log('Upsert path: upsertNode + POST recordings?merge-duplicates\n');

  await test1_creates_new_recording_rows();
  await test2_repeated_enrichment_is_idempotent();
  await test3_isrc_and_mbid_are_separate_fields();
  await test4_no_duplicate_rows();
  await test5_sync_awaited_before_response();
  await test6_existing_rows_updated_safely();
  await test7_mbid_first_isrc_later_reuses_same_node();
  await test8_catalog_keyed_first_isrc_on_enrichment_reuses_same_node();
  await test9_mbid_only_no_isrc_no_catalogid_idempotent();
  await test10_worker_path_calls_and_awaits_graph_sync();
  await test11_worker_error_not_done_on_graph_sync_failure();
  await test12_enrich_artist_captures_graph_stats_in_done();
  await test13_enrich_artist_done_with_failed_stats_on_graph_throw();

  console.log(`\n${'─'.repeat(50)}`);
  const total = passed + failed;
  if (failed > 0) {
    console.error(`${total} assertions | ${passed} passed | ${failed} FAILED`);
  } else {
    console.log(`${total} assertions | ${total} passed`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
