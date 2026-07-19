# 07 — MusiGod Canonical Recording Identity Design

## Status

Graph persistence is repaired (RPCs installed, enum values fixed, edge direction
corrected). The outstanding defect is **recording node identity resolution**: a
track with no ISRC and no catalog_id produces `external_id = NULL,
external_id_ns = NULL`, bypassing `ON CONFLICT` on every call and creating a new
orphan node each time.

This document records every design decision for the identity fix so that the
engineer applying it understands the constraints and can verify the diff
independently.

---

## Canonical policy (from specification)

A recording is a **global sound-recording entity**. A catalog-track UUID is a
source-local fallback, not a primary identifier.

Lookup precedence:

| Tier | Identifier | Namespace | Normalization |
|------|------------|-----------|---------------|
| 1 | ISRC | `isrc` | trim, strip non-alphanumeric, uppercase |
| 2 | MusicBrainz recording MBID | `musicbrainz_recording` | trim, lowercase, validate UUID form |
| 3 | Source-local track UUID | `musigod_catalog_track` | `p_track_id::text` (always non-null) |

The fallback identifier **must always be attached** as a property on any
recording node, even when a global identifier is the primary key.

---

## Repository findings

### ISRC normalization — existing state

| Path | Line | What it does |
|------|------|--------------|
| `api/graph-sync.js` | 218 | `isrc.toUpperCase()` — uppercase only |
| `api/graph-sync.js` | 320 | `track.isrc.toUpperCase()` — uppercase only |
| `lib/enrich-catalog.js` | 140 | Returns `isrcs: rec.isrcs \|\| []` (array, as-is) |

**Gap**: no existing code trims or removes spaces/hyphens before storing.
ISRCs entered as `"US-A1B-23-45678"` or `"US A1B2345678"` would be stored
differently from `"USA1B2345678"` under the current approach.

### Recording MBID — existing state

| Path | Line | What it does |
|------|------|--------------|
| `api/graph-sync.js` | 177 | Normalizes `recording_mbid` / `recordingMBID` |
| `api/graph-sync.js` | 223–224 | Looks up node by `(mbid, 'musicbrainz_recording')` before creating ISRC-keyed node |
| `api/graph-sync.js` | 243–249 | Creates node keyed by MBID when no ISRC present |
| `supabase/migrations/20260619_catalog_enriched_tracks_v1.sql` | 29 | `recording_mbid TEXT` in `catalog_enriched_tracks_v1` |

`catalog_tracks_v1` has **no confirmed `recording_mbid` column** (no migration
file tracked; see V-03 in `07_Recording_Identity_Verification.sql`).

**Implication for the SQL function**: `fn_sync_track_to_graph` queries
`catalog_tracks_v1` and therefore cannot implement the MBID tier without either
(a) confirming the column exists or (b) adding a `LEFT JOIN` to
`catalog_enriched_tracks_v1`. Adding a join changes the query scope, which
conflicts with the constraint to preserve all non-recording logic.

**Decision**: The SQL function implements Tier 1 (ISRC) + Tier 3 (fallback).
Tier 2 (MBID) is implemented only in the JS application layer
(`syncEnrichmentToGraph`) which already handles it correctly. The design doc
includes a conditional MBID block (commented out) that becomes active if V-03
confirms the column exists.

### `musigod_catalog_track` namespace — existing state

Not used in any production code path. Introduced in `release/07_Recording_Identity_Fix.sql`
(prior session). Consistent with the `musigod_*` prefix for internal MusiGod namespaces.

### Identity conflict recording — existing state

No `graph.recording_identity_conflicts` table exists. Publishing and royalty
conflict tables live in `disputes` / `intelligence` schemas and are unrelated.

**Decision**: Create `graph.recording_identity_conflicts` as part of the fix
migration (STEP 1 in `07_Recording_Identity_Fix.sql`). The function logs conflicts
via an INSERT into this table with `ON CONFLICT DO NOTHING` (idempotent). No
auto-merge; the conflict row is a human review trigger only.

---

## Three-step lookup algorithm (SQL function)

```
1. IF isrc is non-empty AFTER normalization:
       normalize → v_norm_isrc
       SELECT id FROM graph.nodes WHERE external_id = v_norm_isrc
                                    AND external_id_ns = 'isrc'
       → v_rec_node_isrc

2. SELECT id FROM graph.nodes WHERE external_id = p_track_id::TEXT
                                AND external_id_ns = 'musigod_catalog_track'
   → v_rec_node_fallback

3a. IF both non-null AND different:
        INSERT INTO graph.recording_identity_conflicts (conflict)
        v_rec_node_id := v_rec_node_isrc   -- ISRC wins; no auto-merge
3b. ELSIF isrc node found: v_rec_node_id := v_rec_node_isrc
3c. ELSIF fallback node found: v_rec_node_id := v_rec_node_fallback
3d. ELSE: INSERT new node with strongest available identity
           + always store track_id in properties
```

---

## ISRC normalization

```sql
v_norm_isrc := UPPER(REGEXP_REPLACE(TRIM(v_track.isrc), '[^A-Za-z0-9]', '', 'g'));
IF LENGTH(v_norm_isrc) = 0 THEN v_norm_isrc := NULL; END IF;
```

