-- HarbourView reviewer, authorization, and secure upload workflow v1

CREATE TABLE IF NOT EXISTS public.enterprise_reviewers_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 2 AND 120),
  email text NOT NULL CHECK (email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  role text NOT NULL CHECK (role IN ('analyst','reviewer','administrator','legal')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email),
  UNIQUE (organization_id, id)
);

ALTER TABLE public.enterprise_review_tasks_v1
  ADD COLUMN IF NOT EXISTS assigned_reviewer_id uuid REFERENCES public.enterprise_reviewers_v1(id),
  ADD COLUMN IF NOT EXISTS resolved_by_reviewer_id uuid REFERENCES public.enterprise_reviewers_v1(id),
  ADD COLUMN IF NOT EXISTS data_source_id uuid REFERENCES public.enterprise_data_sources_v1(id);

DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.enterprise_review_tasks_v1'::regclass
      AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%resolved_by IS NOT NULL%'
  LOOP EXECUTE format('ALTER TABLE public.enterprise_review_tasks_v1 DROP CONSTRAINT %I', c.conname); END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.fn_enterprise_resolve_review_task_v1(
  p_task_id uuid,
  p_reviewer_id uuid,
  p_decision text,
  p_resolution_notes text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_task public.enterprise_review_tasks_v1%ROWTYPE; v_reviewer public.enterprise_reviewers_v1%ROWTYPE;
BEGIN
  IF p_decision NOT IN ('approved','rejected','closed') THEN RAISE EXCEPTION 'invalid review decision'; END IF;
  IF length(trim(coalesce(p_resolution_notes,''))) < 12 THEN RAISE EXCEPTION 'resolution notes must contain at least 12 characters'; END IF;
  SELECT * INTO v_task FROM public.enterprise_review_tasks_v1 WHERE id = p_task_id FOR UPDATE;
  SELECT * INTO v_reviewer FROM public.enterprise_reviewers_v1 WHERE id = p_reviewer_id AND active = true;
  IF v_task.id IS NULL OR v_task.status NOT IN ('open','in_progress','blocked') THEN RAISE EXCEPTION 'eligible open task is required'; END IF;
  IF v_task.task_type = 'security' AND p_decision = 'approved' THEN RAISE EXCEPTION 'security authorization approval must use the source authorization workflow'; END IF;
  IF v_reviewer.id IS NULL OR v_reviewer.organization_id <> v_task.organization_id THEN RAISE EXCEPTION 'active organization reviewer is required'; END IF;
  IF v_task.assigned_reviewer_id IS DISTINCT FROM p_reviewer_id THEN RAISE EXCEPTION 'task must be assigned to the resolving reviewer'; END IF;
  IF v_task.task_type = 'chain_of_title' AND v_reviewer.role <> 'legal' THEN RAISE EXCEPTION 'chain-of-title resolution requires legal reviewer'; END IF;
  IF v_task.task_type <> 'chain_of_title' AND v_reviewer.role <> v_task.required_reviewer_role AND v_reviewer.role <> 'administrator' THEN RAISE EXCEPTION 'reviewer role does not satisfy task gate'; END IF;
  UPDATE public.enterprise_review_tasks_v1 SET status=p_decision,
    resolution=resolution || jsonb_build_object('resolution_notes',trim(p_resolution_notes),'decision',p_decision),
    resolved_by_reviewer_id=p_reviewer_id,resolved_at=now(),updated_at=now() WHERE id=p_task_id;
  INSERT INTO public.enterprise_activity_events_v1(organization_id,workspace_id,event_type,entity_type,entity_id,summary,metadata)
    VALUES(v_task.organization_id,v_task.workspace_id,'review_task.'||p_decision,'review_task',p_task_id,
      v_task.title||' '||p_decision||' by '||v_reviewer.display_name,jsonb_build_object('reviewer_id',p_reviewer_id,'resolution_notes',trim(p_resolution_notes)));
  RETURN p_task_id;
END $$;
ALTER TABLE public.enterprise_review_tasks_v1 DROP CONSTRAINT IF EXISTS enterprise_review_tasks_v1_named_resolution_check;
ALTER TABLE public.enterprise_review_tasks_v1
  ADD CONSTRAINT enterprise_review_tasks_v1_named_resolution_check
  CHECK (status NOT IN ('approved','rejected','closed') OR (coalesce(resolved_by_reviewer_id, resolved_by) IS NOT NULL AND resolved_at IS NOT NULL));

CREATE TABLE IF NOT EXISTS public.enterprise_source_authorizations_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  data_source_id uuid NOT NULL REFERENCES public.enterprise_data_sources_v1(id) ON DELETE CASCADE,
  review_task_id uuid NOT NULL REFERENCES public.enterprise_review_tasks_v1(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','revoked','expired')),
  authorization_reference text NOT NULL,
  resolution_notes text NOT NULL CHECK (length(trim(resolution_notes)) >= 12),
  approved_by_reviewer_id uuid REFERENCES public.enterprise_reviewers_v1(id),
  approved_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, data_source_id),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES public.enterprise_pilot_workspaces_v1(organization_id, id) ON DELETE CASCADE,
  CHECK (status <> 'approved' OR (approved_by_reviewer_id IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.enterprise_portfolio_uploads_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  catalog_id uuid NOT NULL REFERENCES public.enterprise_catalogs_v1(id) ON DELETE CASCADE,
  data_source_id uuid NOT NULL REFERENCES public.enterprise_data_sources_v1(id),
  uploaded_by_reviewer_id uuid REFERENCES public.enterprise_reviewers_v1(id),
  filename text NOT NULL,
  storage_bucket text NOT NULL DEFAULT 'enterprise-portfolio-quarantine',
  storage_path text NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK (mime_type IN ('text/csv','application/csv','text/plain')),
  file_size_bytes bigint NOT NULL CHECK (file_size_bytes BETWEEN 1 AND 10485760),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  record_type text NOT NULL CHECK (record_type IN ('recording','composition','party','right','usage','royalty','payment','registration','agreement')),
  status text NOT NULL DEFAULT 'quarantined' CHECK (status IN ('quarantined','preview_ready','imported','rejected')),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count BETWEEN 0 AND 1000),
  preview jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_batch_id uuid REFERENCES public.enterprise_import_batches_v1(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  imported_at timestamptz,
  UNIQUE (organization_id, content_sha256),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES public.enterprise_pilot_workspaces_v1(organization_id, id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION public.fn_enterprise_source_authorization_required()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.enterprise_source_authorizations_v1 a
    WHERE a.organization_id = NEW.organization_id
      AND a.data_source_id = NEW.data_source_id
      AND a.status = 'approved'
      AND (a.expires_at IS NULL OR a.expires_at > now())
  ) THEN
    RAISE EXCEPTION 'approved source authorization is required before import';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enterprise_import_requires_authorization ON public.enterprise_import_batches_v1;
CREATE TRIGGER trg_enterprise_import_requires_authorization
BEFORE INSERT ON public.enterprise_import_batches_v1
FOR EACH ROW EXECUTE FUNCTION public.fn_enterprise_source_authorization_required();

CREATE OR REPLACE FUNCTION public.fn_enterprise_approve_source_authorization_v1(
  p_task_id uuid,
  p_reviewer_id uuid,
  p_data_source_id uuid,
  p_authorization_reference text,
  p_resolution_notes text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_task public.enterprise_review_tasks_v1%ROWTYPE;
  v_reviewer public.enterprise_reviewers_v1%ROWTYPE;
  v_auth_id uuid;
BEGIN
  IF length(trim(coalesce(p_authorization_reference,''))) < 4 THEN RAISE EXCEPTION 'authorization reference is required'; END IF;
  IF length(trim(coalesce(p_resolution_notes,''))) < 12 THEN RAISE EXCEPTION 'resolution notes must contain at least 12 characters'; END IF;

  SELECT * INTO v_task FROM public.enterprise_review_tasks_v1 WHERE id = p_task_id FOR UPDATE;
  IF v_task.id IS NULL OR v_task.task_type <> 'security' OR v_task.status NOT IN ('open','in_progress','blocked') THEN
    RAISE EXCEPTION 'eligible open source-authorization task is required';
  END IF;
  SELECT * INTO v_reviewer FROM public.enterprise_reviewers_v1 WHERE id = p_reviewer_id AND active = true;
  IF v_reviewer.id IS NULL OR v_reviewer.organization_id <> v_task.organization_id OR v_reviewer.role <> 'administrator' THEN
    RAISE EXCEPTION 'active administrator reviewer is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.enterprise_data_sources_v1 s WHERE s.id = p_data_source_id AND s.organization_id = v_task.organization_id AND s.active = true) THEN
    RAISE EXCEPTION 'active organization source is required';
  END IF;

  UPDATE public.enterprise_review_tasks_v1 SET
    assigned_reviewer_id = p_reviewer_id,
    data_source_id = p_data_source_id,
    status = 'approved',
    resolution = jsonb_build_object('authorization_reference', trim(p_authorization_reference), 'resolution_notes', trim(p_resolution_notes)),
    resolved_by_reviewer_id = p_reviewer_id,
    resolved_at = now(),
    updated_at = now()
  WHERE id = p_task_id;

  INSERT INTO public.enterprise_source_authorizations_v1(
    organization_id, workspace_id, data_source_id, review_task_id, status,
    authorization_reference, resolution_notes, approved_by_reviewer_id, approved_at
  ) VALUES (
    v_task.organization_id, v_task.workspace_id, p_data_source_id, p_task_id, 'approved',
    trim(p_authorization_reference), trim(p_resolution_notes), p_reviewer_id, now()
  ) ON CONFLICT (organization_id, data_source_id) DO UPDATE SET
    review_task_id = EXCLUDED.review_task_id,
    status = 'approved',
    authorization_reference = EXCLUDED.authorization_reference,
    resolution_notes = EXCLUDED.resolution_notes,
    approved_by_reviewer_id = EXCLUDED.approved_by_reviewer_id,
    approved_at = now(),
    updated_at = now()
  RETURNING id INTO v_auth_id;

  UPDATE public.enterprise_portfolio_uploads_v1
    SET status = 'preview_ready',
        validation_summary = validation_summary || jsonb_build_object('authorization_approved', true)
  WHERE organization_id = v_task.organization_id
    AND data_source_id = p_data_source_id
    AND status = 'quarantined';

  INSERT INTO public.enterprise_activity_events_v1(organization_id, workspace_id, event_type, entity_type, entity_id, summary, metadata)
  VALUES (v_task.organization_id, v_task.workspace_id, 'source_authorization.approved', 'data_source', p_data_source_id,
    'Source authorization approved by ' || v_reviewer.display_name,
    jsonb_build_object('reviewer_id', p_reviewer_id, 'review_task_id', p_task_id, 'authorization_reference', trim(p_authorization_reference)));
  RETURN v_auth_id;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['enterprise_reviewers_v1','enterprise_source_authorizations_v1','enterprise_portfolio_uploads_v1'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role_all', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t || '_service_role_all', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_org_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.fn_enterprise_has_org_access(organization_id))', t || '_org_read', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.fn_enterprise_source_authorization_required() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_enterprise_approve_source_authorization_v1(uuid,uuid,uuid,text,text) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.fn_enterprise_resolve_review_task_v1(uuid,uuid,text,text) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_enterprise_approve_source_authorization_v1(uuid,uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_enterprise_resolve_review_task_v1(uuid,uuid,text,text) TO service_role;
CREATE INDEX IF NOT EXISTS enterprise_reviewers_org_active_idx ON public.enterprise_reviewers_v1(organization_id, active, role);
CREATE INDEX IF NOT EXISTS enterprise_authorizations_source_status_idx ON public.enterprise_source_authorizations_v1(data_source_id, status);
CREATE INDEX IF NOT EXISTS enterprise_uploads_workspace_status_idx ON public.enterprise_portfolio_uploads_v1(workspace_id, status, uploaded_at DESC);

DO $$ BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('enterprise-portfolio-quarantine','enterprise-portfolio-quarantine',false,10485760,ARRAY['text/csv','application/csv','text/plain'])
    ON CONFLICT (id) DO UPDATE SET public=false, file_size_limit=10485760, allowed_mime_types=EXCLUDED.allowed_mime_types;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
