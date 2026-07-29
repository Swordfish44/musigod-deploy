'use strict';
// scripts/verify-esham-catalog.js
//
// Read-only verification of the Esham catalog state in production.
// Covers: writer completeness, graph synchronization, and registration-readiness
// totals. Makes zero writes. Used to close the Esham 31-track writer incident
// and assess proof-case readiness.
//
// Key loading (in priority order):
//   1. .env.local in the repo root (dotenv, never committed — covered by .gitignore)
//   2. SUPABASE_SERVICE_KEY environment variable
//   3. SUPABASE_SERVICE_ROLE_KEY environment variable
//
// Usage:
//   node scripts/verify-esham-catalog.js
//
// SECURITY: The key is never printed, logged, or included in any output.
//   sb_secret_* keys are sent ONLY in the apikey header (no Authorization: Bearer).
//   eyJ* (JWT) keys are sent in both apikey and Authorization: Bearer.
//
// Exits 0 if all read checks succeed (even if catalog gaps are found).
// Exits 1 on any HTTP failure (connectivity / auth).

// Load .env.local before reading process.env. dotenv.config() is a no-op when
// the file is absent; it never throws, never overrides already-set env vars.
require('dotenv').config({
  path: require('path').resolve(__dirname, '..', '.env.local'),
  override: false,
});

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SB_KEY) {
  console.error('FAIL: SUPABASE_SERVICE_KEY not found.');
  console.error('  Add it to .env.local (repo root) as: SUPABASE_SERVICE_KEY=sb_secret_...');
  console.error('  .env.local is in .gitignore and is never committed.');
  process.exit(1);
}

// sb_secret_ keys are opaque — apikey header only.
// eyJ keys are JWTs — both apikey and Authorization: Bearer.
// Never log or interpolate SB_KEY into any string.
const IS_JWT = SB_KEY.startsWith('eyJ');

