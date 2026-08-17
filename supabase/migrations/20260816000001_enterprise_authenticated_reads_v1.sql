-- Enterprise authenticated read grants v1
-- Completes the named-user side of the RLS model introduced in
-- 20260816000000_enterprise_foundation_v1.sql.

DROP POLICY IF EXISTS enterprise_organizations_v1_member_read
  ON public.enterprise_organizations_v1;
CREATE POLICY enterprise_organizations_v1_member_read
  ON public.enterprise_organizations_v1
  FOR SELECT TO authenticated
  USING (public.fn_enterprise_has_org_access(id));

DROP POLICY IF EXISTS enterprise_memberships_v1_self_read
  ON public.enterprise_memberships_v1;
CREATE POLICY enterprise_memberships_v1_self_read
  ON public.enterprise_memberships_v1
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND active = true);

GRANT SELECT ON public.enterprise_organizations_v1 TO authenticated;
GRANT SELECT ON public.enterprise_memberships_v1 TO authenticated;
GRANT SELECT ON public.enterprise_data_sources_v1 TO authenticated;
GRANT SELECT ON public.enterprise_import_batches_v1 TO authenticated;
GRANT SELECT ON public.enterprise_import_records_v1 TO authenticated;
GRANT SELECT ON public.enterprise_correction_packages_v1 TO authenticated;
GRANT SELECT ON public.enterprise_title_documents_v1 TO authenticated;
GRANT SELECT ON public.enterprise_title_findings_v1 TO authenticated;

NOTIFY pgrst, 'reload schema';
