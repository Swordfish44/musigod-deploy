-- MusiGod Large Royalty Statement Ingestion Engine v1.
-- Generic delimited ingestion only. Named-source adapters remain unapproved until fixture-tested.
BEGIN;

CREATE TABLE IF NOT EXISTS royalty_intelligence.statement_packages_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 organization_id uuid, title text NOT NULL, period_start date, period_end date, status text NOT NULL DEFAULT 'UPLOADING'
 CHECK(status IN('UPLOADING','QUARANTINED','PROCESSING','REVIEW_REQUIRED','APPROVED','PARTIAL','BLOCKED','FAILED','CANCELLED','COMPLETED')),
 fingerprint text, synthetic boolean NOT NULL DEFAULT false, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 CHECK(period_end IS NULL OR period_start IS NULL OR period_end>=period_start)
);
CREATE UNIQUE INDEX IF NOT EXISTS ri_package_fingerprint_uq ON royalty_intelligence.statement_packages_v1(profile_id,fingerprint) WHERE fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS royalty_intelligence.upload_sessions_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 package_id uuid NOT NULL REFERENCES royalty_intelligence.statement_packages_v1(id) ON DELETE CASCADE, bucket text NOT NULL DEFAULT 'artist-documents',
 object_path text NOT NULL, original_name text NOT NULL, declared_media_type text NOT NULL, declared_size bigint NOT NULL CHECK(declared_size>0 AND declared_size<=5368709120),
 status text NOT NULL DEFAULT 'INITIATED' CHECK(status IN('INITIATED','UPLOADING','UPLOADED','EXPIRED','CANCELLED','FAILED')),
 upload_protocol text NOT NULL DEFAULT 'TUS' CHECK(upload_protocol IN('TUS','SIGNED_SINGLE')), expires_at timestamptz NOT NULL,
 created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE(bucket,object_path)
);

CREATE TABLE IF NOT EXISTS royalty_intelligence.source_files_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 package_id uuid NOT NULL REFERENCES royalty_intelligence.statement_packages_v1(id) ON DELETE CASCADE, upload_session_id uuid REFERENCES royalty_intelligence.upload_sessions_v1(id),
 bucket text NOT NULL, object_path text NOT NULL, original_name text NOT NULL, detected_media_type text, byte_size bigint NOT NULL CHECK(byte_size>0),
 sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'), malware_status text NOT NULL DEFAULT 'PENDING' CHECK(malware_status IN('PENDING','CLEAN','REJECTED','UNAVAILABLE_REVIEW_REQUIRED')),
 quarantine_status text NOT NULL DEFAULT 'QUARANTINED' CHECK(quarantine_status IN('QUARANTINED','RELEASED','REJECTED')),
 format_key text, encoding text, delimiter text, classification jsonb NOT NULL DEFAULT '{}', synthetic boolean NOT NULL DEFAULT false,
 supersedes_file_id uuid REFERENCES royalty_intelligence.source_files_v1(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(profile_id,sha256)
);

CREATE TABLE IF NOT EXISTS royalty_intelligence.ingestion_jobs_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 package_id uuid NOT NULL REFERENCES royalty_intelligence.statement_packages_v1(id) ON DELETE CASCADE, source_file_id uuid REFERENCES royalty_intelligence.source_files_v1(id),
 job_type text NOT NULL, status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','LEASED','RUNNING','RETRY','REVIEW_REQUIRED','COMPLETED','FAILED','DEAD_LETTER','CANCELLED')),
 idempotency_key text NOT NULL, priority integer NOT NULL DEFAULT 100, attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5,
 available_at timestamptz NOT NULL DEFAULT now(), lease_owner text, lease_expires_at timestamptz, heartbeat_at timestamptz,
 progress_rows bigint NOT NULL DEFAULT 0, progress_bytes bigint NOT NULL DEFAULT 0, last_error_code text, last_error_safe text,
 processing_version text NOT NULL DEFAULT 'large-statement-v1', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(idempotency_key)
);
CREATE INDEX IF NOT EXISTS ri_jobs_claim_idx ON royalty_intelligence.ingestion_jobs_v1(status,available_at,priority,created_at);

