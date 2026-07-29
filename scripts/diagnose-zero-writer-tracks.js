'use strict';
// scripts/diagnose-zero-writer-tracks.js
//
// Diagnostic for the 8 Esham tracks currently missing writer data.
// Instruction source: MUSIGOD_NEXT_DIAGNOSTIC.md
//
// What this script does (all read-only — zero DB writes):
//   [1] Identifies the 8 zero-writer tracks with full detail
//   [2] Checks all stored enrichment job results for prior writer data
//   [3] Calls Genius API (read-only) for each track — dry run of proposed enrichment
//   [4] Explains and quantifies the graph-sync gap (31 links vs 196 tracks)
//   [5] Reports: auto-resolvable / needs-manual-research / unresolvable
//
// Requires:
//   SUPABASE_SERVICE_KEY — for catalog queries
//   GENIUS_ACCESS_TOKEN  — optional; Genius dry-run is skipped if absent
//
// Both can be placed in .env.local (never committed).
//
// Usage:
//   node scripts/diagnose-zero-writer-tracks.js

// Load .env.local before any process.env reads or module requires.
require('dotenv').config({
  path: require('path').resolve(__dirname, '..', '.env.local'),
  override: false,
});

// Require genius AFTER dotenv so TOKEN is populated at module load.
const { getGeniusWriters } = require('../lib/genius');

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const HAS_GENIUS = !!(process.env.GENIUS_ACCESS_TOKEN);

if (!SB_KEY) {
  console.error('FAIL: SUPABASE_SERVICE_KEY not found.');
  console.error('  Add to .env.local: SUPABASE_SERVICE_KEY=sb_secret_...');
  process.exit(1);
}

const IS_JWT = SB_KEY.startsWith('eyJ');

function hdr(extra = {}) {
  const h = { apikey: SB_KEY, Accept: 'application/json', 'Content-Type': 'application/json', ...extra };
  if (IS_JWT) h.Authorization = `Bearer ${SB_KEY}`;
  return h;
}

async function sbGet(table, params = '') {
  const url = `${SB_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  const r = await fetch(url, { headers: hdr() });
  if (!r.ok) throw new Error(`GET ${table} HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// ── CSV parser (same as verify script) ────────────────────────────────────
function parseLine(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let val = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { val += line[i++]; }
      }
      if (i < line.length && line[i] === ',') i++;
      fields.push(val);
    } else {
      let val = '';
      while (i < line.length && line[i] !== ',') val += line[i++];
      if (i < line.length) i++;
      fields.push(val);
    }
  }
  return fields;
}

