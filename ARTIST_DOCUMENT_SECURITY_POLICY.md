# Artist Document Security Policy

**Applies to:** All artist documents uploaded through MusiGod  
**Implementation:** `lib/document-vault.js`, `lib/sensitive-data-detector.js`  
**Effective:** 2026-07-30 (subject to attorney review)  
**Status:** DRAFT — requires legal review before client-facing use

---

## Storage

- All artist documents are stored in the **private** `artist-documents` Supabase Storage bucket.
- Documents are never accessible from a predictable public URL.
- The `/storage/v1/object/public/` path pattern is explicitly detected and blocked.
- Upload and download access requires a **short-lived signed URL** (5-minute TTL).
- Signed URLs are never included in email messages or API responses.

## File Validation

**Allowed formats:** PDF, CSV, XLSX, XLS, PNG, JPG/JPEG  
**Maximum file size:** 10 MB  
**Blocked MIME types:** text/html, application/javascript, application/x-sh, application/x-bat, application/x-msdownload, and all executable content  

Every upload is validated for:
1. MIME type against the allowed list
2. File extension against the allowed list
3. MIME type / extension consistency (file-type spoofing detection)
4. File size within the 10 MB limit
5. SHA-256 content hash (duplicate detection)
6. Sensitive-data pattern scan

Files that fail any check are **quarantined** — not rejected — with a reason code. Quarantined files are retained until the artist provides a corrected version, then securely deleted according to retention policy.

## Sensitive Data Detection

Before any document enters the audit pipeline, it is scanned for:

| Category | Example pattern | Severity |
|----------|----------------|----------|
| Social Security Number | `123-45-6789` | CRITICAL |
| EIN / Tax ID | `12-3456789` | CRITICAL |
| Bank account number | `account number: 123456789` | CRITICAL |
| Routing number | `routing: 021000021` | CRITICAL |
| Payment card number | 15-16 digit card formats | CRITICAL |
| Password label | `password: xxx` | CRITICAL |
| Recovery / 2FA code | `recovery code: xxx` | HIGH |
| Tax form reference | `1099`, `W-9`, `W-8` | HIGH |
| Portal credential label | `username: xxx` | HIGH |

**Detected values are NEVER logged.** Only the category, document ID, and page/row reference are recorded. Artists are asked to replace the file with a redacted export.

## Access Control

- Documents are bound to a specific `artist_id` and `engagement_id` at upload time.
- Operators can access queue metadata without gaining access to document content.
- Every document access is appended to an `access_log` on the vault record.
- Cross-artist access is prevented by artist_id scoping at the application layer and by RLS at the database layer.

## Retention and Deletion

- Default retention status: `ACTIVE`
- Documents may be placed in `LEGAL_HOLD` status, which blocks deletion.
- Quarantined documents containing CRITICAL sensitive data are scheduled for secure deletion after the artist provides a corrected replacement.
- MusiGod does not retain statement data beyond the scope of the engagement without client re-authorization.

## What MusiGod Does NOT Do

- Does not request portal passwords, SSNs, EINs, routing numbers, account numbers, or card numbers through any intake form, email, or upload.
- Does not expose documents via public URLs.
- Does not include signed storage URLs in email.
- Does not aggregate or pool private statement data across artist clients.
- Does not retain document content beyond the engagement scope without re-authorization.

## Incident Response

If a document is inadvertently uploaded containing sensitive data that was not detected by the automated scan:

1. Operator places the document in LEGAL_HOLD and restricts access.
2. Artist is notified that the document was received but cannot be processed.
3. Artist is asked to provide a redacted replacement.
4. Original document is deleted according to retention policy after replacement is accepted.
5. Incident is logged with document ID, category, and remediation steps — never the detected value.
