-- ROLLBACK. Refuses to remove either table after any payment data exists.

BEGIN;

DO $billing_rollback$
BEGIN
  IF to_regclass('registrations.payment_accounts_v1') IS NOT NULL
     AND EXISTS (SELECT 1 FROM registrations.payment_accounts_v1 LIMIT 1) THEN
    RAISE EXCEPTION 'Rollback blocked: registrations.payment_accounts_v1 contains data';
  END IF;

  IF to_regclass('registrations.payment_event_receipts_v1') IS NOT NULL
     AND EXISTS (SELECT 1 FROM registrations.payment_event_receipts_v1 LIMIT 1) THEN
    RAISE EXCEPTION 'Rollback blocked: registrations.payment_event_receipts_v1 contains data';
  END IF;
END
$billing_rollback$;

DROP TABLE IF EXISTS registrations.payment_event_receipts_v1;
DROP TABLE IF EXISTS registrations.payment_accounts_v1;

COMMIT;
