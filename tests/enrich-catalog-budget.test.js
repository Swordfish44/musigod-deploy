'use strict';
// tests/enrich-catalog-budget.test.js
// Regression suite for the outer-loop budget guard in lib/enrich-catalog.js.
//
// Tests:
//   1. Guard fires before 300s Vercel timeout — returns cleanly, does not throw
//   2. Already-collected tracks returned in partial batch when guard fires
//   3. Partial batch has valid structure for syncEnrichmentToGraph / persistEnrichedTracks
//   4. Normal runs under budget are unchanged (both releases fully processed)

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else       { console.error(`  ❌ FAIL: ${label}`); failed++; }
}

// ── Constants ────────────────────────────────────────────────────────────────

const FAKE_T   = 1_000_000_000_000; // arbitrary fixed base timestamp
const OVER_T   = FAKE_T + 250_000;  // startMs + 250s → exceeds 240s BUDGET_MS

// ── Module management ────────────────────────────────────────────────────────

function loadFreshEnrichCatalog() {
  const deps = [
    '../lib/enrich-catalog',
    '../lib/discogs',
    '../lib/genius',
    '../lib/overrides',
  ];
  for (const d of deps) {
    try { delete require.cache[require.resolve(d)]; } catch {}
  }
  return require('../lib/enrich-catalog');
}

// ── Sleep patch (eliminates 500ms MB + 1100ms Discogs rate-limit sleeps) ─────

let _origSetTimeout = null;

function installFastSleep() {
  _origSetTimeout = global.setTimeout;
  global.setTimeout = (fn, _ms, ...args) => _origSetTimeout(fn, 0, ...args);
}

function restoreSleep() {
  if (_origSetTimeout) { global.setTimeout = _origSetTimeout; _origSetTimeout = null; }
}

// ── MB / Discogs response body builders ──────────────────────────────────────

function mbArtistBody(name, mbid) {
  return { artists: [{ id: mbid, name }] };
}

function mbReleaseGroupsBody() {
  return {
    'release-groups': [
      { id: 'rg-a', title: 'First Album',  'primary-type': 'Album', 'first-release-date': '2000' },
      { id: 'rg-b', title: 'Second Album', 'primary-type': 'Album', 'first-release-date': '2001' },
    ],
  };
}

function mbReleasesBody(releaseId) {
  return { releases: [{ id: releaseId }] };
}

function mbReleaseTracksBody(tracks) {
  return {
    media: [{
      tracks: tracks.map((t, i) => ({
        number: String(i + 1),
        title: t.title,
        recording: {
          id: t.recordingMBID || null,
          title: t.title,
          isrcs: t.isrcs || [],
          'artist-credit': [],
          length: null,
        },
      })),
    }],
  };
}

function mbWorkRelsBody() {
  return { relations: [] }; // no linked works → triggers Discogs fallback
}

function discogsSearchBody() {
  return { results: [], pagination: { pages: 1 } }; // no candidates
}

function geniusEmptyBody() {
  return { response: { hits: [] } };
}

// ── Standard two-release mock fetch ─────────────────────────────────────────
//
// Covers: MB artist, release-groups, first-release for A+B, release tracks for A+B,
// recording work-rels, Discogs search, Genius search.
//
// Options:
//   onReleaseATracks — callback fired synchronously before returning release-A tracks
//                      (used to flip isOverBudget flag at the right moment)
//   allowGenius      — if false (default), Genius fetch throws (proves budget guard
//                      prevents Genius from being called when budget is exceeded)

function makeMockFetch({ onReleaseATracks, allowGenius = false } = {}) {
  return async (url) => {
    // MB artist search
    if (url.includes('/ws/2/artist/'))
      return { ok: true, json: async () => mbArtistBody('TestArtist', 'mb-test-1') };

    // MB release groups (first page; < limit so loop exits)
    if (url.includes('/ws/2/release-group?'))
      return { ok: true, json: async () => mbReleaseGroupsBody() };

    // MB first release for group A
    if (url.includes('release?release-group=rg-a'))
      return { ok: true, json: async () => mbReleasesBody('rel-a1') };

    // MB first release for group B
    if (url.includes('release?release-group=rg-b'))
      return { ok: true, json: async () => mbReleasesBody('rel-b1') };

    // MB full tracklist for release A — flip clock after body is built but before returning
    if (url.includes('/ws/2/release/rel-a1')) {
      const body = mbReleaseTracksBody([
        { title: 'Track One', recordingMBID: 'rec-a1', isrcs: ['USABC0100001'] },
        { title: 'Track Two', recordingMBID: 'rec-a2', isrcs: ['USABC0100002'] },
      ]);
      if (onReleaseATracks) onReleaseATracks();
      return { ok: true, json: async () => body };
    }

    // MB full tracklist for release B
    if (url.includes('/ws/2/release/rel-b1'))
      return { ok: true, json: async () => mbReleaseTracksBody([
        { title: 'Album B Track', recordingMBID: 'rec-b1', isrcs: [] },
      ]) };

    // MB recording work-rels — no linked work
    if (url.includes('/ws/2/recording/'))
      return { ok: true, json: async () => mbWorkRelsBody() };

    // Discogs release search — no candidates (no getReleaseCredits call follows)
    if (url.includes('api.discogs.com/database/search'))
      return { ok: true, json: async () => discogsSearchBody() };

    // Genius search — allowed only when budget is NOT exceeded (test 4)
    if (url.includes('api.genius.com')) {
      if (!allowGenius) throw new Error(`Genius must not be called when budget is exceeded: ${url}`);
      return { ok: true, json: async () => geniusEmptyBody() };
    }

    throw new Error(`Unexpected fetch in test: ${url}`);
  };
}