This handles:
- Leading/trailing whitespace: `TRIM`
- Internal spaces: stripped by `REGEXP_REPLACE`
- Hyphens: stripped (`US-A1B-23-45678` → `USA1B2345678`)
- Lowercase: `UPPER`
- Empty string after stripping: treated as NULL (no identity)

**Malformed ISRC**: a value that normalizes to a non-empty string but is not
12 chars is stored as-is with namespace `isrc`. No rejection. The
`07_Recording_Identity_Verification.sql` includes a query to surface malformed
ISRCs post-deployment.

---

## Conflict table schema

```sql
graph.recording_identity_conflicts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id         UUID NOT NULL,
  conflict_type    TEXT NOT NULL,   -- 'isrc_vs_fallback'
  norm_isrc        TEXT,
  isrc_node_id     UUID,
  fallback_node_id UUID,
  resolved         BOOLEAN NOT NULL DEFAULT false,
  resolved_node_id UUID,
  detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ
)
UNIQUE INDEX ON (track_id, conflict_type)
```

The INSERT uses `ON CONFLICT (track_id, conflict_type) DO NOTHING` so repeated
runs of the same conflict track do not create duplicate conflict rows.

---

## Scope restrictions (from specification)

- Work node: unchanged
- Artist lookup: unchanged
- `has_recording` edge: unchanged
- `performed` edge: unchanged
- `v_creator_node_id`: preserved in DECLARE (variable present in live fn reconstruction)
- `COMMENT ON FUNCTION`: updated to include identity fix date
- All other executable statements: verbatim copy from `pg_get_functiondef` output

**Do not clean historical duplicate nodes in this migration.** See §Historical
Duplicate Plan below.

---

## Historical duplicate plan (future, read-only now)

When the identity fix has been live for ≥ 1 release cycle:

1. **Identify survivor**: for each pair of duplicate recording nodes, prefer the
   node with the most edges (richer graph connectivity); break ties by `created_at`
   (older wins).
2. **Repoint edges**: `UPDATE graph.edges SET from_node_id = survivor WHERE from_node_id = loser`
   and same for `to_node_id`.
3. **Merge identifiers**: copy the loser's `external_id` / `external_id_ns` into
   the survivor's `properties` JSONB under `merged_identifiers[]`.
4. **Merge catalog links**: copy `works.recordings` rows pointing at loser's
   `node_id` to point at survivor's `node_id` (UPDATE, not INSERT, to avoid PK
   collision).
5. **Merge evidence**: copy investigation/audit references.
6. **Audit trail**: INSERT a row into `graph.history` (if it exists) or
   `graph.recording_identity_conflicts` with `resolved = true`,
   `resolved_node_id = survivor`.
7. **Mark loser**: set `loser.external_id_ns = 'superseded'` and add
   `properties->>'superseded_by' = survivor_id`. Do **not** hard-delete until:
   - All FK references are cleared
   - Conflict row is marked resolved
   - At least one enrichment cycle has passed with zero new conflicts for this track
8. **Hard-delete only after human sign-off** via PR review.

No automated merge. Each merge requires a human-reviewed migration.

---

## Test coverage required (per specification)

| # | Scenario | Where |
|---|----------|-------|
| T-01 | No-ISRC track synced twice → 0 new nodes, 0 new edges on second run | `07_Recording_Identity_Tests.sql` |
| T-02 | ISRC track synced twice → 0 new nodes on second run | `07_Recording_Identity_Tests.sql` |
| T-03 | MBID-only track synced twice → 0 new nodes (via JS layer note) | `07_Recording_Identity_Tests.sql` |
| T-04 | Fallback-only node later enriched with ISRC → same node reused | `07_Recording_Identity_Tests.sql` |
| T-05 | Conflicting ISRC vs fallback nodes → conflict row inserted, ISRC wins | `07_Recording_Identity_Tests.sql` |
| T-06 | Malformed ISRC (non-12-char after normalize) → stored, no crash | `07_Recording_Identity_Tests.sql` |
| T-07 | Multiple ISRCs (only first normalized and used in SQL path) | `07_Recording_Identity_Tests.sql` |
| T-08 | Same recording on different releases → same recording node reused | `07_Recording_Identity_Tests.sql` (JS layer) |
| T-09 | No duplicate edges on any path | `07_Recording_Identity_Tests.sql` |
| T-10 | JSON return contract unchanged (fn returns VOID) | `07_Recording_Identity_Tests.sql` |

---

## Pre-apply checklist

Before running `07_Recording_Identity_Fix.sql` STEP 2:

- [ ] V-01 passes: `graph.nodes (external_id, external_id_ns)` unique index confirmed
- [ ] V-02 passes: `graph.edges (from_node_id, to_node_id, edge_type, status)` unique index confirmed
- [ ] V-03 run: confirm whether `catalog_tracks_v1` has `recording_mbid` column
  - If YES: uncomment the MBID tier block in STEP 2 before applying
  - If NO: MBID tier handled by JS layer only (document in deployment notes)
- [ ] STEP 0 output saved locally and diffed against STEP 2 body
- [ ] Diff shows only: recording-node section replaced, DECLARE block extended, COMMENT updated
- [ ] STEP 1 (conflict table) already applied or will be applied first
- [ ] Rollback plan confirmed: `07_Recording_Identity_Rollback.sql` ready
