-- supabase/migrations/20260722_rpc_recording_enrichment_v2.sql
--
-- Replaces the original rpc_upsert_recording_enrichment (7-param signature)
-- with a new signature that owns identity lookup + upsert atomically inside
-- the SECURITY DEFINER function.
--
-- ROOT CAUSE FIXED: The JS-level duplicate-row guard called findNodeByExternalId()
-- which sent GET /rest/v1/nodes with Accept-Profile: graph. Since graph is not in
-- PostgREST db-schemas, that returned 406, causing 12/22 tracks to fail per run.
--
-- NEW DESIGN: JS passes all three identity keys. The RPC resolves priority
-- (ISRC > recording_mbid > catalog_track_id) inside Postgres, where it has
-- direct access to graph.nodes without going through PostgREST schema routing.
--
-- Old signature: (TEXT,TEXT,TEXT,JSONB,JSONB,UUID,UUID)
-- New signature: (TEXT,TEXT,TEXT,TEXT,JSONB,UUID)
--
-- Prerequisite: 20260721_graph_rls_lockdown.sql must have been applied first.
-- Idempotent: DROP IF EXISTS + CREATE OR REPLACE + REVOKE are all safe to re-run.

-- Do NOT wrap in BEGIN/COMMIT. Supabase SQL Editor wraps each run in its own
-- implicit transaction; an explicit BEGIN inside it is a no-op (PG warns
-- "there is already a transaction in progress"), and an explicit COMMIT
-- prematurely commits the editor's outer transaction, leaving subsequent
-- statements without a transaction to roll back into on failure.
-- The editor's implicit transaction provides the same atomicity guarantee.

