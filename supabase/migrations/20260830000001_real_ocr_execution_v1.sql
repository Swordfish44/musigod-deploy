-- Real OCR execution evidence for scanned royalty-statement PDF pages v1.
BEGIN;
CREATE TABLE IF NOT EXISTS royalty_intelligence.ocr_executions_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 source_file_id uuid NOT NULL REFERENCES royalty_intelligence.source_files_v1(id) ON DELETE CASCADE,
 page_number integer NOT NULL CHECK(page_number>0), image_sha256 text NOT NULL CHECK(image_sha256~'^[0-9a-f]{64}$'),
 image_width integer NOT NULL CHECK(image_width>0), image_height integer NOT NULL CHECK(image_height>0), dpi integer NOT NULL CHECK(dpi>0),
 engine text NOT NULL, engine_version text NOT NULL, language_code text NOT NULL, confidence numeric(7,4) NOT NULL CHECK(confidence BETWEEN 0 AND 100),
 extracted_text text NOT NULL, extracted_text_sha256 text NOT NULL CHECK(extracted_text_sha256~'^[0-9a-f]{64}$'),
 line_evidence jsonb NOT NULL DEFAULT '[]', status text NOT NULL DEFAULT 'PENDING_REVIEW' CHECK(status IN('PENDING_REVIEW','APPROVED','REJECTED')),
 named_reviewer text, resolution_notes text, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_file_id,page_number,image_sha256,engine,engine_version), CHECK(status='PENDING_REVIEW' OR (named_reviewer IS NOT NULL AND length(trim(resolution_notes))>=12 AND reviewed_at IS NOT NULL))
);
CREATE OR REPLACE FUNCTION royalty_intelligence.fn_ocr_evidence_immutable_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'OCR evidence is append-only'; END IF;
 IF NEW.profile_id<>OLD.profile_id OR NEW.source_file_id<>OLD.source_file_id OR NEW.page_number<>OLD.page_number OR NEW.image_sha256<>OLD.image_sha256 OR NEW.engine<>OLD.engine OR NEW.engine_version<>OLD.engine_version OR NEW.extracted_text_sha256<>OLD.extracted_text_sha256 OR NEW.line_evidence<>OLD.line_evidence OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'OCR source evidence is immutable'; END IF;
 RETURN NEW;
END $$;
ALTER TABLE royalty_intelligence.ocr_executions_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ocr_executions_v1_service_all ON royalty_intelligence.ocr_executions_v1;
CREATE POLICY ocr_executions_v1_service_all ON royalty_intelligence.ocr_executions_v1 FOR ALL TO service_role USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS ocr_executions_v1_owner_read ON royalty_intelligence.ocr_executions_v1;
CREATE POLICY ocr_executions_v1_owner_read ON royalty_intelligence.ocr_executions_v1 FOR SELECT TO authenticated USING(royalty_intelligence.fn_has_profile_access_v1(profile_id));
DROP TRIGGER IF EXISTS trg_ocr_executions_v1_immutable ON royalty_intelligence.ocr_executions_v1;
CREATE TRIGGER trg_ocr_executions_v1_immutable BEFORE UPDATE OR DELETE ON royalty_intelligence.ocr_executions_v1 FOR EACH ROW EXECUTE FUNCTION royalty_intelligence.fn_ocr_evidence_immutable_v1();
REVOKE ALL ON royalty_intelligence.ocr_executions_v1 FROM anon,authenticated; GRANT ALL ON royalty_intelligence.ocr_executions_v1 TO service_role; GRANT SELECT ON royalty_intelligence.ocr_executions_v1 TO authenticated;
INSERT INTO royalty_intelligence.adapter_versions_v1(adapter_key,adapter_version,source_name,format_key,definition,fixture_version,approval_status,named_approver,effective_at) VALUES
 ('generic_pdf_ocr','1.0.0','Generic scanned PDF OCR','PDF','{"engine":"tesseract.js","language":"eng","render_dpi":144,"page_image_hash":true,"line_coordinates":true,"confidence_review_threshold":75,"status":"human_review_required","limitations":["English language v1","complex handwriting unsupported","OCR output is never authoritative without review"]}','ocr-synthetic-v1','APPROVED','MusiGod controlled fixture suite',now())
ON CONFLICT(adapter_key,adapter_version) DO NOTHING;
CREATE INDEX IF NOT EXISTS ri_ocr_review_idx ON royalty_intelligence.ocr_executions_v1(profile_id,status,confidence,created_at);
REVOKE ALL ON FUNCTION royalty_intelligence.fn_ocr_evidence_immutable_v1() FROM PUBLIC,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
