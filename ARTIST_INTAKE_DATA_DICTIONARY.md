# Artist Intake Data Dictionary

**Version:** intake-data-dictionary-v1  
**Scope:** All data fields collected, stored, or processed during the artist intake workflow

---

## Identity Fields (`lib/artist-identity.js`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `legal_first_name` | text | Yes | Legal first name as it appears on government-issued ID |
| `legal_last_name` | text | Yes | Legal last name |
| `professional_name` | text | Yes | Stage name or professional name under which recordings were released |
| `aliases` | text[] | No | Historical aliases, spelling variants, and former stage names |
| `group_affiliations` | text[] | No | Groups, bands, or featured-artist projects |
| `business_entities` | text[] | No | LLCs, corporations, or other entities that may hold master rights |
| `pro_affiliations` | enum[] | No | PRO memberships (ASCAP, BMI, SESAC, GMR, PRS, SOCAN, APRA_AMCOS, STIM, GEMA, SACEM, OTHER, NONE) |
| `soundexchange_member` | boolean\|"UNKNOWN" | Yes | Whether the artist is a registered SoundExchange member |
| `performer_roles` | enum[] | Yes | Roles on recordings: FEATURED_PERFORMER, NON_FEATURED_PERFORMER, FEATURED_ON_SOME, BACKGROUND_VOCALIST, SESSION_MUSICIAN, PRODUCER, BAND_MEMBER, SOLO_ARTIST, OTHER |
| `submission_context` | enum | Yes | INDIVIDUAL, ENTITY, GROUP, or REPRESENTATIVE |
| `representative_name` | text | Conditional | Required when submission_context=REPRESENTATIVE |
| `representative_role` | text | Conditional | Required when submission_context=REPRESENTATIVE |
| `representative_evidence_ref` | text | Recommended | Reference to authorization evidence document |
| `attestation_accurate` | boolean | Yes | Must be explicitly `true` — not a truthy value |
| `attestation_authorized` | boolean | Yes | Must be explicitly `true` — not a truthy value |

**Prohibited fields (never collected):** ssn, ein, tax_id, routing_number, account_number, card_number, password, recovery_code, portal_credential

---

## Envelope Fields (`lib/esign-adapter.js`)

| Field | Type | Description |
|-------|------|-------------|
| `envelope_id` | text | Unique identifier for the e-signature envelope |
| `provider` | enum | MOCK (only active provider) |
| `document_type` | enum | ENGAGEMENT_AGREEMENT or LOA |
| `document_version` | text | Version of the agreement template |
| `document_hash` | text | SHA-256 hash of the document content |
| `artist_id` | UUID | Bound artist |
| `signer_email` | text | Email address of the authorized signer |
| `status` | enum | CREATED, SENT, DELIVERED, SIGNED, COMPLETED, DECLINED, VOIDED, EXPIRED |
| `correlation_id` | text | Tracing ID |
| `signed_at` | ISO timestamp | Populated when status=COMPLETED |
| `completion_certificate` | object | Includes certificate_id, signer_email, signer_name, document_hash, signed_at |
| `legal_review_required` | boolean | Always `true` until attorney approves language |
| `production_blocked` | boolean | Always `true` until legal_review_required is cleared |

---

## Document Vault Fields (`lib/document-vault.js`)

| Field | Type | Description |
|-------|------|-------------|
| `document_id` | UUID | Unique document identifier |
| `artist_id` | UUID | Owning artist |
| `artist_email` | text | Artist email (not exposed in manifests) |
| `engagement_id` | UUID | Linked engagement |
| `document_type` | text | From existing document-type allowlist |
| `original_name` | text | Original filename |
| `mime_type` | text | MIME type |
| `size_bytes` | integer | File size |
| `sha256_hash` | text | SHA-256 content hash for deduplication and integrity |
| `storage_path` | text | Internal storage path — not exposed in manifests |
| `bucket` | text | Always `artist-documents` (private) |
| `document_category` | text | Classification category |
| `reporting_period` | text | Optional statement period |
| `quarantined` | boolean | Whether the document is in quarantine |
| `quarantine_reason` | text | QUARANTINE_REASON code if quarantined |
| `retention_status` | text | ACTIVE, EXPIRED, LEGAL_HOLD |
| `legal_hold` | boolean | |
| `uploaded_at` | ISO timestamp | |
| `access_log` | array | {actor, action, timestamp} entries |

