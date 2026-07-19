# Recording Identity Fix — Final Release Report

**Migration:** `07_Recording_Identity_Fix_FINAL.sql`  
**Branch:** `release/fulfillment-layer-v1`  
**Date:** 2026-07-19  
**Project:** `uykzkrnoetcldeuxzqyy`  
**Status:** READY FOR HUMAN REVIEW — do not execute before completing Phase 2 merge

---

## Incident Summary

Track `4bcf28eb-35b6-49e7-a981-a435b9166e90` produced a new orphan recording
node on every call to `public.fn_sync_track_to_graph`. The root cause:
`INSERT INTO graph.nodes … ON CONFLICT (external_id, external_id_ns)` is a
PostgreSQL no-op when both columns are NULL. NULL ≠ NULL in unique indexes,
so no conflict is detected and every call inserts a new row.

The track has no ISRC and no catalog_id, so the old COALESCE expression
produced `NULL` for both `external_id` and `external_id_ns`. Two orphan nodes
were confirmed in production:

| Node ID | external_id | external_id_ns |
|---------|-------------|----------------|
| `af078884-…` | NULL | NULL |
| `d854c1f7-…` | NULL | NULL |

---

## Verified Live Function State (2026-07-18)

| Property | Value |
|----------|-------|
| Name | `public.fn_sync_track_to_graph(p_track_id uuid)` |
| Return type | **jsonb** |
| Language | plpgsql |
| Security | DEFINER |
| Body length | **15,708 chars** |
| has_recording edge | t (fixed 2026-07-17) |
| performed edge | t (fixed 2026-07-17) |
| recorded_as | f (gone) |
| performed_by | f (gone) |
| Backup | `public._musigod_fn_backup_20260718` |

The previous attempt (`07_Recording_Identity_Fix.sql`) used a reconstructed
RETURNS VOID body (~6,000 chars). It was not applied. The live function has
never been replaced since the edge-type fix on 2026-07-17.

---

## Phase 2 — Scope of Change

Only 3 sections of the live function body are modified. Every other executable
line is preserved verbatim from `pg_get_functiondef` output.

### CHANGE-1: DECLARE block additions

Five variables added after the last existing DECLARE variable:

```sql
v_rec_node_isrc      UUID;   -- tier-1 ISRC lookup result
v_rec_node_mbid      UUID;   -- tier-2 MBID lookup result
v_rec_node_fallback  UUID;   -- tier-3 fallback lookup result
v_norm_isrc          TEXT;   -- UPPER(REGEXP_REPLACE(TRIM(isrcs[1])))
v_norm_mbid          TEXT;   -- LOWER(TRIM(recording_mbid))
```

Lines removed: 0. Lines added: 5.

### CHANGE-2: Recording-node section replacement

**Removed** (~15 lines, the INSERT…ON CONFLICT block):
```sql
INSERT INTO graph.nodes (node_type, label, external_id, external_id_ns, properties)
VALUES (
  'recording',
  v_track.track_title,
  COALESCE(UPPER(v_track.isrc), 'rec_' || v_track.catalog_id::TEXT),
  CASE WHEN v_track.isrc IS NOT NULL THEN 'isrc' ELSE 'musigod_catalog' END,
  jsonb_build_object(...)
)
ON CONFLICT (external_id, external_id_ns)
DO UPDATE SET properties = ..., updated_at = now()
RETURNING id INTO v_rec_node_id;
```

**Added** (~90 lines, the three-tier lookup):

