// tests/rights-title-report.test.js
// Tests for api/get-rights-title-report.js
//
// Covers: missing auth, missing identifier, work not found, work found
//         (Esham test catalog) with the identity-bridge and consent fields
//         asserted explicitly, since those are the two things this endpoint
//         adds over api/partner/resolve-rights.js.
//
// Mirrors the structure of tests/partner-resolve-rights.test.js.
// Not run in the sandbox this file was authored in — no live server or
// Supabase credentials were available there. Run for real with:
//
//   MUSIGOD_BASE_URL=... ADMIN_API_KEY=... node tests/rights-title-report.test.js
//
// Run: node tests/rights-title-report.test.js
// Requires: MUSIGOD_BASE_URL (defaults to http://localhost:3000)
//           ADMIN_API_KEY (matching the deployed environment's admin key)

const BASE = process.env.MUSIGOD_BASE_URL || 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_API_KEY;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

async function get(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers });
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function test_missing_auth() {
  console.log('\n[1] No X-Admin-Key → 401');
  const { status } = await get('/api/get-rights-title-report?isrc=USASN0802427');
  assert(status === 401, `status is 401 (got ${status})`);
}

async function test_missing_identifier() {
  console.log('\n[2] Valid admin key, no identifier → 400');
  const { status, body } = await get('/api/get-rights-title-report', {
    'X-Admin-Key': ADMIN_KEY,
  });
  assert(status === 400, `status is 400 (got ${status})`);
  assert(body.error.includes('isrc') || body.error.includes('Provide'), 'error mentions identifier param');
}

async function test_work_not_found() {
  console.log('\n[3] Valid admin key, ISRC not in catalog → 404');
  const { status, body } = await get('/api/get-rights-title-report?isrc=USZZZ9999999', {
    'X-Admin-Key': ADMIN_KEY,
  });
  assert(status === 404, `status is 404 (got ${status})`);
  assert(body.error === 'work_not_found', `error is work_not_found (got ${body.error})`);
}

async function test_work_found_by_musigod_id() {
  console.log('\n[4] Valid admin key, MusiGod UUID (Esham catalog) → 200 with composed report');
  // Same known enriched row used in tests/partner-resolve-rights.test.js
  const ESHAM_TRACK_ID = '4bcf28eb-35b6-49e7-a981-a435b9166e90';
  const { status, body } = await get(`/api/get-rights-title-report?id=${ESHAM_TRACK_ID}`, {
    'X-Admin-Key': ADMIN_KEY,
  });
  assert(status === 200, `status is 200 (got ${status})`);
  assert(body.musigod_version === '1.0-title-report-draft', 'musigod_version field present');
  assert(body.work?.artist === 'Esham', `work.artist is Esham (got "${body.work?.artist}")`);
  assert(Array.isArray(body.gaps), 'gaps is array');
  assert(Array.isArray(body.ownership?.assertions), 'ownership.assertions is array');
  assert(typeof body.ownership?.resolution_state === 'string', 'ownership.resolution_state present');
  assert(typeof body.identity_bridge === 'object', 'identity_bridge object present');
  assert(['direct', 'heuristic_isrc_match', 'heuristic_iswc_match', 'none'].includes(body.identity_bridge?.method),
    `identity_bridge.method is a known value (got "${body.identity_bridge?.method}")`);
  assert(typeof body.consent === 'object' && 'ai_training' in body.consent, 'consent.ai_training present');
  assert(typeof body.consent?.note === 'string', 'consent.note explains which id space was used');
  assert(Array.isArray(body.open_investigations), 'open_investigations is array');
  assert(typeof body.human_confirmed === 'boolean', 'human_confirmed is boolean');
}

(async () => {
  console.log('=== MusiGod Rights Title Report Tests ===');
  console.log(`Base URL: ${BASE}`);

  if (!ADMIN_KEY) {
    console.error('ADMIN_API_KEY not set — cannot authenticate as admin');
    process.exit(1);
  }

  await test_missing_auth();
  await test_missing_identifier();
  await test_work_not_found();
  await test_work_found_by_musigod_id();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
