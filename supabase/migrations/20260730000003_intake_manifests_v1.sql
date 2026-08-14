-- supabase/migrations/20260730000003_intake_manifests_v1.sql
--
-- Intake Manifests — immutable audit handoff records.
-- Each row is created by lib/audit-handoff.js createManifest() when an
-- intake reaches AUDIT_READY. Manifests are never updated or deleted.
--
-- Column names mirror the createManifest() return object exactly.
-- Key design constraints enforced here and in code:
--   - dry_run CHECK (dry_run = TRUE): production manifests require a
--     legal unlock migration (attorney sign-off prerequisite).
--   - artist_email_hash: plain artist email is excluded from the manifest
--     per audit-handoff.js design. Only SHA-256(email) is stored.
--   - documents JSONB: document IDs + hashes only, never content or storage paths.
--   - RLS INSERT-only: manifests are immutable after creation.
--
-- Schema: registrations
-- Depends on: registrations.intake_workflows_v1 (migration 000000)

-- ── Manifest table ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS registrations.intake_manifests_v1 (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- External manifest identifier: 'manifest-{engagement_id}-{unix_ms}'
  manifest_id             TEXT        UNIQUE NOT NULL,

  -- FK to the workflow at the point of handoff
  -- RESTRICT: cannot delete a workflow that has a manifest
  workflow_id             UUID        NOT NULL
                            REFERENCES registrations.intake_workflows_v1(id) ON DELETE RESTRICT,

  engagement_id           TEXT        NOT NULL,

  -- artist_id may be null if identity was not formally confirmed before handoff
  artist_id               UUID,

  -- SHA-256(lowercase(email)) — plain email is intentionally excluded per audit-handoff.js
  artist_email_hash       TEXT,

  -- Must be 'AUDIT_READY' — createManifest() enforces this in code
  intake_state_at_handoff TEXT        NOT NULL,

  frozen_at               TIMESTAMPTZ NOT NULL,

  -- TRUE enforced at DB level. Remove this CHECK only after attorney sign-off
  -- and a separate legal-unlock migration approving production manifests.
  dry_run                 BOOLEAN     NOT NULL DEFAULT TRUE
                            CHECK (dry_run = TRUE),

  document_count          INTEGER     NOT NULL DEFAULT 0,

  -- Array of {document_id, document_type, sha256_hash, document_category,
  --           reporting_period, quarantined, uploaded_at}
  -- storage_path is intentionally excluded — no path hints in manifest
  documents               JSONB       NOT NULL DEFAULT '[]'::JSONB,

  -- E-sign envelope IDs associated with this engagement
  envelope_ids            JSONB       NOT NULL DEFAULT '[]'::JSONB,

  -- Snapshot of completeness report at handoff time
  completeness            JSONB       NOT NULL,

  identity_confirmed      BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Structural catalog counts only — no track names or artist identifiers
  catalog_baseline        JSONB,

  manifest_version        TEXT        NOT NULL DEFAULT 'audit-handoff-v1',
  audit_pipeline          TEXT        NOT NULL DEFAULT 'lib/neighboring-rights-audit.js',

  -- Immutable — no updated_at
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE registrations.intake_manifests_v1 IS
  'Immutable audit handoff manifests. Created by lib/audit-handoff.js createManifest(). '
  'dry_run = TRUE enforced by CHECK constraint until attorney sign-off unlocks production. '
  'Rows are never updated or deleted. INSERT-only for service_role.';

COMMENT ON COLUMN registrations.intake_manifests_v1.dry_run IS
  'Always TRUE until a separate legal-unlock migration drops this CHECK constraint. '
  'Production manifests require explicit attorney sign-off. '
  'lib/audit-handoff.js also throws if dryRun !== true — dual enforcement.';

COMMENT ON COLUMN registrations.intake_manifests_v1.artist_email_hash IS
  'SHA-256 hex digest of the artist email (lowercase-trimmed). '
  'Plain artist email is excluded from the manifest by design per lib/audit-handoff.js.';

COMMENT ON COLUMN registrations.intake_manifests_v1.documents IS
  'Array of document references: {document_id, document_type, sha256_hash, '
  'document_category, reporting_period, quarantined, uploaded_at}. '
  'storage_path is intentionally excluded — no path hints in manifests.';

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS intake_manifests_v1_workflow_id_idx
  ON registrations.intake_manifests_v1 (workflow_id);

CREATE INDEX IF NOT EXISTS intake_manifests_v1_engagement_id_idx
  ON registrations.intake_manifests_v1 (engagement_id);

CREATE INDEX IF NOT EXISTS intake_manifests_v1_frozen_at_idx
  ON registrations.intake_manifests_v1 (frozen_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- service_role: INSERT and SELECT only. No UPDATE or DELETE.
-- Manifests are immutable after creation — no update policy defined.

ALTER TABLE registrations.intake_manifests_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS intake_manifests_v1_service_role_insert
  ON registrations.intake_manifests_v1;

CREATE POLICY intake_manifests_v1_service_role_insert
  ON registrations.intake_manifests_v1
  FOR INSERT TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS intake_manifests_v1_service_role_select
  ON registrations.intake_manifests_v1;

CREATE POLICY intake_manifests_v1_service_role_select
  ON registrations.intake_manifests_v1
  FOR SELECT TO service_role
  USING (true);

-- Intentionally no UPDATE or DELETE policy — manifests are immutable by design.

-- ── Schema cache reload ───────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
