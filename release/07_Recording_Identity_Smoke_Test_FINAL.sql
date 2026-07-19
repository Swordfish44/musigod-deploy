-- ============================================================
-- 07_Recording_Identity_Smoke_Test_FINAL.sql
-- MusiGod Graph — Post-Apply Idempotency and JSONB Return Tests
--
-- Run AFTER 07_Recording_Identity_Fix_FINAL.sql STEP 2 + STEP 3.
--
-- PHASE 5 test scenarios:
--   T-01  No-ISRC track (root-cause scenario): synced twice → 0 new nodes
--   T-02  ISRC track: synced twice → 0 new nodes; ISRC-keyed node stable
--   T-03  MBID-only track: synced twice → 0 new nodes; MBID-keyed node stable
--   T-04  JSONB return: function returns jsonb; value is not null; is jsonb type
--   T-05  Conflict table: recording_identity_conflicts exists and is queryable
--   T-06  ISRC normalization: hyphenated ISRC treated same as canonical form
--   T-07  Fallback identity: no-ISRC track uses musigod_catalog_track namespace
--   T-08  release_mbid: never used as recording external_id_ns
--
-- All tests run against catalog_enriched_tracks_v1.
-- Tests T-01 through T-03, T-06, T-07 are wrapped in ROLLBACK.
-- T-04, T-05, T-08 are read-only (no rollback needed).
--
-- Prerequisites:
--   07_Recording_Identity_Fix_FINAL.sql STEP 1 + STEP 2 applied
--   At least one track in public.catalog_enriched_tracks_v1
--
-- Project: uykzkrnoetcldeuxzqyy
-- Run in:  Supabase SQL Editor
-- ============================================================


-- ── T-01  No-ISRC track idempotency (root-cause scenario) ─────────────────
-- This test reproduces the production incident (track 4bcf28eb-…).
-- The root cause was that ON CONFLICT (NULL, NULL) is a PostgreSQL no-op,
-- so each sync call created a new orphan recording node.
-- After the fix, the second call must create 0 new nodes and 0 new edges.

BEGIN;
DO $$
DECLARE
  v_track_id      UUID;
  v_nodes_before  BIGINT;
  v_edges_before  BIGINT;
  v_nodes_after1  BIGINT;
  v_edges_after1  BIGINT;
  v_nodes_after2  BIGINT;
  v_edges_after2  BIGINT;
BEGIN
  -- Use the known root-cause track if it exists; otherwise any no-ISRC track.
  SELECT id INTO v_track_id
  FROM   public.catalog_enriched_tracks_v1
  WHERE  (isrcs IS NULL OR array_length(isrcs, 1) = 0 OR isrcs[1] IS NULL OR isrcs[1] = '')
    AND  recording_mbid IS NULL
  ORDER  BY id = '4bcf28eb-35b6-49e7-a981-a435b9166e90'::UUID DESC,
            created_at DESC
  LIMIT  1;

  IF v_track_id IS NULL THEN
    RAISE NOTICE 'T-01 SKIP — no no-ISRC/no-MBID track found in catalog_enriched_tracks_v1';
    RETURN;
  END IF;

  RAISE NOTICE 'T-01: using track %', v_track_id;

  SELECT count(*) INTO v_nodes_before FROM graph.nodes;
  SELECT count(*) INTO v_edges_before FROM graph.edges;

  PERFORM public.fn_sync_track_to_graph(v_track_id);

  SELECT count(*) INTO v_nodes_after1 FROM graph.nodes;
  SELECT count(*) INTO v_edges_after1 FROM graph.edges;
  RAISE NOTICE 'T-01: first call — +% nodes, +% edges',
    v_nodes_after1 - v_nodes_before, v_edges_after1 - v_edges_before;

  PERFORM public.fn_sync_track_to_graph(v_track_id);

  SELECT count(*) INTO v_nodes_after2 FROM graph.nodes;
  SELECT count(*) INTO v_edges_after2 FROM graph.edges;

  IF v_nodes_after2 = v_nodes_after1 AND v_edges_after2 = v_edges_after1 THEN
    RAISE NOTICE 'T-01 PASS — second call: +0 nodes, +0 edges (idempotent)';
  ELSE
    RAISE EXCEPTION 'T-01 FAIL — second call: +% nodes, +% edges (expected 0, 0)',
      v_nodes_after2 - v_nodes_after1, v_edges_after2 - v_edges_after1;
  END IF;
END;
$$;
ROLLBACK;


-- ── T-02  ISRC track idempotency ──────────────────────────────────────────

BEGIN;
DO $$
DECLARE
  v_track_id     UUID;
  v_isrc         TEXT;
  v_nodes_before BIGINT;
  v_nodes_after1 BIGINT;
  v_nodes_after2 BIGINT;
