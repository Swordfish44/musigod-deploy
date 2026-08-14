-- Explicit, auditable writer-split validation.
-- Additive and safe to re-run. Does not validate any existing split row.

ALTER TABLE public.catalog_writer_splits_v1
  ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS validated_by TEXT,
  ADD COLUMN IF NOT EXISTS validation_method TEXT,
  ADD COLUMN IF NOT EXISTS validation_evidence_ref TEXT;

CREATE OR REPLACE FUNCTION public.rpc_validate_writer_splits(
  p_artist_id UUID,
  p_track_title TEXT,
  p_expected_updated_at TIMESTAMPTZ,
  p_validated_by TEXT,
  p_evidence_ref TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.catalog_writer_splits_v1%ROWTYPE;
  v_total NUMERIC;
  v_missing_names INTEGER;
BEGIN
  IF NULLIF(btrim(p_validated_by), '') IS NULL THEN
    RAISE EXCEPTION 'validated_by is required' USING ERRCODE = '22023';
  END IF;
  IF NULLIF(btrim(p_evidence_ref), '') IS NULL THEN
    RAISE EXCEPTION 'evidence_ref is required' USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_row
  FROM public.catalog_writer_splits_v1
  WHERE artist_id = p_artist_id
    AND track_title = lower(btrim(p_track_title))
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'writer split row not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'writer split row changed after review' USING ERRCODE = '40001';
  END IF;
  IF jsonb_typeof(v_row.writers) <> 'array' OR jsonb_array_length(v_row.writers) = 0 THEN
    RAISE EXCEPTION 'writers must be a non-empty array' USING ERRCODE = '22023';
  END IF;

  SELECT
    COALESCE(sum((writer->>'split_pct')::numeric), 0),
    count(*) FILTER (WHERE NULLIF(btrim(writer->>'name'), '') IS NULL)
  INTO v_total, v_missing_names
  FROM jsonb_array_elements(v_row.writers) AS writer;

  IF v_missing_names > 0 THEN
    RAISE EXCEPTION 'every writer must have a name' USING ERRCODE = '22023';
  END IF;
  IF abs(v_total - 100) > 0.1 THEN
    RAISE EXCEPTION 'writer splits must total 100; got %', v_total USING ERRCODE = '22023';
  END IF;

  UPDATE public.catalog_writer_splits_v1
  SET validated = true,
      validated_at = now(),
      validated_by = btrim(p_validated_by),
      validation_method = 'admin_evidence_review',
      validation_evidence_ref = btrim(p_evidence_ref)
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'artist_id', v_row.artist_id,
    'track_title', v_row.track_title,
    'validated', v_row.validated,
    'validated_at', v_row.validated_at,
    'validated_by', v_row.validated_by,
    'validation_method', v_row.validation_method,
    'validation_evidence_ref', v_row.validation_evidence_ref
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_validate_writer_splits(
  UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_validate_writer_splits(
  UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

SELECT pg_notify('pgrst', 'reload schema');
