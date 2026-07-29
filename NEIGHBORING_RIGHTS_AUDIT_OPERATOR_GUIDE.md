# Neighboring Rights Audit — Operator Guide

**System:** MusiGod Neighboring Rights Recovery Audit Pipeline  
**Version:** 1.0.0  
**Last updated:** 2026-07-29  
**Pipeline location:** `lib/neighboring-rights-audit.js`

---

## 1. Overview

This guide is for MusiGod operators (internal staff and authorized auditors). It explains how to receive evidence, run the audit pipeline in dry-run mode, interpret every output field, resolve exceptions, produce client-facing reports, and identify what requires legal review or production approval.

The pipeline is a **read-only processing library**. It never writes to the database, calls external APIs, or modifies production data. Every run must use `dryRun: true`.

---

## 2. Receiving and Staging Evidence Securely

### 2.1 Accepted document types

| Import type | Template file | Description |
|-------------|--------------|-------------|
| `soundexchange_catalog` | `template_soundexchange_catalog.csv` | SoundExchange registered catalog |
| `soundexchange_statement` | `template_soundexchange_statement.csv` | Payment + adjustment statement lines |
| `soundexchange_unclaimed` | `template_soundexchange_unclaimed.csv` | Search-and-claim unclaimed results |
| `ppl_statement` | `template_ppl_statement.csv` | PPL royalty statement lines |
| `distributor_statement` | `template_distributor_statement.csv` | Distributor/label royalty lines |
| `performer_roster` | `template_performer_roster.csv` | Featured and non-featured performer list |
| `ownership_declaration` | `template_ownership_declaration.csv` | Master/rightsholder ownership |
| `territory_mandate` | `template_territory_mandate.csv` | CMO mandate coverage |
| `conflicts_manual` | `template_conflicts_manual.csv` | Conflict log and manual decisions |

Templates are in `scripts/fixtures/neighboring-rights/`.

### 2.2 Handling received files

1. Save received files to a local staging directory (e.g., `~/audit-staging/esham-2026/`). **Do not commit statement files, contracts, or tax documents to git.**
2. Verify the file is the format expected (CSV columns match the template).
3. Never open statements in git-tracked directories. The `.gitignore` should exclude `audit-staging/` and `*.private.*`.
4. Parse CSV in your driver script before passing rows to `validateImport()`.

### 2.3 What not to store

Never commit to git:
- SoundExchange or CMO statement exports (contain private royalty amounts)
- Tax documents (1099-MISC, W-9)
- Master ownership agreements
- Any file containing SSN, EIN, routing number, account number

---

## 3. Validating Imports

Before passing any rows to the pipeline, validate them:

```javascript
const { validateImport } = require('./lib/neighboring-rights-audit');

const { valid, quarantine, errors } = validateImport(parsedRows, 'soundexchange_statement');

if (quarantine.length > 0) {
  console.log('Quarantined rows:', quarantine);
  // Each quarantined row has a _quarantine_reason field
}
// Only proceed with `valid` rows
```

Common quarantine reasons and fixes:

| Reason | Fix |
|--------|-----|
| `missing required field: "gross_royalties"` | Check if column header is spelled correctly in the CSV |
| `invalid ISRC: malformed` | Verify ISRC format: 2-letter country code + 3-char registrant + 2-digit year + 5-digit designation |
| `non-numeric value in "gross_royalties"` | Check for blank cells, text annotations, or currency symbols in amount columns |
| `unknown import type` | Use one of the 8 supported import type strings exactly |

---

## 4. Running the Audit in Dry-Run Mode

