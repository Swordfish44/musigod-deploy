-- Fixture: simulates the exact broken production shape reported for PR #33
-- ("Large Royalty Statement Ingestion Engine v1"): processing_checkpoints_v1
-- created without profile_id, with checkpoint rows already present that must
-- be backfilled from their parent ingestion job. Used by
-- .github/workflows/royalty-intelligence-migration-validation.yml to prove
-- the migration in supabase/migrations/20260829000002_large_statement_ingestion_v1.sql
-- self-repairs this state rather than failing with 42703.
--
-- Apply order: local_dev_bootstrap -> rights_registration_center_v1 ->
-- contract_intelligence_expected_royalty_v1 -> THIS FIXTURE ->
-- large_statement_ingestion_v1 (the migration under test).

CREATE TABLE IF NOT EXISTS royalty_intelligence.statement_packages_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 organization_id uuid, title text NOT NULL, period_start date, period_end date, status text NOT NULL DEFAULT 'UPLOADING'
 CHECK(status IN('UPLOADING','QUARANTINED','PROCESSING','REVIEW_REQUIRED','APPROVED','PARTIAL','BLOCKED','FAILED','CANCELLED','COMPLETED')),
 fingerprint text, synthetic boolean NOT NULL DEFAULT false, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 CHECK(period_end IS NULL OR period_start IS NULL OR period_end>=period_start)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.ingestion_jobs_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 package_id uuid NOT NULL REFERENCES royalty_intelligence.statement_packages_v1(id) ON DELETE CASCADE, source_file_id uuid,
 job_type text NOT NULL, status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','LEASED','RUNNING','RETRY','REVIEW_REQUIRED','COMPLETED','FAILED','DEAD_LETTER','CANCELLED')),
 idempotency_key text NOT NULL, priority integer NOT NULL DEFAULT 100, attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5,
 available_at timestamptz NOT NULL DEFAULT now(), lease_owner text, lease_expires_at timestamptz, heartbeat_at timestamptz,
 progress_rows bigint NOT NULL DEFAULT 0, progress_bytes bigint NOT NULL DEFAULT 0, last_error_code text, last_error_safe text,
 processing_version text NOT NULL DEFAULT 'large-statement-v1', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(idempotency_key)
);
-- The broken shape: no profile_id column, matching the original production bug.
CREATE TABLE IF NOT EXISTS royalty_intelligence.processing_checkpoints_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES royalty_intelligence.ingestion_jobs_v1(id) ON DELETE CASCADE,
 stage text NOT NULL, chunk_number bigint NOT NULL, byte_offset bigint NOT NULL DEFAULT 0, source_row_number bigint NOT NULL DEFAULT 0,
 checkpoint_fingerprint text NOT NULL, state jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(job_id,stage,chunk_number)
);

INSERT INTO registrations.rights_registration_profiles_v1(id, legal_name)
VALUES ('11111111-1111-1111-1111-111111111111', 'CI Fixture Artist')
ON CONFLICT (id) DO NOTHING;

INSERT INTO royalty_intelligence.statement_packages_v1(id, profile_id, title)
VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'CI Fixture Statement')
ON CONFLICT (id) DO NOTHING;

INSERT INTO royalty_intelligence.ingestion_jobs_v1(id, profile_id, package_id, job_type, idempotency_key)
VALUES ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'STREAM_DELIMITED', 'ci-fixture-key-1')
ON CONFLICT (idempotency_key) DO NOTHING;

INSERT INTO royalty_intelligence.processing_checkpoints_v1(job_id, stage, chunk_number, checkpoint_fingerprint, source_row_number)
SELECT '33333333-3333-3333-3333-333333333333', 'ROW_STREAM', 1, 'deadbeef', 5000
WHERE NOT EXISTS (
  SELECT 1 FROM royalty_intelligence.processing_checkpoints_v1
  WHERE job_id = '33333333-3333-3333-3333-333333333333' AND stage = 'ROW_STREAM' AND chunk_number = 1
);
