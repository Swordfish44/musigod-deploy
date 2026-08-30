# MusiGod Rights Title Report — 12-Month Build Plan

**Status:** Draft for review. Produced by inspecting the live `Swordfish44/musigod-deploy` repo (branch `master`, commit `5f2179f`) on 2026-08-30 — not from prior planning docs. Live Supabase schema (project `uykzkrnoetcldeuxzqyy`) has not yet been queried directly; every claim below is repo-verified unless flagged `[needs live verification]`.

**Strategic objective (as stated by founder, Aug 2026):** MusiGod is the definitive evidence-backed database of who owns what in music. Publishing administration, royalty recovery, contract intelligence, statement ingestion, and enterprise rights analysis are products and data-acquisition mechanisms feeding that core asset. The Ownership Graph is the system of record. This document scopes the flagship product that makes that asset visible and sellable: the **MusiGod Rights Title Report**.

---

## Executive summary — what inspection actually found

The repo is materially further along than any prior planning document reflects. `CLAUDE.md`'s own "current build context" is dated June 2026 and is already stale — the migrations directory runs through 2026-08-30 (today). Three things change the shape of this plan versus a greenfield read of the strategic framework:

1. **Most of the data model this plan would ask for already exists**, split across three subsystems that were built at different times and are not yet unified:
   - The **evidence graph** (`public.graph_nodes_v1`, `graph_edges_v1`, `graph_evidence_v1`, `graph_identifiers_v1`, `graph_investigations_v1`, `graph_confidence_history_v1`, `graph_node_history_v1` — migrations `20260701*`). This is, almost verbatim, the "evidence is never overwritten, confidence is earned" model the strategic framework calls for. It has a working backfill (`fn_backfill_catalog_to_graph`) from the Esham catalog and opens structured investigations for gaps (missing ISWC, missing IPI, ownership conflicts, etc.) automatically.
   - The **partner-facing graph** (`graph.nodes`, `works.compositions`, `works.recordings`, `rights_split_allocations_v1`, `rights_registrations_v1`) that `api/graph-sync.js` writes to and `api/partner/resolve-rights.js` reads from. This is what a DSP or AI platform actually queries today via the documented Partner Rights Resolution API.
   - The **Contract Intelligence / royalty_intelligence schema** (`contract_families_v1`, `contract_records_v1`, `contract_documents_v1`, `extracted_terms_v1`, `statement_imports_v1`, `reconciliation_results_v1`, `discrepancies_v1`, `recovery_cases_v1`, `review_tasks_v1`, `audit_events_v1`) behind `api/contract-intelligence.js`. This one is worth calling out specifically: `audit_events_v1` is a **hash-chained, append-only audit log** (`event_hash` derived from `payload_hash + previous_event_hash + timestamp`) — that's genuine tamper-evident recordkeeping, not just a timestamped table.

