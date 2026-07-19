// scripts/dry-run-mbid-identity-check.js
//
// Read-only diagnostic: reports the scope of damage from Finding 2 in production.
// No writes, no schema changes.
//
// Run: node scripts/dry-run-mbid-identity-check.js
// Requires: SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)
//
// What this checks:
//   1. How many recording nodes exist per external_id_ns.
//   2. Of isrc-namespace recording nodes, how many have musicbrainz_recording_id
//      already set in works_recordings_v1 (these are healthy).
//   3. Of isrc-namespace recording nodes, how many have a NULL musicbrainz_recording_id
//      (these may have been damaged by the overwrite bug — ISRC set, MBID lost).
//   4. How many catalog_enriched_tracks_v1 rows have a recording_mbid that cannot
//      be found in works.works_recordings_v1.musicbrainz_recording_id.
//   5. Total graph node count breakdown by type and namespace.

'use strict';

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SB_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY not set. Run: set SUPABASE_SERVICE_ROLE_KEY=<key>');
  process.exit(1);
}

function h(schema) {
  const hdrs = {
    apikey:          SB_KEY,
    Authorization:   `Bearer ${SB_KEY}`,
    Accept:          'application/json',
    'Accept-Profile': schema || 'public',
  };
  return hdrs;
}

async function q(table, params, schema) {
  const qs = new URLSearchParams(params).toString();
  const url = `${SB_URL}/rest/v1/${table}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, { headers: h(schema) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${table}: ${res.status} — ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function count(table, params, schema) {
  const hdrs = { ...h(schema), Prefer: 'count=exact', Range: '0-0' };
  const qs = new URLSearchParams({ ...params, select: 'id' }).toString();
  const url = `${SB_URL}/rest/v1/${table}?${qs}`;
  const res = await fetch(url, { headers: hdrs });
  const ct = res.headers.get('content-range') || '0/0';
  // content-range: 0-0/N  or  */N
  const total = parseInt(ct.split('/')[1] || '0', 10);
  return isNaN(total) ? 0 : total;
}

async function rpcPost(fn, body) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method:  'POST',
    headers: { ...h('graph'), 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`RPC ${fn}: ${res.status} — ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function section(title) {
  console.log('\n' + '─'.repeat(60));
  console.log(title);
  console.log('─'.repeat(60));
}

async function main() {
  console.log('=== MusiGod Graph Identity Dry-Run ===');
  console.log('Mode: READ-ONLY. No writes performed.');
  console.log(`Target: ${SB_URL}`);
  console.log(`Run at: ${new Date().toISOString()}`);

  // ── 1. Graph node counts by type and namespace ──────────────────────────────
  section('1. Graph nodes — type × namespace breakdown');

  let allRecordingNodes = [];
  try {
    // Fetch all recording nodes (up to 1000 — enough for Esham pilot scale)
    allRecordingNodes = await q('graph_nodes_v1',
      { node_type: 'eq.recording', select: 'id,external_id,external_id_ns,properties', limit: '1000' },
      'graph'
    );
    console.log(`Total recording nodes fetched: ${allRecordingNodes.length}`);

    const byCatalogNs  = allRecordingNodes.filter(n => n.external_id_ns === 'musigod_catalog');
    const byIsrcNs     = allRecordingNodes.filter(n => n.external_id_ns === 'isrc');
    const byMbidNs     = allRecordingNodes.filter(n => n.external_id_ns === 'musicbrainz');
    const byOther      = allRecordingNodes.filter(n =>
      !['musigod_catalog','isrc','musicbrainz'].includes(n.external_id_ns));

    console.log(`  external_id_ns='musigod_catalog' : ${byCatalogNs.length}`);
    console.log(`  external_id_ns='isrc'            : ${byIsrcNs.length}`);
    console.log(`  external_id_ns='musicbrainz'     : ${byMbidNs.length}`);
    console.log(`  external_id_ns=other             : ${byOther.length}`);

    if (byOther.length) {
      const otherNs = [...new Set(byOther.map(n => n.external_id_ns))].join(', ');
      console.log(`    other namespaces: ${otherNs}`);
    }
  } catch (err) {
    console.warn(`  ⚠ Could not fetch graph_nodes_v1 via graph schema: ${err.message}`);
    console.warn('  (graph schema may require Accept-Profile: graph — check PostgREST config)');
  }

  // ── 2. works_recordings_v1: MBID population rate ──────────────────────────
  section('2. works.works_recordings_v1 — musicbrainz_recording_id population');

  try {
    const totalRec = await count('works_recordings_v1', {}, 'works');
    const withMbid = await count('works_recordings_v1',
      { musicbrainz_recording_id: 'not.is.null' }, 'works');
    const nullMbid = totalRec - withMbid;

    console.log(`Total rows in works_recordings_v1 : ${totalRec}`);
    console.log(`  musicbrainz_recording_id IS NOT NULL : ${withMbid}`);
    console.log(`  musicbrainz_recording_id IS NULL     : ${nullMbid}`);

    if (nullMbid > 0) {
      console.log(`\n  ⚠ ${nullMbid} recording(s) in the formal graph have no MBID bridged.`);
      console.log('    These cannot be joined to catalog_enriched_tracks_v1.recording_mbid.');
    } else {
      console.log('\n  ✓ All recordings have musicbrainz_recording_id set.');
    }
  } catch (err) {
    console.warn(`  ⚠ Could not query works_recordings_v1: ${err.message}`);
  }

  // ── 3. isrc-namespace nodes with NULL musicbrainz_recording_id ─────────────
  section('3. Candidate damaged nodes (isrc-ns recording nodes with no MBID in works table)');

  try {
    const isrcNodes = allRecordingNodes.filter(n => n.external_id_ns === 'isrc');
    if (!isrcNodes.length) {
      console.log('  No recording nodes in isrc namespace — no damage to report.');
    } else {
      // For each isrc-namespace node, check if works_recordings_v1 has musicbrainz_recording_id
      let damaged = 0;
      const damagedList = [];

      for (const node of isrcNodes.slice(0, 200)) { // cap at 200 to avoid rate limit
        const rows = await q('works_recordings_v1',
          { node_id: `eq.${node.id}`, select: 'node_id,isrc,musicbrainz_recording_id' },
          'works'
        );
        const rec = rows[0];
        if (rec && !rec.musicbrainz_recording_id) {
          damaged++;
          damagedList.push({
            node_id:    node.id,
            external_id: node.external_id,
            catalog_id:  node.properties?.catalog_id || null,
          });
        }
      }

      console.log(`isrc-namespace recording nodes checked: ${Math.min(isrcNodes.length, 200)}`);
      console.log(`  With NULL musicbrainz_recording_id (likely damaged): ${damaged}`);

      if (damagedList.length > 0) {
        console.log('\n  Damaged node sample (first 10):');
        damagedList.slice(0, 10).forEach(n => {
          console.log(`    node_id=${n.node_id.slice(0, 8)}… isrc=${n.external_id} catalog_id=${n.catalog_id || '(none)'}`);
        });
        console.log('\n  ⚠ Repair needed: restore external_id_ns to musigod_catalog for damaged nodes.');
        console.log('    A separate one-time repair migration will be required (not part of this fix).');
      } else if (isrcNodes.length > 0) {
        console.log('  ✓ All isrc-namespace nodes have musicbrainz_recording_id set (healthy).');
      }
    }
  } catch (err) {
    console.warn(`  ⚠ Damaged-node check failed: ${err.message}`);
  }

  // ── 4. catalog_enriched_tracks_v1: orphaned recording_mbids ───────────────
  section('4. catalog_enriched_tracks_v1 — recording_mbid bridge coverage');

  try {
    const totalEnriched = await count('catalog_enriched_tracks_v1', {});
    const withRecMbid   = await count('catalog_enriched_tracks_v1',
      { recording_mbid: 'not.is.null' });
    const enrichedRows  = await q('catalog_enriched_tracks_v1',
      { enriched: 'eq.true', select: 'recording_mbid,artist_name,track_title', limit: '500' });

    console.log(`Total rows in catalog_enriched_tracks_v1 : ${totalEnriched}`);
    console.log(`  With recording_mbid set                : ${withRecMbid}`);
    console.log(`  Without recording_mbid                 : ${totalEnriched - withRecMbid}`);

    // Check how many of those mbids exist in works_recordings_v1
    let bridged = 0; let unbridged = 0;
    const unBridgedSample = [];

    for (const row of enrichedRows.filter(r => r.recording_mbid).slice(0, 100)) {
      try {
        const found = await q('works_recordings_v1',
          { musicbrainz_recording_id: `eq.${row.recording_mbid}`, select: 'node_id' },
          'works'
        );
        if (found.length > 0) bridged++;
        else {
          unBridged++;
          if (unBridgedSample.length < 5) {
            unBridgedSample.push(`${row.artist_name} — ${row.track_title} (${row.recording_mbid})`);
          }
        }
      } catch { unBridged++; }
    }

    const checked = Math.min(enrichedRows.filter(r => r.recording_mbid).length, 100);
    console.log(`\n  Bridge check (sample of ${checked} enriched tracks with recording_mbid):`);
    console.log(`    Bridged to works_recordings_v1 : ${bridged}`);
    console.log(`    Not yet bridged                : ${unBridged}`);

    if (unBridged > 0) {
      console.log('\n  Unbrided sample (first 5):');
      unBridgedSample.forEach(s => console.log(`    ${s}`));
      console.log('\n  → These will be bridged on next enrichment run after code fix deployed.');
    }
  } catch (err) {
    console.warn(`  ⚠ catalog_enriched_tracks_v1 check failed: ${err.message}`);
  }

  // ── 5. Summary ─────────────────────────────────────────────────────────────
  section('5. Summary');
  console.log('  DRY-RUN COMPLETE — no data was modified.');
  console.log('  Review findings above before applying the migration and deploying the code fix.');
  console.log('\n  Next steps (in order):');
  console.log('  1. Review this report with project owner.');
  console.log('  2. Apply migration: 20260709_graph_recording_mbid_bridge.sql via Supabase SQL Editor.');
  console.log('  3. Deploy api/graph-sync.js fix (vercel --prod --force).');
  console.log('  4. Re-run enrichment for Esham to backfill musicbrainz_recording_id.');
  console.log('  5. If damaged nodes exist: apply a separate one-time repair migration');
  console.log('     to restore external_id_ns from isrc → musigod_catalog for affected nodes.');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
