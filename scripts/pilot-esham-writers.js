// scripts/pilot-esham-writers.js
// Production pilot: re-enrich a targeted Esham release subset and report before/after.
// Run: node scripts/pilot-esham-writers.js
// Does NOT call the full catalog — uses maxReleases=5 to cover the pilot set.

const PROD_BASE = 'https://musigod.com';
const ARTIST = 'Esham';
const MAX_RELEASES = 5;

// The 10 pilot tracks selected from the 18 known 0-writer records:
// "Judgement Day, Volume 3: Ascending" (7), "Judgement Day" (2), "Mail Dominance" (1 sample)
const PILOT_IDS = [
  '14ce4ed1-518c-47ba-9179-0876c064cb82', // Listen 2 a Deadman Speak  — Judgement Day Vol 3
  'c1b26d26-516d-4dc6-8327-1ac5bd0df618', // Memories of Abuse          — Judgement Day Vol 3
  'a1c1992e-5207-410c-8ff9-01c03a612692', // Original 24/7              — Judgement Day Vol 3
  'c209735d-c4da-4074-a06d-8306639c2a5f', // Pussycat                   — Judgement Day Vol 3
  '6beaedf4-0270-4754-81f0-a2a4141fd9b1', // Save the Drama 4 Ya Mama  — Judgement Day Vol 3
  'd5cac106-9bdf-4bfd-ad63-2b2462844aa6', // The Devil's in Da House    — Judgement Day Vol 3
  'db6d4c81-0597-47ed-bb6a-4b8c95b4c4ab', // Toejam                    — Judgement Day Vol 3
  '0b5803a2-96a9-4c0b-bd35-5a7b0f01aaf5', // Boogieman (intro)          — Judgement Day 2008
  'a8fe8490-da25-47df-9580-c07d65eeaaa9', // Momma Was a Junkie         — Judgement Day 2008
  '06b761ce-a9f8-4d6a-b7fa-7f5531c409cb', // California Dreamin          — Mail Dominance 1999
];

