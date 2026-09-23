-- 00_preflight.sql — READ ONLY. Changes nothing.
-- Run in the Supabase SQL Editor on project uykzkrnoetcldeuxzqyy and paste the
-- single JSON result back into the PR / chat.
--
-- Answers:
--   1. Is there an in-database PostgREST override (pgrst.db_schemas on the
--      authenticator role) that shadows the dashboard "Exposed schemas" list?
--   2. Do the canonical schemas/tables exist (artists.artists_v1,
--      registrations.registrations_v1)? Is there also a registrations.artists_v1?
--   3. Does service_role have USAGE + table privileges on them?
--   4. Does the registrations upsert target (artist_id, registration_type) have
--      a matching unique constraint? Does artists_v1 have any uniqueness on email?

SELECT jsonb_pretty(jsonb_build_object(
  'authenticator_role_settings', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'database', coalesce(d.datname, '<all databases>'),
      'setconfig', to_jsonb(s.setconfig)
    )), '[]'::jsonb)
    FROM pg_db_role_setting s
    JOIN pg_roles r ON r.oid = s.setrole
    LEFT JOIN pg_database d ON d.oid = s.setdatabase
    WHERE r.rolname = 'authenticator'
  ),
  'pgrst_pre_config_functions', (
    SELECT coalesce(jsonb_agg(n.nspname || '.' || p.proname), '[]'::jsonb)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname ILIKE '%pre_config%'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  ),
  'schemas', (
    SELECT jsonb_object_agg(x.s, jsonb_build_object(
      'exists', to_regnamespace(x.s) IS NOT NULL,
      'service_role_usage', CASE WHEN to_regnamespace(x.s) IS NULL THEN NULL
        ELSE has_schema_privilege('service_role', x.s, 'USAGE') END
    ))
    FROM unnest(ARRAY['public','storage','graphql_public','royalty_intelligence',
                      'artists','registrations','fulfillment','works','rights',
                      'graph','royalties','disputes','legal','affiliates','catalog']) AS x(s)
  ),
  'tables', (
    SELECT jsonb_object_agg(x.t, CASE WHEN to_regclass(x.t) IS NULL THEN NULL ELSE jsonb_build_object(
      'relkind', (SELECT relkind::text FROM pg_class WHERE oid = to_regclass(x.t)),
      'rows_estimate', (SELECT reltuples::bigint FROM pg_class WHERE oid = to_regclass(x.t)),
      'rls_enabled', (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass(x.t)),
      'service_role_select', has_table_privilege('service_role', x.t, 'SELECT'),
      'service_role_insert', has_table_privilege('service_role', x.t, 'INSERT'),
      'service_role_update', has_table_privilege('service_role', x.t, 'UPDATE')
    ) END)
    FROM unnest(ARRAY['artists.artists_v1','registrations.artists_v1',
                      'registrations.registrations_v1',
                      'registrations.payment_accounts_v1',
                      'registrations.payment_event_receipts_v1']) AS x(t)
  ),
  'unique_indexes', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'table', i.indrelid::regclass::text,
      'index', i.indexrelid::regclass::text,
      'def', pg_get_indexdef(i.indexrelid)
    )), '[]'::jsonb)
    FROM pg_index i
    WHERE i.indisunique
      AND i.indrelid IN (
        SELECT to_regclass(t) FROM unnest(ARRAY['artists.artists_v1',
          'registrations.artists_v1','registrations.registrations_v1']) t
        WHERE to_regclass(t) IS NOT NULL)
  )
)) AS preflight;
