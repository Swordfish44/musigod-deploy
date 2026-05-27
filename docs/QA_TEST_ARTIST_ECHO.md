# QA Test Artist: Echo

**Permanent QA persona for all MusiGod testing. Never treat as a real customer.**

---

## Profile

| Field | Value |
|-------|-------|
| Artist Name | Test Artist Echo |
| Legal Name | Echo Validation |
| Email | swordfishlp44+testartist@proton.me |
| Phone | 313-555-0199 |
| PRO Affiliation | ASCAP |
| Publisher Name | Echo Test Publishing |
| Distributor | DistroKid |
| Catalog Size | 12 released songs |
| Released Music | Already released |
| Spotify | https://open.spotify.com/artist/test-artist-echo |
| Apple Music | https://music.apple.com/us/artist/test-artist-echo |
| YouTube | https://youtube.com/@testartistecho |
| Instagram | https://instagram.com/testartistecho |
| TikTok | https://tiktok.com/@testartistecho |

**Primary Rights Concern:** Unsure whether publishing, SoundExchange, YouTube Content ID,
and neighboring rights are properly registered.

---

## Purpose

Use this persona for regression testing across every layer of the MusiGod stack:

- Rights audit intake (`/rights-audit.html`)
- Stripe checkout (test mode only — use Stripe test card `4242 4242 4242 4242`)
- `audit-status.html` post-payment page
- Resend confirmation email delivery
- Supabase `rights_audits_v1` record writes
- n8n workflow triggers
- Fulfillment status transitions
- Admin panel audit views

---

## QA Script

```bash
# From repo root — requires MUSIGOD_API_BASE and SUPABASE_SERVICE_ROLE_KEY in env
node scripts/test-rights-audit-flow.js
```

Fixture file: `scripts/fixtures/test-artist-echo.json`

---

## Safeguards

- All test records are written with `source: 'qa-test-artist-echo'`
- Script never charges real money — it only creates a checkout session and verifies the URL exists
- Script will not send emails unless `ALLOW_TEST_EMAILS=true` is set
- Stripe test mode must be active (`STRIPE_SECRET_KEY` starts with `sk_test_`)
- Script will refuse to run against production Stripe keys without `FORCE_PRODUCTION_QA=true`

---

## Identifying Test Records in Supabase

Query to find all Echo test records:

```sql
SELECT * FROM public.rights_audits_v1
WHERE source = 'qa-test-artist-echo'
ORDER BY created_at DESC;
```

To clean up after a test run:

```sql
DELETE FROM public.rights_audits_v1
WHERE source = 'qa-test-artist-echo'
  AND paid_status IS NULL;
-- Never delete PAID records without manual confirmation
```

---

## Pre-Deploy QA Checklist

Run before every production deploy:

1. `node scripts/test-rights-audit-flow.js`
2. Verify all steps PASS
3. Check Supabase: new row with `source = 'qa-test-artist-echo'`
4. Verify `audit_id` returned
5. Verify checkout URL is a valid `https://checkout.stripe.com/...` link
6. Verify `audit-status.html?audit_id=<id>` loads without error
7. If `ALLOW_TEST_EMAILS=true`: verify email arrived at `swordfishlp44+testartist@proton.me`

**Do not deploy to production if any step fails.**

---

## Stripe Test Cards

| Scenario | Card Number |
|----------|-------------|
| Success | 4242 4242 4242 4242 |
| Declined | 4000 0000 0000 0002 |
| Requires auth | 4000 0025 0000 3155 |

Expiry: any future date. CVC: any 3 digits.