function parseCSV(text) {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseLine(lines[0]);
  return lines.slice(1).map(line => {
    const fields = parseLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = fields[i] ?? ''; });
    return obj;
  });
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('════ Esham Zero-Writer Track Diagnostic (read-only) ════');
  console.log(`Target:       ${SB_URL}`);
  console.log(`Auth:         ${IS_JWT ? 'JWT' : 'opaque key'}`);
  console.log(`Genius:       ${HAS_GENIUS ? 'token present — dry run will call API' : 'no token — Genius dry run skipped'}`);
  console.log(`Date:         ${new Date().toISOString()}`);

  // ── [1] Identify the 8 zero-writer tracks ────────────────────────────────
  console.log('');
  console.log('━━━ [1] Zero-writer tracks — full detail ━━━━━━━━━━━━━━━━━━━━━');

  const zeroWriterRows = await sbGet(
    'catalog_enriched_tracks_v1',
    `artist_name=ilike.*sham*&writers=eq.[]` +
    `&select=id,track_title,release_title,release_year,recording_mbid,isrcs,enrichment_source,enrichment_error,enriched,created_at,updated_at` +
    `&order=release_title.asc,track_title.asc&limit=50`
  );

  if (!zeroWriterRows.length) {
    console.log('  ✅ No zero-writer tracks found — catalog is fully enriched');
    return;
  }

  console.log(`  Found ${zeroWriterRows.length} track(s) with writers = []\n`);

  zeroWriterRows.forEach((t, i) => {
    console.log(`  [${i + 1}] "${t.track_title}"`);
    console.log(`       Release:  ${t.release_title} (${t.release_year || 'year unknown'})`);
    console.log(`       ID:       ${t.id}`);
    console.log(`       MBID:     ${t.recording_mbid || '(none)'}`);
    console.log(`       ISRCs:    ${(t.isrcs || []).join(', ') || '(none)'}`);
    console.log(`       Source:   ${t.enrichment_source || '(none)'}`);
    console.log(`       Error:    ${t.enrichment_error || '(none)'}`);
    console.log('');
  });

  // ── [2] Check existing enrichment jobs for prior writer data ─────────────
  console.log('━━━ [2] Existing enrichment job results — prior writer data ━━━');

  const jobs = await sbGet(
    'catalog_enrichments_v1',
    `artist_name=ilike.*sham*&status=eq.DONE&order=created_at.desc&limit=10&select=id,artist_name,created_at`
  );

  console.log(`  Found ${jobs.length} DONE Esham job(s)`);

  // Build a map: normalized title → prior writers, from all available jobs
  // Key: lower(track_title)|lower(release_title)
  const priorWritersByKey = new Map();  // key → { writers: [{name}], jobId, jobDate, source }

  for (const job of jobs) {
    const [full] = await sbGet(
      'catalog_enrichments_v1',
      `id=eq.${job.id}&select=id,created_at,result`
    );
    if (!full?.result?.files) {
      console.log(`  Job ${job.id} (${job.created_at.slice(0, 10)}): no files in result`);
      continue;
    }

    const masterContent = full.result?.files?.master?.content;
    const bmiContent    = full.result?.files?.bmi?.content;

    let foundWriters = 0;
    if (masterContent) {
      const records = parseCSV(masterContent);
      for (const rec of records) {
        const writersRaw = (rec['Writers'] || '').trim();
        if (!writersRaw || writersRaw === 'UNKNOWN - VERIFY') continue;
        const key = `${(rec['Track Title'] || '').trim().toLowerCase()}|${(rec['Release Title'] || '').trim().toLowerCase()}`;
        if (!priorWritersByKey.has(key)) {
          const names = writersRaw.split(';').map(s => s.trim()).filter(Boolean);
          const roles = (rec['Writer Roles'] || '').split(';').map(s => s.trim());
          priorWritersByKey.set(key, {
            writers: names.map((name, i) => ({ name, role: roles[i] || 'CA', source: 'recovered_from_csv' })),
            jobId: job.id, jobDate: job.created_at.slice(0, 10), csvType: 'master',
          });
          foundWriters++;
        }
      }
    } else if (bmiContent) {
      const records = parseCSV(bmiContent);
      const byKey = new Map();
      for (const rec of records) {
        const writerName = (rec['Writer Name'] || '').trim();
        if (!writerName || writerName === 'UNKNOWN - VERIFY') continue;
        const key = `${(rec['Title'] || '').trim().toLowerCase()}|${(rec['Album/Release'] || '').trim().toLowerCase()}`;
        if (!byKey.has(key)) byKey.set(key, []);
        const arr = byKey.get(key);
        if (!arr.some(w => w.name === writerName))
          arr.push({ name: writerName, role: rec['Writer Role'] || 'CA', source: 'recovered_from_csv' });
      }
      for (const [key, writers] of byKey) {
        if (!priorWritersByKey.has(key)) {
          priorWritersByKey.set(key, { writers, jobId: job.id, jobDate: job.created_at.slice(0, 10), csvType: 'bmi' });
          foundWriters++;
        }
      }
    }
    console.log(`  Job ${job.id} (${job.created_at.slice(0, 10)}): ${foundWriters} new tracks with prior writer data indexed`);
  }

  console.log(`\n  Total prior-writer index: ${priorWritersByKey.size} tracks`);

  // Match each zero-writer track against the prior index
  console.log('');
  console.log('  Match results against prior job CSVs:');
  const recoverable = [];
  const notInPrior  = [];

  for (const t of zeroWriterRows) {
    const key = `${(t.track_title || '').toLowerCase()}|${(t.release_title || '').toLowerCase()}`;
    const prior = priorWritersByKey.get(key);
    if (prior) {
      recoverable.push({ track: t, prior });
      console.log(`  ✅ "${t.track_title}" — prior writers found in job ${prior.jobDate}: ${prior.writers.map(w => w.name).join(', ')}`);
    } else {
      notInPrior.push(t);
      console.log(`  ❌ "${t.track_title}" — not in any prior job CSV`);
    }
  }

  // ── [3] Genius dry run — read-only API calls for zero-writer tracks ───────
  console.log('');
  console.log('━━━ [3] Genius dry run (read-only API calls) ━━━━━━━━━━━━━━━━━');

  if (!HAS_GENIUS) {
    console.log('  ⚠️  GENIUS_ACCESS_TOKEN not set — skipping live Genius calls');
    console.log('     Add to .env.local: GENIUS_ACCESS_TOKEN=your_token');
    console.log('     Re-run to include Genius results in the dry run.');
  }

  const geniusResults = []; // { track, writers, found }

  for (const t of zeroWriterRows) {
    if (!HAS_GENIUS) {
      geniusResults.push({ track: t, writers: [], found: false, skipped: true });
      continue;
    }
    process.stdout.write(`  Querying Genius: "${t.track_title}" (${t.release_title})… `);
    try {
      const writers = await getGeniusWriters('Esham', t.track_title);
      if (writers.length) {
        console.log(`FOUND — ${writers.map(w => w.name).join(', ')}`);
        geniusResults.push({ track: t, writers, found: true });
      } else {
        console.log('not found');
        geniusResults.push({ track: t, writers: [], found: false });
      }
    } catch (err) {
      console.log(`ERROR — ${err.message.slice(0, 80)}`);
      geniusResults.push({ track: t, writers: [], found: false, error: err.message });
    }
  }

  // ── [4] Graph sync gap ───────────────────────────────────────────────────
  console.log('');
  console.log('━━━ [4] Graph sync gap ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Count total Esham catalog tracks
  const allEsham = await sbGet(
    'catalog_enriched_tracks_v1',
    `artist_name=ilike.*sham*&select=id&limit=1000`
  );
  const eshamIds = allEsham.map(r => r.id);
  const totalTracks = eshamIds.length;

  // Count graph_catalog_links_v1 entries for Esham
  const idList = eshamIds.map(id => `"${id}"`).join(',');
  let graphLinks = [];
  try {
    graphLinks = await sbGet(
      'graph_catalog_links_v1',
      `track_id=in.(${idList})&select=track_id,node_role,linked_by&limit=2000`
    );
  } catch (err) {
    console.log(`  ⚠️  graph_catalog_links_v1 query failed: ${err.message.slice(0, 120)}`);
  }

  const linkedTrackIds = new Set(graphLinks.map(l => l.track_id));
  const linkCount = graphLinks.length;
  const linkedTracks = linkedTrackIds.size;
  const gap = totalTracks - linkedTracks;

  // Which tracks have links?
  const linkedByRole = {};
  for (const l of graphLinks) {
    linkedByRole[l.node_role] = (linkedByRole[l.node_role] || 0) + 1;
  }

  const linkedBy = {};
  for (const l of graphLinks) {
    linkedBy[l.linked_by] = (linkedBy[l.linked_by] || 0) + 1;
  }

  console.log(`  Total Esham tracks in catalog:       ${totalTracks}`);
  console.log(`  Tracks with graph_catalog_links_v1:  ${linkedTracks}`);
  console.log(`  Total graph link rows:               ${linkCount}`);
  console.log(`  Tracks with NO graph links:          ${gap}  ← the gap`);
  console.log('');

  if (Object.keys(linkedByRole).length) {
    console.log('  Link breakdown by node_role:');
    for (const [role, n] of Object.entries(linkedByRole)) console.log(`    ${role.padEnd(16)} ${n}`);
  }
  if (Object.keys(linkedBy).length) {
    console.log('  Link breakdown by linked_by:');
    for (const [by, n] of Object.entries(linkedBy)) console.log(`    ${by.padEnd(16)} ${n}`);
  }

  console.log('');
  console.log('  Root cause of gap:');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  graph_catalog_links_v1 is populated by fn_sync_track_to_graph()');
  console.log('  or fn_backfill_catalog_to_graph() (SQL functions in public schema).');
  console.log('');
  console.log('  The live enrichment pipeline (api/graph-sync.js) calls');
  console.log('  rpc_upsert_recording_enrichment() instead, which writes to');
  console.log('  graph.nodes + works.recordings — a DIFFERENT graph path that');
  console.log('  does NOT populate graph_catalog_links_v1.');
  console.log('');
  console.log(`  The ${linkedTracks} linked tracks were synced via fn_sync_track_to_graph()`);
  console.log('  at some earlier point (likely during the rights-graph backfill or');
  console.log('  a test run of fn_backfill_catalog_to_graph()).');
  console.log('');
  console.log(`  To close the gap: run SELECT fn_backfill_catalog_to_graph() in`);
  console.log('  Supabase SQL Editor (no migration needed — function already deployed).');
  console.log(`  This will create graph_catalog_links_v1 entries for the remaining`);
  console.log(`  ${gap} tracks. Idempotent — safe to run multiple times.`);

  // ── [5] Resolution summary ────────────────────────────────────────────────
  console.log('');
  console.log('━━━ [5] Resolution plan — dry-run proposed changes ━━━━━━━━━━━');
  console.log('');

  const autoFromPrior  = recoverable;
  const autoFromGenius = geniusResults.filter(g => g.found && !recoverable.some(r => r.track.id === g.track.id));
  const geniusAlso     = geniusResults.filter(g => g.found && recoverable.some(r => r.track.id === g.track.id));
  const needsManual    = zeroWriterRows.filter(t => {
    const inPrior  = recoverable.some(r => r.track.id === t.id);
    const inGenius = geniusResults.some(g => g.found && g.track.id === t.id);
    return !inPrior && !inGenius;
  });

  if (autoFromPrior.length) {
    console.log(`  ✅ AUTO-RESOLVABLE from prior enrichment job CSV (${autoFromPrior.length} track(s)):`);
    for (const { track, prior } of autoFromPrior) {
      const geniusMatch = geniusAlso.find(g => g.track.id === track.id);
      console.log(`\n     "${track.track_title}" (${track.release_title})`);
      console.log(`       ID:              ${track.id}`);
      console.log(`       Proposed source: recovered_from_csv (job ${prior.jobDate})`);
      console.log(`       Writers:         ${prior.writers.map(w => w.name).join(', ')}`);
      if (geniusMatch) {
        const gNames = geniusMatch.writers.map(w => w.name).join(', ');
        const match  = geniusMatch.writers.every(gw =>
          prior.writers.some(pw => pw.name.toLowerCase() === gw.name.toLowerCase())
        );
        console.log(`       Genius confirms: ${gNames} ${match ? '✅ matches' : '⚠️ DIFFERS — review'}`);
      }
    }
    console.log('');
  }

  if (autoFromGenius.length) {
    console.log(`  🎵 AUTO-RESOLVABLE from Genius only (${autoFromGenius.length} track(s)):`);
    for (const g of autoFromGenius) {
      console.log(`\n     "${g.track.track_title}" (${g.track.release_title})`);
      console.log(`       ID:              ${g.track.id}`);
      console.log(`       Proposed source: genius`);
      console.log(`       Writers:         ${g.writers.map(w => w.name).join(', ')}`);
    }
    console.log('');
  }

  if (!HAS_GENIUS && notInPrior.length) {
    console.log(`  ❓ UNKNOWN — Genius not checked (${notInPrior.length} track(s)):`);
    for (const t of notInPrior) {
      console.log(`     "${t.track_title}" (${t.release_title})  id=${t.id}`);
    }
    console.log('     Add GENIUS_ACCESS_TOKEN to .env.local and re-run to check.');
    console.log('');
  }

  if (needsManual.length) {
    const label = HAS_GENIUS ? 'NEEDS MANUAL RESEARCH' : 'NOT IN PRIOR CSV — manual or Genius needed';
    console.log(`  ⚠️  ${label} (${needsManual.length} track(s)):`);
    for (const t of needsManual) {
      console.log(`     "${t.track_title}" (${t.release_title})  id=${t.id}`);
      console.log(`       MBID: ${t.recording_mbid || 'none'}  ISRCs: ${(t.isrcs || []).join(', ') || 'none'}`);
    }
    console.log('');
    console.log('     Options for manual research:');
    console.log('     1. MusicBrainz: search by ISRC or MBID for linked work + writer-rels');
    console.log('     2. Discogs: search by artist + release title for writing credits');
    console.log('     3. BMI/ASCAP public repertoire search by track title');
    console.log('     4. lib/overrides.js: add manual writer entry once confirmed');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('');
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`Zero-writer tracks:          ${zeroWriterRows.length}`);
  console.log(`Auto-resolvable (prior CSV): ${autoFromPrior.length}`);
  console.log(`Auto-resolvable (Genius):    ${autoFromGenius.length}`);
  console.log(`Needs manual research:       ${needsManual.length}`);
  if (!HAS_GENIUS && notInPrior.length) {
    console.log(`Genius not checked:          ${notInPrior.length}`);
  }
  console.log(`Graph link gap:              ${gap} of ${totalTracks} tracks unlinked`);
  console.log('');
  console.log('Zero DB writes made. All Genius calls were read-only API searches.');
  console.log('To apply proposed changes, run scripts/restore-regressed-writers.js');
  console.log('(for prior-CSV resolvable) or re-run enrichment scoped to the 8 tracks.');
}

main().catch(err => {
  console.error('Uncaught error:', err.message);
  process.exit(1);
});
