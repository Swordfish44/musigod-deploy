# Artist Intake Legal Review Checklist

**Status:** DRAFT — all items require attorney review and sign-off before production use  
**Scope:** Engagement agreement, Limited Letter of Authorization, and intake policy language  
**Instructions:** Attorney must mark each item APPROVED or FLAG FOR REVISION before production activation

---

## Part 1 — Engagement Agreement

- [ ] Services description accurately describes neighboring-rights audit scope
- [ ] Contingency fee structure (15% of recovered amounts) is clearly defined and enforceable
- [ ] "Recovered amounts" is narrowly defined to exclude pre-existing correct payments
- [ ] Credit of setup fee against recovery fee (if applicable) is documented
- [ ] Per-recording remediation fee structure is documented
- [ ] Engagement duration and termination rights are specified
- [ ] Artist data rights and confidentiality obligations are specified
- [ ] MusiGod limitation of liability is appropriate for the service
- [ ] Governing law and jurisdiction are specified
- [ ] Dispute resolution mechanism is included
- [ ] Electronic signature is valid and enforceable in the applicable jurisdiction
- [ ] Agreement does not silently authorize rights assignment, copyright transfer, or payment diversion

**Attorney approval required before:** Agreement template is loaded into the e-sign adapter for production use.

---

## Part 2 — Limited Letter of Authorization (LOA)

- [ ] LOA scope is narrowly defined to: audit, research, identification of potential recovery opportunities
- [ ] LOA explicitly prohibits: rights assignment, copyright transfer, payment diversion, banking changes, tax elections, broad power of attorney, dispute settlement beyond approved scope
- [ ] LOA clearly states that MusiGod cannot submit claims without separate explicit client authorization
- [ ] LOA does not authorize MusiGod to log into any SoundExchange, CMO, or distributor portal on the artist's behalf
- [ ] LOA does not authorize transfer of registration or mandate without separate action
- [ ] LOA duration is specified (recommend: time-limited with renewal option)
- [ ] Revocation procedure is specified
- [ ] Electronic signature is valid and enforceable
- [ ] LOA is scoped by service type (neighboring rights only, unless explicitly broadened)

**Attorney approval required before:** LOA template is used with any real artist client.

**Prohibited LOA scopes (enforced in code):** `rights_assignment`, `copyright_transfer`, `payment_diversion`, `banking_change`, `tax_election`, `broad_power_of_attorney`, `dispute_settlement`

---

## Part 3 — Data Collection and Privacy

- [ ] Identity questionnaire collects only what is needed and excludes SSN/EIN/passwords
- [ ] Document retention policy is compliant with applicable privacy law
- [ ] Legal hold and deletion procedures are defined
- [ ] Consent for data processing is properly obtained
- [ ] Data portability and deletion requests procedure is documented
- [ ] Third-party data processing (Supabase, Resend, Vercel, n8n) is disclosed
- [ ] International data transfer compliance (if applicable) is addressed

---

## Part 4 — Neighboring Rights Specific

- [ ] MusiGod's role as auditor (not performer or rightsholder) is clearly stated
- [ ] Distinction between composition royalties and neighboring rights royalties is clear
- [ ] Master ownership claim standard is stated: documentation required, never inferred from identity
- [ ] Featured-performer distinction from rightsholder is clearly described
- [ ] Claim submission authority requires separate explicit authorization
- [ ] Contingency fee applies only to amounts actually received through MusiGod work, not historical payments

---

## Part 5 — E-Signature Provider

- [ ] Chosen e-sign provider (pending selection) is compliant with ESIGN Act / UETA
- [ ] Signer identity verification level is appropriate for the document type
- [ ] Completion certificate format is sufficient for evidentiary purposes
- [ ] Webhook delivery and envelope retention policy is reviewed

---

## Sign-Off

| Item | Attorney | Date | Status |
|------|---------|------|--------|
| Engagement agreement language | | | PENDING |
| LOA language | | | PENDING |
| Data collection and privacy | | | PENDING |
| Neighboring rights scope | | | PENDING |
| E-sign provider compliance | | | PENDING |

**Production activation is blocked until all items above are marked APPROVED.**

The code enforces this via:
- `legal_review_required: true` on all e-sign envelopes
- `production_blocked: true` on all e-sign envelopes
- `billing_activation_blocked: true` in all engagement configs