-- Create new 6-param function FIRST so the old never disappears before the new exists.
CREATE OR REPLACE FUNCTION public.rpc_upsert_recording_enrichment(
  p_label               TEXT,
  p_isrc                TEXT          DEFAULT NULL,
  p_recording_mbid      TEXT          DEFAULT NULL,
  p_catalog_track_id    TEXT          DEFAULT NULL,
  p_node_properties     JSONB         DEFAULT '{}'::JSONB,
  p_composition_node_id UUID          DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog,graph,works
AS $$
DECLARE
  v_node_id   UUID;
  v_norm_isrc TEXT;
  v_ext_id    TEXT;
  v_ext_ns    TEXT;
BEGIN
  -- Normalize ISRC: uppercase, strip whitespace, treat empty/whitespace-only as NULL
  v_norm_isrc := NULLIF(upper(trim(COALESCE(p_isrc, ''))), '');

  -- ── Identity lookup: ISRC → recording_mbid → catalog_track_id ────────────────
  --
  -- Reuse an existing node when any of the three keys already exists in graph.nodes.
  -- This prevents duplicate recording nodes when enrichment adds an ISRC to a track
  -- that was previously keyed by MBID or catalog_id. The function has direct access
  -- to graph.nodes because it runs as SECURITY DEFINER inside Postgres — no schema
  -- routing header required.
  --
  -- Priority for LOOKUP: check in order ISRC > MBID > catalog.
  -- An existing node's external_id/ns is never changed; only works.recordings is updated.

  IF v_norm_isrc IS NOT NULL THEN
    SELECT id INTO v_node_id
    FROM graph.nodes
    WHERE external_id = v_norm_isrc
      AND external_id_ns = 'isrc'
    LIMIT 1;
  END IF;

  IF v_node_id IS NULL
     AND p_recording_mbid IS NOT NULL
     AND p_recording_mbid <> ''
  THEN
    SELECT id INTO v_node_id
    FROM graph.nodes
    WHERE external_id = p_recording_mbid
      AND external_id_ns = 'musicbrainz_recording'
    LIMIT 1;
  END IF;

  IF v_node_id IS NULL
     AND p_catalog_track_id IS NOT NULL
     AND p_catalog_track_id <> ''
  THEN
    SELECT id INTO v_node_id
    FROM graph.nodes
    WHERE external_id = ('rec_' || p_catalog_track_id)
      AND external_id_ns = 'musigod_catalog'
    LIMIT 1;
  END IF;

  -- ── Node upsert (only when no existing node was found) ───────────────────────
  --
  -- Canonical insertion key uses the same ISRC > MBID > catalog priority.
  -- ON CONFLICT handles concurrent inserts safely; RETURNING always sets v_node_id.

  IF v_node_id IS NULL THEN
    IF v_norm_isrc IS NOT NULL THEN
      v_ext_id := v_norm_isrc;
      v_ext_ns := 'isrc';
    ELSIF p_recording_mbid IS NOT NULL AND p_recording_mbid <> '' THEN
      v_ext_id := p_recording_mbid;
      v_ext_ns := 'musicbrainz_recording';
    ELSIF p_catalog_track_id IS NOT NULL AND p_catalog_track_id <> '' THEN
      v_ext_id := 'rec_' || p_catalog_track_id;
      v_ext_ns := 'musigod_catalog';
    ELSE
      -- No identity provided: refuse to create an anonymous recording node.
      RETURN jsonb_build_object(
        'error',   'no_identity',
        'message', 'At least one of p_isrc, p_recording_mbid, or p_catalog_track_id must be provided'
      );
    END IF;

    INSERT INTO graph.nodes (node_type, label, external_id, external_id_ns, properties)
    VALUES (
      'recording',
      p_label,
      v_ext_id,
      v_ext_ns,
      COALESCE(p_node_properties, '{}')
    )
    ON CONFLICT (external_id, external_id_ns) DO UPDATE SET
      label      = EXCLUDED.label,
      properties = graph.nodes.properties || EXCLUDED.properties,
      updated_at = now()
    RETURNING id INTO v_node_id;
  END IF;

  -- ── works.recordings upsert ───────────────────────────────────────────────────
  --
  -- COALESCE on every column: a later enrichment run never clobbers data that a
  -- prior run already wrote. NULL passed for a field = "no update for this column".

  INSERT INTO works.recordings (
    node_id,
    title,
    isrc,
    musicbrainz_recording_id,
    composition_node_id
  )
  VALUES (
    v_node_id,
    p_label,
    v_norm_isrc,
    NULLIF(p_recording_mbid, '')::uuid,
    p_composition_node_id
  )
  ON CONFLICT (node_id) DO UPDATE SET
    title                    = COALESCE(EXCLUDED.title,                    works.recordings.title),
    isrc                     = COALESCE(EXCLUDED.isrc,                     works.recordings.isrc),
    musicbrainz_recording_id = COALESCE(EXCLUDED.musicbrainz_recording_id, works.recordings.musicbrainz_recording_id),
    composition_node_id      = COALESCE(EXCLUDED.composition_node_id,      works.recordings.composition_node_id),
    updated_at               = now();

  RETURN jsonb_build_object('node_id', v_node_id);
END;
$$;

-- Drop old overload AFTER new function is created so there is never a window
-- where neither signature exists. Different param lists = different functions in PG.
DROP FUNCTION IF EXISTS public.rpc_upsert_recording_enrichment(TEXT,TEXT,TEXT,JSONB,JSONB,UUID,UUID);

-- Supabase auto-grants EXECUTE on public functions to anon + authenticated.
-- REVOKE FROM PUBLIC alone does not remove those individual grants.
REVOKE EXECUTE ON FUNCTION public.rpc_upsert_recording_enrichment(TEXT,TEXT,TEXT,TEXT,JSONB,UUID)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rpc_upsert_recording_enrichment(TEXT,TEXT,TEXT,TEXT,JSONB,UUID)
  FROM anon;
REVOKE EXECUTE ON FUNCTION public.rpc_upsert_recording_enrichment(TEXT,TEXT,TEXT,TEXT,JSONB,UUID)
  FROM authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_upsert_recording_enrichment(TEXT,TEXT,TEXT,TEXT,JSONB,UUID)
  TO service_role;

NOTIFY pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- Post-apply verification
-- ─────────────────────────────────────────────────────────────────────────────
-- Run in SQL Editor after applying:
--
-- 1. Confirm old 7-param overload is gone, new 6-param overload exists:
-- SELECT proname, pronargs, pg_get_function_arguments(oid) AS args
-- FROM pg_proc
-- WHERE proname = 'rpc_upsert_recording_enrichment' AND pronamespace = 'public'::regnamespace;
-- EXPECT: 1 row, 6 args: p_label text, p_isrc text, p_recording_mbid text, p_catalog_track_id text, p_node_properties jsonb, p_composition_node_id uuid
--
-- 2. Confirm grants: service_role only
-- SELECT a.grantee, a.privilege_type
-- FROM pg_proc p,
--      LATERAL aclexplode(COALESCE(p.proacl, acldefault('f'::"char", p.proowner))) a
-- WHERE p.proname = 'rpc_upsert_recording_enrichment'
--   AND p.pronamespace = 'public'::regnamespace;
-- EXPECT: service_role | EXECUTE, postgres | EXECUTE (no anon, no authenticated)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback
-- ─────────────────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.rpc_upsert_recording_enrichment(TEXT,TEXT,TEXT,TEXT,JSONB,UUID);
-- NOTIFY pgrst, 'reload schema';
-- Then re-apply 20260721_graph_rls_lockdown.sql to restore the original.
