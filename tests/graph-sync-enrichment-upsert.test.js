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

    // graph_upsert_node RPC — returns next UUID in sequence (same UUID for idempotency tests)
    if (url.includes('/rpc/graph_upsert_node')) {
      const uuid = rpcUuids[Math.min(rpcCallIndex, rpcUuids.length - 1)];
      rpcCallIndex++;
      return { ok: true, text: async () => JSON.stringify(uuid) };
    }

    // graph.nodes GET (findNodeByExternalId) — returns existing node or empty
    if (url.includes('/rest/v1/nodes') && (opts.method === 'GET' || !opts.method)) {
      const row = workNodeId ? [{ id: workNodeId }] : [];
      return { ok: true, text: async () => JSON.stringify(row) };
    }

    // recordings POST (works schema)
    if (url.endsWith('/rest/v1/recordings') && opts.method === 'POST') {
      return { ok: true, text: async () => '' };
    }

    // compositions PATCH (works schema)
    if (url.includes('/rest/v1/compositions') && opts.method === 'PATCH') {
      return { ok: true, text: async () => '' };
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
  console.log('\n[1] Empty works.recordings — syncEnrichmentToGraph creates new rows');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = makeMockFetch({ calls });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  await syncEnrichmentToGraph('TestArtist', [trackWithIsrcAndMbid()]);

  global.fetch = origFetch;

  const rpcCalls = calls.filter(c => c.url.includes('/rpc/graph_upsert_node'));
  const recPostCalls = calls.filter(c => c.url.endsWith('/rest/v1/recordings') && c.method === 'POST');

  assert(rpcCalls.length >= 1, `graph_upsert_node RPC called at least once (got ${rpcCalls.length})`);
  assert(recPostCalls.length === 1, `POST to works.recordings called once (got ${recPostCalls.length})`);
  assert(recPostCalls[0]?.body?.node_id === REC_NODE_UUID,
    `recording row node_id matches upsertNode return (got "${recPostCalls[0]?.body?.node_id}")`);
  assert(recPostCalls[0]?.body?.isrc === 'USABC0100001',
    `recording row has ISRC (got "${recPostCalls[0]?.body?.isrc}")`);
  assert(recPostCalls[0]?.body?.musicbrainz_recording_id === 'mbid-rec-0000-0000-0000-000000000001',
    `recording row has MBID (got "${recPostCalls[0]?.body?.musicbrainz_recording_id}")`);
}

// ── Test 2: Repeated enrichment is idempotent ────────────────────────────────

async function test2_repeated_enrichment_is_idempotent() {
  console.log('\n[2] Repeated enrichment is idempotent — same node_id, merge-duplicates on every run');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  // upsertNode always returns the same UUID (idempotent by external_id + external_id_ns)
  const origFetch = global.fetch;
  global.fetch = makeMockFetch({ calls, rpcUuids: [REC_NODE_UUID, REC_NODE_UUID, REC_NODE_UUID] });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  const track = trackWithIsrcAndMbid();

  await syncEnrichmentToGraph('TestArtist', [track]);
  await syncEnrichmentToGraph('TestArtist', [track]); // second run — must be safe

  global.fetch = origFetch;

  const rpcCalls    = calls.filter(c => c.url.includes('/rpc/graph_upsert_node'));
  const recPostCalls = calls.filter(c => c.url.endsWith('/rest/v1/recordings') && c.method === 'POST');

  // graph_upsert_node called twice (once per enrichment run)
  assert(rpcCalls.length === 2, `graph_upsert_node called twice across two runs (got ${rpcCalls.length})`);

  // Both POST calls use merge-duplicates — PostgREST handles idempotency at DB level
  const preferHeaders = recPostCalls.map(c => c.headers?.['Prefer'] || '');
  assert(recPostCalls.length === 2, `POST to recordings called twice (got ${recPostCalls.length})`);
  assert(preferHeaders.every(h => h.includes('resolution=merge-duplicates')),
    `all recordings POST calls carry Prefer: resolution=merge-duplicates`);

  // Both calls use the same node_id — same row is targeted, no new row created
  const nodeIds = recPostCalls.map(c => c.body?.node_id);
  assert(nodeIds[0] === REC_NODE_UUID && nodeIds[1] === REC_NODE_UUID,
    `same node_id on both runs — same DB row targeted (got ${nodeIds})`);
}

// ── Test 3: ISRC and MBID are separate fields ────────────────────────────────

