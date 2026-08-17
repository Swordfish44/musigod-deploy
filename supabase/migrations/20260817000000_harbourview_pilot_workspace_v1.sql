-- HarbourView Portfolio Rights Integrity Pilot workspace v1
-- Adds an explicitly bounded operating workspace on top of the enterprise foundation.

CREATE TABLE IF NOT EXISTS public.enterprise_pilot_workspaces_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  workspace_code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'configured' CHECK (status IN ('configured','intake','review','reporting','paused','completed')),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_assets integer NOT NULL DEFAULT 1000 CHECK (max_assets BETWEEN 1 AND 100000),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, workspace_code),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS public.enterprise_catalogs_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  catalog_code text NOT NULL,
  name text NOT NULL,
  asset_type text NOT NULL CHECK (asset_type IN ('mixed','recording','composition')),
  status text NOT NULL DEFAULT 'intake' CHECK (status IN ('intake','reconciling','review','complete','on_hold')),
  source_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, catalog_code),
  UNIQUE (organization_id, workspace_id, id),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES public.enterprise_pilot_workspaces_v1(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.enterprise_assets_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  catalog_id uuid NOT NULL,
  asset_reference text NOT NULL,
  asset_type text NOT NULL CHECK (asset_type IN ('recording','composition')),
  title text NOT NULL,
  isrc text,
  iswc text,
  review_status text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','matched','conflict','review_required','human_validated')),
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, asset_reference),
  CHECK (isrc IS NULL OR isrc ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$'),
  CHECK (iswc IS NULL OR iswc ~ '^T[0-9]{9}[0-9]$'),
  FOREIGN KEY (organization_id, workspace_id, catalog_id) REFERENCES public.enterprise_catalogs_v1(organization_id, workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.enterprise_review_tasks_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  catalog_id uuid,
  task_type text NOT NULL CHECK (task_type IN ('identity','metadata','royalty_rule','correction','chain_of_title','security','other')),
  title text NOT NULL,
  description text,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
  required_reviewer_role text NOT NULL CHECK (required_reviewer_role IN ('analyst','reviewer','administrator','legal')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','blocked','approved','rejected','closed')),
  assigned_to uuid REFERENCES auth.users(id),
  due_at timestamptz,
  resolution jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_by uuid REFERENCES auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('approved','rejected','closed') OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL)),
  CHECK (task_type <> 'chain_of_title' OR required_reviewer_role IN ('reviewer','administrator','legal')),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES public.enterprise_pilot_workspaces_v1(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, workspace_id, catalog_id) REFERENCES public.enterprise_catalogs_v1(organization_id, workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.enterprise_activity_events_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.enterprise_organizations_v1(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  actor_id uuid REFERENCES auth.users(id),
  summary text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES public.enterprise_pilot_workspaces_v1(organization_id, id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION public.fn_enterprise_activity_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'enterprise activity events are append-only';
END $$;
DROP TRIGGER IF EXISTS trg_enterprise_activity_immutable ON public.enterprise_activity_events_v1;
CREATE TRIGGER trg_enterprise_activity_immutable
BEFORE UPDATE OR DELETE ON public.enterprise_activity_events_v1
FOR EACH ROW EXECUTE FUNCTION public.fn_enterprise_activity_immutable();

CREATE INDEX IF NOT EXISTS enterprise_catalogs_workspace_status_idx ON public.enterprise_catalogs_v1(workspace_id, status);
CREATE INDEX IF NOT EXISTS enterprise_assets_catalog_review_idx ON public.enterprise_assets_v1(catalog_id, review_status);
CREATE INDEX IF NOT EXISTS enterprise_review_tasks_workspace_status_idx ON public.enterprise_review_tasks_v1(workspace_id, status, priority);
CREATE INDEX IF NOT EXISTS enterprise_activity_workspace_time_idx ON public.enterprise_activity_events_v1(workspace_id, occurred_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'enterprise_pilot_workspaces_v1','enterprise_catalogs_v1','enterprise_assets_v1',
    'enterprise_review_tasks_v1','enterprise_activity_events_v1'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role_all', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t || '_service_role_all', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_org_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.fn_enterprise_has_org_access(organization_id))', t || '_org_read', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

INSERT INTO public.enterprise_organizations_v1 (name, slug, status, data_region, settings)
VALUES ('HarbourView', 'harbourview', 'pilot', 'us', jsonb_build_object(
  'engagement', 'portfolio_rights_integrity_pilot',
  'external_submission_enabled', false,
  'legal_determination_automation', false
))
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  status = EXCLUDED.status,
  settings = enterprise_organizations_v1.settings || EXCLUDED.settings,
  updated_at = now();

INSERT INTO public.enterprise_pilot_workspaces_v1
  (organization_id, workspace_code, name, status, scope, acceptance_criteria, max_assets)
SELECT id, 'HV-PRI-001', 'HarbourView Portfolio Rights Integrity Pilot', 'configured',
  jsonb_build_object(
    'territories', jsonb_build_array('US'),
    'rights', jsonb_build_array('master','composition','neighboring_right'),
    'submission_mode', 'human_approved_only',
    'data_classification', 'confidential'
  ),
  jsonb_build_array(
    'Every imported row retains source provenance',
    'Conflicts enter a named human review queue',
    'Correction packages require human approval before submission',
    'Chain-of-title conclusions require legal review'
  ),
  1000
FROM public.enterprise_organizations_v1 WHERE slug = 'harbourview'
ON CONFLICT (organization_id, workspace_code) DO UPDATE SET
  name = EXCLUDED.name,
  scope = EXCLUDED.scope,
  acceptance_criteria = EXCLUDED.acceptance_criteria,
  max_assets = EXCLUDED.max_assets,
  updated_at = now();

INSERT INTO public.enterprise_data_sources_v1
  (organization_id, source_name, source_type, transport, authority_status, configuration)
SELECT id, 'HarbourView authorized portfolio export', 'acquisition', 'csv', 'client_authorized',
  jsonb_build_object('pilot_only', true, 'credentials_stored', false)
FROM public.enterprise_organizations_v1 WHERE slug = 'harbourview'
ON CONFLICT (organization_id, source_name) DO NOTHING;

NOTIFY pgrst, 'reload schema';
