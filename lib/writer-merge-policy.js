'use strict';

// lib/writer-merge-policy.js
// Provenance-aware merge policy for per-track writer credits.
//
// Rules (from musigod_enrichment_persistence_defect_fix.md):
//  1. Never replace non-empty writers with empty results from a failed, skipped,
//     timed-out, or no-match source.
//  2. Preserve existing source attribution.
//  3. Merge newly discovered writers only when identity resolution supports the addition.
//  4. Do not silently remove existing writers.
//  5. Writer removals or contradictory evidence create a conflict item, not a silent overwrite.
//  6. A re-run must be idempotent.
//  7. Processing one target track must not mutate sibling tracks unless requested.

function normalizeWriterName(name) {
  return (name || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

function isSameWriter(a, b) {
  if (!a || !b) return false;
  // MBID match takes precedence when both are present
  if (a.mbid && b.mbid) return a.mbid === b.mbid;
  // Name-normalized match — guard against both being empty
  const na = normalizeWriterName(a.name);
  const nb = normalizeWriterName(b.name);
  return na.length > 0 && na === nb;
}

/**
 * Apply the governed merge policy to a single incoming track row.
 *
 * @param {object} incomingRow - Row shaped by toRow() in persist-enriched-tracks.js
 * @param {object|null} existingRow - Current DB row, or null if this is a new track
 * @returns {{ action: string, row: object, conflict?: object }}
 *
 * action values:
 *   'INSERT'       — no existing row, insert as-is
 *   'UPGRADE'      — existing has 0 writers, incoming has ≥1 — safe write
 *   'MERGE'        — both have writers; incoming adds new ones (no removals) — merge
 *   'IDEMPOTENT'   — incoming writers are a subset of existing (same set or no new) — keep existing
 *   'KEEP_EXISTING'— incoming has 0 writers but existing has ≥1 — preserve existing
 *   'UPDATE_META'  — both have 0 writers — update metadata fields only
 *   'CONFLICT'     — incoming would remove existing writers — flag for review, keep existing
 */
function applyPolicy(incomingRow, existingRow) {
  if (!existingRow) {
    return { action: 'INSERT', row: incomingRow };
  }

  const incomingWriters = Array.isArray(incomingRow.writers) ? incomingRow.writers : [];
  const existingWriters = Array.isArray(existingRow.writers) ? existingRow.writers : [];

  // Rule 1: Never replace non-empty evidence with empty/failed result.
  if (incomingWriters.length === 0 && existingWriters.length > 0) {
    return {
      action: 'KEEP_EXISTING',
      row: {
        ...incomingRow,
        writers:            existingWriters,
        enriched:           true,
        enrichment_source:  existingRow.enrichment_source,
        // Preserve the error so we know what this run found (or failed to find)
        enrichment_error: incomingRow.enrichment_error
          ? `[preserved prior writers] ${incomingRow.enrichment_error}`
          : null,
      },
    };
  }

  // Both empty — update metadata only; writer fields unchanged.
  if (incomingWriters.length === 0 && existingWriters.length === 0) {
    return { action: 'UPDATE_META', row: incomingRow };
  }

  // Incoming has writers, existing does not — safe upgrade.
  if (incomingWriters.length > 0 && existingWriters.length === 0) {
    return { action: 'UPGRADE', row: incomingRow };
  }

  // Both have writers. Determine what would be added vs removed.
  const additions = incomingWriters.filter(
    iw => !existingWriters.some(ew => isSameWriter(ew, iw))
  );
  const removals = existingWriters.filter(
    ew => !incomingWriters.some(iw => isSameWriter(ew, iw))
  );

  // Any writer that would be silently removed is a contradiction.
  if (removals.length > 0) {
    const conflict = {
      type:           'writer_contradiction',
      track_title:    incomingRow.track_title,
      recording_mbid: incomingRow.recording_mbid,
      existingWriters,
      incomingWriters,
      wouldRemove:    removals,
      wouldAdd:       additions,
    };
    return {
      action: 'CONFLICT',
      row: {
        ...incomingRow,
        writers:           existingWriters, // preserve existing
        enriched:          true,
        enrichment_source: existingRow.enrichment_source,
        enrichment_error:  '[conflict] incoming writers contradict existing — kept existing; review required',
      },
      conflict,
    };
  }

  // Pure additions (no removals) — safe to merge.
  if (additions.length > 0) {
    const merged = [...existingWriters, ...additions];
    const srcParts = [existingRow.enrichment_source, incomingRow.enrichment_source]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
    return {
      action: 'MERGE',
      row: {
        ...incomingRow,
        writers:           merged,
        enriched:          true,
        enrichment_source: srcParts.join('+') || incomingRow.enrichment_source,
        enrichment_error:  null,
      },
    };
  }

  // Incoming writers are identical to existing (idempotent re-run).
  // Still update non-writer metadata (job_id, isrcs, iswc, release info).
  return {
    action: 'IDEMPOTENT',
    row: {
      ...incomingRow,
      writers:           existingWriters,
      enriched:          true,
      enrichment_source: existingRow.enrichment_source,
      enrichment_error:  null,
    },
  };
}

module.exports = { applyPolicy, isSameWriter, normalizeWriterName };
