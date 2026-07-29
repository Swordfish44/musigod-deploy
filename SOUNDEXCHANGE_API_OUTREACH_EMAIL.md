# SoundExchange API Outreach — Draft Email

**Status:** DRAFT — internal review required before sending  
**Do not send** until reviewed and approved by MusiGod legal/management  
**Prepared:** 2026-07-29  
**Source document:** `SOUNDEXCHANGE_API_ACCESS_REQUEST.md`

---

**To:** repertoire@soundexchange.com  
**Subject:** API Access Inquiry — MusiGod Neighboring Rights Recovery Audit Platform  
**From:** [MusiGod authorized representative name and title]  
**Organization:** MusiGod / [Legal entity name]  
**Website:** musigod.com

---

Dear SoundExchange Repertoire Team,

My name is [Name], and I am writing on behalf of MusiGod, a publishing-administration and neighboring-rights catalog-audit platform serving independent artists and artist-owned catalogs.

## About MusiGod

MusiGod helps independent artists form publishing entities, register with performing-rights organizations, identify uncollected royalties, and conduct neighboring-rights audits. Our Neighboring Rights Recovery Audit product analyzes a client's sound-recording catalog against SoundExchange registration status, ISRC coverage, performer declarations, and rightsholder documentation to identify gaps in neighboring-rights collection and — where evidence supports it — authorized recovery opportunities.

We are currently onboarding our first audit clients and are processing catalog exports from SoundExchange Direct on their behalf. Our current workflow is entirely file-based: clients export their own catalog and statement data from SXDirect, transfer it to us via secure upload, and we ingest it through a validated import pipeline. We do not ask clients to share their SXDirect credentials with us, and we do not access their accounts.

As we scale this service, a programmatic data interface would meaningfully improve matching accuracy and reduce the manual burden on both our clients and our operators. We are writing to understand whether SoundExchange offers an authorized path to that kind of access, and if so, how to apply.

---

## Section 1 — Repertoire Search API

We are aware that SoundExchange operates a public artist-search feature on your website. We want to be transparent that we have audited our own codebase and removed a prior implementation that called an undocumented WordPress AJAX endpoint (`wp-admin/admin-ajax.php`) to power that search programmatically. That call has been retired and replaced with a documented stub pending official API access. We do not scrape SoundExchange systems and will not do so.

We would like to request information about any **officially supported Repertoire Search API** that SoundExchange makes available to administrators, distributors, or audit partners. Specifically, we are requesting:

1. **Whether such an API exists** and, if so, a pointer to its public documentation or a contact for the appropriate program.
2. **Eligibility requirements** — what entity type, volume, or certification is required to qualify for access.
3. **The data-use agreement** or terms of service that govern third-party programmatic access to repertoire data.
4. **Sandbox or test environment** availability for integration development prior to production approval.
5. **Authentication method** — OAuth2 client credentials, API key, or another scheme.
6. **Rate limits and quota policy** — requests per minute, requests per day, and any burst or back-off requirements.
7. **Permitted storage and retention** — whether matched repertoire data may be stored in our system for audit-provenance purposes and for how long.
8. **Production approval process** — what review, testing, or certification steps are required before a production integration goes live.

---

## Section 2 — Account-Level and Statement Data APIs

We also want to ask directly whether SoundExchange offers any **authorized API for account-level or payment data**, and if so, what programs govern access. The specific capabilities we are asking about are:

1. **Artist and rightsholder claim status** — whether a given performer or rightsholder is registered, what territories their mandate covers, and whether their registration is current.
2. **Associated-recordings lookup** — the ability to retrieve recordings associated with a registered artist or rightsholder by ISRC or by name, to assist with audit matching.
3. **Payment statement access** — royalty payment history, statement line items by ISRC and period, paid amounts, and held amounts.
4. **Adjustment and reversal records** — the ability to identify prior payment adjustments, reversals, or reissued payments that affect an artist's net received total.
5. **Held and unmatched royalties** — recordings for which SoundExchange has usage data but cannot match to a registered claimant, that a rightsholder or administrator could identify and claim.

**If no authorized API exists for any of these capabilities,** please confirm that, and we will continue to use client-authorized SXDirect exports as our data source. We understand that statement and payment data carries significant privacy and contractual obligations, and we are not requesting access to data that SoundExchange has not specifically authorized for programmatic delivery to third parties.

