-- supabase/rollback/rollback_000003_intake_manifests_v1.sql
-- Reverses migration 20260730000003_intake_manifests_v1.sql
-- Apply BEFORE rollback_000002 and rollback_000001 (manifests depends on workflows).
-- Requires: psql or direct DB access. NOT executable via REST API.
--
-- Usage:
--   psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/rollback/rollback_000003_intake_manifests_v1.sql

DROP POLICY IF EXISTS intake_manifests_v1_service_role_select ON registrations.intake_manifests_v1;
DROP POLICY IF EXISTS intake_manifests_v1_service_role_insert ON registrations.intake_manifests_v1;
DROP TABLE IF EXISTS registrations.intake_manifests_v1;

NOTIFY pgrst, 'reload schema';
