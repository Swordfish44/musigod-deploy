-- Mission 4: Audit Recovery Pipeline — grant + verification pass
-- Safe to re-run. Does NOT re-create tables (all defined in 20260601/20260602 migrations).
-- Run this AFTER the earlier migration sets:
--   20260601_musigod_recovery_cases_ops_layer_v1.sql
--   20260601_musigod_audit_intelligence_v1.sql
--   20260601_musigod_recovery_cases_grants_v1.sql
--   20260602_musigod_intelligence_layer_v1.sql
--   20260602_musigod_recovery_conversion_v1.sql

-- ============================================================
-- SECTION 1: catalog_writer_splits_v1 (Mission 3 prerequisite)
-- Create if not already applied.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.catalog_writer_splits_v1 (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id    UUID NOT NULL,
  track_title  TEXT NOT NULL,
  release_title TEXT,
  writers      JSONB NOT NULL DEFAULT '[]',
  validated    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT catalog_writer_splits_artist_track UNIQUE (artist_id, track_title)
);

CREATE INDEX IF NOT EXISTS idx_writer_splits_artist ON public.catalog_writer_splits_v1 (artist_id);

-- Trigger to keep updated_at current
CREATE OR REPLACE FUNCTION public.fn_touch_writer_splits_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_writer_splits_updated_at ON public.catalog_writer_splits_v1;
CREATE TRIGGER trg_writer_splits_updated_at
  BEFORE UPDATE ON public.catalog_writer_splits_v1
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_writer_splits_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.catalog_writer_splits_v1 TO service_role;
GRANT USAGE ON SCHEMA public TO service_role;

-- ============================================================
-- SECTION 2: admin_queues_v1 — additional grants for new APIs
-- ============================================================

-- get-admin-queue.js and update-admin-queue-task.js read/write this table.
-- Grants may already exist from 20260601_musigod_recovery_cases_grants_v1.sql.
-- Re-granting is idempotent.

GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.admin_queues_v1        TO service_role;
GRANT SELECT ON registrations.v_admin_queue_summary_v1                        TO service_role;
GRANT SELECT ON registrations.recovery_cases_v1                               TO service_role;
GRANT SELECT ON registrations.audit_reports_v1                                TO service_role;

-- ============================================================
-- SECTION 3: RLS bypass confirmation for service_role
-- ============================================================

-- Ensure service_role bypasses RLS on audit tables.
-- (Supabase service_role already bypasses RLS by default, but explicit is safer.)

ALTER TABLE IF EXISTS registrations.admin_queues_v1   ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS svc_all_admin_queues ON registrations.admin_queues_v1;
CREATE POLICY svc_all_admin_queues ON registrations.admin_queues_v1
  TO service_role USING (true) WITH CHECK (true);

ALTER TABLE IF EXISTS public.catalog_writer_splits_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS svc_all_writer_splits ON public.catalog_writer_splits_v1;
CREATE POLICY svc_all_writer_splits ON public.catalog_writer_splits_v1
  TO service_role USING (true) WITH CHECK (true);
