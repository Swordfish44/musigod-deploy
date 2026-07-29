// tests/soundexchange-adapter.test.js
// Mocked tests for lib/soundexchange-adapter.js — the feature-flagged,
// officially-authorized-only SoundExchange Repertoire Search API client.
//
// No network calls are made. global.fetch is stubbed for every case so this
// suite runs fully offline and never touches soundexchange.com.
//
// Run: node tests/soundexchange-adapter.test.js

// Fixed, low-friction config for deterministic tests — set BEFORE require()
// since timeout/retry/rate-limit constants are read once at module load.
process.env.SOUNDEXCHANGE_API_TIMEOUT_MS = '150';
process.env.SOUNDEXCHANGE_API_MAX_RETRIES = '2';
process.env.SOUNDEXCHANGE_API_RATE_LIMIT_PER_MIN = '3';

const adapter = require('../lib/soundexchange-adapter');

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

function enableAdapter({ key = 'sx-secret-test-key-12345' } = {}) {
  process.env.SOUNDEXCHANGE_API_ENABLED = 'true';
  process.env.SOUNDEXCHANGE_API_BASE_URL = 'https://api.example-soundexchange-sandbox.test';
  process.env.SOUNDEXCHANGE_API_SEARCH_PATH = '/v1/repertoire/search';
  process.env.SOUNDEXCHANGE_API_KEY = key;
  // Each test exercises the local sliding-window rate limiter in isolation —
  // reset it so one test's calls don't count against the next test's budget.
  adapter._internal.resetRateLimitForTests();
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function test_disabled_by_default() {
  console.log('\n[1] Disabled by default → not_configured, no network call');
  disableAdapter();
  let fetchCalled = false;
  stubFetch(async () => { fetchCalled = true; throw new Error('fetch should not be called'); });

  assert(adapter.isEnabled() === false, 'isEnabled() is false with no config');

  const result = await adapter.matchByISRC('USASN0802427');
  assert(result.enabled === false, 'result.enabled is false');
  assert(result.matched === false, 'result.matched is false');
  assert(result.reason === 'not_configured', `reason is not_configured (got ${result.reason})`);
  assert(fetchCalled === false, 'no fetch call was made');
  restoreFetch();
}

async function test_partially_configured_stays_disabled() {
  console.log('\n[2] Partial config (missing API key) → stays disabled, no network call');
  disableAdapter();
  process.env.SOUNDEXCHANGE_API_ENABLED = 'true';
  process.env.SOUNDEXCHANGE_API_BASE_URL = 'https://api.example.test';
  process.env.SOUNDEXCHANGE_API_SEARCH_PATH = '/v1/search';
  // no API key set

  let fetchCalled = false;
  stubFetch(async () => { fetchCalled = true; throw new Error('should not be called'); });

  assert(adapter.isEnabled() === false, 'isEnabled() false when apiKey missing');
  const result = await adapter.matchByISRC('USASN0802427');
  assert(result.reason === 'not_configured', 'still not_configured');
  assert(fetchCalled === false, 'no fetch call made');
  restoreFetch();
  disableAdapter();
}

async function test_exact_isrc_match() {
  console.log('\n[3] Enabled + exact ISRC match → matched:true, confidence:exact');
  enableAdapter();
  let capturedUrl = null;
  let capturedAuth = null;
  stubFetch(async (url, opts) => {
    capturedUrl = url;
    capturedAuth = opts.headers.Authorization;
    return jsonResponse(200, { results: [
      { isrc: 'us-asn-08-02427', title: 'Some Song', artist: 'Some Artist' },
      { isrc: 'USZZZ9999999', title: 'Other', artist: 'Other Artist' },
    ] });
  });

  const result = await adapter.matchByISRC('USASN0802427');
  assert(result.enabled === true, 'result.enabled is true');
  assert(result.matched === true, `matched true (got ${result.matched})`);
  assert(result.match?.title === 'Some Song', 'returns the matched candidate');
  assert(result.provenance?.confidence === 'exact', 'provenance confidence is exact');
  assert(result.provenance?.source === 'soundexchange_repertoire_api', 'provenance.source set');
  assert(capturedUrl.includes('/v1/repertoire/search'), 'request hit configured search path');
  assert(capturedAuth === 'Bearer sx-secret-test-key-12345', 'sent Bearer auth header');
  restoreFetch();
  disableAdapter();
}

async function test_no_match_is_deterministic_not_fuzzy() {
  console.log('\n[4] No exact match among candidates → matched:false (no fuzzy scoring)');
  enableAdapter();
  stubFetch(async () => jsonResponse(200, { results: [
    { isrc: 'USASN0802428', title: 'Some Song (Remix)', artist: 'Some Artist' }, // close but not exact
  ] }));

  const result = await adapter.matchByISRC('USASN0802427');
  assert(result.matched === false, 'near-miss ISRC does not count as a match');
  assert(result.provenance?.confidence === 'none', 'confidence is none');
  restoreFetch();
  disableAdapter();
}

async function test_recording_match_requires_both_fields() {
  console.log('\n[5] matchByRecording without title → invalid_query, no network call');
  enableAdapter();
  let fetchCalled = false;
  stubFetch(async () => { fetchCalled = true; return jsonResponse(200, { results: [] }); });

  const result = await adapter.matchByRecording({ artistName: 'Esham' });
  assert(result.reason === 'invalid_query', `reason invalid_query (got ${result.reason})`);
  assert(fetchCalled === false, 'no network call for invalid query');
  restoreFetch();
  disableAdapter();
}

async function test_recording_exact_match() {
  console.log('\n[6] matchByRecording exact artist+title match → matched:true');
  enableAdapter();
  stubFetch(async () => jsonResponse(200, [
    { artistName: 'Esham', recordingTitle: 'Judgement Day', isrc: 'USQY51500001' },
  ]));

  const result = await adapter.matchByRecording({ artistName: 'Esham', title: 'Judgement Day' });
  assert(result.matched === true, 'exact artist+title match found');
  assert(result.match?.isrc === 'USQY51500001', 'returns matched candidate');
  restoreFetch();
  disableAdapter();
}

async function test_retries_on_5xx_then_succeeds() {
  console.log('\n[7] Retries on 500, succeeds on final attempt');
  enableAdapter();
  let calls = 0;
  stubFetch(async () => {
    calls++;
    if (calls < 3) return jsonResponse(503, { error: 'temporarily unavailable' });
    return jsonResponse(200, { results: [{ isrc: 'USASN0802427', title: 'x', artist: 'y' }] });
  });

  const result = await adapter.matchByISRC('USASN0802427');
  assert(calls === 3, `made 3 attempts before success (got ${calls})`);
  assert(result.matched === true, 'eventually matched after retries');
  restoreFetch();
  disableAdapter();
}

async function test_does_not_retry_on_4xx() {
  console.log('\n[8] Does not retry on non-429 4xx (e.g. 401 bad auth)');
  enableAdapter();
  let calls = 0;
  stubFetch(async () => { calls++; return jsonResponse(401, { error: 'invalid api key' }); });

  const result = await adapter.matchByISRC('USASN0802427');
  assert(calls === 1, `only 1 attempt for 401 (got ${calls})`);
  assert(result.matched === false, 'no match on auth failure');
  assert(result.reason === 'error', 'reason is error');
  restoreFetch();
  disableAdapter();
}

async function test_gives_up_after_max_retries_on_persistent_5xx() {
  console.log('\n[9] Gives up after MAX_RETRIES on persistent 500s');
  enableAdapter();
  let calls = 0;
  stubFetch(async () => { calls++; return jsonResponse(500, { error: 'down' }); });

  const result = await adapter.matchByISRC('USASN0802427');
  assert(calls === 3, `attempted 1 + MAX_RETRIES(2) = 3 times (got ${calls})`);
  assert(result.matched === false, 'no match after exhausting retries');
  assert(result.reason === 'error', 'reason is error');
  restoreFetch();
  disableAdapter();
}

async function test_timeout_aborts_request() {
  console.log('\n[10] Request exceeding SOUNDEXCHANGE_API_TIMEOUT_MS aborts');
  enableAdapter();
  process.env.SOUNDEXCHANGE_API_MAX_RETRIES = '0'; // avoid slow retry loop in test
  stubFetch(async (url, opts) => {
    return new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
      // never resolves on its own — only the abort signal ends this
    });
  });

  const start = Date.now();
  const result = await adapter.matchByISRC('USASN0802427');
  const elapsed = Date.now() - start;
  assert(result.matched === false, 'timed-out request has no match');
  assert(result.reason === 'error', 'reason is error');
  assert(/timeout/i.test(result.error || ''), `error mentions timeout (got "${result.error}")`);
  assert(elapsed < 2000, `resolved quickly via timeout, not hung (${elapsed}ms)`);
  restoreFetch();
  disableAdapter();
  process.env.SOUNDEXCHANGE_API_MAX_RETRIES = '2';
}

