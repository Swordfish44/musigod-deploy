-- 01_fix.sql — restore PostgREST exposure of the canonical MusiGod schemas.
--
-- ROOT CAUSE
--   PostgREST on project uykzkrnoetcldeuxzqyy answers
--     PGRST106 "Invalid schema: artists"
--     "Only the following schemas are exposed: public, storage, graphql_public, royalty_intelligence"
--   while Dashboard -> Data API -> Exposed schemas shows `artists` selected.
--   An in-database override `ALTER ROLE authenticator SET pgrst.db_schemas = ...`
--   takes precedence over the dashboard setting. Once that override exists,
--   saving the dashboard no longer changes what PostgREST serves
--   (Supabase docs: "PGRST106 ... error when querying an exposed schema").
--   The override value lists royalty_intelligence but not artists/registrations,
--   so every Accept-Profile: artists / registrations call is rejected.
--
-- WHAT THIS DOES (idempotent, no data touched, no tables created or dropped)
--   * Aborts unless artists.artists_v1 and registrations.registrations_v1 exist.
--   * Aborts if no pgrst.db_schemas override exists (then this diagnosis is wrong).
--   * Rewrites the override as: current entries + the schemas the application
--     code addresses via Accept-Profile, keeping only schemas that exist
--     (a missing schema in db_schemas takes the whole Data API down: PGRST002).
--     `graph` and `affiliates` are intentionally NOT added (private by design).
--   * Grants service_role USAGE + SELECT/INSERT/UPDATE on the two canonical
--     tables (no anon/authenticated grants).
--   * Reloads PostgREST config and schema cache.
--
-- Do not wrap further; this file carries its own transaction.

BEGIN;

DO $$
DECLARE
  app_schemas text[] := ARRAY['artists', 'registrations', 'fulfillment', 'works', 'rights'];
  scope record;
  current_list text[];
  merged text[];
  s text;
  touched int := 0;
BEGIN
  IF to_regclass('artists.artists_v1') IS NULL THEN
    RAISE EXCEPTION 'Aborted: artists.artists_v1 does not exist — canonical table missing, do not expose';
  END IF;
  IF to_regclass('registrations.registrations_v1') IS NULL THEN
    RAISE EXCEPTION 'Aborted: registrations.registrations_v1 does not exist';
  END IF;

  FOR scope IN
    SELECT s.setdatabase, d.datname, c AS entry
    FROM pg_db_role_setting s
    JOIN pg_roles r ON r.oid = s.setrole
    LEFT JOIN pg_database d ON d.oid = s.setdatabase
    CROSS JOIN LATERAL unnest(s.setconfig) AS c
    WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.db_schemas=%'
  LOOP
    current_list := ARRAY(
      SELECT btrim(x) FROM unnest(string_to_array(substr(scope.entry, length('pgrst.db_schemas=') + 1), ',')) x
      WHERE btrim(x) <> '');
    merged := '{}';
    FOREACH s IN ARRAY current_list || app_schemas LOOP
      IF to_regnamespace(s) IS NOT NULL AND NOT s = ANY(merged) THEN
        merged := merged || s;
      END IF;
    END LOOP;

    IF scope.setdatabase = 0 THEN
      EXECUTE format('ALTER ROLE authenticator SET pgrst.db_schemas = %L', array_to_string(merged, ', '));
    ELSE
      EXECUTE format('ALTER ROLE authenticator IN DATABASE %I SET pgrst.db_schemas = %L',
                     scope.datname, array_to_string(merged, ', '));
    END IF;
    RAISE NOTICE 'pgrst.db_schemas (%): [%] -> [%]', coalesce(scope.datname, 'all databases'),
      array_to_string(current_list, ', '), array_to_string(merged, ', ');
    touched := touched + 1;
  END LOOP;

  IF touched = 0 THEN
    RAISE EXCEPTION 'Aborted: no pgrst.db_schemas override on authenticator — the PGRST106 cause is elsewhere; do not proceed';
  END IF;
END $$;

GRANT USAGE ON SCHEMA artists TO service_role;
GRANT USAGE ON SCHEMA registrations TO service_role;
GRANT SELECT, INSERT, UPDATE ON artists.artists_v1 TO service_role;
GRANT SELECT, INSERT, UPDATE ON registrations.registrations_v1 TO service_role;

COMMIT;

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
