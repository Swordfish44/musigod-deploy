-- 20260701_rights_graph_investigations_confidence.sql
--
-- Rights Graph V1 — Migration 2 of 3
-- Investigation Objects + Confidence History + Node Change Log
--
-- Three systems:
--
-- 1. graph_investigations_v1
--    Structured investigation objects. Each composition supports
--    continuous AI-driven investigation: ownership conflicts,
--    missing identifiers, duplicate detection, royalty opportunities.
--    NOT an LLM chatbot. Structured objects only.
--
-- 2. graph_confidence_history_v1
--    Every confidence score change on an edge or evidence record
--    is logged with reasoning. Confidence is earned over time.
--
-- 3. graph_node_history_v1
--    Every node change (created, modified, merged, split, deprecated,
--    superseded) is logged. Complete historical traceability.
--
-- ADDITIVE ONLY. No existing tables modified. Production safe.

-- ─── ENUMS ───────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE public.investigation_type AS ENUM (
    'ownership_conflict',         -- Two sources disagree on ownership %
    'missing_iswc',               -- Composition has no ISWC
    'missing_isrc',               -- Recording has no ISRC
    'missing_ipi',                -- Creator has no IPI number
    'missing_pro_registration',   -- Work not registered with any PRO
    'missing_mlc_registration',   -- Work not registered with MLC
    'missing_publisher',          -- No publisher on record
    'missing_split_sheet',        -- No ownership split sheet
    'split_sheet_incomplete',     -- Split sheet exists but < 100%
    'duplicate_composition',      -- Possible duplicate work detected
    'duplicate_recording',        -- Possible duplicate recording detected
    'publisher_inconsistency',    -- Publisher data conflicts across sources
    'territory_gap',              -- Rights not covered in a territory
    'registration_expired',       -- Registration lapsed
    'unclaimed_royalty_opportunity', -- Royalties likely sitting unclaimed
    'metadata_conflict',          -- Metadata conflicts across sources
    'ai_licensing_unset',         -- AI consent not set
    'orphan_recording',           -- Recording not linked to a composition
    'identity_ambiguity'          -- Two nodes may be the same entity
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.investigation_status AS ENUM (
    'open',           -- Needs attention
    'in_progress',    -- Being investigated
    'resolved',       -- Issue resolved
    'dismissed',      -- Investigated, not actionable
    'wont_fix',       -- Known issue, accepted
    'needs_data'      -- Cannot resolve without more data
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.investigation_priority AS ENUM (
    'critical',   -- Blocking royalty collection
    'high',       -- Significant royalty impact
    'medium',     -- Should be fixed
    'low',        -- Nice to have
    'info'        -- Informational only
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.node_change_type AS ENUM (
    'created',      -- Node first created
    'updated',      -- Metadata updated
    'merged',       -- Two nodes merged into one
    'split',        -- One node split into two
    'deprecated',   -- Node marked deprecated
    'superseded',   -- Node replaced by another
    'restored',     -- Deprecated node restored
    'linked',       -- Node linked to graph entity
    'unlinked'      -- Node unlinked
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── graph_investigations_v1 ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.graph_investigations_v1 (
  id                  UUID                            PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What node is under investigation?
  subject_node_id     UUID                            NOT NULL,
  secondary_node_id   UUID,                           -- second node if conflict between two

  -- Investigation type and status
  investigation_type  public.investigation_type       NOT NULL,
  status              public.investigation_status     NOT NULL DEFAULT 'open',
  priority            public.investigation_priority   NOT NULL DEFAULT 'medium',

  -- What was found?
  title               TEXT                            NOT NULL,
  description         TEXT,
  findings            JSONB                           NOT NULL DEFAULT '{}',
  -- findings structure per investigation_type:
  -- ownership_conflict: { source_a: "BMI", share_a: 50, source_b: "ASCAP", share_b: 70, delta: 20 }
  -- duplicate_composition: { candidate_node_id: uuid, similarity_score: 0.94, matching_fields: [...] }
  -- unclaimed_royalty_opportunity: { estimated_usd: 1200, periods: [...], societies: [...] }
  -- missing_iswc: { has_title: true, has_writers: true, registerable: true }

  -- Recommended action
  recommended_action  TEXT,
  action_url          TEXT,                           -- deep link to relevant admin page

  -- Evidence references — what triggered this investigation?
  triggering_evidence_ids UUID[]                      NOT NULL DEFAULT '{}',

  -- Resolution
  resolved_by_user_id UUID,
  resolved_at         TIMESTAMPTZ,
  resolution_notes    TEXT,
  resolution_evidence_id UUID                         REFERENCES public.graph_evidence_v1(id) ON DELETE SET NULL,

  -- Auto-generated vs human-created
  generated_by        TEXT                            NOT NULL DEFAULT 'system'
                      CHECK (generated_by IN ('system','agent','human','partner_api')),

  -- Dedup — don't create the same investigation twice for same node+type
  CONSTRAINT graph_investigations_v1_subject_type_open_unique
    UNIQUE NULLS NOT DISTINCT (subject_node_id, investigation_type, status),

  created_at          TIMESTAMPTZ                     NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ                     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS graph_investigations_v1_subject_idx
  ON public.graph_investigations_v1 (subject_node_id);

CREATE INDEX IF NOT EXISTS graph_investigations_v1_type_status_idx
  ON public.graph_investigations_v1 (investigation_type, status);

CREATE INDEX IF NOT EXISTS graph_investigations_v1_priority_status_idx
  ON public.graph_investigations_v1 (priority, status)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS graph_investigations_v1_status_idx
  ON public.graph_investigations_v1 (status);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.fn_touch_graph_investigations_v1_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_touch_graph_investigations_v1_updated_at ON public.graph_investigations_v1;
CREATE TRIGGER trg_touch_graph_investigations_v1_updated_at
  BEFORE UPDATE ON public.graph_investigations_v1
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_graph_investigations_v1_updated_at();

-- RLS
ALTER TABLE public.graph_investigations_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS graph_investigations_v1_service_role_all ON public.graph_investigations_v1;
CREATE POLICY graph_investigations_v1_service_role_all
  ON public.graph_investigations_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS graph_investigations_v1_authenticated_read ON public.graph_investigations_v1;
CREATE POLICY graph_investigations_v1_authenticated_read
  ON public.graph_investigations_v1 FOR SELECT TO authenticated USING (true);

-- ─── graph_confidence_history_v1 ─────────────────────────────────────────────
-- Immutable log. Every confidence score change is appended.

CREATE TABLE IF NOT EXISTS public.graph_confidence_history_v1 (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What entity's confidence changed?
  entity_type     TEXT        NOT NULL CHECK (entity_type IN ('edge','evidence')),
  entity_id       UUID        NOT NULL,

  -- The change
  confidence_from NUMERIC(4,3),  -- NULL for initial assignment
  confidence_to   NUMERIC(4,3)   NOT NULL CHECK (confidence_to >= 0 AND confidence_to <= 1),
  delta           NUMERIC(4,3)   GENERATED ALWAYS AS (confidence_to - COALESCE(confidence_from, 0)) STORED,

  -- Why did it change?
  reason          TEXT        NOT NULL,
  supporting_evidence_count  INTEGER NOT NULL DEFAULT 0,
  conflicting_evidence_count INTEGER NOT NULL DEFAULT 0,
  changed_by      TEXT        NOT NULL DEFAULT 'system'
                  CHECK (changed_by IN ('system','agent','human','partner_api')),
  changed_by_user_id UUID,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS graph_confidence_history_v1_entity_idx
  ON public.graph_confidence_history_v1 (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS graph_confidence_history_v1_created_at_idx
  ON public.graph_confidence_history_v1 (created_at DESC);

-- RLS
ALTER TABLE public.graph_confidence_history_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS graph_confidence_history_v1_service_role_all ON public.graph_confidence_history_v1;
CREATE POLICY graph_confidence_history_v1_service_role_all
  ON public.graph_confidence_history_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS graph_confidence_history_v1_authenticated_read ON public.graph_confidence_history_v1;
CREATE POLICY graph_confidence_history_v1_authenticated_read
  ON public.graph_confidence_history_v1 FOR SELECT TO authenticated USING (true);

-- ─── graph_node_history_v1 ───────────────────────────────────────────────────
-- Immutable audit log for every node change.

CREATE TABLE IF NOT EXISTS public.graph_node_history_v1 (
  id              UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id         UUID                    NOT NULL,
  change_type     public.node_change_type NOT NULL,

  -- Snapshot of node state at time of change
  node_type       TEXT,
  label_before    TEXT,
  label_after     TEXT,
  properties_before JSONB,
  properties_after  JSONB,

  -- For merges and splits
  related_node_ids UUID[]                 DEFAULT '{}',

  -- Who and why
  changed_by      TEXT                    NOT NULL DEFAULT 'system',
  changed_by_user_id UUID,
  change_reason   TEXT,
  change_source   TEXT,

  created_at      TIMESTAMPTZ             NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS graph_node_history_v1_node_idx
  ON public.graph_node_history_v1 (node_id);

CREATE INDEX IF NOT EXISTS graph_node_history_v1_change_type_idx
  ON public.graph_node_history_v1 (change_type);

CREATE INDEX IF NOT EXISTS graph_node_history_v1_created_at_idx
  ON public.graph_node_history_v1 (created_at DESC);

-- RLS
ALTER TABLE public.graph_node_history_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS graph_node_history_v1_service_role_all ON public.graph_node_history_v1;
CREATE POLICY graph_node_history_v1_service_role_all
  ON public.graph_node_history_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS graph_node_history_v1_authenticated_read ON public.graph_node_history_v1;
CREATE POLICY graph_node_history_v1_authenticated_read
  ON public.graph_node_history_v1 FOR SELECT TO authenticated USING (true);

-- ─── HELPER: open investigation (idempotent) ─────────────────────────────────
-- Call this from the enrichment pipeline whenever a gap is detected.
-- Uses the UNIQUE constraint to avoid duplicates — safe to call repeatedly.

CREATE OR REPLACE FUNCTION public.fn_open_investigation(
  p_subject_node_id   UUID,
  p_investigation_type public.investigation_type,
  p_title             TEXT,
  p_description       TEXT,
  p_priority          public.investigation_priority DEFAULT 'medium',
  p_findings          JSONB DEFAULT '{}',
  p_recommended_action TEXT DEFAULT NULL,
  p_generated_by      TEXT DEFAULT 'system'
)
RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.graph_investigations_v1 (
    subject_node_id, investigation_type, title, description,
    priority, findings, recommended_action, generated_by, status
  )
  VALUES (
    p_subject_node_id, p_investigation_type, p_title, p_description,
    p_priority, p_findings, p_recommended_action, p_generated_by, 'open'
  )
  ON CONFLICT (subject_node_id, investigation_type, status) DO UPDATE
    SET description        = EXCLUDED.description,
        findings           = EXCLUDED.findings,
        recommended_action = EXCLUDED.recommended_action,
        updated_at         = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_open_investigation(UUID, public.investigation_type, TEXT, TEXT, public.investigation_priority, JSONB, TEXT, TEXT)
  TO service_role;

-- ─── RELOAD POSTGREST ────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
