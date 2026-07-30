# Artist Intake Deployment Runbook

**Status:** Pre-production — no production deployment until all blockers are cleared  
**Branch:** `fix/pgrst202-schema-cache` (current development branch)

---

## Deployment Blockers (Must Resolve First)

1. **Attorney approval** — engagement agreement and LOA language (see `ARTIST_INTAKE_LEGAL_REVIEW_CHECKLIST.md`)
2. **E-sign vendor selection** — paid vendor required; mock provider is test-only
3. **Database migration** — `intake_workflows_v1`, `intake_transitions_v1`, `intake_item_statuses_v1`, `intake_manifests_v1` tables not yet applied to production
4. **Storage bucket privacy verification** — confirm `artist-documents` bucket has deny-by-default public access
5. **n8n workflow configuration** — intake reminder workflow nodes need to be wired to `lib/intake-comms.js` message types
6. **SoundExchange API** — remains feature-flagged OFF; no action required before deployment

---

## Pre-Deployment Checklist

### Code
- [ ] All 683 assertions pass (`npm test`)
- [ ] No credentials or private data in committed files (`git status`, `git diff`)
- [ ] `.gitignore` covers all sensitive file patterns (verified with `git check-ignore`)
- [ ] Sentry error capture wired in API routes (`_sentry.js` pattern)
- [ ] ADMIN_API_KEY environment variable set in Vercel for admin routes
- [ ] RESEND_API_KEY environment variable set in Vercel
- [ ] N8N_REGISTERED_WEBHOOK_URL set in Vercel

### Legal
- [ ] Engagement agreement attorney-approved (see Part 1 of legal checklist)
- [ ] LOA attorney-approved (see Part 2 of legal checklist)
- [ ] Privacy policy updated to reflect intake data collection
- [ ] Attorney sign-off recorded in `ARTIST_INTAKE_LEGAL_REVIEW_CHECKLIST.md`

### E-Sign Provider
- [ ] Vendor selected (DocuSign, HelloSign/Dropbox Sign, PandaDoc, or other)
- [ ] Vendor agreement executed
- [ ] `ESIGN_PROVIDER` environment variable set in Vercel
- [ ] Vendor webhook secret configured
- [ ] `MockESignProvider._simulateSigning()` call paths removed or feature-flagged in production

### Database Migration
Apply migrations to production **after attorney review** and in this order:

```sql
-- Step 1: Apply intake workflow tables
-- File: supabase/migrations/YYYYMMDD_intake_workflows_v1.sql
-- (not yet created — create after attorney approval)

-- Step 2: Apply RLS policies
-- Deny-by-default on intake_workflows_v1
-- Service-role writes only for transitions
-- Artist reads own workflow via artist_id match

-- Step 3: Reload schema
NOTIFY pgrst, 'reload schema';
```

### Storage
- [ ] Confirm `artist-documents` bucket is private (no public access policy)
- [ ] Test signed URL generation and expiry (5-minute TTL)
- [ ] Test that public URL pattern (`/storage/v1/object/public/`) is rejected by `isPublicUrl()`

### n8n Reminder Workflows
Wire the following message types to n8n webhook triggers:
- `IDENTITY_REMINDER` → 3-day cadence, max 3
- `ENGAGEMENT_REMINDER` → 3-day cadence, max 3
- `LOA_REMINDER` → 3-day cadence, max 3
- `MISSING_DOCUMENT_REMINDER` → 7-day cadence, max 4
- `INACTIVITY_WARNING` → 14-day cadence, max 2

Use `shouldSendReminder()` from `lib/intake-comms.js` as the gating function before each send.

---

## Environment Variables Required

| Variable | Description |
|----------|-------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Existing — used for all schema writes |
| `SUPABASE_URL` | Existing |
| `RESEND_API_KEY` | Existing |
| `ADMIN_API_KEY` | Existing |
| `ESIGN_PROVIDER` | New — set to vendor name when approved; `MOCK` for test only |
| `ESIGN_WEBHOOK_SECRET` | New — vendor-provided; never hardcode |

**Do not hardcode any of these.** Use Vercel's encrypted environment variable storage.

---

## Smoke Test After Deployment

1. `GET /api/version` → confirm deployment SHA
2. Create a test intake workflow in a staging environment (not production)
3. Run through states INVITED → IDENTITY_PENDING → IDENTITY_CONFIRMED using mock data
4. Verify transition records are written to `intake_transitions_v1`
5. Upload a test PDF — verify hash computed, vault record written, no sensitive data in logs
6. Verify signed URL expires after 5 minutes
7. Confirm `isPublicUrl()` blocks public URL patterns in responses
8. Run `npm test` in the staging environment

---

## Rollback Plan

If a production deployment introduces issues:
1. Revert the Vercel deployment to the prior SHA via Vercel dashboard or `vercel rollback`
2. Do not rollback database migrations without operator review
3. File incident report per existing Sentry/Incident_Report workflow