CREATE TABLE IF NOT EXISTS royalty_intelligence.processing_checkpoints_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES royalty_intelligence.ingestion_jobs_v1(id) ON DELETE CASCADE,
 stage text NOT NULL, chunk_number bigint NOT NULL, byte_offset bigint NOT NULL DEFAULT 0, source_row_number bigint NOT NULL DEFAULT 0,
 checkpoint_fingerprint text NOT NULL, state jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(job_id,stage,chunk_number)
);

-- Self-repair for processing_checkpoints_v1.profile_id.
-- The original release of this migration created this table without profile_id,
-- then unconditionally referenced profile_id in the profile-scoped RLS loop
-- further down, which failed with 42703 (column "profile_id" does not exist)
-- on every apply attempt. The block below is safe and a no-op on rerun across
-- all states this migration can be applied into: a fresh database (column is
-- added, the backfill UPDATE matches zero rows), an existing table left over
-- from a failed prior attempt that never got the column, existing checkpoint
-- rows that need profile_id backfilled from their parent ingestion job, and a
-- clean rerun after this fix has already applied successfully (every
-- statement below is already satisfied and changes nothing).
ALTER TABLE royalty_intelligence.processing_checkpoints_v1 ADD COLUMN IF NOT EXISTS profile_id uuid;

UPDATE royalty_intelligence.processing_checkpoints_v1 c
SET profile_id = j.profile_id
FROM royalty_intelligence.ingestion_jobs_v1 j
WHERE c.job_id = j.id AND c.profile_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'processing_checkpoints_v1_profile_id_fkey'
      AND conrelid = 'royalty_intelligence.processing_checkpoints_v1'::regclass
  ) THEN
    ALTER TABLE royalty_intelligence.processing_checkpoints_v1
      ADD CONSTRAINT processing_checkpoints_v1_profile_id_fkey
      FOREIGN KEY (profile_id) REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE royalty_intelligence.processing_checkpoints_v1 ALTER COLUMN profile_id SET NOT NULL;

CREATE TABLE IF NOT EXISTS royalty_intelligence.import_chunks_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 import_id uuid REFERENCES royalty_intelligence.statement_imports_v1(id) ON DELETE CASCADE, source_file_id uuid NOT NULL REFERENCES royalty_intelligence.source_files_v1(id) ON DELETE CASCADE,
 chunk_number bigint NOT NULL, first_source_row bigint NOT NULL, last_source_row bigint NOT NULL, row_count integer NOT NULL,
 fingerprint text NOT NULL, status text NOT NULL CHECK(status IN('STAGED','VALIDATED','NORMALIZED','PARTIAL','FAILED')),
 malformed_rows integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_file_id,chunk_number), UNIQUE(source_file_id,fingerprint)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.raw_source_rows_v1(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 source_file_id uuid NOT NULL REFERENCES royalty_intelligence.source_files_v1(id) ON DELETE CASCADE, chunk_id uuid NOT NULL REFERENCES royalty_intelligence.import_chunks_v1(id) ON DELETE CASCADE,
 worksheet_name text, page_number integer, source_row_number bigint NOT NULL, source_location text NOT NULL, source_payload jsonb NOT NULL,
 source_line_fingerprint text NOT NULL CHECK(source_line_fingerprint~'^[0-9a-f]{64}$'), parse_status text NOT NULL DEFAULT 'VALID',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_file_id,source_line_fingerprint)
);
CREATE INDEX IF NOT EXISTS ri_raw_rows_source_idx ON royalty_intelligence.raw_source_rows_v1(source_file_id,source_row_number);

CREATE TABLE IF NOT EXISTS royalty_intelligence.adapter_versions_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), adapter_key text NOT NULL, adapter_version text NOT NULL, source_name text NOT NULL, format_key text NOT NULL,
 definition jsonb NOT NULL, fixture_version text, approval_status text NOT NULL DEFAULT 'UNAPPROVED' CHECK(approval_status IN('UNAPPROVED','TESTED','APPROVED','RETIRED')),
 named_approver text, effective_at timestamptz, retired_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(adapter_key,adapter_version)
);
INSERT INTO royalty_intelligence.adapter_versions_v1(adapter_key,adapter_version,source_name,format_key,definition,fixture_version,approval_status,named_approver,effective_at)
VALUES
 ('generic_csv','1.0.0','Generic CSV','CSV','{"required_columns":[],"preserve_unknown_columns":true,"money":"exact_decimal","limitations":["manual mapping may be required"]}','1.0.0','APPROVED','MusiGod controlled fixture suite',now()),
 ('generic_tsv','1.0.0','Generic TSV','TSV','{"required_columns":[],"preserve_unknown_columns":true,"money":"exact_decimal","limitations":["manual mapping may be required"]}','1.0.0','APPROVED','MusiGod controlled fixture suite',now())