async function test_rate_limit_blocks_without_network_call() {
  console.log('\n[11] Local rate limit (3/min in this test) blocks the 4th call, no network hit');
  enableAdapter();
  let calls = 0;
  stubFetch(async () => { calls++; return jsonResponse(200, { results: [] }); });

  await adapter.matchByISRC('USAAA0000001');
  await adapter.matchByISRC('USAAA0000002');
  await adapter.matchByISRC('USAAA0000003');
  const fourth = await adapter.matchByISRC('USAAA0000004');

  assert(calls === 3, `only 3 network calls made (got ${calls})`);
  assert(fourth.reason === 'rate_limited', `4th call rate-limited (got ${fourth.reason})`);
  restoreFetch();
  disableAdapter();
}

async function test_credentials_never_appear_in_output() {
  console.log('\n[12] API key is redacted from error messages and provenance');
  const secret = 'sx-very-secret-token-do-not-leak';
  enableAdapter({ key: secret });
  stubFetch(async () => jsonResponse(403, { error: `denied for token ${secret}` }));

  const result = await adapter.matchByISRC('USASN0802427');
  const serialized = JSON.stringify(result);
  assert(!serialized.includes(secret), 'secret does not appear anywhere in the returned result');
  assert(serialized.includes('[REDACTED]'), 'redaction placeholder present instead');
  restoreFetch();
  disableAdapter();
}

async function test_describe_config_never_leaks_key() {
  console.log('\n[13] describeConfig() reports booleans only, never the raw key');
  enableAdapter({ key: 'super-secret-value' });
  const desc = adapter.describeConfig();
  assert(desc.configured === true, 'configured true when fully set');
  assert(desc.apiKeySet === true, 'apiKeySet boolean true');
  assert(!JSON.stringify(desc).includes('super-secret-value'), 'raw key absent from describeConfig()');
  disableAdapter();
}

// ─── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('=== SoundExchange Adapter Tests (mocked, offline) ===');

  await test_disabled_by_default();
  await test_partially_configured_stays_disabled();
  await test_exact_isrc_match();
  await test_no_match_is_deterministic_not_fuzzy();
  await test_recording_match_requires_both_fields();
  await test_recording_exact_match();
  await test_retries_on_5xx_then_succeeds();
  await test_does_not_retry_on_4xx();
  await test_gives_up_after_max_retries_on_persistent_5xx();
  await test_timeout_aborts_request();
  await test_rate_limit_blocks_without_network_call();
  await test_credentials_never_appear_in_output();
  await test_describe_config_never_leaks_key();

  restoreFetch();
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
