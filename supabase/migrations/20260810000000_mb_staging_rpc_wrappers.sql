-- supabase/migrations/20260810000000_mb_staging_rpc_wrappers.sql
--
-- Public-schema SECURITY DEFINER wrapper RPCs for mb_staging access.
--
-- WHY: PostgREST's "Exposed schemas" dashboard setting was not propagating
-- despite multiple saves. Rather than block on platform config, we proxy all
-- mb_staging reads/writes through public-schema functions that PostgREST
-- already serves. This is also a cleaner pattern for bulk batch upserts.
--
-- All functions are SECURITY DEFINER so they execute with the owner's privileges
-- (which have USAGE on mb_staging and ALL on each table).
--
-- Usage: called via PostgREST RPC, e.g.
--   POST /rest/v1/rpc/fn_mb_upsert_artists  { "rows": [...] }

-- ─── Write: Artists ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_upsert_artists(rows JSONB)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO mb_staging.artists_v1
    (mb_artist_id, name, sort_name, artist_type, country, area,
     begin_date, end_date, comment, ended, mb_last_updated, ingestion_source, provenance)
  SELECT
    x.mb_artist_id, x.name, x.sort_name, x.artist_type, x.country, x.area,
    x.begin_date, x.end_date, x.comment,
    COALESCE(x.ended, false),
    x.mb_last_updated::timestamptz,
    COALESCE(x.ingestion_source, 'api'),
    COALESCE(x.provenance, '{}'::jsonb)
  FROM jsonb_to_recordset(rows) AS x(
    mb_artist_id TEXT, name TEXT, sort_name TEXT, artist_type TEXT, country TEXT, area TEXT,
    begin_date TEXT, end_date TEXT, comment TEXT, ended BOOLEAN, mb_last_updated TEXT,
    ingestion_source TEXT, provenance JSONB
  )
  ON CONFLICT (mb_artist_id) DO UPDATE SET
    name             = EXCLUDED.name,
    sort_name        = EXCLUDED.sort_name,
    artist_type      = EXCLUDED.artist_type,
    country          = EXCLUDED.country,
    area             = EXCLUDED.area,
    begin_date       = EXCLUDED.begin_date,
    end_date         = EXCLUDED.end_date,
    comment          = EXCLUDED.comment,
    ended            = EXCLUDED.ended,
    mb_last_updated  = EXCLUDED.mb_last_updated,
    ingestion_source = EXCLUDED.ingestion_source,
    provenance       = EXCLUDED.provenance;
$$;

-- ─── Write: Artist Aliases ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_upsert_artist_aliases(rows JSONB)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO mb_staging.artist_aliases_v1
    (mb_artist_id, alias_name, alias_type, locale, primary_alias, begin_date, end_date)
  SELECT
    x.mb_artist_id, x.alias_name, x.alias_type, x.locale,
    COALESCE(x.primary_alias, false),
    x.begin_date, x.end_date
  FROM jsonb_to_recordset(rows) AS x(
    mb_artist_id TEXT, alias_name TEXT, alias_type TEXT, locale TEXT,
    primary_alias BOOLEAN, begin_date TEXT, end_date TEXT
  )
  ON CONFLICT (mb_artist_id, alias_name) DO UPDATE SET
    alias_type    = EXCLUDED.alias_type,
    locale        = EXCLUDED.locale,
    primary_alias = EXCLUDED.primary_alias,
    begin_date    = EXCLUDED.begin_date,
    end_date      = EXCLUDED.end_date;
$$;

