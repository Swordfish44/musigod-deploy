BEGIN;
CREATE TABLE IF NOT EXISTS royalty_intelligence.contract_document_security_scans_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 contract_id uuid NOT NULL REFERENCES royalty_intelligence.contract_records_v1(id) ON DELETE CASCADE,document_id uuid NOT NULL REFERENCES royalty_intelligence.contract_documents_v1(id) ON DELETE RESTRICT,
 scanner_version text NOT NULL,source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),status text NOT NULL CHECK(status IN('CLEARED','REVIEW_REQUIRED','QUARANTINED')),
 safe_summary jsonb NOT NULL DEFAULT '{}',redaction_attested boolean NOT NULL CHECK(redaction_attested=true),attested_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),CHECK(NOT (safe_summary ? 'detected_value'))
);
ALTER TABLE royalty_intelligence.contract_document_security_scans_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_document_security_scans_v1_service_all ON royalty_intelligence.contract_document_security_scans_v1;
CREATE POLICY contract_document_security_scans_v1_service_all ON royalty_intelligence.contract_document_security_scans_v1 FOR ALL TO service_role USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS contract_document_security_scans_v1_owner_read ON royalty_intelligence.contract_document_security_scans_v1;
CREATE POLICY contract_document_security_scans_v1_owner_read ON royalty_intelligence.contract_document_security_scans_v1 FOR SELECT TO authenticated USING(royalty_intelligence.fn_has_profile_access_v1(profile_id));
REVOKE ALL ON royalty_intelligence.contract_document_security_scans_v1 FROM anon,authenticated;GRANT ALL ON royalty_intelligence.contract_document_security_scans_v1 TO service_role;GRANT SELECT ON royalty_intelligence.contract_document_security_scans_v1 TO authenticated;
CREATE INDEX IF NOT EXISTS contract_document_security_scans_profile_idx ON royalty_intelligence.contract_document_security_scans_v1(profile_id,status,created_at DESC);
NOTIFY pgrst,'reload schema';COMMIT;
