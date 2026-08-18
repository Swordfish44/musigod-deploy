-- HarbourView portfolio-scale deterministic analysis v1.
-- Analysis produces evidence and review work; it never makes ownership or debt conclusions.

CREATE TABLE IF NOT EXISTS public.enterprise_analysis_rules_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  rule_family text NOT NULL CHECK(rule_family IN ('asset_match','royalty_reconciliation','ownership_conflict','recovery_priority')),
  rule_version text NOT NULL, definition jsonb NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','retired')),
  approved_by_reviewer_id uuid REFERENCES public.enterprise_reviewers_v1(id), approved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT(organization_id,rule_family,rule_version), CHECK(status<>'approved' OR (approved_by_reviewer_id IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.enterprise_source_asset_records_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, catalog_id uuid NOT NULL, import_record_id uuid NOT NULL REFERENCES public.enterprise_import_records_v1(id) ON DELETE CASCADE,
  source_values jsonb NOT NULL, normalized_values jsonb NOT NULL, transformation jsonb NOT NULL,
  record_fingerprint text NOT NULL CHECK(record_fingerprint~'^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,workspace_id,catalog_id) REFERENCES public.enterprise_catalogs_v1(organization_id,workspace_id,id) ON DELETE CASCADE,
  UNIQUE(organization_id,import_record_id), UNIQUE(organization_id,record_fingerprint,import_record_id)
);

CREATE TABLE IF NOT EXISTS public.enterprise_asset_match_candidates_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, left_source_record_id uuid NOT NULL REFERENCES public.enterprise_source_asset_records_v1(id) ON DELETE CASCADE,
  right_source_record_id uuid NOT NULL REFERENCES public.enterprise_source_asset_records_v1(id) ON DELETE CASCADE,
  classification text NOT NULL CHECK(classification IN ('exact','probable','ambiguous','rejected')), score numeric(5,2) NOT NULL CHECK(score BETWEEN 0 AND 100),
  rule_version text NOT NULL, evidence jsonb NOT NULL, contradictions jsonb NOT NULL DEFAULT '[]', merge_allowed boolean NOT NULL DEFAULT false,
  review_task_id uuid REFERENCES public.enterprise_review_tasks_v1(id), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,workspace_id) REFERENCES public.enterprise_pilot_workspaces_v1(organization_id,id) ON DELETE CASCADE,
  UNIQUE(organization_id,left_source_record_id,right_source_record_id,rule_version),
  CHECK(classification NOT IN ('ambiguous','rejected') OR merge_allowed=false), CHECK(merge_allowed=false OR classification IN ('exact','probable'))
);

CREATE TABLE IF NOT EXISTS public.enterprise_royalty_statements_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, import_batch_id uuid NOT NULL REFERENCES public.enterprise_import_batches_v1(id), statement_type text NOT NULL CHECK(statement_type IN ('dsp','distributor','pro','cmo','neighboring_rights')),
  currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'), period_start date NOT NULL, period_end date NOT NULL, statement_reference text NOT NULL,
  source_values jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(organization_id,workspace_id) REFERENCES public.enterprise_pilot_workspaces_v1(organization_id,id) ON DELETE CASCADE,
  UNIQUE(organization_id,statement_reference), CHECK(period_end>=period_start)
);

CREATE TABLE IF NOT EXISTS public.enterprise_royalty_reconciliations_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, statement_id uuid NOT NULL REFERENCES public.enterprise_royalty_statements_v1(id) ON DELETE CASCADE,
  import_record_id uuid NOT NULL REFERENCES public.enterprise_import_records_v1(id), matched_asset_id uuid REFERENCES public.enterprise_assets_v1(id),
  status text NOT NULL CHECK(status IN ('matched','unmatched','ambiguous','underreported','duplicated','conflicting')),
  reported_amount numeric NOT NULL, expected_amount numeric, variance numeric, currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),
  amount_basis text NOT NULL CHECK(amount_basis IN ('reported','verified')), rule_version text NOT NULL, evidence jsonb NOT NULL,
  review_task_id uuid REFERENCES public.enterprise_review_tasks_v1(id), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,workspace_id) REFERENCES public.enterprise_pilot_workspaces_v1(organization_id,id) ON DELETE CASCADE,
  UNIQUE(organization_id,statement_id,import_record_id,rule_version), CHECK(status NOT IN ('underreported','conflicting') OR amount_basis='verified')
);

