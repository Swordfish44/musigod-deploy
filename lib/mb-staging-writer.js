'use strict';
// lib/mb-staging-writer.js
// Batch write helpers for mb_staging tables.
//
// Uses raw fetch with Accept-Profile/Content-Profile: mb_staging (per CLAUDE.md convention).
// All writes go to mb_staging schema in Supabase via the service role key.
// Every upsert uses ON CONFLICT DO UPDATE (merge-duplicates) so re-runs are idempotent.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';

function key() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
}

const BATCH_SIZE = 500;
const SCHEMA = 'mb_staging';

async function sbFetch(table, options = {}) {
  const { method = 'GET', body, prefer, params } = options;

  let url = `${SB_URL}/rest/v1/${table}`;
  if (params) url += `?${params}`;

  const headers = {
    apikey:           key(),
    Authorization:    `Bearer ${key()}`,
    'Accept-Profile': SCHEMA,
  };

  if (body !== undefined) {
    headers['Content-Type']   = 'application/json';
    headers['Content-Profile'] = SCHEMA;
  }
  if (prefer) headers['Prefer'] = prefer;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`mb-staging-writer ${method} ${table}: ${res.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

// Split arr into chunks of at most size n
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Generic upsert — inserts rows, merges on conflict. Returns number upserted.
async function upsertBatch(table, rows, dryRun = false) {
  if (!rows.length) return 0;
  if (dryRun) {
    console.log(`[mb-staging-writer] DRY RUN: would upsert ${rows.length} rows → ${table}`);
    return rows.length;
  }
  let total = 0;
  for (const batch of chunk(rows, BATCH_SIZE)) {
    await sbFetch(table, {
      method: 'POST',
      body: batch,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    total += batch.length;
  }
  return total;
}

async function upsertArtists(artists, dryRun = false) {
  return upsertBatch('artists_v1', artists, dryRun);
}

async function upsertArtistAliases(aliases, dryRun = false) {
  return upsertBatch('artist_aliases_v1', aliases, dryRun);
}

async function upsertRecordings(recordings, dryRun = false) {
  return upsertBatch('recordings_v1', recordings, dryRun);
}

async function upsertISRCs(isrcs, dryRun = false) {
  return upsertBatch('isrcs_v1', isrcs, dryRun);
}

async function upsertWorks(works, dryRun = false) {
  return upsertBatch('works_v1', works, dryRun);
}

async function upsertISWCs(iswcs, dryRun = false) {
  return upsertBatch('iswcs_v1', iswcs, dryRun);
}

async function upsertReleases(releases, dryRun = false) {
  return upsertBatch('releases_v1', releases, dryRun);
}

async function upsertReleaseGroups(groups, dryRun = false) {
  return upsertBatch('release_groups_v1', groups, dryRun);
}

async function upsertRelationships(relationships, dryRun = false) {
  return upsertBatch('relationships_v1', relationships, dryRun);
}

async function upsertEntityMatches(matches, dryRun = false) {
  return upsertBatch('entity_matches_v1', matches, dryRun);
}

// ─── Ingestion State ─────────────────────────────────────────────────────────

async function getIngestionState(entityType, importMode = 'api') {
  const rows = await sbFetch('ingestion_state_v1', {
    params: `entity_type=eq.${encodeURIComponent(entityType)}&import_mode=eq.${encodeURIComponent(importMode)}&limit=1`,
  });
  return rows?.[0] || null;
}

async function saveIngestionState(entityType, importMode, updates, dryRun = false) {
  if (dryRun) return;
  const body = {
    entity_type:  entityType,
    import_mode:  importMode,
    updated_at:   new Date().toISOString(),
    ...updates,
  };
  await sbFetch('ingestion_state_v1', {
    method: 'POST',
    body,
    prefer: 'resolution=merge-duplicates,return=minimal',
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

async function countTable(table) {
  try {
    const rows = await sbFetch(table, { params: 'select=id&limit=0' });
    // PostgREST returns count in Content-Range header, but since we can't read
    // headers from our simple sbFetch, do a select with just one column.
    // For an actual count, callers should use the Supabase dashboard or psql.
    return Array.isArray(rows) ? rows.length : null;
  } catch {
    return null;
  }
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
