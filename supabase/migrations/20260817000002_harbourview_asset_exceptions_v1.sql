-- HarbourView deterministic asset exceptions and named finding review v1
ALTER TABLE public.enterprise_title_findings_v1
  ADD COLUMN IF NOT EXISTS reviewed_by_reviewer_id uuid REFERENCES public.enterprise_reviewers_v1(id);

CREATE OR REPLACE FUNCTION public.fn_enterprise_resolve_asset_finding_v1(p_finding_id uuid,p_reviewer_id uuid,p_decision text,p_resolution_notes text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_finding public.enterprise_title_findings_v1%ROWTYPE; v_reviewer public.enterprise_reviewers_v1%ROWTYPE; v_workspace_id uuid;
BEGIN
  IF p_decision NOT IN ('human_validated','rejected','resolved') THEN RAISE EXCEPTION 'invalid finding decision'; END IF;
  IF length(trim(coalesce(p_resolution_notes,'')))<12 THEN RAISE EXCEPTION 'resolution notes must contain at least 12 characters'; END IF;
  SELECT * INTO v_finding FROM public.enterprise_title_findings_v1 WHERE id=p_finding_id FOR UPDATE;
  SELECT * INTO v_reviewer FROM public.enterprise_reviewers_v1 WHERE id=p_reviewer_id AND active=true;
  IF v_finding.id IS NULL OR v_finding.review_status NOT IN ('open','human_validated') THEN RAISE EXCEPTION 'eligible open finding is required'; END IF;
  IF v_reviewer.id IS NULL OR v_reviewer.organization_id<>v_finding.organization_id OR v_reviewer.role NOT IN ('reviewer','administrator','legal') THEN RAISE EXCEPTION 'active qualified organization reviewer is required'; END IF;
  IF v_finding.legal_effect THEN RAISE EXCEPTION 'legal-effect findings require the legal validation workflow'; END IF;
  UPDATE public.enterprise_title_findings_v1 SET review_status=p_decision,reviewed_by_reviewer_id=p_reviewer_id,reviewed_at=now(),resolution_notes=trim(p_resolution_notes) WHERE id=p_finding_id;
  SELECT id INTO v_workspace_id FROM public.enterprise_pilot_workspaces_v1 WHERE organization_id=v_finding.organization_id AND workspace_code='HV-PRI-001';
  INSERT INTO public.enterprise_activity_events_v1(organization_id,workspace_id,event_type,entity_type,entity_id,summary,metadata)
  VALUES(v_finding.organization_id,v_workspace_id,'asset_finding.'||p_decision,'title_finding',p_finding_id,'Finding '||p_decision||' by '||v_reviewer.display_name,jsonb_build_object('reviewer_id',p_reviewer_id,'resolution_notes',trim(p_resolution_notes)));
  RETURN p_finding_id;
END $$;
REVOKE ALL ON FUNCTION public.fn_enterprise_resolve_asset_finding_v1(uuid,uuid,text,text) FROM PUBLIC,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_enterprise_resolve_asset_finding_v1(uuid,uuid,text,text) TO service_role;
CREATE INDEX IF NOT EXISTS enterprise_findings_named_reviewer_idx ON public.enterprise_title_findings_v1(organization_id,review_status,reviewed_by_reviewer_id);
NOTIFY pgrst,'reload schema';