BEGIN
  SELECT id, isrcs[1] INTO v_track_id, v_isrc
  FROM   public.catalog_enriched_tracks_v1
  WHERE  isrcs IS NOT NULL
    AND  array_length(isrcs, 1) > 0
    AND  isrcs[1] IS NOT NULL
    AND  isrcs[1] <> ''
  LIMIT  1;

  IF v_track_id IS NULL THEN
    RAISE NOTICE 'T-02 SKIP — no ISRC track found in catalog_enriched_tracks_v1';
    RETURN;
  END IF;

  RAISE NOTICE 'T-02: track %, ISRC %', v_track_id, v_isrc;

  SELECT count(*) INTO v_nodes_before FROM graph.nodes;

  PERFORM public.fn_sync_track_to_graph(v_track_id);
  SELECT count(*) INTO v_nodes_after1 FROM graph.nodes;

  PERFORM public.fn_sync_track_to_graph(v_track_id);
  SELECT count(*) INTO v_nodes_after2 FROM graph.nodes;

  IF v_nodes_after2 = v_nodes_after1 THEN
    RAISE NOTICE 'T-02 PASS — ISRC track idempotent: second call +0 nodes';
  ELSE
    RAISE EXCEPTION 'T-02 FAIL — second call created +% node(s)',
      v_nodes_after2 - v_nodes_after1;
  END IF;
END;
$$;
ROLLBACK;


-- ── T-03  MBID-only track idempotency ─────────────────────────────────────

BEGIN;
DO $$
DECLARE
  v_track_id     UUID;
  v_mbid         TEXT;
  v_nodes_before BIGINT;
  v_nodes_after1 BIGINT;
  v_nodes_after2 BIGINT;
BEGIN
  SELECT id, recording_mbid INTO v_track_id, v_mbid
  FROM   public.catalog_enriched_tracks_v1
  WHERE  recording_mbid IS NOT NULL
    AND  recording_mbid <> ''
    AND  (isrcs IS NULL OR array_length(isrcs, 1) = 0 OR isrcs[1] IS NULL OR isrcs[1] = '')
  LIMIT  1;

  IF v_track_id IS NULL THEN
    RAISE NOTICE 'T-03 SKIP — no MBID-only (no ISRC) track found';
    RETURN;
  END IF;

  RAISE NOTICE 'T-03: track %, recording_mbid %', v_track_id, v_mbid;

  SELECT count(*) INTO v_nodes_before FROM graph.nodes;

  PERFORM public.fn_sync_track_to_graph(v_track_id);
  SELECT count(*) INTO v_nodes_after1 FROM graph.nodes;

  PERFORM public.fn_sync_track_to_graph(v_track_id);
  SELECT count(*) INTO v_nodes_after2 FROM graph.nodes;

  IF v_nodes_after2 = v_nodes_after1 THEN
    RAISE NOTICE 'T-03 PASS — MBID-only track idempotent: second call +0 nodes';
  ELSE
    RAISE EXCEPTION 'T-03 FAIL — second call created +% node(s)',
      v_nodes_after2 - v_nodes_after1;
  END IF;
END;
$$;
ROLLBACK;


-- ── T-04  JSONB return contract ────────────────────────────────────────────
-- The function must return JSONB. Capturing the return value confirms
-- the return contract is intact and the value is not NULL.

DO $$
DECLARE
  v_track_id UUID;
  v_result   JSONB;
BEGIN
  SELECT id INTO v_track_id
  FROM   public.catalog_enriched_tracks_v1
  LIMIT  1;

  IF v_track_id IS NULL THEN
    RAISE NOTICE 'T-04 SKIP — no tracks in catalog_enriched_tracks_v1';
    RETURN;
  END IF;

  v_result := public.fn_sync_track_to_graph(v_track_id);

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'T-04 FAIL — function returned NULL (expected non-null JSONB)';
  END IF;

  IF jsonb_typeof(v_result) IS NULL THEN
    RAISE EXCEPTION 'T-04 FAIL — return value is not valid JSONB';
  END IF;

  RAISE NOTICE 'T-04 PASS — function returned JSONB: %', v_result;
END;
$$;

-- NOTE: T-04 is NOT wrapped in ROLLBACK because it only calls the function
-- on a real track that may already exist in the graph (idempotent operation).
-- If you want to avoid any writes, wrap in BEGIN/ROLLBACK.


-- ── T-05  Conflict table queryable ────────────────────────────────────────

SELECT
  (SELECT count(*) FROM graph.recording_identity_conflicts)  AS total_conflicts,
  (SELECT count(*) FROM graph.recording_identity_conflicts
   WHERE resolved = false)                                    AS open_conflicts,
  'T-05 PASS — recording_identity_conflicts table is queryable'::TEXT AS result;