// ── Test 1: Guard fires at first iteration, returns without throwing ──────────

async function test1_guard_fires_returns_cleanly() {
  console.log('\n[1] Budget guard fires immediately — returns cleanly, enrichedTracks empty');
  installFastSleep();
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  // First Date.now() call (in enrichArtistCatalog: startMs = Date.now()) → FAKE_T.
  // Every subsequent call (outer-loop withinBudget check) → OVER_T → budget exceeded.
  let callCount = 0;
  const origDateNow = Date.now;
  Date.now = () => ++callCount === 1 ? FAKE_T : OVER_T;

  // Guard fires at i=0 before getFirstReleaseId — only artist + release-group fetches needed
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/ws/2/artist/'))        return { ok: true, json: async () => mbArtistBody('TestArtist', 'mb-t1') };
    if (url.includes('/ws/2/release-group?')) return { ok: true, json: async () => mbReleaseGroupsBody() };
    throw new Error(`Budget guard should have prevented this fetch: ${url}`);
  };

  const { enrichArtistCatalog } = loadFreshEnrichCatalog();

  let catalog, threw = false;
  try {
    catalog = await enrichArtistCatalog('TestArtist', { maxReleases: 2 });
  } catch (e) {
    threw = true;
    console.error(`    THREW: ${e.message}`);
  } finally {
    Date.now    = origDateNow;
    global.fetch = origFetch;
    restoreSleep();
  }

  assert(!threw,                                    'enrichArtistCatalog does not throw when budget exceeded at i=0');
  assert(typeof catalog === 'object' && catalog !== null, 'returns a catalog object');
  assert(Array.isArray(catalog?.enrichedTracks),    'enrichedTracks is an array');
  assert(catalog.enrichedTracks.length === 0,
    `guard fires before any tracks are collected (got ${catalog?.enrichedTracks?.length})`);
}

// ── Test 2: Already-collected tracks returned when guard fires mid-loop ───────

async function test2_partial_batch_returned_when_guard_fires() {
  console.log('\n[2] Budget guard — already-collected tracks returned in partial batch');
  installFastSleep();
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  // startMs = FAKE_T (budget not yet exceeded).
  // Clock flips to OVER_T synchronously inside the release-A tracks fetch mock.
  // After the flip: inner-loop Genius check → withinBudget() = false → Genius skipped.
  // Release A's inner track loop still completes → tracks pushed to enrichedTracks.
  // i=1 outer guard check → withinBudget() = false → break.
  let isOverBudget = false;
  const origDateNow = Date.now;
  Date.now = () => isOverBudget ? OVER_T : FAKE_T;

  const origFetch = global.fetch;
  global.fetch = makeMockFetch({
    onReleaseATracks: () => { isOverBudget = true; },
    allowGenius: false, // Genius must not be called after budget flip
  });

  const { enrichArtistCatalog } = loadFreshEnrichCatalog();

  let catalog, threw = false;
  try {
    catalog = await enrichArtistCatalog('TestArtist', { maxReleases: 2 });
  } catch (e) {
    threw = true;
    console.error(`    THREW: ${e.message}`);
  } finally {
    Date.now     = origDateNow;
    global.fetch = origFetch;
    restoreSleep();
  }

  assert(!threw, 'enrichArtistCatalog does not throw on partial batch');
  assert(Array.isArray(catalog?.enrichedTracks), 'enrichedTracks is an array');
  assert(catalog.enrichedTracks.length === 2,
    `2 tracks from First Album in partial batch (got ${catalog?.enrichedTracks?.length})`);
  assert(
    catalog.enrichedTracks.every(t => t.releaseTitle === 'First Album'),
    'all returned tracks belong to First Album (not Second Album)'
  );
  assert(
    catalog.enrichedTracks[0]?.recordingMBID === 'rec-a1',
    `first track recordingMBID is rec-a1 (got "${catalog?.enrichedTracks?.[0]?.recordingMBID}")`
  );
  assert(
    catalog.enrichedTracks[1]?.recordingMBID === 'rec-a2',
    `second track recordingMBID is rec-a2 (got "${catalog?.enrichedTracks?.[1]?.recordingMBID}")`
  );
}

