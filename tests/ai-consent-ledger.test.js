// tests/ai-consent-ledger.test.js
// Tests for Lane A: ai_consent_v1 table + fn_get_consent_state_v1 + set-ai-consent API.
//
// Run: node tests/ai-consent-ledger.test.js
// Requires: MUSIGOD_BASE_URL, SUPABASE_SERVICE_ROLE_KEY, AUDIT_ADMIN_KEY

const BASE   = process.env.MUSIGOD_BASE_URL || 'http://localhost:3000';
const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const ADMIN  = process.env.AUDIT_ADMIN_KEY || 'mg-admin-2026';

let passed = 0; let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else           { console.error(`  ❌ FAIL: ${label}`); failed++; }
}

async function sbGet(table, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, {
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` },
  });
  return res.json();
}

async function callApi(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, body: data };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function test_table_exists() {
  console.log('\n[1] ai_consent_v1 table exists and is queryable');
  const rows = await sbGet('ai_consent_v1', { select: 'id', limit: '1' });
  assert(Array.isArray(rows), 'returns array (table accessible)');
}

async function test_traversal_fn_unset() {
  console.log('\n[2] fn_get_consent_state_v1 returns unset for work with no consent rows');
  // Use a known graph node — pick the first node in graph_nodes_v1
  const nodes = await sbGet('graph_nodes_v1', { select: 'id', limit: '1' });
  if (!nodes.length) { console.log('  ⚠️  No graph nodes — skipping'); return; }
  const workId = nodes[0].id;

  const res = await fetch(`${SB_URL}/rest/v1/rpc/fn_get_consent_state_v1`, {
    method: 'POST',
    headers: {
      'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_work_id: workId }),
  });
  const rows = await res.json();
  assert(Array.isArray(rows) && rows.length === 3, `returns 3 rows (got ${Array.isArray(rows) ? rows.length : JSON.stringify(rows)})`);
  assert(rows.every(r => r.effective_status === 'unset'), 'all three types default to unset');
  assert(rows.map(r => r.consent_type).sort().join(',') === 'ai_generation,ai_training,nil_use',
    'all three consent types present');
}

async function test_set_consent_granted() {
  console.log('\n[3] POST /api/set-ai-consent → grant ai_training');
  const nodes = await sbGet('graph_nodes_v1', { select: 'id', limit: '1' });
  if (!nodes.length) { console.log('  ⚠️  No graph nodes — skipping'); return; }
  const workId = nodes[0].id;

  const { status, body } = await callApi('/api/set-ai-consent', 'POST', {
    work_id:      workId,
    consent_type: 'ai_training',
    status:       'granted',
    provenance:   { flow: 'admin', notes: 'Lane A test suite' },
  });
  assert(status === 200, `status 200 (got ${status})`);
  assert(body?.ok === true, 'ok: true');
  assert(body?.consent?.status === 'granted', `consent.status is granted (got ${body?.consent?.status})`);
  assert(body?.consent?.consent_type === 'ai_training', 'consent_type is ai_training');
  assert(body?.consent?.granted_at !== null, 'granted_at set');

  // Verify traversal now returns granted for ai_training, unset for others
  const traversal = await fetch(`${SB_URL}/rest/v1/rpc/fn_get_consent_state_v1`, {
    method: 'POST',
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_work_id: workId }),
  });
  const rows = await traversal.json();
  const training = rows.find(r => r.consent_type === 'ai_training');
  const generation = rows.find(r => r.consent_type === 'ai_generation');
  assert(training?.effective_status === 'granted', 'ai_training now granted');
  assert(generation?.effective_status === 'unset', 'ai_generation still unset');

  // Cleanup
  await fetch(`${SB_URL}/rest/v1/ai_consent_v1?work_id=eq.${workId}&consent_type=eq.ai_training`, {
    method: 'DELETE',
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` },
  });
}

async function test_set_consent_denied() {
  console.log('\n[4] POST /api/set-ai-consent → deny nil_use');
  const nodes = await sbGet('graph_nodes_v1', { select: 'id', limit: '1' });
  if (!nodes.length) { console.log('  ⚠️  No graph nodes — skipping'); return; }
  const workId = nodes[0].id;

  const { status, body } = await callApi('/api/set-ai-consent', 'POST', {
    work_id:      workId,
    consent_type: 'nil_use',
    status:       'denied',
    provenance:   { flow: 'admin', notes: 'Lane A test suite denial' },
  });
  assert(status === 200, `status 200 (got ${status})`);
  assert(body?.consent?.status === 'denied', 'status is denied');

  // Cleanup
  await fetch(`${SB_URL}/rest/v1/ai_consent_v1?work_id=eq.${workId}&consent_type=eq.nil_use`, {
    method: 'DELETE',
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` },
  });
}

async function test_invalid_consent_type() {
  console.log('\n[5] POST /api/set-ai-consent → invalid consent_type → 400');
  const { status, body } = await callApi('/api/set-ai-consent', 'POST', {
    work_id:      '00000000-0000-0000-0000-000000000000',
    consent_type: 'ai_mind_control',
    status:       'granted',
  });
  assert(status === 400, `status 400 (got ${status})`);
  assert(body?.error?.includes('consent_type'), `error mentions consent_type (got "${body?.error}")`);
}

async function test_work_not_found() {
  console.log('\n[6] POST /api/set-ai-consent → nonexistent work_id → 404');
  const { status } = await callApi('/api/set-ai-consent', 'POST', {
    work_id:      '00000000-0000-0000-0000-000000000001',
    consent_type: 'ai_training',
    status:       'granted',
  });
  assert(status === 404, `status 404 (got ${status})`);
}

// ─── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('=== MusiGod AI Consent Ledger Tests (Lane A) ===');
  if (!SB_KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY not set'); process.exit(1); }

  await test_table_exists();
  await test_traversal_fn_unset();
  await test_set_consent_granted();
  await test_set_consent_denied();
  await test_invalid_consent_type();
  await test_work_not_found();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
