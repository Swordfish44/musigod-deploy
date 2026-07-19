# 07 — Recording Identity Repair: Investigation Report

## Executive summary

The graph persistence incident is repaired (RPCs installed, enum values corrected,
edge direction fixed). A secondary defect remains: `public.fn_sync_track_to_graph`
creates a new orphan recording node on every call for tracks with no ISRC and no
catalog_id, because `ON CONFLICT (NULL, NULL)` is a no-op in PostgreSQL.

This report documents all investigation findings, the canonical identity policy,
the chosen fix, and the plan for resolving historical duplicates.

---

## Proven evidence

| Field | Value |
|-------|-------|
| Track ID | `4bcf28eb-35b6-49e7-a981-a435b9166e90` |
| Duplicate node A | `af078884-0b86-4bd4-b63b-46f0cc545949` |
| Duplicate node B | `d854c1f7-fe93-4c58-aa47-f0817b639a3d` |
| Both nodes | `external_id = NULL`, `external_id_ns = NULL` |
| Cause | `COALESCE(v_track.isrc, 'rec_' \|\| v_track.catalog_id::TEXT)` = NULL when both absent |

---

## Repository investigation results

### ISRC normalization — gaps found

The existing codebase applies only `.toUpperCase()` before storing ISRCs.
No code strips spaces, hyphens, or other separators. An ISRC submitted as
`"US-A1B-23-45678"` and one submitted as `"USA1B2345678"` would create two
separate `graph.nodes` rows despite representing the same recording.

**Fix**: normalization function `UPPER(REGEXP_REPLACE(TRIM(isrc), '[^A-Za-z0-9]', '', 'g'))`
applied in `fn_sync_track_to_graph` before any lookup or INSERT.

### Recording MBID handling — confirmed in both layers

`api/graph-sync.js:syncEnrichmentToGraph` already implements a three-tier lookup
(ISRC → MBID guard → catalog fallback) correctly. The SQL function
`fn_sync_track_to_graph` queries `public.catalog_enriched_tracks_v1`
(confirmed authoritative table per `MusiGod_Recording_Identity_Design_Correction.md`),
which has a confirmed `recording_mbid TEXT` column. The MBID tier is therefore
unconditional — no conditional comment block, no V-03 gate required.

**`release_mbid` vs `recording_mbid`**: `release_mbid` exists in the table but
identifies a MusicBrainz release (album/single), NOT a recording. It must never
be used as a recording node identity key. It is stored in node properties as
metadata only.

### `musigod_catalog_track` namespace — new

Not present in any production node before this fix. Introduced consistently with
the existing `musigod_*` prefix convention for internal MusiGod identifiers.

### Conflict detection — no prior table

No `graph.recording_identity_conflicts` table existed. Publishing/royalty conflict
tables in `disputes` and `intelligence` schemas are unrelated to graph node
identity. A new lightweight table is created in STEP 1 of the fix.

### External_id_ns consistency note (from gap analysis)

`docs/musicbrainz-identity-fix-report.md` documents a prior incident where
`syncEnrichmentToGraph` was overwriting `external_id_ns` to `'isrc'` after
discovering an ISRC for an MBID-keyed node. This was fixed in the JS layer
(the PATCH was removed; the ISRC is now written to `works.recordings.isrc`
only). The SQL function fix does not reintroduce this error.

---

## Fix design

### Three-tier lookup (SQL function)

Source table: `public.catalog_enriched_tracks_v1` (confirmed authoritative)

```
Step A: Normalize ISRC       — UPPER(REGEXP_REPLACE(TRIM(isrcs[1]), '[^A-Za-z0-9]','','g'))
Step B: Normalize MBID       — LOWER(TRIM(recording_mbid))  [NOT release_mbid]
Step C: Tier-1 lookup        — SELECT id WHERE external_id=v_norm_isrc, ns='isrc'
Step D: Tier-2 lookup        — SELECT id WHERE external_id=v_norm_mbid, ns='musicbrainz_recording'
Step E: Tier-3 lookup        — SELECT id WHERE external_id=p_track_id::TEXT, ns='musigod_catalog_track'
Step F: Conflict detection   — isrc_vs_mbid, isrc_vs_fallback, mbid_vs_fallback (all three pairs)
Step G: Priority resolution  — ISRC > MBID > fallback
Step H: Create if none found — INSERT with strongest tier as external_id; track_id in properties
Step I: Merge if found       — UPDATE properties; always write track_id + release_mbid (metadata)
```

### Invariants guaranteed

