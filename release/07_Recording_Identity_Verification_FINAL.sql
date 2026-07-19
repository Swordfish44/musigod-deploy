-- ============================================================
-- 07_Recording_Identity_Verification_FINAL.sql
-- MusiGod Graph — Pre-Apply Read-Only Verification
--
-- Run ALL queries BEFORE applying 07_Recording_Identity_Fix_FINAL.sql.
-- None of these queries modify data.
-- Each query includes: expected result, pass condition, stop condition.
--
-- Project: uykzkrnoetcldeuxzqyy
-- Run in:  Supabase SQL Editor
-- ============================================================


-- ── V-00  Retrieve live function body ────────────────────────────────────
-- Save this output. Diff against the completed STEP 2 body. Do not skip.

SELECT pg_get_functiondef(oid) AS live_body
FROM   pg_proc
WHERE  proname = 'fn_sync_track_to_graph' AND pronamespace = 'public'::regnamespace;

-- Expected: 1 row, body_length ≈ 15,708 chars
-- STOP if 0 rows — function is missing from production


-- ── V-01  Return type — MUST be jsonb ────────────────────────────────────

SELECT
  proname,
  pg_get_function_result(oid)           AS return_type,
  length(pg_get_functiondef(oid))       AS body_length_chars
FROM pg_proc
WHERE proname = 'fn_sync_track_to_graph' AND pronamespace = 'public'::regnamespace;

-- PASS  : return_type = 'jsonb', body_length_chars ≈ 15,708
-- STOP  : return_type ≠ 'jsonb' — live function does not match verified state
-- STOP  : body_length_chars < 15000 — a reconstruction may have been applied;
--         investigate before proceeding


-- ── V-02  Edge-type fixes confirmed in live body ─────────────────────────

SELECT
  (pg_get_functiondef(oid) ILIKE '%has_recording%') AS has_has_recording,
  (pg_get_functiondef(oid) ILIKE '%performed%')      AS has_performed,
  (pg_get_functiondef(oid) ILIKE '%recorded_as%')    AS has_recorded_as,
  (pg_get_functiondef(oid) ILIKE '%performed_by%')   AS has_performed_by
FROM pg_proc
WHERE proname = 'fn_sync_track_to_graph' AND pronamespace = 'public'::regnamespace;

-- PASS  : has_has_recording = t, has_performed = t,
--         has_recorded_as = f, has_performed_by = f
-- STOP if any value differs — apply 03_Replace_fn_sync_track_to_graph.sql first


-- ── V-03  graph.nodes unique constraint (required for ON CONFLICT) ────────

SELECT indexname, indexdef
FROM   pg_indexes
WHERE  schemaname = 'graph'
  AND  tablename  = 'nodes'
  AND  indexdef   ILIKE '%external_id%external_id_ns%';

-- PASS  : ≥ 1 row
-- STOP if 0 rows — run 02_Install_RPCs.sql to create the constraint first


-- ── V-04  graph.edges unique constraint ──────────────────────────────────

SELECT indexname, indexdef
FROM   pg_indexes
WHERE  schemaname = 'graph'
  AND  tablename  = 'edges'
  AND  indexdef   ILIKE '%from_node_id%to_node_id%edge_type%';

-- PASS  : ≥ 1 row
-- STOP if 0 rows — run 02_Install_RPCs.sql first


-- ── V-05  catalog_enriched_tracks_v1 column inventory ────────────────────
-- Confirm the authoritative source table and required columns exist.

SELECT column_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'catalog_enriched_tracks_v1'
ORDER  BY ordinal_position;

-- PASS  : table exists; rows include:
--   id             uuid      NOT NULL
--   track_title    text      NOT NULL
--   isrcs          ARRAY     NOT NULL   ← required for tier-1 ISRC lookup
--   recording_mbid text      YES        ← required for tier-2 MBID lookup
--   release_mbid   text      YES        ← stored as metadata; never identity key
-- STOP if table does not exist — source table mismatch; investigate


-- ── V-06  Backup table state ──────────────────────────────────────────────
-- After running STEP 0C, this must show 1 row.

SELECT fn_name, backed_up_at, length(body) AS body_length_chars
FROM   public._musigod_fn_backup_20260718
WHERE  fn_name = 'fn_sync_track_to_graph';

-- PASS  : 1 row, body_length_chars ≈ 15,708
-- NOTE  : 0 rows means STEP 0C has not been run yet — run it before STEP 2


-- ── V-07  recording_identity_conflicts table ──────────────────────────────
-- After running STEP 1, this must show 1 row.

SELECT tablename, tableowner
FROM   pg_tables
WHERE  schemaname = 'graph' AND tablename = 'recording_identity_conflicts';

-- PASS  : 1 row
-- NOTE  : 0 rows means STEP 1 has not been run yet — run it before STEP 2


-- ── V-08  NULL external_id recording nodes (root-cause evidence) ──────────
-- These are the duplicate orphan nodes that the fix prevents.

SELECT id, external_id, external_id_ns, properties->>'track_id' AS track_id
FROM   graph.nodes
WHERE  node_type       = 'recording'
  AND  (external_id IS NULL OR external_id_ns IS NULL)
ORDER  BY created_at DESC;

-- PASS    : 0 rows — fix already applied (unexpected at pre-apply time)
-- EXPECTED: ≥ 1 row (e.g., the two orphans for track 4bcf28eb-…)
-- INFO    : These rows are historical; the fix prevents new ones.
--           They will be cleaned up in a future human-reviewed migration.


-- ── V-09  ISRC format inventory ───────────────────────────────────────────
-- Identifies non-standard ISRC values that normalization will correct.

SELECT
  COUNT(*)                                                   AS total_isrc_nodes,
  COUNT(*) FILTER (WHERE length(external_id) = 12)           AS standard_12char,
  COUNT(*) FILTER (WHERE length(external_id) <> 12)          AS non_standard,
  COUNT(*) FILTER (WHERE external_id ~ '[^A-Z0-9]')          AS contains_separators
FROM   graph.nodes
WHERE  external_id_ns = 'isrc';

-- INFO: non_standard and contains_separators rows will be normalized on
-- the next sync call after the fix is applied. They are not duplicates yet.


-- ── V-10  recording_mbid and musigod_catalog_track inventory ─────────────

SELECT external_id_ns, COUNT(*) AS node_count
FROM   graph.nodes
WHERE  node_type = 'recording'
GROUP  BY external_id_ns
ORDER  BY node_count DESC;

-- Expected namespaces before fix: 'isrc', 'musigod_catalog', possibly NULL
-- After fix: 'isrc', 'musicbrainz_recording', 'musigod_catalog_track' will appear


-- ── V-11  Duplicate recording node pairs ─────────────────────────────────

SELECT
  external_id, external_id_ns, COUNT(*) AS duplicate_count,
  array_agg(id ORDER BY created_at) AS node_ids
FROM   graph.nodes
WHERE  node_type = 'recording'
  AND  external_id IS NOT NULL
GROUP  BY external_id, external_id_ns
HAVING COUNT(*) > 1;

-- Expected: 0 rows (duplicates only arise when external_id IS NULL,
-- which is the root-cause scenario).
-- If rows appear: two ISRC-keyed nodes share the same ISRC — investigate
-- before applying the fix.
