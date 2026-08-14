# Esham — Neighboring Rights Baseline Report

**Prepared by:** MusiGod Neighboring Rights Audit Pipeline v1.0.0  
**Date:** 2026-07-29  
**Audit type:** Dry-run — repository evidence only; no private statements imported  
**Production writes:** None  
**Credentials accessed:** None

---

## Verdict

**No defensible neighboring-rights receivable total can currently be calculated.**

No private SoundExchange payment statements, PPL statements, or other CMO usage/payment exports are present in this repository or in this audit run. No dollar amounts appear in this report because no transaction-, statement-, usage-, or CMO-grounded evidence is available.

This baseline documents what is known, what is missing, and what must be obtained before any dollar calculation can proceed.

---

## 1. Catalog Overview

| Metric | Value |
|--------|-------|
| Total catalog tracks | 196 |
| Tracks with enrichment data | 188 |
| Tracks with writer/composer data | 188 |
| Tracks with zero writer data (manual review) | 8 |
| Tracks with at least one ISRC | 152 |
| Tracks missing all ISRCs | 44 |
| Total unique ISRCs | 152 |
| Duplicate ISRCs (same ISRC on multiple tracks) | 0 |
| Malformed ISRCs | 0 |
| Multi-ISRC tracks | 0 |
| Tracks with MusicBrainz Recording MBID | 196 (100%) |

### ISRC coverage by release group

The 44 tracks missing ISRCs are concentrated in two releases:

| Release | Est. no-ISRC tracks | Note |
|---------|---------------------|------|
| Judgement Day, Volume 3: Ascending (2006) | ~18 | Pre-digital distribution era; ISRCs may exist at label/CMO |
| Esham's Erotic Poetry (year unknown) | ~2 | Undated EP; distribution unknown |
| Additional tracks from other releases | ~24 | Spread across catalog |

Missing ISRCs are not necessarily a sign of non-registration. They may exist in SoundExchange's or a distributor's system but have not been surfaced through MusicBrainz or Discogs. The SoundExchange catalog export (see data request) will resolve this.

---

## 2. Performer Associations (Current Evidence)

| Status | Result |
|--------|--------|
| Confirmed featured performer on all 196 tracks | **Not confirmed by explicit declaration** |
| Esham identity established in catalog | Yes — artist_name field, MusicBrainz MBID linkage |
| IPI number on file | Present for Esham in writer data for 188 tracks |
| ISNI | Not confirmed |
| Featured-performer declarations on file | **None** — no performer_roster import has been provided |
| Non-featured performer roster | **None** |

**Blocker:** No formal featured-performer declaration has been provided. SoundExchange and PPL require explicit registration as a featured performer, separate from registration as a songwriter or publisher. Esham's status as the performing artist on his own recordings is factually expected but is not documented in the format required for CMO claims.

---

## 3. Master / Rightsholder Associations (Current Evidence)

| Status | Result |
|--------|--------|
| Confirmed master rightsholder | **Not confirmed** |
| Reel Life Productions identified as likely rights entity | Referenced in production context, not confirmed by ownership declaration |
| Master ownership agreements on file | **None** |
| Distribution agreements confirming rightsholder | **None** |
| Label history on file | Partial — available through MusicBrainz and Discogs data for some releases |

**Blocker:** MusiGod does not assume master ownership based on artist name, songwriter registration, or uploading the recording. A written ownership declaration or agreement is required before any rightsholder-side royalty calculation can be supported.

---

## 4. CMO Registration Status

| Organization | Registration status |
|-------------|---------------------|
| SoundExchange (US) | **Unknown** — no catalog export provided |
| PPL (UK) | **Unknown** |
| SCPP / ADAMI (France) | **Unknown** |
| GVL (Germany) | **Unknown** |
| AURA / Gramex (Nordics) | **Unknown** |
| Other CMOs | **Unknown** |

The public SoundExchange unclaimed-artist search tool exists but returns only boolean found/not-found with `estimatedImpact: 0` — it cannot surface dollar amounts without account registration. No unclaimed results have been imported for this audit.

---

## 5. Territory and Mandate Coverage

| Status | Result |
|--------|--------|
| Territories of release | US, international — specifics unconfirmed beyond MusicBrainz data |
| Active mandate at any CMO | **Unknown** — no mandate documents provided |
| International neighboring-rights mandate | **Unknown** |

A mandate is required for a CMO to collect and remit royalties on behalf of a claimant. Without mandate documentation, even if royalties are accumulating at a CMO, they may be held as unmatched or distributed to the general fund after the holding period.

---

## 6. Recordings Ready for CMO Matching

