-- MusiGod Enterprise Foundation v1
-- Multi-tenant portfolio ingestion, royalty rules, correction packaging,
-- chain-of-title review, and MESA-1 security evidence.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.enterprise_organizations_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  status text NOT NULL DEFAULT 'pilot' CHECK (status IN ('pilot','active','suspended','closed')),
  data_region text NOT NULL DEFAULT 'us',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.enterprise_memberships_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer','analyst','reviewer','administrator')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE OR REPLACE FUNCTION public.fn_enterprise_has_org_access(p_organization_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.enterprise_memberships_v1 m
    WHERE m.organization_id = p_organization_id
      AND m.user_id = auth.uid() AND m.active = true
  );
$$;

CREATE TABLE IF NOT EXISTS public.enterprise_data_sources_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  source_name text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('pro','cmo','dsp','neighboring_rights','administrator','distributor','acquisition','internal')),
  transport text NOT NULL CHECK (transport IN ('api','sftp','ddex','cwr','csv','xlsx','pdf','manual')),
  authority_status text NOT NULL DEFAULT 'client_authorized' CHECK (authority_status IN ('official','client_authorized','pending','disabled')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, source_name)
);

CREATE TABLE IF NOT EXISTS public.enterprise_import_batches_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  data_source_id uuid NOT NULL REFERENCES public.enterprise_data_sources_v1(id),
  filename text,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  source_period_start date,
  source_period_end date,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','validated','processing','completed','rejected','quarantined')),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  accepted_count integer NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  rejected_count integer NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  validation_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_by uuid REFERENCES auth.users(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id, content_sha256)
);

CREATE TABLE IF NOT EXISTS public.enterprise_import_records_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES public.enterprise_import_batches_v1(id) ON DELETE CASCADE,
  row_number integer NOT NULL CHECK (row_number > 0),
  record_type text NOT NULL CHECK (record_type IN ('recording','composition','party','right','usage','royalty','payment','registration','agreement')),
  source_record_id text,
  normalized_payload jsonb NOT NULL,
  validation_status text NOT NULL CHECK (validation_status IN ('accepted','warning','rejected','review_required')),
  validation_messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, row_number)
);

CREATE TABLE IF NOT EXISTS public.enterprise_royalty_rules_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  rule_code text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  territory text NOT NULL,
  rights_type text NOT NULL CHECK (rights_type IN ('composition','master','featured_performer','nonfeatured_performer','neighboring_right','other')),
  usage_type text NOT NULL,
  collection_body text,
  effective_from date NOT NULL,
  effective_to date,
  claim_deadline_rule jsonb NOT NULL DEFAULT '{}'::jsonb,
  eligibility_rule jsonb NOT NULL DEFAULT '{}'::jsonb,
  allocation_rule jsonb NOT NULL DEFAULT '{}'::jsonb,
  authority_sources jsonb NOT NULL CHECK (jsonb_typeof(authority_sources) = 'array' AND jsonb_array_length(authority_sources) > 0),
  confidence text NOT NULL DEFAULT 'provisional' CHECK (confidence IN ('provisional','verified','deprecated')),
  review_status text NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft','human_reviewed','legal_reviewed','approved','retired')),
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (organization_id, rule_code, version),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK ((review_status IN ('draft')) OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.enterprise_correction_specs_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination text NOT NULL,
  submission_type text NOT NULL,
  version text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  required_fields jsonb NOT NULL,
  field_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  accepted_format text NOT NULL CHECK (accepted_format IN ('csv','xlsx','cwr','ddex','json','portal')),
  submission_channel text NOT NULL,
  authority_source text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','verified','retired')),
  verified_by uuid REFERENCES auth.users(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (destination, submission_type, version)
);

CREATE TABLE IF NOT EXISTS public.enterprise_correction_packages_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  specification_id uuid NOT NULL REFERENCES public.enterprise_correction_specs_v1(id),
  package_reference text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validation_failed','ready_for_review','approved','submitted','accepted','rejected','withdrawn')),
  payload jsonb NOT NULL,
  validation_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload_sha256 text CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[a-f0-9]{64}$'),
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  submitted_at timestamptz,
  external_receipt text,
  external_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, package_reference),
  CHECK (status NOT IN ('approved','submitted','accepted') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.enterprise_title_documents_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  document_reference text NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('acquisition_agreement','assignment','amendment','license','termination','registration','schedule','other')),
  effective_date date,
  parties jsonb NOT NULL DEFAULT '[]'::jsonb,
  rights_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  territories jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  extraction_status text NOT NULL DEFAULT 'unreviewed' CHECK (extraction_status IN ('unreviewed','human_verified','rejected')),
  verified_by uuid REFERENCES auth.users(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, document_reference)
);

