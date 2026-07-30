-- supabase/migrations/20260730000000_intake_workflows_v1.sql
--
-- Intake Workflows — one row per artist engagement.
-- Persists the current state of lib/intake-state-machine.js.
-- State transitions are written to intake_transitions_v1 (migration 000001).
-- Item completeness is tracked in intake_item_statuses_v1 (migration 000002).
-- Audit handoff manifests live in intake_manifests_v1 (migration 000003).
--
-- LOCAL / NON-PRODUCTION ONLY.
-- Do not apply to production without attorney sign-off on engagement language.
-- (billing_activation_blocked: true enforced in lib/intake-config.js)
--
-- Schema: registrations
-- Depends on: registrations.artists_v1 (pre-existing)
-- ADDITIVE ONLY — no existing tables modified.

-- ── Workflow table ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS registrations.intake_workflows_v1 (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- External correlation key — used across all intake tables and in API responses
  engagement_id   TEXT        UNIQUE NOT NULL,

  -- Artist FK — may be null until identity questionnaire is confirmed
  artist_id       UUID        REFERENCES registrations.artists_v1(id) ON DELETE SET NULL,
  artist_email    TEXT        NOT NULL,

  -- Pilot / tier — from lib/intake-config.js
  pilot_id        TEXT,                       -- e.g., 'pilot-001'; NULL = no pilot config
  tier            TEXT        NOT NULL DEFAULT 'individual'
                    CHECK (tier IN ('individual', 'enterprise')),

  -- State machine current state — must be one of the 21 states in lib/intake-state-machine.js
  current_state   TEXT        NOT NULL
                    CHECK (current_state IN (
                      'INVITED',
                      'IDENTITY_PENDING',
                      'IDENTITY_CONFIRMED',
                      'ENGAGEMENT_PENDING',
                      'ENGAGEMENT_SENT',
                      'ENGAGEMENT_SIGNED',
                      'LOA_PENDING',
                      'LOA_SENT',
                      'LOA_SIGNED',
                      'EXPORT_GUIDANCE_PENDING',
                      'DOCUMENTS_PARTIAL',
                      'DOCUMENTS_COMPLETE',
                      'DOCUMENTS_VALIDATING',
                      'DOCUMENTS_NEED_CORRECTION',
                      'OWNERSHIP_REVIEW',
                      'AUTHORIZATION_REVIEW',
                      'AUDIT_READY',
                      'AUDIT_IN_PROGRESS',
                      'CLIENT_ACTION_REQUIRED',
                      'CLOSED',
                      'WITHDRAWN'
                    )),

  -- Correlation / tracing
  correlation_id  TEXT,

  -- Set when workflow reaches a terminal state (CLOSED or WITHDRAWN)
  closed_at       TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE registrations.intake_workflows_v1 IS
  'One row per artist intake engagement. Tracks current state machine state. '
  'State transitions appended to intake_transitions_v1. '
  'LOCAL/NON-PRODUCTION: billing_activation_blocked enforced in lib/intake-config.js.';

COMMENT ON COLUMN registrations.intake_workflows_v1.engagement_id IS
  'External correlation key shared across intake_transitions_v1, intake_item_statuses_v1, '
  'intake_manifests_v1, and intake_upload_tokens_v1.';

COMMENT ON COLUMN registrations.intake_workflows_v1.current_state IS
  'Current state per lib/intake-state-machine.js STATES array. '
  'CLOSED and WITHDRAWN are terminal (idempotent). '
  'All 21 valid state values are enforced by CHECK constraint.';

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS intake_workflows_v1_artist_email_idx
  ON registrations.intake_workflows_v1 (artist_email);

CREATE INDEX IF NOT EXISTS intake_workflows_v1_artist_id_idx
  ON registrations.intake_workflows_v1 (artist_id)
  WHERE artist_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS intake_workflows_v1_current_state_idx
  ON registrations.intake_workflows_v1 (current_state);

CREATE INDEX IF NOT EXISTS intake_workflows_v1_pilot_id_idx
  ON registrations.intake_workflows_v1 (pilot_id)
  WHERE pilot_id IS NOT NULL;

-- ── updated_at trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION registrations.fn_touch_intake_workflows_v1_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_intake_workflows_v1_updated_at
  ON registrations.intake_workflows_v1;

CREATE TRIGGER trg_touch_intake_workflows_v1_updated_at
  BEFORE UPDATE ON registrations.intake_workflows_v1
  FOR EACH ROW EXECUTE FUNCTION registrations.fn_touch_intake_workflows_v1_updated_at();

-- ── closed_at trigger — set automatically on terminal state ───────────────────

CREATE OR REPLACE FUNCTION registrations.fn_set_intake_workflow_closed_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_state IN ('CLOSED', 'WITHDRAWN') AND OLD.current_state NOT IN ('CLOSED', 'WITHDRAWN') THEN
    NEW.closed_at = NOW();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_intake_workflow_closed_at
  ON registrations.intake_workflows_v1;

CREATE TRIGGER trg_set_intake_workflow_closed_at
  BEFORE UPDATE ON registrations.intake_workflows_v1
  FOR EACH ROW EXECUTE FUNCTION registrations.fn_set_intake_workflow_closed_at();

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Deny by default. service_role has full access.
-- No direct artist-facing access — all reads go through operator API routes.

ALTER TABLE registrations.intake_workflows_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS intake_workflows_v1_service_role_all
  ON registrations.intake_workflows_v1;

CREATE POLICY intake_workflows_v1_service_role_all
  ON registrations.intake_workflows_v1
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── Schema cache reload ───────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
