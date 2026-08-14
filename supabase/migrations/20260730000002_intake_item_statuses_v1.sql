-- supabase/migrations/20260730000002_intake_item_statuses_v1.sql
--
-- Intake Item Statuses — current status of each checklist item per workflow.
-- One row per (workflow_id, item_id). UPSERTED each time an item changes status.
-- History is recorded in intake_transitions_v1 via state machine transitions.
--
-- item_id values mirror MANDATORY_ITEMS and OPTIONAL_ITEMS from
-- lib/completeness-engine.js. status values mirror ITEM_STATUS constants.
--
-- The AUDIT_READY gate requires all 7 mandatory items to be VALID and
-- zero items in AWAITING_REVIEW or REJECTED state.
--
-- Schema: registrations
-- Depends on: registrations.intake_workflows_v1 (migration 000000)

-- ── Item status table ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS registrations.intake_item_statuses_v1 (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  workflow_id     UUID        NOT NULL
                    REFERENCES registrations.intake_workflows_v1(id) ON DELETE CASCADE,

  -- Item ID from lib/completeness-engine.js MANDATORY_ITEMS + OPTIONAL_ITEMS
  item_id         TEXT        NOT NULL
                    CHECK (item_id IN (
                      -- 7 mandatory items (gate AUDIT_READY)
                      'identity_confirmed',
                      'engagement_signed',
                      'loa_signed',
                      'soundexchange_catalog',
                      'soundexchange_payments',
                      'featured_performer_declaration',
                      'master_ownership',
                      -- 6 optional items
                      'soundexchange_search_and_claim',
                      'soundexchange_adjustments',
                      'distributor_statements',
                      'label_statements',
                      'ppl_statements',
                      'international_mandates'
                    )),

  -- Status from lib/completeness-engine.js ITEM_STATUS
  status          TEXT        NOT NULL
                    CHECK (status IN (
                      'REQUIRED',
                      'RECEIVED',
                      'VALID',
                      'REJECTED',
                      'MISSING',
                      'OPTIONAL',
                      'NOT_APPLICABLE',
                      'CLIENT_DECLINED',
                      'UNABLE_TO_OBTAIN',
                      'THIRD_PARTY_REQUIRED',
                      'AWAITING_REVIEW'
                    )),

  -- Document IDs associated with this item (from artist_documents_v1)
  document_ids    UUID[]      NOT NULL DEFAULT '{}',

  -- Free-text notes from operator or system
  notes           TEXT        NOT NULL DEFAULT '',

  -- Operator who last reviewed / set this status (null = auto-set by system)
  reviewed_by     TEXT,

  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workflow_id, item_id)
);

COMMENT ON TABLE registrations.intake_item_statuses_v1 IS
  'Current status of each intake checklist item. '
  'item_id and status values mirror lib/completeness-engine.js constants. '
  'AUDIT_READY requires all 7 mandatory items = VALID with none in AWAITING_REVIEW/REJECTED.';

COMMENT ON COLUMN registrations.intake_item_statuses_v1.item_id IS
  'Mandatory (7): identity_confirmed, engagement_signed, loa_signed, soundexchange_catalog, '
  'soundexchange_payments, featured_performer_declaration, master_ownership. '
  'Optional (6): soundexchange_search_and_claim, soundexchange_adjustments, '
  'distributor_statements, label_statements, ppl_statements, international_mandates.';

COMMENT ON COLUMN registrations.intake_item_statuses_v1.status IS
  'REQUIRED/MISSING: expected, not yet received. '
  'RECEIVED: received, validation pending. '
  'VALID: passes all checks — counts toward AUDIT_READY gate. '
  'REJECTED/AWAITING_REVIEW: blocks AUDIT_READY gate. '
  'NOT_APPLICABLE/CLIENT_DECLINED/UNABLE_TO_OBTAIN/THIRD_PARTY_REQUIRED: '
  'terminal non-blocking statuses for optional items or operator exceptions.';

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS intake_item_statuses_v1_workflow_id_idx
  ON registrations.intake_item_statuses_v1 (workflow_id);

CREATE INDEX IF NOT EXISTS intake_item_statuses_v1_status_idx
  ON registrations.intake_item_statuses_v1 (status)
  WHERE status IN ('REQUIRED', 'MISSING', 'REJECTED', 'AWAITING_REVIEW');

-- ── updated_at trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION registrations.fn_touch_intake_item_statuses_v1_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_intake_item_statuses_v1_updated_at
  ON registrations.intake_item_statuses_v1;

CREATE TRIGGER trg_touch_intake_item_statuses_v1_updated_at
  BEFORE UPDATE ON registrations.intake_item_statuses_v1
  FOR EACH ROW EXECUTE FUNCTION registrations.fn_touch_intake_item_statuses_v1_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE registrations.intake_item_statuses_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS intake_item_statuses_v1_service_role_all
  ON registrations.intake_item_statuses_v1;

CREATE POLICY intake_item_statuses_v1_service_role_all
  ON registrations.intake_item_statuses_v1
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── Schema cache reload ───────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