| Invariant | How |
|-----------|-----|
| No NULL external_id | `p_track_id::TEXT` is always non-null (function arg) |
| Idempotent | Explicit lookup before INSERT; ON CONFLICT DO NOTHING on all edges and conflicts |
| Fallback always attached | `track_id` stored in properties on every path (create and update) |
| No auto-merge | Conflict row only; human review required for all three pairwise conflict types |
| ISRC normalization | `UPPER(REGEXP_REPLACE(TRIM(isrcs[1]), '[^A-Za-z0-9]', '', 'g'))` |
| MBID normalization | `LOWER(TRIM(recording_mbid))` |
| release_mbid excluded from identity | Stored in node properties only; never used as external_id |

### Scope of change in function body

Only the recording-node section (between the `── Recording node ──` and
`── Edge: work →` comments) is modified. Work node, artist lookup, edges, and
all other executable statements are copied verbatim from `pg_get_functiondef`.

---

## Test coverage

| Test | Scenario | Result |
|------|----------|--------|
| T-01 | No-ISRC track synced twice | +0 nodes, +0 edges on 2nd run |
| T-02 | ISRC track synced twice | +0 nodes on 2nd run; track_id in properties |
| T-03 | MBID-only track (SQL fn path) | Fallback used; +0 nodes on 2nd run |
| T-04 | Fallback node gains ISRC | Fallback node reused; ISRC merged into props |
| T-05 | All three conflict pairs (isrc_vs_mbid, isrc_vs_fallback, mbid_vs_fallback) | Each fires independently; ISRC node wins priority |
| T-06 | Malformed ISRC | No exception; stored normalized |
| T-07 | Hyphenated ISRC | Normalized to 12-char form; idempotent |
| T-08 | Same ISRC two releases | Single recording node |
| T-09 | No duplicate edges | Exactly 2 edges across 3 runs |
| T-10 | Return contract | VOID, plpgsql, VOLATILE — unchanged |

Plus 18 existing JS unit tests in `tests/graph-sync-identity.test.js`
covering the application layer (`syncEnrichmentToGraph`, `syncCatalogToGraph`).

---

## Smoke test results — 2026-07-19

### JS application layer (153 assertions, 0 failures)

All five runnable test suites executed via `node tests/<file>`. Two integration
suites (`ai-consent-ledger.test.js`, `partner-resolve-rights.test.js`) require
a live Supabase service-role key and are unrelated to the recording identity fix;
they were skipped.

| Suite | Assertions | Result |
|-------|-----------|--------|
| `graph-sync-identity.test.js` | 56 | ✅ 56/56 passed |
| `graph-sync-enrichment-upsert.test.js` | 61 | ✅ 61/61 passed |
| `enrich-catalog-budget.test.js` | 36 | ✅ 36/36 passed |
| `ai-consent-ledger.test.js` | — | SKIP (integration, unrelated feature) |
| `partner-resolve-rights.test.js` | — | SKIP (integration, unrelated feature) |
| **Total** | **153** | **✅ 153/153 passed** |

### Idempotency — application layer proven

The following tests directly prove that running the same enrichment twice produces
**zero additional recording nodes and zero duplicate graph edges** on the second run:

| Test | Key assertion |
|------|--------------|
| Upsert-2: Repeated enrichment idempotent | `graph_upsert_node` called twice; **same node_id returned both times**; both `works.recordings` POSTs carry `Prefer: resolution=merge-duplicates` |
| Upsert-4: No duplicate rows across 3 runs | Same `node_id` on all 3 POST bodies; DB-level merge-duplicates active |
| Upsert-7: MBID-first then ISRC-later | Second run reuses the MBID-keyed node; **no new node created** |
| Upsert-8: Catalog-keyed node reused on ISRC discovery | `upsertNode` not called on run 2 — existing node found and reused |
| Upsert-9: MBID-only (the root-cause scenario) | Two runs, **same node_id on both**; `isrcs` array empty, no ISRC path; no fallback lookup needed; `merge-duplicates` on both recordings rows |
| Identity-2/3/4: ISRC/MBID/catalog guard | `external_id_ns` never overwritten; node identity stable across enrichment cycles |

Upsert-9 is the scenario that caused the original production incident (track
`4bcf28eb-…` with no ISRC and no catalog_id). The application layer is proven
idempotent for all three identity tiers.

### SQL function layer — pending migration application

`07_Recording_Identity_Tests.sql` (T-01 through T-10) and `05_Smoke_Test.sql`
Part F prove SQL-layer idempotency for `fn_sync_track_to_graph`. These tests:
- **Cannot run until `07_Recording_Identity_Fix.sql` STEP 1 + STEP 2 are applied**
  in the Supabase SQL Editor.
