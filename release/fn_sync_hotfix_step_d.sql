CREATE OR REPLACE FUNCTION public.fn_sync_track_to_graph(p_track_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$

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
  -- CHANGE-1 (2026-07-19): recording identity variables
  v_norm_isrc          TEXT;
  v_norm_mbid          TEXT;
  v_rec_node_isrc      UUID;
  v_rec_node_mbid      UUID;
  v_rec_node_fallback  UUID;

BEGIN

  SELECT * INTO v_track FROM public.catalog_enriched_tracks_v1 WHERE id = p_track_id;

  IF NOT FOUND THEN

    RETURN jsonb_build_object('error', 'track not found', 'track_id', p_track_id);

  END IF;



  -- â”€â”€ 1. WORK NODE (was: composition) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  v_comp_node_id := NULL;

  IF v_track.iswc IS NOT NULL AND v_track.iswc != '' THEN

    SELECT node_id INTO v_comp_node_id FROM public.graph_identifiers_v1

    WHERE namespace = 'iswc' AND value = v_track.iswc AND is_active = true LIMIT 1;

  END IF;

  IF v_comp_node_id IS NULL AND v_track.recording_mbid IS NOT NULL AND v_track.recording_mbid != '' THEN

    SELECT node_id INTO v_comp_node_id FROM public.graph_identifiers_v1

    WHERE namespace = 'musicbrainz_recording' AND value = v_track.recording_mbid AND is_active = true LIMIT 1;

  END IF;

  IF v_comp_node_id IS NULL THEN

    INSERT INTO public.graph_nodes_v1 (node_type, label, properties)

    VALUES ('work', v_track.track_title, jsonb_build_object(

      'title', v_track.track_title, 'artist', v_track.artist_name,

      'iswc', v_track.iswc, 'source', 'catalog_enrichment', 'catalog_track_id', p_track_id))

    RETURNING id INTO v_comp_node_id;

    v_created_nodes := v_created_nodes + 1;

    INSERT INTO public.graph_node_history_v1 (node_id, change_type, node_type, label_after, change_reason, change_source)

    VALUES (v_comp_node_id, 'created', 'work', v_track.track_title, 'backfill from catalog_enriched_tracks_v1', 'fn_sync_track_to_graph');

  END IF;



  INSERT INTO public.graph_catalog_links_v1 (track_id, node_id, node_role, confidence, linked_by)

  VALUES (p_track_id, v_comp_node_id, 'composition', 0.750, 'fn_sync_track_to_graph')

  ON CONFLICT (track_id, node_id, node_role) DO NOTHING;



  -- â”€â”€ 2. WORK IDENTIFIERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  IF v_track.iswc IS NOT NULL AND v_track.iswc != '' THEN

    INSERT INTO public.graph_identifiers_v1 (node_id, namespace, value, source_type, confidence, observed_at)

    VALUES (v_comp_node_id, 'iswc', v_track.iswc, 'enrichment_pipeline', 0.700, now())

    ON CONFLICT (node_id, namespace, value, source_type) DO NOTHING;

    IF FOUND THEN v_created_ids := v_created_ids + 1; END IF;

  END IF;

  IF v_track.recording_mbid IS NOT NULL AND v_track.recording_mbid != '' THEN

    INSERT INTO public.graph_identifiers_v1 (node_id, namespace, value, source_type, confidence, observed_at)

    VALUES (v_comp_node_id, 'musicbrainz_recording', v_track.recording_mbid, 'musicbrainz', 0.900, now())

    ON CONFLICT (node_id, namespace, value, source_type) DO NOTHING;

    IF FOUND THEN v_created_ids := v_created_ids + 1; END IF;

  END IF;



  -- ── 3. RECORDING NODE (CHANGE-2: three-tier identity, 2026-07-19) ──────────
  -- Root-cause fix: ON CONFLICT (NULL, NULL) never fires; fallback via
  -- graph_catalog_links_v1 gives no-ISRC/no-MBID tracks a stable identity.

  v_rec_node_id       := NULL;
  v_rec_node_isrc     := NULL;
  v_rec_node_mbid     := NULL;
  v_rec_node_fallback := NULL;
  v_norm_isrc         := NULL;
  v_norm_mbid         := NULL;

  -- Step A: normalize ISRC
  IF v_track.isrcs IS NOT NULL AND array_length(v_track.isrcs, 1) > 0
     AND v_track.isrcs[1] IS NOT NULL AND v_track.isrcs[1] <> '' THEN
    v_norm_isrc := UPPER(REGEXP_REPLACE(TRIM(v_track.isrcs[1]), '[^A-Za-z0-9]', '', 'g'));
    IF LENGTH(v_norm_isrc) = 0 THEN v_norm_isrc := NULL; END IF;
  END IF;

  -- Step B: normalize recording MBID (never release_mbid)
  IF v_track.recording_mbid IS NOT NULL AND v_track.recording_mbid <> '' THEN
    v_norm_mbid := LOWER(TRIM(v_track.recording_mbid));
    IF LENGTH(v_norm_mbid) = 0 THEN v_norm_mbid := NULL; END IF;
  END IF;

  -- Step C: tier-1 lookup via graph_identifiers_v1
  IF v_norm_isrc IS NOT NULL THEN
    SELECT node_id INTO v_rec_node_isrc FROM public.graph_identifiers_v1
    WHERE namespace = 'isrc' AND value = v_norm_isrc AND is_active = true LIMIT 1;
  END IF;

  -- Step D: tier-2 lookup via graph_identifiers_v1 (recording-type nodes only)
  -- Section 1 also writes recording_mbid under namespace 'musicbrainz_recording' on WORK nodes.
  -- JOIN on graph_nodes_v1 guards against returning a work node here (which would cause
  -- a self-loop on the has_recording edge). Current production data: all entries under
  -- this namespace are work nodes, so tier-2 resolves to NULL and tier-3 handles identity.
  IF v_norm_mbid IS NOT NULL THEN
    SELECT gi.node_id INTO v_rec_node_mbid
    FROM public.graph_identifiers_v1 gi
    JOIN public.graph_nodes_v1 gn ON gn.id = gi.node_id
    WHERE gi.namespace = 'musicbrainz_recording'
      AND gi.value = v_norm_mbid
      AND gi.is_active = true
      AND gn.node_type = 'recording'
    LIMIT 1;
  END IF;

  -- Step E: tier-3 fallback via graph_catalog_links_v1
  SELECT node_id INTO v_rec_node_fallback FROM public.graph_catalog_links_v1
  WHERE track_id = p_track_id AND node_role = 'recording' LIMIT 1;

  -- Step F: pairwise conflict detection (no auto-merge)
  IF v_rec_node_isrc IS NOT NULL AND v_rec_node_mbid IS NOT NULL
     AND v_rec_node_isrc <> v_rec_node_mbid THEN
    INSERT INTO graph.recording_identity_conflicts
      (track_id, conflict_type, norm_isrc, isrc_node_id, mbid_node_id)
    VALUES (p_track_id, 'isrc_vs_mbid', v_norm_isrc, v_rec_node_isrc, v_rec_node_mbid)
    ON CONFLICT (track_id, conflict_type) WHERE resolved = false DO NOTHING;
  END IF;
  IF v_rec_node_isrc IS NOT NULL AND v_rec_node_fallback IS NOT NULL
     AND v_rec_node_isrc <> v_rec_node_fallback THEN
    INSERT INTO graph.recording_identity_conflicts
      (track_id, conflict_type, norm_isrc, isrc_node_id, fallback_node_id)
    VALUES (p_track_id, 'isrc_vs_fallback', v_norm_isrc, v_rec_node_isrc, v_rec_node_fallback)
    ON CONFLICT (track_id, conflict_type) WHERE resolved = false DO NOTHING;
  END IF;
  IF v_rec_node_mbid IS NOT NULL AND v_rec_node_fallback IS NOT NULL
     AND v_rec_node_mbid <> v_rec_node_fallback THEN
    INSERT INTO graph.recording_identity_conflicts
      (track_id, conflict_type, mbid_node_id, fallback_node_id)
    VALUES (p_track_id, 'mbid_vs_fallback', v_rec_node_mbid, v_rec_node_fallback)
    ON CONFLICT (track_id, conflict_type) WHERE resolved = false DO NOTHING;
  END IF;

  -- Step G: priority resolution: ISRC > MBID > fallback
  IF    v_rec_node_isrc     IS NOT NULL THEN v_rec_node_id := v_rec_node_isrc;
  ELSIF v_rec_node_mbid     IS NOT NULL THEN v_rec_node_id := v_rec_node_mbid;
  ELSIF v_rec_node_fallback IS NOT NULL THEN v_rec_node_id := v_rec_node_fallback;
  END IF;

  -- Step H: create node if no tier resolved
  IF v_rec_node_id IS NULL THEN

    INSERT INTO public.graph_nodes_v1 (node_type, label, properties)

    VALUES ('recording', v_track.track_title || COALESCE(' (' || v_track.release_year || ')', ''),

      jsonb_build_object('title', v_track.track_title, 'release_title', v_track.release_title,

        'release_year', v_track.release_year, 'release_mbid', v_track.release_mbid,

        'track_number', v_track.track_number, 'duration', v_track.track_duration,

        'catalog_track_id', p_track_id))

    RETURNING id INTO v_rec_node_id;

    v_created_nodes := v_created_nodes + 1;

    INSERT INTO public.graph_node_history_v1 (node_id, change_type, node_type, label_after, change_reason, change_source)

    VALUES (v_rec_node_id, 'created', 'recording', v_track.track_title, 'backfill from catalog_enriched_tracks_v1', 'fn_sync_track_to_graph');

  END IF;



  INSERT INTO public.graph_edges_v1 (edge_type, from_node_id, to_node_id, confidence, status, properties)

  VALUES ('has_recording', v_comp_node_id, v_rec_node_id, 0.750, 'active', jsonb_build_object('source', 'catalog_enrichment'))

  ON CONFLICT DO NOTHING;



  IF v_track.isrcs IS NOT NULL THEN

    FOREACH v_isrc IN ARRAY v_track.isrcs LOOP

      INSERT INTO public.graph_identifiers_v1 (node_id, namespace, value, source_type, confidence, observed_at)

      VALUES (v_rec_node_id, 'isrc', v_isrc, 'enrichment_pipeline', 0.850, now())

      ON CONFLICT (node_id, namespace, value, source_type) DO NOTHING;

      IF FOUND THEN v_created_ids := v_created_ids + 1; END IF;

    END LOOP;

  END IF;



  INSERT INTO public.graph_catalog_links_v1 (track_id, node_id, node_role, confidence, linked_by)

  VALUES (p_track_id, v_rec_node_id, 'recording', 0.750, 'fn_sync_track_to_graph')

  ON CONFLICT (track_id, node_id, node_role) DO NOTHING;



  -- â”€â”€ 4. ARTIST NODE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  IF v_track.artist_name IS NOT NULL THEN

    v_artist_node_id := NULL;

    IF v_track.artist_mbid IS NOT NULL AND v_track.artist_mbid != '' THEN

      SELECT node_id INTO v_artist_node_id FROM public.graph_identifiers_v1

      WHERE namespace = 'musicbrainz_artist' AND value = v_track.artist_mbid AND is_active = true LIMIT 1;

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

    INSERT INTO public.graph_edges_v1 (edge_type, from_node_id, to_node_id, confidence, status)

    VALUES ('performed', v_artist_node_id, v_rec_node_id, 0.800, 'active') ON CONFLICT DO NOTHING;

    v_created_edges := v_created_edges + 1;

    INSERT INTO public.graph_catalog_links_v1 (track_id, node_id, node_role, confidence, linked_by)

    VALUES (p_track_id, v_artist_node_id, 'artist', 0.800, 'fn_sync_track_to_graph')

    ON CONFLICT (track_id, node_id, node_role) DO NOTHING;

  END IF;



  -- â”€â”€ 5. WRITER NODES + EVIDENCE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  IF v_track.writers IS NOT NULL AND jsonb_array_length(v_track.writers) > 0 THEN

    FOR v_writer IN SELECT * FROM jsonb_array_elements(v_track.writers) LOOP

      v_writer_node_id := NULL;

      IF (v_writer->>'ipi') IS NOT NULL AND (v_writer->>'ipi') != '' THEN

        SELECT node_id INTO v_writer_node_id FROM public.graph_identifiers_v1

        WHERE namespace = 'ipi_name' AND value = (v_writer->>'ipi') AND is_active = true LIMIT 1;

      END IF;

      IF v_writer_node_id IS NULL AND (v_writer->>'mbid') IS NOT NULL AND (v_writer->>'mbid') != '' THEN

        SELECT node_id INTO v_writer_node_id FROM public.graph_identifiers_v1

        WHERE namespace = 'musicbrainz_artist' AND value = (v_writer->>'mbid') AND is_active = true LIMIT 1;

      END IF;

      -- Name-based fallback for writers with no IPI or MBID (prevents duplicate nodes
      -- on repeat syncs; same lookup used in the investigations section below).
      IF v_writer_node_id IS NULL THEN
        SELECT id INTO v_writer_node_id FROM public.graph_nodes_v1
        WHERE node_type = 'creator' AND label = (v_writer->>'name') LIMIT 1;
      END IF;

      IF v_writer_node_id IS NULL THEN

        INSERT INTO public.graph_nodes_v1 (node_type, label, properties)

        VALUES ('creator', v_writer->>'name', jsonb_build_object(

          'name', v_writer->>'name', 'ipi', v_writer->>'ipi',

          'mbid', v_writer->>'mbid', 'role', v_writer->>'role', 'source', v_writer->>'source'))

        RETURNING id INTO v_writer_node_id;

        v_created_nodes := v_created_nodes + 1;

        INSERT INTO public.graph_node_history_v1 (node_id, change_type, node_type, label_after, change_reason, change_source)

        VALUES (v_writer_node_id, 'created', 'creator', v_writer->>'name', 'backfill from catalog writers JSONB', 'fn_sync_track_to_graph');

      END IF;

      IF (v_writer->>'ipi') IS NOT NULL AND (v_writer->>'ipi') != '' THEN

        INSERT INTO public.graph_identifiers_v1 (node_id, namespace, value, source_type, confidence)

        VALUES (v_writer_node_id, 'ipi_name', v_writer->>'ipi',

          CASE WHEN v_writer->>'source' = 'musicbrainz' THEN 'musicbrainz'::public.evidence_source_type

               ELSE 'enrichment_pipeline'::public.evidence_source_type END, 0.900)

        ON CONFLICT (node_id, namespace, value, source_type) DO NOTHING;

        v_created_ids := v_created_ids + 1;

      END IF;

      IF (v_writer->>'mbid') IS NOT NULL AND (v_writer->>'mbid') != '' THEN

        INSERT INTO public.graph_identifiers_v1 (node_id, namespace, value, source_type, confidence)

        VALUES (v_writer_node_id, 'musicbrainz_artist', v_writer->>'mbid', 'musicbrainz', 0.950)

        ON CONFLICT (node_id, namespace, value, source_type) DO NOTHING;

        v_created_ids := v_created_ids + 1;

      END IF;

      INSERT INTO public.graph_edges_v1 (edge_type, from_node_id, to_node_id, confidence, status, properties)

      VALUES ('wrote', v_writer_node_id, v_comp_node_id, 0.750, 'active',

        jsonb_build_object('role', COALESCE(v_writer->>'role','writer'), 'source', COALESCE(v_writer->>'source','enrichment_pipeline')))

      ON CONFLICT DO NOTHING;

      v_created_edges := v_created_edges + 1;

      INSERT INTO public.graph_evidence_v1 (subject_node_id, object_node_id, claim_type, claim_value, source_type, confidence, confidence_rationale)

      VALUES (v_comp_node_id, v_writer_node_id, 'writing_credit',

        jsonb_build_object('role', COALESCE(v_writer->>'role','writer'), 'credited_name', v_writer->>'name', 'ipi', v_writer->>'ipi', 'source', v_writer->>'source'),

        CASE WHEN v_writer->>'source'='musicbrainz' THEN 'musicbrainz'::public.evidence_source_type

             WHEN v_writer->>'source'='discogs' THEN 'discogs'::public.evidence_source_type

             WHEN v_writer->>'source'='genius' THEN 'genius'::public.evidence_source_type

             ELSE 'enrichment_pipeline'::public.evidence_source_type END,

        CASE WHEN v_writer->>'source'='musicbrainz' THEN 0.850

             WHEN v_writer->>'source'='discogs' THEN 0.700

             WHEN v_writer->>'source'='genius' THEN 0.600 ELSE 0.500 END,

        'Derived from catalog enrichment pipeline â€” ' || COALESCE(v_writer->>'source','unknown source'));

      v_created_evidence := v_created_evidence + 1;

      INSERT INTO public.graph_catalog_links_v1 (track_id, node_id, node_role, confidence, linked_by)

      VALUES (p_track_id, v_writer_node_id, 'creator', 0.750, 'fn_sync_track_to_graph')

      ON CONFLICT (track_id, node_id, node_role) DO NOTHING;

    END LOOP;

  END IF;



  -- â”€â”€ 6. INVESTIGATIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  IF v_track.iswc IS NULL OR v_track.iswc = '' THEN

    PERFORM public.fn_open_investigation(v_comp_node_id, 'missing_iswc',

      'No ISWC for "' || v_track.track_title || '"',

      'Composition has no ISWC. Cannot register with MLC or international societies.',

      'high', jsonb_build_object('track_title', v_track.track_title, 'artist', v_track.artist_name),

      'Register composition with BMI/ASCAP to obtain ISWC');

    v_opened_investigations := v_opened_investigations + 1;

  END IF;

  IF v_track.isrcs IS NULL OR array_length(v_track.isrcs, 1) IS NULL THEN

    PERFORM public.fn_open_investigation(v_rec_node_id, 'missing_isrc',

      'No ISRC for "' || v_track.track_title || '"',

      'Recording has no ISRC. Cannot collect neighboring rights accurately.',

      'high', jsonb_build_object('track_title', v_track.track_title, 'release_title', v_track.release_title),

      'Register ISRC with RIAA or distributor');

    v_opened_investigations := v_opened_investigations + 1;

  END IF;

  IF v_track.writers IS NULL OR jsonb_array_length(v_track.writers) = 0 THEN

    PERFORM public.fn_open_investigation(v_comp_node_id, 'missing_split_sheet',

      'No writer credits for "' || v_track.track_title || '"',

      'No writer credits found. Cannot register or collect without writer information.',

      'critical', jsonb_build_object('track_title', v_track.track_title, 'artist', v_track.artist_name),

      'Obtain writer credits from artist or PRO registration');

    v_opened_investigations := v_opened_investigations + 1;

  END IF;

  IF v_track.writers IS NOT NULL THEN

    FOR v_writer IN SELECT * FROM jsonb_array_elements(v_track.writers) LOOP

      IF (v_writer->>'ipi') IS NULL OR (v_writer->>'ipi') = '' THEN

        SELECT node_id INTO v_writer_node_id FROM public.graph_identifiers_v1

        WHERE namespace = 'musicbrainz_artist' AND value = COALESCE(v_writer->>'mbid','') AND is_active = true LIMIT 1;

        IF v_writer_node_id IS NULL THEN

          SELECT id INTO v_writer_node_id FROM public.graph_nodes_v1

          WHERE label = (v_writer->>'name') AND node_type = 'creator' LIMIT 1;

        END IF;

        IF v_writer_node_id IS NOT NULL THEN

          PERFORM public.fn_open_investigation(v_writer_node_id, 'missing_ipi',

            'No IPI for writer "' || COALESCE(v_writer->>'name','Unknown') || '"',

            'Writer has no IPI number. Required for PRO registration and royalty payment.',

            'high', jsonb_build_object('writer_name', v_writer->>'name', 'source', v_writer->>'source'),

            'Look up IPI at ISWC International or PRO member search');

          v_opened_investigations := v_opened_investigations + 1;

        END IF;

      END IF;

    END LOOP;

  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.ai_consent_v1 WHERE work_id = v_comp_node_id AND status != 'unset') THEN

    PERFORM public.fn_open_investigation(v_comp_node_id, 'ai_licensing_unset',

      'AI licensing consent not set for "' || v_track.track_title || '"',

      'No explicit AI training or generation consent on record.',

      'medium', jsonb_build_object('track_title', v_track.track_title),

      'Artist should set AI licensing preferences via MusiGod portal');

    v_opened_investigations := v_opened_investigations + 1;

  END IF;



  RETURN jsonb_build_object(

    'track_id', p_track_id, 'track_title', v_track.track_title,

    'comp_node_id', v_comp_node_id, 'rec_node_id', v_rec_node_id,

    'created_nodes', v_created_nodes, 'created_edges', v_created_edges,

    'created_identifiers', v_created_ids, 'created_evidence', v_created_evidence,

    'opened_investigations', v_opened_investigations);

EXCEPTION WHEN OTHERS THEN

  RETURN jsonb_build_object('error', SQLERRM, 'track_id', p_track_id, 'sqlstate', SQLSTATE);

END;

$function$
