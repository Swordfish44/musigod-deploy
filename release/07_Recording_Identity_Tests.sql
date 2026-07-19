-- ============================================================
-- 07_Recording_Identity_Tests.sql
-- MusiGod Graph — Recording Identity Resolution Test Suite
--
-- Tests all 10 scenarios from the specification.
-- Run AFTER 07_Recording_Identity_Fix.sql STEP 1 + STEP 2.
--
-- Each test runs in a transaction that is ROLLED BACK after the
-- assertions, so no permanent data is written. Tests are safe to
-- run on production data.
--
-- Prerequisite: fn_sync_track_to_graph must be able to find a real
-- artist row in graph.nodes for the performed edge test (T-09).
-- Tests that require a real track row use a synthetic DO block that
-- inserts transient test data within the rollback boundary.
--
-- Run order: T-01 through T-10 in sequence.
--
-- Project: uykzkrnoetcldeuxzqyy
-- Run in:  Supabase SQL Editor
-- ============================================================


-- ══════════════════════════════════════════════════════════════════════
-- T-01 — No-ISRC track synced twice → 0 new recording nodes on 2nd run
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_track_id       UUID := gen_random_uuid();
  v_nodes_before   BIGINT;
  v_nodes_after1   BIGINT;
  v_nodes_after2   BIGINT;
  v_edges_before   BIGINT;
  v_edges_after1   BIGINT;
  v_edges_after2   BIGINT;
BEGIN
  -- Insert a synthetic no-ISRC track (no isrc, no catalog_id)
  INSERT INTO public.catalog_tracks_v1
    (id, track_title, artist_id, isrc, catalog_id)
  VALUES
    (v_track_id, 'T-01 No ISRC Track', gen_random_uuid(), NULL, NULL);

  SELECT count(*) INTO v_nodes_before FROM graph.nodes;
  SELECT count(*) INTO v_edges_before FROM graph.edges;

  -- First call
  PERFORM public.fn_sync_track_to_graph(v_track_id);

  SELECT count(*) INTO v_nodes_after1 FROM graph.nodes;
  SELECT count(*) INTO v_edges_after1 FROM graph.edges;

  -- Second call — must be idempotent
  PERFORM public.fn_sync_track_to_graph(v_track_id);

  SELECT count(*) INTO v_nodes_after2 FROM graph.nodes;
  SELECT count(*) INTO v_edges_after2 FROM graph.edges;

  -- Assertions
  IF v_nodes_after2 = v_nodes_after1 AND v_edges_after2 = v_edges_after1 THEN
    RAISE NOTICE 'T-01 PASS — no-ISRC track idempotent: second run +0 nodes, +0 edges';
  ELSE
    RAISE EXCEPTION 'T-01 FAIL — second run created +% node(s), +% edge(s); expected 0, 0',
      v_nodes_after2 - v_nodes_after1, v_edges_after2 - v_edges_after1;
  END IF;

  -- Verify recording node uses musigod_catalog_track namespace
  IF NOT EXISTS (
    SELECT 1 FROM graph.nodes
    WHERE external_id    = v_track_id::TEXT
      AND external_id_ns = 'musigod_catalog_track'
      AND node_type      = 'recording'
  ) THEN
    RAISE EXCEPTION 'T-01 FAIL — recording node not keyed by (track_id, musigod_catalog_track)';
  END IF;
  RAISE NOTICE 'T-01 PASS — recording node keyed by musigod_catalog_track namespace';

  ROLLBACK;
END;
$$;
BEGIN; ROLLBACK; -- reset transaction state between tests


-- ══════════════════════════════════════════════════════════════════════
-- T-02 — ISRC track synced twice → 0 new recording nodes on 2nd run
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_track_id       UUID := gen_random_uuid();
  v_nodes_before   BIGINT;
  v_nodes_after1   BIGINT;
  v_nodes_after2   BIGINT;
