-- 20260701_rights_graph_evidence_identifiers.sql
--
-- Rights Graph V1 — Migration 1 of 3
-- Evidence Model + Identifier Registry
--
-- PHILOSOPHY: Every ownership assertion is evidence, not fact.
-- Truth is inferred, never assumed. Sources conflict. Confidence is earned.
--
-- This migration adds two foundational systems:
--
-- 1. graph_evidence_v1
--    Every ownership claim, metadata assertion, or relationship fact
--    must be recorded as evidence with source, confidence, and provenance.
--    Never overwrite. Always append. Complete historical lineage.
--
-- 2. graph_identifiers_v1
--    Multi-source identifier registry for every node.
--    One row per (node_id, namespace, value). Full history preserved.
--    Supports ISWC, ISRC, IPI, CAE, UPC, Spotify, Apple, YouTube,
--    MusicBrainz, Discogs, internal MusiGod IDs, and future namespaces.
--
-- ADDITIVE ONLY. No existing tables modified. Production safe.

-- ─── ENUMS ───────────────────────────────────────────────────────────────────

DO $$ BEGIN
  -- Evidence source types — where did this fact come from?
  CREATE TYPE public.evidence_source_type AS ENUM (
    'musicbrainz',        -- MusicBrainz API
    'discogs',            -- Discogs API
    'genius',             -- Genius API
    'ascap_public',       -- ASCAP public search
    'bmi_public',         -- BMI public search
    'mlc_public',         -- MLC public search
    'sesac_public',       -- SESAC public search
    'pro_api',            -- PRO licensed API access
    'ddex_ern',           -- DDEX ERN delivery
    'crd_import',         -- CRD (Common Works Registration) import
    'iswc_international', -- ISWC International Agency
    'isrc_registry',      -- ISRC registry
    'artist_submission',  -- Artist submitted directly
    'admin_manual',       -- Manual admin entry
    'csv_import',         -- CSV/spreadsheet import
    'stripe_checkout',    -- Derived from Stripe audit intake
    'enrichment_pipeline',-- MusiGod enrichment pipeline
    'web_scrape',         -- Web scraping (lower confidence)
    'inference',          -- Inferred from other evidence
    'partner_api',        -- Partner submitted via API
    'unknown'             -- Source not recorded
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- What type of claim does this evidence support?
  CREATE TYPE public.evidence_claim_type AS ENUM (
    'ownership_share',        -- X owns Y% of this work
    'writing_credit',         -- X wrote this composition
    'publishing_credit',      -- X published this work
    'administration_right',   -- X administers rights for Y
    'recording_credit',       -- X performed/produced this recording
    'release_credit',         -- X released this recording
    'identifier_assertion',   -- This identifier belongs to this node
    'title_assertion',        -- This is the canonical/alternate title
    'metadata_assertion',     -- General metadata (genre, duration, etc.)
    'relationship_assertion', -- Two nodes are related in some way
    'registration_status',    -- Work is registered with PRO/society
    'territory_control',      -- Rights controlled in this territory
    'termination_right',      -- Termination right asserted
    'dispute_claim',          -- Disputed ownership
    'public_domain_claim',    -- Claimed to be public domain
    'license_assertion'       -- Licensed to/from
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Identifier namespaces — what type of ID is this?
  CREATE TYPE public.identifier_namespace AS ENUM (
    'iswc',           -- T-xxx.xxx.xxx-x (composition)
    'isrc',           -- CCXXXyynnnnn (recording)
    'ipi_name',       -- IPI name number (person/entity)
    'ipi_base',       -- IPI base number
    'isni',           -- International Standard Name Identifier
    'cae',            -- Legacy IPI (Compositeur Auteur Editeur)
    'upc',            -- UPC/EAN barcode
    'ean',            -- EAN barcode
    'grid',           -- Global Release Identifier
    'musigod',        -- Internal MusiGod UUID
    'musicbrainz_work',      -- MusicBrainz work MBID
    'musicbrainz_recording', -- MusicBrainz recording MBID
    'musicbrainz_artist',    -- MusicBrainz artist MBID
    'musicbrainz_release',   -- MusicBrainz release MBID
    'musicbrainz_label',     -- MusicBrainz label MBID
    'discogs_release',       -- Discogs release ID
    'discogs_artist',        -- Discogs artist ID
    'discogs_label',         -- Discogs label ID
    'spotify_track',         -- Spotify track ID
    'spotify_artist',        -- Spotify artist ID
    'spotify_album',         -- Spotify album ID
    'apple_music_track',     -- Apple Music track ID
    'apple_music_artist',    -- Apple Music artist ID
    'youtube_video',         -- YouTube video ID
    'youtube_channel',       -- YouTube channel ID
    'soundcloud_track',      -- SoundCloud track ID
    'tidal_track',           -- TIDAL track ID
    'ascap_work',            -- ASCAP work ID
    'bmi_work',              -- BMI work ID
    'sesac_work',            -- SESAC work ID
    'socan_work',            -- SOCAN work ID
    'prs_work',              -- PRS work ID
    'gema_work',             -- GEMA work ID
    'mlc_work',              -- MLC work ID
    'cisac_society',         -- CISAC society code
    'ddex_dpid',             -- DDEX Party Identifier
    'proprietary'            -- Other/future namespaces
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── graph_evidence_v1 ───────────────────────────────────────────────────────
-- Core evidence table. One row per assertion.
-- Never delete, never update the core claim — only update status/confidence.
-- Use superseded_by to chain corrections.

CREATE TABLE IF NOT EXISTS public.graph_evidence_v1 (
  id                  UUID                        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What node(s) does this evidence concern?
  subject_node_id     UUID                        NOT NULL,   -- primary subject (composition, recording, creator, etc.)
  object_node_id      UUID,                                   -- secondary subject (publisher, territory, etc.) if relational
  edge_id             UUID,                                   -- if this evidence supports a specific graph edge

  -- What is being claimed?
  claim_type          public.evidence_claim_type  NOT NULL,
  claim_value         JSONB                       NOT NULL,
  -- claim_value structure depends on claim_type:
  -- ownership_share:    { share_percent: 50.0, right_type: "performance", territory: "WORLD" }
  -- writing_credit:     { role: "composer", credited_name: "Esham" }
  -- identifier_assertion: { namespace: "iswc", value: "T-123.456.789-0" }
  -- title_assertion:    { title: "Rocks Off", title_type: "canonical" }
  -- registration_status:{ registrar: "BMI", status: "registered", reg_number: "..." }

  -- Where did this come from?
  source_type         public.evidence_source_type NOT NULL DEFAULT 'unknown',
  source_url          TEXT,                                   -- direct URL to source record
  source_ref          TEXT,                                   -- source-internal reference ID
  source_retrieved_at TIMESTAMPTZ,                           -- when was this fetched/observed
  raw_payload         JSONB,                                  -- full raw response from source

  -- How confident are we?
  confidence          NUMERIC(4,3)                NOT NULL DEFAULT 0.500
                      CHECK (confidence >= 0 AND confidence <= 1),
  confidence_rationale TEXT,                                  -- why this confidence score

  -- Lifecycle
  status              TEXT                        NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','superseded','retracted','disputed','pending_verification')),
  superseded_by       UUID                        REFERENCES public.graph_evidence_v1(id) ON DELETE SET NULL,
  retraction_reason   TEXT,

  -- Who asserted this?
  asserted_by_node_id UUID,                                   -- if a partner/artist/publisher asserted it
  asserted_by_user_id UUID,                                   -- if a human admin asserted it

  created_at          TIMESTAMPTZ                 NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ                 NOT NULL DEFAULT now()
);

-- Indexes for the evidence table
CREATE INDEX IF NOT EXISTS graph_evidence_v1_subject_idx
  ON public.graph_evidence_v1 (subject_node_id);

CREATE INDEX IF NOT EXISTS graph_evidence_v1_object_idx
  ON public.graph_evidence_v1 (object_node_id)
  WHERE object_node_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS graph_evidence_v1_edge_idx
  ON public.graph_evidence_v1 (edge_id)
  WHERE edge_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS graph_evidence_v1_claim_type_idx
  ON public.graph_evidence_v1 (claim_type);

CREATE INDEX IF NOT EXISTS graph_evidence_v1_source_type_idx
  ON public.graph_evidence_v1 (source_type);

CREATE INDEX IF NOT EXISTS graph_evidence_v1_status_idx
  ON public.graph_evidence_v1 (status);

CREATE INDEX IF NOT EXISTS graph_evidence_v1_confidence_idx
  ON public.graph_evidence_v1 (confidence DESC);

CREATE INDEX IF NOT EXISTS graph_evidence_v1_subject_claim_idx
  ON public.graph_evidence_v1 (subject_node_id, claim_type, status);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.fn_touch_graph_evidence_v1_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_touch_graph_evidence_v1_updated_at ON public.graph_evidence_v1;
CREATE TRIGGER trg_touch_graph_evidence_v1_updated_at
  BEFORE UPDATE ON public.graph_evidence_v1
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_graph_evidence_v1_updated_at();

-- RLS
ALTER TABLE public.graph_evidence_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS graph_evidence_v1_service_role_all ON public.graph_evidence_v1;
CREATE POLICY graph_evidence_v1_service_role_all
  ON public.graph_evidence_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS graph_evidence_v1_authenticated_read ON public.graph_evidence_v1;
CREATE POLICY graph_evidence_v1_authenticated_read
  ON public.graph_evidence_v1 FOR SELECT TO authenticated USING (true);

-- ─── graph_identifiers_v1 ────────────────────────────────────────────────────
-- Multi-source identifier registry. One row per (node_id, namespace, value).
-- Never delete rows. Deactivate via is_active = false.
-- Multiple sources can assert the same identifier — each gets its own row.

CREATE TABLE IF NOT EXISTS public.graph_identifiers_v1 (
  id                  UUID                        PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id             UUID                        NOT NULL,   -- the graph node this identifier belongs to
  namespace           public.identifier_namespace NOT NULL,
  value               TEXT                        NOT NULL,

  -- Provenance
  source_type         public.evidence_source_type NOT NULL DEFAULT 'unknown',
  source_url          TEXT,
  source_ref          TEXT,
  observed_at         TIMESTAMPTZ                 NOT NULL DEFAULT now(),

  -- Confidence
  confidence          NUMERIC(4,3)                NOT NULL DEFAULT 0.800
                      CHECK (confidence >= 0 AND confidence <= 1),

  -- Status
  is_active           BOOLEAN                     NOT NULL DEFAULT true,
  deactivated_at      TIMESTAMPTZ,
  deactivation_reason TEXT,

  -- Link back to evidence if this identifier was asserted via the evidence system
  evidence_id         UUID                        REFERENCES public.graph_evidence_v1(id) ON DELETE SET NULL,

  created_at          TIMESTAMPTZ                 NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ                 NOT NULL DEFAULT now(),

  -- One active identifier per (node, namespace) from each source
  -- Multiple sources can assert the same namespace — they get separate rows
  CONSTRAINT graph_identifiers_v1_node_ns_value_source_unique
    UNIQUE (node_id, namespace, value, source_type)
);

CREATE INDEX IF NOT EXISTS graph_identifiers_v1_node_idx
  ON public.graph_identifiers_v1 (node_id);

CREATE INDEX IF NOT EXISTS graph_identifiers_v1_namespace_value_idx
  ON public.graph_identifiers_v1 (namespace, value);

CREATE INDEX IF NOT EXISTS graph_identifiers_v1_value_idx
  ON public.graph_identifiers_v1 (value);

CREATE INDEX IF NOT EXISTS graph_identifiers_v1_active_idx
  ON public.graph_identifiers_v1 (node_id, namespace)
  WHERE is_active = true;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.fn_touch_graph_identifiers_v1_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_touch_graph_identifiers_v1_updated_at ON public.graph_identifiers_v1;
CREATE TRIGGER trg_touch_graph_identifiers_v1_updated_at
  BEFORE UPDATE ON public.graph_identifiers_v1
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_graph_identifiers_v1_updated_at();

-- RLS
ALTER TABLE public.graph_identifiers_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS graph_identifiers_v1_service_role_all ON public.graph_identifiers_v1;
CREATE POLICY graph_identifiers_v1_service_role_all
  ON public.graph_identifiers_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS graph_identifiers_v1_authenticated_read ON public.graph_identifiers_v1;
CREATE POLICY graph_identifiers_v1_authenticated_read
  ON public.graph_identifiers_v1 FOR SELECT TO authenticated USING (true);

-- ─── HELPER FUNCTION: resolve node by identifier ──────────────────────────────
-- Given a namespace + value, return the node_id with highest-confidence active identifier.
-- Used by the partner API and enrichment pipeline for dedup and linking.

CREATE OR REPLACE FUNCTION public.fn_resolve_node_by_identifier(
  p_namespace public.identifier_namespace,
  p_value     TEXT
)
RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT node_id
  FROM public.graph_identifiers_v1
  WHERE namespace = p_namespace
    AND value     = p_value
    AND is_active = true
  ORDER BY confidence DESC, observed_at DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.fn_resolve_node_by_identifier(public.identifier_namespace, TEXT)
  TO service_role, authenticated;

-- ─── HELPER FUNCTION: get all active identifiers for a node ──────────────────

CREATE OR REPLACE FUNCTION public.fn_get_node_identifiers(p_node_id UUID)
RETURNS TABLE (
  namespace   public.identifier_namespace,
  value       TEXT,
  confidence  NUMERIC,
  source_type public.evidence_source_type,
  observed_at TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  SELECT namespace, value, confidence, source_type, observed_at
  FROM public.graph_identifiers_v1
  WHERE node_id   = p_node_id
    AND is_active = true
  ORDER BY namespace, confidence DESC;
$$;

GRANT EXECUTE ON FUNCTION public.fn_get_node_identifiers(UUID)
  TO service_role, authenticated;

-- ─── RELOAD POSTGREST ────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
