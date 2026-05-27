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

## Pre-Deploy QA: Run Test Artist Echo

**Run before every production deploy.**

```bash
MUSIGOD_API_BASE=https://musigod.com \
STRIPE_SECRET_KEY=sk_test_... \
SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/test-rights-audit-flow.js
```

All steps must PASS before deploying. See `docs/QA_TEST_ARTIST_ECHO.md` for full reference.

To also verify email delivery:

```bash
MUSIGOD_API_BASE=https://musigod.com \
STRIPE_SECRET_KEY=sk_test_... \
SUPABASE_SERVICE_ROLE_KEY=... \
ALLOW_TEST_EMAILS=true \
node scripts/test-rights-audit-flow.js
```

## Live Checkout Verification

1. Submit a real Rights Audit request at `https://musigod.com/rights-audit.html`.
2. Click `UNLOCK FULL AUDIT`.
3. Complete the Stripe Checkout payment using test card `4242 4242 4242 4242`.
4. Confirm Stripe redirects to:

```text
https://musigod.com/audit-status.html?audit_id=AUDIT_ID&session_id=CHECKOUT_SESSION_ID
```

5. Confirm the page shows the green AUDIT UNLOCKED state with artist name and paid timestamp.
6. Confirm the Stripe webhook delivery returns HTTP 200.
7. Confirm `public.rights_audits_v1` shows `paid_status = 'PAID'`.
8. Confirm the admin Rights Audits view shows `PAID`.
9. Confirm confirmation email CTA points to `audit-status.html`, not `rights-audit.html`.

## Rollback

All previous versions are in GitHub history. To roll back any file:

```text
GitHub repo → file → History → previous commit → ⋯ → Revert
```

Then locally: `git pull && vercel --prod --force`
