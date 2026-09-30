-- READ-ONLY. Run in the Supabase SQL editor for project uykzkrnoetcldeuxzqyy
-- BEFORE deploying fix/stripe-activation-ledger. Changes nothing.
-- Every row in section A MUST be true: the webhook now fails closed (HTTP 500,
-- Stripe retries, no activation) if the ledger, payment account or audit tables
-- are missing. Deploying with any false row blocks all Stripe activations.
-- sections B-D list records needing a human.

-- A. Objects the Stripe webhook now writes to / relies on
SELECT 'ledger_table_exists' AS check, to_regclass('registrations.payment_event_receipts_v1') IS NOT NULL AS ok
UNION ALL
SELECT 'ledger_unique_event', EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid = to_regclass('registrations.payment_event_receipts_v1') AND contype = 'u')
UNION ALL
SELECT 'service_role_can_insert_ledger',
  CASE WHEN to_regclass('registrations.payment_event_receipts_v1') IS NULL THEN false
       ELSE has_table_privilege('service_role', 'registrations.payment_event_receipts_v1', 'INSERT') END
UNION ALL
SELECT 'payment_accounts_table_exists', to_regclass('registrations.payment_accounts_v1') IS NOT NULL
UNION ALL
SELECT 'service_role_can_upsert_payment_accounts',
  CASE WHEN to_regclass('registrations.payment_accounts_v1') IS NULL THEN false
       ELSE has_table_privilege('service_role', 'registrations.payment_accounts_v1', 'INSERT')
        AND has_table_privilege('service_role', 'registrations.payment_accounts_v1', 'UPDATE') END
UNION ALL
SELECT 'activity_timeline_table_exists', to_regclass('registrations.artist_activity_timeline_v1') IS NOT NULL
UNION ALL
SELECT 'service_role_can_insert_timeline',
  CASE WHEN to_regclass('registrations.artist_activity_timeline_v1') IS NULL THEN false
       ELSE has_table_privilege('service_role', 'registrations.artist_activity_timeline_v1', 'INSERT') END
UNION ALL
SELECT 'registrations_schema_exposed_to_postgrest_or_unknown',
  current_setting('pgrst.db_schemas', true) IS NULL OR current_setting('pgrst.db_schemas', true) ILIKE '%registrations%'
UNION ALL
SELECT 'registrations_plan_status_column', EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'registrations' AND table_name = 'registrations_v1' AND column_name = 'plan_status')
UNION ALL
SELECT 'artist_activation_guard_present', EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('artists', 'public')
    AND pg_get_functiondef(p.oid) ILIKE '%signed Publishing Administration Agreement%');

-- B. plan_status CHECK constraint on artists.artists_v1 (confirms allowed values)
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'artists.artists_v1'::regclass AND contype = 'c';

-- C. ACTIVE artists that violate the activation contract (must be zero rows)
SELECT id, email, plan_tier, plan_status,
       agreement_signed_at IS NOT NULL      AS has_signed_at,
       agreement_signed_by IS NOT NULL      AS has_signed_by,
       agreement_document_url IS NOT NULL   AS has_document,
       meta->>'billing_status'              AS billing_status,
       meta ? 'activation_event'            AS has_activation_event
FROM artists.artists_v1
WHERE plan_status = 'ACTIVE'
  AND (agreement_signed_at IS NULL OR agreement_signed_by IS NULL OR agreement_document_url IS NULL
       OR NOT EXISTS (SELECT 1 FROM registrations.registrations_v1 r
                      WHERE r.artist_id = artists_v1.id AND (r.stripe_subscription_id IS NOT NULL
                            OR EXISTS (SELECT 1 FROM registrations.payment_accounts_v1 pa
                                       WHERE pa.artist_id = artists_v1.id AND pa.status = 'ACTIVE'))));

-- D. Paid, waiting on signature (the operator follow-up list)
SELECT id, email, plan_tier, meta->>'billing_provider' AS provider,
       meta->>'billing_paid_at' AS paid_at, meta->>'billing_event_id' AS event_id
FROM artists.artists_v1
WHERE meta->>'billing_status' = 'PAID_AWAITING_AGREEMENT'
ORDER BY meta->>'billing_paid_at';
