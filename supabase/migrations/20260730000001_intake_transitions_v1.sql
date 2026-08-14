-- supabase/migrations/20260730000001_intake_transitions_v1.sql
--
-- Intake Transitions — append-only audit of every state machine transition.
-- Each row maps to the record returned by makeTransitionRecord() in
-- lib/intake-state-machine.js. Rows are never updated or deleted.
--
-- Column names mirror makeTransitionRecord() return keys exactly so that
-- API routes can insert the record with a direct spread.
--
-- Schema: registrations
-- Depends on: registrations.intake_workflows_v1 (migration 000000)
-- APPEND-ONLY: no UPDATE or DELETE permitted by RLS policy.

-- ── Transition log table ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS registrations.intake_transitions_v1 (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FK to the workflow this transition belongs to
  workflow_id     UUID        NOT NULL
                    REFERENCES registrations.intake_workflows_v1(id) ON DELETE CASCADE,

  -- From makeTransitionRecord() — column names match JS return keys
  prior_state     TEXT        NOT NULL,
  new_state       TEXT        NOT NULL,
  trigger         TEXT        NOT NULL,  -- e.g., 'identity_submitted', 'agreement_signed'
  actor           TEXT        NOT NULL,  -- operator ID, system, or 'artist'
  evidence_ref    TEXT,                  -- document ID, envelope ID, or other evidence pointer
  auth_scope      TEXT,                  -- LOA auth scope if relevant, or null
  correlation_id  TEXT        NOT NULL,
  reason          TEXT        NOT NULL DEFAULT '',

  -- Immutable timestamp — set at insert, never changed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- No updated_at: this table is append-only
);

COMMENT ON TABLE registrations.intake_transitions_v1 IS
  'Append-only record of every intake state machine transition. '
  'Column names mirror makeTransitionRecord() in lib/intake-state-machine.js. '
  'Rows are never updated or deleted — RLS enforces INSERT-only for service_role.';

COMMENT ON COLUMN registrations.intake_transitions_v1.trigger IS
  'The event that caused this transition, e.g.: '
  'identity_submitted, agreement_signed, loa_signed, document_uploaded, '
  'operator_approved, inactivity_timeout, artist_withdrew.';

COMMENT ON COLUMN registrations.intake_transitions_v1.evidence_ref IS
  'Optional pointer to the artifact that triggered the transition: '
  'document_id from artist_documents_v1, envelope_id from signed_agreements_v1, '
  'or other correlation reference.';

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS intake_transitions_v1_workflow_id_idx
  ON registrations.intake_transitions_v1 (workflow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS intake_transitions_v1_new_state_idx
  ON registrations.intake_transitions_v1 (new_state, created_at DESC);

CREATE INDEX IF NOT EXISTS intake_transitions_v1_correlation_id_idx
  ON registrations.intake_transitions_v1 (correlation_id);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- service_role: INSERT only (append-only enforcement).
-- No UPDATE or DELETE policy — any UPDATE/DELETE attempt is denied.

ALTER TABLE registrations.intake_transitions_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS intake_transitions_v1_service_role_insert
  ON registrations.intake_transitions_v1;

CREATE POLICY intake_transitions_v1_service_role_insert
  ON registrations.intake_transitions_v1
  FOR INSERT TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS intake_transitions_v1_service_role_select
  ON registrations.intake_transitions_v1;

CREATE POLICY intake_transitions_v1_service_role_select
  ON registrations.intake_transitions_v1
  FOR SELECT TO service_role
  USING (true);

-- Intentionally no UPDATE or DELETE policy — append-only by design.

-- ── Schema cache reload ───────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
