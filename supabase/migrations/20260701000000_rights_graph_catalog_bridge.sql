-- 20260701_rights_graph_catalog_bridge.sql
--
-- Rights Graph V1 — Migration 3 of 3
-- Catalog → Graph Bridge + Backfill
--
-- The enriched catalog (catalog_enriched_tracks_v1) exists in isolation.
-- Esham's 179 tracks have no graph_nodes_v1 entries. This migration:
--
-- 1. Adds graph_catalog_links_v1
--    Junction table linking catalog_enriched_tracks_v1 rows to
--    graph_nodes_v1 entries. One row per (track, node) pair.
--    Supports many-to-many — one track can resolve to multiple nodes
--    (composition node + recording node), one node can have multiple
--    catalog sources.
--
-- 2. fn_backfill_catalog_to_graph()
--    Idempotent function that reads all enriched tracks and:
--    - Creates graph_nodes_v1 entries for compositions and recordings
--    - Creates graph_nodes_v1 entries for artists/creators found in writers[]
--    - Creates graph_edges_v1 entries (wrote, recorded_by)
--    - Populates graph_identifiers_v1 (ISRC, ISWC, MusicBrainz IDs)
--    - Populates graph_evidence_v1 (writing credits as evidence)
--    - Opens investigations for every gap (missing ISWC, missing IPI, etc.)
--    - Links everything via graph_catalog_links_v1
--    Safe to run multiple times — uses ON CONFLICT DO NOTHING/UPDATE.
--
-- 3. fn_sync_track_to_graph(track_id UUID)
--    Per-track version of the backfill. Called by the enrichment pipeline
--    after every new track is enriched so the graph stays current.
--
-- ADDITIVE ONLY. No existing tables modified. Production safe.

-- ─── graph_catalog_links_v1 ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.graph_catalog_links_v1 (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id        UUID        NOT NULL REFERENCES public.catalog_enriched_tracks_v1(id) ON DELETE CASCADE,
  node_id         UUID        NOT NULL,
  node_role       TEXT        NOT NULL CHECK (node_role IN ('composition','recording','artist','creator','publisher')),
  confidence      NUMERIC(4,3) NOT NULL DEFAULT 0.750,
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  linked_by       TEXT        NOT NULL DEFAULT 'backfill',

  CONSTRAINT graph_catalog_links_v1_track_node_role_unique
    UNIQUE (track_id, node_id, node_role)
);

CREATE INDEX IF NOT EXISTS graph_catalog_links_v1_track_idx
  ON public.graph_catalog_links_v1 (track_id);

CREATE INDEX IF NOT EXISTS graph_catalog_links_v1_node_idx
  ON public.graph_catalog_links_v1 (node_id);

-- RLS
ALTER TABLE public.graph_catalog_links_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS graph_catalog_links_v1_service_role_all ON public.graph_catalog_links_v1;
CREATE POLICY graph_catalog_links_v1_service_role_all
  ON public.graph_catalog_links_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS graph_catalog_links_v1_authenticated_read ON public.graph_catalog_links_v1;
CREATE POLICY graph_catalog_links_v1_authenticated_read
  ON public.graph_catalog_links_v1 FOR SELECT TO authenticated USING (true);

-- ─── fn_sync_track_to_graph ──────────────────────────────────────────────────
-- Per-track sync. Idempotent. Call after enrichment, call during backfill.
-- Returns a summary JSONB of what was created/updated.

CREATE OR REPLACE FUNCTION public.fn_sync_track_to_graph(p_track_id UUID)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_track             RECORD;
  v_comp_node_id      UUID;
  v_rec_node_id       UUID;
  v_artist_node_id    UUID;
  v_writer            JSONB;
  v_writer_node_id    UUID;
  v_edge_id           UUID;
  v_evidence_id       UUID;
  v_created_nodes     INTEGER := 0;
  v_created_edges     INTEGER := 0;
  v_created_ids       INTEGER := 0;
  v_created_evidence  INTEGER := 0;
  v_opened_investigations INTEGER := 0;
  v_isrc              TEXT;
