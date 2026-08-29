-- MusiGod Contract Intelligence and Expected Royalty Engine v1.
-- Evidence and calculations are decision support, not legal conclusions or proof of debt.
BEGIN;
CREATE SCHEMA IF NOT EXISTS royalty_intelligence;

CREATE OR REPLACE FUNCTION royalty_intelligence.fn_has_profile_access_v1(p_profile_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=registrations,public AS $$
  SELECT EXISTS (SELECT 1 FROM registrations.rights_registration_profiles_v1 p WHERE p.id=p_profile_id AND p.auth_user_id=auth.uid())
$$;

CREATE TABLE IF NOT EXISTS royalty_intelligence.contract_families_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 title text NOT NULL, asset_scope text NOT NULL DEFAULT 'mixed' CHECK(asset_scope IN('master','composition','mixed','other')),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','TERMINATED','REVERTED','ARCHIVED')), synthetic boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(profile_id,title,synthetic)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.contract_records_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), family_id uuid NOT NULL REFERENCES royalty_intelligence.contract_families_v1(id) ON DELETE CASCADE,
 profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE, record_type text NOT NULL,
 title text NOT NULL, execution_status text NOT NULL CHECK(execution_status IN('UNSIGNED_DRAFT','EXECUTED','DISPUTED','TERMINATED')),
 effective_date date, execution_date date, governing_law text, venue text, version_label text NOT NULL,
 authoritative boolean NOT NULL DEFAULT false, synthetic boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(authoritative=false OR execution_status='EXECUTED'), UNIQUE(family_id,version_label)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.contract_parties_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid NOT NULL REFERENCES royalty_intelligence.contract_records_v1(id) ON DELETE CASCADE,
 profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE, legal_name text NOT NULL,
 role text NOT NULL, identifiers jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(contract_id,legal_name,role)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.contract_assets_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid NOT NULL REFERENCES royalty_intelligence.contract_records_v1(id) ON DELETE CASCADE,
 profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE, asset_type text NOT NULL CHECK(asset_type IN('MASTER','COMPOSITION','RELEASE','CATALOG','OTHER')),
 title text NOT NULL, identifiers jsonb NOT NULL DEFAULT '{}', territory text NOT NULL DEFAULT 'WORLD', effective_from date, effective_to date,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(effective_to IS NULL OR effective_from IS NULL OR effective_to>=effective_from)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.contract_documents_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid NOT NULL REFERENCES royalty_intelligence.contract_records_v1(id) ON DELETE CASCADE,
 profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE, bucket text NOT NULL DEFAULT 'artist-documents', object_path text NOT NULL,
 file_name text NOT NULL, media_type text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size>0), sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
 source_kind text NOT NULL CHECK(source_kind IN('ORIGINAL','SCAN','OCR_DERIVATIVE')), uploaded_by uuid, uploaded_at timestamptz NOT NULL DEFAULT now(),
 synthetic boolean NOT NULL DEFAULT false, UNIQUE(profile_id,sha256)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.contract_clauses_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid NOT NULL REFERENCES royalty_intelligence.contract_records_v1(id) ON DELETE CASCADE,
 document_id uuid NOT NULL REFERENCES royalty_intelligence.contract_documents_v1(id) ON DELETE RESTRICT, profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 clause_type text NOT NULL, page_number integer NOT NULL CHECK(page_number>0), paragraph_reference text NOT NULL, clause_reference text,
 original_text text NOT NULL, original_text_hash text NOT NULL CHECK(original_text_hash~'^[0-9a-f]{64}$'), extraction_method text NOT NULL,
 model_version text, confidence numeric(5,4) NOT NULL CHECK(confidence BETWEEN 0 AND 1), extracted_at timestamptz NOT NULL DEFAULT now(),
 review_required boolean NOT NULL DEFAULT true, synthetic boolean NOT NULL DEFAULT false, UNIQUE(document_id,page_number,paragraph_reference,original_text_hash)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.extracted_terms_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), clause_id uuid NOT NULL REFERENCES royalty_intelligence.contract_clauses_v1(id) ON DELETE RESTRICT,
 contract_id uuid NOT NULL REFERENCES royalty_intelligence.contract_records_v1(id) ON DELETE CASCADE, profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 term_key text NOT NULL, normalized_value jsonb NOT NULL, interpretation text NOT NULL, authority_basis text NOT NULL CHECK(authority_basis IN('EXPLICIT','INFERRED','INDUSTRY_REFERENCE')),
 confidence numeric(5,4) NOT NULL CHECK(confidence BETWEEN 0 AND 1), status text NOT NULL DEFAULT 'PENDING_REVIEW' CHECK(status IN('PENDING_REVIEW','APPROVED','REJECTED','SUPERSEDED','LEGAL_REVIEW')),
 calculation_authoritative boolean NOT NULL DEFAULT false, approved_review_id uuid, valid_from date, valid_to date, territory text, exploitation_type text,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(calculation_authoritative=false OR (status='APPROVED' AND authority_basis='EXPLICIT'))
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.term_precedence_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 family_id uuid NOT NULL REFERENCES royalty_intelligence.contract_families_v1(id) ON DELETE CASCADE, earlier_term_id uuid NOT NULL REFERENCES royalty_intelligence.extracted_terms_v1(id) ON DELETE RESTRICT,
 controlling_term_id uuid NOT NULL REFERENCES royalty_intelligence.extracted_terms_v1(id) ON DELETE RESTRICT, scope jsonb NOT NULL,
 rationale text NOT NULL, status text NOT NULL DEFAULT 'PENDING_REVIEW' CHECK(status IN('PENDING_REVIEW','APPROVED','REJECTED','LEGAL_REVIEW')),
 approved_review_id uuid, created_at timestamptz NOT NULL DEFAULT now(), CHECK(earlier_term_id<>controlling_term_id)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.review_tasks_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 task_type text NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL, status text NOT NULL DEFAULT 'OPEN' CHECK(status IN('OPEN','IN_REVIEW','APPROVED','REJECTED','LEGAL_REVIEW','RESOLVED')),
 assigned_reviewer text, reviewer_role text, decision text, resolution_notes text, decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status IN('OPEN','IN_REVIEW','LEGAL_REVIEW') OR (assigned_reviewer IS NOT NULL AND length(trim(resolution_notes))>=12 AND decided_at IS NOT NULL))
);
ALTER TABLE royalty_intelligence.extracted_terms_v1 DROP CONSTRAINT IF EXISTS extracted_terms_v1_approved_review_id_fkey;
ALTER TABLE royalty_intelligence.extracted_terms_v1 ADD CONSTRAINT extracted_terms_v1_approved_review_id_fkey FOREIGN KEY(approved_review_id) REFERENCES royalty_intelligence.review_tasks_v1(id);
ALTER TABLE royalty_intelligence.term_precedence_v1 DROP CONSTRAINT IF EXISTS term_precedence_v1_approved_review_id_fkey;
ALTER TABLE royalty_intelligence.term_precedence_v1 ADD CONSTRAINT term_precedence_v1_approved_review_id_fkey FOREIGN KEY(approved_review_id) REFERENCES royalty_intelligence.review_tasks_v1(id);

