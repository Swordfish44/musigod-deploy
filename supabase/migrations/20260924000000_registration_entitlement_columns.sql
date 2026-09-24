-- Adds the entitlement columns that api/paypal-webhook.js and api/stripe-webhook.js
-- already write to registrations.registrations_v1 (plan_status, plan_type) and
-- that api/create-checkout-session.js reads (stripe_customer_id).
-- Production lacked them, so every activation webhook PATCH returned 400 and the
-- artist never became ACTIVE. Additive, nullable, idempotent. No data changes.
BEGIN;
ALTER TABLE registrations.registrations_v1 ADD COLUMN IF NOT EXISTS plan_status TEXT;
ALTER TABLE registrations.registrations_v1 ADD COLUMN IF NOT EXISTS plan_type TEXT;
ALTER TABLE registrations.registrations_v1 ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
COMMIT;
NOTIFY pgrst, 'reload schema';