-- ─── Write: Recordings ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_upsert_recordings(rows JSONB)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO mb_staging.recordings_v1
    (mb_recording_id, title, length_ms, artist_credit, mb_artist_id,
     comment, video, mb_last_updated, ingestion_source, provenance)
  SELECT
    x.mb_recording_id, x.title, x.length_ms, x.artist_credit, x.mb_artist_id,
    x.comment, COALESCE(x.video, false),
    x.mb_last_updated::timestamptz,
    COALESCE(x.ingestion_source, 'api'),
    COALESCE(x.provenance, '{}'::jsonb)
  FROM jsonb_to_recordset(rows) AS x(
    mb_recording_id TEXT, title TEXT, length_ms INTEGER, artist_credit TEXT,
    mb_artist_id TEXT, comment TEXT, video BOOLEAN, mb_last_updated TEXT,
    ingestion_source TEXT, provenance JSONB
  )
  ON CONFLICT (mb_recording_id) DO UPDATE SET
    title            = EXCLUDED.title,
    length_ms        = EXCLUDED.length_ms,
    artist_credit    = EXCLUDED.artist_credit,
    mb_artist_id     = EXCLUDED.mb_artist_id,
    comment          = EXCLUDED.comment,
    video            = EXCLUDED.video,
    mb_last_updated  = EXCLUDED.mb_last_updated,
    ingestion_source = EXCLUDED.ingestion_source,
    provenance       = EXCLUDED.provenance;
$$;

-- ─── Write: ISRCs ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_upsert_isrcs(rows JSONB)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO mb_staging.isrcs_v1 (mb_recording_id, isrc)
  SELECT x.mb_recording_id, x.isrc
  FROM jsonb_to_recordset(rows) AS x(mb_recording_id TEXT, isrc TEXT)
  ON CONFLICT (mb_recording_id, isrc) DO NOTHING;
$$;

-- ─── Write: Works ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_upsert_works(rows JSONB)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO mb_staging.works_v1
    (mb_work_id, title, work_type, language, comment, mb_last_updated, ingestion_source, provenance)
  SELECT
    x.mb_work_id, x.title, x.work_type, x.language, x.comment,
    x.mb_last_updated::timestamptz,
    COALESCE(x.ingestion_source, 'api'),
    COALESCE(x.provenance, '{}'::jsonb)
  FROM jsonb_to_recordset(rows) AS x(
    mb_work_id TEXT, title TEXT, work_type TEXT, language TEXT, comment TEXT,
    mb_last_updated TEXT, ingestion_source TEXT, provenance JSONB
  )
  ON CONFLICT (mb_work_id) DO UPDATE SET
    title            = EXCLUDED.title,
    work_type        = EXCLUDED.work_type,
    language         = EXCLUDED.language,
    comment          = EXCLUDED.comment,
    mb_last_updated  = EXCLUDED.mb_last_updated,
    ingestion_source = EXCLUDED.ingestion_source,
    provenance       = EXCLUDED.provenance;
$$;

-- ─── Write: ISWCs ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_upsert_iswcs(rows JSONB)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO mb_staging.iswcs_v1 (mb_work_id, iswc)
  SELECT x.mb_work_id, x.iswc
  FROM jsonb_to_recordset(rows) AS x(mb_work_id TEXT, iswc TEXT)
  ON CONFLICT (mb_work_id, iswc) DO NOTHING;
$$;

-- ─── Write: Releases ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_upsert_releases(rows JSONB)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO mb_staging.releases_v1
    (mb_release_id, mb_release_group_id, title, artist_credit, mb_artist_id,
     release_date, country, status, barcode, mb_last_updated, ingestion_source, provenance)
  SELECT
    x.mb_release_id, x.mb_release_group_id, x.title, x.artist_credit, x.mb_artist_id,
    x.release_date, x.country, x.status, x.barcode,
    x.mb_last_updated::timestamptz,
    COALESCE(x.ingestion_source, 'api'),
    COALESCE(x.provenance, '{}'::jsonb)
  FROM jsonb_to_recordset(rows) AS x(
    mb_release_id TEXT, mb_release_group_id TEXT, title TEXT, artist_credit TEXT,
    mb_artist_id TEXT, release_date TEXT, country TEXT, status TEXT, barcode TEXT,
    mb_last_updated TEXT, ingestion_source TEXT, provenance JSONB
  )
  ON CONFLICT (mb_release_id) DO UPDATE SET
    mb_release_group_id = EXCLUDED.mb_release_group_id,
    title               = EXCLUDED.title,
    artist_credit       = EXCLUDED.artist_credit,
    mb_artist_id        = EXCLUDED.mb_artist_id,
    release_date        = EXCLUDED.release_date,
    country             = EXCLUDED.country,
    status              = EXCLUDED.status,
    barcode             = EXCLUDED.barcode,
    mb_last_updated     = EXCLUDED.mb_last_updated,
    ingestion_source    = EXCLUDED.ingestion_source,
    provenance          = EXCLUDED.provenance;
