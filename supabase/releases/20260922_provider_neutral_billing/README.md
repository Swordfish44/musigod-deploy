# Provider-Neutral Billing Release Gate

This package prepares the two service-role-only billing tables required by the PayPal failover branch. It does not alter Stripe tables, existing subscriptions, checkout selection, or payout configuration.

## Required execution order

1. Run `00_preflight.sql` and save the result.
2. Confirm the `registrations` schema and canonical artist/registration tables exist.
3. Review `01_install.sql` against the canonical migration.
4. Run `01_install.sql` in the Supabase SQL editor.
5. Run `02_verify.sql`; every Boolean must be true.
6. Deploy the branch to Vercel Preview only.
7. Keep `PAYMENT_CHECKOUT_PROVIDER=stripe` while creating and validating PayPal sandbox plans.
8. Run one controlled sandbox subscription for each $79, $129, $179, and $699 tier.
9. Verify activation, renewal, failed payment, cancellation, suspension, refund, webhook replay, and database records.
10. Stop.

`03_rollback.sql` removes only these two new tables and refuses to run once either contains data.

## Current decision

PayPal credentials, webhook registration, plan IDs, the database preflight, Preview deployment, and controlled sandbox payments have not yet been verified.

**BLOCKED**