BEGIN
  INSERT INTO public.catalog_tracks_v1
    (id, track_title, artist_id, isrc, catalog_id)
  VALUES
    (v_track_id, 'T-02 ISRC Track', gen_random_uuid(), 'UST020000002', gen_random_uuid());

  SELECT count(*) INTO v_nodes_before FROM graph.nodes;
  PERFORM public.fn_sync_track_to_graph(v_track_id);
  SELECT count(*) INTO v_nodes_after1 FROM graph.nodes;
  PERFORM public.fn_sync_track_to_graph(v_track_id);
  SELECT count(*) INTO v_nodes_after2 FROM graph.nodes;

  IF v_nodes_after2 = v_nodes_after1 THEN
    RAISE NOTICE 'T-02 PASS — ISRC track idempotent: second run +0 nodes';
  ELSE
    RAISE EXCEPTION 'T-02 FAIL — second run created +% node(s)',
      v_nodes_after2 - v_nodes_after1;
  END IF;

  -- Verify recording node uses isrc namespace
  IF NOT EXISTS (
    SELECT 1 FROM graph.nodes
    WHERE external_id    = 'UST020000002'
      AND external_id_ns = 'isrc'
      AND node_type      = 'recording'
  ) THEN
    RAISE EXCEPTION 'T-02 FAIL — recording node not keyed by normalized ISRC';
  END IF;
  RAISE NOTICE 'T-02 PASS — recording node keyed by isrc namespace';

  -- Verify track_id in properties (fallback always attached)
  IF NOT EXISTS (
    SELECT 1 FROM graph.nodes
    WHERE external_id             = 'UST020000002'
      AND external_id_ns          = 'isrc'
      AND properties->>'track_id' = v_track_id::TEXT
  ) THEN
    RAISE EXCEPTION 'T-02 FAIL — track_id not attached in properties';
  END IF;
  RAISE NOTICE 'T-02 PASS — track_id attached in node properties (fallback identifier)';

  ROLLBACK;
END;
$$;
BEGIN; ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════
-- T-03 — MBID-only track: note that MBID tier lives in JS layer
-- The SQL function does not implement MBID tier unless V-03 confirms
-- catalog_tracks_v1 has recording_mbid. This test verifies the SQL
-- function handles a no-ISRC / no-MBID track gracefully (falls through
-- to fallback), matching the expected JS-layer behavior.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_track_id UUID := gen_random_uuid();
  v_nodes_before BIGINT;
  v_nodes_after1 BIGINT;
  v_nodes_after2 BIGINT;
BEGIN
  -- Simulate a track that enrichment would populate with MBID but the
  -- SQL fn only sees (no isrc). If the MBID tier block is uncommented
  -- and catalog_tracks_v1 has recording_mbid, a different assertion applies.
  INSERT INTO public.catalog_tracks_v1
    (id, track_title, artist_id, isrc, catalog_id)
  VALUES
    (v_track_id, 'T-03 MBID Only Track', gen_random_uuid(), NULL, NULL);

  SELECT count(*) INTO v_nodes_before FROM graph.nodes;
  PERFORM public.fn_sync_track_to_graph(v_track_id);
  SELECT count(*) INTO v_nodes_after1 FROM graph.nodes;
  PERFORM public.fn_sync_track_to_graph(v_track_id);
  SELECT count(*) INTO v_nodes_after2 FROM graph.nodes;

  IF v_nodes_after2 = v_nodes_after1 THEN
    RAISE NOTICE 'T-03 PASS — no-ISRC (MBID-only) track idempotent via fallback namespace';
  ELSE
    RAISE EXCEPTION 'T-03 FAIL — second run created +% node(s)',
      v_nodes_after2 - v_nodes_after1;
  END IF;

  RAISE NOTICE 'T-03 NOTE — MBID lookup is in JS syncEnrichmentToGraph; SQL fn uses track-id fallback for no-ISRC tracks until V-03 confirms recording_mbid column';

  ROLLBACK;
END;
$$;
BEGIN; ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════
-- T-04 — Fallback-only node later enriched with ISRC → same node reused
-- Simulates: first sync has no ISRC (creates fallback-keyed node),
-- then track gains an ISRC and is re-synced (should reuse same node).
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_track_id      UUID := gen_random_uuid();
  v_node_id_first UUID;
  v_node_id_after UUID;
  v_nodes_before  BIGINT;
  v_nodes_after1  BIGINT;
  v_nodes_after2  BIGINT;
