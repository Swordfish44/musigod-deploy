-- ============================================================
-- 07_Recording_Identity_Verification.sql
-- MusiGod Graph — Read-Only Schema and Data Verification
--
-- Run ALL of these queries BEFORE applying 07_Recording_Identity_Fix.sql.
-- None of these queries modify data.
--
-- V-00: Retrieve live function body for diff
-- V-01: graph.nodes unique constraint (required by ON CONFLICT in RPCs)
-- V-02: graph.edges unique constraint
-- V-03: catalog_tracks_v1 column list (determines MBID tier availability)
-- V-04: Recording nodes with NULL external_id (the root-cause duplicates)
-- V-05: Recording nodes by external_id_ns (namespace inventory)
-- V-06: Duplicate recording node pairs (same isrc normalized)
-- V-07: Duplicate MBID recording nodes
-- V-08: Existing musigod_catalog_track nodes (should be 0 before first fix run)
-- V-09: ISRC format anomalies (non-12-char after normalization)
-- V-10: graph.recording_identity_conflicts (existence + row count)
-- V-11: works.recordings rows with NULL node_id (orphan detail rows)
-- V-12: Live function body ISRC normalization check
--
-- Project: uykzkrnoetcldeuxzqyy
-- Run in:  Supabase SQL Editor (read-only, no side effects)
-- ============================================================


-- ── V-00: Live function body ─────────────────────────────────────────────────
-- Save this output. Diff against 07_Recording_Identity_Fix.sql STEP 2.

SELECT pg_get_functiondef(oid) AS live_fn_sync_track_to_graph
FROM   pg_proc
WHERE  proname      = 'fn_sync_track_to_graph'
  AND  pronamespace = 'public'::regnamespace;


-- ── V-01: graph.nodes unique constraint ──────────────────────────────────────
-- Required: must return ≥ 1 row with indexdef containing external_id, external_id_ns.
-- If 0 rows: the ON CONFLICT in graph_upsert_node will error at runtime.

SELECT indexname, indexdef
FROM   pg_indexes
WHERE  schemaname = 'graph'
  AND  tablename  = 'nodes'
  AND  indexdef   ILIKE '%external_id%external_id_ns%';

-- Expected: ≥ 1 row  (e.g., UNIQUE INDEX on (external_id, external_id_ns))
-- Failure:  0 rows → STOP; run 02_Install_RPCs.sql to create the constraint


-- ── V-02: graph.edges unique constraint ──────────────────────────────────────
-- Required: must return ≥ 1 row.

SELECT indexname, indexdef
FROM   pg_indexes
WHERE  schemaname = 'graph'
  AND  tablename  = 'edges'
  AND  indexdef   ILIKE '%from_node_id%to_node_id%edge_type%';

-- Expected: ≥ 1 row
-- Failure:  0 rows → STOP; run 02_Install_RPCs.sql


-- ── V-03: catalog_tracks_v1 column list ──────────────────────────────────────
-- This determines whether the MBID tier block in 07_Recording_Identity_Fix.sql
-- STEP 2 can be uncommented.

SELECT column_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'catalog_tracks_v1'
ORDER  BY ordinal_position;

-- Key columns to look for:
--   isrc            — tier 1 ISRC identity (expected to exist)
--   recording_mbid  — tier 2 MBID identity (uncomment MBID tier block if present)
--   catalog_id      — used in work node identity
--   artist_id       — used for artist edge
--
-- If recording_mbid IS present:
--   → Uncomment the [MBID TIER] block in 07_Recording_Identity_Fix.sql STEP 2
-- If recording_mbid IS NOT present:
--   → MBID tier is handled by JS layer (syncEnrichmentToGraph) only
--   → Leave [MBID TIER] block commented out


-- ── V-04: Recording nodes with NULL external_id ───────────────────────────────
-- These are the root-cause duplicate nodes. Count and list.

SELECT
  id,
  label,
  properties->>'track_id'   AS track_id_in_props,
  properties->>'isrc'       AS isrc_in_props,
  created_at
FROM   graph.nodes
WHERE  node_type     = 'recording'
  AND  external_id   IS NULL
ORDER  BY created_at DESC;

-- Expected after fix applied: 0 rows
-- Expected BEFORE fix: at least 2 rows for track 4bcf28eb-35b6-49e7-a981-a435b9166e90


-- ── V-05: Recording nodes by external_id_ns ──────────────────────────────────
-- Inventory of all namespaces currently in use for recording nodes.

SELECT
  external_id_ns,
  count(*)        AS node_count,
  count(CASE WHEN external_id IS NULL THEN 1 END) AS null_id_count
FROM   graph.nodes
WHERE  node_type = 'recording'
GROUP  BY external_id_ns
ORDER  BY node_count DESC;

-- Expected namespaces: isrc, musicbrainz_recording, musigod_catalog
-- Expected after fix: musigod_catalog_track also appears (new namespace)
-- null_id_count should be 0 for all rows after fix


