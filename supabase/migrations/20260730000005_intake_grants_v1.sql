-- supabase/migrations/20260730000005_intake_grants_v1.sql
--
-- Table-level grants for all intake_* tables in the registrations schema.
-- Schema USAGE is already granted by 20260601000002_musigod_recovery_cases_grants_v1.sql.
-- GRANT is idempotent — safe to re-run.

-- intake_workflows_v1: service_role needs full CRUD
GRANT SELECT, INSERT, UPDATE, DELETE
  ON registrations.intake_workflows_v1
  TO service_role;

-- intake_transitions_v1: append-only — service_role INSERT + SELECT only
GRANT SELECT, INSERT
  ON registrations.intake_transitions_v1
  TO service_role;

-- intake_item_statuses_v1: service_role needs full CRUD
GRANT SELECT, INSERT, UPDATE, DELETE
  ON registrations.intake_item_statuses_v1
  TO service_role;

-- intake_manifests_v1: append-only — service_role INSERT + SELECT only
GRANT SELECT, INSERT
  ON registrations.intake_manifests_v1
  TO service_role;

-- intake_upload_tokens_v1: service_role needs full CRUD (issuance + revocation)
GRANT SELECT, INSERT, UPDATE, DELETE
  ON registrations.intake_upload_tokens_v1
  TO service_role;

NOTIFY pgrst, 'reload schema';
