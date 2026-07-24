'use strict';
// POST /api/evaluate-readiness for Esham, then GET /api/get-readiness?summary=true
// Usage:
//   AUDIT_ADMIN_KEY=<key> node scripts/run-evaluate-esham.js
//
// Reports full decision + blocker breakdown per destination.
// Makes no external society submissions.

const PROD_BASE = process.env.PROD_BASE || 'https://musigod.com';
const ADMIN_KEY = process.env.AUDIT_ADMIN_KEY || process.env.ADMIN_API_KEY;

if (!ADMIN_KEY) {
  console.error('FAIL: AUDIT_ADMIN_KEY (or ADMIN_API_KEY) env var required');
  process.exit(1);
}

const ARTIST_NAME = 'Esham';

async function adminPost(path, body) {
  const r = await fetch(`${PROD_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key':  ADMIN_KEY,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, ok: r.ok, json };
}

async function adminGet(path) {
  const r = await fetch(`${PROD_BASE}${path}`, {
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, ok: r.ok, json };
}

function banner(title) {
  console.log('');
  console.log(`══ ${title} ══`);
}

async function main() {
  banner('Step 1 — POST /api/evaluate-readiness (Esham, all 5 destinations)');
  console.log(`  Target: ${PROD_BASE}`);
  console.log(`  Artist: ${ARTIST_NAME}`);
  console.log('  Running evaluation... (may take 10-30 s for large catalogs)');

  const evalRes = await adminPost('/api/evaluate-readiness', {
    artist_name:  ARTIST_NAME,
    destinations: ['ASCAP', 'BMI', 'MLC', 'SOUNDEXCHANGE', 'NEIGHBORING_RIGHTS'],
  });

  if (!evalRes.ok) {
    console.error(`  FAIL: HTTP ${evalRes.status}`);
    console.error('  ', JSON.stringify(evalRes.json, null, 2));
    if (
      JSON.stringify(evalRes.json).includes('PGRST202') ||
      JSON.stringify(evalRes.json).includes('schema cache')
    ) {
      console.error('');
      console.error('  DIAGNOSIS: PostgREST schema cache is stale.');
      console.error('  RPCs exist in pg_proc but were not in the cache when the migration ran.');
      console.error('  Fix: run the SQL in scripts/diagnose-rpc-signatures.js,');
      console.error('  then reload the schema via supabase/migrations/20260725_reload_schema.sql.');
    }
    console.error('');
    console.error('  Steps 2–4 skipped. Fix Step 1 before re-running.');
    process.exit(1);
  }

  const ev = evalRes.json;
  console.log(`  ✅ HTTP ${evalRes.status}`);
  console.log(`  tracks_evaluated : ${ev.tracks_evaluated}`);
  console.log(`  decisions written: ${ev.evaluated}`);
  console.log(`  errors           : ${ev.errors}`);

  if (ev.evaluation_errors && ev.evaluation_errors.length > 0) {
    console.log('  ⚠️  Evaluation errors:');
    for (const e of ev.evaluation_errors) {
      console.log(`    track_id=${e.track_id} dest=${e.destination}: ${e.error}`);
    }
  }

  // Per-destination decision breakdown from the raw evaluate response
  const dests = ['ASCAP', 'BMI', 'MLC', 'SOUNDEXCHANGE', 'NEIGHBORING_RIGHTS'];
  const decisionsByDest = {};
  for (const d of dests) decisionsByDest[d] = { READY: 0, BLOCKED: 0, NEEDS_REVIEW: 0, NOT_APPLICABLE: 0 };
  const blockerFreq = {};

  if (Array.isArray(ev.decisions)) {
    for (const d of ev.decisions) {
      if (decisionsByDest[d.destination]) {
        decisionsByDest[d.destination][d.decision] = (decisionsByDest[d.destination][d.decision] || 0) + 1;
      }
    }
  }

  banner('Step 2 — GET /api/get-readiness?summary=true (aggregate counts)');
  const sumRes = await adminGet(
    `/api/get-readiness?artist_name=${encodeURIComponent(ARTIST_NAME)}&summary=true`
  );

  if (!sumRes.ok) {
    console.error(`  FAIL: HTTP ${sumRes.status}`);
    console.error('  ', JSON.stringify(sumRes.json, null, 2));
  } else {
    const s = sumRes.json;
    console.log(`  ✅ HTTP ${sumRes.status}`);
    console.log(`  total_tracks  : ${s.total_tracks}`);
    console.log(`  not_evaluated : ${s.not_evaluated}`);
    if (s.by_destination) {
      console.log('  by_destination:');
      for (const [dest, counts] of Object.entries(s.by_destination)) {
        const parts = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ');
        console.log(`    ${dest.padEnd(20)} ${parts}`);
      }
    }
  }

  banner('Step 3 — GET /api/get-readiness (full BLOCKED list with blockers)');
  const blockedRes = await adminGet(
    `/api/get-readiness?artist_name=${encodeURIComponent(ARTIST_NAME)}&decision=BLOCKED&include_blockers=true&destination=ASCAP`
  );

  if (!blockedRes.ok) {
    console.error(`  FAIL: HTTP ${blockedRes.status}`);
  } else {
    const b = blockedRes.json;
    const rows = b.decisions || [];
    console.log(`  ASCAP BLOCKED rows: ${rows.length}`);
    const codeFreq = {};
    for (const row of rows) {
      for (const bl of (row.blockers || [])) {
        codeFreq[bl.code] = (codeFreq[bl.code] || 0) + 1;
      }
    }
    if (Object.keys(codeFreq).length) {
      console.log('  Blocker code frequency (ASCAP):');
      const sorted = Object.entries(codeFreq).sort((a, b) => b[1] - a[1]);
      for (const [code, count] of sorted) {
        console.log(`    ${code.padEnd(40)} ${count} tracks`);
      }
    }
  }

  // Also pull NEEDS_REVIEW for ASCAP
  banner('Step 4 — NEEDS_REVIEW breakdown (ASCAP)');
  const nrRes = await adminGet(
    `/api/get-readiness?artist_name=${encodeURIComponent(ARTIST_NAME)}&decision=NEEDS_REVIEW&include_blockers=true&destination=ASCAP`
  );
  if (nrRes.ok) {
    const nrd = nrRes.json;
    console.log(`  ASCAP NEEDS_REVIEW rows: ${(nrd.decisions || []).length}`);
    const codeFreq2 = {};
    for (const row of (nrd.decisions || [])) {
      for (const bl of (row.blockers || [])) {
        codeFreq2[bl.code] = (codeFreq2[bl.code] || 0) + 1;
      }
    }
    if (Object.keys(codeFreq2).length) {
      for (const [code, count] of Object.entries(codeFreq2).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${code.padEnd(40)} ${count} tracks`);
      }
    }
  }

  banner('Done');
  console.log('  No external society submissions made.');
}

main().catch(err => {
  console.error('Uncaught error:', err.message);
  process.exit(1);
});