2. **The evidence graph and the partner graph do not share an identity space.** `ai_consent_v1.work_id` references `public.graph_nodes_v1(id)` — the evidence graph. `api/partner/resolve-rights.js` resolves identity through `works_compositions_v1.node_id` / `works_recordings_v1.node_id` — the partner graph. These are two different UUID spaces populated by two different write paths (`fn_sync_track_to_graph` vs. `graph-sync.js`'s `upsertNode`/`upsertRecordingEnrichment`). Nothing in the repo bridges them except `graph_catalog_links_v1`, which links `catalog_enriched_tracks_v1` rows to evidence-graph nodes only — it does not touch the partner graph at all. **This is the single biggest architectural fact this plan has to design around**, and it wasn't visible from prior planning notes.

3. **A commercial product matching almost exactly what was asked for already exists as a sold offer**, not just a concept: `docs/commercial/PORTFOLIO_RIGHTS_INTEGRITY_DIAGNOSTIC.md` is a fully scoped, priced ($7,500 fixed fee), 10-point-deliverable diagnostic with a written outreach email and qualification-call script, explicitly separating system findings from legal determinations. `docs/enterprise/HARBOURVIEW_PILOT_BUILD.md` names a real pilot counterparty (HarbourView, a catalog buyer) with human-gated correction workflows and MESA-1 security evidence collection already scaffolded (`20260816000000_enterprise_foundation_v1.sql` onward). **The Title Report is not a new product idea — it's the missing composition layer over work that is already sold and already partially built.**

Given this, the highest-leverage 12 months are not "build a title plant from nothing." They are: (a) reconcile the two graph identity spaces, (b) compose the Title Report as the missing read layer over data that already exists in three places, (c) close the master-ownership and chain-of-title gaps that are real, and (d) turn the HarbourView pilot into the proof case.

---

## Phase 1 — Rights Title Report v1

**Objective:** A production report, generated from what already exists, representing every ownership/control assertion as `Party X owns/controls Y% of Right Z in Asset A, in Territory B, during Time Period C, supported by Evidence E` — without collapsing conflicting claims.

| Requirement | State |
|---|---|
| Composition ownership | **Exists** — `rights_split_allocations_v1` (queried by `resolve-rights.js`), plus writing-credit evidence in `graph_evidence_v1`. Real data volume unverified `[needs live verification]`. |
| Master ownership | **Needs to be built.** `works_recordings_v1.master_rights_holder` is a single free-text field — no percentage splits, no multi-party structure, no evidence backing. This is the weakest part of the whole ownership model today. |
| Beneficial vs. legal ownership | **Needs to be built.** No field anywhere distinguishes beneficial from legal ownership; `rights_split_allocations_v1` has one `role` field (writer/publisher/administrator), not this distinction. |
| Administration/control | **Exists** — `edge_type = 'administers'`-style relationships are supported by the edge schema (`owns_publishing`, `administration_right` claim type exists in `graph_evidence_v1`'s enum); actual population unverified `[needs live verification]`. |
| Writer/artist/producer interests | **Exists** — `writing_credit`, `recording_credit` claim types in `graph_evidence_v1`; `performed`/`performed_by` edges. |
| Publisher/label relationships | **Partial.** Publisher shows up as a `role` in splits and as an `evidence_claim_type`, but there's no dedicated publisher/label entity table with its own attributes — publishers exist only as graph nodes with minimal properties. |
| PRO/CMO affiliations | **Exists** — `rights_registrations_v1` (registrar, registration_number, status), plus `member_of_society` edges in `graph-sync.js`. |
| Territory | **Exists in schema, likely thin in data.** `territory_scope` on splits, `territory_ids` param on edges. `[needs live verification]` on actual coverage beyond "WORLD"/"US". |
| Effective dates | **Schema exists, not populated.** `graph_upsert_edge` RPC accepts `effective_from`/`effective_until` — every call site in `graph-sync.js` passes `null` for both. The capability is there; nothing uses it yet. |
| Assignments / acquisitions / reversions / terminations | **Needs to be built.** No first-class event type for these exists anywhere in the graph. `investigation_type` enum has no `reversion` or `assignment_recorded` value. This is real Phase 2 work, not a v1 gap. |
| Liens / encumbrances | **Needs to be built.** No representation anywhere. |
| Licenses | **Needs to be built** for the general case; AI-licensing specifically is covered by `ai_consent_v1` (Lane A), which is a license-adjacent but narrower concept. |
| Conflicting claims, preserved not collapsed | **Exists, underused.** `graph_evidence_v1.status` includes `disputed`; `graph_investigations_v1.investigation_type = 'ownership_conflict'` with structured `findings` (`source_a`, `share_a`, `source_b`, `share_b`, `delta`) is exactly the "preserve competing claims" model asked for. It exists as schema and is auto-populated for some gap types, but not for ownership-percentage conflicts specifically yet — `fn_sync_track_to_graph` opens investigations for missing ISWC/ISRC/writers/IPI, not for conflicting share percentages. |
| Source evidence / provenance | **Exists and is genuinely strong** — `source_type`, `source_url`, `source_ref`, `raw_payload`, `confidence`, `confidence_rationale` on every evidence row. |
| Confidence | **Exists** — numeric confidence per evidence row and per edge, with a full change-history table (`graph_confidence_history_v1`). |
| Human-reviewed vs. machine-inferred | **Exists as raw material, not as a labeled field.** `evidence_source_type` distinguishes `admin_manual`/`artist_submission` (human) from `inference`/`enrichment_pipeline`/`web_scrape` (machine); `graph_investigations_v1.generated_by` (`system`/`agent`/`human`/`partner_api`) does the same for investigations. Contract Intelligence's `review_tasks_v1` and `authoritative: false` flag on contract records add a second, independent human-review gate. No single "is this human-confirmed?" boolean exists yet across all three subsystems — worth adding as a computed field in the report layer rather than a new column. |

**What can ship immediately (no schema change):** A composed, read-only Title Report endpoint that queries all three existing subsystems for a given work and structures the response per the model above, explicitly surfacing `resolution_state: contested` wherever `graph_evidence_v1` has multiple non-superseded rows for the same claim, or an open `ownership_conflict` investigation exists. **Built as part of this PR** — see `api/get-rights-title-report.js`.

**What needs building before v1 is complete:** master-ownership splits (schema), beneficial/legal ownership distinction (schema), a `human_confirmed` computed flag in the report layer, and conflict-detection logic that actually diffs share percentages across sources rather than relying on gap-type investigations alone.

---

## Phase 2 — Chain of Title

**Objective:** Answer not just "who owns this" but "who owned this, when, how did they obtain it, from whom, under what instrument, and what changed."

**Finding:** This is the least-built phase relative to what the strategic framework asks for, but the schema is closer than it looks. `graph_edges_v1` already carries `effective_from`/`effective_until` (unused), and `graph_node_history_v1` already logs node-level state transitions (`created`, `updated`, `merged`, `split`, `deprecated`, `superseded`, `restored`) with before/after snapshots. What's missing is the **edge-level** equivalent — there is no `graph_edge_history_v1`. An ownership edge changing (a share percentage changing, an edge being superseded by an assignment, an edge terminating on a reversion date) is currently invisible; only the node it points to has a history table, not the relationship itself. `graph_confidence_history_v1` logs confidence changes on edges, but confidence and terms are different things — a 100%-confidence edge can still expire on a reversion date.

**Needs to be built:**
- `graph_edge_history_v1` — mirrors `graph_node_history_v1` structurally, logs every edge state change (share change, status change, supersession, termination) with `change_reason` and `change_source`.
- An explicit `ownership_event` concept: either a new `investigation_type`/`evidence_claim_type` pair (`assignment_recorded`, `reversion_recorded`, `termination_recorded`) or a dedicated `graph_ownership_events_v1` table if the event needs its own structured fields (instrument reference, prior party, new party, effective date, source document). Recommendation: dedicated table — ownership events need to reference source documents (which ties directly into Contract Intelligence's `contract_documents_v1`), and overloading the evidence-claim model would blur "this is a fact about ownership" with "this is an event that changed ownership."
- Actually populating `effective_from`/`effective_until` on write — currently dead columns.

**Tag:** Needs to be built (schema + write-path changes). Non-money schema — agent-buildable per `CLAUDE.md`. Not attempted in this PR; recommend as the first follow-up PR after live-schema verification, since it touches the same tables Contract Intelligence and the evidence graph both write to.

---

## Phase 3 — External Ownership Data: source-by-source acquisition plan

| Source | Category | Rights/data | Authority | Access mechanism | Update frequency | Identifiers | Priority |
|---|---|---|---|---|---|---|---|
| MusicBrainz | 1. Public/open, ingestible now | Recordings, works, artists, relationships | Community-maintained, high coverage, variable accuracy | Public API/dumps — **already integrated** (`db/mb-corpus`, `esham_mb_scraper.py`, `MUSIGOD_MUSICBRAINZ_INGESTION.md`) | Continuous | MBIDs | Already shipping |
| Discogs | 1. Public/open | Release/label/credit metadata | Community-maintained | Public API — **already integrated** (tier 2 of enrichment fallback) | Continuous | Discogs IDs | Already shipping |
| Genius | 1. Public/open | Lyrics/writer credits | Crowd-sourced, lower confidence | Public API — **already integrated** (tier 3 fallback) | Continuous | — | Already shipping |
| U.S. Copyright Office | 1. Public/open, restricted automation | Registration records | Authoritative for registration | Public search, no bulk API; scraping restricted by ToS | Static per record | — | Not started — legal review needed before any automated collection |
| ASCAP/BMI/SESAC public search | 2. Public, access-restricted | Registration + writer/publisher | Authoritative for PRO membership | Public search UIs only; `ascap_public`/`bmi_public`/`sesac_public` already exist as `evidence_source_type` enum values, meaning the schema anticipated this before any integration was built | Static per lookup | IPI, PRO work IDs | Medium — schema-ready, no scraper built |
| MLC (Mechanical Licensing Collective) | 3/5. Partial API, partnership for full access | Mechanical ownership, matched/unmatched works | Statutory body, high authority for mechanical rights in the US | Public bulk data exists in limited form; full access typically requires registration as a rightsholder or administrator | Periodic | ISWC, MLC work ID | **High** — directly strengthens the composition side, `mlc_work` identifier namespace already modeled |
| SoundExchange | 5/6. Partnership/private, outreach already drafted | Neighboring-rights (master) royalties, featured/non-featured performer data | Authoritative for digital performance royalties | API access requires request — **`SOUNDEXCHANGE_API_ACCESS_REQUEST.md` and outreach email already drafted in-repo**; status of actual outreach unverified `[needs live verification — check email/CRM]` | Periodic | ISRC | **Highest** — most actionable: BD groundwork already done, and it's the direct data source for the neighboring-rights recovery product already being built (`MUSIGOD_NEIGHBORING_RIGHTS_RECOVERY_PRODUCT.md`) |
| DDEX ERN deliveries | 3/4. API/commercial, distributor-dependent | Release/track metadata at ingestion | High, distributor-authoritative | Requires distributor/DSP relationship | Per release | UPC, ISRC | Low near-term — no distributor relationship yet visible in repo |
| Contract documents (rightsholder-provided) | 6. Private evidence | Chain of title, splits, term, territory | Highest — primary source | Already has an intake path: `contract_documents_v1` + SHA-256 dedup + OCR (`real_ocr_execution_v1`, the most recent commit in the repo) | Per upload | — | **Already shipping** — this is arguably ahead of the external-source work |
| Royalty statements (rightsholder-provided) | 6/7. Private evidence + self-generated | Payment/control evidence, reconciliation | High for what was actually paid | `statement_imports_v1`, large-statement ingestion, specialized workers, real OCR — **all shipped in the last two weeks of commits** | Per statement | — | Already shipping |
| Acquisition/HarbourView portfolio data | 5. Partnership-only | Historical rights data at scale | Authoritative per deal | `harbourview_portfolio_analysis_v1`, `harbourview_asset_exceptions_v1` — schema exists, pilot in progress per `HARBOURVIEW_PILOT_BUILD.md` | Per engagement | — | Already shipping (pilot stage) |
| MusiGod's own operations (registrations, enrichment runs, recovery cases) | 7. Self-generated | Every category above | High — direct observation | Already the primary evidence source today | Continuous | — | Already the dominant source |

**Note on the instruction not to bypass access controls:** the repo already reflects this discipline — every external-facing doc (`HARBOURVIEW_PILOT_BUILD.md`, the diagnostic offer) requires written authorization before any real data is processed, and the enum-level anticipation of PRO "public search" sources without a scraper built suggests a prior decision was already made not to automate around access restrictions. This plan doesn't change that posture.

---

## Phase 4 — Entity Resolution

**Objective:** Determine when differently formatted names represent the same person/party/asset, with evidence-backed, reversible merges.

**Finding — this phase has to start with MusiGod's own two graphs, not external entities.** The framework as written assumes entity resolution is primarily an external-data problem (matching "Bloodstone" across five sources). That's real, but the more urgent instance of the same problem is internal: the evidence graph and the partner graph maintain separate identities for what should be the same node, with no resolution table between them at all.

**Exists:**
- `graph_identifiers_v1` — exactly the "multiple namespaces per node, full history, confidence-weighted" identifier registry the framework calls for, with `fn_resolve_node_by_identifier` already doing highest-confidence resolution by namespace+value.
- Merge/split are first-class `node_change_type` values (`merged`, `split`) in `graph_node_history_v1`, so reversible merges are architecturally anticipated even though no merge UI/logic exists yet.

**Needs to be built:**
- **Cross-graph identity bridge** (highest priority — see Executive Summary). Concretely: a `graph_node_identity_bridge_v1` table mapping `evidence_graph_node_id ↔ partner_graph_node_id ↔ catalog_enriched_tracks_v1.id`, populated by matching on shared identifiers (ISRC/ISWC/MBID) where they exist on both sides, with confidence-scored, evidence-backed rows — using the exact same evidence model already built, applied reflexively to MusiGod's own data.
- Fuzzy name matching for parties without identifiers (the `identity_ambiguity` investigation type already exists in the enum — it's just not wired to any matching logic yet).
- A merge workflow (UI + API) that actually uses the existing `merged`/`split` history types — currently nothing writes them.

**Tag:** Needs to be built. Non-money schema — agent-buildable. This is the second-highest-priority follow-up after the Title Report composition layer, because nothing in Phase 1 or Phase 6 works reliably across both graphs until it exists.

---

## Phase 5 — MusiGod Ownership Confidence

**Objective:** Evidence-weighted confidence that distinguishes verified fact from inference without manufacturing false certainty.

**Finding: this is the most mature part of the entire system.** `graph_evidence_v1` already has a 20-value `evidence_source_type` enum ranked implicitly by the confidence values assigned at insertion time in `fn_sync_track_to_graph` (MusicBrainz writing credits: 0.85, Discogs: 0.70, Genius: 0.60, unspecified: 0.50), `graph_confidence_history_v1` logs every change with `supporting_evidence_count`/`conflicting_evidence_count` and a required `reason`, and `graph_investigations_v1.generated_by` separately tracks whether a finding came from `system`/`agent`/`human`/`partner_api`. Contract Intelligence adds a second, independent confidence gate: `contract_records_v1.authoritative` (boolean, defaults false) and `execution_status = 'UNSIGNED_DRAFT'` — nothing is treated as authoritative until a human reviewer changes that status via `review_tasks_v1`.

**What's genuinely missing:**
- The confidence *tiers* the framework asks for (verified fact / authoritative-source assertion / documentary evidence / rightsholder assertion / third-party assertion / MusiGod inference / conflicting evidence / unresolved claim) exist as raw ingredients (`source_type` + `status` + `generated_by` + `authoritative`) but nowhere are they **collapsed into one displayable tier** for a report reader. This is a report-layer computation, not a schema change — recommend a pure function, not a new table, so the underlying evidence stays granular and the tier is always re-derivable rather than another value to keep in sync.
- Written-down confidence *calculation* logic doesn't exist yet beyond the fixed per-source constants in `fn_sync_track_to_graph`. Recommend: confidence should be a function of source authority (fixed weight per `source_type`) × corroboration (count of independent non-conflicting sources) × recency, with the formula itself versioned in `graph_confidence_history_v1.reason` so it can be audited and changed without losing history. Not implemented in this PR — flagging as a designed-but-unbuilt piece, since getting the weights right deserves its own review rather than shipping silently inside the report endpoint.

**Tag:** Mostly exists; the tier-collapsing function is safely buildable now (pure computation over existing data, no schema change) and is included in the Title Report endpoint shipped with this PR.

---

## Phase 6 — Rights Title Search

**Objective:** Search song/recording/artist/writer/producer/publisher/label/company/catalog/ISRC/ISWC/IPI/CAE and traverse the graph.

**Finding:** No dedicated search endpoint exists today. The closest analogs are `api/get-catalog.js` (catalog-scoped, not graph-wide) and the partner API's single-identifier lookup (`resolve-rights.js`, which requires an exact ISRC/ISWC/ID — no fuzzy or cross-entity search). `graph_identifiers_v1` and `fn_resolve_node_by_identifier` already provide the exact-match backend a search feature would sit on top of; there's no ILIKE/fuzzy layer, no ranking, and no traversal-from-result-to-related-entities UI.

**Tag:** Needs to be built — genuinely new work, both API and UI (`catalog-intake.html`/`admin-intelligence.html` are the closest existing UI patterns to extend). Depends on Phase 4's entity bridge to be useful across both graphs, not just one. Not attempted in this PR — this is a Bloomberg-terminal-shaped feature that deserves its own design pass once the Title Report composition layer and identity bridge exist to search over.

---

## Phase 7 — Institutional Title Product

**Objective:** What's needed for the Title Report to be useful in acquisitions, financing, lending, diligence, audits, disputes, estate administration, transfers, publisher/label acquisitions — with a clean line between MusiGod's informational output and attorney opinion/certification/regulated activity.

**Finding: this phase is already substantially built as a commercial offer**, not a future plan. `docs/commercial/PORTFOLIO_RIGHTS_INTEGRITY_DIAGNOSTIC.md` explicitly excludes "legal opinions or final ownership determinations," "audit, tax or accounting opinions," and "guaranteed recovery values or payment promises" — precisely the separation the strategic framework asks for. `docs/enterprise/HARBOURVIEW_PILOT_BUILD.md`'s human gates ("A system finding never has legal effect," "Only an authorized legal reviewer may record a final ownership determination") do the same at the workflow level, not just the contract level.

**What's missing:** the Title Report *artifact itself* — the diagnostic sells a "Rights Recovery Report" as a deliverable, but that report is presumably assembled manually/semi-manually today, not generated from a single composed endpoint. Once Phase 1's endpoint exists, the diagnostic's deliverable and the Title Report become the same underlying object rendered for different audiences (partner API = machine-readable; diagnostic report = human-readable PDF/HTML). That convergence is the actual Phase 7 work: point the existing $7,500 diagnostic's report generation at the new composed endpoint instead of (presumably) hand-assembly, and audit-trail every report issuance through `audit_events_v1`'s hash chain so a delivered Title Report is itself tamper-evident.

**Tag:** Mostly exists commercially; needs the technical convergence above. Non-money, non-consent — agent-buildable, but sequenced after Phase 1's endpoint is validated.

---

## Phase 8 — Title Insurance Path

**Objective:** What data quality, legal process, underwriting standards, claims history, and partnerships would eventually let an established insurer rely on a MusiGod Rights Title Report — without MusiGod underwriting anything itself.

This one is deliberately not an engineering phase. What it needs, in order:

1. **A claims-history-worthy track record** — meaning Title Reports that have actually been relied on (via the diagnostic product and HarbourView-style pilots) with no material errors surfacing after the fact. This can't be accelerated; it has to accumulate.
2. **Standardized confidence tiers with documented methodology** (Phase 5's collapsing function, written down and stable) — an insurer's actuaries need to be able to map MusiGod confidence tiers to their own risk categories.
3. **A legal-review layer that is more than a human clicking "approved"** — likely an actual attorney or accredited title examiner signing off on a sample of reports, with that sign-off itself recorded as evidence (the schema already supports this: `resolved_by_user_id`, `resolution_notes` on investigations; would need an analogous "certified by" field on the report object itself, tagged separately from ordinary human review).
4. **A specialty underwriter conversation**, not a general title insurer — music rights title insurance would most plausibly emerge from an E&O/IP-specialty underwriter (the kind that already prices media E&O and IP indemnity), not a real-estate title insurer directly. This is a partnership/BD path, not a build.

**Tag:** Requires legal/regulatory work and commercial partnership — no code in this PR. Revisit once Phase 7's convergence has produced enough real, relied-upon reports to have a track record to show an underwriter.

---

## Phase 9 — Data Flywheel

Mapped against what's actually wired today, not aspirationally:

| Activity | Feeds the graph via | Status |
|---|---|---|
| Publishing administration (registration) | `register-artist.js` → `graph-sync.js` | Wired |
| Registrations | `rights_registrations_v1` | Wired (partner graph) |
| Royalty statements | `statement-ingestion.js`, `submit-statement.js`, OCR pipeline → `statement_imports_v1`, `reconciliation_results_v1` | Wired (Contract Intelligence schema), **not yet bridged to the evidence or partner graphs** |
| Contract intelligence | `contract-intelligence.js` → `contract_records_v1`, `extracted_terms_v1` | Wired, same bridging gap |
| Royalty reconciliation → discrepancy evidence | `discrepancies_v1`, `recovery_cases_v1` | Wired within Contract Intelligence schema only |
| Enterprise portfolio ingestion | `api/enterprise/*` → `harbourview_portfolio_analysis_v1` | Wired (pilot-scoped) |
| Catalog diligence → chain-of-title evidence | HarbourView pilot workflow | Wired at the pilot level; not yet generalized |
| Acquisitions → historical rights data | No dedicated path yet | Depends on Phase 2 |
| Human review → resolved ownership | `review_tasks_v1`, `graph_investigations_v1.resolved_by_user_id` | Wired in both Contract Intelligence and the evidence graph, independently |

**The real finding here:** the flywheel described in the strategic framework is already spinning, but it's currently **three separate flywheels** (evidence graph, partner graph, Contract Intelligence) rather than one. Every phase above that closes a bridging gap (Phase 4 especially) is what turns three flywheels into one — that's the actual mechanism by which "every transaction makes the graph more valuable," and it's a data-architecture fact, not a metaphor.

---

## Phase 10 — 12-Month Execution Roadmap

Scoped to avoid inflating what already exists. Months where nothing new is listed means prior months' work is landing/stabilizing.

**Month 1 (this PR + immediate follow-ups)**
- Ship: composed Rights Title Report endpoint (read-only, no schema change) — **done in this PR**.
- Ship: this roadmap document, committed to the repo so it's read by future agent runs the way `CLAUDE.md` is.
- Start: live-schema verification of `graph.nodes`/`works.*`/`rights_*` tables (needs Supabase credentials — not yet provided this session).
- Start: confirm actual SoundExchange outreach status (Phase 3, highest-priority external source) — this is a BD task, not engineering.

**Month 2**
- Build: `graph_node_identity_bridge_v1` (Phase 4) — reconcile evidence graph ↔ partner graph for the Esham catalog first (known-good test set), then generalize.
- Build: conflict-detection logic that diffs share percentages across sources into `ownership_conflict` investigations (Phase 1 gap).

**Month 3**
- Build: `graph_edge_history_v1` + populate `effective_from`/`effective_until` on write (Phase 2, part 1).
- Design (no build yet): `graph_ownership_events_v1` schema for assignments/reversions/terminations, reviewed against real HarbourView pilot cases so the schema is shaped by an actual acquisition, not a hypothetical one.

**Month 4**
- Build: `graph_ownership_events_v1` (Phase 2, part 2) — needs-human-merge if it touches anything the royalties/legal schemas reference; otherwise agent-buildable.
- Build: master-ownership split table, mirroring `rights_split_allocations_v1`'s structure for the master side (Phase 1 gap).

**Month 5**
- Converge: point the $7,500 Portfolio Rights Integrity Diagnostic's report generation at the Title Report endpoint (Phase 7).
- Build: confidence-tier collapsing function formalized with a written, versioned methodology (Phase 5).

**Month 6**
- Build: Rights Title Search v1 — exact + fuzzy identifier and name search over the bridged graph (Phase 6).
- Checkpoint: first HarbourView-pilot-derived Title Report delivered and relied upon, if the pilot has progressed that far — this is the first data point toward Phase 8's track record.

**Months 7–9**
- External data: MLC bulk data ingestion (Phase 3) — priority behind SoundExchange because it requires more integration work per the access-mechanism research.
- External data: SoundExchange API integration, assuming Month 1's BD outreach converted.
- Harden: entity-resolution fuzzy matching (Phase 4) generalized beyond exact-identifier bridging.

**Months 10–12**
- Institutional packaging: Title Report as a certified, versioned, hash-chain-audited deliverable format (Phase 7 completion).
- Begin specialty-underwriter conversations (Phase 8) — commercial/legal track, parallel to engineering, contingent on having 2–3 quarters of relied-upon reports by this point.
- Reassess: this roadmap should be re-verified against live production state at the 12-month mark the same way this version was verified against the repo — not extended from memory.

---

## Five closing questions

**1. How much of Rights Title Report v1 can MusiGod produce today?**
Most of the underlying data model exists — composition identity, writer credits with IPI, ISWC/ISRC, registration status, evidence with confidence and provenance, AI consent, contract-backed evidence, and a hash-chained audit trail all already exist as schema and (for the Esham test catalog) as real data. What did not exist until this PR is a single endpoint that composes them into one report. Master ownership, beneficial/legal distinction, and true chain-of-title events are genuinely unbuilt, not just uncomposed. Rough estimate: the data model is 60–70% there; the composed report artifact was 0% there and is now a working v1 read endpoint; full v1 per the spec above (including master splits and chain-of-title events) is a few months out.

**2. What are the five biggest missing capabilities preventing MusiGod from becoming the definitive ownership database?**
In priority order: (1) identity resolution between MusiGod's own two graphs — without this, nothing composed is reliable; (2) master-ownership chain of title, currently a single text field; (3) true temporal ownership events (assignments/reversions/terminations) distinct from point-in-time edges; (4) live external-source integration beyond the enrichment pipeline (PRO/MLC/SoundExchange are modeled in the schema but not connected); (5) a report-layer confidence-tier methodology that's written down, versioned, and stable enough to eventually show an underwriter.

**3. What external dataset should we acquire or ingest first?**
SoundExchange — not because it's the largest, but because the BD groundwork is already drafted in-repo, it directly feeds a product already being built (neighboring-rights recovery), and it's the most tractable access path of the non-public sources. MLC bulk data is the close second for the composition side.

**4. What should be demonstrably working within the next 30 days?**
The composed Title Report endpoint (shipped in this PR) returning a real, evidence-backed report for Esham catalog tracks, including explicit gap flags and — once the identity bridge lands (Month 2 target, pullable into month 1 if prioritized) — evidence-graph data merged in for tracks that today only surface through the partner graph.

**5. What would make MusiGod's Ownership Graph genuinely difficult for another company to reproduce?**
Not any single dataset — all of the public sources are, definitionally, public. It's the combination of the evidence-first architecture (append-only, confidence-scored, fully historical — already built, already disciplined), the hash-chained audit trail, the human-review gating that's enforced at the schema level (`authoritative: false` by default, `UNSIGNED_DRAFT` execution status, review tasks required before anything becomes authoritative) rather than as a policy someone could skip under pressure, and — the part no competitor can backfill — real rightsholder relationships (the Detroit scene access, the HarbourView pilot) generating primary-source evidence that no public database has. A competitor can scrape MusicBrainz in a weekend. They cannot backfill eighteen months of disciplined, human-gated evidence accumulation or the trust relationships that produced it.

---

## What this PR changes

- Adds this roadmap document.
- Adds `api/get-rights-title-report.js` — read-only, no schema change, no money/consent state touched. Composes the partner graph, the evidence graph (bridged via `graph_catalog_links_v1` where possible), AI consent state, and flags explicit gaps including `identity_bridge_incomplete` where the two graphs couldn't be reconciled for a given lookup — that gap flag is itself the most honest thing this endpoint can say about the system's current state.
- Does not touch `royalties`, `legal`, Stripe disbursement code, or the AI consent ledger's write path. Per `CLAUDE.md`, changes there require human merge regardless of how safe they'd look — none were needed for this scope.
- Does not write a new migration. Lane 0 of the existing agent backlog is explicit that migration reconstruction must be verified against live schema first; that verification needs Supabase credentials this session does not yet have.