async function test3_isrc_and_mbid_are_separate_fields() {
  console.log('\n[3] ISRC and musicbrainz_recording_id remain separate, distinct columns');
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

  const post = calls.find(c => c.url.endsWith('/rest/v1/recordings') && c.method === 'POST');
  assert(post !== undefined, 'recordings POST was called');
  assert(post?.body?.isrc === 'USXYZ9999999',
    `isrc field set to ISRC value (got "${post?.body?.isrc}")`);
  assert(post?.body?.musicbrainz_recording_id === 'mbid-distinct-0000-0000-000000000003',
    `musicbrainz_recording_id field set to MBID (got "${post?.body?.musicbrainz_recording_id}")`);
  assert(post?.body?.isrc !== post?.body?.musicbrainz_recording_id,
    'ISRC and MBID are different values in different fields — not conflated');
  assert(!String(post?.body?.isrc || '').startsWith('mbid-'),
    'isrc column does not contain a MusicBrainz ID');
  assert(!String(post?.body?.musicbrainz_recording_id || '').startsWith('US'),
    'musicbrainz_recording_id column does not contain an ISRC');
}

// ── Test 4: No duplicate rows ────────────────────────────────────────────────

async function test4_no_duplicate_rows() {
  console.log('\n[4] No duplicate rows — upsertNode idempotency + merge-duplicates prevents doubles');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  const origFetch = global.fetch;
  // Always return same UUID — simulates DB idempotency of graph_upsert_node
  global.fetch = makeMockFetch({ calls, rpcUuids: [REC_NODE_UUID, REC_NODE_UUID, REC_NODE_UUID] });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  const track = trackWithIsrcAndMbid({ isrcs: ['USDUP0000001'] });

  // Three enrichment runs on the same track
  await syncEnrichmentToGraph('TestArtist', [track]);
  await syncEnrichmentToGraph('TestArtist', [track]);
  await syncEnrichmentToGraph('TestArtist', [track]);

  global.fetch = origFetch;

  const recPostCalls = calls.filter(c => c.url.endsWith('/rest/v1/recordings') && c.method === 'POST');
  assert(recPostCalls.length === 3, `3 POST calls made across 3 runs (got ${recPostCalls.length})`);

  // All use the same node_id — they target the same row (update, not insert)
  const uniqueNodeIds = [...new Set(recPostCalls.map(c => c.body?.node_id))];
  assert(uniqueNodeIds.length === 1 && uniqueNodeIds[0] === REC_NODE_UUID,
    `all 3 POST calls target the same node_id — only 1 row exists (got ${uniqueNodeIds})`);

  // All carry merge-duplicates — PostgREST ON CONFLICT DO UPDATE, not raw INSERT
  const allMergeDuplicates = recPostCalls.every(c =>
    (c.headers?.['Prefer'] || '').includes('resolution=merge-duplicates')
  );
  assert(allMergeDuplicates, 'all POST calls carry resolution=merge-duplicates (DB-level deduplication)');
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
  console.log('\n[6] Existing works.recordings row — MBID written safely without clobbering ISRC');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const calls = [];
  const origFetch = global.fetch;
  // Simulate: recording node already exists in graph (upsertNode returns its UUID)
  global.fetch = makeMockFetch({ calls, rpcUuids: [REC_NODE_UUID] });

  const { syncEnrichmentToGraph } = loadFreshGraphSync();
  // Track that already has an ISRC in the graph; enrichment discovered the MBID
  await syncEnrichmentToGraph('TestArtist', [
    trackWithIsrcAndMbid({
      isrcs:         ['USEXI0000006'],
      recordingMBID: 'mbid-existing-row-00000000000006',
    }),
  ]);

  global.fetch = origFetch;

  const post = calls.find(c => c.url.endsWith('/rest/v1/recordings') && c.method === 'POST');
  assert(post !== undefined, 'recordings POST called for existing row');
  assert(post?.body?.node_id === REC_NODE_UUID,
    `uses same node_id as existing row (got "${post?.body?.node_id}")`);
  assert(post?.body?.isrc === 'USEXI0000006',
    `ISRC preserved in POST body (got "${post?.body?.isrc}")`);
  assert(post?.body?.musicbrainz_recording_id === 'mbid-existing-row-00000000000006',
    `MBID added to existing row (got "${post?.body?.musicbrainz_recording_id}")`);
  assert((post?.headers?.['Prefer'] || '').includes('resolution=merge-duplicates'),
    'merge-duplicates prevents a second row being inserted for the existing node');
}