$$;

-- ─── Write: Release Groups ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_upsert_release_groups(rows JSONB)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO mb_staging.release_groups_v1
    (mb_release_group_id, title, primary_type, secondary_types, mb_artist_id,
     first_release_date, ingestion_source, provenance)
  SELECT
    x.mb_release_group_id, x.title, x.primary_type,
    COALESCE(
      ARRAY(SELECT jsonb_array_elements_text(x.secondary_types)),
      '{}'::TEXT[]
    ),
    x.mb_artist_id, x.first_release_date,
    COALESCE(x.ingestion_source, 'api'),
    COALESCE(x.provenance, '{}'::jsonb)
  FROM jsonb_to_recordset(rows) AS x(
    mb_release_group_id TEXT, title TEXT, primary_type TEXT, secondary_types JSONB,
    mb_artist_id TEXT, first_release_date TEXT, ingestion_source TEXT, provenance JSONB
  )
  ON CONFLICT (mb_release_group_id) DO UPDATE SET
    title               = EXCLUDED.title,
    primary_type        = EXCLUDED.primary_type,
    secondary_types     = EXCLUDED.secondary_types,
    mb_artist_id        = EXCLUDED.mb_artist_id,
    first_release_date  = EXCLUDED.first_release_date,
    ingestion_source    = EXCLUDED.ingestion_source,
    provenance          = EXCLUDED.provenance;
$$;

-- ─── Write: Relationships ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_upsert_relationships(rows JSONB)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO mb_staging.relationships_v1
    (source_type, source_mb_id, target_type, target_mb_id,
     relationship_type, attributes, begin_date, end_date, direction)
  SELECT
    x.source_type, x.source_mb_id, x.target_type, x.target_mb_id,
    x.relationship_type,
    COALESCE(x.attributes, '{}'::jsonb),
    x.begin_date, x.end_date,
    COALESCE(x.direction, 'forward')
  FROM jsonb_to_recordset(rows) AS x(
    source_type TEXT, source_mb_id TEXT, target_type TEXT, target_mb_id TEXT,
    relationship_type TEXT, attributes JSONB, begin_date TEXT, end_date TEXT, direction TEXT
  )
  ON CONFLICT (source_type, source_mb_id, target_type, target_mb_id, relationship_type)
  DO UPDATE SET
    attributes   = EXCLUDED.attributes,
    begin_date   = EXCLUDED.begin_date,
    end_date     = EXCLUDED.end_date,
    direction    = EXCLUDED.direction;
$$;

-- ─── Write: Entity Matches ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_upsert_entity_matches(rows JSONB)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO mb_staging.entity_matches_v1
    (mb_entity_type, mb_entity_id, musigod_entity_type, musigod_entity_id,
     match_method, confidence, match_signals, review_status, promoted)
  SELECT
    x.mb_entity_type, x.mb_entity_id, x.musigod_entity_type, x.musigod_entity_id,
    x.match_method, x.confidence::numeric(4,3),
    COALESCE(x.match_signals, '{}'::jsonb),
    COALESCE(x.review_status, 'pending'),
    COALESCE(x.promoted, false)
  FROM jsonb_to_recordset(rows) AS x(
    mb_entity_type TEXT, mb_entity_id TEXT, musigod_entity_type TEXT, musigod_entity_id TEXT,
    match_method TEXT, confidence NUMERIC, match_signals JSONB, review_status TEXT, promoted BOOLEAN
  )
  ON CONFLICT (mb_entity_type, mb_entity_id, musigod_entity_type, musigod_entity_id)
  DO UPDATE SET
    match_method   = EXCLUDED.match_method,
    confidence     = GREATEST(mb_staging.entity_matches_v1.confidence, EXCLUDED.confidence),
    match_signals  = EXCLUDED.match_signals,
    review_status  = mb_staging.entity_matches_v1.review_status,  -- never downgrade review status
    updated_at     = now();
$$;

