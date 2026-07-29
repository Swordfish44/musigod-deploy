// tests/soundexchange-legacy.test.js
// Tests for lib/soundexchange.js — the gap-scanner wrapper consumed by
// lib/scanner.js / api/scan-artist.js.
//
// Verifies the unauthorized wp-admin/admin-ajax.php scraping is gone: by
// default (no SoundExchange API configured) this module must make zero
// network calls and only return a manual-check pointer. When the
// feature-flagged adapter *is* configured, it delegates to it.
//
// Run: node tests/soundexchange-legacy.test.js

process.env.SOUNDEXCHANGE_API_TIMEOUT_MS = '150';
process.env.SOUNDEXCHANGE_API_MAX_RETRIES = '1';
process.env.SOUNDEXCHANGE_API_RATE_LIMIT_PER_MIN = '30';

const { scanSoundExchange } = require('../lib/soundexchange');

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ FAIL: ${label}`); failed++; }
}

const REAL_FETCH = global.fetch;
function stubFetch(fn) { global.fetch = fn; }
function restoreFetch() { global.fetch = REAL_FETCH; }

function disableAdapter() {
  delete process.env.SOUNDEXCHANGE_API_ENABLED;
  delete process.env.SOUNDEXCHANGE_API_BASE_URL;
  delete process.env.SOUNDEXCHANGE_API_SEARCH_PATH;
  delete process.env.SOUNDEXCHANGE_API_KEY;
}

function enableAdapter() {
  process.env.SOUNDEXCHANGE_API_ENABLED = 'true';
  process.env.SOUNDEXCHANGE_API_BASE_URL = 'https://api.example-soundexchange-sandbox.test';
  process.env.SOUNDEXCHANGE_API_SEARCH_PATH = '/v1/repertoire/search';
  process.env.SOUNDEXCHANGE_API_KEY = 'sx-test-key';
}

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) };
}

async function test_default_makes_no_network_call() {
  console.log('\n[1] Default (no API configured) → no network call, manual-check result');
  disableAdapter();
  let fetchCalled = false;
  stubFetch(async () => { fetchCalled = true; throw new Error('must not be called — no scraping'); });

  const result = await scanSoundExchange('Esham');
  assert(fetchCalled === false, 'zero network calls made by default');
  assert(result.found === null, `found is null/unknown (got ${result.found})`);
  assert(typeof result.manualUrl === 'string' && result.manualUrl.includes('soundexchange.com'), 'manualUrl points to public SoundExchange search page');
  assert(Array.isArray(result.gaps) && result.gaps.length === 1, 'exactly one gap: manual check needed');
  assert(result.gaps[0].type === 'soundexchange_manual_check_needed', 'gap type is manual_check_needed');
  restoreFetch();
}

async function test_never_hits_wp_admin_ajax() {
  console.log('\n[2] Never constructs a wp-admin/admin-ajax.php URL (legacy scraper fully removed)');
  disableAdapter();
  let calledUrls = [];
  stubFetch(async (url) => { calledUrls.push(String(url)); return jsonResponse(200, {}); });

  await scanSoundExchange('Esham');
  assert(calledUrls.every(u => !u.includes('wp-admin')), 'no wp-admin URL ever requested');
  assert(calledUrls.length === 0, 'no fetch performed at all in default mode');
  restoreFetch();
}

async function test_adapter_enabled_confirmed_match() {
  console.log('\n[3] Adapter enabled + exact match → found:true, low-severity gap');
  enableAdapter();
  stubFetch(async () => jsonResponse(200, { results: [
    { artistName: 'Esham', recordingTitle: 'Esham', isrc: 'USQY51500001' },
  ] }));

  const result = await scanSoundExchange('Esham');
  assert(result.found === true, `found true (got ${result.found})`);
  assert(result.gaps[0].type === 'soundexchange_confirmed_registered', 'gap reflects confirmed registration');
  assert(result.gaps[0].severity === 'low', 'confirmed registration is low severity');
  assert(result.provenance?.source === 'soundexchange_repertoire_api', 'provenance included from adapter');
  restoreFetch();
  disableAdapter();
}

async function test_adapter_enabled_no_match() {
  console.log('\n[4] Adapter enabled + no match → found:false, high-severity gap');
  enableAdapter();
  stubFetch(async () => jsonResponse(200, { results: [] }));

  const result = await scanSoundExchange('Some Unregistered Artist');
  assert(result.found === false, `found false (got ${result.found})`);
  assert(result.gaps[0].type === 'soundexchange_unregistered_or_unconfirmed', 'gap reflects unconfirmed/unregistered');
  assert(result.gaps[0].severity === 'high', 'unregistered is high severity');
  restoreFetch();
  disableAdapter();
}

// ─── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('=== SoundExchange Legacy Wrapper Tests (mocked, offline) ===');

  await test_default_makes_no_network_call();
  await test_never_hits_wp_admin_ajax();
  await test_adapter_enabled_confirmed_match();
  await test_adapter_enabled_no_match();

  restoreFetch();
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
