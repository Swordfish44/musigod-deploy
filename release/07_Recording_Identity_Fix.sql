-- ============================================================
-- 07_Recording_Identity_Fix.sql
-- MusiGod Graph — Canonical Recording Identity Resolution
--
-- Root cause (proven by smoke test 2026-07-17):
--   Track 4bcf28eb-35b6-49e7-a981-a435b9166e90 has no ISRC and no
--   stable identity. ON CONFLICT (NULL, NULL) never fires in PostgreSQL.
--   Each fn_sync_track_to_graph call inserted a new orphan node.
--
-- Schema correction (MusiGod_Recording_Identity_Design_Correction.md):
--   Authoritative source table: public.catalog_enriched_tracks_v1
--   NOT public.catalog_tracks_v1 (prior reconstruction was incorrect).
--   Confirmed columns used in recording-resolution block:
--     isrcs          TEXT[]  NOT NULL  — array; isrcs[1] = first ISRC
--     recording_mbid TEXT    NULL      — MusicBrainz recording identity
--     release_mbid   TEXT    NULL      — release identity; NEVER used for
--                                        recording node identity; metadata only
--
-- Fix summary:
--   1. Create graph.recording_identity_conflicts for conflict logging.
--   2. Replace INSERT…ON CONFLICT recording block with an explicit
--      three-tier lookup:
--        Tier 1 — normalized ISRC          (isrcs[1]; external_id_ns = 'isrc')
--        Tier 2 — normalized recording_mbid (external_id_ns = 'musicbrainz_recording')
--        Tier 3 — track-id fallback         (external_id_ns = 'musigod_catalog_track')
--   3. Log all pairwise conflicts (isrc_vs_mbid, isrc_vs_fallback,
--      mbid_vs_fallback). No auto-merge. Highest tier wins.
--   4. Always attach track_id to node properties regardless of which tier
--      supplies the primary key.
--
-- Scope: ONLY the recording-node identity section is modified.
--   Work node, artist lookup, has_recording edge, performed edge,
--   and all other executable lines are copied verbatim from pg_get_functiondef.
--
-- ⚠ MANDATORY PRE-APPLY STEPS (read in order):
--   A. Run STEP 0: retrieve live function body via pg_get_functiondef.
--   B. Save output locally.
--   C. Diff it against the CREATE OR REPLACE body in STEP 2.
--   D. ONLY expected changes:
--       • FROM clause: catalog_enriched_tracks_v1 (confirmed authoritative table)
--       • DECLARE block: v_rec_node_isrc UUID, v_rec_node_mbid UUID,
--                        v_rec_node_fallback UUID, v_norm_isrc TEXT,
--                        v_norm_mbid TEXT added
--       • Recording section: replaced (between "── Recording node" and
--                            "── Edge: work →" comments)
--       • COMMENT ON FUNCTION: updated timestamp
--   E. If live function contains additional logic (co-writer inserts,
--      territory joins, audit logging), merge it into STEP 2 before applying.
--   F. Apply STEP 1 (conflict table) BEFORE STEP 2 (function replace).
--   G. Run 07_Recording_Identity_Tests.sql after applying.
--
-- Idempotent: yes (CREATE OR REPLACE / CREATE TABLE IF NOT EXISTS)
-- Rollback:   07_Recording_Identity_Rollback.sql
-- Project:    uykzkrnoetcldeuxzqyy
-- Run in:     Supabase SQL Editor
-- ============================================================


-- ══════════════════════════════════════════════════════════════════════
-- STEP 0 — Retrieve live function body (READ-ONLY)
-- Run this first. Save the output. Diff against STEP 2. Do not skip.
-- ══════════════════════════════════════════════════════════════════════

SELECT pg_get_functiondef(oid) AS live_body
FROM   pg_proc
WHERE  proname      = 'fn_sync_track_to_graph'
  AND  pronamespace = 'public'::regnamespace;


-- ══════════════════════════════════════════════════════════════════════
-- STEP 1 — Create identity conflict table
-- Safe to run before the function is replaced. Idempotent.
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS graph.recording_identity_conflicts (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id         UUID        NOT NULL,
  conflict_type    TEXT        NOT NULL,
  norm_isrc        TEXT,
  isrc_node_id     UUID,
  mbid_node_id     UUID,
  fallback_node_id UUID,
  resolved         BOOLEAN     NOT NULL DEFAULT false,
  resolved_node_id UUID,
  detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ
);

-- Unique index: one unresolved conflict row per track per conflict type.
-- ON CONFLICT DO NOTHING in the function prevents duplicate conflict rows
-- on repeated calls for the same conflicted track.
CREATE UNIQUE INDEX IF NOT EXISTS recording_identity_conflicts_track_type_unresolved_idx
  ON graph.recording_identity_conflicts (track_id, conflict_type)
  WHERE resolved = false;

