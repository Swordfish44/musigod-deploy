-- 20260619_catalog_enriched_tracks_v1.sql
--
-- This is intentionally separate from catalog_v1, which is scoped to the paid
-- customer self-submission flow (audit_id NOT NULL FK -> rights_audits_v1).
-- The enrichment pipeline runs for artists who have NOT necessarily submitted
-- a paid audit (e.g. Esham, run for outreach/registration prep), so it needs
-- its own table with no audit_id dependency.
--
-- Root cause this fixes: enrichArtistCatalog() in lib/enrich-catalog.js builds
-- a rich per-track array (enrichedTracks), but api/enrich-artist.js and
-- api/run-enrichment-job.js only ever persisted the CSV-formatted OUTPUT of
-- that array (lib/generate-registration-files.js) into a single JSONB blob
-- on one job row in catalog_enrichments_v1. No per-track rows were ever
-- written anywhere. This table is the missing persistence layer.

CREATE TABLE IF NOT EXISTS public.catalog_enriched_tracks_v1 (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              UUID        REFERENCES public.catalog_enrichments_v1(id) ON DELETE SET NULL,
  artist_name         TEXT        NOT NULL,
  artist_mbid         TEXT,
  release_title       TEXT,
  release_year        TEXT,
  release_type        TEXT,
  release_mbid        TEXT,
  release_group_mbid  TEXT,
  track_number        TEXT,
  track_title         TEXT        NOT NULL,
  track_duration      INTEGER,
  recording_mbid      TEXT,
  isrcs               TEXT[]      NOT NULL DEFAULT '{}',
  iswc                TEXT,
  writers             JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- [{name, mbid, ipi, role, source}]
  artist_credits      TEXT[]      NOT NULL DEFAULT '{}',
  enriched            BOOLEAN     NOT NULL DEFAULT false,
  enrichment_source   TEXT,       -- 'musicbrainz' | 'discogs' | 'genius' | 'manual' | 'recovered_from_csv'
  enrichment_error    TEXT,
  recovered_from_csv  BOOLEAN     NOT NULL DEFAULT false,
  -- Generated dedup key so re-running enrichment for the same artist upserts
  -- instead of duplicating rows. Lowercased so casing drift doesn't create dupes.
  dedup_key           TEXT GENERATED ALWAYS AS (
                          lower(artist_name) || '|' || coalesce(recording_mbid, '') || '|' || lower(track_title)
                        ) STORED,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_enriched_tracks_v1_dedup_key_idx
  ON public.catalog_enriched_tracks_v1 (dedup_key);

CREATE INDEX IF NOT EXISTS catalog_enriched_tracks_v1_artist_idx
  ON public.catalog_enriched_tracks_v1 (artist_name);

CREATE INDEX IF NOT EXISTS catalog_enriched_tracks_v1_job_idx
  ON public.catalog_enriched_tracks_v1 (job_id);

CREATE INDEX IF NOT EXISTS catalog_enriched_tracks_v1_recording_mbid_idx
  ON public.catalog_enriched_tracks_v1 (recording_mbid) WHERE recording_mbid IS NOT NULL;

CREATE INDEX IF NOT EXISTS catalog_enriched_tracks_v1_iswc_idx
  ON public.catalog_enriched_tracks_v1 (iswc) WHERE iswc IS NOT NULL;

-- RLS — service_role only, consistent with catalog_v1 / catalog_enrichments_v1
ALTER TABLE public.catalog_enriched_tracks_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS catalog_enriched_tracks_v1_service_role_all ON public.catalog_enriched_tracks_v1;

CREATE POLICY catalog_enriched_tracks_v1_service_role_all
  ON public.catalog_enriched_tracks_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.fn_touch_catalog_enriched_tracks_v1_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_touch_catalog_enriched_tracks_v1_updated_at ON public.catalog_enriched_tracks_v1;
CREATE TRIGGER trg_touch_catalog_enriched_tracks_v1_updated_at
  BEFORE UPDATE ON public.catalog_enriched_tracks_v1
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_catalog_enriched_tracks_v1_updated_at();

-- Reload PostgREST schema cache so the table is queryable immediately
NOTIFY pgrst, 'reload schema';
