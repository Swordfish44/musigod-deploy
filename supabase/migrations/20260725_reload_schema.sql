-- 20260725_registration_readiness_rpc_hardening.sql
--
-- Hardens the Registration Readiness SECURITY DEFINER RPCs and requests a
-- PostgREST schema-cache reload. Safe and idempotent; no catalog rows change.

ALTER FUNCTION public.rpc_upsert_readiness_decision(
  UUID, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB
) SET search_path = public, pg_temp;

ALTER FUNCTION public.rpc_get_readiness_summary(
  TEXT, UUID[]
) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.rpc_upsert_readiness_decision(
  UUID, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.rpc_get_readiness_summary(
  TEXT, UUID[]
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_upsert_readiness_decision(
  UUID, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB
) TO service_role;

GRANT EXECUTE ON FUNCTION public.rpc_get_readiness_summary(
  TEXT, UUID[]
) TO service_role;

SELECT pg_notify('pgrst', 'reload schema');
