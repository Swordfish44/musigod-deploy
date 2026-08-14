# MusiGod Artist Rights Intake — Attorney Review Packet

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  DRAFT — NOT FOR CLIENT USE                                                  ║
║  All language in this document is preliminary and has not been reviewed      ║
║  or approved by counsel. No provision herein creates any legal obligation    ║
║  or constitutes legal advice. No clause should be presented to, signed by,  ║
║  or relied upon by any artist or third party until attorney review is        ║
║  complete and written approval is recorded in                                ║
║  ARTIST_INTAKE_LEGAL_REVIEW_CHECKLIST.md.                                   ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

**Prepared for:** Attorney review  
**Prepared by:** MusiGod (engineering and operations)  
**Packet version:** attorney-review-v1  
**Date prepared:** 2026-07-30  
**Production status:** All e-sign activation, billing, and client outreach are blocked pending attorney approval

---

## Table of Contents

1. [System Description for Counsel](#1-system-description-for-counsel)
2. [Data-Flow Summary](#2-data-flow-summary)
3. [Draft Engagement Agreement](#3-draft-engagement-agreement)
4. [Draft Limited Letter of Authorization (LOA)](#4-draft-limited-letter-of-authorization)
5. [Privacy and Data-Handling Disclosures](#5-privacy-and-data-handling-disclosures)
6. [Contingent-Recovery Fee Terms](#6-contingent-recovery-fee-terms)
7. [Prohibited Authority Schedule](#7-prohibited-authority-schedule)
8. [Revocation Procedure](#8-revocation-procedure)
9. [Document-Retention Policy](#9-document-retention-policy)
10. [Unresolved Legal Decisions](#10-unresolved-legal-decisions)
11. [Attorney Sign-Off Table](#11-attorney-sign-off-table)

---

## 1. System Description for Counsel

### What MusiGod Is

MusiGod is a publishing-administration and neighboring-rights catalog-audit platform for independent artists. Its Neighboring Rights Recovery Audit product identifies gaps in an artist's sound-recording performance royalty collection — principally through SoundExchange (U.S. digital performance) and international collection organizations such as PPL (UK) and GVL (Germany) — and, where evidence supports it, assists the artist in authorized recovery.

MusiGod's fee model is: a fixed audit/setup fee (amount set per engagement; not yet determined), plus a contingency fee of **15% of amounts actually recovered** through documented MusiGod work. Royalties already being paid correctly before the engagement begins are explicitly excluded from the contingency calculation.

**MusiGod is not a performing rights organization, a collection management organization, or an agent for any third party.** It does not hold or disburse royalties. It does not register works or sound recordings on behalf of artists without separate explicit authorization. It does not submit claims to SoundExchange, PPL, or any CMO on an artist's behalf without a separate, specifically authorized action — that authorization is not granted by the engagement agreement or the LOA alone.

### What the Automated Intake System Does

The Automated Artist Rights Intake system is a software workflow that collects, validates, and organizes the evidence needed before a neighboring-rights audit can begin. It does not conduct the audit. It does not submit claims. It does not modify any artist's account at any collection organization.

The intake system does the following:

1. **Sends a structured invitation** to a prospective artist client.
2. **Collects an identity and authority questionnaire** — legal name, stage name, aliases, performer role, business entities, PRO affiliations, SoundExchange membership status, and submission context (individual, entity, group, or authorized representative). Does **not** collect SSN, EIN, routing numbers, account numbers, payment card numbers, passwords, recovery codes, or portal credentials. (Nine field types are prohibited in code: `ssn`, `ein`, `tax_id`, `routing_number`, `account_number`, `card_number`, `password`, `recovery_code`, `portal_credential`. See `lib/artist-identity.js` → `PROHIBITED_FIELDS`.)
3. **Presents and collects e-signatures** on the engagement agreement and a Limited Letter of Authorization, using a provider-neutral e-signature adapter. No paid vendor is currently activated; mock provider only.
4. **Guides the artist through a document export process** via a guided checklist. The artist logs into their own SoundExchange Direct account, distributor portal, and any other relevant portals, exports their own data as files, and uploads those files to MusiGod through a secure upload interface. MusiGod does not log into any portal on the artist's behalf.
5. **Validates and classifies uploaded documents** — file type, size, content hash, duplicate detection, sensitive-data scan (SSN/EIN/bank/password patterns), and document classification (provider, type, period, ISRC coverage).
6. **Tracks intake completeness** against a mandatory checklist of seven items. No audit can begin until all seven mandatory items are marked VALID.
7. **Generates an immutable audit handoff manifest** when the checklist is complete. The manifest references document IDs and content hashes — it does not copy document content. The manifest is marked `dry_run: true` until human review is complete; no production action follows automatically.
8. **Sends automated reminders** via email when required items are missing or overdue. Reminders stop automatically when the requirement is satisfied. Reminders never contain signed document URLs, document content, or sensitive data.

### The Seven Mandatory Intake Items

The system will not advance an engagement to `AUDIT_READY` until all of the following are `VALID`:

| # | Item | What "VALID" requires |
|---|------|-----------------------|
| 1 | Artist identity and authority questionnaire | Questionnaire submitted with both explicit attestations marked `true` |
| 2 | Engagement agreement signed | E-signature envelope marked COMPLETED by the correct signer |
| 3 | Limited Letter of Authorization signed | LOA envelope COMPLETED; scope validated against prohibited list |
| 4 | SoundExchange associated recordings export | Valid catalog CSV/XLSX received and classified |
| 5 | SoundExchange payment statements (all available years) | Payment statement files received for all requested years |
| 6 | Featured-performer identity confirmed | Artist's featured-performer role confirmed in writing |
| 7 | Master ownership or exclusive license evidence | Ownership documentation accepted by a MusiGod operator |

### What the System Does Not Do

- Does not log into any artist portal, CMO portal, or distributor portal.
- Does not submit claims, registrations, mandates, disputes, or payment-instruction changes.
- Does not infer master ownership from artist identity, distributor identity, or possession of audio files.
- Does not treat a SoundExchange repertoire match as proof of ownership, registration, or payment entitlement.
- Does not pool or aggregate private statement data across artist clients.
- Does not expose artist documents through publicly accessible URLs.
- Does not send private financial documents or signed URLs through email.
- Does not activate billing or legal terms without attorney approval (enforced in code: `billing_activation_blocked: true`).

---

## 2. Data-Flow Summary

Counsel should understand exactly what data flows where in this system.

### Data MusiGod Collects from the Artist

| Category | Specific fields | Storage |
|----------|----------------|---------|
| Identity | Legal name, stage name, aliases, submission context, performer roles, PRO affiliations, SoundExchange membership status | Supabase (Postgres, `registrations` schema), AWS `us-east-1` (Supabase default) |
| Authority | Representative name/role (if applicable), attestation timestamps, e-signature completion certificates | Supabase Postgres |
| Documents | SoundExchange catalog exports, payment statements, distributor statements, master ownership evidence | Supabase Storage (private bucket `artist-documents`), AWS S3 |
| Document metadata | Original filename, MIME type, file size, SHA-256 hash, classification, quarantine status | Supabase Postgres |

### Data MusiGod Never Collects

SSN, EIN, routing numbers, bank account numbers, payment card numbers, portal passwords, recovery codes, 2FA codes, or any tax form containing unredacted personal identifiers. These are explicitly prohibited in the identity questionnaire schema and detected/quarantined if inadvertently included in uploaded documents. Detected values are never logged — only the category and document reference are recorded.

### Data Flows — Technical Path

```
Artist browser
  → Vercel serverless API (HTTPS TLS 1.2+)
    → Supabase/Postgres (registrations schema) — identity, transitions, item statuses
    → Supabase Storage (artist-documents bucket, private) — document files
    → Resend — outbound email only; no sensitive data in email
    → n8n (musigod-n8n.onrender.com) — reminder workflow triggers
    → Sentry — error capture; no PII in error payloads

SoundExchange adapter: feature-flagged OFF; zero API calls to SoundExchange
Statement data: stays on CSV import path; never routes through SoundExchange API
```

### Third-Party Sub-Processors

| Service | Role | Data received | Privacy agreement reference |
|---------|------|---------------|----------------------------|
| Supabase (Supabase Inc.) | Database + file storage | All stored data | Supabase DPA (AWS us-east-1) |
| Vercel Inc. | Compute (serverless functions) | Request/response data | Vercel DPA |
| Resend | Transactional email | To address, subject, body (no documents, no signed URLs) | Resend ToS/DPA |
| n8n (self-hosted on Render) | Workflow automation for reminders | Webhook payloads (artist ID, message type, engagement ID) | Render ToS |
| Sentry | Error monitoring | Stack traces, function context (no PII policy enforced) | Sentry DPA |

**Counsel should confirm:** Whether the current set of sub-processors and their data-processing agreements satisfy applicable privacy law, including CCPA (California) and any other state or international privacy frameworks applicable to MusiGod's client base.

### Document Access Controls

- All documents stored in a private Supabase Storage bucket. Public access is disabled.
- Documents are accessed only via short-lived signed URLs (5-minute expiry) generated server-side. Signed URLs are never included in email — `buildMessageRecord()` in `lib/intake-comms.js` throws an error if a `portalUrl` parameter contains a storage token or `/storage/v1/object` path (code-enforced). Excluding signed URLs from other API response bodies is a system design policy: the audit manifest explicitly omits `storage_path` from document entries, and vault records expose paths, not pre-signed URLs. There is no dedicated runtime response-layer check on arbitrary API routes; operator code discipline is required for those paths.
- Each document record is bound to a specific `artist_id` and `engagement_id`. Cross-artist access is prevented at both the application and database (RLS) layers.
- Every document access is appended to an audit log (`access_log`) on the vault record.
- MusiGod operators can view queue metadata (document type, hash, status) without accessing document content directly.

---

## 3. Draft Engagement Agreement

```
DRAFT — NOT FOR CLIENT USE
This draft has not been reviewed by counsel. It may contain errors,
omissions, unenforceable provisions, or language that is inappropriate
for MusiGod's jurisdiction, client base, or business model.
Do not present to any artist or other party.
```

---

### MUSIGOD NEIGHBORING RIGHTS AUDIT ENGAGEMENT AGREEMENT

**[DRAFT v0.1 — ATTORNEY REVIEW REQUIRED]**

This Neighboring Rights Audit Engagement Agreement ("Agreement") is entered into as of the date of electronic signature ("Effective Date") between:

**MusiGod** (a [ENTITY TYPE AND STATE OF FORMATION TO BE CONFIRMED BY COUNSEL] — "MusiGod"), and

**Artist** (the individual or entity named in the signature block — "Artist").

---

**SECTION 1 — SCOPE OF SERVICES**

1.1 **Audit Services.** MusiGod agrees to conduct a Neighboring Rights Recovery Audit for the Artist's catalog of sound recordings ("Catalog"). The Audit includes:

   (a) Identification of sound recordings in the Catalog for which neighboring-rights royalties may be uncollected, underpaid, or unclaimed with SoundExchange (U.S.) and, subject to Artist authorization, with international collection management organizations ("CMOs");

   (b) Comparison of the Artist's catalog against available SoundExchange registration and payment data provided by the Artist;

   (c) Identification of recordings lacking valid International Standard Recording Codes ("ISRCs"), and, subject to separate agreement, assistance with ISRC remediation;

   (d) Identification of potential ownership, performer-identity, or mandate gaps that may prevent or reduce neighboring-rights collection;

   (e) Preparation of a written audit findings report summarizing identified gaps, supporting evidence, and recommended next steps.

1.2 **What Is Not Included.** Unless the parties execute a separate written amendment specifically authorizing the following, MusiGod's services under this Agreement do **not** include:

   (a) Submission of claims, registrations, mandates, or disputes to SoundExchange, PPL, GVL, ASCAP, BMI, SESAC, or any other performing rights organization or CMO;

   (b) Negotiation of settlements or payment plans with any organization;

   (c) Legal representation of the Artist in any proceeding;

   (d) Publishing administration, including registration of compositions with a performing rights organization;

   (e) Modification of the Artist's payment instructions or banking information at any CMO;

   (f) Transfer of rights or mandates to MusiGod or any third party.

1.3 **MusiGod Is Not Acting as Legal Counsel.** Nothing in this Agreement constitutes legal advice. The Artist is encouraged to seek independent legal counsel before executing this Agreement.

---

**SECTION 2 — ARTIST REPRESENTATIONS AND WARRANTIES**

2.1 The Artist represents and warrants that:

   (a) The Artist is the featured performer and/or master rightsholder of the recordings in the Catalog, or is an authorized representative of the entity that holds those rights, and has authority to enter into this Agreement;

   (b) The Artist has not entered into any exclusive mandate or exclusive administration agreement that would prohibit MusiGod from conducting the Audit or from taking any action specifically authorized under this Agreement;

   (c) The documents, exports, and information provided to MusiGod are, to the Artist's best knowledge, accurate, complete, and not altered or falsified;

   (d) The Artist will not provide MusiGod with portal login credentials, full Social Security Numbers, Employer Identification Numbers, bank account or routing numbers, payment card numbers, or recovery codes. The Artist understands that MusiGod will not request these and that submission of such data would be a material breach of this Agreement;

   (e) The Artist understands that MusiGod's matching of a recording to a SoundExchange or CMO record is not confirmation of ownership, registration status, or payment entitlement.

---

**SECTION 3 — FEES AND PAYMENT**

**[COUNSEL FLAG: Confirm fee structure, payment timing, escrow requirements, and contingency enforceability in applicable jurisdiction(s). Consider whether this constitutes a "contingency fee" subject to state regulation in any jurisdiction where the Artist resides.]**

3.1 **Audit Fee.** The Artist agrees to pay MusiGod a non-refundable audit and setup fee of **[$AMOUNT — TO BE SET PER ENGAGEMENT]** upon execution of this Agreement ("Audit Fee"). [COUNSEL FLAG: Confirm whether this fee is refundable or partially refundable under applicable consumer protection law.]

3.2 **Contingent Recovery Fee.** In addition to the Audit Fee, the Artist agrees to pay MusiGod a contingent recovery fee of **fifteen percent (15%)** of "Recovered Amounts" (as defined in Section 3.3) ("Recovery Fee").

3.3 **Definition of Recovered Amounts.** "Recovered Amounts" means funds that:

   (a) Are actually received by the Artist (not merely identified, claimed, or promised); AND

   (b) Would not have been received by the Artist without MusiGod's documented involvement (i.e., MusiGod identified the gap, the Artist authorized the claim, and the claim was processed as a direct result of MusiGod's work); AND

   (c) Were not already being paid to the Artist correctly before the Effective Date of this Agreement.

   For the avoidance of doubt, Recovered Amounts **exclude**:

   (i) Royalties already flowing correctly to the Artist at the time of engagement, even if MusiGod later confirms their accuracy;

   (ii) Royalties that the Artist would have received through their own independent action or through an action initiated before this Agreement;

   (iii) Advance payments or estimates not yet confirmed by actual distribution.

3.4 **Credit of Audit Fee.** [OPTIONAL PROVISION — COUNSEL TO ADVISE WHETHER TO INCLUDE] If Recovered Amounts exceed [$THRESHOLD], the Audit Fee paid under Section 3.1 shall be credited against the Recovery Fee owed under Section 3.2.

3.5 **Per-Recording Remediation.** If the Artist requests ISRC remediation or individual recording remediation services, those services will be priced at **[$AMOUNT per recording — TO BE SET]** and invoiced separately.

3.6 **Payment of Recovery Fee.** The Recovery Fee becomes due within **[30/60] days** of the Artist's receipt of each Recovered Amount. MusiGod will provide an invoice identifying the relevant recordings, the distribution amount, and the calculated Recovery Fee.

3.7 **No Guarantee.** MusiGod does not guarantee that any royalties will be recovered. The Audit may determine that no gap exists, that the required evidence is unavailable, or that amounts are immaterial. The Audit Fee is earned on engagement, not on outcome.

---

**SECTION 4 — TERM AND TERMINATION**

**[COUNSEL FLAG: Confirm initial term length, auto-renewal provisions, and whether any state law imposes mandatory termination rights for personal services or contingency arrangements.]**

4.1 **Term.** This Agreement begins on the Effective Date and continues until the earlier of: (a) delivery of the final audit findings report; (b) mutual written agreement to close; or (c) termination pursuant to Section 4.2.

4.2 **Termination.** Either party may terminate this Agreement with **[30] days** written notice. Upon termination:

   (a) The Artist owes the Audit Fee for all services performed through the termination date;

   (b) The Recovery Fee remains payable for any Recovered Amounts received by the Artist within **[12] months** of termination, where MusiGod's work was a proximate cause of recovery;

   (c) MusiGod will return or delete the Artist's documents as directed by the Artist, subject to any legal hold obligations.

4.3 **Withdrawal.** The Artist may withdraw from the intake process at any time before the final audit findings report is delivered. MusiGod will acknowledge the withdrawal in writing and cease further processing.

---

**SECTION 5 — CONFIDENTIALITY**

5.1 MusiGod agrees to treat all Artist documents, financial data, and personally identifying information as confidential and to use them solely for the purpose of performing the Audit Services.

5.2 MusiGod will not disclose Artist confidential information to third parties except: (a) to MusiGod's employees, contractors, and sub-processors who need the information to perform the Services and are bound by equivalent confidentiality obligations; (b) as required by law; (c) with the Artist's written consent.

5.3 MusiGod's obligations under this Section survive termination of this Agreement for a period of **[3/5] years**.

**[COUNSEL FLAG: Confirm confidentiality term length, whether financial data is classified as confidential under applicable law, and whether mutual confidentiality is appropriate.]**

---

**SECTION 6 — DATA PROTECTION**

6.1 MusiGod will process the Artist's personal data in accordance with the Privacy Disclosure set forth in Section 5 of this Packet.

6.2 The Artist consents to MusiGod's processing of personal data as described in this Agreement and the Privacy Disclosure.

6.3 The Artist may request deletion, correction, or export of their personal data at any time by contacting [MUSIGOD CONTACT ADDRESS].

---

**SECTION 7 — LIMITATION OF LIABILITY**

**[COUNSEL FLAG: Review limitation of liability in light of applicable consumer protection law. Certain limitations may not be enforceable in all states. Confirm whether mutual limitation is appropriate or whether one-sided cap is standard for this service type.]**

7.1 **Cap on Liability.** MusiGod's total cumulative liability to the Artist for any and all claims arising under or related to this Agreement, regardless of cause of action or theory of recovery, will not exceed the Audit Fee paid by the Artist under Section 3.1.

7.2 **Exclusion of Consequential Damages.** Neither party will be liable for any indirect, incidental, consequential, special, or punitive damages arising out of or related to this Agreement, even if advised of the possibility of such damages.

7.3 **Exceptions.** The limitations in this Section do not apply to: (a) gross negligence or willful misconduct; (b) breach of confidentiality obligations; (c) indemnification obligations under Section 8.

---

**SECTION 8 — INDEMNIFICATION**

**[COUNSEL FLAG: Confirm scope of mutual indemnification. Consider whether Artist indemnification of MusiGod for third-party claims arising from Artist's misrepresentations is appropriate and enforceable.]**

8.1 **MusiGod Indemnification.** MusiGod will indemnify, defend, and hold harmless the Artist from third-party claims arising from MusiGod's gross negligence, willful misconduct, or unauthorized submission of any claim or registration on the Artist's behalf.

8.2 **Artist Indemnification.** The Artist will indemnify, defend, and hold harmless MusiGod from third-party claims arising from: (a) the Artist's misrepresentation of ownership, performer status, or authority; (b) the Artist's breach of any representation or warranty in Section 2; (c) documents provided by the Artist that contain inaccurate or falsified information.

---

**SECTION 9 — DISPUTE RESOLUTION**

**[COUNSEL FLAG: Confirm whether arbitration is appropriate and enforceable for consumer contracts in the Artist's likely jurisdiction(s). If arbitration is used, specify rules (AAA, JAMS, other), seat, and cost allocation. Consider whether small-claims carve-out is required or advisable. Do not include state-specific conclusions in this draft.]**

9.1 **Good-Faith Negotiation.** The parties agree to attempt in good faith to resolve any dispute arising under this Agreement within **[30] days** of written notice of the dispute.

9.2 **[OPTION A — ARBITRATION] Binding Arbitration.** If the dispute is not resolved within the negotiation period, it will be submitted to binding arbitration administered by [ARBITRATION PROVIDER TO BE SELECTED] under its [APPLICABLE RULES]. Arbitration will be conducted in [LOCATION TO BE DETERMINED]. The arbitrator's decision will be final and binding. [COUNSEL: Confirm class action waiver enforceability and mandatory arbitration enforceability for service contracts in relevant jurisdictions.]

9.3 **[OPTION B — LITIGATION] Governing Jurisdiction.** If the parties do not resolve the dispute through negotiation, either party may pursue claims in courts of competent jurisdiction in [JURISDICTION TO BE DETERMINED BY COUNSEL].

9.4 **Governing Law.** This Agreement is governed by the laws of [STATE/JURISDICTION — TO BE DETERMINED BY COUNSEL], without regard to conflict of law principles.

---

**SECTION 10 — GENERAL**

10.1 **Entire Agreement.** This Agreement and the exhibits referenced herein constitute the entire agreement between the parties with respect to its subject matter and supersede all prior representations, agreements, and understandings.

10.2 **Amendments.** Amendments to this Agreement must be in writing and signed by both parties.

10.3 **Severability.** If any provision of this Agreement is held to be unenforceable, the remaining provisions will continue in full force.

10.4 **Electronic Signature.** The parties agree that electronic signatures, including those delivered through an approved e-signature platform, constitute valid signatures for purposes of this Agreement. [COUNSEL FLAG: Confirm ESIGN Act and UETA compliance in the context of the selected e-sign provider and applicable state law.]

10.5 **Counterparts.** This Agreement may be executed in counterparts, each of which is an original.

---

**Signature Block**

MusiGod: _________________________ Date: ___________  
[Authorized Representative Name and Title — TO BE CONFIRMED]

Artist: __________________________ Date: ___________  
[Legal Name]

---

## 4. Draft Limited Letter of Authorization

```
DRAFT — NOT FOR CLIENT USE
This draft LOA has not been reviewed by counsel. It contains
placeholder language and unresolved scope questions that must
be addressed before use with any real artist client.
```

---

### LIMITED LETTER OF AUTHORIZATION FOR NEIGHBORING RIGHTS AUDIT

**[DRAFT v0.1 — ATTORNEY REVIEW REQUIRED]**

**Date:** [Date of electronic signature]

**Artist:** [Legal Name of Artist or Authorized Representative]

**Professional Name:** [Stage Name]

**To:** MusiGod, [Address — TO BE CONFIRMED]

---

I, the undersigned, am the featured performer and/or the master rightsholder (or authorized representative of the master rightsholder) of the sound recordings described in the Catalog Attachment to this Letter of Authorization ("LOA").

**1. GRANT OF AUTHORIZATION**

I hereby authorize MusiGod, on my behalf, to perform **only** the following specific actions:

   (a) Obtain from me, analyze, and retain for audit purposes the following documents and data that I voluntarily export and provide:
      — My SoundExchange Direct associated recordings export
      — My SoundExchange Direct payment and adjustment statements
      — My SoundExchange Direct search-and-claim or unclaimed recordings export
      — My distributor catalog and statement exports
      — Master ownership or exclusive license documentation that I choose to provide

   (b) Compare the Catalog against publicly available or artist-provided data to identify potential neighboring-rights collection gaps;

   (c) Prepare and deliver to me a written audit findings report;

   (d) Communicate with me regarding my account status, identified gaps, and recommended next steps;

   (e) With my separate written authorization for each specific action, contact SoundExchange, PPL, GVL, or other collection organizations solely to inquire about general registration processes applicable to my catalog.

**2. WHAT THIS LETTER DOES NOT AUTHORIZE**

This LOA **does not** authorize MusiGod to:

   (a) Submit any claim, registration, mandate, or dispute filing to SoundExchange, PPL, GVL, or any other performing rights organization or collection management organization on my behalf;

   (b) Modify my payment instructions, banking details, or direct-deposit information with any organization;

   (c) Change, transfer, or assign any mandate, registration, or CMO affiliation;

   (d) Accept any mandate, power of attorney, or appointment on my behalf;

   (e) Settle or resolve any dispute, claim, or audit finding on my behalf;

   (f) Assign, transfer, encumber, or otherwise convey any of my rights in any sound recording or composition;

   (g) Act as my legal representative in any legal, regulatory, or administrative proceeding;

   (h) Log into or access any SoundExchange Direct, distributor portal, label portal, CMO portal, or any other password-protected account on my behalf;

   (i) Make any tax elections, complete any tax filings, or submit any tax forms in my name;

   (j) Perform any action not explicitly listed in Section 1 of this LOA.

**[COUNSEL FLAG: Confirm that the prohibited actions list in Section 2 is comprehensive under applicable law. Confirm whether any state law treats this LOA as a power of attorney and whether special requirements apply (notarization, witnesses, specific statutory language). Confirm whether the LOA must be filed with or provided to SoundExchange or any CMO.]**

**3. SCOPE**

This LOA applies to the sound recordings identified in the Catalog Attachment only. It does not apply to compositions, publishing rights, synchronization rights, or master rights outside the Catalog.

**4. TERRITORY**

This LOA is applicable in connection with the Audit Services described in the Engagement Agreement. [COUNSEL FLAG: Confirm whether territory scope needs to be specified or limited for LOA validity in specific jurisdictions.]

**5. DURATION**

This LOA is effective from the date of my signature and will remain in effect until the earlier of: (a) the delivery of the final audit findings report; (b) my written revocation pursuant to Section 6; or (c) **[12] months** from the date of signature, whichever occurs first. **[COUNSEL FLAG: Confirm appropriate duration and whether auto-renewal is appropriate.]**

**6. REVOCATION**

I may revoke this LOA at any time by delivering written notice to MusiGod at [MUSIGOD ADDRESS]. Revocation takes effect upon confirmed receipt by MusiGod. Revocation does not affect actions already completed by MusiGod under this LOA before the effective date of revocation.

**[COUNSEL FLAG: Confirm revocation procedure under applicable state law. Confirm whether electronic revocation (email) is sufficient or whether a specific form is required. See Section 8 of this Packet for the full revocation procedure.]**

**7. REPRESENTATION AND WARRANTY**

I represent and warrant that I am authorized to grant the rights described in Section 1 of this LOA, either as the artist, rightsholder, or authorized representative, and that doing so does not violate any other agreement to which I am a party.

**8. ATTORNEY REVIEW**

**[DRAFT — THIS SECTION IS A PLACEHOLDER. COUNSEL MUST REVIEW ALL LANGUAGE IN THIS LOA BEFORE IT IS PRESENTED TO ANY ARTIST.]**

I understand that this LOA has been prepared by MusiGod for attorney review and that I should seek independent legal counsel before signing.

---

**Signature Block**

Artist Signature: _________________________ Date: ___________  
Printed Legal Name: _______________________  
Professional Name: ________________________  
Submission Capacity: [Individual / Entity Representative / Group Representative / Authorized Representative]  
If Representative: Representative Name and Role: ___________________________

---

## 5. Privacy and Data-Handling Disclosures

```
DRAFT — NOT FOR CLIENT USE
This privacy disclosure is preliminary and has not been reviewed
by counsel for compliance with CCPA, CPA (Colorado), CTDPA (Connecticut),
VCDPA (Virginia), or any other applicable privacy framework.
```

**[DRAFT v0.1 — ATTORNEY REVIEW REQUIRED]**

---

### MUSIGOD ARTIST INTAKE PRIVACY DISCLOSURE

**Effective Date:** [TO BE DETERMINED BY COUNSEL]  
**Applies to:** All artists who engage with the MusiGod Artist Rights Intake workflow

---

#### What We Collect

MusiGod collects the following categories of personal information from artists during the intake process:

| Category | Specific data | Purpose |
|----------|--------------|---------|
| Identity | Legal name, professional name, aliases, submission context, performer roles | Intake questionnaire; featured-performer verification |
| Contact | Email address | Communications, reminders, audit delivery |
| Authorization | PRO affiliations, SoundExchange membership status, attestation timestamps, e-signature completion records | Audit eligibility determination |
| Financial documents | SoundExchange payment statements, distributor statements | Audit analysis (secure vault only) |
| Ownership documents | Recording agreements, exclusive licenses, business entity records | Master ownership verification |
| Device and access | IP address, browser type, access timestamps | Security logging |

**We do not collect** SSN, EIN, full bank account numbers, routing numbers, payment card numbers, portal passwords, or 2FA recovery codes through any intake form.

#### How We Use It

- To conduct the neighboring-rights audit you have engaged us to perform
- To communicate with you about the status of your intake and audit
- To comply with our legal obligations
- For internal recordkeeping and audit provenance

We do not sell your personal information. We do not share your personal information with third parties except as described under "Sub-Processors" below and as required by law.

#### Sub-Processors

MusiGod uses the following sub-processors to operate the intake system. By engaging MusiGod you acknowledge that your data may be processed by these services:

| Service | Role | Location |
|---------|------|----------|
| Supabase (Supabase Inc.) | Database and file storage | AWS us-east-1 (U.S.) |
| Vercel Inc. | Compute (serverless API) | U.S. edge regions |
| Resend | Transactional email | U.S. |
| n8n (self-hosted, Render.com) | Workflow automation | U.S. |
| Sentry | Error monitoring | U.S. |

**[COUNSEL FLAG: Confirm whether sub-processor list is complete. Confirm CCPA/applicable law classification of sub-processors as "service providers." Confirm whether GDPR or other international frameworks require additional disclosure for international transfers. Confirm whether Render.com (n8n host) has an adequate DPA.]**

#### Document Storage and Access

Your uploaded documents are stored in a private, access-controlled file storage system (Supabase Storage on AWS). They are:

- Never accessible via a predictable public URL
- Accessible to MusiGod operators only through short-lived authenticated links that expire after 5 minutes
- Bound to your specific engagement — MusiGod operators handling other engagements cannot access your documents
- Processed through an automated sensitive-data scanner; detected sensitive values are never logged

#### Retention

Your personal information and documents are retained for the duration of your engagement plus [RETENTION PERIOD TO BE DETERMINED — see Section 9 of this Packet]. Documents containing sensitive financial data are deleted according to the schedule in Section 9 after the engagement closes, unless a legal hold applies.

#### Your Rights

**[COUNSEL FLAG: Draft CCPA, VCDPA, CPA, and/or CTDPA rights disclosures as applicable depending on artist's location. Confirm which state-specific rights (access, correction, deletion, opt-out of sale, sensitive data rights) are applicable to MusiGod's business model. Do not include state-specific legal conclusions in this draft.]**

Depending on your location, you may have rights to:
- Request a copy of the personal information we hold about you
- Request correction of inaccurate information
- Request deletion of your personal information, subject to our legal obligations
- Opt out of certain data processing activities
- Lodge a complaint with a supervisory authority

To exercise these rights, contact: [MUSIGOD PRIVACY CONTACT — TO BE CONFIRMED]

---

## 6. Contingent-Recovery Fee Terms

```
DRAFT — NOT FOR CLIENT USE
Contingency fee arrangements for royalty recovery may be subject to
regulation as legal fees or as advance-fee arrangements in some
jurisdictions. Counsel must determine whether these terms are
enforceable and whether any disclosure, registration, or licensing
requirements apply to MusiGod's business model.
```

**[COUNSEL FLAG — PRIORITY ITEMS FOR REVIEW:]**

**A. Fee characterization.** Is MusiGod's 15% recovery fee a "contingency fee" subject to state bar rules or other professional-services regulation in any jurisdiction where MusiGod operates or where artists are located? If so, what requirements apply?

**B. Advance-fee prohibition.** Does any applicable state law prohibit advance fees (i.e., the Audit Fee) in connection with a contingency arrangement, or require that advance fees be held in trust or escrow? California, New York, and other states have enacted advance-fee laws for talent services and similar arrangements. Counsel must review.

**C. Definition of "Recovered."** The current draft defines Recovered Amounts as funds "actually received" by the Artist. Counsel should confirm that this definition:
   - Prevents MusiGod from claiming fees on amounts merely claimed or disputed but not yet paid
   - Is enforceable under applicable contract law
   - Does not constitute an unlawful sharing of royalties if MusiGod's fee is deducted from or paid simultaneously with a royalty distribution

**D. Calculation baseline.** The current draft excludes royalties "already being paid correctly before the Effective Date." Counsel should advise on how to define and document the pre-engagement payment baseline to prevent disputes about what was "already being paid."

**E. Recovery fee trigger period.** The current draft proposes that the recovery fee applies to Recovered Amounts received within [12] months of termination where MusiGod's work was a proximate cause. Counsel should advise on the appropriate "tail" period and how to handle the "proximate cause" standard evidentiary requirements.

**F. International payments.** SoundExchange distributions for non-U.S. territory exploitation may flow through different channels and on different timelines. Counsel should advise on whether the fee structure covers international CMO distributions and how to handle currency conversion.

**Summary of current fee structure in code (`lib/intake-config.js`):**

```javascript
contingency_rate: 0.15,
contingency_applies_to:
  'Money actually recovered through documented MusiGod work only. ' +
  'Excludes royalties already being paid correctly before the MusiGod engagement.',
contingency_excludes:
  'Royalties already being paid correctly. Pre-existing distributions. ' +
  'Amounts recoverable without MusiGod involvement.',
billing_activation_blocked: true,
```

---

## 7. Prohibited Authority Schedule

This schedule documents the actions MusiGod's software is engineered to **never** take without separate, specific, written authorization. It is provided to help counsel verify that the legal language in the engagement agreement and LOA is consistent with the system's actual capabilities and restrictions.

### Code-Enforced Prohibitions

The following are enforced at the code level — they are not configurable or overridable at runtime without a code change:

| Prohibition | Enforcement mechanism |
|-------------|----------------------|
| Submitting claims to SoundExchange | SoundExchange adapter feature-flagged OFF; zero API calls possible in default state |
| Routing private statement data through the SoundExchange API | `validateStatementImport()` calls `validateImport()` only; zero `fetch()` calls in the statement path; verified by test [36] in `tests/artist-intake.test.js` |
| Signing envelopes in production without legal approval | All envelopes have `legal_review_required: true` and `production_blocked: true` |
| Generating a production audit manifest without `dryRun: true` | `createManifest()` throws on `dryRun !== true` |
| Including sensitive values in email | `buildMessageRecord()` throws if sensitive keys appear in `customFields` |
| Including signed storage URLs in email | `buildMessageRecord()` throws if `portalUrl` contains a storage token |
| Billing activation | `billing_activation_blocked: true` in all engagement configs |

### LOA Prohibited Scope Values (Enforced in Code)

The following scope values are rejected by `validateLOAScope()` in `lib/esign-adapter.js`. Any LOA envelope whose scope includes these values will throw an error and be rejected:

```
rights_assignment
copyright_transfer
payment_diversion
banking_change
tax_election
broad_power_of_attorney
dispute_settlement
```

**Counsel should confirm** that this list is complete and that no additional scope values should be prohibited based on applicable law.

### Policy-Level Prohibitions (Not Yet Code-Enforced — Require Operator Compliance)

The following are stated as policy but rely on operator adherence; they are not yet enforced by automated code checks:

| Prohibition | Current status |
|-------------|---------------|
| Requesting portal passwords from artists | Identity questionnaire prohibits collection; operator training required |
| Accessing artist portals on their behalf | Policy; no code exists to do this; not currently requested |
| Submitting claims without separate written authorization | Policy + state machine design; no claim API exists |
| Treating repertoire match as ownership confirmation | Policy + data model; system records matches as evidence, not proof |

---

## 8. Revocation Procedure

```
DRAFT — NOT FOR CLIENT USE
Counsel must confirm whether the revocation procedure below is
adequate under applicable law. Some jurisdictions impose specific
requirements for revocation of authorization letters affecting
financial accounts or CMO mandates.
```

**[COUNSEL FLAG: Confirm whether the following procedure satisfies state law requirements for revocation of an authorization letter. Confirm whether written/email revocation is sufficient or whether the LOA requires a specific revocation form.]**

### How an Artist May Revoke the LOA

1. **Written notice.** The artist delivers written notice of revocation to MusiGod at [MUSIGOD EMAIL ADDRESS AND MAILING ADDRESS — TO BE CONFIRMED]. Email is accepted. The notice must state the artist's legal name, professional name, and the engagement ID or Effective Date of the LOA being revoked.

2. **Confirmation of receipt.** MusiGod will confirm receipt of the revocation notice within **[2] business days** by reply email.

3. **Effective date.** Revocation takes effect on the date MusiGod sends its confirmation of receipt. Actions taken by MusiGod before the effective revocation date are not affected.

4. **State machine.** Upon confirmed revocation, the artist's intake workflow is transitioned to the `WITHDRAWN` state. This is a terminal state — the workflow cannot be restarted without a new engagement.

5. **Data handling after revocation.** Upon revocation, MusiGod will:
   - Cease all processing of the artist's documents for audit purposes
   - Retain documents only as required by law or for the resolution of any pending dispute
   - Offer the artist a copy of their uploaded documents upon request
   - Delete documents that are not subject to retention obligations within [DELETION PERIOD — TO BE CONFIRMED BY COUNSEL]

6. **Effect on Fees.** Revocation does not relieve the artist of the obligation to pay the Audit Fee for services already performed. The Recovery Fee tail period (Section 4.2(b) of the Engagement Agreement) continues to apply to Recovered Amounts received after revocation where MusiGod's pre-revocation work was a proximate cause.

### How MusiGod Closes an Engagement

MusiGod may close an engagement (transition to `WITHDRAWN` or `CLOSED`) in the following circumstances:
- Artist requests withdrawal in writing
- Artist is unresponsive for more than **[90] days** after a final inactivity warning
- MusiGod determines the audit cannot be conducted due to insufficient evidence or ownership disputes that cannot be resolved
- MusiGod becomes aware of material misrepresentation in the Artist's submissions

MusiGod will notify the artist in writing before closing an engagement involuntarily.

---

## 9. Document-Retention Policy

```
DRAFT — NOT FOR CLIENT USE
Retention periods are placeholder values. Counsel must review in light
of applicable law, including privacy law deletion obligations, tax record
requirements, and any industry-specific regulations.
```

**[COUNSEL FLAG — PRIORITY ITEMS FOR REVIEW:]**

**A. Minimum retention.** What is the minimum retention period for: (i) signed agreements (LOA, engagement agreement); (ii) financial statements provided by artists; (iii) audit findings reports; (iv) transition records and access logs?

**B. Maximum retention.** CCPA and similar laws impose deletion obligations when personal data is no longer necessary. What is the maximum retention period for artist personal data and financial documents, and what triggers the deletion obligation?

**C. Tax records.** If MusiGod receives or processes financial data for fee-calculation purposes, do tax record retention requirements apply (typically 7 years under IRS guidance)?

**D. Legal hold.** What standard should trigger a legal hold that suspends automatic deletion?

### Proposed Retention Schedule (DRAFT — ALL PERIODS SUBJECT TO ATTORNEY REVIEW)

| Document Category | Proposed Retention | Trigger for Deletion |
|------------------|--------------------|---------------------|
| Signed engagement agreements | **[7] years** from engagement close | [7] years elapsed and no dispute pending |
| Signed LOAs | **[7] years** from revocation or engagement close | [7] years elapsed and no dispute pending |
| Identity questionnaire submissions | **[5] years** from engagement close | [5] years elapsed and no dispute pending |
| Artist financial statements (SoundExchange, distributor) | **[5] years** from engagement close | [5] years elapsed and engagement closed |
| Audit findings reports | **[7] years** from delivery | [7] years elapsed |
| State machine transition records | **[5] years** from engagement close | [5] years elapsed |
| Access logs | **[3] years** from creation | [3] years elapsed |
| Documents in quarantine (sensitive data) | Until replaced or **[90] days**, whichever is shorter | Replacement accepted or [90] days from quarantine |
| Documents under legal hold | Indefinite | Legal hold lifted by operator |

### Deletion Procedure

1. Retention period expires for a document category in a closed engagement.
2. System (or operator) marks the document for deletion.
3. Document is deleted from Supabase Storage. Supabase performs secure deletion on their end; MusiGod relies on Supabase's infrastructure controls.
4. Document vault record is marked `retention_status: DELETED`. The vault record (metadata only, no content) is retained for the audit trail.
5. Deletion event is logged with document ID, category, retention period, and deletion date — not document content.

**MusiGod does not currently have an automated retention enforcement system.** Retention is currently a manual operator responsibility. An automated retention enforcement job is a deployment-phase deliverable.

---

## 10. Unresolved Legal Decisions

The following questions require attorney input before any artist engagement can proceed. Each is listed with the relevant code or document reference so counsel can locate the placeholder quickly.

| # | Question | Urgency | Relevant reference |
|---|---------|---------|-------------------|
| 1 | **Governing law and jurisdiction.** Which state's law governs the engagement agreement? Where may disputes be filed? | High | §9.4 of draft agreement |
| 2 | **Dispute resolution.** Arbitration or litigation? If arbitration: provider, rules, seat, cost allocation. Class action waiver enforceability. | High | §9.2 / §9.3 of draft agreement |
| 3 | **Advance-fee compliance.** Is the Audit Fee permissible in combination with a contingency Recovery Fee under state law? Does any state require the advance fee to be held in trust or escrow? | High | §3.1 of draft agreement; Section 6 of this Packet |
| 4 | **Contingency fee characterization.** Does the 15% Recovery Fee constitute a "contingency fee" subject to state bar rules or other regulation? | High | §3.2 of draft agreement; Section 6 of this Packet |
| 5 | **LOA legal classification.** Does this LOA constitute a power of attorney under any applicable state law? If so, what statutory requirements apply (notarization, witnesses, specific statutory language)? | High | Section 4 of this Packet |
| 6 | **E-sign provider compliance.** Once a vendor is selected (DocuSign, HelloSign, PandaDoc, or other), confirm ESIGN Act and UETA compliance, signer identity verification requirements, and completeness certificate standards for this use case. | High (blocks production) | `lib/esign-adapter.js`; §10.4 of draft agreement |
| 7 | **MusiGod entity type and name.** The draft agreement identifies MusiGod as "[ENTITY TYPE AND STATE OF FORMATION TO BE CONFIRMED]." Confirm the correct legal entity name and formation details. | High | §1 (preamble) of draft agreement |
| 8 | **Recovery fee tail period.** How long after engagement termination should the Recovery Fee tail period run? 12 months was proposed but has not been reviewed. | Medium | §4.2(b) of draft agreement |
| 9 | **Privacy law compliance.** Which state and federal privacy laws apply to MusiGod's data collection? What disclosures, rights, and procedures are required? Does MusiGod need to register as a "data broker" or equivalent in any state? | Medium | Section 5 of this Packet |
| 10 | **Sub-processor DPAs.** Are existing data processing agreements with Supabase, Vercel, Resend, n8n/Render, and Sentry adequate? Are additional DPAs required? | Medium | §2 of this Packet (sub-processor table) |
| 11 | **International CMO mandates.** If MusiGod assists an artist with PPL, GVL, or other international CMO engagement, do additional authorization documents beyond the current LOA become necessary? | Medium | LOA §1(e); ESHAM_AUTOMATED_INTAKE_PILOT_PLAN.md |
| 12 | **Contingency exclusion baseline.** How should the "royalties already being paid correctly before the Effective Date" exclusion be documented and verified to prevent fee disputes? | Medium | §3.3 of draft agreement; Section 6 of this Packet |
| 13 | **Limitation of liability enforceability.** Is the liability cap (Audit Fee amount) and exclusion of consequential damages enforceable in consumer contracts in likely artist jurisdictions? | Medium | §7 of draft agreement |
| 14 | **Talent representation laws.** Does any state's talent representation law (California, New York, Tennessee, etc.) require MusiGod to be licensed as a talent agent, personal manager, or similar? | Medium | Requires jurisdiction-specific analysis |
| 15 | **Retention period finalization.** Confirm minimum and maximum retention periods for each document category. | Medium | Section 9 of this Packet |
| 16 | **Reel Life Productions (pilot-specific).** If the pilot artist's recordings are owned by Reel Life Productions, what ownership documentation standard is required, and does MusiGod need a separate authorization from Reel Life Productions in addition to the artist's LOA? | Low (pilot-specific) | ESHAM_AUTOMATED_INTAKE_PILOT_PLAN.md |
| 17 | **Non-featured performer share.** SoundExchange holds a separate non-featured performer share. This system does not currently collect non-featured performer declarations or submit non-featured performer claims. Confirm that the current scope of the LOA and engagement agreement does not unintentionally affect non-featured performer rights. | Low | `lib/neighboring-rights-audit.js` (`non_featured_gross`) |
| 18 | **Class action waiver.** If arbitration is selected, confirm whether a class action waiver is enforceable in likely artist jurisdictions and whether it is appropriate for this service model. | Low (depends on dispute resolution choice) | §9.2 of draft agreement |

---

## 11. Attorney Sign-Off Table

Complete this table after reviewing each section. The production system remains blocked until all items in the "REQUIRED BEFORE PRODUCTION" column are marked APPROVED.

| Section | Attorney | Date | Status | Notes |
|---------|---------|------|--------|-------|
| Draft Engagement Agreement — Services (§1) | | | PENDING | |
| Draft Engagement Agreement — Artist Reps (§2) | | | PENDING | |
| Draft Engagement Agreement — Fees (§3) | | | PENDING | Advance fee + contingency structure |
| Draft Engagement Agreement — Term/Termination (§4) | | | PENDING | |
| Draft Engagement Agreement — Confidentiality (§5) | | | PENDING | |
| Draft Engagement Agreement — Liability Cap (§7) | | | PENDING | Consumer protection review |
| Draft Engagement Agreement — Indemnification (§8) | | | PENDING | |
| Draft Engagement Agreement — Dispute Resolution (§9) | | | PENDING | Arbitration vs. litigation decision |
| Draft Engagement Agreement — Governing Law (§9.4) | | | PENDING | **Blocks production** |
| Draft LOA — Grant of Authorization (§1) | | | PENDING | **Blocks production** |
| Draft LOA — Prohibited Actions (§2) | | | PENDING | **Blocks production** |
| Draft LOA — Duration (§5) | | | PENDING | |
| Draft LOA — Revocation (§6) | | | PENDING | |
| Draft LOA — POA classification | | | PENDING | **Blocks production** |
| Privacy Disclosure | | | PENDING | CCPA and applicable law compliance |
| Contingent-Recovery Fee Terms | | | PENDING | **Blocks production** |
| Prohibited Authority Schedule | | | PENDING | Confirm LOA prohibited scope list is complete |
| Revocation Procedure | | | PENDING | |
| Retention Policy | | | PENDING | Specific periods need confirmation |
| E-sign provider compliance | | | PENDING | **Blocks production** (vendor pending selection) |
| MusiGod entity name and type | | | PENDING | **Blocks production** |
| Sub-processor DPAs | | | PENDING | |

---

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  DRAFT — NOT FOR CLIENT USE                                                  ║
║  All language in this document is preliminary and has not been reviewed      ║
║  or approved by counsel. Do not present to, sign with, or rely upon for      ║
║  any artist or third party until attorney review is complete.                ║
║  Production activation remains blocked.                                      ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

*End of attorney review packet.*