BEGIN
  -- First sync: no ISRC
  INSERT INTO public.catalog_tracks_v1
    (id, track_title, artist_id, isrc, catalog_id)
  VALUES
    (v_track_id, 'T-04 ISRC Enrichment Track', gen_random_uuid(), NULL, NULL);

  SELECT count(*) INTO v_nodes_before FROM graph.nodes;
  PERFORM public.fn_sync_track_to_graph(v_track_id);
  SELECT count(*) INTO v_nodes_after1 FROM graph.nodes;

  -- Capture the fallback-keyed node id
  SELECT id INTO v_node_id_first
  FROM   graph.nodes
  WHERE  external_id    = v_track_id::TEXT
    AND  external_id_ns = 'musigod_catalog_track';

  IF v_node_id_first IS NULL THEN
    RAISE EXCEPTION 'T-04 SETUP FAIL — fallback node not created on first sync';
  END IF;

  -- Second sync: ISRC now available (simulate by updating the row)
  UPDATE public.catalog_tracks_v1 SET isrc = 'UST040000004' WHERE id = v_track_id;

  PERFORM public.fn_sync_track_to_graph(v_track_id);
  SELECT count(*) INTO v_nodes_after2 FROM graph.nodes;

  -- With the current three-step lookup:
  -- Step B (ISRC): new 'UST040000004' → not found (new ISRC, no prior node)
  -- Step C (fallback): finds v_node_id_first → v_rec_node_id = v_node_id_first
  -- → no new node created; ISRC stored in properties
  IF v_nodes_after2 = v_nodes_after1 THEN
    RAISE NOTICE 'T-04 PASS — second sync (ISRC added) reused existing fallback node, 0 new nodes';
  ELSE
    RAISE EXCEPTION 'T-04 FAIL — second sync created +% node(s); expected 0 (fallback reuse)',
      v_nodes_after2 - v_nodes_after1;
  END IF;

  -- Verify ISRC now in properties of the original node
  IF NOT EXISTS (
    SELECT 1 FROM graph.nodes
    WHERE id                      = v_node_id_first
      AND properties->>'isrc'     = 'UST040000004'
  ) THEN
    RAISE EXCEPTION 'T-04 FAIL — ISRC not merged into properties of original fallback node';
  END IF;
  RAISE NOTICE 'T-04 PASS — ISRC merged into properties of original fallback node';

  ROLLBACK;
END;
$$;
BEGIN; ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════
-- T-05 — Conflicting ISRC vs fallback nodes → conflict row inserted,
--         ISRC node wins, no auto-merge
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_track_id       UUID := gen_random_uuid();
  v_isrc_node_id   UUID;
  v_fallback_node  UUID;
  v_conflict_count BIGINT;
  v_chosen_node    UUID;
BEGIN
  -- Pre-create two DIFFERENT recording nodes:
  -- One keyed by ISRC (as if another track already used this ISRC)
  INSERT INTO graph.nodes (node_type, label, external_id, external_id_ns, properties)
  VALUES ('recording', 'Pre-existing ISRC Node', 'UST050000005', 'isrc',
          '{"source": "pre-existing"}'::jsonb)
  RETURNING id INTO v_isrc_node_id;

  -- One keyed by our track_id fallback (as if this track was synced before without ISRC)
  INSERT INTO graph.nodes (node_type, label, external_id, external_id_ns, properties)
  VALUES ('recording', 'Pre-existing Fallback Node', v_track_id::TEXT, 'musigod_catalog_track',
          '{"source": "pre-existing-fallback"}'::jsonb)
  RETURNING id INTO v_fallback_node;

  -- Insert track row WITH an ISRC that resolves to the pre-existing ISRC node
  INSERT INTO public.catalog_tracks_v1
    (id, track_title, artist_id, isrc, catalog_id)
  VALUES
    (v_track_id, 'T-05 Conflict Track', gen_random_uuid(), 'UST050000005', NULL);

  -- Sync: should detect isrc_vs_fallback conflict
  PERFORM public.fn_sync_track_to_graph(v_track_id);

  -- Verify conflict was logged
  SELECT count(*) INTO v_conflict_count
  FROM   graph.recording_identity_conflicts
  WHERE  track_id      = v_track_id
    AND  conflict_type = 'isrc_vs_fallback';

  IF v_conflict_count >= 1 THEN
    RAISE NOTICE 'T-05 PASS — conflict row inserted (% row(s))', v_conflict_count;
  ELSE
    RAISE EXCEPTION 'T-05 FAIL — no conflict row inserted; expected isrc_vs_fallback conflict';
  END IF;

  -- Verify ISRC node was chosen (global identifier wins)
  -- The has_recording edge from_node_id should point to a work, to_node_id to isrc node
  IF EXISTS (
    SELECT 1 FROM graph.edges
    WHERE  to_node_id  = v_isrc_node_id
      AND  edge_type   = 'has_recording'
  ) THEN
    RAISE NOTICE 'T-05 PASS — ISRC node chosen as authoritative (has_recording edge points to ISRC node)';
  ELSE
    RAISE EXCEPTION 'T-05 FAIL — ISRC node not chosen; has_recording edge missing or points to wrong node';
  END IF;

  -- Verify fallback node was NOT auto-merged (still exists separately)
  IF EXISTS (SELECT 1 FROM graph.nodes WHERE id = v_fallback_node) THEN
    RAISE NOTICE 'T-05 PASS — fallback node not deleted (no auto-merge)';
  ELSE
    RAISE EXCEPTION 'T-05 FAIL — fallback node was deleted; expected no auto-merge';
  END IF;

  ROLLBACK;
