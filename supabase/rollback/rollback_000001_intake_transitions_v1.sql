-- supabase/rollback/rollback_000001_intake_transitions_v1.sql
-- Reverses migration 20260730000001_intake_transitions_v1.sql
-- Apply AFTER rollback_000003 and rollback_000002, BEFORE rollback_000000.
--
-- Usage:
--   psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/rollback/rollback_000001_intake_transitions_v1.sql

DROP POLICY IF EXISTS intake_transitions_v1_service_role_select ON registrations.intake_transitions_v1;
DROP POLICY IF EXISTS intake_transitions_v1_service_role_insert ON registrations.intake_transitions_v1;
DROP TABLE IF EXISTS registrations.intake_transitions_v1;

NOTIFY pgrst, 'reload schema';
