# Automated Artist Rights Intake — Architecture

**Status:** Implementation complete (Phase 1–16)  
**Stack:** Vercel serverless, Supabase/Postgres, Resend, n8n  
**All engagement and authorization language is DRAFT — attorney review required before production activation**

---

## System Overview

The Automated Artist Rights Intake system is a deterministic, multi-phase workflow that collects the evidence required for a MusiGod neighboring-rights recovery audit. It replaces manual email chasing with a structured, consent-driven pipeline that preserves evidence provenance and enforces authorization boundaries at every step.

The system is designed as a set of pure, side-effect-free library modules. All persistence and network calls are isolated in the calling layer (Vercel API routes). This makes every business rule independently testable without credentials or database access.

---

## Architecture Diagram

```
Artist Invitation
       ↓
lib/intake-state-machine.js   ← deterministic 20-state machine; no DB writes
       ↓
lib/artist-identity.js        ← identity + authority questionnaire; no SSN/EIN/passwords
       ↓
lib/esign-adapter.js          ← mock e-sign provider; hooks for real vendor when approved
       ↓
lib/export-center.js          ← config-driven guided export checklists per document type
       ↓
lib/document-vault.js         ← SHA-256 hashing, type validation, duplicate detection, quarantine
       ↓
lib/sensitive-data-detector.js ← SSN/EIN/bank/card/password pattern scan; values never logged
       ↓
lib/document-classifier.js    ← filename + header heuristics; AI proposals advisory only
       ↓
lib/completeness-engine.js    ← mandatory vs optional; AUDIT_READY gate
       ↓
lib/intake-comms.js           ← Resend + n8n; cadence/limits/timezone; no sensitive data in email
       ↓
lib/audit-handoff.js          ← immutable manifest; document references + hashes; dryRun guard
       ↓
lib/neighboring-rights-audit.js ← existing audit pipeline (CSV import path)
```

---

## Libraries Created

| File | Purpose | Side Effects |
|------|---------|--------------|
| `lib/intake-state-machine.js` | 20-state deterministic workflow FSM; 50+ legal transitions | None |
| `lib/artist-identity.js` | Identity questionnaire schema + validator; prohibition list | None |
| `lib/esign-adapter.js` | Provider-neutral e-sign adapter; mock provider only | In-memory mock store only |
| `lib/export-center.js` | Config-driven per-document export guides | None |
| `lib/document-vault.js` | File validation, hashing, signed URL enforcement | None (callers write to Supabase) |
| `lib/sensitive-data-detector.js` | Pattern-based sensitive data scan; values never logged | None |
| `lib/document-classifier.js` | Filename + header heuristics + AI proposal interface | None |
| `lib/completeness-engine.js` | Mandatory/optional checklist; AUDIT_READY gate | None |
| `lib/intake-comms.js` | Versioned message records; cadence enforcement; guards | None (callers call Resend/n8n) |
| `lib/audit-handoff.js` | Immutable manifest generation; dryRun guard | None |
| `lib/intake-config.js` | Pilot and commercial configuration | None |

---

## Database Schema (Proposed — Not Yet Applied)

The following tables are proposed for the `registrations` schema. They reuse the existing schema, RLS, and service-role pattern from `signed_agreements_v1`, `artist_documents_v1`, and `recovery_engagements_v1`.

### `intake_workflows_v1`
One row per artist intake engagement.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| artist_id | UUID | FK → artists table |
| artist_email | TEXT | |
| engagement_id | UUID | FK → recovery_engagements_v1 |
| current_state | TEXT | 20-state enum |
| pilot_id | TEXT | e.g. "pilot-001" |
| commercial_tier | TEXT | "individual" or "enterprise" |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### `intake_transitions_v1`
Append-only audit of every state transition.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| workflow_id | UUID | FK → intake_workflows_v1 |
| actor | TEXT | |
| timestamp | TIMESTAMPTZ | |
| prior_state | TEXT | |
| new_state | TEXT | |
| trigger | TEXT | |
| evidence_ref | TEXT | nullable |
| auth_scope | TEXT | nullable |
| correlation_id | TEXT | |
| reason | TEXT | |

### `intake_item_statuses_v1`
One row per (workflow_id, item_id). Tracks completeness items.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| workflow_id | UUID | FK |
| item_id | TEXT | e.g. "master_ownership" |
| status | TEXT | ITEM_STATUS enum |
| document_ids | JSONB | array of document IDs |
| notes | TEXT | |
| updated_at | TIMESTAMPTZ | |

### `intake_manifests_v1`
One row per completed audit handoff manifest. Immutable after creation.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK = manifest_id |
| workflow_id | UUID | FK |
| manifest_json | JSONB | full manifest (no document content) |
| frozen_at | TIMESTAMPTZ | |
| dry_run | BOOLEAN | |

---

## Existing Infrastructure Reused

- `registrations` schema: `signed_agreements_v1`, `agreement_versions_v1`, `artist_documents_v1`, `recovery_engagements_v1`, `admin_queues_v1`
- RPCs: `fn_complete_authorization_onboarding_v1`, `fn_log_artist_activity_v1`, `fn_create_admin_queue_task_v1`, `fn_create_recovery_engagement_v1`
- Storage: `artist-documents` bucket (must be confirmed private)
- Email: Resend via `RESEND_API_KEY` (matching `register-artist.js` pattern)
- n8n: `musigod-n8n.onrender.com` webhook integration (matching existing webhooks)
- Sentry: `_sentry.js` pattern for error capture
- Admin authentication: `ADMIN_API_KEY` header pattern

---

## Security Architecture

See `ARTIST_DOCUMENT_SECURITY_POLICY.md` for full detail.

Key invariants enforced in code:

1. **No sensitive data in email** — `buildMessageRecord()` throws if signed URLs or sensitive keys appear
2. **No public document URLs** — `isPublicUrl()` detects `/storage/v1/object/public/` paths
3. **Signed URLs expire in 300 seconds** — `SIGNED_URL_TTL_SECONDS` constant
4. **Sensitive data values never logged** — `scanText()` redacts detected values before returning
5. **Statement data stays on CSV path** — separate from SoundExchange adapter API
6. **dryRun guard on manifest** — `createManifest()` throws unless `dryRun: true`
7. **LOA prohibited scopes** — `validateLOAScope()` rejects rights_assignment, copyright_transfer, etc.
8. **Production e-sign blocked** — `legal_review_required: true`, `production_blocked: true` on all envelopes

---

## Deployment Blockers (Not Yet Resolved)

1. **Attorney review of engagement agreement and LOA** — all legal language is marked DRAFT
2. **E-sign vendor selection** — mock provider only; no paid vendor activated
3. **Database migration** — proposed tables above not yet applied
4. **Storage bucket privacy confirmation** — `artist-documents` bucket must be confirmed private
5. **n8n workflow configuration** — reminder workflow nodes need to be wired
6. **`SOUNDEXCHANGE_API_ENABLED`** — remains `false` (feature-flagged; no official API access yet)

See `ARTIST_INTAKE_DEPLOYMENT_RUNBOOK.md` for the full pre-production checklist.