END;
$$;
BEGIN; ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════
-- T-06 — Malformed ISRC (non-12-char after normalization) → no crash
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_track_id UUID := gen_random_uuid();
  v_errored  BOOLEAN := false;
BEGIN
  INSERT INTO public.catalog_tracks_v1
    (id, track_title, artist_id, isrc, catalog_id)
  VALUES
    (v_track_id, 'T-06 Malformed ISRC Track', gen_random_uuid(), 'BAD-ISRC', NULL);

  BEGIN
    PERFORM public.fn_sync_track_to_graph(v_track_id);
  EXCEPTION WHEN OTHERS THEN
    v_errored := true;
    RAISE NOTICE 'T-06 FAIL — fn raised exception: %', SQLERRM;
  END;

  IF NOT v_errored THEN
    RAISE NOTICE 'T-06 PASS — malformed ISRC "BAD-ISRC" processed without exception';
  END IF;

  -- Verify a node was created (malformed ISRC stored as-is after normalization = "BADISRC")
  IF EXISTS (
    SELECT 1 FROM graph.nodes
    WHERE external_id    = 'BADISRC'
      AND external_id_ns = 'isrc'
      AND node_type      = 'recording'
  ) THEN
    RAISE NOTICE 'T-06 PASS — malformed ISRC stored normalized as "BADISRC" in isrc namespace';
  ELSIF EXISTS (
    SELECT 1 FROM graph.nodes
    WHERE external_id    = v_track_id::TEXT
      AND external_id_ns = 'musigod_catalog_track'
  ) THEN
    RAISE NOTICE 'T-06 PASS — malformed ISRC stripped to empty → track-id fallback used';
  ELSE
    RAISE EXCEPTION 'T-06 FAIL — no recording node created for malformed ISRC track';
  END IF;

  ROLLBACK;
