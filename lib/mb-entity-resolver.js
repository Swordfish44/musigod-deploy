'use strict';
// lib/mb-entity-resolver.js
// Entity resolution: find MB staging candidates for MusiGod enriched tracks.
//
// Confidence tiers:
//   1.000 — ISRC exact match (gold: sound recording identity)
//   1.000 — MBID direct (MBID already known in enriched track)
//   0.950 — ISWC exact match (gold: composition identity)
//   0.700–0.890 — Name trigram fuzzy + duration bonus (must be human-reviewed)
//
// Corpus lookups → external PostgreSQL (MUSICBRAINZ_DATABASE_URL) via mb-corpus-db.
// Entity match writes → Supabase via fn_mb_upsert_entity_matches RPC.
//
// Isolation: if the corpus DB is unavailable, lookups return empty and no
// candidates are produced. entity_matches_v1 writes (Supabase) are unaffected.
// Recording and work entities are NEVER conflated.

const corpusDb           = require('./mb-corpus-db');
const { upsertEntityMatches } = require('./mb-staging-writer');

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';

function sbKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
}

// ─── String utilities ─────────────────────────────────────────────────────────

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function titleSimilarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  if (na.length < 3 || nb.length < 3) {
    const shorter = na.length < nb.length ? na : nb;
    const longer  = na.length < nb.length ? nb : na;
    let matches = 0;
    for (const ch of shorter) if (longer.includes(ch)) matches++;
    return matches / longer.length;
  }
  const tA = new Set();
  const tB = new Set();
  for (let i = 0; i <= na.length - 3; i++) tA.add(na.slice(i, i + 3));
  for (let i = 0; i <= nb.length - 3; i++) tB.add(nb.slice(i, i + 3));
  let intersection = 0;
  for (const t of tA) if (tB.has(t)) intersection++;
  const union = tA.size + tB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ─── Corpus DB lookups ────────────────────────────────────────────────────────
// Direct SQL against external PostgreSQL corpus DB (mb_staging schema).

async function corpusLookupISRC(isrc) {
  const { rows } = await corpusDb.query(
    'SELECT mb_recording_id FROM mb_staging.isrcs_v1 WHERE isrc = $1',
    [isrc]
  );
  return rows;
}

async function corpusLookupRecordingMbid(mbid) {
  const { rows } = await corpusDb.query(
    'SELECT mb_recording_id FROM mb_staging.recordings_v1 WHERE mb_recording_id = $1',
    [mbid]
  );
  return rows;
}

async function corpusLookupISWC(iswc) {
  const { rows } = await corpusDb.query(
    'SELECT mb_work_id FROM mb_staging.iswcs_v1 WHERE iswc = $1',
    [iswc]
  );
  return rows;
}

async function corpusSearchRecordings(titlePrefix) {
  const { rows } = await corpusDb.query(
    'SELECT mb_recording_id, title, length_ms FROM mb_staging.recordings_v1 WHERE title ILIKE $1 LIMIT 50',
    [titlePrefix + '%']
  );
  return rows;
}

// ─── Core resolution ─────────────────────────────────────────────────────────