CREATE TABLE IF NOT EXISTS public.enterprise_ownership_claims_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, asset_id uuid NOT NULL REFERENCES public.enterprise_assets_v1(id) ON DELETE CASCADE, import_record_id uuid NOT NULL REFERENCES public.enterprise_import_records_v1(id),
  claimant_name text NOT NULL, claimant_identifier text, ownership_share numeric(7,4) NOT NULL CHECK(ownership_share BETWEEN 0 AND 100),
  territory text NOT NULL, rights_type text NOT NULL, effective_from date NOT NULL, effective_to date, source_values jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,workspace_id) REFERENCES public.enterprise_pilot_workspaces_v1(organization_id,id) ON DELETE CASCADE,
  UNIQUE(organization_id,import_record_id,asset_id,rights_type,territory,effective_from), CHECK(effective_to IS NULL OR effective_to>=effective_from)
);

CREATE TABLE IF NOT EXISTS public.enterprise_ownership_conflicts_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, claim_a_id uuid NOT NULL REFERENCES public.enterprise_ownership_claims_v1(id), claim_b_id uuid NOT NULL REFERENCES public.enterprise_ownership_claims_v1(id),
  classification text NOT NULL DEFAULT 'data_conflict' CHECK(classification='data_conflict'), reasons jsonb NOT NULL, legal_conclusion text,
  rule_version text NOT NULL, review_task_id uuid NOT NULL REFERENCES public.enterprise_review_tasks_v1(id), resolution_status text NOT NULL DEFAULT 'open' CHECK(resolution_status IN ('open','human_reviewed','legal_reviewed','resolved','rejected')),
  reviewed_by_reviewer_id uuid REFERENCES public.enterprise_reviewers_v1(id), resolution_notes text, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,workspace_id) REFERENCES public.enterprise_pilot_workspaces_v1(organization_id,id) ON DELETE CASCADE,
  UNIQUE(organization_id,claim_a_id,claim_b_id,rule_version), CHECK(legal_conclusion IS NULL OR resolution_status='legal_reviewed'),
  CHECK(resolution_status='open' OR (reviewed_by_reviewer_id IS NOT NULL AND length(trim(resolution_notes))>=12))
);

CREATE TABLE IF NOT EXISTS public.enterprise_recovery_opportunities_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, opportunity_reference text NOT NULL, status text NOT NULL DEFAULT 'identified' CHECK(status IN ('identified','review_required','approved','rejected','package_created')),
  score numeric(5,2) NOT NULL CHECK(score BETWEEN 0 AND 100), priority text NOT NULL CHECK(priority IN ('low','medium','high','critical')),
  amount numeric, amount_basis text NOT NULL CHECK(amount_basis IN ('verified','estimate','unknown')), currency text, rule_version text NOT NULL,
  factors jsonb NOT NULL, evidence jsonb NOT NULL, assumptions jsonb NOT NULL DEFAULT '[]', filing_deadline date, recovery_complexity numeric(4,3),
  review_task_id uuid NOT NULL REFERENCES public.enterprise_review_tasks_v1(id), approved_by_reviewer_id uuid REFERENCES public.enterprise_reviewers_v1(id), approved_at timestamptz, approval_notes text,
  correction_package_id uuid REFERENCES public.enterprise_correction_packages_v1(id), external_submission_enabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,workspace_id) REFERENCES public.enterprise_pilot_workspaces_v1(organization_id,id) ON DELETE CASCADE,
  UNIQUE(organization_id,opportunity_reference), CHECK(status NOT IN ('approved','package_created') OR (approved_by_reviewer_id IS NOT NULL AND approved_at IS NOT NULL AND length(trim(approval_notes))>=12)),
  CHECK(external_submission_enabled=false), CHECK(amount_basis='unknown' OR (amount IS NOT NULL AND currency~'^[A-Z]{3}$'))
);