| Step | Action |
|------|--------|
| A | Normalize ISRC: `UPPER(REGEXP_REPLACE(TRIM(isrcs[1]), '[^A-Za-z0-9]', '', 'g'))` |
| B | Normalize MBID: `LOWER(TRIM(recording_mbid))` — never `release_mbid` |
| C | Tier-1 lookup: `WHERE external_id = v_norm_isrc AND external_id_ns = 'isrc'` |
| D | Tier-2 lookup: `WHERE external_id = v_norm_mbid AND external_id_ns = 'musicbrainz_recording'` |
| E | Tier-3 lookup: `WHERE external_id = p_track_id::TEXT AND external_id_ns = 'musigod_catalog_track'` |
| F | Log pairwise conflicts: `isrc_vs_mbid`, `isrc_vs_fallback`, `mbid_vs_fallback`. No auto-merge. |
| G | Priority resolution: ISRC > MBID > fallback |
| H | Create node if none resolved. Best tier supplies external_id. track_id always stored in properties. |
| I | Merge properties on found node. Always write track_id and release_mbid (metadata). |

### CHANGE-3: COMMENT ON FUNCTION

Append to existing comment (preserving existing timestamp lines):

```
'Recording identity corrected 2026-07-19: three-tier lookup '
'(ISRC → recording_mbid → track-id fallback) replaces NULL-vulnerable '
'INSERT…ON CONFLICT. Conflict detection via graph.recording_identity_conflicts.'
```

### Unchanged

- Function signature: `RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER`
- Source table SELECT (`catalog_enriched_tracks_v1`)
- Work-node INSERT…ON CONFLICT…RETURNING
- `INSERT INTO graph.edges … 'has_recording'`
- Artist node lookup
- `INSERT INTO graph.edges … 'performed'`
- All additional live statements (~9,000 chars of logic not in any repo file)
- `RETURN jsonb_build_object(...)` — preserved verbatim

---

## Phase 3 — Structured Diff Summary

```
--- live body (STEP 0 output)
+++ patched body

@@ DECLARE block @@
  [existing variables]
+ v_rec_node_isrc     UUID;
+ v_rec_node_mbid     UUID;
+ v_rec_node_fallback UUID;
+ v_norm_isrc         TEXT;
+ v_norm_mbid         TEXT;
  BEGIN

@@ Recording-node section @@
- INSERT INTO graph.nodes ... COALESCE(UPPER(v_track.isrc), 'rec_' || ...) ...
- ON CONFLICT (external_id, external_id_ns) DO UPDATE ...
- RETURNING id INTO v_rec_node_id;
+ [Steps A–I, three-tier lookup + conflict logging, ~90 lines]

@@ COMMENT ON FUNCTION @@
- 'DB-side graph sync... Edge types corrected 2026-07-17...';
+ 'DB-side graph sync... Edge types corrected 2026-07-17... '
+ 'Recording identity corrected 2026-07-19: three-tier lookup ...';

  [all other lines: unchanged]
```

A reviewer diffing the completed STEP 2 body against STEP 0 output should
see exactly these 3 change regions. Any additional diff line is an error.

---

## Deployment Sequence

Run each step in order. Stop on any failure and consult the stop conditions.

| # | File | Step | Safe to stop after? |
|---|------|------|---------------------|
| 1 | Verification_FINAL.sql | V-00 through V-11 | Yes — read-only |
| 2 | Fix_FINAL.sql | STEP 0 (retrieve live body) | Yes |
| 3 | Fix_FINAL.sql | STEP 0B (assert jsonb + length) | Yes |
| 4 | Fix_FINAL.sql | STEP 0C (backup) | Yes |
| 5 | Fix_FINAL.sql | STEP 1 (conflict table) | Yes — standalone |
| 6 | Manual | Complete the operator merge (steps i–vii) | Yes |
| 7 | Fix_FINAL.sql | Remove safety guard | — |
| 8 | Fix_FINAL.sql | STEP 2 (CREATE OR REPLACE) | ROLLBACK if error |
| 9 | Fix_FINAL.sql | STEP 3 (post-apply verify) | ROLLBACK if any f |
| 10 | Smoke_Test_FINAL.sql | T-01 through T-08 | ROLLBACK if any FAIL |
| 11 | — | NOTIFY pgrst (included in Fix_FINAL.sql) | — |

**Do not deploy to Vercel** until T-01 through T-08 all PASS.

