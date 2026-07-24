'use strict';
// Diagnose PGRST202 for registration readiness RPCs.
//
// What this script does:
//   1. Shows SQL to run in Supabase SQL Editor to read actual pg_proc signatures
//   2. Shows the parameter names the API code expects to send
//   3. Probes PostgREST directly and reports whether the functions are in the schema cache
//
// Usage:
//   SUPABASE_SERVICE_KEY=<key> node scripts/diagnose-rpc-signatures.js
//
// If you see PGRST202 in the probe results, the functions exist in pg_proc but
// PostgREST's schema cache was not updated. Apply supabase/migrations/20260725_reload_schema.sql
// via a session-mode connection (NOT the default transaction pooler) and re-run this script.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// ─── Expected signatures (source of truth = migration SQL) ───────────────────
// If the actual pg_proc query (Section 1 below) returns different names,
// that is the mismatch to fix.

const EXPECTED = {
  rpc_upsert_readiness_decision: [
    'p_catalog_track_id',
    'p_destination',
    'p_decision',
    'p_ruleset_version',
    'p_blockers',
    'p_warnings',
    'p_evidence_summary',
  ],
  rpc_get_readiness_summary: [
    'p_artist_name',
    'p_track_ids',
  ],
};

// ─── Parameters the API code actually sends ───────────────────────────────────
// Source: api/evaluate-readiness.js sbRpc('rpc_upsert_readiness_decision', {...})
//         api/get-readiness.js      sbRpc('rpc_get_readiness_summary', {...})

const API_SENDS = {
  rpc_upsert_readiness_decision: [
    'p_catalog_track_id',
    'p_destination',
    'p_decision',
    'p_ruleset_version',
    'p_blockers',
    'p_warnings',
    'p_evidence_summary',
  ],
  rpc_get_readiness_summary: [
    'p_artist_name',
    'p_track_ids',
  ],
};

function sep(label = '') {
  console.log('');
  console.log(`──── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);
}

function compareParams(fnName) {
  const expected = EXPECTED[fnName];
  const sent     = API_SENDS[fnName];
  const missing  = expected.filter(p => !sent.includes(p));
  const extra    = sent.filter(p => !expected.includes(p));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`  ✅ ${fnName}: API params match migration SQL`);
  } else {
    console.log(`  ❌ ${fnName}: MISMATCH`);
    if (missing.length) console.log(`     In SQL but NOT sent by API : ${missing.join(', ')}`);
    if (extra.length)   console.log(`     Sent by API but NOT in SQL : ${extra.join(', ')}`);
  }
}

async function probeRpc(fnName, body) {
  if (!SB_KEY) {
    console.log(`  ⚠️  No SUPABASE_SERVICE_KEY — skipping live probe for ${fnName}`);
    return;
  }
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      'apikey':        SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  const isPGRST202 = txt.includes('PGRST202') || txt.includes('schema cache');
  const isFK       = txt.includes('23503') || txt.includes('foreign key');

  if (isPGRST202) {
    console.log(`  ❌ ${fnName}: PGRST202 — not in PostgREST schema cache`);
    console.log(`     HTTP ${r.status} body: ${txt.slice(0, 200)}`);
    console.log(`     → The function exists in pg_proc but PostgREST has not loaded it.`);
    console.log(`     → Fix: apply supabase/migrations/20260725_reload_schema.sql via session mode.`);
  } else if (isFK) {
    console.log(`  ✅ ${fnName}: in schema cache, callable, FK enforced (probe UUID rejected)`);
  } else if (r.ok) {
    console.log(`  ✅ ${fnName}: callable — HTTP 200`);
  } else {
    console.log(`  ⚠️  ${fnName}: HTTP ${r.status} — ${txt.slice(0, 160)}`);
  }
}

async function main() {
  console.log('');
  console.log('══════════════ RPC Signature Diagnosis ══════════════');
  console.log(`Target: ${SB_URL}`);

  // ── Section 1: Static comparison ──────────────────────────────────────────
  sep('1. Static parameter alignment (migration SQL vs API code)');
  compareParams('rpc_upsert_readiness_decision');
  compareParams('rpc_get_readiness_summary');

  // ── Section 2: SQL to verify pg_proc in the actual database ───────────────
  sep('2. SQL to run in Supabase SQL Editor → verify pg_proc signatures');
  console.log(`
  Run this in the SQL Editor (any connection mode) to confirm the functions
  exist in pg_proc with the correct parameter names:

  SELECT
    p.proname                                           AS function_name,
    pg_catalog.pg_get_function_arguments(p.oid)         AS arguments,
    CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'INVOKER' END AS security
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'rpc_upsert_readiness_decision',
      'rpc_get_readiness_summary'
    );

  Expected results:
    rpc_upsert_readiness_decision | p_catalog_track_id uuid, p_destination text, ... | SECURITY DEFINER
    rpc_get_readiness_summary     | p_artist_name text DEFAULT NULL, p_track_ids uuid[] DEFAULT NULL | SECURITY DEFINER

  If either row is missing → the migration did not fully apply. Re-run the migration.
  If rows are present with different parameter names → update the API code to match.
  If rows are present with correct names → schema cache is stale. Apply the reload migration.
`);

  // ── Section 3: SQL to reload PostgREST schema ─────────────────────────────
  sep('3. Schema reload instructions');
  console.log(`
  The NOTIFY in the original migration was sent via Supabase's Supavisor transaction
  pooler, which does NOT forward session-level NOTIFY to PostgREST's LISTEN connection.

  Option A (preferred): Apply supabase/migrations/20260725_reload_schema.sql
    → File contains only: SELECT pg_notify('pgrst', 'reload schema');
    → Run it via SQL Editor in SESSION mode (not transaction mode):
         Supabase SQL Editor → Connection type → Session mode (or Direct Connection)
         Paste content → Run

  Option B: Supabase Dashboard
    → API Settings → Reload (if your project version has this button)

  After reload, re-run this script. PGRST202 probes should flip to ✅.
`);

  // ── Section 4: Live PostgREST probe ───────────────────────────────────────
  sep('4. Live PostgREST probe (requires SUPABASE_SERVICE_KEY)');
  if (!SB_KEY) {
    console.log('  Set SUPABASE_SERVICE_KEY to enable live probes.');
  } else {
    await probeRpc('rpc_upsert_readiness_decision', {
      p_catalog_track_id: '00000000-0000-0000-0000-000000000000',
      p_destination:      'ASCAP',
      p_decision:         'BLOCKED',
      p_ruleset_version:  'diag-probe',
      p_blockers:         [],
      p_warnings:         [],
      p_evidence_summary: {},
    });
    await probeRpc('rpc_get_readiness_summary', {
      p_artist_name: '__diag_probe__',
      p_track_ids:   null,
    });
  }

  sep('Done');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
