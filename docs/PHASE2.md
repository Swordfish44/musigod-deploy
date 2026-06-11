# MusiGod Phase 2 — Execution Brief

## Environment
- Repo: C:\musigod-deploy (branch release/fulfillment-layer-v1)
- Deploy: `vercel --prod --force` (PowerShell: semicolons not &&)
- Supabase project: uykzkrnoetcldeuxzqyy (raw fetch only — NO Supabase JS client)
- GitHub PAT already configured in git remote
- Admin key: mg-admin-2026
- Test artist: artist_id 86c8df13-dbc6-4846-a8da-cdbaaf386cc7, email swordfishlp44+testartist@proton.me

## Supabase Schema Facts
- artists schema: artists_v1 (plan_status: ACTIVE/SUSPENDED/CANCELLED/TRIAL/PENDING_CHECKOUT)
- registrations schema: registrations_v1 (status: CANCELLED/COMPLETED/IN_PROGRESS/PENDING/SUBMITTED)
- royalties schema: statements_v1 (source_category: US_PRO, status: RECEIVED)
- All raw fetch headers: apikey + Authorization: Bearer + Accept-Profile/Content-Profile for non-public schemas
- public schema: catalog_enrichments_v1 (no schema headers needed)

## Stripe
- Stripe Connect: api/create-connect-account.js, api/trigger-payout.js, api/submit-statement.js
- STRIPE_CONNECT URL currently hardcoded to NAIM's account — needs to be dynamic
- All Stripe keys in Vercel env

## DO NOT TOUCH
- lib/enrich-catalog.js
- lib/discogs.js  
- lib/generate-registration-files.js
- api/enrich-artist.js
- api/get-enrichment-status.js
- catalog-enrichment.html
These are working. Do not modify without explicit instruction.

## Known Issues Going In
- register-artist endpoint returns 500 (root cause unknown — investigate first)
- Stripe Connect onboarding URL is hardcoded to NAIM's account
- Co-writer split protocol not yet built
- Audit recovery pipeline not yet built

## Execution Order
Mission 1 → Mission 2 → Mission 3 → Mission 4
Do not start Mission 2 until Mission 1 passes E2E test.
Commit after each mission with descriptive message.
Deploy after Mission 1 and Mission 2. Stage 3 and 4 can be a single deploy.