-- ─── State: Get ingestion state ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_get_ingestion_state(
  p_entity_type TEXT,
  p_import_mode TEXT DEFAULT 'api'
) RETURNS JSONB LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT to_jsonb(s)
  FROM mb_staging.ingestion_state_v1 s
  WHERE entity_type = p_entity_type
    AND import_mode = p_import_mode
  LIMIT 1;
$$;

-- ─── State: Save ingestion state (upsert) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_save_ingestion_state(
  p_entity_type TEXT,
  p_import_mode TEXT,
  p_data        JSONB
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO mb_staging.ingestion_state_v1
    (entity_type, import_mode, status, last_offset, last_mb_id,
     total_processed, total_errors, dump_file,
     started_at, completed_at, error_message, metadata, updated_at)
  VALUES (
    p_entity_type,
    p_import_mode,
    COALESCE(p_data->>'status', 'pending'),
    COALESCE((p_data->>'last_offset')::bigint, 0),
    p_data->>'last_mb_id',
    COALESCE((p_data->>'total_processed')::bigint, 0),
    COALESCE((p_data->>'total_errors')::bigint, 0),
    p_data->>'dump_file',
    (p_data->>'started_at')::timestamptz,
    (p_data->>'completed_at')::timestamptz,
    p_data->>'error_message',
    COALESCE(p_data->'metadata', '{}'::jsonb),
    now()
  )
  ON CONFLICT (entity_type, import_mode) DO UPDATE SET
    status          = COALESCE(p_data->>'status',          mb_staging.ingestion_state_v1.status::text)::text,
    last_offset     = COALESCE((p_data->>'last_offset')::bigint,     mb_staging.ingestion_state_v1.last_offset),
    last_mb_id      = COALESCE(p_data->>'last_mb_id',      mb_staging.ingestion_state_v1.last_mb_id),
    total_processed = COALESCE((p_data->>'total_processed')::bigint, mb_staging.ingestion_state_v1.total_processed),
    total_errors    = COALESCE((p_data->>'total_errors')::bigint,    mb_staging.ingestion_state_v1.total_errors),
    dump_file       = COALESCE(p_data->>'dump_file',       mb_staging.ingestion_state_v1.dump_file),
    started_at      = COALESCE((p_data->>'started_at')::timestamptz, mb_staging.ingestion_state_v1.started_at),
    completed_at    = COALESCE((p_data->>'completed_at')::timestamptz, mb_staging.ingestion_state_v1.completed_at),
    error_message   = COALESCE(p_data->>'error_message',   mb_staging.ingestion_state_v1.error_message),
    metadata        = COALESCE(p_data->'metadata',         mb_staging.ingestion_state_v1.metadata),
    updated_at      = now();
END;
$$;

-- ─── Read: ISRC lookup ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_lookup_isrc(p_isrc TEXT)
RETURNS TABLE(mb_recording_id TEXT) LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT mb_recording_id FROM mb_staging.isrcs_v1 WHERE isrc = p_isrc LIMIT 25;
$$;

-- ─── Read: Recording MBID lookup ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_lookup_recording_mbid(p_mbid TEXT)
RETURNS TABLE(mb_recording_id TEXT) LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT mb_recording_id FROM mb_staging.recordings_v1
  WHERE mb_recording_id = p_mbid LIMIT 1;
$$;

-- ─── Read: ISWC lookup ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_lookup_iswc(p_iswc TEXT)
RETURNS TABLE(mb_work_id TEXT) LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT mb_work_id FROM mb_staging.iswcs_v1 WHERE iswc = p_iswc LIMIT 25;
$$;

-- ─── Read: Recording fuzzy title search ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_mb_search_recordings(p_title TEXT)
RETURNS TABLE(mb_recording_id TEXT, title TEXT, length_ms INTEGER, mb_artist_id TEXT)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT mb_recording_id, title, length_ms, mb_artist_id
  FROM mb_staging.recordings_v1
  WHERE lower(title) LIKE lower('%' || p_title || '%')
  LIMIT 25;
$$;

-- Reload schema so PostgREST picks up the new functions immediately
NOTIFY pgrst, 'reload schema';