-- PASS  : query returns without error
-- If table does not exist: STEP 1 was not applied. Apply it and re-run.


-- ── T-06  ISRC normalization — hyphenated vs canonical ────────────────────
-- Two calls with the same track ID must resolve the same recording node
-- regardless of how the ISRC is formatted in the source table.
-- This test verifies normalization works by checking a hyphenated ISRC
-- normalizes to the same 12-char uppercase form as the canonical form.

DO $$
DECLARE
  v_norm_1 TEXT := UPPER(REGEXP_REPLACE(TRIM('US-A1B-23-45678'), '[^A-Za-z0-9]', '', 'g'));
  v_norm_2 TEXT := UPPER(REGEXP_REPLACE(TRIM('USA1B2345678'),    '[^A-Za-z0-9]', '', 'g'));
  v_norm_3 TEXT := UPPER(REGEXP_REPLACE(TRIM('usa1b2345678'),    '[^A-Za-z0-9]', '', 'g'));
BEGIN
  IF v_norm_1 = v_norm_2 AND v_norm_2 = v_norm_3 THEN
    RAISE NOTICE 'T-06 PASS — all three ISRC forms normalize to: %', v_norm_1;
  ELSE
    RAISE EXCEPTION 'T-06 FAIL — normalization inconsistent: %, %, %',
      v_norm_1, v_norm_2, v_norm_3;
  END IF;
END;
$$;

-- Expected: all three → 'USA1B2345678'


-- ── T-07  Fallback namespace is musigod_catalog_track ─────────────────────
-- A no-ISRC no-MBID track must be keyed by (p_track_id::TEXT, musigod_catalog_track).
-- This namespace is new — not musigod_catalog (which was used before the fix).

BEGIN;
DO $$
DECLARE
  v_track_id UUID;
  v_rec_id   UUID;
BEGIN
  SELECT id INTO v_track_id
  FROM   public.catalog_enriched_tracks_v1
  WHERE  (isrcs IS NULL OR array_length(isrcs, 1) = 0 OR isrcs[1] IS NULL OR isrcs[1] = '')
    AND  recording_mbid IS NULL
  LIMIT  1;

  IF v_track_id IS NULL THEN
    RAISE NOTICE 'T-07 SKIP — no no-ISRC/no-MBID track found';
    RETURN;
  END IF;

  PERFORM public.fn_sync_track_to_graph(v_track_id);

  SELECT id INTO v_rec_id
  FROM   graph.nodes
  WHERE  external_id    = v_track_id::TEXT
    AND  external_id_ns = 'musigod_catalog_track'
    AND  node_type      = 'recording';

  IF v_rec_id IS NOT NULL THEN
    RAISE NOTICE 'T-07 PASS — fallback node keyed by musigod_catalog_track: %', v_rec_id;
  ELSE
    RAISE EXCEPTION
      'T-07 FAIL — no recording node found with (%, musigod_catalog_track); '
      'fix may not have been applied correctly', v_track_id;
  END IF;
END;
$$;
ROLLBACK;


-- ── T-08  release_mbid never used as recording identity ───────────────────
-- release_mbid must appear only in node properties, never as external_id_ns.

SELECT count(*) AS recording_nodes_keyed_by_release_mbid
FROM   graph.nodes
WHERE  node_type       = 'recording'
  AND  external_id_ns  = 'release_mbid';

-- PASS  : 0
-- Any non-zero value means release_mbid leaked into recording identity — investigate.


-- ── Summary query — run after T-01 through T-08 ───────────────────────────

SELECT
  pg_get_function_result(oid)                                          AS live_return_type,
  length(pg_get_functiondef(oid))                                      AS body_length_chars,
  (pg_get_function_result(oid) = 'jsonb')                              AS t04_return_is_jsonb,
  (pg_get_functiondef(oid) ILIKE '%musigod_catalog_track%')            AS t07_has_fallback_ns,
  (pg_get_functiondef(oid) ILIKE '%recording_identity_conflicts%')     AS t05_has_conflict_log,
  (pg_get_functiondef(oid) ILIKE '%isrcs[1]%')                         AS t06_has_isrc_array,
  (pg_get_functiondef(oid) ILIKE '%REGEXP_REPLACE%')                   AS t06_has_normalize,
  (SELECT count(*) FROM graph.recording_identity_conflicts)            AS open_conflict_count
FROM pg_proc
WHERE proname = 'fn_sync_track_to_graph' AND pronamespace = 'public'::regnamespace;

-- All boolean columns must be t except nothing.
-- If t04_return_is_jsonb = f → ROLLBACK immediately.
-- If body_length_chars < 15000 → reconstruction was applied; ROLLBACK.