ON CONFLICT(adapter_key,adapter_version) DO NOTHING;

CREATE TABLE IF NOT EXISTS royalty_intelligence.column_mappings_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 source_file_id uuid NOT NULL REFERENCES royalty_intelligence.source_files_v1(id) ON DELETE CASCADE, adapter_version_id uuid REFERENCES royalty_intelligence.adapter_versions_v1(id),
 source_column text NOT NULL, normalized_field text, transform_rule jsonb NOT NULL DEFAULT '{}', confidence numeric(5,4) NOT NULL DEFAULT 0 CHECK(confidence BETWEEN 0 AND 1),
 status text NOT NULL DEFAULT 'PROPOSED' CHECK(status IN('PROPOSED','APPROVED','REJECTED')), approved_by text, approved_at timestamptz, UNIQUE(source_file_id,source_column)
);

CREATE TABLE IF NOT EXISTS royalty_intelligence.import_exceptions_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 package_id uuid NOT NULL REFERENCES royalty_intelligence.statement_packages_v1(id) ON DELETE CASCADE, source_file_id uuid REFERENCES royalty_intelligence.source_files_v1(id),
 raw_row_id bigint REFERENCES royalty_intelligence.raw_source_rows_v1(id), source_location text, original_value jsonb, normalized_value jsonb,
 rule_key text NOT NULL, rule_version text NOT NULL, severity text NOT NULL CHECK(severity IN('INFO','WARNING','ERROR','BLOCKING')),
 explanation text NOT NULL, recommended_action text NOT NULL, review_status text NOT NULL DEFAULT 'OPEN' CHECK(review_status IN('OPEN','IN_REVIEW','RESOLVED','REJECTED','LEGAL_REVIEW')),
 named_reviewer text, resolution_notes text, resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(review_status IN('OPEN','IN_REVIEW','LEGAL_REVIEW') OR (named_reviewer IS NOT NULL AND length(trim(resolution_notes))>=12 AND resolved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ri_exception_queue_idx ON royalty_intelligence.import_exceptions_v1(review_status,severity,created_at);

CREATE TABLE IF NOT EXISTS royalty_intelligence.import_approvals_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 package_id uuid NOT NULL REFERENCES royalty_intelligence.statement_packages_v1(id) ON DELETE CASCADE, status text NOT NULL CHECK(status IN('APPROVED','REJECTED','LEGAL_REVIEW')),
 named_reviewer text NOT NULL, reviewer_role text NOT NULL, resolution_notes text NOT NULL CHECK(length(trim(resolution_notes))>=12),
 approved_line_count bigint NOT NULL DEFAULT 0, approved_at timestamptz NOT NULL DEFAULT now(), UNIQUE(package_id)
);

CREATE TABLE IF NOT EXISTS royalty_intelligence.processing_metrics_v1(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id uuid NOT NULL REFERENCES royalty_intelligence.ingestion_jobs_v1(id) ON DELETE CASCADE,
 metric_key text NOT NULL, metric_value numeric NOT NULL, unit text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.dead_letter_jobs_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), original_job_id uuid NOT NULL UNIQUE REFERENCES royalty_intelligence.ingestion_jobs_v1(id), profile_id uuid NOT NULL,
 error_code text NOT NULL, error_safe text NOT NULL, attempts integer NOT NULL, replayed_by text, replayed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE royalty_intelligence.statement_imports_v1 DROP CONSTRAINT IF EXISTS statement_imports_v1_status_check;
ALTER TABLE royalty_intelligence.statement_imports_v1 ADD CONSTRAINT statement_imports_v1_status_check CHECK(status IN('QUARANTINED','VALIDATING','PROCESSING','REVIEW_REQUIRED','VALIDATED','IMPORTED','PARTIAL','BLOCKED','FAILED','DUPLICATE','REJECTED','CANCELLED'));
ALTER TABLE royalty_intelligence.statement_imports_v1 ADD COLUMN IF NOT EXISTS package_id uuid REFERENCES royalty_intelligence.statement_packages_v1(id);
ALTER TABLE royalty_intelligence.statement_imports_v1 ADD COLUMN IF NOT EXISTS source_file_id uuid REFERENCES royalty_intelligence.source_files_v1(id);
ALTER TABLE royalty_intelligence.statement_imports_v1 ADD COLUMN IF NOT EXISTS adapter_version_id uuid REFERENCES royalty_intelligence.adapter_versions_v1(id);
ALTER TABLE royalty_intelligence.statement_imports_v1 ADD COLUMN IF NOT EXISTS quality_score numeric(5,2);
ALTER TABLE royalty_intelligence.statement_lines_v1 ADD COLUMN IF NOT EXISTS raw_source_row_id bigint REFERENCES royalty_intelligence.raw_source_rows_v1(id);
ALTER TABLE royalty_intelligence.statement_lines_v1 ADD COLUMN IF NOT EXISTS normalized_line_fingerprint text;
ALTER TABLE royalty_intelligence.statement_lines_v1 ADD COLUMN IF NOT EXISTS mapping_confidence numeric(5,4);
ALTER TABLE royalty_intelligence.statement_lines_v1 ADD COLUMN IF NOT EXISTS match_confidence numeric(5,4);
ALTER TABLE royalty_intelligence.statement_lines_v1 ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'UNREVIEWED';

CREATE OR REPLACE FUNCTION royalty_intelligence.fn_claim_ingestion_job_v1(p_worker text,p_lease_seconds integer DEFAULT 55)
RETURNS SETOF royalty_intelligence.ingestion_jobs_v1 LANGUAGE plpgsql SECURITY DEFINER SET search_path=royalty_intelligence,public AS $$
DECLARE v_id uuid;
BEGIN
 SELECT id INTO v_id FROM royalty_intelligence.ingestion_jobs_v1
 WHERE ((status IN('QUEUED','RETRY') AND available_at<=now()) OR (status IN('LEASED','RUNNING') AND lease_expires_at<now()))
 ORDER BY priority,created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF v_id IS NULL THEN RETURN; END IF;
 RETURN QUERY UPDATE royalty_intelligence.ingestion_jobs_v1 SET status='LEASED',lease_owner=p_worker,
 lease_expires_at=now()+make_interval(secs=>greatest(10,least(p_lease_seconds,300))),heartbeat_at=now(),attempts=attempts+1,updated_at=now()
 WHERE id=v_id RETURNING *;
END $$;

CREATE OR REPLACE FUNCTION royalty_intelligence.fn_raw_evidence_append_only_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'raw statement evidence is append-only'; END $$;
CREATE OR REPLACE FUNCTION royalty_intelligence.fn_source_file_evidence_immutable_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF (OLD.profile_id,OLD.package_id,OLD.upload_session_id,OLD.bucket,OLD.object_path,OLD.original_name,OLD.byte_size,OLD.sha256,OLD.synthetic)
 IS DISTINCT FROM (NEW.profile_id,NEW.package_id,NEW.upload_session_id,NEW.bucket,NEW.object_path,NEW.original_name,NEW.byte_size,NEW.sha256,NEW.synthetic)
 THEN RAISE EXCEPTION 'preserved source-file evidence fields are immutable'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS trg_raw_rows_append_only ON royalty_intelligence.raw_source_rows_v1;
CREATE TRIGGER trg_raw_rows_append_only BEFORE UPDATE OR DELETE ON royalty_intelligence.raw_source_rows_v1 FOR EACH ROW EXECUTE FUNCTION royalty_intelligence.fn_raw_evidence_append_only_v1();
DROP TRIGGER IF EXISTS trg_source_files_append_only ON royalty_intelligence.source_files_v1;
CREATE TRIGGER trg_source_files_append_only BEFORE DELETE ON royalty_intelligence.source_files_v1 FOR EACH ROW EXECUTE FUNCTION royalty_intelligence.fn_raw_evidence_append_only_v1();
DROP TRIGGER IF EXISTS trg_source_files_evidence_immutable ON royalty_intelligence.source_files_v1;
CREATE TRIGGER trg_source_files_evidence_immutable BEFORE UPDATE ON royalty_intelligence.source_files_v1 FOR EACH ROW EXECUTE FUNCTION royalty_intelligence.fn_source_file_evidence_immutable_v1();

-- Profile-scoped RLS loop. Audited: before creating a policy that assumes
-- profile_id, each table's column is verified against information_schema.
-- A table added to this array in the future without profile_id now fails
-- with a clear, named exception instead of the opaque 42703 seen in
-- production — the exact failure mode this migration is fixing.
DO $$
DECLARE
  t text;
  v_has_profile_id boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['statement_packages_v1','upload_sessions_v1','source_files_v1','ingestion_jobs_v1','processing_checkpoints_v1','import_chunks_v1','raw_source_rows_v1','column_mappings_v1','import_exceptions_v1','import_approvals_v1']
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'royalty_intelligence' AND table_name = t AND column_name = 'profile_id'
    ) INTO v_has_profile_id;

    IF NOT v_has_profile_id THEN
      RAISE EXCEPTION 'royalty_intelligence.% is missing profile_id — cannot create a profile-scoped RLS policy. Add and backfill the column before this migration runs.', t;
    END IF;

    EXECUTE format('ALTER TABLE royalty_intelligence.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('DROP POLICY IF EXISTS profile_read_%I ON royalty_intelligence.%I',t,t);
    EXECUTE format('CREATE POLICY profile_read_%I ON royalty_intelligence.%I FOR SELECT TO authenticated USING (royalty_intelligence.fn_has_profile_access_v1(profile_id))',t,t);
  END LOOP;
END $$;
ALTER TABLE royalty_intelligence.adapter_versions_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS adapter_versions_read_v1 ON royalty_intelligence.adapter_versions_v1;
CREATE POLICY adapter_versions_read_v1 ON royalty_intelligence.adapter_versions_v1 FOR SELECT TO authenticated USING(approval_status IN('TESTED','APPROVED'));
ALTER TABLE royalty_intelligence.processing_metrics_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE royalty_intelligence.dead_letter_jobs_v1 ENABLE ROW LEVEL SECURITY;
REVOKE INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA royalty_intelligence FROM authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA royalty_intelligence TO authenticated;
REVOKE SELECT ON royalty_intelligence.processing_metrics_v1,royalty_intelligence.dead_letter_jobs_v1 FROM authenticated;
REVOKE ALL ON FUNCTION royalty_intelligence.fn_claim_ingestion_job_v1(text,integer) FROM PUBLIC,authenticated;
GRANT EXECUTE ON FUNCTION royalty_intelligence.fn_claim_ingestion_job_v1(text,integer) TO service_role;
REVOKE ALL ON FUNCTION royalty_intelligence.fn_raw_evidence_append_only_v1() FROM PUBLIC,authenticated;
REVOKE ALL ON FUNCTION royalty_intelligence.fn_source_file_evidence_immutable_v1() FROM PUBLIC,authenticated;

-- Resumable client uploads are restricted to the caller's profile prefix in the private bucket.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('artist-documents','artist-documents',false,5368709120,NULL)
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=5368709120;
DROP POLICY IF EXISTS statement_tus_insert_v1 ON storage.objects;
CREATE POLICY statement_tus_insert_v1 ON storage.objects FOR INSERT TO authenticated WITH CHECK(
 bucket_id='artist-documents' AND (storage.foldername(name))[1]='royalty-statements'
 AND (storage.foldername(name))[2]~'^[0-9a-f-]{36}$'
 AND royalty_intelligence.fn_has_profile_access_v1(((storage.foldername(name))[2])::uuid)
);
DROP POLICY IF EXISTS statement_tus_select_v1 ON storage.objects;
CREATE POLICY statement_tus_select_v1 ON storage.objects FOR SELECT TO authenticated USING(
 bucket_id='artist-documents' AND (storage.foldername(name))[1]='royalty-statements'
 AND (storage.foldername(name))[2]~'^[0-9a-f-]{36}$'
 AND royalty_intelligence.fn_has_profile_access_v1(((storage.foldername(name))[2])::uuid)
);

NOTIFY pgrst,'reload schema';
COMMIT;