```javascript
const { validateImport, runAudit } = require('./lib/neighboring-rights-audit');
const fs = require('fs');

// Example driver script
// Assumes catalogTracks is fetched from the database already (read-only)

async function main() {
  const sxRows = parseCsv('~/audit-staging/esham-2026/Esham_SX_Statement_2023.csv');
  const { valid: sxStatements } = validateImport(sxRows, 'soundexchange_statement');

  const ownershipRows = parseCsv('~/audit-staging/esham-2026/Esham_Ownership_Declaration.csv');
  const { valid: ownership } = validateImport(ownershipRows, 'ownership_declaration');

  // catalogTracks comes from a read-only Supabase query
  const catalogTracks = await fetchCatalogReadOnly();

  const result = runAudit({
    dryRun: true,
    catalogTracks,
    soundexchangeStatements: sxStatements,
    ownershipDeclarations: ownership,
  });

  // result.dry_run === true — no DB writes occurred
  fs.writeFileSync('./audit-output.json', JSON.stringify(result, null, 2));
}
```

The pipeline returns a result object with:

```
{
  dry_run: true,
  pipeline_version: '1.0.0',
  processed_at: '2026-07-29T...',
  catalog_total: 196,
  statements_processed: { soundexchange: N, ppl: N, distributor: N },
  classifications: { CLAIMED_PAID: N, UNCLAIMED: N, ... },
  recordings: [ ... per-track results ],
  exceptions: [ ... conflicts, duplicates, fuzzy-only matches ],
  reconciliation: { soundexchange: {...}, ppl: {...}, distributor: {...} },
  confirmed_receivable_calculable: true | false,
  verdict: '...'
}
```

---

## 5. Interpreting Every Classification

| Classification | Meaning | What to do |
|---------------|---------|------------|
| `CLAIMED_PAID` | Statement match found; paid amount > 0, no held amount | Verify amount is correct; document as received |
| `CLAIMED_UNPAID` | Statement match found; amount is held, not paid | Investigate hold reason; may require mandate or ownership proof |
| `UNCLAIMED` | ISRC present, mandate on file, no statement match | Initiate SoundExchange search-and-claim (requires client auth) |
| `PARTIALLY_CLAIMED` | Statement match found; both paid and held amounts present | Reconcile held portion; investigate split between paid/held |
| `MISSING_FROM_CMO` | In catalog, has ISRC, mandate on file — no usage evidence | May indicate CMO has no usage data for this recording |
| `OWNERSHIP_CONFLICT` | Ownership declarations sum to >100% for a territory | Escalate to legal review; do not initiate claims until resolved |
| `PERFORMER_CONFLICT` | Performer listed with contradictory roles (e.g., both featured and non-featured) | Correct performer roster; get written confirmation from client |
| `IDENTIFIER_CONFLICT` | Duplicate ISRCs within a single track's identifier list | Investigate ISRC registration history; contact ISRC registrant |
| `TERRITORY_GAP` | Has ISRC and statement match but no territory data | Request territory-level breakdown from CMO |
| `MANDATE_GAP` | Has ISRC, no statement match, no mandate on file | Client must register mandate with CMO before claims can proceed |
| `STATEMENT_ONLY_UNMATCHED` | Statement row found but no catalog match by ISRC or fuzzy | Investigate whether recording is in catalog; may be alias or compilation |
| `CATALOG_ONLY_NO_USAGE_EVIDENCE` | In catalog, no ISRC or statement — no basis for any claim | Source ISRC; provide to CMO for matching |
| `INSUFFICIENT_EVIDENCE` | No ISRC, no statement, no ownership declaration | Cannot proceed; request data per data request document |
| `MANUAL_REVIEW` | Fuzzy match candidate only — insufficient corroboration for auto-match | Human must confirm or deny match before further processing |

---

## 6. Interpreting Financial Totals

### Reconciliation fields

| Field | Meaning |
|-------|---------|
| `total_gross` | Sum of all gross_royalties rows from this source |
| `total_net_stated` | Sum of all net_royalties rows from this source |
| `total_fees` | Sum of all fee_amount deductions |
| `total_withholding` | Sum of all withholding_amount deductions |
| `implied_net` | `total_gross - total_fees - total_withholding` |
| `reconciles` | True if `total_net_stated ≈ implied_net` (within $0.01) |
| `reconciliation_gap` | `total_net_stated - implied_net` (non-zero = discrepancy) |

### Interest separation fields (per track)

