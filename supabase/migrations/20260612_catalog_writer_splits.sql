CREATE TABLE IF NOT EXISTS public.catalog_writer_splits_v1 (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id   UUID        NOT NULL,
  track_title TEXT        NOT NULL,   -- stored lowercase-trimmed
  release_title TEXT,
  writers     JSONB       NOT NULL DEFAULT '[]',
  -- writers structure: [{name, split_pct, role, ipi}]
  -- split_pct: writer's share of the writer's 50% (values must sum to 100 per track)
  validated   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT catalog_writer_splits_artist_track UNIQUE (artist_id, track_title)
);

CREATE INDEX IF NOT EXISTS idx_writer_splits_artist
  ON public.catalog_writer_splits_v1 (artist_id);
