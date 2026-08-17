# HarbourView Portfolio Rights Integrity Pilot — Build Contract

## Product boundary

The pilot ingests a customer-authorized portfolio sample, creates canonical records with provenance, applies only sourced and human-reviewed rules, produces correction packages for human approval, and assembles chain-of-title evidence for legal review.

It does not claim universal society connectivity, submit corrections without authorization, make final legal ownership determinations, or represent MESA-1 as SOC 2 certification.

## Initial source adapters

| Source | Pilot path | Future path |
|---|---|---|
| SoundExchange | HarbourView-authorized CSV/XLSX exports | Official API or partner exchange after written access |
| ASCAP/BMI/SESAC/MLC | Authorized exports and current bulk formats | Direct or administrator-authorized exchange |
| Distributor/DSP | CSV, XLSX, DDEX, or SFTP delivery | Managed recurring connectors |
| Acquisition records | Schedules and document manifests | Deal-room ingestion connector |

## Human gates

1. A royalty rule cannot drive matching while its status is `draft`.
2. A correction package cannot become `approved`, `submitted`, or `accepted` without an identified approver and approval timestamp.
3. Extracted agreement terms remain unverified until reviewed.
4. A system finding never has legal effect.
5. Only an authorized legal reviewer may record a final ownership determination.

## Pilot acceptance criteria

- Duplicate source files are detected by organization-scoped SHA-256 hash.
- Every normalized record retains source, source identifier, import time, transform version, and input hash.
- Tenant-isolation policies prevent cross-organization reads.
- Each active royalty rule contains an authority source, effective dates, version, and reviewer.
- Each correction package validates against a versioned destination specification.
- Every package preserves evidence and an output hash.
- Chain-of-title output distinguishes facts, inferences, conflicts, missing evidence, and legal questions.
- No live external submission occurs during validation tests.
- Security control evidence is append-only.

## Delivery sequence

1. Apply `20260816000000_enterprise_foundation_v1.sql` in a non-production environment.
2. Seed MusiGod and the pilot organization; assign named reviewers.
3. Configure authorized sources without storing credentials in source control.
4. Load destination specifications and sourced U.S. rules.
5. Run an artificial dataset through import, reconciliation, correction, and title-review gates.
6. Complete MESA-1 evidence collection and independent penetration testing.
7. Admit the restricted HarbourView sample after written authorization.
