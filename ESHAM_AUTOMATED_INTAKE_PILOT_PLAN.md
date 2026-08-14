# Esham Automated Intake Pilot Plan

**Pilot ID:** `pilot-001`  
**Configuration:** `lib/intake-config.js → PILOT_CATALOG_CONFIGS['pilot-001']`  
**Status:** Planning phase — no client invitations sent  
**Do not send:** No outreach, invitations, claims, or portal access until engagement agreement is attorney-approved

---

## Catalog Baseline

| Metric | Value | Source |
|--------|-------|--------|
| Total catalog tracks | 196 | MusicBrainz enrichment (verified) |
| Tracks with ISRCs | 152 | 77.6% coverage |
| Tracks missing ISRCs | 44 | Concentrated in two releases |
| Tracks missing writer data | 8 | Does NOT block neighboring rights intake |
| Tracks with MusicBrainz MBIDs | 196 | 100% MBID coverage |
| ISRC duplicates | 0 | Verified clean |

**ISRC gap concentration:**
- *Judgement Day Vol. 3* (2006) — ISRC data unavailable
- *Esham's Erotic Poetry* — ISRC data unavailable

**Key baseline document:** `ESHAM_NEIGHBORING_RIGHTS_BASELINE.md`

---

## Pilot-Specific Requirements

### 1. Featured-Performer Confirmation (Mandatory)
Esham must confirm his featured-performer identity and role for each recording or release group. This is required because:
- Neighboring rights attach to sound recordings, not compositions.
- Featured-performer status determines the rate split between featured performer and non-featured performers.
- SoundExchange requires performer identity confirmation for claims.

### 2. Master Ownership Evidence (Mandatory)
All 196 recordings require documented ownership or exclusive license evidence. The primary candidate is:

**Reel Life Productions** — unverified ownership candidate.  
Status: NOT CONFIRMED. Must not be treated as confirmed until documentation is received.  
Required evidence: Recording agreements, work-for-hire agreements, or entity formation documents establishing that Reel Life Productions owns or exclusively licenses the masters.

### 3. Writerless Tracks (Do Not Block)
8 tracks have no writer data in the MusicBrainz enrichment. These tracks are NOT blocked for neighboring rights intake because:
- Neighboring rights (sound recording performance royalties) attach to the master recording, not the composition.
- Writer data is irrelevant to SoundExchange neighboring rights claims.
- These 8 tracks should proceed through the neighboring rights intake identically to the other 188 tracks.

### 4. Missing ISRCs (Document, Do Not Block)
44 tracks have no ISRC. The intake workflow should:
- Document the ISRC gap in the intake record.
- Proceed with the 152 ISRC-identified tracks.
- Flag the 44 missing-ISRC tracks for ISRC remediation as a separate workstream.
- Not block the intake or the audit on ISRC remediation.

### 5. SoundExchange Statements — All Available Years
Request all available payment and adjustment statement years from SoundExchange Direct. The baseline audit cannot calculate outstanding amounts without this data.

### 6. International Mandate Status
Request information on any existing international collection mandates (PPL, GVL, or other CMO appointments). If no mandates exist, document that fact.

---

## Pilot Workflow Sequence

1. Attorney approval of engagement agreement and LOA language ← **CURRENT BLOCKER**
2. Configure e-sign provider (paid vendor selection required)
3. Create intake workflow record in `intake_workflows_v1`
4. Send invitation to artist
5. Artist completes identity questionnaire (including featured-performer role)
6. Send engagement agreement
7. Agreement signed → send LOA
8. LOA signed → direct to export center with pilot-specific guide
9. Artist exports and uploads: SoundExchange catalog, payments (all years), search-and-claim
10. Artist exports and uploads: distributor statements (ISRC corroboration)
11. Artist provides master ownership evidence for Reel Life Productions (or alternative entity)
12. Operator validates all documents
13. Operator marks featured-performer declaration valid
14. Completeness engine confirms all 7 mandatory items VALID
15. Generate audit manifest (dryRun: true)
16. Human review of manifest before proceeding to live audit
17. Audit handoff to `lib/neighboring-rights-audit.js` pipeline
18. Audit results reviewed with artist; recovery opportunities identified
19. Any claim action requires separate explicit artist authorization

---

## Separation of Interests

Per `lib/neighboring-rights-audit.js`, these interest types are tracked separately and never combined:
- `featured_performer_gross` — Esham's share as featured performer
- `rightsholder_gross` — Reel Life Productions or other master rightsholder share (pending confirmation)
- `non_featured_gross` — Held separately by SoundExchange; requires separate performer roster
- `other_gross` — All other categories

---

## Commercial Configuration

- **Tier:** Individual (pilot terms pending attorney review)
- **Contingency:** 15% of money actually recovered through documented MusiGod work only
- **Excludes:** Royalties already being paid correctly; pre-engagement distributions
- **Billing activation:** BLOCKED — requires attorney-approved engagement language

---

## Constraints

- Do not submit claims, change payment instructions, or communicate with SoundExchange on behalf of this artist without a separate authorized action.
- Do not confirm Reel Life Productions as the master rightsholder without documentation.
- Do not treat ISRC matches as proof of ownership or entitlement.
- All documents containing Esham's private financial data must remain on the secure document vault path — never in API responses or email.