-- ── V-06: Duplicate recording node pairs (same normalized ISRC) ───────────────
-- Finds recording nodes whose external_ids normalize to the same ISRC,
-- indicating they represent the same sound recording under different spellings.

SELECT
  UPPER(REGEXP_REPLACE(external_id, '[^A-Za-z0-9]', '', 'g')) AS norm_isrc,
  count(*)                                                      AS node_count,
  array_agg(id ORDER BY created_at)                            AS node_ids,
  array_agg(external_id ORDER BY created_at)                   AS raw_isrcs
FROM   graph.nodes
WHERE  node_type     = 'recording'
  AND  external_id_ns = 'isrc'
  AND  external_id    IS NOT NULL
GROUP  BY norm_isrc
HAVING count(*) > 1
ORDER  BY node_count DESC;

-- Expected: 0 rows (no ISRC-namespace duplicates)
-- If rows present: log these as pre-existing data quality issues;
--   do NOT merge in this migration


-- ── V-07: Duplicate MBID recording nodes ─────────────────────────────────────

SELECT
  LOWER(TRIM(external_id)) AS norm_mbid,
  count(*)                 AS node_count,
  array_agg(id)            AS node_ids
FROM   graph.nodes
WHERE  node_type      = 'recording'
  AND  external_id_ns = 'musicbrainz_recording'
  AND  external_id    IS NOT NULL
GROUP  BY norm_mbid
HAVING count(*) > 1;

-- Expected: 0 rows


-- ── V-08: Existing musigod_catalog_track nodes ────────────────────────────────
-- Before the first fix deployment: should return 0 rows.
-- After first deployment: shows newly created fallback-keyed nodes.

SELECT
  id,
  label,
  external_id                  AS track_id,
  properties->>'isrc'          AS isrc_in_props,
  created_at
FROM   graph.nodes
WHERE  node_type      = 'recording'
  AND  external_id_ns = 'musigod_catalog_track'
ORDER  BY created_at DESC;


-- ── V-09: ISRC format anomalies ───────────────────────────────────────────────
-- ISRCs should be 12 alphanumeric characters after normalization.
-- Non-12-char ISRCs are stored but flagged here for data quality review.

SELECT
  id,
  external_id                                                         AS raw_isrc,
  UPPER(REGEXP_REPLACE(external_id, '[^A-Za-z0-9]', '', 'g'))        AS norm_isrc,
  LENGTH(UPPER(REGEXP_REPLACE(external_id, '[^A-Za-z0-9]', '', 'g'))) AS norm_length,
  created_at
FROM   graph.nodes
WHERE  node_type      = 'recording'
  AND  external_id_ns = 'isrc'
  AND  external_id    IS NOT NULL
  AND  LENGTH(UPPER(REGEXP_REPLACE(external_id, '[^A-Za-z0-9]', '', 'g'))) <> 12
ORDER  BY created_at DESC;

-- Expected: 0 rows for a clean catalog
-- If rows present: note them; the fix will still store the normalized form


-- ── V-10: graph.recording_identity_conflicts table ────────────────────────────
-- Before STEP 1 runs: will error with "relation does not exist" — expected.
-- After STEP 1 runs: returns 0 rows initially.
-- After repeated fn_sync_track_to_graph calls: shows detected conflicts.

SELECT
  count(*)                                       AS total_conflicts,
  count(CASE WHEN resolved = false THEN 1 END)  AS open_conflicts,
  count(CASE WHEN resolved = true  THEN 1 END)  AS resolved_conflicts
FROM   graph.recording_identity_conflicts;


-- ── V-11: works.recordings rows with NULL node_id ────────────────────────────
-- These are orphan detail rows that cannot be joined to graph.nodes.
-- Separate from the NULL external_id problem but related symptom.

SELECT count(*) AS orphan_recording_detail_rows
FROM   works.recordings
WHERE  node_id IS NULL;

-- Expected: 0 rows


-- ── V-12: Live function ISRC normalization check ─────────────────────────────
-- Confirms whether the deployed function uses the new normalization expression.

SELECT
  (pg_get_functiondef(oid) ILIKE '%REGEXP_REPLACE%isrc%')         AS uses_regexp_replace,
  (pg_get_functiondef(oid) ILIKE '%musigod_catalog_track%')       AS uses_fallback_ns,
  (pg_get_functiondef(oid) ILIKE '%v_norm_isrc%')                 AS uses_norm_isrc_var,
  (pg_get_functiondef(oid) ILIKE '%recording_identity_conflicts%') AS logs_conflicts
FROM pg_proc
WHERE proname      = 'fn_sync_track_to_graph'
  AND pronamespace = 'public'::regnamespace;

-- Before fix: all false
-- After fix:
--  uses_regexp_replace | uses_fallback_ns | uses_norm_isrc_var | logs_conflicts
-- ---------------------+------------------+--------------------+----------------
--  t                   | t                | t                  | t
