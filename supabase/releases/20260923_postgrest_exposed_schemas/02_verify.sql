-- 02_verify.sql — READ ONLY. Every Boolean must be true.
WITH cfg AS (
  SELECT string_agg(c, ' | ') AS entries
  FROM pg_db_role_setting s
  JOIN pg_roles r ON r.oid = s.setrole
  CROSS JOIN LATERAL unnest(s.setconfig) AS c
  WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.db_schemas=%'
)
SELECT
  cfg.entries                                                        AS pgrst_db_schemas,
  cfg.entries ~ '(=|,\s*)artists(,|$)'                               AS artists_exposed,
  cfg.entries ~ '(=|,\s*)registrations(,|$)'                         AS registrations_exposed,
  cfg.entries ~ '(=|,\s*)royalty_intelligence(,|$)'                  AS royalty_intelligence_still_exposed,
  has_schema_privilege('service_role', 'artists', 'USAGE')           AS sr_artists_usage,
  has_schema_privilege('service_role', 'registrations', 'USAGE')     AS sr_registrations_usage,
  has_table_privilege('service_role', 'artists.artists_v1', 'INSERT')             AS sr_artists_insert,
  has_table_privilege('service_role', 'registrations.registrations_v1', 'INSERT') AS sr_registrations_insert
FROM cfg;
