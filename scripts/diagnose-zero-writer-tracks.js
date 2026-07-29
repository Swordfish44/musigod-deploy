'use strict';
// scripts/diagnose-zero-writer-tracks.js
//
// Diagnostic for the 8 Esham tracks currently missing writer data.
// Instruction source: MUSIGOD_NEXT_DIAGNOSTIC.md
//
// What this script does (all read-only — zero DB writes):
//   [1] Identifies the 8 zero-writer tracks with full detail
//   [2] Checks all stored enrichment job results for prior writer data
//   [3] Calls Genius API (read-only) with fuzzy/normalized title matching,
//       exact artist validation, album corroboration, confidence scoring
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

// Load .env.local before any process.env reads.
require('dotenv').config({
  path: require('path').resolve(__dirname, '..', '.env.local'),
  override: false,
});

// NOTE: we do NOT use lib/genius.js here. The production library does exact-
// title matching; this diagnostic implements fuzzy matching with confidence
// scoring independently so the production code is not changed.

const SB_URL       = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY       = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const GENIUS_TOKEN = process.env.GENIUS_ACCESS_TOKEN || '';
const HAS_GENIUS   = !!GENIUS_TOKEN;

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

// ── CSV parser ────────────────────────────────────────────────────────────────
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

// ── Genius fuzzy-search helpers ───────────────────────────────────────────────

// Strip non-alphanumeric and lowercase.
const normTitle = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Collapse consecutive repeated characters: "skkkk" → "sk", "ll" → "l".
// This makes "helterskkkellter" and "hellterskkkelter" both reduce to
// "helterskelter", catching intentional misspelling variants in artist names.
const collapseRepeats = s => s.replace(/(.)\1+/g, '$1');

function titleVariants(title) {
  const n = normTitle(title);
  const c = collapseRepeats(n);
  return [...new Set([n, c])];
}

function confidenceRank(c) {
  return { EXACT: 3, NORMALIZED: 2, SUBSTRING: 1 }[c] || 0;
}

async function geniusGet(path) {
  const res = await fetch(`https://api.genius.com${path}`, {
    headers: {
      Authorization: `Bearer ${GENIUS_TOKEN}`,
      'User-Agent': 'MusiGod-Diagnostic/1.0 +https://musigod.com',
    },
  });
  if (!res.ok) throw new Error(`Genius HTTP ${res.status}: ${path}`);
  return res.json();
}

