# Artist Intake Operator Guide

**Audience:** MusiGod operators managing artist onboarding and document review  
**Implementation:** `lib/intake-state-machine.js`, `lib/completeness-engine.js`, `lib/document-vault.js`

---

## Workflow Overview

1. **Invite artist** → state transitions to `INVITED`
2. **Artist completes identity questionnaire** → `IDENTITY_CONFIRMED`
3. **Send engagement agreement** → `ENGAGEMENT_SENT`
4. **Agreement signed** → `ENGAGEMENT_SIGNED` (webhook from e-sign provider)
5. **Send LOA** → `LOA_SENT`
6. **LOA signed** → `LOA_SIGNED` (webhook)
7. **Direct artist to export center** → `EXPORT_GUIDANCE_PENDING`
8. **Artist uploads documents** → `DOCUMENTS_PARTIAL` (multiple transitions allowed)
9. **Operator marks documents complete** → `DOCUMENTS_COMPLETE` → `DOCUMENTS_VALIDATING`
10. **Validate documents** → `OWNERSHIP_REVIEW` or `AUTHORIZATION_REVIEW` or `AUDIT_READY`
11. **All mandatory items VALID** → `AUDIT_READY`
12. **Generate audit manifest (dryRun)** → `AUDIT_IN_PROGRESS`
13. **Audit completes** → `CLOSED`

---

## State Transitions (Operator-Initiated)

| From | To | Trigger | When to use |
|------|----|---------|-------------|
| `DOCUMENTS_VALIDATING` | `OWNERSHIP_REVIEW` | `ownership_evidence_requires_review` | Master ownership docs are ambiguous or contested |
| `DOCUMENTS_VALIDATING` | `AUTHORIZATION_REVIEW` | `loa_scope_requires_review` | LOA scope needs legal verification |
| `DOCUMENTS_VALIDATING` | `DOCUMENTS_NEED_CORRECTION` | `document_validation_failed` | Documents failed technical validation |
| `OWNERSHIP_REVIEW` | `AUDIT_READY` | `ownership_confirmed` | Ownership evidence accepted |
| `AUTHORIZATION_REVIEW` | `AUDIT_READY` | `authorization_confirmed` | LOA scope confirmed |
| `AUDIT_READY` | `AUDIT_IN_PROGRESS` | `audit_started` | Begin neighboring-rights audit |
| `AUDIT_IN_PROGRESS` | `CLOSED` | `audit_complete` | Audit finished |
| Any | `WITHDRAWN` | `artist_withdrew` or `operator_closed` | Artist withdrew or engagement expired |

---

## Document Validation Checklist

For each received document:

- [ ] File type is allowed (PDF, CSV, XLSX)
- [ ] File size within 10 MB limit
- [ ] MIME type matches extension
- [ ] SHA-256 hash computed and stored
- [ ] Duplicate hash check passed (no exact copy already on file)
- [ ] Sensitive-data scan completed (categories, not values)
- [ ] Document classified (provider, type, statement period)
- [ ] Statement period is complete (all expected years present)
- [ ] Document is not quarantined

---

## Completeness Engine — Mandatory Item Review

All 7 mandatory items must reach `VALID` status before the intake can transition to `AUDIT_READY`:

| Item | What "VALID" requires |
|------|-----------------------|
| `identity_confirmed` | Identity questionnaire accepted with both attestations |
| `engagement_signed` | Engagement agreement envelope status COMPLETED |
| `loa_signed` | LOA envelope status COMPLETED; scope validated |
| `soundexchange_catalog` | Valid catalog CSV/XLSX received and classified |
| `soundexchange_payments` | Payment statements for all requested years |
| `featured_performer_declaration` | Featured-performer identity confirmed in writing |
| `master_ownership` | Ownership documentation accepted by operator |

---

## Sensitive Data Quarantine Handling

If a document is quarantined for sensitive data:

1. Do NOT access or log the document content.
2. Set item status to `RECEIVED` (not `VALID`) — the item remains a blocker.
3. Notify artist via `REJECTED_DOCUMENT_REQUEST` message.
4. Request replacement file with sensitive fields redacted.
5. Upon receiving replacement, re-run validation pipeline.
6. Schedule original quarantined file for secure deletion per retention policy.

**Never display the detected sensitive value** — the scan result shows only category and page/row reference.

---

## Admin Dashboard Signals

| Signal | Action |
|--------|--------|
| Intake stalled in `IDENTITY_PENDING` > 7 days | Send `IDENTITY_REMINDER` |
| Intake stalled in `ENGAGEMENT_SENT` > 3 days | Send `ENGAGEMENT_REMINDER` |
| Intake stalled in `LOA_SENT` > 3 days | Send `LOA_REMINDER` |
| Documents in quarantine | Human review — do not auto-approve |
| Ownership conflict in `OWNERSHIP_REVIEW` | Escalate to legal review |
| `mandatory_awaiting_review > 0` | Cannot advance to AUDIT_READY — resolve first |
| `AUDIT_READY` state reached | Confirm with artist; proceed to audit pipeline |

---

## Security Reminders for Operators

- **Never request artist portal passwords** — only ask artists to export files themselves.
- **Never share signed document URLs in email** — use authenticated portal links only.
- **Never log document content** — only document IDs, categories, and hashes.
- **Admin metadata access does not grant document-body access** — respect the least-privilege boundary.
- **Do not modify production data directly** — all intake actions go through the workflow state machine.
- **Legal review is required before any engagement language is used with a real client** — all e-sign templates are currently DRAFT.

---

## Escalation Paths

| Issue | Escalation |
|-------|-----------|
| Contested master ownership | Legal review + evidence gathering |
| LOA scope dispute | Attorney review |
| Sensitive data detected | Privacy officer + retention policy |
| Possible ownership conflict | Legal review before proceeding |
| Artist unresponsive > 30 days | Move to `CLIENT_ACTION_REQUIRED`; send `INACTIVITY_WARNING` |
