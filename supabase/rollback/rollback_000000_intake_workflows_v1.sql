-- supabase/rollback/rollback_000000_intake_workflows_v1.sql
-- Reverses migration 20260730000000_intake_workflows_v1.sql
-- Apply LAST — after rollbacks 000003, 000002, 000001.
-- DROP TABLE CASCADE will also remove child tables if still present,
-- but apply the earlier rollbacks first to be surgical.
--
-- Usage:
--   psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/rollback/rollback_000000_intake_workflows_v1.sql

DROP TRIGGER IF EXISTS trg_set_intake_workflow_closed_at        ON registrations.intake_workflows_v1;
DROP TRIGGER IF EXISTS trg_touch_intake_workflows_v1_updated_at ON registrations.intake_workflows_v1;
DROP FUNCTION IF EXISTS registrations.fn_set_intake_workflow_closed_at();
DROP FUNCTION IF EXISTS registrations.fn_touch_intake_workflows_v1_updated_at();

DROP POLICY IF EXISTS intake_workflows_v1_service_role_all ON registrations.intake_workflows_v1;
DROP TABLE IF EXISTS registrations.intake_workflows_v1 CASCADE;

NOTIFY pgrst, 'reload schema';
