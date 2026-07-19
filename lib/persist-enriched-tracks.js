// lib/persist-enriched-tracks.js
// Persists the per-track output of enrichArtistCatalog() (lib/enrich-catalog.js)
// into catalog_enriched_tracks_v1. This is the step that was missing entirely
// from api/enrich-artist.js and api/run-enrichment-job.js — both only ever
// saved CSV-formatted output into a JSONB blob on the job row, never per-track
// rows. See supabase/migrations/20260619_catalog_enriched_tracks_v1.sql.

const { applyPolicy } = require('./writer-merge-policy');

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const CHUNK_SIZE = 200; // keep well under Vercel/PostgREST payload limits for large catalogs

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

// Pre-fetch current writer state for all tracks that have a recording_mbid.
// Returns a Map keyed by "<recording_mbid>|<lower(track_title)>" matching the
// dedup_key generated column in Postgres.
async function fetchExistingRows(artistName, recordingMbids) {
  if (!recordingMbids.length || !SB_KEY) return new Map();

  const BATCH = 100; // keep URL length manageable
  const allRows = [];

  for (let i = 0; i < recordingMbids.length; i += BATCH) {
    const batch = recordingMbids.slice(i, i + BATCH);
    const inClause = batch.map(id => `"${id}"`).join(',');
    const url =
      `${SB_URL}/rest/v1/catalog_enriched_tracks_v1` +
      `?artist_name=eq.${encodeURIComponent(artistName)}` +
      `&recording_mbid=in.(${inClause})` +
      `&select=recording_mbid,track_title,writers,enriched,enrichment_source`;

    try {
      const res = await fetch(url, {
        headers: {
          'apikey':        SB_KEY,
          'Authorization': `Bearer ${SB_KEY}`,
        },
      });
      if (res.ok) {
        const rows = await res.json();
        allRows.push(...rows);
      } else {
        const text = await res.text().catch(() => '');
        console.warn(`[persist] fetchExisting failed ${res.status}: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[persist] fetchExisting network error: ${err.message}`);
    }
  }

  // Index by the same compound key used in the dedup_key generated column
  const map = new Map();
  for (const row of allRows) {
    const key = `${row.recording_mbid}|${(row.track_title || '').toLowerCase()}`;
    map.set(key, row);
  }
  return map;
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

// Persists every track in enrichedTracks[]. Applies the governed merge policy
// (lib/writer-merge-policy.js) before upserting so that existing writer evidence
// is never silently destroyed by a failed/skipped/no-match source run.
//
// Options:
//   artistName   — required
//   artistMbid   — optional
//   jobId        — optional
//   onProgress   — optional callback({ persisted, total })
//   scopeReleases — optional string[]; if set, only tracks whose release_title is in this
//                   list are persisted. Other tracks in enrichedTracks are silently skipped.
//
// Returns { persisted, failed, errors, conflicts, policyStats }.
// Never throws — persistence failures are collected and returned.
async function persistEnrichedTracks(enrichedTracks, {
  artistName, artistMbid, jobId, onProgress = null, scopeReleases = null,
} = {}) {
  if (!Array.isArray(enrichedTracks) || !enrichedTracks.length) {
    return { persisted: 0, failed: 0, errors: [], conflicts: [], policyStats: {} };
  }

  // Scope filter: if scopeReleases is specified, only persist matching tracks.
  let tracks = enrichedTracks;
  if (Array.isArray(scopeReleases) && scopeReleases.length > 0) {
    const scopeSet = new Set(scopeReleases.map(r => r.toLowerCase()));
    tracks = enrichedTracks.filter(t => scopeSet.has((t.releaseTitle || '').toLowerCase()));
    const skipped = enrichedTracks.length - tracks.length;
    if (skipped > 0) {
      console.log(`[persist-enriched-tracks] scope filter: ${tracks.length} in scope, ${skipped} skipped`);
    }
  }

  // Shape all incoming tracks into DB rows.
  const rawRows = tracks.map(t => toRow(t, { artistName, artistMbid, jobId }));

  // Pre-fetch existing writer state for tracks with a recording_mbid (these are
  // the rows the dedup_key constraint can match). Tracks without a recording_mbid
  // have a NULL dedup_key and will always INSERT without conflict.
  const mbids = [...new Set(rawRows.map(r => r.recording_mbid).filter(Boolean))];
  let existingMap = new Map();
  try {
    existingMap = await fetchExistingRows(artistName, mbids);
  } catch (err) {
    console.warn(`[persist-enriched-tracks] fetchExisting threw, falling back to overwrite: ${err.message}`);
  }

  // Apply the provenance-aware merge policy to each row.
  const policyStats = { INSERT: 0, UPGRADE: 0, MERGE: 0, IDEMPOTENT: 0, KEEP_EXISTING: 0, UPDATE_META: 0, CONFLICT: 0 };
  const conflicts = [];
  const finalRows = rawRows.map(row => {
    let existingRow = null;
    if (row.recording_mbid) {
      const lookupKey = `${row.recording_mbid}|${(row.track_title || '').toLowerCase()}`;
      existingRow = existingMap.get(lookupKey) || null;
    }
    const { action, row: mergedRow, conflict } = applyPolicy(row, existingRow);
    policyStats[action] = (policyStats[action] || 0) + 1;
    if (action === 'KEEP_EXISTING') {
      console.log(`[merge] KEEP_EXISTING "${row.track_title}" — existing writers preserved (new run: ${row.enrichment_error || 'no error'})`);
    } else if (action === 'CONFLICT') {
      console.warn(`[merge] CONFLICT "${row.track_title}" — incoming contradicts existing; kept existing. Will remove: ${conflict.wouldRemove.map(w => w.name).join(', ')}`);
      conflicts.push(conflict);
    } else if (action === 'MERGE') {
      console.log(`[merge] MERGE "${row.track_title}" — added ${mergedRow.writers.length - (existingRow?.writers?.length || 0)} writer(s)`);
    }
    return mergedRow;
  });

  const result = await upsertRows(finalRows, { onProgress });

  console.log(
    `[persist-enriched-tracks] ${artistName}: ${result.persisted}/${finalRows.length} persisted` +
    (result.failed ? `, ${result.failed} failed` : '') +
    ` | policy: ${JSON.stringify(policyStats)}` +
    (conflicts.length ? ` | ${conflicts.length} conflict(s) flagged` : '')
  );

  return { ...result, conflicts, policyStats };
}

module.exports = { persistEnrichedTracks, upsertRows, toRow, fetchExistingRows };
