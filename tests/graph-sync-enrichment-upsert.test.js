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

    // graph_nodes_v1 GET — returns existing work node or empty
    if (url.includes('/rest/v1/graph_nodes_v1')) {
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
    // graph_nodes_v1 GET — return MBID node only after it was created in run 1
    if (url.includes('/rest/v1/graph_nodes_v1')) {
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
    if (url.includes('/rest/v1/graph_nodes_v1')) {
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

  console.log(`\n${'─'.repeat(50)}`);
  const total = passed + failed;
  if (failed > 0) {
    console.error(`${total} assertions | ${passed} passed | ${failed} FAILED`);
  } else {
    console.log(`${total} assertions | ${total} passed`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