We want to be clear about our data-handling practices for account-level data regardless of delivery method:

- Statement and payment data is never transmitted through our API layer. It is ingested only from client-provided exports, validated locally, and stored in encrypted form associated with the specific client engagement that authorized its collection.
- We maintain a per-record audit trail including the source organization, source filename, import timestamp, evidence type, and matching rationale for every data point we process.
- We never pool or aggregate private statement data across clients.
- We do not retain statement data beyond the scope of the engagement without client re-authorization.

---

## Section 3 — Our Technical Architecture and Security Posture

We want to give you confidence in how we would use any authorized access. Key properties of our integration:

**No scraping.** MusiGod does not call undocumented endpoints, parse HTML, or use browser automation to extract SoundExchange data. The prior `wp-admin/admin-ajax.php` call has been removed from our codebase and is not used in any current or planned integration.

**Feature-flagged adapter.** Our SoundExchange integration is implemented as a feature-flagged adapter (`lib/soundexchange-adapter.js`) that defaults to `FEATURE_DISABLED` until official credentials are supplied. The adapter cannot make any API calls in its default state. We built this architecture specifically to ensure that no unauthorized calls are made while we seek official access.

**Encrypted credential handling.** API credentials are loaded exclusively from environment variables, never hardcoded in source code. Our credential pipeline uses Vercel's encrypted environment variable storage. Credentials are never logged, printed, or committed to version control.

**Separation of private royalty data.** Statement and payment import is a distinct code path from the repertoire search adapter. Private royalty data can never flow through the API layer regardless of credential state. Our test suite includes explicit assertions for this invariant.

**Audit provenance.** Every imported fact retains its source organization, source filename, record ID, statement period, import timestamp, and matching rationale. Conflicting evidence is preserved rather than overwritten.

**Client-first authorization.** We obtain written authorization from clients before initiating any audit, and we do not act on any data or submit any claim without client sign-off. We can provide a copy of our client engagement template on request.

---

## Section 4 — What We Are Not Asking For

To be explicit about scope:

- We are not requesting access to any client's SoundExchange account on their behalf without their written authorization.
- We are not requesting credentials to SoundExchange Direct or the ability to log in as a client.
- We are not requesting the ability to submit claims, registrations, mandates, or dispute filings through an API — we understand those actions require the rightsholder's direct authorization and would require a separate arrangement.
- We are not asking SoundExchange to perform any action on a client's account. We are asking only whether read-access to repertoire and, separately, client-authorized account data is available through an official channel.

---

## Section 5 — Proposed Next Steps

If an official program exists that fits our use case, we are prepared to:

1. Complete any required application or eligibility questionnaire.
2. Provide business entity documentation, security policies, and client authorization framework.
3. Execute a data-use agreement or non-disclosure agreement as required.
4. Integrate against a sandbox environment before requesting production access.
5. Submit to any technical review or certification process SoundExchange requires.

If no API is currently available or if our use case does not qualify, we would appreciate a brief reply confirming that so we can close this inquiry and continue with the client-export workflow.

We are happy to schedule a call to discuss our use case in more detail. Please let us know the best way to proceed.

Thank you for your time and for the important work SoundExchange does for independent artists.

Sincerely,

[Name]  
[Title]  
MusiGod  
[Phone number]  
[Email address]  
musigod.com

---

## Internal Pre-Send Checklist

Complete all items before sending:

- [ ] Replace all `[bracketed placeholders]` with real values
- [ ] Legal review of Section 2 (account-level and statement data APIs) — confirm the data-handling representations are accurate and complete
- [ ] Confirm `repertoire@soundexchange.com` is still the correct contact address (verify on soundexchange.com before sending)
- [ ] Remove this checklist section before sending
- [ ] Obtain management sign-off
- [ ] Send from a professional MusiGod email address, not a personal address
- [ ] BCC the sent copy to internal records
- [ ] Log the outreach date in `SOUNDEXCHANGE_API_ACCESS_REQUEST.md` under a new "Outreach Log" section

---

*This document is a draft for internal review. It has not been sent. Do not send without completing the checklist above.*
