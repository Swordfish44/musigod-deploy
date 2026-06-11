-- Manual writer credit overrides for tracks that automated enrichment can't fill.
-- Keyed on (artist_name, track_title) — case-insensitive unique index.
-- writers is a JSONB array of {name, role} objects.

CREATE TABLE IF NOT EXISTS public.catalog_writer_overrides (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_name  TEXT        NOT NULL,
  track_title  TEXT        NOT NULL,
  writers      JSONB       NOT NULL DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_writer_overrides_artist_track
  ON public.catalog_writer_overrides (lower(artist_name), lower(track_title));

CREATE OR REPLACE FUNCTION public.fn_touch_writer_override_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_touch_writer_override_updated_at ON public.catalog_writer_overrides;
CREATE TRIGGER trg_touch_writer_override_updated_at
  BEFORE UPDATE ON public.catalog_writer_overrides
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_writer_override_updated_at();