CREATE TABLE IF NOT EXISTS royalty_intelligence.calculation_rules_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rule_key text NOT NULL, rule_version text NOT NULL, royalty_source text NOT NULL,
 asset_scope text NOT NULL CHECK(asset_scope IN('MASTER','COMPOSITION','MIXED')), definition jsonb NOT NULL, status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','APPROVED','RETIRED')),
 approved_review_id uuid REFERENCES royalty_intelligence.review_tasks_v1(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(rule_key,rule_version),
 CHECK(status<>'APPROVED' OR approved_review_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.statement_sources_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 payor text NOT NULL, source_type text NOT NULL, recipient text, account_reference_hash text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(profile_id,payor,source_type)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.statement_imports_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 source_id uuid NOT NULL REFERENCES royalty_intelligence.statement_sources_v1(id), bucket text NOT NULL DEFAULT 'artist-documents', object_path text NOT NULL,
 file_name text NOT NULL, media_type text NOT NULL, sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'), period_start date, period_end date,
 source_currency text NOT NULL CHECK(source_currency~'^[A-Z]{3}$'), status text NOT NULL DEFAULT 'QUARANTINED' CHECK(status IN('QUARANTINED','VALIDATED','IMPORTED','REJECTED')),
 synthetic boolean NOT NULL DEFAULT false, imported_at timestamptz NOT NULL DEFAULT now(), UNIQUE(profile_id,sha256), CHECK(period_end IS NULL OR period_start IS NULL OR period_end>=period_start)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.statement_lines_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), import_id uuid NOT NULL REFERENCES royalty_intelligence.statement_imports_v1(id) ON DELETE CASCADE,
 profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE, source_location text NOT NULL, source_payload jsonb NOT NULL,
 line_fingerprint text NOT NULL CHECK(line_fingerprint~'^[0-9a-f]{64}$'), asset_type text CHECK(asset_type IN('MASTER','COMPOSITION','UNKNOWN')),
 identifiers jsonb NOT NULL DEFAULT '{}', title text, territory text, service text, usage_type text, units numeric(28,8),
 gross_amount_minor bigint, net_amount_minor bigint, fee_amount_minor bigint, deduction_amount_minor bigint, reserve_amount_minor bigint, recoupment_amount_minor bigint, tax_amount_minor bigint,
 currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'), period_start date, period_end date, payment_reference text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(import_id,line_fingerprint)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.payment_records_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 source_id uuid REFERENCES royalty_intelligence.statement_sources_v1(id), payment_reference text NOT NULL, paid_at date NOT NULL, amount_minor bigint NOT NULL,
 currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'), verification_status text NOT NULL CHECK(verification_status IN('REPORTED','INDEPENDENTLY_VERIFIED','CLEARED')),
 evidence_id uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(profile_id,payment_reference,currency)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.calculation_runs_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 contract_id uuid NOT NULL REFERENCES royalty_intelligence.contract_records_v1(id), statement_import_id uuid REFERENCES royalty_intelligence.statement_imports_v1(id),
 engine_version text NOT NULL, rule_set_hash text NOT NULL CHECK(rule_set_hash~'^[0-9a-f]{64}$'), reporting_currency text NOT NULL CHECK(reporting_currency~'^[A-Z]{3}$'),
 status text NOT NULL CHECK(status IN('QUEUED','RUNNING','BLOCKED','COMPLETED','FAILED')), synthetic boolean NOT NULL DEFAULT false,
 blocked_reasons jsonb NOT NULL DEFAULT '[]', started_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.calculation_inputs_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES royalty_intelligence.calculation_runs_v1(id) ON DELETE CASCADE,
 profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE, statement_line_id uuid REFERENCES royalty_intelligence.statement_lines_v1(id),
 contract_id uuid NOT NULL REFERENCES royalty_intelligence.contract_records_v1(id), contract_version text NOT NULL, term_id uuid REFERENCES royalty_intelligence.extracted_terms_v1(id),
 rule_id uuid REFERENCES royalty_intelligence.calculation_rules_v1(id), input_payload jsonb NOT NULL, input_hash text NOT NULL CHECK(input_hash~'^[0-9a-f]{64}$'), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,input_hash)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.calculation_outputs_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES royalty_intelligence.calculation_runs_v1(id) ON DELETE CASCADE,
 input_id uuid NOT NULL REFERENCES royalty_intelligence.calculation_inputs_v1(id) ON DELETE CASCADE, profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 expected_gross_minor bigint, expected_net_minor bigint, reported_minor bigint, paid_minor bigint, variance_minor bigint, source_currency text NOT NULL CHECK(source_currency~'^[A-Z]{3}$'),
 reporting_currency text NOT NULL CHECK(reporting_currency~'^[A-Z]{3}$'), fx_rate_numerator bigint, fx_rate_denominator bigint, fx_source text, fx_date date,
 classification text NOT NULL, confidence numeric(5,4) NOT NULL CHECK(confidence BETWEEN 0 AND 1), evidence jsonb NOT NULL DEFAULT '[]', assumptions jsonb NOT NULL DEFAULT '[]',
 result_hash text NOT NULL CHECK(result_hash~'^[0-9a-f]{64}$'), review_status text NOT NULL DEFAULT 'UNREVIEWED', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,input_id)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.reconciliation_results_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 calculation_output_id uuid REFERENCES royalty_intelligence.calculation_outputs_v1(id), statement_line_id uuid REFERENCES royalty_intelligence.statement_lines_v1(id),
 classification text NOT NULL, tolerance_minor bigint NOT NULL DEFAULT 1, amount_basis text NOT NULL CHECK(amount_basis IN('REPORTED','CALCULATED_EXPECTATION','ESTIMATED_OPPORTUNITY','VERIFIED_DISCREPANCY')),
 explanation text NOT NULL, evidence_status text NOT NULL CHECK(evidence_status IN('INCOMPLETE','SUFFICIENT','VERIFIED')), review_task_id uuid REFERENCES royalty_intelligence.review_tasks_v1(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.discrepancies_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 reconciliation_id uuid NOT NULL REFERENCES royalty_intelligence.reconciliation_results_v1(id), discrepancy_type text NOT NULL,
 status text NOT NULL DEFAULT 'POTENTIAL' CHECK(status IN('POTENTIAL','EVIDENCE_INCOMPLETE','ANALYST_REVIEW','CONTRACT_REVIEW','LEGAL_REVIEW','VERIFIED','REJECTED')),
 amount_minor bigint, currency text CHECK(currency IS NULL OR currency~'^[A-Z]{3}$'), amount_label text NOT NULL DEFAULT 'ESTIMATED_POTENTIAL_DISCREPANCY',
 legal_conclusion boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), CHECK(status<>'VERIFIED' OR amount_label='CONFIRMED_CONTRACTUAL_UNDERPAYMENT'), CHECK(legal_conclusion=false)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.authorization_records_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 scope text NOT NULL, status text NOT NULL CHECK(status IN('PENDING_SIGNATURE','EXECUTED','REVOKED','EXPIRED','REJECTED')), terms_version text NOT NULL,
 executed_at timestamptz, expires_at timestamptz, evidence_id uuid, created_at timestamptz NOT NULL DEFAULT now(), CHECK(status<>'EXECUTED' OR executed_at IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.recovery_cases_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 discrepancy_id uuid NOT NULL REFERENCES royalty_intelligence.discrepancies_v1(id), case_reference text NOT NULL, status text NOT NULL,
 estimated_minor bigint, verified_minor bigint, claimed_minor bigint, acknowledged_minor bigint, settlement_minor bigint, cleared_recovery_minor bigint NOT NULL DEFAULT 0,
 currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'), external_action_enabled boolean NOT NULL DEFAULT false,
 authorization_id uuid REFERENCES royalty_intelligence.authorization_records_v1(id), approved_review_id uuid REFERENCES royalty_intelligence.review_tasks_v1(id), synthetic boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(profile_id,case_reference), CHECK(external_action_enabled=false OR (authorization_id IS NOT NULL AND approved_review_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.audit_windows_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 contract_id uuid NOT NULL REFERENCES royalty_intelligence.contract_records_v1(id), clause_id uuid NOT NULL REFERENCES royalty_intelligence.contract_clauses_v1(id),
 window_type text NOT NULL, due_date date, calculation_status text NOT NULL CHECK(calculation_status IN('BLOCKED','PENDING_REVIEW','APPROVED')),
 source_text text NOT NULL, review_task_id uuid REFERENCES royalty_intelligence.review_tasks_v1(id), reminder_state text NOT NULL DEFAULT 'NOT_SCHEDULED', created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(calculation_status<>'APPROVED' OR (due_date IS NOT NULL AND review_task_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.evidence_records_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 entity_type text NOT NULL, entity_id uuid NOT NULL, evidence_type text NOT NULL, source_reference text NOT NULL, source_hash text NOT NULL CHECK(source_hash~'^[0-9a-f]{64}$'),
 verification_status text NOT NULL CHECK(verification_status IN('REPORTED','SOURCE_PRESERVED','INDEPENDENTLY_VERIFIED')), metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.audit_events_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE RESTRICT,
 event_type text NOT NULL, actor_type text NOT NULL CHECK(actor_type IN('CLIENT','ADMIN','SYSTEM','LEGAL')), actor_subject text NOT NULL,
 entity_type text NOT NULL, entity_id uuid, payload jsonb NOT NULL DEFAULT '{}', payload_hash text NOT NULL CHECK(payload_hash~'^[0-9a-f]{64}$'), previous_event_hash text,
 event_hash text NOT NULL CHECK(event_hash~'^[0-9a-f]{64}$'), created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION royalty_intelligence.fn_immutable_evidence_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'contract and royalty source evidence is append-only; create an explicit correction record'; END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['contract_documents_v1','contract_clauses_v1','statement_lines_v1','payment_records_v1','calculation_inputs_v1','calculation_outputs_v1','evidence_records_v1','audit_events_v1'] LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS %I ON royalty_intelligence.%I','trg_'||t||'_immutable',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON royalty_intelligence.%I FOR EACH ROW EXECUTE FUNCTION royalty_intelligence.fn_immutable_evidence_v1()','trg_'||t||'_immutable',t);
END LOOP; END $$;
CREATE OR REPLACE FUNCTION royalty_intelligence.fn_statement_import_source_immutable_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.profile_id<>OLD.profile_id OR NEW.source_id<>OLD.source_id OR NEW.bucket<>OLD.bucket OR NEW.object_path<>OLD.object_path OR NEW.file_name<>OLD.file_name OR NEW.media_type<>OLD.media_type OR NEW.sha256<>OLD.sha256 OR NEW.source_currency<>OLD.source_currency OR NEW.synthetic<>OLD.synthetic OR NEW.imported_at<>OLD.imported_at THEN
  RAISE EXCEPTION 'statement source evidence is immutable; only controlled status progression is permitted';
 END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_statement_import_source_immutable ON royalty_intelligence.statement_imports_v1;
CREATE TRIGGER trg_statement_import_source_immutable BEFORE UPDATE ON royalty_intelligence.statement_imports_v1 FOR EACH ROW EXECUTE FUNCTION royalty_intelligence.fn_statement_import_source_immutable_v1();
DROP TRIGGER IF EXISTS trg_statement_import_delete_denied ON royalty_intelligence.statement_imports_v1;
CREATE TRIGGER trg_statement_import_delete_denied BEFORE DELETE ON royalty_intelligence.statement_imports_v1 FOR EACH ROW EXECUTE FUNCTION royalty_intelligence.fn_immutable_evidence_v1();

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['contract_families_v1','contract_records_v1','contract_parties_v1','contract_assets_v1','contract_documents_v1','contract_clauses_v1','extracted_terms_v1','term_precedence_v1','review_tasks_v1','statement_sources_v1','statement_imports_v1','statement_lines_v1','payment_records_v1','calculation_runs_v1','calculation_inputs_v1','calculation_outputs_v1','reconciliation_results_v1','discrepancies_v1','authorization_records_v1','recovery_cases_v1','audit_windows_v1','evidence_records_v1','audit_events_v1'] LOOP
 EXECUTE format('ALTER TABLE royalty_intelligence.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('DROP POLICY IF EXISTS %I ON royalty_intelligence.%I',t||'_service_all',t);
 EXECUTE format('CREATE POLICY %I ON royalty_intelligence.%I FOR ALL TO service_role USING(true) WITH CHECK(true)',t||'_service_all',t);
 EXECUTE format('DROP POLICY IF EXISTS %I ON royalty_intelligence.%I',t||'_owner_read',t);
 EXECUTE format('CREATE POLICY %I ON royalty_intelligence.%I FOR SELECT TO authenticated USING(royalty_intelligence.fn_has_profile_access_v1(profile_id))',t||'_owner_read',t);
 EXECUTE format('REVOKE ALL ON royalty_intelligence.%I FROM anon,authenticated',t); EXECUTE format('GRANT ALL ON royalty_intelligence.%I TO service_role',t); EXECUTE format('GRANT SELECT ON royalty_intelligence.%I TO authenticated',t);
END LOOP; END $$;
ALTER TABLE royalty_intelligence.calculation_rules_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calculation_rules_v1_service_all ON royalty_intelligence.calculation_rules_v1;
CREATE POLICY calculation_rules_v1_service_all ON royalty_intelligence.calculation_rules_v1 FOR ALL TO service_role USING(true) WITH CHECK(true);
REVOKE ALL ON royalty_intelligence.calculation_rules_v1 FROM anon,authenticated; GRANT ALL ON royalty_intelligence.calculation_rules_v1 TO service_role;

CREATE INDEX IF NOT EXISTS ri_contract_profile_idx ON royalty_intelligence.contract_records_v1(profile_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ri_terms_review_idx ON royalty_intelligence.extracted_terms_v1(profile_id,status,term_key);
CREATE INDEX IF NOT EXISTS ri_statement_lines_match_idx ON royalty_intelligence.statement_lines_v1(profile_id,asset_type,title);
CREATE INDEX IF NOT EXISTS ri_reconciliation_idx ON royalty_intelligence.reconciliation_results_v1(profile_id,classification,created_at DESC);
CREATE INDEX IF NOT EXISTS ri_discrepancy_queue_idx ON royalty_intelligence.discrepancies_v1(profile_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS ri_recovery_queue_idx ON royalty_intelligence.recovery_cases_v1(profile_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS ri_audit_due_idx ON royalty_intelligence.audit_windows_v1(profile_id,due_date);
CREATE INDEX IF NOT EXISTS ri_review_queue_idx ON royalty_intelligence.review_tasks_v1(status,created_at);

REVOKE ALL ON FUNCTION royalty_intelligence.fn_has_profile_access_v1(uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION royalty_intelligence.fn_has_profile_access_v1(uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION royalty_intelligence.fn_immutable_evidence_v1() FROM PUBLIC,authenticated;
REVOKE ALL ON FUNCTION royalty_intelligence.fn_statement_import_source_immutable_v1() FROM PUBLIC,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