- Are fully written and wrapped in `ROLLBACK` transactions (safe to run on production).
- Must all show `PASS` in the Messages tab before this PR is merged.

**Merge gate**: run T-01 through T-10 in Supabase SQL Editor after STEP 2 is
applied. All must pass. This PR must not be merged before that confirmation.

---

## Historical duplicate nodes — remediation plan (future)

> Do NOT execute any of the steps below in this migration. These are
> documented for a future human-reviewed PR.

### Step 1 — Identify survivor

For each duplicate pair (same `external_id`, same `external_id_ns`):
- Prefer the node with more incoming/outgoing edges (richer graph).
- Break ties by `created_at ASC` (older node survives).

```sql
SELECT
  external_id,
  external_id_ns,
  array_agg(id ORDER BY (
    SELECT count(*) FROM graph.edges
    WHERE from_node_id = n.id OR to_node_id = n.id
  ) DESC, n.created_at ASC
  ) AS ranked_node_ids
FROM graph.nodes n
WHERE node_type = 'recording'
GROUP BY external_id, external_id_ns
HAVING count(*) > 1;
```

### Step 2 — Repoint edges

```sql
UPDATE graph.edges SET from_node_id = <survivor> WHERE from_node_id = <loser>;
UPDATE graph.edges SET to_node_id   = <survivor> WHERE to_node_id   = <loser>;
```

### Step 3 — Merge catalog detail rows

```sql
UPDATE works.recordings SET node_id = <survivor> WHERE node_id = <loser>;
```

Merge conflicts (same `node_id` already exists in `works.recordings`): update
fields individually rather than the whole row.

### Step 4 — Merge identifiers into survivor properties

```sql
UPDATE graph.nodes
  SET properties = properties || jsonb_build_object(
    'merged_identifiers', properties->'merged_identifiers' || jsonb_build_array(
      jsonb_build_object(
        'external_id',    <loser_external_id>,
        'external_id_ns', <loser_external_id_ns>,
        'merged_at',      now()
      )
    )
  )
WHERE id = <survivor>;
```

### Step 5 — Mark loser as superseded

```sql
UPDATE graph.nodes
  SET external_id_ns  = 'superseded',
      properties      = properties || jsonb_build_object('superseded_by', <survivor>::TEXT)
WHERE id = <loser>;
```

### Step 6 — Audit and conflict resolution

Mark the corresponding conflict row resolved:
```sql
UPDATE graph.recording_identity_conflicts
  SET resolved         = true,
      resolved_node_id = <survivor>,
      resolved_at      = now()
WHERE track_id = <track_id>;
```

### Step 7 — Hard-delete (only after sign-off)

After ≥ 1 enrichment cycle with zero new conflicts for this track:
```sql
DELETE FROM graph.nodes WHERE id = <loser> AND external_id_ns = 'superseded';
```

**Never hard-delete before**: all FK references cleared, conflict row resolved,
at least one enrichment cycle elapsed, human PR review approved.

---

## Deliverables checklist

| File | Status |
|------|--------|
| `release/07_Recording_Identity_Design.md` | Created |
| `release/07_Recording_Identity_Fix.sql` | Created (STEP 0 + STEP 1 + STEP 2 + STEP 3) |
| `release/07_Recording_Identity_Verification.sql` | Created (V-00 through V-12) |
| `release/07_Recording_Identity_Rollback.sql` | Created (R-01 through R-05) |
| `release/07_Recording_Identity_Tests.sql` | Created (T-01 through T-10) |
| `release/07_Recording_Identity_Report.md` | This file |

---

## Pre-apply gate (summary)

All of the following must be confirmed before running STEP 2:

1. V-01 returns ≥ 1 row (nodes unique constraint present)
2. V-02 returns ≥ 1 row (edges unique constraint present)
3. STEP 0 output saved and diffed — only expected changes:
   - FROM clause: `catalog_enriched_tracks_v1`
   - DECLARE block: five new variables (`v_rec_node_isrc`, `v_rec_node_mbid`,
     `v_rec_node_fallback`, `v_norm_isrc`, `v_norm_mbid`)
   - Recording section: replaced (Steps A–I between the two comment banners)
   - COMMENT ON FUNCTION: updated timestamp
4. STEP 1 applied (conflict table exists before STEP 2 runs)
5. T-01 through T-10 all show PASS in Messages tab after STEP 2