// ── Test 7: MBID-only first run → ISRC discovered later → same node_id ───────
//
// Proves the duplicate-row guard: when a recording was first written with
// only an MBID (no ISRC at the time), and a subsequent enrichment run
// discovers the ISRC, the existing MBID-keyed node_id is reused rather than
// creating a second ISRC-keyed row.

async function test7_mbid_first_isrc_later_reuses_same_node() {
  console.log('\n[7] Duplicate-row guard — MBID-first then ISRC-later reuses same node_id');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const mbid     = 'mbid-transition-0000-0000-000000000007';
  const MBID_UUID = 'cccccccc-7777-0000-0000-000000000007';
  let mbidNodeCreated = false;
  const calls = [];
  const origFetch = global.fetch;

  global.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method || 'GET', body });

    // graph_upsert_node RPC — only fires on run 1 (MBID-only path)
    if (url.includes('/rpc/graph_upsert_node')) {
      mbidNodeCreated = true;
      return { ok: true, text: async () => JSON.stringify(MBID_UUID) };
    }
    // graph.nodes GET (findNodeByExternalId) — return MBID node only after it was created in run 1
    if (url.includes('/rest/v1/nodes') && (opts.method === 'GET' || !opts.method)) {
      if (mbidNodeCreated && url.includes(encodeURIComponent(mbid)) && url.includes('musicbrainz_recording')) {
        return { ok: true, text: async () => JSON.stringify([{ id: MBID_UUID }]) };
      }
      return { ok: true, text: async () => JSON.stringify([]) };
    }
    if (url.includes('/rest/v1/recordings') && opts.method === 'POST') {
      return { ok: true, text: async () => '' };
    }
    throw new Error(`Unexpected: ${opts.method || 'GET'} ${url}`);
  };

  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  // Run 1: MBID only — no ISRC known yet
  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Transition Track',
    isrcs: [],
    recordingMBID: mbid,
  }]);

  // Run 2: ISRC now available (MusicBrainz added it)
  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle: 'Transition Track',
    isrcs: ['USTRT0000007'],
    recordingMBID: mbid,
  }]);

  global.fetch = origFetch;

  const rpcCalls  = calls.filter(c => c.url.includes('/rpc/graph_upsert_node'));
  const postCalls = calls.filter(c => c.url.includes('/rest/v1/recordings') && c.method === 'POST');
  const nodeIds   = postCalls.map(c => c.body?.node_id);

  assert(rpcCalls.length === 1,
    `upsertNode called only once (run 1 MBID-only) — not called again on run 2 (got ${rpcCalls.length})`);
  assert(postCalls.length === 2,
    `POST to recordings twice — one per run (got ${postCalls.length})`);
  assert(nodeIds[0] === MBID_UUID && nodeIds[1] === MBID_UUID,
    `both runs use the same node_id — no duplicate row created (got ${JSON.stringify(nodeIds)})`);
  assert(postCalls[1]?.body?.isrc === 'USTRT0000007',
    `run 2 POST body contains ISRC (got "${postCalls[1]?.body?.isrc}")`);
  assert(postCalls[1]?.body?.musicbrainz_recording_id === mbid,
    `run 2 POST body contains MBID (got "${postCalls[1]?.body?.musicbrainz_recording_id}")`);
}

// ── Test 8: Catalog-submitted first → enrichment with ISRC → same node_id ────
//
// Proves the duplicate-row guard for the cross-path case: a track submitted
// through submit-catalog.js (keyed by rec_{catalog_id} in musigod_catalog ns)
// and then enriched with an ISRC by enrich-artist.js reuses the catalog node.

