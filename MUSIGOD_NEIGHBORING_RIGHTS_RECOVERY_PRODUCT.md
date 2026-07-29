# MusiGod — Neighboring Rights Recovery Audit: Product Definition

**Version:** 1.0.0  
**Date:** 2026-07-29  
**Status:** Internal product definition — do not share as a client-facing document without review

---

## 1. The Client Problem

Independent artists, small labels, and artist-owned catalogs frequently miss sound-recording performance royalties from organizations like SoundExchange (US) and PPL (UK). These royalties compensate **featured performers** and **sound-recording rightsholders** when recordings are broadcast, streamed, or publicly performed.

Unlike publishing royalties (which go to songwriters via PROs like ASCAP and BMI), neighboring-rights royalties are paid for the **recording itself** — not the song. A recording can earn neighboring-rights royalties even if the songwriter is different from the performer.

Common reasons these royalties go uncollected:
- Artist is not registered as a featured performer at SoundExchange or PPL
- Artist registered but no mandate on file for international territories
- Recordings lack ISRCs, preventing CMO matching
- Label or distributor collected royalties but did not remit them to the artist
- Unclaimed pool accumulates until the holding period expires
- Prior recovery work was incomplete or covered only some territories

MusiGod's catalog data, enrichment pipeline, and rights graph make it well-positioned to identify gaps, organize evidence, and support authorized recovery — without making legal guarantees or inventing ungrounded numbers.

---

## 2. Audit Scope

The Neighboring Rights Recovery Audit covers:

- Sound recording performance royalties (neighboring rights), not publishing/composition royalties
- SoundExchange (US digital performance) as the primary CMO for US-market recordings
- PPL (UK), GVL (Germany), SCPP (France), Gramex/AURA (Nordics), and other international CMOs where recordings have been distributed — as a secondary tier
- All catalog recordings for which ISRC matching is possible
- Performer identity (featured performer and non-featured performer, separately)
- Sound-recording rightsholder identity (master owner, label, distributor)
- Territory coverage and mandate status
- Historical unclaimed amounts, held amounts, and payment adjustments
- Disputed claims and prior recovery work

**Out of scope for this audit:**
- Publishing/composition royalties (handled separately by PRO registration and MLC/HFA pipelines)
- Mechanical royalties
- Sync licensing
- New recording registrations or ISRC issuance (those are distinct workflows)
- Tax withholding calculations (handled at disbursement stage under separate protocols)

---

## 3. Required Inputs

The following are required from the client before any dollar calculation can be produced:

| Input | Format | Notes |
|-------|--------|-------|
| Written authorization | PDF/email | Must name legal claimant and authorize MusiGod |
| Featured performer declaration | Written statement | Required per CMO rules |
| Master ownership confirmation | Agreement or declaration | MusiGod will not assume ownership |
| SoundExchange payment statements (all years) | CSV or PDF | Primary source for dollar amounts |
| SoundExchange catalog export | CSV | Confirms ISRC registration |
| International CMO statements (PPL, etc.) | CSV or PDF | Where applicable |

See `ESHAM_NEIGHBORING_RIGHTS_DATA_REQUEST.md` for the complete data request template.

---

## 4. Deliverables

Upon receipt of required inputs:

| Deliverable | Description |
|------------|-------------|
| Import validation report | Which rows were accepted, quarantined, and why |
| Per-recording classification | Each track classified per the 14 audit classifications |
| Financial reconciliation | Gross/net/paid/held/adjustment per source, per territory, per currency |
| Exception queue | Conflicts, unmatched statement rows, fuzzy-only candidates |
| Interest breakdown | Featured-performer share vs. rightsholder share vs. other — never combined |
| Baseline report update | Updated `ESHAM_NEIGHBORING_RIGHTS_BASELINE.md` |
| Client-facing recovery summary | Plain-language summary of confirmed, unclaimed, and blocked amounts |
| Recommended next steps | Prioritized action list with blockers identified |

**Not a deliverable:** Legal opinions, guarantees of recovery, or speculative estimates of "what you might be owed."

---

## 5. Exclusions and Limitations

1. **No legal guarantees.** MusiGod does not guarantee that any amount identified in the audit will be recovered.
2. **No CMO portal access.** MusiGod does not log into CMO portals on behalf of clients. Clients must export their own statements and provide them.
3. **No claim submission without separate authorization.** The audit phase identifies opportunities. Submitting a claim or mandate requires a separate written authorization.
4. **No master ownership assumption.** MusiGod will not treat Esham or any client as the master rightsholder without documentation, regardless of who the performing artist is.
5. **International coverage is contingent on statement availability.** If no PPL statement is provided, no PPL amount will appear in the report.
6. **ISRC gaps limit matching.** The 44 tracks currently lacking ISRCs cannot be matched to CMO records until ISRCs are sourced.
7. **Statute of limitations.** CMOs have varying holding periods for unclaimed royalties. MusiGod does not provide legal advice on whether a particular historical amount is still recoverable.

---

## 6. Evidence Standards

Every dollar amount in an audit report must be traceable to at least one of the following:

- A specific line item in a provided CMO statement (preferred)
- A SoundExchange search-and-claim result with a confirmed ISRC match
- A distributor royalty statement with confirmed ISRC match