---

## Completeness Item IDs (`lib/completeness-engine.js`)

### Mandatory
| Item ID | Label |
|---------|-------|
| `identity_confirmed` | Artist identity and authority questionnaire |
| `engagement_signed` | Engagement agreement signed |
| `loa_signed` | Limited Letter of Authorization signed |
| `soundexchange_catalog` | SoundExchange associated recordings export |
| `soundexchange_payments` | SoundExchange payment statements |
| `featured_performer_declaration` | Featured-performer identity confirmed |
| `master_ownership` | Master ownership or exclusive license evidence |

### Optional
| Item ID | Label |
|---------|-------|
| `soundexchange_search_and_claim` | SoundExchange search-and-claim / unclaimed export |
| `soundexchange_adjustments` | SoundExchange adjustment and reversal records |
| `distributor_statements` | Distributor statements |
| `label_statements` | Label statements |
| `ppl_statements` | PPL and international CMO statements |
| `international_mandates` | Existing international collection mandates |

### Item Status Values
`REQUIRED`, `RECEIVED`, `VALID`, `REJECTED`, `MISSING`, `OPTIONAL`, `NOT_APPLICABLE`, `CLIENT_DECLINED`, `UNABLE_TO_OBTAIN`, `THIRD_PARTY_REQUIRED`, `AWAITING_REVIEW`

---

## Message Types (`lib/intake-comms.js`)

| Message Type | Default Max Reminders | Interval |
|-------------|----------------------|----------|
| INVITATION | 1 | once |
| IDENTITY_REMINDER | 3 | 3 days |
| ENGAGEMENT_REMINDER | 3 | 3 days |
| LOA_REMINDER | 3 | 3 days |
| MISSING_DOCUMENT_REMINDER | 4 | 7 days |
| REJECTED_DOCUMENT_REQUEST | 3 | 3 days |
| MISSING_PERIOD_REMINDER | 2 | 7 days |
| AUDIT_READY_CONFIRMATION | 1 | once |
| CLIENT_ACTION_REQUIRED | 3 | 5 days |
| INACTIVITY_WARNING | 2 | 14 days |
| WITHDRAWAL_CONFIRMATION | 1 | once |
| EXPIRATION_NOTICE | 1 | once |

---

## Audit Manifest Fields (`lib/audit-handoff.js`)

| Field | Type | Description |
|-------|------|-------------|
| `manifest_id` | text | Unique manifest identifier |
| `engagement_id` | UUID | |
| `artist_id` | UUID | |
| `artist_email_hash` | text | SHA-256 of lowercased email — plain email excluded |
| `intake_state_at_handoff` | text | Must be "AUDIT_READY" |
| `frozen_at` | ISO timestamp | |
| `dry_run` | boolean | Always `true` in current implementation |
| `document_count` | integer | |
| `documents` | array | {document_id, document_type, sha256_hash, document_category, reporting_period, quarantined, uploaded_at} |
| `envelope_ids` | text[] | Signed envelope IDs |
| `completeness` | object | Completeness summary excluding raw data |
| `identity_confirmed` | boolean | |
| `catalog_baseline` | object | {total_tracks, tracks_with_isrc, tracks_missing_isrc, tracks_missing_writers} |
| `statement_data_path` | text | "CSV import only — private statement data never routes through SoundExchange adapter API" |
| `immutable` | boolean | Always `true` |

---

## Interest Separation (Neighboring Rights)

As defined in `lib/neighboring-rights-audit.js`:

| Interest Type | Description |
|---------------|-------------|
| `featured_performer_gross` | Sound recording royalties attributed to featured performers |
| `rightsholder_gross` | Master rightsholder share |
| `non_featured_gross` | Non-featured performer / session musician share (held separately by SoundExchange) |
| `other_gross` | All other interest categories |

These must never be combined in financial reporting.
