-- Phase 1A: Catalog intake and enrichment queue
-- Idempotent. Safe to run multiple times.
-- Extends rights_audits_v1 without touching existing columns.

-- catalog_v1: stores song/release level data submitted by artists
CREATE TABLE IF NOT EXISTS public.catalog_v1 (
  catalog_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id          UUID        NOT NULL REFERENCES public.rights_audits_v1(audit_id) ON DELETE CASCADE,
  track_title       TEXT        NOT NULL,
  album_title       TEXT,
  isrc              TEXT,
  iswc              TEXT,
  upc               TEXT,
  release_date      DATE,
  distributor       TEXT,
  pro_affiliation   TEXT,
  publisher         TEXT,
  writers           TEXT[]      NOT NULL DEFAULT '{}',
  producers         TEXT[]      NOT NULL DEFAULT '{}',
  featured_artists  TEXT[]      NOT NULL DEFAULT '{}',
  writer_splits     JSONB       DEFAULT '{}'::jsonb,
  producer_splits   JSONB       DEFAULT '{}'::jsonb,
  revenue_sources   TEXT[]      NOT NULL DEFAULT '{}',
  label_agreement   BOOLEAN     DEFAULT false,
  publishing_admin  TEXT,
  neighboring_rights_admin TEXT,
  mechanical_admin  TEXT,
  content_id_registered  BOOLEAN DEFAULT false,
  soundexchange_registered BOOLEAN DEFAULT false,
  notes             TEXT,
  source            TEXT        NOT NULL DEFAULT 'catalog-intake',
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_v1_audit_id_idx   ON public.catalog_v1 (audit_id);
CREATE INDEX IF NOT EXISTS catalog_v1_isrc_idx        ON public.catalog_v1 (isrc) WHERE isrc IS NOT NULL;
CREATE INDEX IF NOT EXISTS catalog_v1_created_idx     ON public.catalog_v1 (created_at DESC);

-- catalog_enrichment_v1: queues and tracks enrichment jobs per track
CREATE TABLE IF NOT EXISTS public.catalog_enrichment_v1 (
  enrichment_id     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id        UUID        REFERENCES public.catalog_v1(catalog_id) ON DELETE CASCADE,
  audit_id          UUID        REFERENCES public.rights_audits_v1(audit_id) ON DELETE CASCADE,
  status            TEXT        NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','PROCESSING','COMPLETE','FAILED','SKIPPED')),
  isrc_found        TEXT,
  iswc_found        TEXT,
  pro_registration_found   BOOLEAN,
  soundexchange_found      BOOLEAN,
  content_id_found         BOOLEAN,
  mlc_found                BOOLEAN,
  confidence_score         NUMERIC(5,2) DEFAULT 0,
  enrichment_source        TEXT,
  raw_result               JSONB       DEFAULT '{}'::jsonb,
  error_message            TEXT,
  processed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enrichment_v1_audit_id_idx  ON public.catalog_enrichment_v1 (audit_id);
CREATE INDEX IF NOT EXISTS enrichment_v1_status_idx    ON public.catalog_enrichment_v1 (status);
CREATE INDEX IF NOT EXISTS enrichment_v1_catalog_id_idx ON public.catalog_enrichment_v1 (catalog_id);

-- Track catalog submission count on audit record
ALTER TABLE public.rights_audits_v1
  ADD COLUMN IF NOT EXISTS catalog_submitted_at  TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS catalog_track_count   INTEGER     DEFAULT 0;

-- RLS
ALTER TABLE public.catalog_v1            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_enrichment_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS catalog_v1_service_role_all            ON public.catalog_v1;
DROP POLICY IF EXISTS catalog_enrichment_v1_service_role_all ON public.catalog_enrichment_v1;

CREATE POLICY catalog_v1_service_role_all
  ON public.catalog_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY catalog_enrichment_v1_service_role_all
  ON public.catalog_enrichment_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

-- updated_at trigger for catalog_v1
CREATE OR REPLACE FUNCTION public.set_catalog_v1_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_catalog_v1_updated_at ON public.catalog_v1;
CREATE TRIGGER trg_catalog_v1_updated_at
  BEFORE UPDATE ON public.catalog_v1
  FOR EACH ROW EXECUTE FUNCTION public.set_catalog_v1_updated_at();
