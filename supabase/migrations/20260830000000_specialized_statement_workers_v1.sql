-- Specialized XLSX/PDF/ZIP worker evidence and adapter controls v1.
BEGIN;
CREATE TABLE IF NOT EXISTS royalty_intelligence.source_file_members_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 parent_source_file_id uuid NOT NULL REFERENCES royalty_intelligence.source_files_v1(id) ON DELETE CASCADE,
 member_index integer NOT NULL CHECK(member_index>0), member_path text NOT NULL, format_key text NOT NULL,
 compressed_size bigint NOT NULL CHECK(compressed_size>=0), uncompressed_size bigint NOT NULL CHECK(uncompressed_size>=0),
 crc32 bigint, sha256 text CHECK(sha256 IS NULL OR sha256~'^[0-9a-f]{64}$'), processing_status text NOT NULL DEFAULT 'INVENTORIED' CHECK(processing_status IN('INVENTORIED','PROCESSED','REVIEW_REQUIRED','REJECTED','UNSUPPORTED')),
 exception_code text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(parent_source_file_id,member_path)
);
CREATE TABLE IF NOT EXISTS royalty_intelligence.extracted_source_units_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 source_file_id uuid NOT NULL REFERENCES royalty_intelligence.source_files_v1(id) ON DELETE CASCADE,
 source_member_id uuid REFERENCES royalty_intelligence.source_file_members_v1(id) ON DELETE CASCADE,
 unit_type text NOT NULL CHECK(unit_type IN('WORKSHEET','PDF_PAGE','ARCHIVE_MEMBER')), unit_index integer NOT NULL CHECK(unit_index>0),
 source_location text NOT NULL, unit_name text, payload jsonb NOT NULL DEFAULT '{}', payload_hash text NOT NULL CHECK(payload_hash~'^[0-9a-f]{64}$'),
 extraction_method text NOT NULL, extractor_version text NOT NULL, confidence numeric(5,4) CHECK(confidence IS NULL OR confidence BETWEEN 0 AND 1),
 review_status text NOT NULL DEFAULT 'UNREVIEWED', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_file_id,source_location,payload_hash)
);
CREATE OR REPLACE FUNCTION royalty_intelligence.fn_specialized_evidence_immutable_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'specialized statement extraction evidence is append-only'; END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['source_file_members_v1','extracted_source_units_v1'] LOOP
 EXECUTE format('ALTER TABLE royalty_intelligence.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('DROP POLICY IF EXISTS %I ON royalty_intelligence.%I',t||'_service_all',t);
 EXECUTE format('CREATE POLICY %I ON royalty_intelligence.%I FOR ALL TO service_role USING(true) WITH CHECK(true)',t||'_service_all',t);
 EXECUTE format('DROP POLICY IF EXISTS %I ON royalty_intelligence.%I',t||'_owner_read',t);
 EXECUTE format('CREATE POLICY %I ON royalty_intelligence.%I FOR SELECT TO authenticated USING(royalty_intelligence.fn_has_profile_access_v1(profile_id))',t||'_owner_read',t);
 EXECUTE format('REVOKE ALL ON royalty_intelligence.%I FROM anon,authenticated',t); EXECUTE format('GRANT ALL ON royalty_intelligence.%I TO service_role',t); EXECUTE format('GRANT SELECT ON royalty_intelligence.%I TO authenticated',t);
 EXECUTE format('DROP TRIGGER IF EXISTS %I ON royalty_intelligence.%I','trg_'||t||'_immutable',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON royalty_intelligence.%I FOR EACH ROW EXECUTE FUNCTION royalty_intelligence.fn_specialized_evidence_immutable_v1()','trg_'||t||'_immutable',t);
END LOOP; END $$;
INSERT INTO royalty_intelligence.adapter_versions_v1(adapter_key,adapter_version,source_name,format_key,definition,fixture_version,approval_status,named_approver,effective_at) VALUES
 ('generic_xlsx','1.0.0','Generic XLSX','XLSX','{"streaming":true,"multi_worksheet":true,"formula_policy":"cached_values_only","external_links":"ignored","provenance":"worksheet_and_row","limitations":["XLS and XLSB require conversion or a dedicated binary worker"]}','xlsx-synthetic-v1','APPROVED','MusiGod controlled fixture suite',now()),
 ('generic_pdf_text','1.0.0','Generic searchable PDF','PDF','{"page_coordinates":true,"ocr_routing":true,"table_rows":"coordinate_grouped","provenance":"page_and_bounds","limitations":["scanned pages route to OCR review","complex tables require human mapping"]}','pdf-synthetic-v1','APPROVED','MusiGod controlled fixture suite',now()),
 ('generic_zip','1.0.0','Generic ZIP package','ZIP','{"lazy_entries":true,"path_traversal_protection":true,"encrypted_members":"rejected","maximum_members":500,"maximum_ratio":100,"partial_member_review":true}','zip-synthetic-v1','APPROVED','MusiGod controlled fixture suite',now())
ON CONFLICT(adapter_key,adapter_version) DO NOTHING;
CREATE INDEX IF NOT EXISTS ri_source_members_parent_idx ON royalty_intelligence.source_file_members_v1(parent_source_file_id,member_index);
CREATE INDEX IF NOT EXISTS ri_extracted_units_source_idx ON royalty_intelligence.extracted_source_units_v1(source_file_id,unit_type,unit_index);
REVOKE ALL ON FUNCTION royalty_intelligence.fn_specialized_evidence_immutable_v1() FROM PUBLIC,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