async function resolveTrack(track) {
  const candidates = [];
  const seen = new Map();

  function addCandidate(c) {
    const key = `${c.mb_entity_type}:${c.mb_entity_id}`;
    if (!seen.has(key) || seen.get(key) < c.confidence) {
      seen.set(key, c.confidence);
      const idx = candidates.findIndex(x => `${x.mb_entity_type}:${x.mb_entity_id}` === key);
      if (idx >= 0) candidates.splice(idx, 1);
      candidates.push(c);
    }
  }

  // 1. ISRC exact match — confidence 1.0
  for (const isrc of (track.isrcs || [])) {
    if (!isrc) continue;
    const norm = isrc.toUpperCase().replace(/[-\s]/g, '');
    let rows;
    try {
      rows = await corpusLookupISRC(norm);
    } catch (e) {
      console.warn(`[mb-resolver] ISRC lookup failed for ${norm}: ${e.message}`);
      continue;
    }
    for (const row of rows) {
      addCandidate({
        mb_entity_type:      'recording',
        mb_entity_id:        row.mb_recording_id,
        musigod_entity_type: 'enriched_track',
        musigod_entity_id:   String(track.id),
        match_method:        'isrc_exact',
        confidence:          1.0,
        match_signals:       { isrc: norm, isrc_match: true },
      });
    }
  }

  // 2. MBID direct match — confidence 1.0
  if (track.recording_mbid) {
    let rows;
    try {
      rows = await corpusLookupRecordingMbid(track.recording_mbid);
    } catch (e) {
      console.warn(`[mb-resolver] MBID lookup failed: ${e.message}`);
      rows = [];
    }
    if (rows.length > 0) {
      addCandidate({
        mb_entity_type:      'recording',
        mb_entity_id:        track.recording_mbid,
        musigod_entity_type: 'enriched_track',
        musigod_entity_id:   String(track.id),
        match_method:        'mbid_direct',
        confidence:          1.0,
        match_signals:       { recording_mbid: track.recording_mbid, mbid_match: true },
      });
    }
  }

  // 3. ISWC exact match — confidence 0.95
  if (track.iswc) {
    let rows;
    try {
      rows = await corpusLookupISWC(track.iswc);
    } catch (e) {
      console.warn(`[mb-resolver] ISWC lookup failed: ${e.message}`);
      rows = [];
    }
    for (const row of rows) {
      addCandidate({
        mb_entity_type:      'work',
        mb_entity_id:        row.mb_work_id,
        musigod_entity_type: 'enriched_track',
        musigod_entity_id:   String(track.id),
        match_method:        'iswc_exact',
        confidence:          0.95,
        match_signals:       { iswc: track.iswc, iswc_match: true },
      });
    }
  }

  // 4. Fuzzy name match — only if no high-confidence identifiers found
  const hasHighConfidenceMatch = candidates.some(c => c.confidence >= 0.95);
  if (!hasHighConfidenceMatch && track.track_title) {
    const normTitle = normalize(track.track_title);
    if (normTitle.length >= 3) {
      let rows = [];
      try {
        rows = await corpusSearchRecordings(track.track_title.slice(0, 30));
      } catch (e) {
        console.warn(`[mb-resolver] title search failed: ${e.message}`);
      }

      for (const rec of rows) {
        const sim = titleSimilarity(track.track_title, rec.title);
        if (sim < 0.7) continue;

        let confidence = 0.45 + sim * 0.4;
        const signals = { title_similarity: parseFloat(sim.toFixed(3)) };

        const trackMs = track.track_duration ? track.track_duration * 1000 : null;
        if (trackMs && rec.length_ms) {
          const diff = Math.abs(trackMs - parseInt(rec.length_ms, 10));
          if (diff <= 2000) {
            confidence += 0.05;
            signals.duration_match = true;
            signals.duration_diff_ms = diff;
          }
        }

        confidence = Math.min(0.89, parseFloat(confidence.toFixed(3)));

        addCandidate({
          mb_entity_type:      'recording',
          mb_entity_id:        rec.mb_recording_id,
          musigod_entity_type: 'enriched_track',
          musigod_entity_id:   String(track.id),
          match_method:        'name_fuzzy',
          confidence,
          match_signals:       signals,
        });
      }
    }
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

async function persistCandidates(candidates, dryRun = false) {
  if (!candidates.length) return 0;
  return upsertEntityMatches(
    candidates.map(c => ({
      ...c,
      review_status: 'pending',
      promoted:      false,
    })),
    dryRun,
  );
}

// Load enriched tracks from Supabase (public schema — no profile headers needed).
async function loadEnrichedTracks(artistName = null) {
  const SB_KEY = sbKey();
  let params = 'select=id,artist_name,track_title,recording_mbid,isrcs,iswc,track_duration&limit=1000';
  if (artistName) params += `&artist_name=ilike.${encodeURIComponent('%' + artistName + '%')}`;

  const res = await fetch(`${SB_URL}/rest/v1/catalog_enriched_tracks_v1?${params}`, {
    headers: {
      apikey:        SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`loadEnrichedTracks: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

async function resolveAllTracks({ artistName = null, dryRun = false, onProgress = null } = {}) {
  const tracks = await loadEnrichedTracks(artistName);
  console.log(`[mb-resolver] Resolving ${tracks.length} enriched tracks…`);

  let totalCandidates = 0;
  let totalTracks = 0;

  for (const track of tracks) {
    totalTracks++;
    if (onProgress) onProgress({ current: totalTracks, total: tracks.length, track: track.track_title });

    try {
      const candidates = await resolveTrack(track);
      if (candidates.length) {
        await persistCandidates(candidates, dryRun);
        totalCandidates += candidates.length;
        console.log(`[mb-resolver] "${track.track_title}" → ${candidates.length} candidates (best: ${candidates[0]?.confidence} via ${candidates[0]?.match_method})`);
      }
    } catch (err) {
      console.warn(`[mb-resolver] "${track.track_title}" resolve failed: ${err.message}`);
    }
  }

  console.log(`[mb-resolver] Done: ${totalTracks} tracks → ${totalCandidates} candidates written`);
  return { totalTracks, totalCandidates };
}

module.exports = { resolveTrack, resolveAllTracks, persistCandidates, titleSimilarity, normalize };