CREATE TABLE IF NOT EXISTS public.enterprise_title_findings_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  asset_node_id uuid,
  finding_type text NOT NULL CHECK (finding_type IN ('documented_fact','system_inference','data_conflict','missing_evidence','legal_determination_required')),
  summary text NOT NULL,
  source_document_ids uuid[] NOT NULL DEFAULT '{}',
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  legal_effect boolean NOT NULL DEFAULT false,
  review_status text NOT NULL DEFAULT 'open' CHECK (review_status IN ('open','human_validated','legal_validated','rejected','resolved')),
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  resolution_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT legal_effect OR review_status = 'legal_validated')
);

CREATE TABLE IF NOT EXISTS public.enterprise_security_controls_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_code text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL,
  nist_csf_refs text[] NOT NULL DEFAULT '{}',
  cis_v81_refs text[] NOT NULL DEFAULT '{}',
  soc2_refs text[] NOT NULL DEFAULT '{}',
  owner_role text NOT NULL,
  cadence text NOT NULL,
  implementation_status text NOT NULL DEFAULT 'planned' CHECK (implementation_status IN ('planned','implemented','operating','exception')),
  last_reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.enterprise_security_evidence_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_id uuid NOT NULL REFERENCES public.enterprise_security_controls_v1(id),
  evidence_type text NOT NULL CHECK (evidence_type IN ('policy','configuration','log','test','review','attestation','exception')),
  artifact_reference text NOT NULL,
  artifact_sha256 text CHECK (artifact_sha256 IS NULL OR artifact_sha256 ~ '^[a-f0-9]{64}$'),
  period_start date,
  period_end date,
  collected_by uuid REFERENCES auth.users(id),
  collected_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE OR REPLACE FUNCTION public.fn_enterprise_deny_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'enterprise security evidence is append-only';
END $$;
DROP TRIGGER IF EXISTS trg_enterprise_security_evidence_immutable ON public.enterprise_security_evidence_v1;
CREATE TRIGGER trg_enterprise_security_evidence_immutable
BEFORE UPDATE OR DELETE ON public.enterprise_security_evidence_v1
FOR EACH ROW EXECUTE FUNCTION public.fn_enterprise_deny_mutation();

CREATE INDEX IF NOT EXISTS enterprise_import_batches_org_status_idx ON public.enterprise_import_batches_v1(organization_id, status, received_at DESC);
CREATE INDEX IF NOT EXISTS enterprise_import_records_batch_idx ON public.enterprise_import_records_v1(batch_id, validation_status);
CREATE INDEX IF NOT EXISTS enterprise_rules_lookup_idx ON public.enterprise_royalty_rules_v1(territory, rights_type, usage_type, review_status);
CREATE INDEX IF NOT EXISTS enterprise_packages_org_status_idx ON public.enterprise_correction_packages_v1(organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS enterprise_title_findings_org_review_idx ON public.enterprise_title_findings_v1(organization_id, review_status, finding_type);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'enterprise_organizations_v1','enterprise_memberships_v1','enterprise_data_sources_v1',
    'enterprise_import_batches_v1','enterprise_import_records_v1','enterprise_royalty_rules_v1',
    'enterprise_correction_specs_v1','enterprise_correction_packages_v1','enterprise_title_documents_v1',
    'enterprise_title_findings_v1','enterprise_security_controls_v1','enterprise_security_evidence_v1'
  ] LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t); END LOOP;
END $$;

-- Service role is the controlled server-side path for all enterprise writes.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'enterprise_organizations_v1','enterprise_memberships_v1','enterprise_data_sources_v1',
    'enterprise_import_batches_v1','enterprise_import_records_v1','enterprise_royalty_rules_v1',
    'enterprise_correction_specs_v1','enterprise_correction_packages_v1','enterprise_title_documents_v1',
    'enterprise_title_findings_v1','enterprise_security_controls_v1','enterprise_security_evidence_v1'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role_all', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t || '_service_role_all', t);
  END LOOP;
