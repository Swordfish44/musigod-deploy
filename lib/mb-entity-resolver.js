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
// Identifier matches outrank all text-based matches.
// Recording and work entities are NEVER conflated — they remain distinct types.
//
// Usage:
//   const { resolveTrack, resolveAllTracks } = require('./mb-entity-resolver');
//   const candidates = await resolveTrack(enrichedTrack);
//   // candidates: array sorted by confidence desc, written to entity_matches_v1

const { upsertEntityMatches } = require('./mb-staging-writer');

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';

function key() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
}

// ─── String utilities ─────────────────────────────────────────────────────────

// Normalize for comparison: lowercase, strip non-alphanumeric
function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Jaccard similarity on character 3-grams — robust to word-order variation
function titleSimilarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  if (na.length < 3 || nb.length < 3) {
    // Too short for trigrams — fall back to character overlap ratio
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

// ─── MB staging lookup helpers ────────────────────────────────────────────────

async function mbGet(table, params, schema = 'mb_staging') {
  const url = `${SB_URL}/rest/v1/${table}?${params}&limit=25`;
  const res = await fetch(url, {
    headers: {
      apikey:           key(),
      Authorization:    `Bearer ${key()}`,
      'Accept-Profile': schema,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`mb-entity-resolver GET ${table}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

// ─── Core resolution ─────────────────────────────────────────────────────────

// Resolve a single MusiGod enriched track against mb_staging.
// Returns an array of match candidates sorted by confidence desc.
// Does NOT write to DB — caller decides whether to persist via persistCandidates().
async function resolveTrack(track) {
  const candidates = [];
  const seen = new Map();

  function addCandidate(c) {
    const key = `${c.mb_entity_type}:${c.mb_entity_id}`;
    if (!seen.has(key) || seen.get(key) < c.confidence) {
      seen.set(key, c.confidence);
      // Remove earlier lower-confidence entry for same MB entity
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
      rows = await mbGet('isrcs_v1', `isrc=eq.${encodeURIComponent(norm)}&select=mb_recording_id`);
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
      rows = await mbGet(
        'recordings_v1',
        `mb_recording_id=eq.${encodeURIComponent(track.recording_mbid)}&select=mb_recording_id`,
      );
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
      rows = await mbGet('iswcs_v1', `iswc=eq.${encodeURIComponent(track.iswc)}&select=mb_work_id`);
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
      // Prefix search on title — ilike avoids full-scan on small staging sets
      const prefix = track.track_title.slice(0, 30).replace(/'/g, "''");
      let rows = [];
      try {
        rows = await mbGet(
          'recordings_v1',
          `title=ilike.${encodeURIComponent('%' + prefix + '%')}&select=mb_recording_id,title,length_ms,mb_artist_id`,
        );
      } catch (e) {
        console.warn(`[mb-resolver] title search failed: ${e.message}`);
      }

      for (const rec of rows) {
        const sim = titleSimilarity(track.track_title, rec.title);
        if (sim < 0.7) continue;

        let confidence = 0.45 + sim * 0.4;  // 0.45..0.85 range
        const signals = { title_similarity: parseFloat(sim.toFixed(3)) };

        // Duration bonus: +0.05 if within 2 seconds
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

// Persist candidates to mb_staging.entity_matches_v1.
// Existing rows are upserted — same (mb_entity_id, musigod_entity_id) pair updates confidence.
async function persistCandidates(candidates, dryRun = false) {
  if (!candidates.length) return 0;
  return upsertEntityMatches(
    candidates.map(c => ({
      ...c,
      review_status: c.confidence >= 0.95 ? 'pending' : 'pending',
      promoted:      false,
    })),
    dryRun,
  );
}

// Load all enriched tracks for resolution (optionally filter by artist)
async function loadEnrichedTracks(artistName = null) {
  const SB_KEY = key();
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

// Resolve all enriched tracks and write candidates to entity_matches_v1.
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