CREATE OR REPLACE FUNCTION public.fn_enterprise_resolve_ownership_conflict_v1(p_conflict_id uuid,p_reviewer_id uuid,p_decision text,p_resolution_notes text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_conflict public.enterprise_ownership_conflicts_v1%ROWTYPE; v_task public.enterprise_review_tasks_v1%ROWTYPE; v_reviewer public.enterprise_reviewers_v1%ROWTYPE;
BEGIN
  IF p_decision NOT IN ('human_reviewed','legal_reviewed','resolved','rejected') THEN RAISE EXCEPTION 'invalid ownership review decision'; END IF;
  IF length(trim(coalesce(p_resolution_notes,'')))<12 THEN RAISE EXCEPTION 'resolution notes must contain at least 12 characters'; END IF;
  SELECT * INTO v_conflict FROM public.enterprise_ownership_conflicts_v1 WHERE id=p_conflict_id FOR UPDATE;
  SELECT * INTO v_task FROM public.enterprise_review_tasks_v1 WHERE id=v_conflict.review_task_id FOR UPDATE;
  SELECT * INTO v_reviewer FROM public.enterprise_reviewers_v1 WHERE id=p_reviewer_id AND active=true;
  IF v_conflict.id IS NULL OR v_conflict.resolution_status<>'open' THEN RAISE EXCEPTION 'open ownership conflict is required'; END IF;
  IF v_reviewer.id IS NULL OR v_reviewer.organization_id<>v_conflict.organization_id OR v_task.assigned_reviewer_id<>p_reviewer_id THEN RAISE EXCEPTION 'assigned named organization reviewer is required'; END IF;
  IF p_decision='legal_reviewed' AND v_reviewer.role<>'legal' THEN RAISE EXCEPTION 'legal review requires legal reviewer'; END IF;
  UPDATE public.enterprise_ownership_conflicts_v1 SET resolution_status=p_decision,reviewed_by_reviewer_id=p_reviewer_id,resolution_notes=trim(p_resolution_notes) WHERE id=p_conflict_id;
  INSERT INTO public.enterprise_activity_events_v1(organization_id,workspace_id,event_type,entity_type,entity_id,summary,metadata)
  VALUES(v_conflict.organization_id,v_conflict.workspace_id,'ownership_conflict.'||p_decision,'ownership_conflict',p_conflict_id,'Ownership data conflict reviewed by '||v_reviewer.display_name,jsonb_build_object('reviewer_id',p_reviewer_id,'resolution_notes',trim(p_resolution_notes)));
  RETURN p_conflict_id;
END $$;

CREATE OR REPLACE FUNCTION public.fn_enterprise_approve_recovery_opportunity_v1(p_opportunity_id uuid,p_reviewer_id uuid,p_approval_notes text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_opportunity public.enterprise_recovery_opportunities_v1%ROWTYPE; v_task public.enterprise_review_tasks_v1%ROWTYPE; v_reviewer public.enterprise_reviewers_v1%ROWTYPE;
BEGIN
  IF length(trim(coalesce(p_approval_notes,'')))<12 THEN RAISE EXCEPTION 'approval notes must contain at least 12 characters'; END IF;
  SELECT * INTO v_opportunity FROM public.enterprise_recovery_opportunities_v1 WHERE id=p_opportunity_id FOR UPDATE;
  SELECT * INTO v_task FROM public.enterprise_review_tasks_v1 WHERE id=v_opportunity.review_task_id FOR UPDATE;
  SELECT * INTO v_reviewer FROM public.enterprise_reviewers_v1 WHERE id=p_reviewer_id AND active=true;
  IF v_opportunity.id IS NULL OR v_opportunity.status NOT IN ('identified','review_required') THEN RAISE EXCEPTION 'reviewable recovery opportunity is required'; END IF;
  IF v_reviewer.id IS NULL OR v_reviewer.organization_id<>v_opportunity.organization_id OR v_task.assigned_reviewer_id<>p_reviewer_id OR v_reviewer.role NOT IN ('reviewer','administrator','legal') THEN RAISE EXCEPTION 'assigned named qualified reviewer is required'; END IF;
  UPDATE public.enterprise_recovery_opportunities_v1 SET status='approved',approved_by_reviewer_id=p_reviewer_id,approved_at=now(),approval_notes=trim(p_approval_notes),external_submission_enabled=false WHERE id=p_opportunity_id;
  INSERT INTO public.enterprise_activity_events_v1(organization_id,workspace_id,event_type,entity_type,entity_id,summary,metadata)
  VALUES(v_opportunity.organization_id,v_opportunity.workspace_id,'recovery_opportunity.approved','recovery_opportunity',p_opportunity_id,'Recovery opportunity approved for correction-package preparation by '||v_reviewer.display_name,jsonb_build_object('reviewer_id',p_reviewer_id,'approval_notes',trim(p_approval_notes),'external_submission_enabled',false));
  RETURN p_opportunity_id;
END $$;

CREATE OR REPLACE FUNCTION public.fn_enterprise_analysis_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'enterprise analysis evidence is append-only'; END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['enterprise_source_asset_records_v1','enterprise_asset_match_candidates_v1','enterprise_royalty_reconciliations_v1','enterprise_ownership_claims_v1'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I','trg_'||t||'_immutable',t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_enterprise_analysis_evidence_immutable()','trg_'||t||'_immutable',t);
  END LOOP;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['enterprise_analysis_rules_v1','enterprise_source_asset_records_v1','enterprise_asset_match_candidates_v1','enterprise_royalty_statements_v1','enterprise_royalty_reconciliations_v1','enterprise_ownership_claims_v1','enterprise_ownership_conflicts_v1','enterprise_recovery_opportunities_v1'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',t||'_service_role_all',t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING(true) WITH CHECK(true)',t||'_service_role_all',t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',t||'_org_read',t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING(organization_id IS NOT NULL AND public.fn_enterprise_has_org_access(organization_id))',t||'_org_read',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO service_role',t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS enterprise_match_review_idx ON public.enterprise_asset_match_candidates_v1(organization_id,classification,score DESC);
CREATE INDEX IF NOT EXISTS enterprise_reconciliation_review_idx ON public.enterprise_royalty_reconciliations_v1(organization_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS enterprise_ownership_review_idx ON public.enterprise_ownership_conflicts_v1(organization_id,resolution_status,created_at DESC);
CREATE INDEX IF NOT EXISTS enterprise_recovery_priority_idx ON public.enterprise_recovery_opportunities_v1(organization_id,status,score DESC);
REVOKE ALL ON FUNCTION public.fn_enterprise_analysis_evidence_immutable() FROM PUBLIC,authenticated;
REVOKE ALL ON FUNCTION public.fn_enterprise_resolve_ownership_conflict_v1(uuid,uuid,text,text) FROM PUBLIC,authenticated;
REVOKE ALL ON FUNCTION public.fn_enterprise_approve_recovery_opportunity_v1(uuid,uuid,text) FROM PUBLIC,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_enterprise_resolve_ownership_conflict_v1(uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_enterprise_approve_recovery_opportunity_v1(uuid,uuid,text) TO service_role;
NOTIFY pgrst,'reload schema';
