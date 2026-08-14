-- supabase/rollback/rollback_000002_intake_item_statuses_v1.sql
-- Reverses migration 20260730000002_intake_item_statuses_v1.sql
-- Apply AFTER rollback_000003 (manifests), BEFORE rollback_000001 (transitions).
--
-- Usage:
--   psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/rollback/rollback_000002_intake_item_statuses_v1.sql

DROP TRIGGER IF EXISTS trg_touch_intake_item_statuses_v1_updated_at ON registrations.intake_item_statuses_v1;
DROP FUNCTION IF EXISTS registrations.fn_touch_intake_item_statuses_v1_updated_at();

DROP POLICY IF EXISTS intake_item_statuses_v1_service_role_all ON registrations.intake_item_statuses_v1;
DROP TABLE IF EXISTS registrations.intake_item_statuses_v1;

NOTIFY pgrst, 'reload schema';