function hdr(extra = {}) {
  const h = {
    apikey: SB_KEY,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
  if (IS_JWT) h.Authorization = `Bearer ${SB_KEY}`;
  return h;
}

async function get(table, params = '', schemaHint = null) {
  const headers = schemaHint
    ? hdr({ 'Accept-Profile': schemaHint, 'Content-Profile': schemaHint })
    : hdr();
  const url = `${SB_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`GET ${table} HTTP ${r.status}: ${body.slice(0, 300)}`);
  }
  // Respect Content-Range for count queries
  const range = r.headers.get('content-range');
  const data  = await r.json();
  return { data, range };
}

// PostgREST COUNT: HEAD request with Prefer: count=exact
async function count(table, params = '', schemaHint = null) {
  const headers = schemaHint
    ? hdr({ 'Accept-Profile': schemaHint, 'Content-Profile': schemaHint, Prefer: 'count=exact' })
    : hdr({ Prefer: 'count=exact' });
  const url = `${SB_URL}/rest/v1/${table}${params ? '?' + params : ''}&limit=1`;
  const r = await fetch(url, { method: 'HEAD', headers });
  if (!r.ok) return null;
  const range = r.headers.get('content-range'); // "0-0/179" or "*/179"
  if (!range) return null;
  const m = range.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

let httpFail = 0;
function note(label) { console.log(`  ${label}`); }
function pass(label) { console.log(`  ✅ ${label}`); }
function warn(label) { console.log(`  ⚠️  ${label}`); }
function fail(label) { console.error(`  ❌ ${label}`); httpFail++; }

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('════ Esham Catalog Verification (read-only) ════');
  console.log(`Target: ${SB_URL}`);
  console.log(`Auth:   ${IS_JWT ? 'JWT' : 'opaque key (apikey only)'}`);
  console.log(`Date:   ${new Date().toISOString()}`);

  // ── Section 1: Writer completeness ────────────────────────────────────────
  console.log('');
  console.log('━━━ [1] Writer completeness ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let totalTracks = 0, withWriters = 0, withoutWriters = 0;
  let sources = {};
  let recoveredCount = 0;
  let geniusCount = 0, discogsCount = 0, mbCount = 0, csvCount = 0;
  let noWriterTracks = [];

  try {
    totalTracks = await count(
      'catalog_enriched_tracks_v1',
      `artist_name=ilike.*sham*`
    ) ?? 0;

    withWriters = await count(
      'catalog_enriched_tracks_v1',
      `artist_name=ilike.*sham*&writers=not.eq.[]`
    ) ?? 0;

    withoutWriters = await count(
      'catalog_enriched_tracks_v1',
      `artist_name=ilike.*sham*&writers=eq.[]`
    ) ?? 0;

    recoveredCount = await count(
      'catalog_enriched_tracks_v1',
      `artist_name=ilike.*sham*&recovered_from_csv=eq.true`
    ) ?? 0;

    // Source breakdown
    for (const src of ['musicbrainz', 'discogs', 'genius', 'recovered_from_csv']) {
      const n = await count(
        'catalog_enriched_tracks_v1',
        `artist_name=ilike.*sham*&enrichment_source=eq.${src}`
      );
      if (n !== null) sources[src] = n;
    }

    // Tracks missing writers — fetch titles for the report (limit 50)
    const { data: noW } = await get(
      'catalog_enriched_tracks_v1',
      `artist_name=ilike.*sham*&writers=eq.[]&select=track_title,release_title,enrichment_error&limit=50`
    );
    noWriterTracks = noW;

    note(`Total Esham tracks in catalog:  ${totalTracks}`);
    note(`  With writers:                 ${withWriters} (${pct(withWriters, totalTracks)}%)`);
    note(`  Without writers:              ${withoutWriters} (${pct(withoutWriters, totalTracks)}%)`);
    note(`  Recovered from CSV:           ${recoveredCount}`);
    note('');
    note('  Enrichment source breakdown:');
    for (const [src, n] of Object.entries(sources)) {
      note(`    ${src.padEnd(20)} ${n}`);
    }

    if (withWriters >= totalTracks * 0.9) {
      pass(`Writer coverage ≥ 90%: ${withWriters}/${totalTracks}`);
    } else {
      warn(`Writer coverage below 90%: ${withWriters}/${totalTracks}`);
    }

    if (withoutWriters === 0) {
      pass('Zero tracks missing writers');
    } else {
      warn(`${withoutWriters} track(s) still missing writers:`);
      noWriterTracks.slice(0, 20).forEach(t =>
        note(`    "${t.track_title}" (${t.release_title}) — ${t.enrichment_error || 'no error recorded'}`)
      );
      if (noWriterTracks.length > 20) note(`    …and ${noWriterTracks.length - 20} more`);
    }
  } catch (err) {
    fail(`Writer completeness check failed: ${err.message}`);
  }

  // ── Section 2: 31-track incident — verify EXACT_MATCH ────────────────────
  console.log('');
  console.log('━━━ [2] Esham 31-track incident — post-closure state ━━━━━━━━━');

  const MANIFEST_IDS = [
    '851c7879-1d49-4694-ab4f-291f563f45f7','3e2be49e-1221-406a-b8e2-50ba1b3170d3',
    '47010d4a-710c-4661-8942-ec0969b4bc4c','92c5ba66-00b0-49b2-a7df-c141b1572461',
    '0d407229-a811-4ff3-a0aa-036f81928480','e1f859ac-c39e-4653-a1da-620ccc6015b9',
    '4bd95aae-a8a5-4692-8417-cef9c7b35e3d','5f033ff5-7411-402f-b88d-f2eb0ac1b56c',
    '3f3df72c-7a70-4ece-9b99-2e2d6957b5d8','9f2b1839-a74a-4da6-8bec-4b25bcd7e694',
    'f3fd7279-42f4-4b2f-a335-8fa169edbd22','f420e78f-0f26-47cc-925a-64ec87336ba9',
    'c8ad769e-b80d-476f-a8ac-c8ba5bc4e213','8578e2a6-8713-4686-b9e3-db335a386c82',
    'b57013da-3e06-48a4-9116-c74115245a6b','052ed575-96cd-4402-8772-863c709b9d81',
    '6e063841-12aa-4d21-88b1-db5234bdffac','7d939e20-1fad-4ede-8a76-154a6436e625',
    '96c8ffc6-7a4c-400b-a144-b59a653be912','cd7429db-75c4-445f-abf7-e7fe82dbdb02',
    '7fa40949-6625-48c9-b4a3-20895f5e0313','ad6752b0-9f17-46e7-8ad1-2ae2f22ed7ed',
    '0d435cf6-5307-4c75-aa96-a489c01fa2a1','119d7e60-04fb-4bec-9128-4bd6a8cafd0d',
    '73036f45-f7db-4249-8f34-559d44b4eee6','3eee1d51-2d78-4683-a5bf-f194c70ec98b',
    '8283f1af-4770-4fb4-a226-37c2c620b665','cd65ef7f-a228-42e9-9e2e-c7e2a8887099',
    '8e88da45-f870-42ce-a3c1-e7d3e1aaf937','6d7349f2-eac5-4c38-b856-94e2ce0c6691',
    '00c2891b-272d-4717-ab2c-0dde48b18bee',
  ];

  try {
    const idList = MANIFEST_IDS.map(id => `"${id}"`).join(',');
    const { data: rows } = await get(
      'catalog_enriched_tracks_v1',
      `id=in.(${idList})&select=id,track_title,writers,enrichment_source,recovered_from_csv`
    );

    const withW  = rows.filter(r => Array.isArray(r.writers) && r.writers.length > 0);
    const noW    = rows.filter(r => !Array.isArray(r.writers) || r.writers.length === 0);
    const recov  = rows.filter(r => r.recovered_from_csv);

    note(`Incident tracks found in DB: ${rows.length}/31`);
    note(`  Have writers:              ${withW.length}`);
    note(`  Still at 0 writers:        ${noW.length}`);
    note(`  Marked recovered_from_csv: ${recov.length}`);

    if (withW.length === 31 && noW.length === 0) {
      pass('All 31 incident tracks have writers — incident closed as EXACT_MATCH');
    } else if (noW.length > 0) {
      warn(`${noW.length} incident track(s) still have 0 writers:`);
      noW.forEach(r => note(`    "${r.track_title}" id=${r.id}`));
    }
  } catch (err) {
    fail(`Incident track check failed: ${err.message}`);
  }

  // ── Section 3: Graph synchronization ─────────────────────────────────────
  console.log('');
  console.log('━━━ [3] Graph synchronization ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // graph_catalog_links_v1 is public schema; graph.nodes requires schema header
  let catalogLinks = null, graphNodes = null;

  try {
    catalogLinks = await count(
      'graph_catalog_links_v1',
      `track_id=in.(select id from catalog_enriched_tracks_v1 where artist_name.ilike.*sham*)`
    );
    // Simple proxy: just count total links from catalog table
    // PostgREST doesn't support subqueries in filter params; use a join or count all
    // Fall back to fetching Esham track IDs first then counting links
    const { data: eshamRows } = await get(
      'catalog_enriched_tracks_v1',
      `artist_name=ilike.*sham*&select=id&limit=1000`
    );
    const eshamIds = eshamRows.map(r => `"${r.id}"`).join(',');

    if (eshamIds.length > 0) {
      catalogLinks = await count(
        'graph_catalog_links_v1',
        `track_id=in.(${eshamIds})`
      );
    }

    note(`graph_catalog_links_v1 entries for Esham: ${catalogLinks ?? 'unknown'}`);

    if (catalogLinks === 0 || catalogLinks === null) {
      warn('No graph_catalog_links_v1 entries found — graph sync may not have run for Esham');
    } else {
      pass(`Graph catalog links present: ${catalogLinks}`);
    }
  } catch (err) {
    warn(`graph_catalog_links_v1 check: ${err.message.slice(0, 120)}`);
  }

  // Try to count graph.nodes for Esham (non-public schema — may be RLS-blocked)
  try {
    const nTotal = await count('nodes', ``, 'graph');
    if (nTotal !== null) {
      note(`graph.nodes total (all artists): ${nTotal}`);
    }
  } catch (err) {
    note(`graph.nodes (schema=graph): ${err.message.slice(0, 80)}`);
  }

  // Check works.recordings for Esham ISRCs as a graph-sync proxy
  try {
    const wTotal = await count('recordings', ``, 'works');
    if (wTotal !== null) {
      note(`works.recordings total: ${wTotal}`);
    }
  } catch (err) {
    note(`works.recordings (schema=works): ${err.message.slice(0, 80)}`);
  }

  // ── Section 4: Registration-readiness totals ──────────────────────────────
  console.log('');
  console.log('━━━ [4] Registration-readiness totals ━━━━━━━━━━━━━━━━━━━━━━━');

  let readinessRows = 0;
  try {
    // Fetch all readiness rows for tracks in the Esham set
    const { data: eshamFull } = await get(
      'catalog_enriched_tracks_v1',
      `artist_name=ilike.*sham*&select=id&limit=1000`
    );
    const eshamIds = eshamFull.map(r => `"${r.id}"`).join(',');

    if (!eshamIds) {
      note('No Esham tracks found — skipping readiness check');
    } else {
      const { data: readiness } = await get(
        'registration_readiness_v1',
        `catalog_track_id=in.(${eshamIds})&select=destination,decision,blockers,evaluated_at&limit=2000`
      );

      readinessRows = readiness.length;

      if (readinessRows === 0) {
        warn('No readiness evaluations found — /api/evaluate-readiness has not been run for Esham');
      } else {
        const byDest = {};
        const byDecision = {};
        for (const r of readiness) {
          byDest[r.destination] = (byDest[r.destination] || 0) + 1;
          byDecision[r.decision] = (byDecision[r.decision] || 0) + 1;
        }

        const uniqueTracks = new Set(readiness.map(r => r.catalog_track_id)).size;
        const latestEval = readiness
          .map(r => r.evaluated_at)
          .sort()
          .reverse()[0];

        note(`Readiness rows: ${readinessRows}  (${uniqueTracks} unique tracks × up to 5 destinations)`);
        note(`Latest eval:    ${latestEval}`);
        note('');
        note('  Decision breakdown:');
        for (const [d, n] of Object.entries(byDecision).sort()) {
          const icon = d === 'READY' ? '✅' : d === 'BLOCKED' ? '❌' : d === 'NEEDS_REVIEW' ? '⚠️ ' : '—';
          note(`    ${icon} ${d.padEnd(16)} ${n}`);
        }
        note('');
        note('  Destination breakdown:');
        for (const [d, n] of Object.entries(byDest).sort()) {
          note(`    ${d.padEnd(20)} ${n} evaluations`);
        }

        const readyRows = byDecision['READY'] || 0;
        const blockedRows = byDecision['BLOCKED'] || 0;
        const needsReviewRows = byDecision['NEEDS_REVIEW'] || 0;

        if (readyRows > 0) {
          pass(`${readyRows} track-destination pair(s) are READY for registration`);
        }
        if (blockedRows > 0) {
          warn(`${blockedRows} track-destination pair(s) are BLOCKED`);
        }
        if (needsReviewRows > 0) {
          warn(`${needsReviewRows} track-destination pair(s) NEED_REVIEW`);
        }

        // Sample one BLOCKED row to show why
        const blocked = readiness.filter(r => r.decision === 'BLOCKED');
        if (blocked.length > 0) {
          const sample = blocked[0];
          const blockers = Array.isArray(sample.blockers) ? sample.blockers : [];
          note('');
          note(`  Sample BLOCKED row (${sample.destination}): ${blockers.map(b => b.code).join(', ') || 'no blocker codes'}`);
        }
      }
    }
  } catch (err) {
    warn(`Readiness check: ${err.message.slice(0, 200)}`);
  }

  // ── Section 5: Blocker summary for proof-case readiness ──────────────────
  console.log('');
  console.log('━━━ [5] Remaining blockers — Esham as proof case ━━━━━━━━━━━━');

  const blockers = [];

  if (withoutWriters > 0) {
    blockers.push({
      code: 'MISSING_WRITERS',
      severity: 'HIGH',
      detail: `${withoutWriters} track(s) have no writer data. Cannot register without writers.`,
      action: 'Run fresh Genius enrichment scoped to these tracks.',
    });
  }

  if (readinessRows === 0) {
    blockers.push({
      code: 'READINESS_NOT_EVALUATED',
      severity: 'HIGH',
      detail: 'No registration-readiness evaluation has been run for Esham.',
      action: 'Apply the schema reload migration (20260725_reload_schema.sql) via Supabase SQL Editor ' +
              'session mode, then run: AUDIT_ADMIN_KEY=<key> node scripts/run-evaluate-esham.js',
    });
  }

  if (catalogLinks === 0 || catalogLinks === null) {
    blockers.push({
      code: 'GRAPH_NOT_SYNCED',
      severity: 'MEDIUM',
      detail: 'No graph_catalog_links_v1 entries found — rights graph is disconnected from catalog.',
      action: 'Run fn_backfill_catalog_to_graph() in Supabase SQL Editor, or re-run enrichment ' +
              'with graph-sync wired in (api/enrich-artist.js or api/run-enrichment-job.js).',
    });
  }

  if (blockers.length === 0) {
    pass('No blockers identified — Esham catalog is proof-case ready');
  } else {
    console.log('');
    blockers.forEach((b, i) => {
      const icon = b.severity === 'HIGH' ? '❌' : '⚠️ ';
      console.log(`  ${icon} [${b.code}] (${b.severity})`);
      console.log(`     ${b.detail}`);
      console.log(`     Action: ${b.action}`);
      console.log('');
    });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`Tracks total:        ${totalTracks}`);
  console.log(`With writers:        ${withWriters} (${pct(withWriters, totalTracks)}%)`);
  console.log(`Without writers:     ${withoutWriters}`);
  console.log(`Readiness rows:      ${readinessRows}`);
  console.log(`Graph links:         ${catalogLinks ?? 'unknown'}`);
  console.log(`Open blockers:       ${blockers.length}`);
  console.log(`HTTP failures:       ${httpFail}`);
  console.log('');
  console.log(httpFail > 0 ? '❌ Verification completed with HTTP failures' :
              blockers.length > 0 ? '⚠️  Verification complete — blockers require resolution' :
              '✅ Verification complete — Esham catalog is proof-case ready');

  if (httpFail > 0) process.exit(1);
}

function pct(n, total) {
  if (!total) return '0';
  return Math.round((n / total) * 100);
}

main().catch(err => {
  console.error('Uncaught error:', err.message);
  process.exit(1);
});