// ── Test 3: Partial batch has valid structure for downstream callers ──────────

async function test3_partial_batch_structurally_valid() {
  console.log('\n[3] Partial batch fields are valid for syncEnrichmentToGraph / persistEnrichedTracks');
  installFastSleep();
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  let isOverBudget = false;
  const origDateNow = Date.now;
  Date.now = () => isOverBudget ? OVER_T : FAKE_T;

  const origFetch = global.fetch;
  global.fetch = makeMockFetch({
    onReleaseATracks: () => { isOverBudget = true; },
    allowGenius: false,
  });

  const { enrichArtistCatalog } = loadFreshEnrichCatalog();

  let catalog;
  try {
    catalog = await enrichArtistCatalog('TestArtist', { maxReleases: 2 });
  } finally {
    Date.now     = origDateNow;
    global.fetch = origFetch;
    restoreSleep();
  }

  const tracks = catalog?.enrichedTracks ?? [];
  assert(tracks.length > 0, 'partial batch is non-empty');

  // Verify field shapes required by graph-sync and persist-enrichment
  for (const t of tracks) {
    assert(typeof t.trackTitle    === 'string',  `"${t.trackTitle}" has string trackTitle`);
    assert(typeof t.releaseTitle  === 'string',  `"${t.trackTitle}" has string releaseTitle`);
    assert(typeof t.recordingMBID === 'string',  `"${t.trackTitle}" has string recordingMBID`);
    assert(Array.isArray(t.isrcs),               `"${t.trackTitle}" has array isrcs`);
    assert(Array.isArray(t.writers),             `"${t.trackTitle}" has array writers`);
    assert(typeof t.enriched      === 'boolean', `"${t.trackTitle}" has boolean enriched`);
    // enrichmentError may be a string or null — just must not be undefined
    assert(t.enrichmentError !== undefined,      `"${t.trackTitle}" enrichmentError is present`);
  }

  // Top-level catalog shape (what enrich-artist.js receives and passes downstream)
  assert(typeof catalog.artistName      === 'string', 'catalog.artistName is a string');
  assert(typeof catalog.mbid            === 'string', 'catalog.mbid is a string');
  assert(typeof catalog.totalReleases   === 'number', 'catalog.totalReleases is a number');
  assert(typeof catalog.totalTracks     === 'number', 'catalog.totalTracks is a number');
  assert(typeof catalog.generatedAt     === 'string', 'catalog.generatedAt is an ISO string');
}

// ── Test 4: Normal run under budget — both releases fully processed ───────────

async function test4_normal_run_under_budget_unchanged() {
  console.log('\n[4] Normal run under budget — all releases processed, guard never fires');
  installFastSleep();
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Clock never advances → withinBudget() always true → no guard fires
  const origDateNow = Date.now;
  Date.now = () => FAKE_T;

  let relBFetched = false;
  const origFetch = global.fetch;
  const baseFetch = makeMockFetch({ allowGenius: true }); // Genius called when budget is ok
  global.fetch = async (url, ...args) => {
    if (url.includes('/ws/2/release/rel-b1')) relBFetched = true;
    return baseFetch(url, ...args);
  };

  const { enrichArtistCatalog } = loadFreshEnrichCatalog();

  let catalog, threw = false;
  try {
    catalog = await enrichArtistCatalog('TestArtist', { maxReleases: 2 });
  } catch (e) {
    threw = true;
    console.error(`    THREW: ${e.message}`);
  } finally {
    Date.now     = origDateNow;
    global.fetch = origFetch;
    restoreSleep();
  }

  assert(!threw, 'enrichArtistCatalog does not throw on normal run');
  assert(Array.isArray(catalog?.enrichedTracks), 'enrichedTracks is an array');
  assert(catalog.enrichedTracks.length === 3,
    `all 3 tracks collected (First Album×2 + Second Album×1), got ${catalog?.enrichedTracks?.length}`);
  assert(relBFetched, 'Second Album tracks were fetched (guard did not fire prematurely)');
  assert(
    catalog.enrichedTracks.some(t => t.releaseTitle === 'First Album'),
    'First Album tracks present'
  );
  assert(
    catalog.enrichedTracks.some(t => t.releaseTitle === 'Second Album'),
    'Second Album tracks present'
  );
}

// ── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== enrich-catalog-budget.test.js ===');
  console.log('Guards: outer-loop withinBudget() prevents Vercel 300s timeout\n');

  await test1_guard_fires_returns_cleanly();
  await test2_partial_batch_returned_when_guard_fires();
  await test3_partial_batch_structurally_valid();
  await test4_normal_run_under_budget_unchanged();

  console.log(`\n${'─'.repeat(50)}`);
  const total = passed + failed;
  if (failed > 0) {
    console.error(`${total} tests | ${passed} passed | ${failed} FAILED`);
  } else {
    console.log(`${total} tests | ${total} passed`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
