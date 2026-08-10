'use strict';
// lib/mb-staging-writer.js
// Batch write helpers for mb_staging tables.
//
// Uses public-schema SECURITY DEFINER RPC wrappers (fn_mb_upsert_*) rather than
// direct Accept-Profile: mb_staging calls. This avoids dependence on the
// PostgREST "Exposed schemas" dashboard setting, which was unreliable.
// Data still lands in mb_staging — the public wrapper functions are SECURITY DEFINER.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';

function key() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
}

const BATCH_SIZE = 500;
const SCHEMA = 'mb_staging';

// Call a public-schema RPC function
async function rpc(fnName, params) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey:         key(),
      Authorization:  `Bearer ${key()}`,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`mb-staging-writer rpc/${fnName}: ${res.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function upsertBatch(fnName, rows, dryRun = false) {
  if (!rows.length) return 0;
  if (dryRun) {
    console.log(`[mb-staging-writer] DRY RUN: would upsert ${rows.length} rows via ${fnName}`);
    return rows.length;
  }
  let total = 0;
  for (const batch of chunk(rows, BATCH_SIZE)) {
    await rpc(fnName, { rows: batch });
    total += batch.length;
  }
  return total;
}

async function upsertArtists(artists, dryRun = false) {
  return upsertBatch('fn_mb_upsert_artists', artists, dryRun);
}

async function upsertArtistAliases(aliases, dryRun = false) {
  return upsertBatch('fn_mb_upsert_artist_aliases', aliases, dryRun);
}

async function upsertRecordings(recordings, dryRun = false) {
  return upsertBatch('fn_mb_upsert_recordings', recordings, dryRun);
}

async function upsertISRCs(isrcs, dryRun = false) {
  return upsertBatch('fn_mb_upsert_isrcs', isrcs, dryRun);
}

async function upsertWorks(works, dryRun = false) {
  return upsertBatch('fn_mb_upsert_works', works, dryRun);
}

async function upsertISWCs(iswcs, dryRun = false) {
  return upsertBatch('fn_mb_upsert_iswcs', iswcs, dryRun);
}

async function upsertReleases(releases, dryRun = false) {
  return upsertBatch('fn_mb_upsert_releases', releases, dryRun);
}

async function upsertReleaseGroups(groups, dryRun = false) {
  return upsertBatch('fn_mb_upsert_release_groups', groups, dryRun);
}

async function upsertRelationships(relationships, dryRun = false) {
  return upsertBatch('fn_mb_upsert_relationships', relationships, dryRun);
}

async function upsertEntityMatches(matches, dryRun = false) {
  return upsertBatch('fn_mb_upsert_entity_matches', matches, dryRun);
}

// ─── Ingestion State ─────────────────────────────────────────────────────────

async function getIngestionState(entityType, importMode = 'api') {
  return rpc('fn_mb_get_ingestion_state', {
    p_entity_type: entityType,
    p_import_mode: importMode,
  });
}

async function saveIngestionState(entityType, importMode, updates, dryRun = false) {
  if (dryRun) return;
  await rpc('fn_mb_save_ingestion_state', {
    p_entity_type: entityType,
    p_import_mode: importMode,
    p_data: { updated_at: new Date().toISOString(), ...updates },
  });
}

async function markIngestionStarted(entityType, importMode, extra = {}) {
  await saveIngestionState(entityType, importMode, {
    status:     'running',
    started_at: new Date().toISOString(),
    ...extra,
  });
}

async function markIngestionCompleted(entityType, importMode, stats = {}) {
  await saveIngestionState(entityType, importMode, {
    status:       'completed',
    completed_at: new Date().toISOString(),
    ...stats,
  });
}

async function markIngestionFailed(entityType, importMode, errorMessage) {
  await saveIngestionState(entityType, importMode, {
    status:        'failed',
    error_message: errorMessage,
  });
}

async function checkpointProgress(entityType, importMode, offset, lastMbId, totalProcessed, totalErrors) {
  await saveIngestionState(entityType, importMode, {
    last_offset:     offset,
    last_mb_id:      lastMbId || null,
    total_processed: totalProcessed,
    total_errors:    totalErrors,
  });
}

// ─── Count helpers ────────────────────────────────────────────────────────────

async function countTable(_table) {
  // Counts require direct schema access; return null and let callers use SQL Editor.
  return null;
}

module.exports = {
  upsertArtists,
  upsertArtistAliases,
  upsertRecordings,
  upsertISRCs,
  upsertWorks,
  upsertISWCs,
  upsertReleases,
  upsertReleaseGroups,
  upsertRelationships,
  upsertEntityMatches,
  getIngestionState,
  saveIngestionState,
  markIngestionStarted,
  markIngestionCompleted,
  markIngestionFailed,
  checkpointProgress,
  countTable,
  BATCH_SIZE,
  SCHEMA,
};