async function fetchTracks() {
  const r = await fetch(`${PROD_BASE}/api/get-enriched-tracks?artist_name=${encodeURIComponent(ARTIST)}&limit=1000`);
  if (!r.ok) throw new Error(`get-enriched-tracks ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.tracks || [];
}

function pickPilotRows(tracks) {
  const map = new Map(tracks.map(t => [t.id, t]));
  return PILOT_IDS.map(id => map.get(id)).filter(Boolean);
}

function summarizeTrack(t) {
  return {
    id: t.id,
    track_title: t.track_title,
    release_title: t.release_title,
    release_year: t.release_year,
    writers_count: (t.writers || []).length,
    writer_names: (t.writers || []).map(w => w.name || w).join('; ') || null,
    enriched: t.enriched,
    source: t.enrichment_source,
    error: t.enrichment_error,
  };
}

(async () => {
  console.log('=== Esham Writers Pilot ===');
  console.log(`Pilot tracks: ${PILOT_IDS.length}`);
  console.log(`Production base: ${PROD_BASE}`);
  console.log(`maxReleases: ${MAX_RELEASES}\n`);

  // ── BEFORE ────────────────────────────────────────────────────────────────
  console.log('--- BEFORE ---');
  const tracksBefore = await fetchTracks();
  const pilotBefore  = pickPilotRows(tracksBefore);

  const missingBefore = PILOT_IDS.filter(id => !pilotBefore.find(t => t.id === id));
  if (missingBefore.length) {
    console.warn(`⚠ ${missingBefore.length} pilot IDs not found in DB before enrichment.`);
  }

  pilotBefore.forEach(t => {
    const s = summarizeTrack(t);
    console.log(`  [${s.id.slice(0,8)}] "${s.track_title}" (${s.release_title}) writers=${s.writers_count} source=${s.source || 'none'}`);
  });

  const totalBefore     = tracksBefore.length;
  const zerosBefore     = tracksBefore.filter(t => !t.writers || t.writers.length === 0).length;
  const nonPilotBefore  = tracksBefore.filter(t => !PILOT_IDS.includes(t.id));

  console.log(`\nDB snapshot: ${totalBefore} total tracks, ${zerosBefore} with 0 writers`);

  // ── ENRICH ────────────────────────────────────────────────────────────────
  console.log(`\n--- ENRICH (POST /api/enrich-artist, maxReleases=${MAX_RELEASES}) ---`);
  const enrichStart = Date.now();
  const enrichRes = await fetch(`${PROD_BASE}/api/enrich-artist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artistName: ARTIST, maxReleases: MAX_RELEASES }),
  });
  const enrichMs = Date.now() - enrichStart;
  const enrichData = await enrichRes.json().catch(() => ({}));

  console.log(`HTTP ${enrichRes.status} — ${enrichMs}ms`);
  console.log('Response:', JSON.stringify(enrichData, null, 2));

  if (!enrichRes.ok) {
    console.error('Enrichment call failed. Aborting pilot.');
    process.exit(1);
  }

  // ── AFTER ─────────────────────────────────────────────────────────────────
  console.log('\n--- AFTER ---');
  const tracksAfter  = await fetchTracks();
  const pilotAfter   = pickPilotRows(tracksAfter);

  pilotAfter.forEach(t => {
    const s = summarizeTrack(t);
    const before = pilotBefore.find(b => b.id === t.id);
    const wBefore = before ? (before.writers || []).length : '?';
    const changed = wBefore !== s.writers_count ? ' ← CHANGED' : '';
    console.log(`  [${s.id.slice(0,8)}] "${s.track_title}" writers: ${wBefore} → ${s.writers_count}${changed}`);
    if (s.writer_names) console.log(`    Writers: ${s.writer_names} (source: ${s.source})`);
    if (s.error && s.writers_count === 0) console.log(`    Error: ${s.error}`);
  });

  // ── SIDE-EFFECT CHECK ─────────────────────────────────────────────────────
  console.log('\n--- SIDE-EFFECT CHECK (non-pilot tracks) ---');
  const nonPilotAfter = tracksAfter.filter(t => !PILOT_IDS.includes(t.id));
  let sideEffects = 0;
  nonPilotAfter.forEach(ta => {
    const tb = nonPilotBefore.find(b => b.id === ta.id);
    if (!tb) return; // new track added, not a modification
    const wBefore = (tb.writers || []).length;
    const wAfter  = (ta.writers || []).length;
    if (wBefore !== wAfter) {
      console.log(`  ⚠ SIDE EFFECT: [${ta.id.slice(0,8)}] "${ta.track_title}" writers: ${wBefore} → ${wAfter}`);
      sideEffects++;
    }
  });
  if (sideEffects === 0) console.log('  ✓ No unrelated catalog records changed.');

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  console.log('\n=== PILOT SUMMARY ===');
  const gained   = pilotAfter.filter(t => {
    const b = pilotBefore.find(b => b.id === t.id);
    return b && (b.writers||[]).length === 0 && (t.writers||[]).length > 0;
  });
  const stillZero = pilotAfter.filter(t => (t.writers||[]).length === 0);

  console.log(`Latency:          ${enrichMs}ms (${(enrichMs/1000).toFixed(1)}s)`);
  console.log(`Pilot tracks:     ${pilotAfter.length}/${PILOT_IDS.length} found in DB`);
  console.log(`Gained writers:   ${gained.length}`);
  console.log(`Still 0 writers:  ${stillZero.length}`);
  console.log(`Side effects:     ${sideEffects}`);
  console.log(`Tracks persisted: ${enrichData.tracksPersisted ?? 'unknown'}`);

  if (gained.length > 0) {
    console.log('\nGained:');
    gained.forEach(t => {
      const names = (t.writers||[]).map(w => w.name || w).join(', ');
      console.log(`  ✓ "${t.track_title}" → ${names} (${t.enrichment_source})`);
    });
  }

  if (stillZero.length > 0) {
    console.log('\nStill 0 writers (analysis needed):');
    stillZero.forEach(t => {
      console.log(`  ✗ [${t.id.slice(0,8)}] "${t.track_title}" (${t.release_title}) — ${t.enrichment_error || 'no error stored'}`);
    });
  }
})().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
