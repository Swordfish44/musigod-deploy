-- 20260622_ai_consent_ledger.sql
--
-- Lane A: AI-licensing consent ledger.
--
-- Adds per-work consent state for three independent AI use types:
--   ai_training   — use of the work to train an AI model
--   ai_generation — use of the work as a reference in AI-generated output
--   nil_use       — name/image/likeness use in AI contexts
--
-- Default state for ALL works is 'unset' — no implicit consent in either
-- direction. A rightsholder must take an affirmative action to grant or deny.
-- This is critical: no existing artist data is defaulted to 'granted'.
--
-- This is the ownership-side counterpart to what attribution-detection tools
-- (e.g. Sureel AI) do on the usage-detection side. Sureel tells you an AI
-- model touched a song. This table tells you whether the owner consented.
--
-- work_id references graph_nodes_v1.id (the canonical node for a composition
-- or recording in the rights graph). Consent is set at the composition level
-- when possible; recording-level overrides are supported via the same table.
--
-- Touches consent state → per CLAUDE.md, human PR review required before merge.

-- ─── Enums ───────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE public.ai_consent_type AS ENUM (
    'ai_training',
    'ai_generation',
    'nil_use'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.ai_consent_status AS ENUM (
    'granted',
    'denied',
    'unset'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── ai_consent_v1 ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_consent_v1 (
  id              UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id         UUID                    NOT NULL REFERENCES public.graph_nodes_v1(id) ON DELETE CASCADE,
  consent_type    public.ai_consent_type  NOT NULL,
  status          public.ai_consent_status NOT NULL DEFAULT 'unset',
  granted_by      UUID                    REFERENCES public.graph_nodes_v1(id) ON DELETE SET NULL,
                                          -- node_id of the rightsholder (artist/publisher) who set this
  granted_at      TIMESTAMPTZ,            -- NULL when status = 'unset'
  expires_at      TIMESTAMPTZ,            -- NULL = no expiry; set for time-limited licenses
  provenance      JSONB NOT NULL DEFAULT '{}'::jsonb,
                  -- { flow: 'artist_portal' | 'admin' | 'bulk_import' | 'api',
                  --   set_by_user_id: uuid | null,
                  --   ip_address: text | null,
                  --   notes: text | null }
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One row per work+type combination. Updating consent replaces the row via upsert.
  CONSTRAINT ai_consent_v1_work_type_unique UNIQUE (work_id, consent_type)
);

CREATE INDEX IF NOT EXISTS ai_consent_v1_work_id_idx
  ON public.ai_consent_v1 (work_id);

CREATE INDEX IF NOT EXISTS ai_consent_v1_status_idx
  ON public.ai_consent_v1 (status);

CREATE INDEX IF NOT EXISTS ai_consent_v1_consent_type_idx
  ON public.ai_consent_v1 (consent_type);

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- Service role only for writes. Read access for authenticated role so the
-- partner resolve-rights API can query consent state server-side.

ALTER TABLE public.ai_consent_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_consent_v1_service_role_all ON public.ai_consent_v1;
CREATE POLICY ai_consent_v1_service_role_all
  ON public.ai_consent_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ai_consent_v1_authenticated_read ON public.ai_consent_v1;
CREATE POLICY ai_consent_v1_authenticated_read
  ON public.ai_consent_v1 FOR SELECT TO authenticated USING (true);

-- ─── updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_touch_ai_consent_v1_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_touch_ai_consent_v1_updated_at ON public.ai_consent_v1;
CREATE TRIGGER trg_touch_ai_consent_v1_updated_at
  BEFORE UPDATE ON public.ai_consent_v1
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_ai_consent_v1_updated_at();

-- ─── Traversal function ───────────────────────────────────────────────────────
-- fn_get_consent_state_v1(work_id UUID)
-- Returns one row per consent_type with current status, granted_at, expires_at,
-- and provenance. Missing rows (not yet set by rightsholder) are returned as
-- status='unset' so callers always get all three types regardless of whether
-- consent has been recorded.

CREATE OR REPLACE FUNCTION public.fn_get_consent_state_v1(p_work_id UUID)
RETURNS TABLE (
  consent_type    public.ai_consent_type,
  status          public.ai_consent_status,
  granted_by      UUID,
  granted_at      TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  provenance      JSONB,
  is_expired      BOOLEAN,
  effective_status TEXT   -- 'granted' | 'denied' | 'unset' | 'expired'
)
LANGUAGE sql STABLE AS $$
  SELECT
    t.consent_type,
    COALESCE(c.status, 'unset'::public.ai_consent_status)         AS status,
    c.granted_by,
    c.granted_at,
    c.expires_at,
    COALESCE(c.provenance, '{}'::jsonb)                           AS provenance,
    -- is_expired: granted but past expiry date
    CASE
      WHEN c.status = 'granted' AND c.expires_at IS NOT NULL AND c.expires_at < now()
      THEN true ELSE false
    END                                                            AS is_expired,
    -- effective_status: what the partner API should actually surface
    CASE
      WHEN c.status IS NULL                                        THEN 'unset'
      WHEN c.status = 'granted'
           AND c.expires_at IS NOT NULL
           AND c.expires_at < now()                               THEN 'expired'
      ELSE c.status::text
    END                                                            AS effective_status
  FROM (
    VALUES
      ('ai_training'::public.ai_consent_type),
      ('ai_generation'::public.ai_consent_type),
      ('nil_use'::public.ai_consent_type)
  ) AS t(consent_type)
  LEFT JOIN public.ai_consent_v1 c
    ON c.work_id = p_work_id
   AND c.consent_type = t.consent_type;
$$;

-- Grant execute to service_role and authenticated so the partner API and
-- any future artist portal can call it.
GRANT EXECUTE ON FUNCTION public.fn_get_consent_state_v1(UUID)
  TO service_role, authenticated;

-- ─── Reload PostgREST ─────────────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';
