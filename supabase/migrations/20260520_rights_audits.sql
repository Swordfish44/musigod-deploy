-- Rights audit intake storage for MusiGod production.
-- The Vercel API uses the Supabase service role with raw PostgREST fetches.
-- Browser clients do not access this table directly.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.rights_audits_v1 (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'NEW'
    CHECK (status IN ('NEW','IN_REVIEW','WAITING_ON_ARTIST','READY_FOR_ONBOARDING','CLOSED')),
  artist_name TEXT NOT NULL,
  legal_name TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  pro_affiliation TEXT,
  publisher_name TEXT,
  catalog_size TEXT NOT NULL,
  released_music TEXT NOT NULL,
  platforms TEXT[] NOT NULL DEFAULT '{}',
  rights_concerns TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'rights-audit.html',
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rights_audits_v1_status_created_idx
  ON public.rights_audits_v1 (status, created_at DESC);

CREATE INDEX IF NOT EXISTS rights_audits_v1_email_idx
  ON public.rights_audits_v1 (lower(email));

CREATE OR REPLACE FUNCTION public.set_rights_audits_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rights_audits_updated_at ON public.rights_audits_v1;

CREATE TRIGGER trg_rights_audits_updated_at
BEFORE UPDATE ON public.rights_audits_v1
FOR EACH ROW
EXECUTE FUNCTION public.set_rights_audits_updated_at();

ALTER TABLE public.rights_audits_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rights_audits_service_role_all ON public.rights_audits_v1;

CREATE POLICY rights_audits_service_role_all
ON public.rights_audits_v1
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