// Search Genius with multiple title variants and return a scored match or null.
// Never writes to any database. All calls are GET requests to the Genius API.
//
// Returns:
//   null — no validated match found
//   { songId, writers, confidence, matchNote, geniusTitle, geniusArtist,
//     geniusAlbum, geniusUrl, albumCorroborated, albumNote, searchQuery }
//
// confidence levels:
//   EXACT      — norm(geniusTitle) === norm(trackTitle)
//   NORMALIZED — collapsed-repeat forms match
//   SUBSTRING  — one normalized form contains the other (≥5 chars)
async function searchGeniusFuzzy(trackTitle, releaseTitle) {
  const ARTIST = 'Esham';
  const artistNorm = normTitle(ARTIST);
  const trackVariants = titleVariants(trackTitle);

  // Queries tried in order — first hit with valid artist+title wins.
  const queries = [
    `${ARTIST} ${trackTitle}`,
    `${ARTIST} ${collapseRepeats(normTitle(trackTitle))}`,
  ];
  if (releaseTitle) queries.push(`${ARTIST} ${releaseTitle}`);

  const tried = new Set();
  let bestHit = null;    // { r (hit result), confidence, matchNote, query }
  let allRawHits = [];   // for "not found" reporting

  for (const q of queries) {
    if (tried.has(q)) continue;
    tried.add(q);

    const data = await geniusGet(`/search?q=${encodeURIComponent(q)}`);
    const hits = (data.response?.hits || []).filter(h => h.type === 'song');

    // Collect for raw-hit reporting
    for (const h of hits) allRawHits.push({ ...h.result, _query: q });

    for (const h of hits) {
      const r = h.result;

      // Artist guard: primary artist must include "esham"
      const hitArtistNorm = normTitle(r.primary_artist?.name || '');
      if (!hitArtistNorm.includes(artistNorm)) continue;

      const hitVariants = titleVariants(r.title || '');
      let confidence = null;
      let matchNote = '';

      if (normTitle(r.title) === normTitle(trackTitle)) {
        confidence = 'EXACT';
      } else if (trackVariants.some(tv => hitVariants.some(hv => tv === hv))) {
        confidence = 'NORMALIZED';
        const tv = collapseRepeats(normTitle(trackTitle));
        const hv = collapseRepeats(normTitle(r.title));
        matchNote = `collapsed "${normTitle(trackTitle)}" → "${tv}" matches Genius "${normTitle(r.title)}" → "${hv}"`;
      } else {
        const minLen = 5;
        const subMatch = trackVariants.some(tv =>
          hitVariants.some(hv => (hv.includes(tv) || tv.includes(hv)) && tv.length >= minLen)
        );
        if (subMatch) {
          confidence = 'SUBSTRING';
          matchNote = `"${r.title}" substring overlap with "${trackTitle}"`;
        }
      }

      if (!confidence) continue;

      if (!bestHit || confidenceRank(confidence) > confidenceRank(bestHit.confidence)) {
        bestHit = { r, confidence, matchNote, query: q };
        if (confidence === 'EXACT') break;
      }
    }
    if (bestHit?.confidence === 'EXACT') break;
  }

  if (!bestHit) {
    // Surface top Esham hits for debugging
    const eshamHits = allRawHits.filter(r => normTitle(r.primary_artist?.name || '').includes('esham'));
    return { found: false, topHits: eshamHits.slice(0, 3) };
  }

  // Fetch full song detail for writers + album name
  const { r, confidence, matchNote, query } = bestHit;
  const detail = await geniusGet(`/songs/${r.id}`);
  const song = detail.response?.song || {};

  const writers = (song.writer_artists || []).map(a => ({
    name: a.name, role: 'writer', source: 'genius',
  }));

  // Album corroboration
  const geniusAlbum = song.album?.name || null;
  const albumVariants = geniusAlbum ? titleVariants(geniusAlbum) : [];
  const releaseVariants = releaseTitle ? titleVariants(releaseTitle) : [];
  const albumCorroborated = !!(geniusAlbum && releaseTitle &&
    albumVariants.some(av => releaseVariants.some(rv =>
      av === rv || av.includes(rv) || rv.includes(av)
    ))
  );
  const albumNote = geniusAlbum
    ? `Genius album: "${geniusAlbum}"${albumCorroborated ? ' ✅ matches release' : ' ⚠️ differs from our release title'}`
    : 'no album listed on Genius';

  return {
    found: true,
    songId: r.id,
    writers,
    confidence,
    matchNote,
    geniusTitle: song.title || r.title,
    geniusArtist: song.primary_artist?.name || r.primary_artist?.name,
    geniusAlbum,
    geniusUrl: song.url || r.url,
    albumCorroborated,
    albumNote,
    searchQuery: query,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('════ Esham Zero-Writer Track Diagnostic (read-only) ════');
  console.log(`Target:       ${SB_URL}`);
  console.log(`Auth:         ${IS_JWT ? 'JWT' : 'opaque key'}`);
  console.log(`Genius:       ${HAS_GENIUS ? 'token present — fuzzy dry run active' : 'no token — Genius dry run skipped'}`);
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

  const priorWritersByKey = new Map();

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

  // ── [3] Genius fuzzy dry run ──────────────────────────────────────────────
  console.log('');
  console.log('━━━ [3] Genius dry run — fuzzy/normalized title matching ━━━━━');
  console.log('    Strategy: exact → collapsed-repeats → release-title fallback');
  console.log('    Artist guard: primary_artist must include "esham"');
  console.log('    Album corroboration: Genius album vs our release_title');
  console.log('');

  if (!HAS_GENIUS) {
    console.log('  ⚠️  GENIUS_ACCESS_TOKEN not set — skipping live Genius calls');
    console.log('     Add to .env.local: GENIUS_ACCESS_TOKEN=your_token');
    return;
  }

  const geniusResults = [];

  for (const t of zeroWriterRows) {
    process.stdout.write(`  Querying: "${t.track_title}" (${t.release_title})…\n`);

    try {
      const result = await searchGeniusFuzzy(t.track_title, t.release_title);

      if (result.found) {
        const confLabel = { EXACT: '✅ EXACT', NORMALIZED: '🔶 NORMALIZED', SUBSTRING: '🔷 SUBSTRING' }[result.confidence] || result.confidence;
        console.log(`    ${confLabel} match — "${result.geniusTitle}" by ${result.geniusArtist}`);
        if (result.matchNote) console.log(`    Match note:  ${result.matchNote}`);
        console.log(`    ${result.albumNote}`);
        console.log(`    Writers:     ${result.writers.length ? result.writers.map(w => w.name).join(', ') : '(none listed on Genius)'}`);
        console.log(`    Evidence:    ${result.geniusUrl}`);
        if (!result.albumCorroborated && result.geniusAlbum) {
          console.log(`    ⚠️  Album mismatch — verify this is the correct recording before applying`);
        }
        geniusResults.push({ track: t, ...result });
      } else {
        console.log(`    ❌ Not found after all variants`);
        if (result.topHits?.length) {
          console.log(`    Top Esham hits returned by Genius (for manual review):`);
          result.topHits.forEach(h => {
            console.log(`      • "${h.title}" — ${h.url}`);
          });
        } else {
          console.log(`    No Esham results returned by any search query`);
        }
        geniusResults.push({ track: t, found: false });
      }
    } catch (err) {
      console.log(`    ERROR — ${err.message.slice(0, 100)}`);
      geniusResults.push({ track: t, found: false, error: err.message });
    }
    console.log('');
  }

  // ── [4] Graph sync gap ───────────────────────────────────────────────────
  console.log('━━━ [4] Graph sync gap ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const allEsham = await sbGet(
    'catalog_enriched_tracks_v1',
    `artist_name=ilike.*sham*&select=id&limit=1000`
  );
  const eshamIds = allEsham.map(r => r.id);
  const totalTracks = eshamIds.length;

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

  const linkedByRole = {};
  for (const l of graphLinks) linkedByRole[l.node_role] = (linkedByRole[l.node_role] || 0) + 1;

  const linkedBy = {};
  for (const l of graphLinks) linkedBy[l.linked_by] = (linkedBy[l.linked_by] || 0) + 1;

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
  console.log('  Root cause: enrichment pipeline calls rpc_upsert_recording_enrichment()');
  console.log('  (→ graph.nodes + works.recordings) while graph_catalog_links_v1 requires');
  console.log('  fn_sync_track_to_graph() / fn_backfill_catalog_to_graph().');
  console.log(`  Fix: SELECT fn_backfill_catalog_to_graph() in SQL Editor (idempotent).`);

  // ── [5] Resolution summary ────────────────────────────────────────────────
  console.log('');
  console.log('━━━ [5] Resolution plan — dry-run proposed changes ━━━━━━━━━━━');
  console.log('');

  const autoFromPrior  = recoverable;
  const geniusFound    = geniusResults.filter(g => g.found);
  const geniusNotPrior = geniusFound.filter(g => !recoverable.some(r => r.track.id === g.track.id));
  const needsManual    = zeroWriterRows.filter(t =>
    !recoverable.some(r => r.track.id === t.id) &&
    !geniusFound.some(g => g.track.id === t.id)
  );

  if (autoFromPrior.length) {
    console.log(`  ✅ AUTO-RESOLVABLE from prior enrichment CSV (${autoFromPrior.length} track(s)):`);
    for (const { track, prior } of autoFromPrior) {
      const g = geniusFound.find(g => g.track.id === track.id);
      console.log(`\n     "${track.track_title}" (${track.release_title})`);
      console.log(`       ID:      ${track.id}`);
      console.log(`       Writers: ${prior.writers.map(w => w.name).join(', ')}`);
      if (g) {
        const agree = g.writers.every(gw => prior.writers.some(pw =>
          pw.name.toLowerCase() === gw.name.toLowerCase()
        ));
        console.log(`       Genius:  ${g.writers.map(w => w.name).join(', ')} [conf: ${g.confidence}]${agree ? ' ✅ agrees' : ' ⚠️ DIFFERS — review'}`);
        console.log(`       URL:     ${g.geniusUrl}`);
      }
    }
    console.log('');
  }

  if (geniusNotPrior.length) {
    console.log(`  🎵 AUTO-RESOLVABLE from Genius only (${geniusNotPrior.length} track(s)):`);
    for (const g of geniusNotPrior) {
      console.log(`\n     "${g.track.track_title}" (${g.track.release_title})`);
      console.log(`       ID:         ${g.track.id}`);
      console.log(`       Confidence: ${g.confidence}${g.matchNote ? ' — ' + g.matchNote : ''}`);
      console.log(`       Writers:    ${g.writers.length ? g.writers.map(w => w.name).join(', ') : '(none listed)'}`);
      console.log(`       ${g.albumNote}`);
      console.log(`       URL:        ${g.geniusUrl}`);
      if (!g.albumCorroborated) {
        console.log(`       ⚠️  Album not corroborated — manual verification required before applying`);
      }
    }
    console.log('');
  }

  if (needsManual.length) {
    console.log(`  ⚠️  NEEDS MANUAL RESEARCH (${needsManual.length} track(s)):`);
    for (const t of needsManual) {
      console.log(`\n     "${t.track_title}" (${t.release_title})`);
      console.log(`       ID:    ${t.id}`);
      console.log(`       MBID:  ${t.recording_mbid || 'none'}`);
      console.log(`       ISRCs: ${(t.isrcs || []).join(', ') || 'none'}`);
    }
    console.log('');
    console.log('     Manual research paths:');
    console.log('     1. MusicBrainz: look up recording by MBID; check linked work + writer-rels');
    console.log('     2. Discogs: search artist + release title for credits');
    console.log('     3. BMI/ASCAP public repertoire search by ISRC or title');
    console.log('     4. lib/overrides.js: add confirmed credits manually');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('');
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`Zero-writer tracks:             ${zeroWriterRows.length}`);
  console.log(`Auto-resolvable (prior CSV):    ${autoFromPrior.length}`);
  console.log(`Auto-resolvable (Genius):       ${geniusNotPrior.length}`);
  const exactCount      = geniusFound.filter(g => g.confidence === 'EXACT').length;
  const normalizedCount = geniusFound.filter(g => g.confidence === 'NORMALIZED').length;
  const substringCount  = geniusFound.filter(g => g.confidence === 'SUBSTRING').length;
  if (geniusFound.length) {
    console.log(`  Genius confidence breakdown:`);
    if (exactCount)      console.log(`    EXACT:      ${exactCount}`);
    if (normalizedCount) console.log(`    NORMALIZED: ${normalizedCount}`);
    if (substringCount)  console.log(`    SUBSTRING:  ${substringCount}`);
  }
  console.log(`Needs manual research:          ${needsManual.length}`);
  console.log(`Graph link gap:                 ${gap} of ${totalTracks} tracks unlinked`);
  console.log('');
  console.log('Zero DB writes made. All Genius calls were read-only API searches.');
  console.log('To apply proposed changes: add confirmed credits to lib/overrides.js');
  console.log('(for Genius results, verify album corroboration first).');
}

main().catch(err => {
  console.error('Uncaught error:', err.message);
  process.exit(1);
});
