-- READ ONLY. Run in the Supabase SQL editor before installation.

SELECT
  current_database() AS database_name,
  current_user AS database_user,
  now() AS checked_at,
  to_regnamespace('registrations') IS NOT NULL AS registrations_schema_exists,
  to_regclass('registrations.artists_v1') IS NOT NULL AS artists_table_exists,
  to_regclass('registrations.registrations_v1') IS NOT NULL AS registrations_table_exists,
  to_regclass('registrations.payment_accounts_v1') IS NOT NULL AS payment_accounts_already_exists,
  to_regclass('registrations.payment_event_receipts_v1') IS NOT NULL AS event_receipts_already_exists;

SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'registrations'
  AND table_name IN ('artists_v1', 'registrations_v1')
  AND column_name IN ('id', 'artist_id', 'plan_status', 'plan_tier', 'plan_type')
ORDER BY table_name, ordinal_position;

SELECT schemaname, tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'registrations'
  AND tablename IN ('payment_accounts_v1', 'payment_event_receipts_v1')
ORDER BY tablename, policyname;
