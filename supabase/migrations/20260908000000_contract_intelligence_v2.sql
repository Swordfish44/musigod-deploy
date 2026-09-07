BEGIN;
CREATE TABLE IF NOT EXISTS royalty_intelligence.contract_extraction_runs_v2(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 contract_id uuid NOT NULL REFERENCES royalty_intelligence.contract_records_v1(id) ON DELETE CASCADE,document_id uuid NOT NULL REFERENCES royalty_intelligence.contract_documents_v1(id) ON DELETE RESTRICT,
 engine_version text NOT NULL,input_hash text NOT NULL CHECK(input_hash~'^[a-f0-9]{64}$'),source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN('RUNNING','COMPLETED','FAILED')),summary jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,completed_at timestamptz,UNIQUE(profile_id,input_hash)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.contract_term_conflicts_v2(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 contract_id uuid NOT NULL REFERENCES royalty_intelligence.contract_records_v1(id) ON DELETE CASCADE,term_key text NOT NULL,
 term_a_id uuid REFERENCES royalty_intelligence.extracted_terms_v1(id) ON DELETE RESTRICT,term_b_id uuid REFERENCES royalty_intelligence.extracted_terms_v1(id) ON DELETE RESTRICT,
 classification text NOT NULL DEFAULT 'CONTRADICTORY_TERMS',status text NOT NULL DEFAULT 'LEGAL_REVIEW' CHECK(status IN('LEGAL_REVIEW','RESOLVED','REJECTED')),
 explanation text NOT NULL,evidence jsonb NOT NULL DEFAULT '[]',resolution_review_id uuid REFERENCES royalty_intelligence.review_tasks_v1(id),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status<>'RESOLVED' OR resolution_review_id IS NOT NULL),UNIQUE(contract_id,term_key,term_a_id,term_b_id)
);
ALTER TABLE royalty_intelligence.contract_extraction_runs_v2 ENABLE ROW LEVEL SECURITY;ALTER TABLE royalty_intelligence.contract_term_conflicts_v2 ENABLE ROW LEVEL SECURITY;
CREATE POLICY contract_extraction_runs_v2_service_all ON royalty_intelligence.contract_extraction_runs_v2 FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE POLICY contract_term_conflicts_v2_service_all ON royalty_intelligence.contract_term_conflicts_v2 FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE POLICY contract_extraction_runs_v2_owner_read ON royalty_intelligence.contract_extraction_runs_v2 FOR SELECT TO authenticated USING(royalty_intelligence.fn_has_profile_access_v1(profile_id));
CREATE POLICY contract_term_conflicts_v2_owner_read ON royalty_intelligence.contract_term_conflicts_v2 FOR SELECT TO authenticated USING(royalty_intelligence.fn_has_profile_access_v1(profile_id));
REVOKE ALL ON royalty_intelligence.contract_extraction_runs_v2,royalty_intelligence.contract_term_conflicts_v2 FROM anon,authenticated;GRANT ALL ON royalty_intelligence.contract_extraction_runs_v2,royalty_intelligence.contract_term_conflicts_v2 TO service_role;GRANT SELECT ON royalty_intelligence.contract_extraction_runs_v2,royalty_intelligence.contract_term_conflicts_v2 TO authenticated;
CREATE INDEX IF NOT EXISTS contract_extraction_runs_v2_profile_idx ON royalty_intelligence.contract_extraction_runs_v2(profile_id,created_at DESC);CREATE INDEX IF NOT EXISTS contract_term_conflicts_v2_review_idx ON royalty_intelligence.contract_term_conflicts_v2(profile_id,status,created_at);
NOTIFY pgrst,'reload schema';COMMIT;
