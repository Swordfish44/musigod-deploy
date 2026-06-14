-- MusiGod Recovery Cases: PostgREST Grants + RLS Policies
-- Run after 20260601_musigod_recovery_cases_ops_layer_v1.sql
-- Idempotent.

-- ============================================================
-- GRANT table and view access to service_role
-- (service_role bypasses RLS but still needs schema+table grants)
-- ============================================================

GRANT USAGE ON SCHEMA registrations TO service_role;
GRANT USAGE ON SCHEMA registrations TO anon;
GRANT USAGE ON SCHEMA registrations TO authenticated;

-- Tables
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.recovery_cases_v1          TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.artist_documents_v1         TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.artist_activity_timeline_v1 TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.admin_queues_v1             TO service_role;

-- Views
GRANT SELECT ON registrations.v_recovered_money_dashboard_v1  TO service_role;
GRANT SELECT ON registrations.v_case_type_breakdown_v1        TO service_role;
GRANT SELECT ON registrations.v_admin_queue_summary_v1        TO service_role;
GRANT SELECT ON registrations.v_artist_recovery_summary_v1    TO service_role;

-- Functions
GRANT EXECUTE ON FUNCTION registrations.fn_log_artist_activity_v1       TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_create_admin_queue_task_v1   TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_update_recovery_case_status_v1 TO service_role;

-- ============================================================
-- RLS POLICIES
-- All writes go through API routes using service_role key.
-- Service role bypasses RLS entirely — these policies cover
-- any future anon/authenticated read access.
-- ============================================================

-- recovery_cases_v1: no public access
DROP POLICY IF EXISTS service_role_all_recovery_cases ON registrations.recovery_cases_v1;
CREATE POLICY service_role_all_recovery_cases
  ON registrations.recovery_cases_v1
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- artist_documents_v1: no public access
DROP POLICY IF EXISTS service_role_all_artist_documents ON registrations.artist_documents_v1;
CREATE POLICY service_role_all_artist_documents
  ON registrations.artist_documents_v1
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- artist_activity_timeline_v1: no public access
DROP POLICY IF EXISTS service_role_all_timeline ON registrations.artist_activity_timeline_v1;
CREATE POLICY service_role_all_timeline
  ON registrations.artist_activity_timeline_v1
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- admin_queues_v1: no public access
DROP POLICY IF EXISTS service_role_all_admin_queues ON registrations.admin_queues_v1;
CREATE POLICY service_role_all_admin_queues
  ON registrations.admin_queues_v1
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