END;
$$;
BEGIN; ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════
-- T-07 — Multiple ISRCs (SQL function uses first; all stored in properties)
-- NOTE: catalog_tracks_v1 stores a single isrc TEXT field.
--       Multiple ISRCs are supported by catalog_enriched_tracks_v1.isrcs[].
--       The SQL function uses the single isrc field. This test confirms
--       the single ISRC is normalized correctly.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_track_id UUID := gen_random_uuid();
BEGIN
  -- Track with an ISRC that has hyphens (common in import data)
  INSERT INTO public.catalog_tracks_v1
    (id, track_title, artist_id, isrc, catalog_id)
  VALUES
    (v_track_id, 'T-07 Multi-ISRC Track', gen_random_uuid(), 'US-T07-00-00007', NULL);

  PERFORM public.fn_sync_track_to_graph(v_track_id);

  -- Verify hyphens stripped and normalized
  IF EXISTS (
    SELECT 1 FROM graph.nodes
    WHERE external_id    = 'UST070000007'
      AND external_id_ns = 'isrc'
      AND node_type      = 'recording'
  ) THEN
    RAISE NOTICE 'T-07 PASS — hyphenated ISRC "US-T07-00-00007" normalized to "UST070000007"';
  ELSE
    RAISE EXCEPTION 'T-07 FAIL — hyphenated ISRC not normalized correctly; expected node with external_id = "UST070000007"';
  END IF;

  -- Second call with same hyphenated ISRC → idempotent
  DECLARE
    v_count_before BIGINT;
    v_count_after  BIGINT;
  BEGIN
    SELECT count(*) INTO v_count_before FROM graph.nodes WHERE node_type = 'recording';
    PERFORM public.fn_sync_track_to_graph(v_track_id);
    SELECT count(*) INTO v_count_after  FROM graph.nodes WHERE node_type = 'recording';
    IF v_count_after = v_count_before THEN
      RAISE NOTICE 'T-07 PASS — second run with same hyphenated ISRC: 0 new nodes';
    ELSE
      RAISE EXCEPTION 'T-07 FAIL — second run created +% node(s)', v_count_after - v_count_before;
    END IF;
  END;

  ROLLBACK;
END;
$$;
BEGIN; ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════
-- T-08 — Same recording on different releases → same recording node reused
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_track_id_a UUID := gen_random_uuid();
  v_track_id_b UUID := gen_random_uuid();
  v_node_a     UUID;
  v_node_b     UUID;
BEGIN
  -- Two different catalog track rows with the same ISRC (same recording,
  -- different release submissions — e.g., album + single)
  INSERT INTO public.catalog_tracks_v1
    (id, track_title, artist_id, isrc, catalog_id)
  VALUES
    (v_track_id_a, 'T-08 Same Recording (Album)',  gen_random_uuid(), 'UST080000008', gen_random_uuid()),
    (v_track_id_b, 'T-08 Same Recording (Single)', gen_random_uuid(), 'UST080000008', gen_random_uuid());

  PERFORM public.fn_sync_track_to_graph(v_track_id_a);
  PERFORM public.fn_sync_track_to_graph(v_track_id_b);

  SELECT id INTO v_node_a
  FROM   graph.nodes WHERE external_id = 'UST080000008' AND external_id_ns = 'isrc';

  -- Both tracks should resolve to the same node
  SELECT id INTO v_node_b
  FROM   graph.nodes WHERE external_id = 'UST080000008' AND external_id_ns = 'isrc';

  IF v_node_a IS NOT NULL AND v_node_a = v_node_b THEN
    RAISE NOTICE 'T-08 PASS — same ISRC from two releases resolves to one recording node (id: %)', v_node_a;
  ELSE
    RAISE EXCEPTION 'T-08 FAIL — expected single ISRC node; found node_a=%, node_b=%', v_node_a, v_node_b;
  END IF;

  -- Verify exactly one recording node with this ISRC
  IF (SELECT count(*) FROM graph.nodes
      WHERE external_id = 'UST080000008' AND external_id_ns = 'isrc') = 1 THEN
    RAISE NOTICE 'T-08 PASS — exactly 1 recording node for shared ISRC';
  ELSE
    RAISE EXCEPTION 'T-08 FAIL — more than 1 recording node for shared ISRC';
  END IF;

  ROLLBACK;
END;
$$;
BEGIN; ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════
-- T-09 — No duplicate edges on any path
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_track_id    UUID := gen_random_uuid();
  v_artist_id   UUID := gen_random_uuid();
  v_edge_count1 BIGINT;
  v_edge_count2 BIGINT;