---

## Pre-Apply Gate

All conditions must be true before running STEP 2:

| Check | Query | Required result |
|-------|-------|-----------------|
| Live function returns jsonb | V-01 | `return_type = 'jsonb'` |
| Body length ≈ 15,708 | V-01 | `body_length_chars BETWEEN 15000 AND 16500` |
| Edge fixes present | V-02 | `has_has_recording = t`, `has_performed = t` |
| Stale edge types absent | V-02 | `has_recorded_as = f`, `has_performed_by = f` |
| graph.nodes unique constraint | V-03 | ≥ 1 row |
| graph.edges unique constraint | V-04 | ≥ 1 row |
| catalog_enriched_tracks_v1 exists | V-05 | table present with isrcs, recording_mbid |
| Backup saved | V-06 | 1 row, body_length_chars ≈ 15,708 |
| Conflict table created | V-07 | 1 row |

---

## Post-Apply Gate (Merge Gate)

All conditions must be true before merging PR #8:

| Test | File | Required result |
|------|------|-----------------|
| T-04 JSONB return | Smoke_Test_FINAL.sql | function returns non-null JSONB |
| T-01 no-ISRC idempotency | Smoke_Test_FINAL.sql | PASS |
| T-02 ISRC idempotency | Smoke_Test_FINAL.sql | PASS |
| T-03 MBID idempotency | Smoke_Test_FINAL.sql | PASS |
| T-05 conflict table | Smoke_Test_FINAL.sql | PASS |
| T-07 fallback namespace | Smoke_Test_FINAL.sql | PASS |
| STEP 3 body_length_chars | Fix_FINAL.sql | ≥ 15,000 |
| STEP 3 return_is_jsonb | Fix_FINAL.sql | t |

---

## Rollback Procedure

1. Run `07_Recording_Identity_Rollback_FINAL.sql` (restores from `_musigod_fn_backup_20260718`).
2. Confirm R-03: `return_is_jsonb = t`, `has_fallback_ns = f`, `body_length_chars ≈ 15,708`.
3. Run `NOTIFY pgrst, 'reload schema'` (included in rollback file).
4. The conflict table is dropped only if empty (R-04). Non-empty → keep for investigation.

If the backup does not exist or is malformed, fall back to:
- `public._musigod_fn_backup_20260717` (July 17 backup — has edge fixes but not the JSONB recording block)
- Supabase point-in-time restore to before the migration window

---

## Residual Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Live body has logic not in any repo file (~9,000 chars) | Certain | Operator diff (steps i–vii) is mandatory; STEP 3 body_length_chars check catches short bodies |
| Operator accidentally applies safety-guard-blocked STEP 2 | Low | Guard raises EXCEPTION before any DDL runs |
| RETURN jsonb shape breaks callers | Low | RETURN is preserved verbatim from live body; STEP 3 and T-04 verify return_is_jsonb |
| Historical duplicate nodes (NULL/NULL pairs) | Existing | Not cleaned by this migration; future human-reviewed PR with survivor selection |
| conflict_type = 'isrc_vs_mbid' fires on valid same-recording data | Possible | Rows logged for human review; no auto-merge; no data is deleted |

---

## Files in This Release

| File | Purpose | Status |
|------|---------|--------|
| `07_Recording_Identity_Fix_FINAL.sql` | Main migration — PHASE 1–3 SQL | Ready; STEP 2 requires operator merge |
| `07_Recording_Identity_Verification_FINAL.sql` | Pre-apply read-only checks (V-00 through V-11) | Ready |
| `07_Recording_Identity_Rollback_FINAL.sql` | Rollback from `_musigod_fn_backup_20260718` | Ready |
| `07_Recording_Identity_Smoke_Test_FINAL.sql` | Post-apply idempotency + JSONB return tests (T-01 through T-08) | Ready |
| `07_Recording_Identity_Release_Report_FINAL.md` | This document | Ready |