| Tier | Count | Condition |
|------|-------|-----------|
| Strong candidates (have ISRC + MBID, no conflicts) | 152 | Ready for ISRC-based CMO matching once registration/mandate confirmed |
| Candidates requiring ISRC sourcing first | 44 | ISRC must be obtained from CMO, label, or distributor before matching |
| Blocked by zero writer data (may affect some CMO workflows) | 8 | Neighboring-rights matching does not require writer data; not blocked for neighboring rights specifically |
| Graph-linked tracks (`graph_catalog_links_v1`) | 3 | Graph linkage is a separate system; does not affect CMO matching readiness |
| Graph-unlinked | 193 | Graph backfill is a separate task; does not affect CMO matching readiness |

---

## 7. Prior Incident — Writer Data Recovery

In a prior session, a regression was detected in which 31 tracks had writer data replaced with empty arrays. This was identified and the tracks were verified as restored to EXACT_MATCH status. This incident is documented in `enrichment_recovery_manifest.json` and does not affect neighboring-rights processing.

---

## 8. Graph and Enrichment Infrastructure

The following existing infrastructure is relevant to neighboring rights but does not replace statement evidence:

| System | Status | Relevance |
|--------|--------|-----------|
| `graph_evidence_v1` | Deployed | Can store CMO evidence once imported |
| `graph_identifiers_v1` | Deployed | Can store ISRCs with source and confidence |
| `graph_investigations_v1` | Deployed | Supports `unclaimed_royalty_opportunity` investigation type |
| `catalog_enriched_tracks_v1` | Deployed | Stores ISRCs, MBIDs, writers; lacks performer and rightsholder fields |
| `lib/neighboring-rights-audit.js` | New (this session) | Read-only audit pipeline; zero DB writes |

Fields **not** currently in `catalog_enriched_tracks_v1`:
- `master_owner` / `rightsholder`
- `featured_performer`
- `territory`
- `mandate_status`

These fields would need to be added (in a separate tracked migration, with human review) once ownership and performer data is confirmed.

---

## 9. Genius Writer-Credit Findings (Adjacent, Not Blocking)

From the prior diagnostic (`ESHAM_8_TRACK_DIAGNOSTIC_RESULTS.md`):

| Status | Count | Implication for neighboring rights |
|--------|-------|-------------------------------------|
| FOUND_WITH_WRITERS on Genius | 0 of 8 writerless tracks | Writer credits do not affect neighboring-rights ISRC matching |
| FOUND_UNCREDITED on Genius | 5 of 8 tracks | Song pages confirm recording identity for these tracks; ISRCs still needed |
| NOT_FOUND on Genius | 3 of 8 tracks | Mail Dominance tracks listed as "?" entries on Genius |

Writer data is relevant for **publishing royalties** (PRO/MLC), not for neighboring rights. The 8 writerless tracks are not blocked for neighboring-rights analysis.

---

## 10. Evidence Required to Determine Dollars

To produce a defensible receivable calculation, the following must be obtained:

| Item | Type | Priority | Currently available? |
|------|------|----------|---------------------|
| Written authorization from Esham or representative | Legal | Required | No |
| SoundExchange payment statements (all years) | Statement | Required | No |
| Featured performer declaration | Legal/CMO | Required | No |
| Master ownership declaration | Legal | Required | No |
| SoundExchange catalog export | CMO export | High | No |
| SoundExchange unclaimed/search-and-claim results | CMO export | High | No |
| International CMO statements (PPL, GVL, etc.) | Statement | High | No |
| Territory mandate documentation | Legal/CMO | High | No |
| ISRCs for 44 missing tracks | Metadata | Medium | No |
| Distributor statements | Statement | Medium | No |

---

## 11. Recommended Next Steps

In priority order:

1. **Obtain written client authorization** — required before any CMO action.
2. **Provide SoundExchange data request response** per `ESHAM_NEIGHBORING_RIGHTS_DATA_REQUEST.md`.
3. **Confirm Reel Life Productions as rightsholder** for all or part of the catalog — specific releases or a catalog-wide declaration.
4. **Source ISRCs for 44 missing tracks** — contact original distributor/label or request SoundExchange unmatched report.
5. **Register mandate at SoundExchange** if not already registered — required before any collection can begin.
6. **Investigate PPL registration** for UK performance royalties.
7. **Run pipeline again** with actual statement data once items 1–4 are complete.

---

## Audit Integrity Notes

- This report was produced from repository data only. No private statements, contracts, credentials, or tax documents were accessed.
- No CMO portals, external APIs, or databases beyond the local repository were queried.
- No production database writes occurred.
- All dollar columns in this report show zero or "not calculable" because no statement evidence exists in this run.
- The audit pipeline (`lib/neighboring-rights-audit.js`) requires `dryRun: true` and will throw if called otherwise.
