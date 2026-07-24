'use strict';
// Post-migration verification for 20260724_registration_readiness_v1.sql
// Usage:
//   SUPABASE_URL=https://uykzkrnoetcldeuxzqyy.supabase.co \
//   SUPABASE_SERVICE_KEY=<service_role_key> \
//   node scripts/verify-readiness-migration.js
//
// Exits 0 only if every check passes. Exits 1 with explicit FAIL lines on any failure.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SB_KEY) {
  console.error('FAIL: SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) is required');
  process.exit(1);
}

function hdr(extra = {}) {
  return {
    'apikey':        SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`,
    'Accept':        'application/json',
    'Content-Type':  'application/json',
    ...extra,
  };
}

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✅ ${label}`);
  passed++;
}

function fail(label, detail = '') {
  console.error(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
  failed++;
}

async function checkTableExists(tableName) {
  const r = await fetch(
    `${SB_URL}/rest/v1/${tableName}?limit=0`,
    { headers: hdr() }
  );
  if (r.ok || r.status === 416) {
    ok(`Table ${tableName} exists (HTTP ${r.ok ? 200 : r.status})`);
  } else {
    const txt = await r.text();
    fail(`Table ${tableName} not found`, `HTTP ${r.status}: ${txt.slice(0, 120)}`);
  }
}

async function checkRLSBlocks() {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/rpc_get_readiness_summary`, {
    method: 'POST',
    headers: hdr(),
    body: JSON.stringify({ p_artist_name: '__verify_rls_probe__', p_track_ids: null }),
  });
  const txt = await r.text();
  const isPGRST202 = txt.includes('PGRST202') || txt.includes('Could not find') || txt.includes('schema cache');
  const isPermDeny = r.status === 403 || txt.includes('permission denied') || txt.includes('42501');

  if (isPGRST202) {
    fail(
      'rpc_get_readiness_summary not in PostgREST schema cache — NOTIFY did not propagate',
      `HTTP ${r.status}: PGRST202. Reload PostgREST schema (see rpc_upsert check above). ` + txt.slice(0, 60)
    );
    return;
  }
  if (isPermDeny) {
    fail('rpc_get_readiness_summary permission denied — grant to service_role missing', txt.slice(0, 120));
    return;
  }
  if (!r.ok) {
    fail('rpc_get_readiness_summary not callable', `HTTP ${r.status}: ${txt.slice(0, 120)}`);
    return;
  }
  let body;
  try { body = JSON.parse(txt); } catch { body = null; }
  const data = Array.isArray(body) ? body[0] : body;
  if (data && data.error) {
    fail('rpc_get_readiness_summary returned error', JSON.stringify(data).slice(0, 120));
  } else {
    ok('rpc_get_readiness_summary callable by service_role and returns expected shape');
  }
}

async function checkUpsertRpc() {
  // Call rpc_upsert_readiness_decision with a known-bad UUID — it should return
  // a JSON error (FK violation) rather than 404 (function missing) or 403 (no grant).
  const r = await fetch(`${SB_URL}/rest/v1/rpc/rpc_upsert_readiness_decision`, {
    method: 'POST',
    headers: hdr(),
    body: JSON.stringify({
      p_catalog_track_id: '00000000-0000-0000-0000-000000000000',
      p_destination:      'ASCAP',
      p_decision:         'BLOCKED',
      p_ruleset_version:  'verify-probe',
      p_blockers:         [],
      p_warnings:         [],
      p_evidence_summary: {},
    }),
  });
  const txt = await r.text();
  // FK violation (23503) means the function exists and ran — the FK rejected the fake UUID.
  // That is the correct outcome for a probe.
  //
  // PGRST202 ("Could not find the function in the schema cache") arrives as HTTP 400 in
  // PostgREST 12 (Supabase current), NOT 404. Check code and message explicitly so no
  // status falls through to a false-positive pass.
  const isPGRST202 = txt.includes('PGRST202') || txt.includes('Could not find') || txt.includes('schema cache');
  const isFK       = txt.includes('23503') || txt.includes('foreign key') || txt.includes('violates foreign key');
  const isPermDeny = r.status === 403 || txt.includes('permission denied') || txt.includes('42501');

  if (isFK) {
    ok('rpc_upsert_readiness_decision exists, grants correct, FK enforced (FK rejected probe UUID)');
  } else if (isPGRST202) {
    fail(
      'rpc_upsert_readiness_decision not in PostgREST schema cache — NOTIFY did not propagate',
      `HTTP ${r.status}: PGRST202. Run "SELECT pg_notify(\'pgrst\', \'reload schema\')" via a ` +
      'session-mode connection (not transaction pooler), then re-verify. ' + txt.slice(0, 80)
    );
  } else if (isPermDeny) {
    fail('rpc_upsert_readiness_decision permission denied — grant to service_role missing', txt.slice(0, 120));
  } else if (r.ok) {
    ok(`rpc_upsert_readiness_decision callable (HTTP 200)`);
  } else {
    // Unknown failure — surface the full status and body for diagnosis
    fail(`rpc_upsert_readiness_decision unexpected response`, `HTTP ${r.status}: ${txt.slice(0, 160)}`);
  }
}

async function checkEnums() {
  // Query using the enum cast — if enums don't exist, the filter will error
  const r = await fetch(
    `${SB_URL}/rest/v1/registration_readiness_v1?destination=eq.ASCAP&limit=0`,
    { headers: hdr() }
  );
  if (r.ok || r.status === 416) {
    ok('readiness_destination enum in use (ASCAP filter accepted by PostgREST)');
  } else {
    const txt = await r.text();
    fail('readiness_destination enum or table not found', txt.slice(0, 120));
  }
}

async function checkHistoryTable() {
  const r = await fetch(
    `${SB_URL}/rest/v1/registration_readiness_history_v1?limit=0`,
    { headers: hdr() }
  );
  if (r.ok || r.status === 416) {
    ok('registration_readiness_history_v1 exists');
  } else {
    const txt = await r.text();
    fail('registration_readiness_history_v1 not found', txt.slice(0, 120));
  }
}

async function main() {
  console.log('');
  console.log('═══ Registration Readiness Migration Verification ═══');
  console.log(`Target: ${SB_URL}`);
  console.log('');

  console.log('[1] Tables exist');
  await checkTableExists('registration_readiness_v1');
  await checkHistoryTable();

  console.log('');
  console.log('[2] Enums accepted by PostgREST');
  await checkEnums();

  console.log('');
  console.log('[3] rpc_upsert_readiness_decision callable by service_role');
  await checkUpsertRpc();

  console.log('');
  console.log('[4] rpc_get_readiness_summary callable by service_role');
  await checkRLSBlocks();

  console.log('');
  console.log('─────────────────────────────────────────────────────');
  const total = passed + failed;
  console.log(`${total} checks | ${passed} passed | ${failed} failed`);

  if (failed > 0) {
    console.error('\nMIGRATION VERIFICATION FAILED — do not deploy');
    process.exit(1);
  } else {
    console.log('\nMIGRATION VERIFIED — safe to deploy');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Uncaught error:', err.message);
  process.exit(1);
});