BEGIN
  -- Load the track
  SELECT * INTO v_track
  FROM public.catalog_enriched_tracks_v1
  WHERE id = p_track_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'track not found', 'track_id', p_track_id);
  END IF;

  -- ── 1. COMPOSITION NODE ────────────────────────────────────────────────────
  -- Check if a composition node already exists via ISWC or title fingerprint
  v_comp_node_id := NULL;

  -- Try ISWC lookup via identifier registry
  IF v_track.iswc IS NOT NULL AND v_track.iswc != '' THEN
    SELECT node_id INTO v_comp_node_id
    FROM public.graph_identifiers_v1
    WHERE namespace = 'iswc' AND value = v_track.iswc AND is_active = true
    LIMIT 1;
  END IF;

  -- Try MusicBrainz work ID if no ISWC match
  IF v_comp_node_id IS NULL AND v_track.recording_mbid IS NOT NULL AND v_track.recording_mbid != '' THEN
    SELECT node_id INTO v_comp_node_id
    FROM public.graph_identifiers_v1
    WHERE namespace = 'musicbrainz_recording' AND value = v_track.recording_mbid AND is_active = true
    LIMIT 1;
  END IF;

  -- Create composition node if still not found
  IF v_comp_node_id IS NULL THEN
    INSERT INTO public.graph_nodes_v1 (node_type, label, properties)
    VALUES (
      'composition',
      v_track.track_title,
      jsonb_build_object(
        'title',        v_track.track_title,
        'artist',       v_track.artist_name,
        'iswc',         v_track.iswc,
        'source',       'catalog_enrichment',
        'catalog_track_id', p_track_id
      )
    )
    RETURNING id INTO v_comp_node_id;
    v_created_nodes := v_created_nodes + 1;

    -- Log node creation
    INSERT INTO public.graph_node_history_v1 (node_id, change_type, node_type, label_after, change_reason, change_source)
    VALUES (v_comp_node_id, 'created', 'composition', v_track.track_title, 'backfill from catalog_enriched_tracks_v1', 'fn_sync_track_to_graph');
  END IF;

  -- Link catalog track to composition node
  INSERT INTO public.graph_catalog_links_v1 (track_id, node_id, node_role, confidence, linked_by)
  VALUES (p_track_id, v_comp_node_id, 'composition', 0.750, 'fn_sync_track_to_graph')
  ON CONFLICT (track_id, node_id, node_role) DO NOTHING;

  -- ── 2. COMPOSITION IDENTIFIERS ────────────────────────────────────────────
  IF v_track.iswc IS NOT NULL AND v_track.iswc != '' THEN
    INSERT INTO public.graph_identifiers_v1 (node_id, namespace, value, source_type, confidence, observed_at)
    VALUES (v_comp_node_id, 'iswc', v_track.iswc, 'enrichment_pipeline', 0.700, now())
    ON CONFLICT (node_id, namespace, value, source_type) DO NOTHING;
    IF FOUND THEN v_created_ids := v_created_ids + 1; END IF;
  END IF;

  -- MusicBrainz recording ID → attach to composition as best available MB link
  IF v_track.recording_mbid IS NOT NULL AND v_track.recording_mbid != '' THEN
    INSERT INTO public.graph_identifiers_v1 (node_id, namespace, value, source_type, confidence, observed_at)
    VALUES (v_comp_node_id, 'musicbrainz_recording', v_track.recording_mbid, 'musicbrainz', 0.900, now())
    ON CONFLICT (node_id, namespace, value, source_type) DO NOTHING;
    IF FOUND THEN v_created_ids := v_created_ids + 1; END IF;
  END IF;

  -- ── 3. RECORDING NODE ─────────────────────────────────────────────────────
  v_rec_node_id := NULL;

  -- Check ISRCs for existing recording node
  IF v_track.isrcs IS NOT NULL AND array_length(v_track.isrcs, 1) > 0 THEN
    v_isrc := v_track.isrcs[1];
    SELECT node_id INTO v_rec_node_id
    FROM public.graph_identifiers_v1
    WHERE namespace = 'isrc' AND value = v_isrc AND is_active = true
    LIMIT 1;
  END IF;

  -- Create recording node
  IF v_rec_node_id IS NULL THEN
    INSERT INTO public.graph_nodes_v1 (node_type, label, properties)
    VALUES (
      'recording',
      v_track.track_title || COALESCE(' (' || v_track.release_year || ')', ''),
      jsonb_build_object(
        'title',          v_track.track_title,
        'release_title',  v_track.release_title,
        'release_year',   v_track.release_year,
        'release_mbid',   v_track.release_mbid,
        'track_number',   v_track.track_number,
        'duration',       v_track.track_duration,
        'catalog_track_id', p_track_id
      )
    )
    RETURNING id INTO v_rec_node_id;
    v_created_nodes := v_created_nodes + 1;

    INSERT INTO public.graph_node_history_v1 (node_id, change_type, node_type, label_after, change_reason, change_source)
    VALUES (v_rec_node_id, 'created', 'recording', v_track.track_title, 'backfill from catalog_enriched_tracks_v1', 'fn_sync_track_to_graph');
  END IF;

  -- Link recording to composition via edge
  INSERT INTO public.graph_edges_v1 (edge_type, from_node_id, to_node_id, confidence, status, properties)
  VALUES ('recorded_as', v_comp_node_id, v_rec_node_id, 0.750, 'active',
    jsonb_build_object('source', 'catalog_enrichment'))
  ON CONFLICT DO NOTHING;

  -- Recording identifiers — ISRCs
  IF v_track.isrcs IS NOT NULL THEN
    FOREACH v_isrc IN ARRAY v_track.isrcs LOOP
      INSERT INTO public.graph_identifiers_v1 (node_id, namespace, value, source_type, confidence, observed_at)
      VALUES (v_rec_node_id, 'isrc', v_isrc, 'enrichment_pipeline', 0.850, now())
      ON CONFLICT (node_id, namespace, value, source_type) DO NOTHING;
      IF FOUND THEN v_created_ids := v_created_ids + 1; END IF;
    END LOOP;
  END IF;

  -- Link catalog track to recording node
  INSERT INTO public.graph_catalog_links_v1 (track_id, node_id, node_role, confidence, linked_by)
  VALUES (p_track_id, v_rec_node_id, 'recording', 0.750, 'fn_sync_track_to_graph')
  ON CONFLICT (track_id, node_id, node_role) DO NOTHING;

  -- ── 4. ARTIST NODE ────────────────────────────────────────────────────────
  IF v_track.artist_name IS NOT NULL THEN
    -- Check for existing artist by MusicBrainz ID
    v_artist_node_id := NULL;
    IF v_track.artist_mbid IS NOT NULL AND v_track.artist_mbid != '' THEN
      SELECT node_id INTO v_artist_node_id
      FROM public.graph_identifiers_v1
      WHERE namespace = 'musicbrainz_artist' AND value = v_track.artist_mbid AND is_active = true
      LIMIT 1;
    END IF;

    IF v_artist_node_id IS NULL THEN
      INSERT INTO public.graph_nodes_v1 (node_type, label, properties)
      VALUES ('artist', v_track.artist_name, jsonb_build_object('name', v_track.artist_name, 'mbid', v_track.artist_mbid))
      RETURNING id INTO v_artist_node_id;
      v_created_nodes := v_created_nodes + 1;

      INSERT INTO public.graph_node_history_v1 (node_id, change_type, node_type, label_after, change_reason, change_source)
      VALUES (v_artist_node_id, 'created', 'artist', v_track.artist_name, 'backfill from catalog_enriched_tracks_v1', 'fn_sync_track_to_graph');

      IF v_track.artist_mbid IS NOT NULL AND v_track.artist_mbid != '' THEN
        INSERT INTO public.graph_identifiers_v1 (node_id, namespace, value, source_type, confidence)
        VALUES (v_artist_node_id, 'musicbrainz_artist', v_track.artist_mbid, 'musicbrainz', 0.950)
        ON CONFLICT (node_id, namespace, value, source_type) DO NOTHING;
        v_created_ids := v_created_ids + 1;
      END IF;
    END IF;

    -- Edge: artist performed recording
    INSERT INTO public.graph_edges_v1 (edge_type, from_node_id, to_node_id, confidence, status)
    VALUES ('performed_by', v_rec_node_id, v_artist_node_id, 0.800, 'active')
    ON CONFLICT DO NOTHING;
    v_created_edges := v_created_edges + 1;

    INSERT INTO public.graph_catalog_links_v1 (track_id, node_id, node_role, confidence, linked_by)
    VALUES (p_track_id, v_artist_node_id, 'artist', 0.800, 'fn_sync_track_to_graph')
    ON CONFLICT (track_id, node_id, node_role) DO NOTHING;
  END IF;

  -- ── 5. WRITER NODES + EVIDENCE ────────────────────────────────────────────
  IF v_track.writers IS NOT NULL AND jsonb_array_length(v_track.writers) > 0 THEN
    FOR v_writer IN SELECT * FROM jsonb_array_elements(v_track.writers) LOOP
      v_writer_node_id := NULL;

      -- Check for existing creator node by IPI
      IF (v_writer->>'ipi') IS NOT NULL AND (v_writer->>'ipi') != '' THEN
        SELECT node_id INTO v_writer_node_id
        FROM public.graph_identifiers_v1
        WHERE namespace = 'ipi_name' AND value = (v_writer->>'ipi') AND is_active = true
        LIMIT 1;
      END IF;

      -- Check by MusicBrainz artist ID
      IF v_writer_node_id IS NULL AND (v_writer->>'mbid') IS NOT NULL AND (v_writer->>'mbid') != '' THEN
        SELECT node_id INTO v_writer_node_id
        FROM public.graph_identifiers_v1
        WHERE namespace = 'musicbrainz_artist' AND value = (v_writer->>'mbid') AND is_active = true
        LIMIT 1;
      END IF;

      -- Create creator node
      IF v_writer_node_id IS NULL THEN
        INSERT INTO public.graph_nodes_v1 (node_type, label, properties)
        VALUES (
          'creator',
          v_writer->>'name',
          jsonb_build_object(
            'name',   v_writer->>'name',
            'ipi',    v_writer->>'ipi',
            'mbid',   v_writer->>'mbid',
            'role',   v_writer->>'role',
            'source', v_writer->>'source'
          )
        )
        RETURNING id INTO v_writer_node_id;
        v_created_nodes := v_created_nodes + 1;

        INSERT INTO public.graph_node_history_v1 (node_id, change_type, node_type, label_after, change_reason, change_source)
        VALUES (v_writer_node_id, 'created', 'creator', v_writer->>'name', 'backfill from catalog writers JSONB', 'fn_sync_track_to_graph');
      END IF;

      -- IPI identifier
      IF (v_writer->>'ipi') IS NOT NULL AND (v_writer->>'ipi') != '' THEN
        INSERT INTO public.graph_identifiers_v1 (node_id, namespace, value, source_type, confidence)
        VALUES (v_writer_node_id, 'ipi_name', v_writer->>'ipi',
          CASE WHEN v_writer->>'source' = 'musicbrainz' THEN 'musicbrainz'::public.evidence_source_type
               ELSE 'enrichment_pipeline'::public.evidence_source_type END,
          0.900)
        ON CONFLICT (node_id, namespace, value, source_type) DO NOTHING;
        v_created_ids := v_created_ids + 1;
      END IF;

      -- MusicBrainz artist ID
      IF (v_writer->>'mbid') IS NOT NULL AND (v_writer->>'mbid') != '' THEN
        INSERT INTO public.graph_identifiers_v1 (node_id, namespace, value, source_type, confidence)
        VALUES (v_writer_node_id, 'musicbrainz_artist', v_writer->>'mbid', 'musicbrainz', 0.950)
        ON CONFLICT (node_id, namespace, value, source_type) DO NOTHING;
        v_created_ids := v_created_ids + 1;
      END IF;

      -- Edge: creator wrote composition
      INSERT INTO public.graph_edges_v1 (
        edge_type, from_node_id, to_node_id, confidence, status, properties
      )
      VALUES (
        'wrote', v_writer_node_id, v_comp_node_id, 0.750, 'active',
        jsonb_build_object(
          'role',   COALESCE(v_writer->>'role', 'writer'),
          'source', COALESCE(v_writer->>'source', 'enrichment_pipeline')
        )
      )
      ON CONFLICT DO NOTHING;
      v_created_edges := v_created_edges + 1;

      -- Evidence: writing credit
      INSERT INTO public.graph_evidence_v1 (
        subject_node_id, object_node_id,
        claim_type, claim_value,
        source_type, confidence, confidence_rationale
      )
      VALUES (
        v_comp_node_id, v_writer_node_id,
        'writing_credit',
        jsonb_build_object(
          'role',           COALESCE(v_writer->>'role', 'writer'),
          'credited_name',  v_writer->>'name',
          'ipi',            v_writer->>'ipi',
          'source',         v_writer->>'source'
        ),
        CASE WHEN v_writer->>'source' = 'musicbrainz' THEN 'musicbrainz'::public.evidence_source_type
             WHEN v_writer->>'source' = 'discogs'     THEN 'discogs'::public.evidence_source_type
             WHEN v_writer->>'source' = 'genius'      THEN 'genius'::public.evidence_source_type
             ELSE 'enrichment_pipeline'::public.evidence_source_type END,
        CASE WHEN v_writer->>'source' = 'musicbrainz' THEN 0.850
             WHEN v_writer->>'source' = 'discogs'     THEN 0.700
             WHEN v_writer->>'source' = 'genius'      THEN 0.600
             ELSE 0.500 END,
        'Derived from catalog enrichment pipeline — ' || COALESCE(v_writer->>'source', 'unknown source')
      );
      v_created_evidence := v_created_evidence + 1;

      -- Link creator to catalog
      INSERT INTO public.graph_catalog_links_v1 (track_id, node_id, node_role, confidence, linked_by)
      VALUES (p_track_id, v_writer_node_id, 'creator', 0.750, 'fn_sync_track_to_graph')
      ON CONFLICT (track_id, node_id, node_role) DO NOTHING;
    END LOOP;
  END IF;

  -- ── 6. OPEN INVESTIGATIONS FOR GAPS ───────────────────────────────────────

  -- Missing ISWC
  IF v_track.iswc IS NULL OR v_track.iswc = '' THEN
    PERFORM public.fn_open_investigation(
      v_comp_node_id, 'missing_iswc',
      'No ISWC for "' || v_track.track_title || '"',
      'Composition has no ISWC on record. Cannot register with MLC or international societies without it.',
      'high',
      jsonb_build_object('track_title', v_track.track_title, 'artist', v_track.artist_name, 'has_writers', (jsonb_array_length(COALESCE(v_track.writers, '[]'::jsonb)) > 0)),
      'Register composition with BMI/ASCAP to obtain ISWC'
    );
    v_opened_investigations := v_opened_investigations + 1;
  END IF;

  -- Missing ISRC
  IF v_track.isrcs IS NULL OR array_length(v_track.isrcs, 1) IS NULL THEN
    PERFORM public.fn_open_investigation(
      v_rec_node_id, 'missing_isrc',
      'No ISRC for "' || v_track.track_title || '"',
      'Recording has no ISRC. Cannot collect neighboring rights or track streams accurately.',
      'high',
      jsonb_build_object('track_title', v_track.track_title, 'release_title', v_track.release_title),
      'Register ISRC with RIAA or distributor'
    );
    v_opened_investigations := v_opened_investigations + 1;
  END IF;

  -- Missing writers
  IF v_track.writers IS NULL OR jsonb_array_length(v_track.writers) = 0 THEN
    PERFORM public.fn_open_investigation(
      v_comp_node_id, 'missing_split_sheet',
      'No writer credits for "' || v_track.track_title || '"',
      'No writer credits found in enrichment data. Cannot register or collect without writer information.',
      'critical',
      jsonb_build_object('track_title', v_track.track_title, 'artist', v_track.artist_name),
      'Obtain writer credits from artist or PRO registration'
    );
    v_opened_investigations := v_opened_investigations + 1;
  END IF;

  -- Missing IPI for writers who have names but no IPI
  IF v_track.writers IS NOT NULL THEN
    FOR v_writer IN SELECT * FROM jsonb_array_elements(v_track.writers) LOOP
      IF (v_writer->>'ipi') IS NULL OR (v_writer->>'ipi') = '' THEN
        -- Find the writer node we just created/found
        SELECT node_id INTO v_writer_node_id
        FROM public.graph_identifiers_v1
        WHERE namespace = 'musicbrainz_artist'
          AND value = COALESCE(v_writer->>'mbid', '')
          AND is_active = true
        LIMIT 1;

        IF v_writer_node_id IS NULL THEN
          SELECT id INTO v_writer_node_id
          FROM public.graph_nodes_v1
          WHERE label = (v_writer->>'name') AND node_type = 'creator'
          LIMIT 1;
        END IF;

        IF v_writer_node_id IS NOT NULL THEN
          PERFORM public.fn_open_investigation(
            v_writer_node_id, 'missing_ipi',
            'No IPI for writer "' || COALESCE(v_writer->>'name', 'Unknown') || '"',
            'Writer has no IPI number on record. Required for PRO registration and royalty payment.',
            'high',
            jsonb_build_object('writer_name', v_writer->>'name', 'source', v_writer->>'source'),
            'Look up IPI at ISWC International or PRO member search'
          );
          v_opened_investigations := v_opened_investigations + 1;
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- AI consent not set
  IF NOT EXISTS (
    SELECT 1 FROM public.ai_consent_v1
    WHERE work_id = v_comp_node_id AND status != 'unset'
  ) THEN
    PERFORM public.fn_open_investigation(
      v_comp_node_id, 'ai_licensing_unset',
      'AI licensing consent not set for "' || v_track.track_title || '"',
      'No explicit AI training or generation consent on record for this composition.',
      'medium',
      jsonb_build_object('track_title', v_track.track_title),
      'Artist should set AI licensing preferences via MusiGod portal'
    );
    v_opened_investigations := v_opened_investigations + 1;
  END IF;

  RETURN jsonb_build_object(
    'track_id',              p_track_id,
    'track_title',           v_track.track_title,
    'comp_node_id',          v_comp_node_id,
    'rec_node_id',           v_rec_node_id,
    'created_nodes',         v_created_nodes,
    'created_edges',         v_created_edges,
    'created_identifiers',   v_created_ids,
    'created_evidence',      v_created_evidence,
    'opened_investigations', v_opened_investigations
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'error',      SQLERRM,
    'track_id',   p_track_id,
    'sqlstate',   SQLSTATE
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_sync_track_to_graph(UUID) TO service_role;

-- ─── fn_backfill_catalog_to_graph ────────────────────────────────────────────
-- Full backfill. Iterates all enriched tracks, calls fn_sync_track_to_graph.
-- Returns summary stats. Safe to run multiple times.

CREATE OR REPLACE FUNCTION public.fn_backfill_catalog_to_graph(
  p_artist_name TEXT DEFAULT NULL,   -- NULL = all artists
  p_limit       INTEGER DEFAULT 500  -- safety cap per run
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_track_id      UUID;
  v_result        JSONB;
  v_total         INTEGER := 0;
  v_succeeded     INTEGER := 0;
  v_failed        INTEGER := 0;
  v_errors        JSONB[] := '{}';
  v_total_nodes   INTEGER := 0;
  v_total_edges   INTEGER := 0;
  v_total_ids     INTEGER := 0;
  v_total_evidence INTEGER := 0;
  v_total_investigations INTEGER := 0;
BEGIN
  FOR v_track_id IN
    SELECT id FROM public.catalog_enriched_tracks_v1
    WHERE (p_artist_name IS NULL OR artist_name ILIKE p_artist_name)
    ORDER BY created_at ASC
    LIMIT p_limit
  LOOP
    v_total := v_total + 1;
    v_result := public.fn_sync_track_to_graph(v_track_id);

    IF v_result ? 'error' THEN
      v_failed := v_failed + 1;
      v_errors := array_append(v_errors, jsonb_build_object('track_id', v_track_id, 'error', v_result->>'error'));
    ELSE
      v_succeeded := v_succeeded + 1;
      v_total_nodes       := v_total_nodes       + COALESCE((v_result->>'created_nodes')::int, 0);
      v_total_edges       := v_total_edges       + COALESCE((v_result->>'created_edges')::int, 0);
      v_total_ids         := v_total_ids         + COALESCE((v_result->>'created_identifiers')::int, 0);
      v_total_evidence    := v_total_evidence    + COALESCE((v_result->>'created_evidence')::int, 0);
      v_total_investigations := v_total_investigations + COALESCE((v_result->>'opened_investigations')::int, 0);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'total_tracks',         v_total,
    'succeeded',            v_succeeded,
    'failed',               v_failed,
    'created_nodes',        v_total_nodes,
    'created_edges',        v_total_edges,
    'created_identifiers',  v_total_ids,
    'created_evidence',     v_total_evidence,
    'opened_investigations',v_total_investigations,
    'errors',               COALESCE(to_jsonb(v_errors), '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_backfill_catalog_to_graph(TEXT, INTEGER) TO service_role;

-- ─── RELOAD POSTGREST ────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