async function test8_catalog_keyed_first_isrc_on_enrichment_reuses_same_node() {
  console.log('\n[8] Duplicate-row guard — catalog-keyed node reused when ISRC discovered on enrichment');
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  const catalogId    = 'cat-track-00000008';
  const CATALOG_UUID = 'dddddddd-8888-0000-0000-000000000008';
  const calls = [];
  const origFetch = global.fetch;

  global.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method || 'GET', body });

    if (url.includes('/rpc/graph_upsert_node')) {
      return { ok: true, text: async () => JSON.stringify(CATALOG_UUID) };
    }
    if (url.includes('/rest/v1/nodes') && (opts.method === 'GET' || !opts.method)) {
      // Catalog-keyed recording node (rec_cat-track-00000008 in musigod_catalog)
      if (url.includes(`rec_${catalogId}`) && url.includes('musigod_catalog')) {
        return { ok: true, text: async () => JSON.stringify([{ id: CATALOG_UUID }]) };
      }
      return { ok: true, text: async () => JSON.stringify([]) };
    }
    if (url.includes('/rest/v1/recordings') && opts.method === 'POST') {
      return { ok: true, text: async () => '' };
    }
    throw new Error(`Unexpected: ${opts.method || 'GET'} ${url}`);
  };

  const { syncEnrichmentToGraph } = loadFreshGraphSync();

  // Enrichment run: track has catalogId + ISRC (was previously in catalog submission)
  await syncEnrichmentToGraph('TestArtist', [{
    trackTitle:  'Catalog Track',
    catalog_id:  catalogId,
    isrcs:       ['USCAT0000008'],
    recordingMBID: null,
  }]);

  global.fetch = origFetch;

  const rpcCalls  = calls.filter(c => c.url.includes('/rpc/graph_upsert_node'));
  const postCalls = calls.filter(c => c.url.includes('/rest/v1/recordings') && c.method === 'POST');

  assert(rpcCalls.length === 0,
    `upsertNode NOT called — existing catalog-keyed node found and reused (got ${rpcCalls.length})`);
  assert(postCalls.length === 1,
    `POST to recordings once (got ${postCalls.length})`);
  assert(postCalls[0]?.body?.node_id === CATALOG_UUID,
    `POST uses catalog node UUID — no new ISRC-keyed row created (got "${postCalls[0]?.body?.node_id}")`);
  assert(postCalls[0]?.body?.isrc === 'USCAT0000008',
    `ISRC correctly written to existing catalog row (got "${postCalls[0]?.body?.isrc}")`);
}

// ── Test 9: MBID-only (no ISRC, no catalog_id) — idempotent, no duplicate rows ─
//
// When a track has only a recordingMBID (no ISRC, no catalog_id), the code
// takes the else-MBID-keyed path directly without any findNodeByExternalId
// guard. Two enrichment runs must produce the same node_id in both POST
// bodies — no duplicate rows.

async function test9_mbid_only_no_isrc_no_catalogid_idempotent() {
  console.log('\n[9] MBID-only (no ISRC, no catalog_id) — idempotent across two runs');
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

  const rpcCalls   = calls.filter(c => c.url.includes('/rpc/graph_upsert_node'));
  const getLookups = calls.filter(c => c.url.includes('/rest/v1/nodes') && c.method === 'GET');
  const postCalls  = calls.filter(c => c.url.endsWith('/rest/v1/recordings') && c.method === 'POST');
  const nodeIds    = postCalls.map(c => c.body?.node_id);

  assert(getLookups.length === 0,
    `no graph.nodes lookups — MBID-only path skips findNodeByExternalId (got ${getLookups.length})`);
  assert(rpcCalls.length === 2,
    `graph_upsert_node called once per run (got ${rpcCalls.length})`);

  const extIds = rpcCalls.map(c => c.body?.p_external_id);
  assert(extIds.every(id => id === mbid),
    `both upsertNode calls use MBID as external_id (got ${JSON.stringify(extIds)})`);
  assert(rpcCalls[0]?.body?.p_external_ns === 'musicbrainz_recording',
    `node keyed with musicbrainz_recording namespace (got "${rpcCalls[0]?.body?.p_external_ns}")`);

  assert(postCalls.length === 2,
    `POST to recordings twice — one per run (got ${postCalls.length})`);
  assert(nodeIds[0] === MBID_UUID && nodeIds[1] === MBID_UUID,
    `same node_id on both runs — no duplicate row (got ${JSON.stringify(nodeIds)})`);
  assert(postCalls.every(c => (c.headers?.['Prefer'] || '').includes('resolution=merge-duplicates')),
    'all POST calls carry resolution=merge-duplicates');
  assert(postCalls.every(c => !c.body?.isrc),
    'isrc field absent from both POST bodies (no ISRC on this track)');
  assert(postCalls.every(c => c.body?.musicbrainz_recording_id === mbid),
    `MBID written to musicbrainz_recording_id on both runs (got ${JSON.stringify(postCalls.map(c => c.body?.musicbrainz_recording_id))})`);
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
