-- supabase/migrations/20260721_graph_rls_lockdown.sql
--
-- Preflight run 2026-07-21 confirmed the following are already in production:
--   • anon and authenticated hold zero SELECT grants on graph or works schemas
--   • graph.graph_upsert_node and graph.graph_upsert_edge already have
--     search_path pinned (proconfig = 'search_path=graph, pg_catalog')
--   • PUBLIC EXECUTE on both graph functions already revoked
--
-- Only the public service-role RPC is missing. That is the sole change here.
--
-- Idempotent: CREATE OR REPLACE; REVOKE on a non-existent grant is a no-op.
-- Apply in: Supabase SQL Editor
-- Prerequisite: none — all schema grants and function hardening pre-exist.

-- ─────────────────────────────────────────────────────────────────────────────
-- Single public RPC for the enrichment write path
-- ─────────────────────────────────────────────────────────────────────────────
-- Atomically:
--   (a) upsert a 'recording' node in graph.nodes, OR accept a known node_id
--       from the JS-level duplicate-row guard (p_existing_node_id).
--   (b) upsert the corresponding row in works.recordings, using COALESCE so
--       a later enrichment run never clobbers data written by an earlier one.
--
-- Called only by api/graph-sync.js::upsertRecordingEnrichment().
-- REVOKE from PUBLIC first; Postgres grants EXECUTE to PUBLIC by default on
-- new functions.

CREATE OR REPLACE FUNCTION public.rpc_upsert_recording_enrichment(
  p_label               TEXT,
  p_external_id         TEXT          DEFAULT NULL,
  p_external_id_ns      TEXT          DEFAULT NULL,
  p_node_properties     JSONB         DEFAULT '{}'::JSONB,
  p_recording_patch     JSONB         DEFAULT '{}'::JSONB,
  p_composition_node_id UUID          DEFAULT NULL,
  p_existing_node_id    UUID          DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog,graph,works
AS $$
DECLARE
  v_node_id UUID;
BEGIN
  IF p_existing_node_id IS NOT NULL THEN
    -- Duplicate-row guard: JS found an existing node keyed by MBID or catalog_id.
    -- Skip node upsert; proceed directly to works.recordings update.
    v_node_id := p_existing_node_id;
  ELSE
    INSERT INTO graph.nodes (node_type, label, external_id, external_id_ns, properties)
    VALUES (
      'recording',
      p_label,
      p_external_id,
      p_external_id_ns,
      COALESCE(p_node_properties, '{}')
    )
    ON CONFLICT (external_id, external_id_ns)
    DO UPDATE SET
      label      = EXCLUDED.label,
      properties = graph.nodes.properties || EXCLUDED.properties,
      updated_at = now()
    RETURNING id INTO v_node_id;
  END IF;

  INSERT INTO works.recordings (
    node_id, title, isrc, musicbrainz_recording_id, composition_node_id
  )
  VALUES (
    v_node_id,
    p_recording_patch->>'title',
    p_recording_patch->>'isrc',
    NULLIF(p_recording_patch->>'musicbrainz_recording_id','')::uuid,
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

-- Supabase default privileges auto-grant EXECUTE on public functions to anon and
-- authenticated; REVOKE FROM PUBLIC alone does not remove those individual grants.
REVOKE EXECUTE ON FUNCTION public.rpc_upsert_recording_enrichment(TEXT,TEXT,TEXT,JSONB,JSONB,UUID,UUID)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rpc_upsert_recording_enrichment(TEXT,TEXT,TEXT,JSONB,JSONB,UUID,UUID)
  FROM anon;
REVOKE EXECUTE ON FUNCTION public.rpc_upsert_recording_enrichment(TEXT,TEXT,TEXT,JSONB,JSONB,UUID,UUID)
  FROM authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_upsert_recording_enrichment(TEXT,TEXT,TEXT,JSONB,JSONB,UUID,UUID)
  TO service_role;

NOTIFY pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (run after applying)
-- ─────────────────────────────────────────────────────────────────────────────
-- Expect: 1 row, grantee = service_role only
--
-- SELECT grantee, privilege_type
-- FROM information_schema.routine_privileges
-- WHERE routine_schema = 'public'
--   AND routine_name = 'rpc_upsert_recording_enrichment';

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.rpc_upsert_recording_enrichment(TEXT,TEXT,TEXT,JSONB,JSONB,UUID,UUID);
-- NOTIFY pgrst, 'reload schema';
-- If restoring Supabase default behaviour for public functions, also run:
-- GRANT EXECUTE ON FUNCTION public.rpc_upsert_recording_enrichment(TEXT,TEXT,TEXT,JSONB,JSONB,UUID,UUID)
--   TO anon, authenticated;
--
-- Also revert api/graph-sync.js:
--   - remove upsertRecordingEnrichment()
--   - restore syncEnrichmentToGraph() recording block to call upsertNode()
--     followed by a separate graphFetch('recordings', ...) POST