END $$;

-- Named users may read only rows for organizations where they hold an active membership.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'enterprise_data_sources_v1','enterprise_import_batches_v1','enterprise_import_records_v1',
    'enterprise_correction_packages_v1','enterprise_title_documents_v1','enterprise_title_findings_v1'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_org_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.fn_enterprise_has_org_access(organization_id))', t || '_org_read', t);
  END LOOP;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'enterprise_organizations_v1','enterprise_memberships_v1','enterprise_data_sources_v1',
    'enterprise_import_batches_v1','enterprise_import_records_v1','enterprise_royalty_rules_v1',
    'enterprise_correction_specs_v1','enterprise_correction_packages_v1','enterprise_title_documents_v1',
    'enterprise_title_findings_v1','enterprise_security_controls_v1','enterprise_security_evidence_v1'
  ] LOOP EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t); END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.fn_enterprise_has_org_access(uuid) TO authenticated, service_role;

INSERT INTO public.enterprise_security_controls_v1
  (control_code, title, description, nist_csf_refs, cis_v81_refs, soc2_refs, owner_role, cadence)
VALUES
  ('MESA-01','Security governance','Govern security risk and review the enterprise risk register.',ARRAY['GV.OC','GV.RM'],ARRAY['17'],ARRAY['CC1','CC3'],'security_owner','quarterly'),
  ('MESA-02','Asset inventory','Inventory managed cloud, endpoint, software, and dependency assets.',ARRAY['ID.AM'],ARRAY['1','2'],ARRAY['CC6'],'platform_owner','monthly'),
  ('MESA-03','Data lifecycle','Classify, retain, and verifiably delete enterprise data.',ARRAY['ID.AM','PR.DS'],ARRAY['3'],ARRAY['CC6'],'data_owner','quarterly'),
  ('MESA-04','Identity and access','Require named access, MFA, least privilege, and access review.',ARRAY['PR.AA'],ARRAY['5','6'],ARRAY['CC6'],'security_owner','quarterly'),
  ('MESA-05','Secure change','Review code and control production configuration and deployment.',ARRAY['PR.PS'],ARRAY['4','16'],ARRAY['CC8'],'engineering_owner','per_change'),
  ('MESA-06','Vulnerability management','Scan dependencies and remediate vulnerabilities by severity.',ARRAY['ID.RA','PR.PS'],ARRAY['7','16'],ARRAY['CC7'],'engineering_owner','continuous'),
  ('MESA-07','Logging and monitoring','Retain audit events and respond to security alerts.',ARRAY['DE.CM'],ARRAY['8','13'],ARRAY['CC7'],'security_owner','continuous'),
  ('MESA-08','Backup and recovery','Back up protected data and verify restoration.',ARRAY['PR.IR','RC.RP'],ARRAY['11'],ARRAY['A1'],'platform_owner','quarterly'),
  ('MESA-09','Incident response','Maintain, exercise, and improve the incident response plan.',ARRAY['RS.MA','RS.CO','RS.MI'],ARRAY['17'],ARRAY['CC7'],'security_owner','annual'),
  ('MESA-10','Vendor management','Review subprocessors and material technology suppliers.',ARRAY['GV.SC'],ARRAY['15'],ARRAY['CC9'],'operations_owner','annual'),
  ('MESA-11','Tenant isolation','Enforce and test organization-scoped access boundaries.',ARRAY['PR.AA','PR.DS'],ARRAY['3','6'],ARRAY['CC6'],'engineering_owner','per_release'),
  ('MESA-12','Processing integrity','Preserve provenance and verify deterministic processing outputs.',ARRAY['PR.DS','DE.AE'],ARRAY['8'],ARRAY['PI1'],'data_owner','per_release')
ON CONFLICT (control_code) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  nist_csf_refs = EXCLUDED.nist_csf_refs,
  cis_v81_refs = EXCLUDED.cis_v81_refs,
  soc2_refs = EXCLUDED.soc2_refs,
  owner_role = EXCLUDED.owner_role,
  cadence = EXCLUDED.cadence,
  updated_at = now();

NOTIFY pgrst, 'reload schema';
