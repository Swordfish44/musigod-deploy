#!/usr/bin/env node
// scripts/recover-enrichment-job.js
// One-time backfill: pulls a historical job row from catalog_enrichments_v1
// and reconstructs per-track rows in catalog_enriched_tracks_v1 from the
// Master Catalog CSV that's the only surviving copy of that run's data.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=xxx node scripts/recover-enrichment-job.js --artist "Esham"
//   SUPABASE_SERVICE_ROLE_KEY=xxx node scripts/recover-enrichment-job.js --job-id <uuid>
//   SUPABASE_SERVICE_ROLE_KEY=xxx node scripts/recover-enrichment-job.js --artist "Esham" --list
//     (--list just shows matching job rows without recovering, so you can
//      pick the right job_id if there were multiple runs)

const { recoverTracksFromMasterCSV } = require('../lib/parse-master-csv');
const { upsertRows, toRow } = require('../lib/persist-enriched-tracks');

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

function parseArgs(argv) {
  const out = { list: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--artist') out.artist = argv[++i];
    else if (argv[i] === '--job-id') out.jobId = argv[++i];
    else if (argv[i] === '--list') out.list = true;
  }
  return out;
}

async function sbGet(query) {
  const res = await fetch(`${SB_URL}/rest/v1/catalog_enrichments_v1?${query}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET catalog_enrichments_v1 failed: ${res.status} — ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

async function main() {
  if (!SB_KEY) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY) in env.');
    process.exit(1);
  }

  const args = parseArgs(process.argv);
  if (!args.artist && !args.jobId) {
    console.error('Usage: node scripts/recover-enrichment-job.js --artist "Esham" [--list]');
    console.error('   or: node scripts/recover-enrichment-job.js --job-id <uuid>');
    process.exit(1);
  }

  let jobs;
  if (args.jobId) {
    jobs = await sbGet(`id=eq.${encodeURIComponent(args.jobId)}&select=id,artist_name,status,progress_label,result,created_at,updated_at`);
  } else {
    jobs = await sbGet(`artist_name=eq.${encodeURIComponent(args.artist)}&order=created_at.desc&select=id,artist_name,status,progress_label,result,created_at,updated_at`);
  }

  if (!jobs.length) {
    console.log('No matching job rows found in catalog_enrichments_v1.');
    process.exit(0);
  }

  console.log(`Found ${jobs.length} job row(s):`);
  const candidates = [];
  for (const j of jobs) {
    const tracks = j.result?.totalTracks ?? '?';
    const hasMaster = !!j.result?.files?.master?.content;
    let enrichedCount = null;
    if (hasMaster) {
      try {
        enrichedCount = recoverTracksFromMasterCSV(j.result.files.master.content).filter(t => t.enriched).length;
      } catch (e) { /* leave null, will sort last */ }
    }
    console.log(`  - ${j.id}  artist="${j.artist_name}"  status=${j.status}  totalTracks=${tracks}  hasMasterCSV=${hasMaster}  enriched=${enrichedCount ?? '?'}  created=${j.created_at}`);
    if (j.status === 'DONE' && hasMaster) candidates.push({ job: j, enrichedCount: enrichedCount ?? -1 });
  }

  if (args.list) return;

  // Pick the candidate with the HIGHEST enriched-track count, not just the
  // most recent — historical runs vary wildly in quality (e.g. some Esham
  // runs only got 27/179 enriched while a later same-day run got 161/179).
  // Ties broken by recency (jobs[] is already ordered created_at.desc when
  // querying by --artist, so a stable sort preserves that as the tiebreak).
  candidates.sort((a, b) => b.enrichedCount - a.enrichedCount);
  const best = args.jobId ? { job: jobs[0] } : candidates[0];
  const target = best?.job;

  if (!target) {
    console.log('\nNo DONE job with a recoverable Master CSV found. Nothing to recover.');
    process.exit(0);
  }
  if (candidates.length > 1 && !args.jobId) {
    console.log(`\nPicked job ${target.id} (enriched=${best.enrichedCount}) over ${candidates.length - 1} other candidate(s) — highest enrichment quality.`);
  }
  if (!target.result?.files?.master?.content) {
    console.log(`\nJob ${target.id} has no Master CSV in result.files.master.content — nothing to recover from this row.`);
    process.exit(0);
  }

  console.log(`\nRecovering from job ${target.id} ("${target.artist_name}")…`);

  const recovered = recoverTracksFromMasterCSV(target.result.files.master.content);
  console.log(`Parsed ${recovered.length} track rows from Master CSV.`);

  if (!recovered.length) {
    console.log('Nothing to insert.');
    return;
  }

  const rows = recovered.map(t => ({
    ...toRow(t, { artistName: target.artist_name, artistMbid: target.result.mbid, jobId: target.id }),
    recovered_from_csv: true,
  }));

  const result = await upsertRows(rows, {
    onProgress: ({ persisted, total }) => console.log(`  saved ${persisted}/${total}…`),
  });

  console.log(`\nDone. Persisted ${result.persisted}/${rows.length}${result.failed ? `, ${result.failed} FAILED` : ''}.`);
  if (result.errors.length) {
    console.error('Errors:', JSON.stringify(result.errors, null, 2));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Recovery failed:', err.message);
  process.exit(1);
});
