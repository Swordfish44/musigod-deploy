-- READ ONLY. Expected result: all booleans true and both row counts zero before sandbox testing.

SELECT
  to_regclass('registrations.payment_accounts_v1') IS NOT NULL AS payment_accounts_exists,
  to_regclass('registrations.payment_event_receipts_v1') IS NOT NULL AS event_receipts_exists,
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'registrations'
      AND indexname = 'payment_accounts_v1_primary_artist_idx'
  ) AS one_primary_account_index_exists,
  EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'registrations'
      AND c.relname = 'payment_accounts_v1'
      AND c.relrowsecurity
  ) AS payment_accounts_rls_enabled,
  EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'registrations'
      AND c.relname = 'payment_event_receipts_v1'
      AND c.relrowsecurity
  ) AS event_receipts_rls_enabled;

SELECT 'payment_accounts_v1' AS table_name, count(*) AS row_count
FROM registrations.payment_accounts_v1
UNION ALL
SELECT 'payment_event_receipts_v1', count(*)
FROM registrations.payment_event_receipts_v1;

SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'registrations'
  AND table_name IN ('payment_accounts_v1', 'payment_event_receipts_v1')
  AND grantee IN ('anon', 'authenticated', 'service_role')
ORDER BY table_name, grantee, privilege_type;
