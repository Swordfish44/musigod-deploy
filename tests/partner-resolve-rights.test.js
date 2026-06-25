// tests/partner-resolve-rights.test.js
// Tests for api/partner/resolve-rights.js
//
// Covers: valid key, invalid key, rate limit exceeded, work not found,
//         work found with full enriched data (Esham test catalog).
//
// Run: node tests/partner-resolve-rights.test.js
// Requires: MUSIGOD_BASE_URL (defaults to http://localhost:3000)
//           PARTNER_TEST_KEY (a real key seeded in partners_v1)
//           SUPABASE_SERVICE_ROLE_KEY (for seeding the test partner row)

const BASE = process.env.MUSIGOD_BASE_URL || 'http://localhost:3000';
const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const crypto = require('crypto');

// ─── Test utilities ───────────────────────────────────────────────────────────
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

// ─── Test partner seeding ─────────────────────────────────────────────────────
const TEST_KEY = `mg-test-${Date.now()}`;
const TEST_KEY_HASH = crypto.createHash('sha256').update(TEST_KEY).digest('hex');
let seededPartnerId = null;

async function seedTestPartner() {
  const res = await fetch(`${SB_URL}/rest/v1/partners_v1`, {
    method: 'POST',
    headers: {
      'apikey':        SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',
    },
    body: JSON.stringify({
      partner_name:       'MusiGod Test Partner',
      api_key_hash:       TEST_KEY_HASH,
      rate_limit_per_min: 10,
      active:             true,
      notes:              'Seeded by test suite — safe to delete',
    }),
  });
  const rows = await res.json();
  seededPartnerId = rows[0]?.id;
  console.log(`  Seeded test partner: ${seededPartnerId} (key: ${TEST_KEY})`);
}

async function cleanupTestPartner() {
  if (!seededPartnerId) return;
  await fetch(`${SB_URL}/rest/v1/partners_v1?id=eq.${seededPartnerId}`, {
    method: 'DELETE',
    headers: {
      'apikey':        SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
    },
  });
  console.log(`  Cleaned up test partner ${seededPartnerId}`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function test_invalid_key() {
  console.log('\n[1] Invalid API key → 401');
  const { status, body } = await get('/api/partner/resolve-rights?isrc=USASN0802427', {
    'X-Partner-Key': 'not-a-real-key',
  });
  assert(status === 401, `status is 401 (got ${status})`);
  assert(typeof body.error === 'string', 'error field present');
}

async function test_missing_key() {
  console.log('\n[2] Missing API key → 401');
  const { status, body } = await get('/api/partner/resolve-rights?isrc=USASN0802427');
  assert(status === 401, `status is 401 (got ${status})`);
}

async function test_missing_identifier() {
  console.log('\n[3] Valid key, no identifier → 400');
  const { status, body } = await get('/api/partner/resolve-rights', {
    'X-Partner-Key': TEST_KEY,
  });
  assert(status === 400, `status is 400 (got ${status})`);
  assert(body.error.includes('isrc') || body.error.includes('Provide'), 'error mentions identifier param');
}

async function test_work_not_found() {
  console.log('\n[4] Valid key, ISRC not in catalog → 404');
  const { status, body } = await get('/api/partner/resolve-rights?isrc=USZZZ9999999', {
    'X-Partner-Key': TEST_KEY,
  });
  assert(status === 404, `status is 404 (got ${status})`);
  assert(body.error === 'work_not_found', `error is work_not_found (got ${body.error})`);
  assert(body.lookup?.type === 'isrc', 'lookup.type is isrc');
  assert(body.lookup?.value === 'USZZZ9999999', 'lookup.value echoed');
}

async function test_work_found_by_musigod_id() {
  console.log('\n[5] Valid key, MusiGod UUID (Esham — Rocks Off) → 200 with enriched data');
  // Known enriched row with writers confirmed in catalog_enriched_tracks_v1
  const ESHAM_ROCKS_OFF_ID = '4bcf28eb-35b6-49e7-a981-a435b9166e90'; // How Much is Ya Life Worth
  const { status, body } = await get(`/api/partner/resolve-rights?id=${ESHAM_ROCKS_OFF_ID}`, {
    'X-Partner-Key': TEST_KEY,
  });
  assert(status === 200, `status is 200 (got ${status})`);
  assert(body.musigod_version === '1.0', 'musigod_version field present');
  assert(body.work?.title?.toLowerCase().includes('how much') ||
         body.work?.title?.toLowerCase().includes('life worth') ||
         typeof body.work?.title === 'string', `work.title present (got "${body.work?.title}")`);
  assert(body.work?.artist === 'Esham', `work.artist is Esham (got "${body.work?.artist}")`);
  assert(Array.isArray(body.writers), 'writers is array');
  assert(body.writers.length > 0, `writers non-empty (got ${body.writers.length})`);
  assert(body.writers[0].name === 'Esham', `writer[0].name is Esham`);
  assert(Array.isArray(body.gaps), 'gaps is array');
  assert(Array.isArray(body.splits), 'splits is array');
  assert(Array.isArray(body.registrations), 'registrations is array');
  assert(body.consent?.ai_licensing === 'unknown', 'consent.ai_licensing is unknown (Lane A pending)');
  assert(body.lookup?.type === 'musigod_id', 'lookup.type is musigod_id');
}

async function test_rate_limit() {
  console.log('\n[6] Rate limit exceeded (fire 11 requests, limit=10) → eventually 429');
  const results = [];
  for (let i = 0; i < 12; i++) {
    const { status } = await get('/api/partner/resolve-rights?isrc=USZZZ0000000', {
      'X-Partner-Key': TEST_KEY,
    });
    results.push(status);
  }
  const hit429 = results.includes(429);
  assert(hit429, `at least one 429 in ${results.join(',')} after 12 requests`);
}

// ─── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('=== MusiGod Partner Resolve-Rights Tests ===');
  console.log(`Base URL: ${BASE}`);

  if (!SB_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set — cannot seed test partner');
    process.exit(1);
  }

  try {
    console.log('\n[setup] Seeding test partner in partners_v1...');
    await seedTestPartner();

    await test_invalid_key();
    await test_missing_key();
    await test_missing_identifier();
    await test_work_not_found();
    await test_work_found_by_musigod_id();
    await test_rate_limit();

  } finally {
    console.log('\n[teardown] Removing test partner...');
    await cleanupTestPartner();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
