# Stripe Rights Audit Deployment Checklist

This checklist finalizes the paid MusiGod Rights Audit unlock path.

## Required Vercel Environment Variables

- `STRIPE_SECRET_KEY`
- `STRIPE_RIGHTS_AUDIT_UNLOCK_PRICE_ID`
- `STRIPE_WEBHOOK_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_API_KEY`

Do not expose `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, or `SUPABASE_SERVICE_ROLE_KEY` to frontend code.

## Supabase Migration

Run `supabase/migrations/20260523_rights_audit_paid_unlock.sql` before testing paid unlocks.

The migration is idempotent and adds:

- `paid_status`
- `paid_at`
- `stripe_session_id`
- `stripe_customer_email`

## Stripe Webhook Setup

1. Open Stripe Dashboard.
2. Go to Developers, then Webhooks.
3. Click Add destination.
4. Set scope to Your account.
5. Select event `checkout.session.completed`.
6. Set destination type to Webhook endpoint.
7. Set endpoint URL to `https://musigod.com/api/stripe-webhook`.
8. Save the endpoint.
9. Copy the signing secret starting with `whsec_`.
10. Add the signing secret to Vercel as `STRIPE_WEBHOOK_SECRET`.
11. Redeploy production after adding or changing Vercel environment variables.

## Live Checkout Verification

1. Submit a real Rights Audit request at `https://musigod.com/rights-audit.html`.
2. Click `UNLOCK FULL AUDIT`.
3. Complete the Stripe Checkout payment.
4. Confirm Stripe redirects to:

```text
https://musigod.com/rights-audit.html?audit_id=AUDIT_ID&unlock=success&session_id=CHECKOUT_SESSION_ID
```

5. Confirm the page shows:

```text
Your full MusiGod Rights Audit has been unlocked. Check your email for next steps.
```

6. Confirm the Stripe webhook delivery returns HTTP 200.
7. Confirm `public.rights_audits_v1` shows `paid_status = 'PAID'`.
8. Confirm the admin Rights Audits view shows `PAID`.