| Field | Meaning |
|-------|---------|
| `featured_performer_gross` | Royalties attributable to Esham's featured-performer share |
| `rightsholder_gross` | Royalties attributable to Reel Life Productions / master-rightsholder share |
| `non_featured_gross` | Session musician / non-featured performer royalties |
| `other_gross` | Amounts with unknown claimant type |

**These four amounts must never be added together.** They represent separate economic interests that belong to different parties and are tracked separately to prevent double-counting.

### What "confirmed receivable" means

`confirmed_receivable_calculable: true` means the pipeline has **both** statement data and ownership evidence and can produce a partial dollar figure for matched recordings.

It does **not** mean that the amount is final, undisputed, or ready to collect. It is an audit figure that requires:
- Legal review of ownership declarations
- Client confirmation that the rightsholder data is accurate
- CMO validation before any claim submission

---

## 7. Resolving Exceptions

The `exceptions` array contains three types of entries:

### DUPLICATE_STATEMENT
Two rows with the same ISRC + period + territory + statement_ref + amount. Fix: verify source file was not exported twice; if intentional reissue, update the `statement_ref` to distinguish them.

### ISRC_CONFLICT
Same ISRC appears twice in a single period/territory combination with different amounts. Fix: request clarification from the CMO — this may indicate a split-payment record or correction.

### Manual review (fuzzy match only)
A track was matched to a statement row only via title/artist similarity, without ISRC corroboration. The pipeline sets `isFuzzyMatchOnly: true` and does not auto-assign the amount. A human operator must confirm or deny the match.

---

## 8. Resolving Exceptions Without Inventing Facts

Rules:
1. **Never edit a statement row's amount, ISRC, or period to make it match.** If a row doesn't match, quarantine it and investigate the source.
2. **Never infer master ownership from artist name alone.** Obtain a written declaration.
3. **Never confirm a fuzzy match without corroboration from at least 2 independent signals** (artist name + duration, or album + MBID, etc.).
4. **Never combine performer and rightsholder amounts** unless the same entity holds both interests and this is explicitly documented.
5. **Preserve original currency.** Never convert and then discard the original amount.

---

## 9. Producing a Client-Facing Recovery Report

The client-facing report (not this guide) should contain:
- Total recordings examined
- Classification breakdown (counts only — not dollar amounts unless ownership is confirmed)
- Confirmed paid amounts (from matched, paid statements, if any)
- Held/unpaid amounts (from matched, held statements, if any)
- Unclaimed opportunities (UNCLAIMED + MANDATE_GAP classifications, count only)
- Recordings with missing ISRCs (blockers to CMO matching)
- Recordings with ownership conflicts (blockers to claim submission)
- Recommended next actions (prioritized)
- Items requiring client authorization before proceeding

Do not include:
- Raw statement line items
- Internal audit classification codes (translate to plain language)
- Dollar amounts for `INSUFFICIENT_EVIDENCE` or `CATALOG_ONLY_NO_USAGE_EVIDENCE` tracks (there is no basis for an amount)
- Legal opinions or guarantees of recovery

---

## 10. What Requires Legal Review, Client Confirmation, CMO Action, or Production Approval

| Action | What's needed before proceeding |
|--------|--------------------------------|
| Submit any CMO claim or mandate | Client written authorization + legal review of ownership |
| Resolve an `OWNERSHIP_CONFLICT` | Legal review; do not resolve by guessing |
| Confirm fuzzy match | Human operator + client confirmation for recordings they know |
| Assign "owed" dollar amounts to client | Client confirmation of rightsholder status + legal sign-off |
| Write audit results to production database | PM approval + separate migration PR + human merge |
| Initiate SoundExchange search-and-claim | Requires client SoundExchange Direct credentials or mandate |
| Open dispute at any CMO | Legal review + client authorization |
| Apply graph backfill (`fn_backfill_catalog_to_graph`) | Separate PR + human approval (not part of this audit) |

---

## 11. Running the Test Suite

```
node tests/neighboring-rights-audit.test.js
```

Or via npm:

```
npm test
```

The test file covers all 22 scenarios listed in Phase 9. All assertions must pass before any audit run is considered validated.

No test requires network access, database credentials, or real client data.
