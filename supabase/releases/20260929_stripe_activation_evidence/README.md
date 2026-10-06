# Stripe activation chain (fix/stripe-activation-ledger)

No schema change. Every Stripe entitlement change now runs, in order:

1. **Verified event**: HMAC signature and 5-minute tolerance (unchanged).
2. **Idempotency**: lookup in `registrations.payment_event_receipts_v1`. If it was already processed, the handler returns 200 `duplicate` and does nothing else.
3. **Correct artist**: `client_reference_id` must equal `metadata.artist_id`. The artist must exist in `artists.artists_v1`. A Stripe customer already bound to another artist is refused. A refusal changes nothing, records a receipt with the reason and alerts Sentry.
4. **Payment recorded**: idempotent upsert into `registrations.payment_accounts_v1` on `(provider, provider_subscription_id)`. This happens before any entitlement change.
5. **Agreement check**: all of `agreement_signed_at`, `agreement_signed_by` and `agreement_document_url` must be present. If any is missing the artist is held at `PAID_AWAITING_AGREEMENT` and no activation is attempted.
6. **Audit before activation**: an `ACTIVATION_AUTHORIZED` row is written to `registrations.artist_activity_timeline_v1` (ADMIN_ONLY).
7. **Guarded activation**: `PATCH plan_status=ACTIVE`. The database guard still decides. If it refuses, the artist is held.
8. **Audit after activation**: the handler re-reads the row to confirm ACTIVE, writes an `ACCOUNT_ACTIVATED` row, then writes `meta.activation_event` as the completion marker.
9. **Receipt**: written last, so a failed step is reprocessed when Stripe retries.

Fail-closed rule: if the ledger, payment account or audit write fails, the webhook returns 500 and the artist is not activated. Stripe retries, and an interrupted activation is completed on the retry.

## Before deploy (required)
1. Run `00_preflight.sql` (read-only) one section at a time; the SQL editor shows only the last result.
2. **Every row in section A must be true.** If the ledger or payment-account tables are missing, install `20260922_provider_neutral_billing/01_install.sql` first, following its own gate. Section C references `payment_accounts_v1` and will error until that table exists.
3. Section C must return zero rows. Any row is an ACTIVE artist without a complete agreement or verifiable payment; review each one by hand.
4. Confirm the Stripe endpoint `/api/stripe-webhook` subscribes to: checkout.session.completed, checkout.session.async_payment_succeeded, customer.subscription.created/updated/deleted, invoice.paid, invoice.payment_failed, invoice.payment_action_required, charge.refunded.

## Live verification (Stripe test mode, then one live Starter)
1. Register a test artist, pay Starter, and sign the agreement.
2. Run:
   ```sql
   SELECT provider_event_id, event_type, payload FROM registrations.payment_event_receipts_v1 WHERE provider='stripe' ORDER BY processed_at DESC LIMIT 10;
   SELECT provider_customer_id, provider_subscription_id, plan_code, status, is_primary FROM registrations.payment_accounts_v1 WHERE artist_id='<artist>';
   SELECT event_type, created_at, metadata FROM registrations.artist_activity_timeline_v1 WHERE artist_id='<artist>' ORDER BY created_at;
   SELECT plan_status, meta->'activation_event' FROM artists.artists_v1 WHERE id='<artist>';
   ```
   The expected timeline is either ACTIVATION_HELD_AWAITING_AGREEMENT (if the artist paid first), then ACTIVATION_AUTHORIZED, then ACCOUNT_ACTIVATED.
3. Resend the checkout event from the Stripe Dashboard. The response must be `{"received":true,"duplicate":true}` and no new rows may appear.

## Rollback
Revert the commit and redeploy. Receipts, payment accounts and timeline rows are additive audit history; leave them in place.
