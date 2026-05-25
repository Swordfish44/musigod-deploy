-- Canonical post-payment fulfillment reliability layer for MusiGod Rights Audits.
-- Idempotent and safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS fulfillment;

GRANT USAGE ON SCHEMA fulfillment TO service_role;

CREATE TABLE IF NOT EXISTS fulfillment.audit_status_v1 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id TEXT UNIQUE NOT NULL,
  email TEXT,
  stripe_session_id TEXT,
  current_status TEXT NOT NULL,
  status_message TEXT,
  estimated_completion TEXT,
  last_error TEXT,
  n8n_retry_count INTEGER NOT NULL DEFAULT 0,
  fulfillment_queued_at TIMESTAMPTZ,
  processing_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_status_v1_current_status_check CHECK (
    current_status IN (
      'PENDING_PAYMENT',
      'PAID',
      'FULFILLMENT_QUEUED',
      'PROCESSING',
      'COMPLETED',
      'FAILED_RETRYING',
      'ACTION_REQUIRED'
    )
  )
);

ALTER TABLE fulfillment.audit_status_v1
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS stripe_session_id TEXT,
  ADD COLUMN IF NOT EXISTS status_message TEXT,
  ADD COLUMN IF NOT EXISTS estimated_completion TEXT,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS n8n_retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fulfillment_queued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS fulfillment.audit_event_log_v1 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id TEXT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  source_system TEXT NOT NULL,
  correlation_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_event_log_v1_severity_check CHECK (severity IN ('debug','info','warn','error')),
  CONSTRAINT audit_event_log_v1_source_check CHECK (source_system IN ('stripe','api','n8n','resend','fulfillment','frontend'))
);

ALTER TABLE fulfillment.audit_event_log_v1
  ADD COLUMN IF NOT EXISTS audit_id TEXT,
  ADD COLUMN IF NOT EXISTS event_type TEXT,
  ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'info',
  ADD COLUMN IF NOT EXISTS source_system TEXT,
  ADD COLUMN IF NOT EXISTS correlation_id TEXT,
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION fulfillment.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_status_updated_at ON fulfillment.audit_status_v1;

CREATE TRIGGER trg_audit_status_updated_at
BEFORE UPDATE ON fulfillment.audit_status_v1
FOR EACH ROW
EXECUTE FUNCTION fulfillment.set_updated_at();

CREATE INDEX IF NOT EXISTS audit_status_v1_audit_id_idx
  ON fulfillment.audit_status_v1 (audit_id);

CREATE INDEX IF NOT EXISTS audit_status_v1_email_idx
  ON fulfillment.audit_status_v1 (lower(email));

CREATE INDEX IF NOT EXISTS audit_status_v1_current_status_updated_idx
  ON fulfillment.audit_status_v1 (current_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS audit_status_v1_stripe_session_idx
  ON fulfillment.audit_status_v1 (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_event_log_v1_audit_created_idx
  ON fulfillment.audit_event_log_v1 (audit_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_event_log_v1_type_created_idx
  ON fulfillment.audit_event_log_v1 (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_event_log_v1_severity_created_idx
  ON fulfillment.audit_event_log_v1 (severity, created_at DESC);

ALTER TABLE fulfillment.audit_status_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE fulfillment.audit_event_log_v1 ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE fulfillment.audit_status_v1 TO service_role;
GRANT ALL ON TABLE fulfillment.audit_event_log_v1 TO service_role;

DROP POLICY IF EXISTS audit_status_service_role_all ON fulfillment.audit_status_v1;
CREATE POLICY audit_status_service_role_all
ON fulfillment.audit_status_v1
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS audit_event_log_service_role_all ON fulfillment.audit_event_log_v1;
CREATE POLICY audit_event_log_service_role_all
ON fulfillment.audit_event_log_v1
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);
