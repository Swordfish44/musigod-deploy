-- catalog_enrichments_v1
-- Stores background enrichment jobs triggered by n8n

CREATE TABLE IF NOT EXISTS catalog.catalog_enrichments_v1 (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_name     TEXT NOT NULL,
  publisher_name  TEXT NOT NULL DEFAULT 'MusiGod Publishing Administration',
  publisher_ipi   TEXT,
  max_releases    INT NOT NULL DEFAULT 30,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','RUNNING','DONE','ERROR')),
  progress_pct    INT DEFAULT 0,
  progress_label  TEXT,
  result          JSONB,   -- full enriched payload stored here on DONE
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION catalog.fn_touch_enrichment_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_touch_enrichment_updated_at ON catalog.catalog_enrichments_v1;
CREATE TRIGGER trg_touch_enrichment_updated_at
  BEFORE UPDATE ON catalog.catalog_enrichments_v1
  FOR EACH ROW EXECUTE FUNCTION catalog.fn_touch_enrichment_updated_at();

-- Index for status polling
CREATE INDEX IF NOT EXISTS idx_catalog_enrichments_status
  ON catalog.catalog_enrichments_v1(status, created_at DESC);