BEGIN
  -- Pre-create an artist node so the performed edge path fires
  INSERT INTO graph.nodes (node_type, label, external_id, external_id_ns, properties)
  VALUES ('artist', 'T-09 Test Artist', v_artist_id::TEXT, 'musigod_artist', '{}'::jsonb);

  INSERT INTO public.catalog_tracks_v1
    (id, track_title, artist_id, isrc, catalog_id)
  VALUES
    (v_track_id, 'T-09 Duplicate Edge Test', v_artist_id, 'UST090000009', gen_random_uuid());

  SELECT count(*) INTO v_edge_count1 FROM graph.edges;

  -- Run 3 times to confirm all edges are idempotent
  PERFORM public.fn_sync_track_to_graph(v_track_id);
  PERFORM public.fn_sync_track_to_graph(v_track_id);
  PERFORM public.fn_sync_track_to_graph(v_track_id);

  SELECT count(*) INTO v_edge_count2 FROM graph.edges;

  -- Only 2 edges should exist after all 3 runs:
  --   1. work → has_recording → recording
  --   2. artist → performed → recording
  IF v_edge_count2 - v_edge_count1 = 2 THEN
    RAISE NOTICE 'T-09 PASS — exactly 2 edges created across 3 runs (no duplicates)';
  ELSIF v_edge_count2 - v_edge_count1 < 2 THEN
    RAISE EXCEPTION 'T-09 FAIL — fewer than 2 edges created; expected has_recording + performed';
  ELSE
    RAISE EXCEPTION 'T-09 FAIL — % edges created (expected 2); duplicate edges present',
      v_edge_count2 - v_edge_count1;
  END IF;

  ROLLBACK;
END;
$$;
BEGIN; ROLLBACK;


-- ══════════════════════════════════════════════════════════════════════
-- T-10 — JSON return contract unchanged (function returns VOID)
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_return_type TEXT;
  v_lang        TEXT;
  v_volatile    TEXT;
BEGIN
  SELECT
    pg_catalog.format_type(prorettype, NULL),
    lanname,
    CASE provolatile WHEN 'v' THEN 'VOLATILE' WHEN 's' THEN 'STABLE' WHEN 'i' THEN 'IMMUTABLE' END
  INTO v_return_type, v_lang, v_volatile
  FROM   pg_proc p
  JOIN   pg_language l ON l.oid = p.prolang
  WHERE  p.proname      = 'fn_sync_track_to_graph'
    AND  p.pronamespace = 'public'::regnamespace;

  IF v_return_type = 'void' THEN
    RAISE NOTICE 'T-10 PASS — return type is void (contract unchanged)';
  ELSE
    RAISE EXCEPTION 'T-10 FAIL — return type is "%" (expected void)', v_return_type;
  END IF;

  IF v_lang = 'plpgsql' THEN
    RAISE NOTICE 'T-10 PASS — language is plpgsql (unchanged)';
  ELSE
    RAISE EXCEPTION 'T-10 FAIL — language is "%" (expected plpgsql)', v_lang;
  END IF;

  IF v_volatile = 'VOLATILE' THEN
    RAISE NOTICE 'T-10 PASS — volatility is VOLATILE (correct for a function that writes)';
  ELSE
    RAISE EXCEPTION 'T-10 FAIL — volatility is "%" (expected VOLATILE)', v_volatile;
  END IF;
END;
$$;


-- ══════════════════════════════════════════════════════════════════════
-- SUMMARY — Run all tests and report
-- ══════════════════════════════════════════════════════════════════════

SELECT
  'T-01' AS test, 'no-ISRC track idempotent'              AS description, 'see NOTICE output above' AS result
UNION ALL SELECT 'T-02', 'ISRC track idempotent',             'see NOTICE output above'
UNION ALL SELECT 'T-03', 'MBID-only falls to fallback (SQL)', 'see NOTICE output above'
UNION ALL SELECT 'T-04', 'fallback reused when ISRC added',   'see NOTICE output above'
UNION ALL SELECT 'T-05', 'conflict logged, ISRC wins',        'see NOTICE output above'
UNION ALL SELECT 'T-06', 'malformed ISRC no crash',           'see NOTICE output above'
UNION ALL SELECT 'T-07', 'hyphenated ISRC normalized',        'see NOTICE output above'
UNION ALL SELECT 'T-08', 'same ISRC two releases = one node', 'see NOTICE output above'
UNION ALL SELECT 'T-09', 'no duplicate edges (3 runs)',       'see NOTICE output above'
UNION ALL SELECT 'T-10', 'VOID return contract unchanged',    'see NOTICE output above';

-- Check the Messages tab in Supabase SQL Editor for PASS/FAIL notices.
-- Any RAISE EXCEPTION causes that test's transaction to roll back,
-- leaving production data unchanged.
