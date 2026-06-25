// lib/persist-enriched-tracks.js
// Persists the per-track output of enrichArtistCatalog() (lib/enrich-catalog.js)
// into catalog_enriched_tracks_v1. This is the step that was missing entirely
// from api/enrich-artist.js and api/run-enrichment-job.js — both only ever
// saved CSV-formatted output into a JSONB blob on the job row, never per-track
// rows. See supabase/migrations/20260619_catalog_enriched_tracks_v1.sql.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const CHUNK_SIZE = 200; // keep well under Vercel/PostgREST payload limits for large catalogs (e.g. 337-work runs)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toRow(track, { artistName, artistMbid, jobId }) {
  return {
    job_id:             jobId || null,
    artist_name:        artistName,
    artist_mbid:        artistMbid || null,
    release_title:      track.releaseTitle || null,
    release_year:       track.releaseYear || null,
    release_type:       track.releaseType || null,
    release_mbid:       track.releaseMBID || null,
    release_group_mbid: track.releaseGroupMBID || null,
    track_number:       track.trackNumber || null,
    track_title:        track.trackTitle || '(untitled)',
    track_duration:     track.trackDuration || null,
    recording_mbid:     track.recordingMBID || null,
    isrcs:              track.isrcs || [],
    iswc:               track.iswc || null,
    writers:            track.writers || [],
    artist_credits:     track.artistCredits || [],
    enriched:           !!track.enriched,
    enrichment_source:  track.enrichmentSource || null,
    enrichment_error:   track.enrichmentError || null,
    recovered_from_csv: false,
  };
}

// Upsert one chunk via PostgREST on_conflict=dedup_key (merge-duplicates).
// dedup_key is a generated column (lower(artist_name)|recording_mbid|lower(track_title))
// so re-running enrichment for the same artist updates existing rows instead of
// creating duplicates.
async function upsertChunk(rows) {
  const res = await fetch(`${SB_URL}/rest/v1/catalog_enriched_tracks_v1?on_conflict=dedup_key`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Prefer':        'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`catalog_enriched_tracks_v1 upsert failed: ${res.status} — ${text.slice(0, 400)}`);
  }
  return res.json();
}

// Upsert an arbitrary set of already-shaped rows (chunked). Shared by both
// the live persistence path and the historical recovery script.
async function upsertRows(rows, { onProgress = null } = {}) {
  if (!SB_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
  if (!Array.isArray(rows) || !rows.length) {
    return { persisted: 0, failed: 0, errors: [] };
  }

  let persisted = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    try {
      const result = await upsertChunk(chunk);
      persisted += result.length;
    } catch (err) {
      console.error(`[persist-enriched-tracks] chunk ${i}-${i + chunk.length} failed: ${err.message}`);
      errors.push({ chunkStart: i, chunkSize: chunk.length, message: err.message });
    }
    if (onProgress) await onProgress({ persisted, total: rows.length });
    await sleep(50); // small spacing to avoid hammering PostgREST on big catalogs
  }

  const failed = rows.length - persisted;
  return { persisted, failed, errors };
}

// Persists every track in enrichedTracks[]. Returns { persisted, failed, errors }.
// Never throws — a persistence failure should not blow up the enrichment job
// after MusicBrainz/Discogs/Genius calls already succeeded. Errors are
// collected and returned so the caller can log/patch job status accordingly.
async function persistEnrichedTracks(enrichedTracks, { artistName, artistMbid, jobId, onProgress = null }) {
  if (!Array.isArray(enrichedTracks) || !enrichedTracks.length) {
    return { persisted: 0, failed: 0, errors: [] };
  }

  const rows = enrichedTracks.map(t => toRow(t, { artistName, artistMbid, jobId }));
  const result = await upsertRows(rows, { onProgress });

  console.log(`[persist-enriched-tracks] ${artistName}: ${result.persisted}/${rows.length} persisted${result.failed ? `, ${result.failed} failed` : ''}`);

  return result;
}

module.exports = { persistEnrichedTracks, upsertRows, toRow };