Dollar amounts will **not** be calculated from:
- Stream count estimates
- Catalog-wide royalty rate estimates
- Inferences from public usage data
- Any source that is not a provided statement or official CMO export

---

## 7. Recovery Workflow

**Phase 0 — Authorization**  
Client signs engagement letter. MusiGod receives written authorization to conduct audit.

**Phase 1 — Evidence collection**  
Client exports data per `ESHAM_NEIGHBORING_RIGHTS_DATA_REQUEST.md` and transfers securely.

**Phase 2 — Import and validation**  
Operator runs `validateImport()` for each source. Quarantine exceptions are reviewed and resolved.

**Phase 3 — Pipeline run**  
`runAudit({ dryRun: true, ... })` processes all sources. Zero DB writes. Output is a structured JSON report.

**Phase 4 — Review and reconciliation**  
Operator reviews classifications, financial reconciliation, and exception queue. Fuzzy-match candidates are manually confirmed or denied.

**Phase 5 — Client report**  
Client-facing summary is produced from the pipeline output. Amounts shown are from statement evidence only.

**Phase 6 — Recovery actions (separate engagement)**  
Based on the report, client and MusiGod agree on which actions to take:
- SoundExchange search-and-claim (client authorization required)
- International mandate registration (client authorization required)
- Dispute filing (legal review required)
- Label/distributor inquiry (client authorization required)

**Phase 7 — Post-recovery update**  
After any recovery is complete and funds are received, pipeline re-run confirms amounts match. Disbursement handled under the `royalties` schema (separate workflow; requires human merge + production write approval).

---

## 8. Human-Review Workflow

The following classifications always require human review before any action is taken:

| Classification | Required review |
|---------------|----------------|
| `OWNERSHIP_CONFLICT` | Legal review + client written confirmation of correct ownership |
| `PERFORMER_CONFLICT` | Client confirmation of correct performer role |
| `IDENTIFIER_CONFLICT` | Investigation of ISRC registration history |
| `MANUAL_REVIEW` | Operator must confirm or deny fuzzy match before any amount is attributed |
| Any amount > $500 | Second operator review before including in client report |
| Any international amount | Confirm exchange rate provenance before converting |

The pipeline will never auto-resolve these classifications. They appear in `exceptions` and in the `recordings` array with their classification code.

---

## 9. Pricing Structure

### Standard catalog audit

| Tier | Price | Includes |
|------|-------|---------|
| Catalog audit setup (up to 200 tracks) | $[TBD fixed fee] | Phase 0–5: import, validation, classification, financial reconciliation, client report |
| Additional tracks (over 200) | $[TBD per-100-tracks fee] | Same processing for additional catalog |
| Rush turnaround (<5 business days) | $[TBD surcharge] | Priority processing |

### Per-recording remediation (optional)

For recordings that require individual research beyond the standard pipeline (missing ISRC sourcing, label inquiry, dispute filing):

| Service | Price |
|---------|-------|
| ISRC sourcing research (per track) | $[TBD] |
| CMO match investigation (per track) | $[TBD] |
| Label/distributor inquiry support (per release) | $[TBD] |

### Contingent recovery fee

| Scenario | Fee |
|---------|-----|
| Confirmed recovery (funds actually received by client) | 15% of recovered amount |
| Minimum fee if recovery is confirmed | $[TBD minimum] |

**The contingent fee is calculated only on money actually received by the client** — not on speculative amounts, "potential" opportunities, or pipeline-identified unclaimed amounts that have not yet been collected.

The contingent recovery fee is capped so that the combination of fixed audit fee + contingent fee does not exceed [TBD cap, e.g., 20%] of the total recovered amount.

---

## 10. Scalable Version for B2B Clients

The same audit pipeline can be offered to:

| Client type | Use case |
|------------|---------|
| Catalog funds and music investment vehicles | Audit historical neighboring-rights gaps across acquired catalogs |
| Independent labels | Audit their artist roster's sound-recording royalty exposure |
| Publisher with master interests | Where publisher also owns or co-owns the master recording |
| Artist estates and administrators | Historical recovery for legacy catalogs |
| Distributors (white-label) | Offer as a value-added service to artist clients |
| DSPs and AI music platforms (B2B2B) | Use rights graph to verify neighboring-rights clearance status before licensing |

For B2B engagements:

- Catalog size may range from 200 to 200,000 tracks
- Pipeline is designed to be idempotent and scalable — same `runAudit()` function, larger input arrays
- Financial output would be aggregated by label, artist, release, territory, or CMO depending on client need
- White-label reporting available: client's branding on the output report
- API access to the audit pipeline available as a recurring subscription

---

## 11. What MusiGod Will Not Do

Regardless of client request:

- Will not submit claims without written authorization
- Will not log into CMO portals
- Will not fabricate dollar amounts without statement evidence
- Will not assume master ownership without documentation
- Will not provide legal opinions on recoverability
- Will not commit private client data to git or any version-controlled repository
- Will not combine performer share with rightsholder share in any single total
- Will not represent this audit as a guarantee of recovery

---

*This product definition is an internal document. Pricing is indicative and subject to legal and business review before client-facing use.*
