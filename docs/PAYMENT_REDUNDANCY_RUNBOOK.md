# MusiGod Payment Redundancy Runbook

## Safety boundary

Stripe remains the default provider. PayPal is fail-closed and unavailable unless its feature flag, credentials, webhook ID, and plan IDs are configured. Switching providers affects only new checkout sessions; it does not move funds already held by a processor or migrate existing subscriptions.

## Required PayPal configuration

Create and approve a PayPal Business REST app, one active monthly billing plan per MusiGod tier, and a webhook pointing to:

`https://musigod.com/api/paypal-webhook`

Subscribe the webhook to:

- `BILLING.SUBSCRIPTION.CREATED`
- `BILLING.SUBSCRIPTION.ACTIVATED`
- `BILLING.SUBSCRIPTION.UPDATED`
- `BILLING.SUBSCRIPTION.EXPIRED`
- `BILLING.SUBSCRIPTION.CANCELLED`
- `BILLING.SUBSCRIPTION.SUSPENDED`
- `BILLING.SUBSCRIPTION.PAYMENT.FAILED`
- `PAYMENT.SALE.COMPLETED`
- `PAYMENT.SALE.REFUNDED`
- `PAYMENT.SALE.REVERSED`

Set these Vercel environment variables first in Preview:

```text
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_WEBHOOK_ID=...
PAYPAL_STARTER_PLAN_ID=...
PAYPAL_GROWTH_PLAN_ID=...
PAYPAL_PRO_PLAN_ID=...
PAYPAL_LABEL_PLAN_ID=...
PAYPAL_BILLING_ENABLED=true
PAYMENT_CHECKOUT_PROVIDER=stripe
```

## Controlled activation sequence

1. Execute the reviewed preflight, install, verification, and guarded rollback package in `supabase/releases/20260922_provider_neutral_billing/`. Do not apply the migration before the preflight is reviewed.
2. Deploy this branch to a Vercel Preview deployment.
3. Complete one sandbox purchase for each plan.
4. Confirm the verified webhook writes one `registrations.payment_accounts_v1` row and one event receipt, and sets the artist entitlement to `ACTIVE`.
5. Replay the same webhook and confirm it returns `duplicate: true` without a second entitlement change.
6. Test cancellation, suspension, failed payment, refund, and reversal events.
7. Change only Preview to `PAYMENT_CHECKOUT_PROVIDER=paypal` and repeat registration end to end.
8. Keep Production on `stripe` until the above checks pass and PayPal has approved the live business account.

## Emergency switch

When PayPal live mode has already passed controlled testing, switch new subscriptions by setting:

```text
PAYPAL_ENV=live
PAYMENT_CHECKOUT_PROVIDER=paypal
```

Redeploy so `/api/public-config` exposes the new provider. Do not disable Stripe webhooks: existing Stripe subscriptions must continue to deliver renewal, failure, cancellation, and refund events.

To return new checkout to Stripe, set `PAYMENT_CHECKOUT_PROVIDER=stripe` and redeploy. Existing PayPal webhooks must remain enabled for PayPal subscribers.

## Manual invoice fallback

Enterprise and diagnostic customers can be invoiced for ACH or wire outside the web checkout. Record cleared payments in the provider-neutral ledger only after bank confirmation. Never mark an artist `ACTIVE` from an emailed receipt, screenshot, browser return parameter, or unverified webhook.
