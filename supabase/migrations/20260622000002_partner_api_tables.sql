-- 20260622_partner_api_tables.sql
--
-- Scaffolds the partner API key management and call audit tables for
-- Lane B: Partner-facing rights resolution API.
--
-- partners_v1         — one row per licensed partner (Suno, Udio, etc.)
-- partner_api_calls_v1 — immutable audit log of every resolve-rights call
--
-- No royalty or payout logic here. Read-only partner API only.

-- ─── partners_v1 ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.partners_v1 (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_name        TEXT        NOT NULL,
  api_key_hash        TEXT        NOT NULL UNIQUE,  -- bcrypt/sha256 hash; plaintext never stored
  rate_limit_per_min  INTEGER     NOT NULL DEFAULT 60,
  active              BOOLEAN     NOT NULL DEFAULT true,
  contact_email       TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partners_v1_api_key_hash_idx ON public.partners_v1 (api_key_hash);

ALTER TABLE public.partners_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partners_v1_service_role_all ON public.partners_v1;
CREATE POLICY partners_v1_service_role_all
  ON public.partners_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.fn_touch_partners_v1_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_touch_partners_v1_updated_at ON public.partners_v1;
CREATE TRIGGER trg_touch_partners_v1_updated_at
  BEFORE UPDATE ON public.partners_v1
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_partners_v1_updated_at();

-- ─── partner_api_calls_v1 ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.partner_api_calls_v1 (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id      UUID        REFERENCES public.partners_v1(id) ON DELETE SET NULL,
  partner_name    TEXT,                     -- denormalized for fast reporting
  endpoint        TEXT        NOT NULL,     -- e.g. 'resolve-rights'
  identifier_type TEXT,                     -- 'isrc' | 'iswc' | 'musigod_id'
  identifier      TEXT,                     -- the actual lookup value (not PII)
  http_status     INTEGER,
  response_ms     INTEGER,
  work_found      BOOLEAN,
  error_message   TEXT,
  called_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_api_calls_v1_partner_idx  ON public.partner_api_calls_v1 (partner_id);
CREATE INDEX IF NOT EXISTS partner_api_calls_v1_called_at_idx ON public.partner_api_calls_v1 (called_at DESC);
CREATE INDEX IF NOT EXISTS partner_api_calls_v1_identifier_idx ON public.partner_api_calls_v1 (identifier) WHERE identifier IS NOT NULL;

ALTER TABLE public.partner_api_calls_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_api_calls_v1_service_role_all ON public.partner_api_calls_v1;
CREATE POLICY partner_api_calls_v1_service_role_all
  ON public.partner_api_calls_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── Reload PostgREST ────────────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';
