-- catalog_enrichments_v1 in public schema
-- (catalog schema not exposed via PostgREST — using public to match all other tables)

CREATE TABLE IF NOT EXISTS public.catalog_enrichments_v1 (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_name     TEXT NOT NULL,
  publisher_name  TEXT NOT NULL DEFAULT 'MusiGod Publishing Administration',
  publisher_ipi   TEXT,
  max_releases    INT NOT NULL DEFAULT 30,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','RUNNING','DONE','ERROR')),
  progress_pct    INT DEFAULT 0,
  progress_label  TEXT,
  result          JSONB,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.fn_touch_catalog_enrichment_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_touch_catalog_enrichment_updated_at ON public.catalog_enrichments_v1;
CREATE TRIGGER trg_touch_catalog_enrichment_updated_at
  BEFORE UPDATE ON public.catalog_enrichments_v1
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_catalog_enrichment_updated_at();

CREATE INDEX IF NOT EXISTS idx_catalog_enrichments_status
  ON public.catalog_enrichments_v1(status, created_at DESC);