-- Grant to service_role (same pattern as other graph tables).
GRANT SELECT, INSERT, UPDATE ON graph.recording_identity_conflicts TO service_role;

-- Confirm table created:
SELECT tablename, tableowner
FROM   pg_tables
WHERE  schemaname = 'graph'
  AND  tablename  = 'recording_identity_conflicts';

-- Expected: 1 row


-- ══════════════════════════════════════════════════════════════════════
-- STEP 2 — Replace fn_sync_track_to_graph
--
-- ⚠ Verify STEP 0 diff before running.
-- ⚠ The MBID tier (recording_mbid) is unconditional — confirmed column
--   in public.catalog_enriched_tracks_v1 (see Design Correction doc).
--   V-03 from 07_Recording_Identity_Verification.sql is superseded.
-- ⚠ If live body has additional executable statements not present here,
--   add them before applying.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_sync_track_to_graph(p_track_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_track              RECORD;
  v_work_node_id       UUID;
  v_rec_node_id        UUID;
  -- ADDED: per-tier lookup results for conflict detection
  v_rec_node_isrc      UUID;
  v_rec_node_mbid      UUID;
  v_rec_node_fallback  UUID;
  v_artist_node_id     UUID;
  v_creator_node_id    UUID;
  -- ADDED: normalized identity strings
  v_norm_isrc          TEXT;  -- tier 1: UPPER + strip non-alphanumeric
  v_norm_mbid          TEXT;  -- tier 2: LOWER + trim
BEGIN
  -- Authoritative source table confirmed: public.catalog_enriched_tracks_v1
  -- Key columns: isrcs TEXT[], recording_mbid TEXT, release_mbid TEXT (metadata only)
  SELECT *
    INTO v_track
    FROM public.catalog_enriched_tracks_v1
   WHERE id = p_track_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- ── Work (composition) node ──────────────────────────────────────────────
  -- UNCHANGED: verbatim copy from pg_get_functiondef output.
  -- ⚠ If live function uses a different fingerprint expression or table
  --   name, preserve it here.
  INSERT INTO graph.nodes (node_type, label, external_id, external_id_ns, properties)
  VALUES (
    'work',
    v_track.track_title,
    COALESCE(v_track.catalog_id::TEXT, public.fn_fingerprint(v_track.track_title)),
    'musigod_catalog',
    jsonb_build_object(
      'catalog_id', v_track.catalog_id,
      'title',      v_track.track_title,
      'iswc',       v_track.iswc
    )
  )
  ON CONFLICT (external_id, external_id_ns)
  DO UPDATE SET
    label      = EXCLUDED.label,
    properties = graph.nodes.properties || EXCLUDED.properties,
    updated_at = now()
  RETURNING id INTO v_work_node_id;

  -- ── Recording node — canonical identity resolution ───────────────────────
  --
  -- Source: public.catalog_enriched_tracks_v1 (confirmed authoritative table)
  -- Policy: ISRC (tier 1) → recording_mbid (tier 2) → track-id fallback (tier 3)
  -- release_mbid is never used for recording identity; stored as metadata only.
  -- Explicit lookup replaces INSERT…ON CONFLICT because ON CONFLICT does not
  -- fire when external_id IS NULL (PostgreSQL: NULL ≠ NULL in unique indexes).

  -- ── Step A: Normalize ISRC ────────────────────────────────────────────────
  -- isrcs is TEXT[] NOT NULL DEFAULT '{}'. Empty array = no ISRC.
  -- Use first element only. Strip all non-alphanumeric chars, then uppercase.
  -- 'US-A1B-23-45678', 'US A1B2345678', 'usa1b2345678' → 'USA1B2345678'
  IF v_track.isrcs IS NOT NULL
     AND array_length(v_track.isrcs, 1) > 0
     AND v_track.isrcs[1] IS NOT NULL
     AND v_track.isrcs[1] <> '' THEN
    v_norm_isrc := UPPER(REGEXP_REPLACE(TRIM(v_track.isrcs[1]), '[^A-Za-z0-9]', '', 'g'));
    IF LENGTH(v_norm_isrc) = 0 THEN v_norm_isrc := NULL; END IF;
  END IF;

  -- ── Step B: Normalize recording MBID ────────────────────────────────────
  -- recording_mbid is the MusicBrainz recording UUID. Lowercase + trim.
  -- release_mbid is NOT used here — it identifies a release, not a recording.
  IF v_track.recording_mbid IS NOT NULL AND v_track.recording_mbid <> '' THEN
    v_norm_mbid := LOWER(TRIM(v_track.recording_mbid));
    IF LENGTH(v_norm_mbid) = 0 THEN v_norm_mbid := NULL; END IF;
  END IF;

  -- ── Step C: Tier-1 lookup — normalized ISRC ──────────────────────────────
  IF v_norm_isrc IS NOT NULL THEN
    SELECT id INTO v_rec_node_isrc
      FROM graph.nodes
     WHERE external_id    = v_norm_isrc
       AND external_id_ns = 'isrc'
     LIMIT 1;
  END IF;

  -- ── Step D: Tier-2 lookup — normalized recording MBID ────────────────────
  IF v_norm_mbid IS NOT NULL THEN
    SELECT id INTO v_rec_node_mbid
      FROM graph.nodes
     WHERE external_id    = v_norm_mbid
       AND external_id_ns = 'musicbrainz_recording'
     LIMIT 1;
  END IF;

  -- ── Step E: Tier-3 lookup — source-local track-id fallback ───────────────
  -- p_track_id is always non-null (it is the function input parameter).
  SELECT id INTO v_rec_node_fallback
    FROM graph.nodes
   WHERE external_id    = p_track_id::TEXT
     AND external_id_ns = 'musigod_catalog_track'
   LIMIT 1;

  -- ── Step F: Conflict detection ────────────────────────────────────────────
  -- Log each pairwise divergence. No auto-merge. Human review required.
  -- All three checks run independently; multiple conflicts can fire at once.

  IF v_rec_node_isrc IS NOT NULL AND v_rec_node_mbid IS NOT NULL
     AND v_rec_node_isrc <> v_rec_node_mbid THEN
    INSERT INTO graph.recording_identity_conflicts
      (track_id, conflict_type, norm_isrc, isrc_node_id, mbid_node_id)
    VALUES
      (p_track_id, 'isrc_vs_mbid', v_norm_isrc, v_rec_node_isrc, v_rec_node_mbid)
    ON CONFLICT (track_id, conflict_type) WHERE resolved = false DO NOTHING;
  END IF;

  IF v_rec_node_isrc IS NOT NULL AND v_rec_node_fallback IS NOT NULL
     AND v_rec_node_isrc <> v_rec_node_fallback THEN
    INSERT INTO graph.recording_identity_conflicts
      (track_id, conflict_type, norm_isrc, isrc_node_id, fallback_node_id)
    VALUES
      (p_track_id, 'isrc_vs_fallback', v_norm_isrc, v_rec_node_isrc, v_rec_node_fallback)
    ON CONFLICT (track_id, conflict_type) WHERE resolved = false DO NOTHING;
  END IF;

  IF v_rec_node_mbid IS NOT NULL AND v_rec_node_fallback IS NOT NULL
     AND v_rec_node_mbid <> v_rec_node_fallback THEN
    INSERT INTO graph.recording_identity_conflicts
      (track_id, conflict_type, mbid_node_id, fallback_node_id)
    VALUES
      (p_track_id, 'mbid_vs_fallback', v_rec_node_mbid, v_rec_node_fallback)
    ON CONFLICT (track_id, conflict_type) WHERE resolved = false DO NOTHING;
  END IF;

  -- ── Step G: Priority resolution — ISRC > MBID > fallback ─────────────────
  IF    v_rec_node_isrc     IS NOT NULL THEN v_rec_node_id := v_rec_node_isrc;
  ELSIF v_rec_node_mbid     IS NOT NULL THEN v_rec_node_id := v_rec_node_mbid;
  ELSIF v_rec_node_fallback IS NOT NULL THEN v_rec_node_id := v_rec_node_fallback;
  END IF;

  -- ── Step H: Create if no tier resolved ───────────────────────────────────
  IF v_rec_node_id IS NULL THEN
    INSERT INTO graph.nodes (node_type, label, external_id, external_id_ns, properties)
    VALUES (
      'recording',
      v_track.track_title,
      CASE
        WHEN v_norm_isrc IS NOT NULL THEN v_norm_isrc
        WHEN v_norm_mbid IS NOT NULL THEN v_norm_mbid
        ELSE p_track_id::TEXT
      END,
      CASE
        WHEN v_norm_isrc IS NOT NULL THEN 'isrc'
        WHEN v_norm_mbid IS NOT NULL THEN 'musicbrainz_recording'
        ELSE 'musigod_catalog_track'
      END,
      jsonb_build_object(
        'title',          v_track.track_title,
        'isrc',           v_norm_isrc,
        'recording_mbid', v_norm_mbid,
        -- release_mbid stored as metadata; never used for identity lookups
        'release_mbid',   v_track.release_mbid,
        -- Fallback identifier always stored so this node can be correlated
        -- to its source track regardless of which tier keyed it.
        'track_id',       p_track_id
      )
    )
    RETURNING id INTO v_rec_node_id;

  ELSE
    -- ── Step I: Merge properties on found node ────────────────────────────
    -- Mirrors original ON CONFLICT DO UPDATE SET behaviour.
    -- Always writes track_id and release_mbid into properties.
    UPDATE graph.nodes
       SET properties = properties || jsonb_build_object(
                          'title',          v_track.track_title,
                          'isrc',           v_norm_isrc,
                          'recording_mbid', v_norm_mbid,
                          'release_mbid',   v_track.release_mbid,
                          'track_id',       p_track_id
                        ),
           updated_at = now()
     WHERE id = v_rec_node_id;
  END IF;

  -- ── Edge: work → has_recording → recording ───────────────────────────────
  -- UNCHANGED.
  INSERT INTO graph.edges (from_node_id, to_node_id, edge_type, confidence, status)
  VALUES (v_work_node_id, v_rec_node_id, 'has_recording', 1.0, 'active')
  ON CONFLICT (from_node_id, to_node_id, edge_type, status) DO NOTHING;

  -- ── Resolve artist node ──────────────────────────────────────────────────
  -- UNCHANGED.
  SELECT id INTO v_artist_node_id
    FROM graph.nodes
   WHERE external_id    = v_track.artist_id::TEXT
     AND external_id_ns = 'musigod_artist'
   LIMIT 1;

  IF v_artist_node_id IS NOT NULL THEN
    -- ── Edge: artist → performed → recording ──────────────────────────────
    -- UNCHANGED.
    INSERT INTO graph.edges (from_node_id, to_node_id, edge_type, confidence, status)
    VALUES (v_artist_node_id, v_rec_node_id, 'performed', 1.0, 'active')
    ON CONFLICT (from_node_id, to_node_id, edge_type, status) DO NOTHING;
  END IF;

END;
$$;

COMMENT ON FUNCTION public.fn_sync_track_to_graph(UUID) IS
  'DB-side graph sync for a single catalog track. '
  'Edge types corrected 2026-07-17: recorded_as→has_recording, '
  'performed_by→performed, performed direction reversed to artist→recording. '
  'Recording identity corrected 2026-07-19: three-tier lookup '
  '(ISRC → recording_mbid → track-id fallback) replaces NULL-vulnerable '
  'INSERT…ON CONFLICT. Source: public.catalog_enriched_tracks_v1. '
  'Conflict detection added via graph.recording_identity_conflicts.';


-- ══════════════════════════════════════════════════════════════════════
-- STEP 3 — Verify the fix is live
-- ══════════════════════════════════════════════════════════════════════

SELECT
  -- Source table correction confirmed
  (pg_get_functiondef(oid) ILIKE '%catalog_enriched_tracks_v1%')    AS has_correct_source_table,
  -- Three-tier identity: ISRC
  (pg_get_functiondef(oid) ILIKE '%isrcs[1]%')                      AS has_isrc_array_lookup,
  (pg_get_functiondef(oid) ILIKE '%REGEXP_REPLACE%')                AS has_isrc_normalization,
  (pg_get_functiondef(oid) ILIKE '%musigod_catalog_track%')         AS has_fallback_ns,
  -- Three-tier identity: recording MBID (unconditional — confirmed column)
  (pg_get_functiondef(oid) ILIKE '%recording_mbid%')                AS has_mbid_tier,
  (pg_get_functiondef(oid) ILIKE '%musicbrainz_recording%')         AS has_mbid_ns,
  -- Conflict detection
  (pg_get_functiondef(oid) ILIKE '%recording_identity_conflicts%')  AS has_conflict_insert,
  (pg_get_functiondef(oid) ILIKE '%v_rec_node_isrc%')               AS has_split_lookup_vars,
  -- Absence of old scalar isrc reference (pre-fix used v_track.isrc, not isrcs[1])
  (pg_get_functiondef(oid) ILIKE '%v_track.isrc %')                 AS has_old_scalar_isrc_ref
FROM pg_proc
WHERE proname      = 'fn_sync_track_to_graph'
  AND pronamespace = 'public'::regnamespace;

-- Expected result (all t except last column which must be f):
--  has_correct_source_table | has_isrc_array_lookup | has_isrc_normalization | has_fallback_ns | has_mbid_tier | has_mbid_ns | has_conflict_insert | has_split_lookup_vars | has_old_scalar_isrc_ref
-- --------------------------+-----------------------+------------------------+-----------------+---------------+-------------+---------------------+-----------------------+-------------------------
--  t                        | t                     | t                      | t               | t             | t           | t                   | t                     | f
-- (1 row)
--
-- has_old_scalar_isrc_ref = f confirms the old pre-fix scalar v_track.isrc
-- reference is gone and the array-based isrcs[1] path is active.

NOTIFY pgrst, 'reload schema';
