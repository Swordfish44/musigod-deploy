'use strict';
// lib/mb-staging-writer.js
// Batch write helpers for the MusicBrainz corpus and MusiGod review tables.
//
// Corpus tables (artists, recordings, ISRCs, works, ISWCs, releases,
// release_groups, relationships, ingestion_state) → external PostgreSQL
// via lib/mb-corpus-db.js (MUSICBRAINZ_DATABASE_URL).
//
// Review table (entity_matches_v1) → Supabase via SECURITY DEFINER RPC
// fn_mb_upsert_entity_matches. This table is the human-review boundary;
// it stays in Supabase so PostgREST can serve the review UI.
//
// Isolation: corpus DB outage never blocks entity_matches_v1 writes.

const corpusDb = require('./mb-corpus-db');

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';

function sbKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
}

const BATCH_SIZE = 500;
const MAX_PARAMS = 60_000; // pg hard limit is 65535

// ─── Supabase RPC (entity_matches only) ──────────────────────────────────────

async function sbRpc(fnName, params) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey:         sbKey(),
      Authorization:  `Bearer ${sbKey()}`,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`mb-staging-writer rpc/${fnName}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ─── Corpus DB batch insert ───────────────────────────────────────────────────

function serializeValue(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v;                 // TEXT[] — pg handles natively
  if (typeof v === 'object') return JSON.stringify(v);  // JSONB
  return v;
}

async function batchInsert(table, columns, conflictCols, updateCols, rows, dryRun) {
  if (!rows.length) return 0;
  if (dryRun) {
    console.log(`[mb-staging-writer] DRY RUN: would upsert ${rows.length} rows into mb_staging.${table}`);
    return rows.length;
  }

  const chunkSize = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
  let total = 0;

  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const n = columns.length;

    const placeholders = chunk
      .map((_, ri) => `(${columns.map((_, ci) => `$${ri * n + ci + 1}`).join(', ')})`)
      .join(', ');

    const values = chunk.flatMap(row =>
      columns.map(col => serializeValue(row[col] ?? null))
    );

    const onConflict = updateCols.length
      ? `ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`
      : `ON CONFLICT (${conflictCols.join(', ')}) DO NOTHING`;

    await corpusDb.query(
      `INSERT INTO mb_staging.${table} (${columns.join(', ')}) VALUES ${placeholders} ${onConflict}`,
      values
    );
    total += chunk.length;
  }

  return total;
}

// ─── Corpus entity upserts ────────────────────────────────────────────────────

async function upsertArtists(artists, dryRun = false) {
  const cols    = ['mb_artist_id','name','sort_name','artist_type','country','area','begin_date','end_date','comment','ended','mb_last_updated','ingestion_source','provenance'];
  const conflict = ['mb_artist_id'];
  const update   = ['name','sort_name','artist_type','country','area','begin_date','end_date','comment','ended','mb_last_updated','ingestion_source','provenance'];

  let total = 0;
  for (let i = 0; i < artists.length; i += BATCH_SIZE) {
    total += await batchInsert('artists_v1', cols, conflict, update, artists.slice(i, i + BATCH_SIZE), dryRun);
  }
  return total;
}

async function upsertArtistAliases(aliases, dryRun = false) {
  const cols    = ['mb_artist_id','alias_name','alias_type','locale','primary_alias','begin_date','end_date'];
  const conflict = ['mb_artist_id','alias_name'];
  const update   = ['alias_type','locale','primary_alias','begin_date','end_date'];

  let total = 0;
  for (let i = 0; i < aliases.length; i += BATCH_SIZE) {
    total += await batchInsert('artist_aliases_v1', cols, conflict, update, aliases.slice(i, i + BATCH_SIZE), dryRun);
  }
  return total;
}

async function upsertRecordings(recordings, dryRun = false) {
  const cols    = ['mb_recording_id','title','length_ms','artist_credit','mb_artist_id','comment','video','mb_last_updated','ingestion_source','provenance'];
  const conflict = ['mb_recording_id'];
  const update   = ['title','length_ms','artist_credit','mb_artist_id','comment','video','mb_last_updated','ingestion_source','provenance'];

  let total = 0;
  for (let i = 0; i < recordings.length; i += BATCH_SIZE) {
    total += await batchInsert('recordings_v1', cols, conflict, update, recordings.slice(i, i + BATCH_SIZE), dryRun);
  }
  return total;
}

async function upsertISRCs(isrcs, dryRun = false) {
  const cols    = ['mb_recording_id','isrc'];
  const conflict = ['mb_recording_id','isrc'];
  const update   = [];  // ISRCs are immutable once linked

  let total = 0;
  for (let i = 0; i < isrcs.length; i += BATCH_SIZE) {
    total += await batchInsert('isrcs_v1', cols, conflict, update, isrcs.slice(i, i + BATCH_SIZE), dryRun);
  }
  return total;
}

async function upsertWorks(works, dryRun = false) {
  const cols    = ['mb_work_id','title','work_type','language','comment','mb_last_updated','ingestion_source','provenance'];
  const conflict = ['mb_work_id'];
  const update   = ['title','work_type','language','comment','mb_last_updated','ingestion_source','provenance'];

  let total = 0;
  for (let i = 0; i < works.length; i += BATCH_SIZE) {
    total += await batchInsert('works_v1', cols, conflict, update, works.slice(i, i + BATCH_SIZE), dryRun);
  }
  return total;
}

async function upsertISWCs(iswcs, dryRun = false) {
  const cols    = ['mb_work_id','iswc'];
  const conflict = ['mb_work_id','iswc'];
  const update   = [];  // ISWCs are immutable once linked

  let total = 0;
  for (let i = 0; i < iswcs.length; i += BATCH_SIZE) {
    total += await batchInsert('iswcs_v1', cols, conflict, update, iswcs.slice(i, i + BATCH_SIZE), dryRun);
  }
  return total;
}

async function upsertReleases(releases, dryRun = false) {
  const cols    = ['mb_release_id','mb_release_group_id','title','artist_credit','mb_artist_id','release_date','country','status','barcode','mb_last_updated','ingestion_source','provenance'];
  const conflict = ['mb_release_id'];
  const update   = ['mb_release_group_id','title','artist_credit','mb_artist_id','release_date','country','status','barcode','mb_last_updated','ingestion_source','provenance'];

  let total = 0;
  for (let i = 0; i < releases.length; i += BATCH_SIZE) {
    total += await batchInsert('releases_v1', cols, conflict, update, releases.slice(i, i + BATCH_SIZE), dryRun);
  }
  return total;
}

async function upsertReleaseGroups(groups, dryRun = false) {
  const cols    = ['mb_release_group_id','title','primary_type','secondary_types','mb_artist_id','first_release_date','ingestion_source','provenance'];
  const conflict = ['mb_release_group_id'];
  const update   = ['title','primary_type','secondary_types','mb_artist_id','first_release_date','ingestion_source','provenance'];

  let total = 0;
  for (let i = 0; i < groups.length; i += BATCH_SIZE) {
    total += await batchInsert('release_groups_v1', cols, conflict, update, groups.slice(i, i + BATCH_SIZE), dryRun);
  }
  return total;
}

async function upsertRelationships(rels, dryRun = false) {
  const cols    = ['source_type','source_mb_id','target_type','target_mb_id','relationship_type','attributes','direction'];
  const conflict = ['source_type','source_mb_id','target_type','target_mb_id','relationship_type'];
  const update   = ['attributes','direction'];

  let total = 0;
  for (let i = 0; i < rels.length; i += BATCH_SIZE) {
    total += await batchInsert('relationships_v1', cols, conflict, update, rels.slice(i, i + BATCH_SIZE), dryRun);
  }
  return total;
}

// entity_matches_v1 stays in Supabase — the human-review boundary.
async function upsertEntityMatches(matches, dryRun = false) {
  if (!matches.length) return 0;
  if (dryRun) {
    console.log(`[mb-staging-writer] DRY RUN: would upsert ${matches.length} entity_matches rows`);
    return matches.length;
  }

  let total = 0;
  for (let i = 0; i < matches.length; i += BATCH_SIZE) {
    await sbRpc('fn_mb_upsert_entity_matches', { rows: matches.slice(i, i + BATCH_SIZE) });
    total += Math.min(BATCH_SIZE, matches.length - i);
  }
  return total;
}

// ─── Ingestion State (corpus DB) ─────────────────────────────────────────────
// One row per (entity_type, import_mode). Supports checkpoint/resume.

// Fields recognized in the updates object; iterated in this order for param positions.
const STATE_FIELD_ORDER = [
  'status', 'last_offset', 'last_mb_id', 'total_processed',
  'total_errors', 'dump_file', 'started_at', 'completed_at',
  'error_message', 'metadata',
];

async function saveIngestionState(entityType, importMode, updates, dryRun = false) {
  if (dryRun) return;

  // Ensure row exists with defaults first.
  await corpusDb.query(
    `INSERT INTO mb_staging.ingestion_state_v1 (entity_type, import_mode)
     VALUES ($1, $2)
     ON CONFLICT (entity_type, import_mode) DO NOTHING`,
    [entityType, importMode]
  );

  // Update only the fields present in updates.
  const sets = [];
  const params = [entityType, importMode];

  for (const field of STATE_FIELD_ORDER) {
    if (field in updates && updates[field] !== undefined) {
      const v = field === 'metadata' && updates[field] && typeof updates[field] === 'object'
        ? JSON.stringify(updates[field])
        : updates[field];
      params.push(v);
      sets.push(`${field} = $${params.length}`);
    }
  }
  sets.push('updated_at = now()');

  await corpusDb.query(
    `UPDATE mb_staging.ingestion_state_v1
     SET ${sets.join(', ')}
     WHERE entity_type = $1 AND import_mode = $2`,
    params
  );
}

async function getIngestionState(entityType, importMode = 'api') {
  const { rows } = await corpusDb.query(
    `SELECT * FROM mb_staging.ingestion_state_v1
     WHERE entity_type = $1 AND import_mode = $2
     LIMIT 1`,
    [entityType, importMode]
  );
  return rows[0] || null;
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

const CORPUS_TABLES = new Set([
  'artists_v1', 'artist_aliases_v1', 'recordings_v1', 'isrcs_v1',
  'works_v1', 'iswcs_v1', 'releases_v1', 'release_groups_v1',
  'relationships_v1', 'ingestion_state_v1',
]);

async function countTable(table) {
  if (!CORPUS_TABLES.has(table)) throw new Error(`countTable: unknown table "${table}"`);
  const { rows } = await corpusDb.query(`SELECT COUNT(*) AS n FROM mb_staging.${table}`);
  return parseInt(rows[0].n, 10);
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
};
