# PostgREST exposed-schemas repair (PGRST106 "Invalid schema: artists")

## Symptom
`POST /api/register-artist` → 500. Server log:
`Supabase POST artists_v1 failed: 406 {"code":"PGRST106","message":"Invalid schema: artists","hint":"Only the following schemas are exposed: public, storage, graphql_public, royalty_intelligence"}`
while Dashboard → Data API → Exposed schemas shows `artists` selected.

Same code is on `master`, so production registration (and every `artists`/`registrations` profile call) is affected, not only PR #40.

## Root cause
The `authenticator` role carries an in-database PostgREST setting, `pgrst.db_schemas = 'public, storage, graphql_public, royalty_intelligence'`.
In-database config overrides the dashboard. Once it exists, saving the dashboard changes nothing PostgREST serves ([Supabase: PGRST106 troubleshooting](https://supabase.com/docs/guides/troubleshooting/pgrst106-the-schema-must-be-one-of-the-following-error-when-querying-an-exposed-schema)).
Earlier "dashboard setting not propagating" notes (`20260810000000_mb_staging_rpc_wrappers.sql`) are consistent with the same override.
The override is not in any tracked migration; it was applied via the SQL Editor, most likely while exposing `royalty_intelligence`.

## Run order (SQL Editor, project `uykzkrnoetcldeuxzqyy`)
1. `00_preflight.sql`: read-only. Save the JSON.
2. `01_fix.sql`: idempotent. Aborts unless `artists.artists_v1` and `registrations.registrations_v1` exist and an override is present. Merges `artists, registrations, fulfillment, works, rights` (existing ones only) into the override, grants service_role table access, then reloads PostgREST.
3. `02_verify.sql`: every Boolean must be true.
4. `node scripts/check-postgrest-exposure.js`: live probe, must PASS both.
5. If the Data API becomes unhealthy (PGRST002), run `03_rollback.sql`.

## Handing control back to the dashboard (optional, later)
When the dashboard list is confirmed to contain every schema above, and all of those schemas exist:
`ALTER ROLE authenticator RESET pgrst.db_schemas; NOTIFY pgrst, 'reload config';`
After that, dashboard saves take effect again. Until then, **edit exposure in SQL, not the dashboard.**
