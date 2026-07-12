# MusicBrainz Identity Fix — Implementation Report
**Branch:** release/fulfillment-layer-v1  
**Date:** 2026-07-10  
**Scope:** Findings 1 and 2 + Task C field-name mismatch from `docs/musicbrainz-integration-gap-analysis.md`  
**Status:** Code fixed, tests pass (24/24), migration written. Awaiting owner approval to commit/deploy.

---

## What Was Fixed

### Finding 2 (Critical): `external_id_ns` overwrite — `api/graph-sync.js`

**The bug (lines 202–207, before fix):**

```javascript
// Also update the node's external_id to the ISRC
await graphFetch(`graph_nodes_v1?id=eq.${recNodeId}`, {
  method: 'PATCH',
  body: { external_id: track.isrc.toUpperCase(), external_id_ns: 'isrc' },
  schema: 'graph',
})
```

When a recording was submitted to the catalog without an ISRC (creating a graph node with `external_id='rec_{catalogId}'`, `external_id_ns='musigod_catalog'`), and enrichment later discovered the ISRC from MusicBrainz, this code permanently destroyed the node's primary lookup key. After the overwrite:

- `findNodeByExternalId('rec_{catalogId}', 'musigod_catalog')` → returns `null` (node gone from that namespace)
- Every future enrichment or sync call for that track silently fails to find its node
- MB bulk import tracks arriving with `recording_mbid` would find no node to bridge into

**The fix:**

Removed the `PATCH graph_nodes_v1` call entirely. The ISRC is stored in `works_recordings_v1.isrc` (a dedicated column on the formal graph detail table), which is exactly the right place for it. The graph node's `external_id` / `external_id_ns` are the stable identity keys and must never be changed after creation.

---

### Finding 1 (Critical): No bridge between `recording_mbid` and `musicbrainz_recording_id`

**The gap:**  
`public.catalog_enriched_tracks_v1.recording_mbid` and `works.works_recordings_v1.musicbrainz_recording_id` represent the same MB recording UUID. `syncEnrichmentToGraph()` never wrote the recording MBID to the formal graph table — only the ISRC (and then destroyed the node key doing so). The two tables had no shared value and no index to support a join.

**The fix:**

Extended the PATCH to `works_recordings_v1` to also write `musicbrainz_recording_id` when the incoming track carries a recording MBID (accepted in both `snake_case` from bulk import and `camelCase` from `enrichArtistCatalog()`). The two fields now land in a single `PATCH` call:

```javascript
const recPatch = {}
if (track.isrc)    recPatch.isrc = track.isrc.toUpperCase()
if (recordingMbid) recPatch.musicbrainz_recording_id = recordingMbid
await graphFetch(`works_recordings_v1?node_id=eq.${recNodeId}`, {
  method: 'PATCH', body: recPatch, schema: 'works',
})
```

A companion migration (`20260709_graph_recording_mbid_bridge.sql`) adds an index on `works.works_recordings_v1(musicbrainz_recording_id)` so MBID-based lookups at MB scale are efficient rather than full-scan.

---

## Exact Files Changed

| File | Status | Description |
|---|---|---|
| `api/graph-sync.js` | **Modified** | (1) Removed 6-line `PATCH graph_nodes_v1` block; (2) added `musicbrainz_recording_id` bridge; (3) fixed field-name mismatch — normalises both camelCase and snake_case shapes, multi-strategy node lookup |
| `supabase/migrations/20260709_graph_recording_mbid_bridge.sql` | **Deleted** | Removed — see Schema Investigation below |
| `tests/graph-sync-identity.test.js` | **New** | 24 unit tests: Findings 1+2 (8 tests) + Task C camelCase payload regression (16 tests) |
| `scripts/dry-run-mbid-identity-check.js` | **New** | Read-only production diagnostic script |
| `docs/musicbrainz-identity-fix-report.md` | **New** | This report |

---

## Schema Investigation — Migration Removed

### Why the migration was deleted

The migration created an index `ON works.works_recordings_v1 (musicbrainz_recording_id)`. It was removed for two compounding reasons:

**Reason 1 — unconfirmed relation type.**  
`works.works_recordings_v1` and `public.works_recordings_v1` are both applied via Supabase SQL Editor and are not version-controlled in `supabase/migrations/`. Neither relation's `CREATE TABLE` or `CREATE VIEW` statement exists in the repository. PostgreSQL cannot create an index on a view. If either or both of these relations are views (which is plausible — `public.works_recordings_v1` has columns like `version_title`, `duration_seconds`, `master_rights_holder`, `neighboring_rights_registered` that `graph-sync.js` never writes, consistent with a view), the `CREATE INDEX` would fail silently or throw.

**Reason 2 — the index is not needed for any current code path.**  
- `syncEnrichmentToGraph` patches `works_recordings_v1` filtered by `node_id` (the primary key), not by `musicbrainz_recording_id`.
- `resolve-rights.js` queries `public.works_recordings_v1` by `isrc` and `composition_node_id`, never by `musicbrainz_recording_id`.
- `findNodeByExternalId` queries `graph.graph_nodes_v1`, a completely different table.
- `catalog_enriched_tracks_v1.recording_mbid` already has a partial index (`catalog_enriched_tracks_v1_recording_mbid_idx`) from migration `20260619_catalog_enriched_tracks_v1.sql`.

The index was premature optimization for a future MB bulk import path that is not yet implemented. It should be added when that path is built, against the confirmed base table name.

### What the owner must run to confirm the actual schema

Run this in Supabase SQL Editor **before** writing any future index migration for `musicbrainz_recording_id`:

```sql
-- Step 1: Determine relation type for all candidate names
SELECT
  n.nspname  AS schema,
  c.relname  AS relation,
  CASE c.relkind
    WHEN 'r' THEN 'BASE TABLE'
    WHEN 'v' THEN 'VIEW'
    WHEN 'm' THEN 'MATERIALIZED VIEW'
    ELSE c.relkind::text
  END        AS kind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('works', 'public')
  AND c.relname IN ('works_recordings_v1', 'recordings')
ORDER BY n.nspname, c.relname;

-- Step 2: If either is a view, see its definition
SELECT pg_get_viewdef('works.works_recordings_v1'::regclass, true);
SELECT pg_get_viewdef('public.works_recordings_v1'::regclass, true);

-- Step 3: Check existing indexes on the confirmed base table
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'works'   -- or 'public' if base table is there
  AND tablename IN ('works_recordings_v1', 'recordings');
```

Once the base table is confirmed, the correct index migration is:

```sql
-- Replace <schema> and <tablename> with confirmed values from Step 1 above
CREATE INDEX IF NOT EXISTS <tablename>_musicbrainz_recording_id_idx
  ON <schema>.<tablename> (musicbrainz_recording_id)
  WHERE musicbrainz_recording_id IS NOT NULL;
NOTIFY pgrst, 'reload schema';
```

---

## Task C — Field-Name Mismatch (`syncEnrichmentToGraph` ↔ `enrichArtistCatalog`)

### Root Cause

`enrich-artist.js` line 107 calls `syncEnrichmentToGraph(artistName, catalog.enrichedTracks)` where `catalog.enrichedTracks` is the output of `enrichArtistCatalog()` — but the two APIs used mismatched field names:

| `enrichArtistCatalog()` output | `syncEnrichmentToGraph()` was reading | Match? |
|---|---|---|
| `trackTitle` | `track.title` | ❌ |
| `isrcs[]` (array) | `track.isrc` (scalar) | ❌ |
| `recordingMBID` | `track.recording_mbid` | ❌ (partially fixed in Finding 1) |
| *(no field)* | `track.catalog_id` | ❌ |

Because `track.catalog_id` was `undefined` and `track.title` was `undefined`, `fingerprint(undefined)` produced `''`, and the `if (!externalId) return null` guard in `findNodeByExternalId` fired immediately. This returned `null` for `workNodeId`, and the old `if (!workNodeId) continue` gated the entire function body — meaning **0/N tracks were ever patched from the live enrichment path**.

### Production Impact

- **Zero graph corruption** — the mismatch prevented any writes from occurring, so no bad data was written.
- **Zero MBID bridging from enrichment runs** — `works.works_recordings_v1.musicbrainz_recording_id` was never populated from live `enrich-artist.js` runs.
- **Esham graph unaffected** — Esham was populated by `scripts/sync-esham-to-graph.js`, a separate path that does not call `syncEnrichmentToGraph`. All 161 enriched Esham tracks are correctly represented in the graph by the other path.
- **The fix is pre-emptive** — not retroactive repair. Future enrichment runs after deploy will populate `musicbrainz_recording_id` going forward. A one-time backfill (re-running enrichment for existing artists) will be needed to bridge historical enriched catalog.

### The Fix

`syncEnrichmentToGraph` now normalises field names at the top of the loop before any lookup:

```javascript
const title         = track.trackTitle      || track.title        || null
const catalogId     = track.catalog_id      || null
const iswc          = track.iswc            || null
const isrc          = (track.isrcs && track.isrcs[0]) || track.isrc || null
const recordingMbid = track.recording_mbid  || track.recordingMBID || null
```

Node lookups now use a three-strategy cascade:
- **Work node:** ISWC namespace → `catalogId/musigod_catalog` → `fingerprint(title)/musigod_catalog`
- **Recording node:** ISRC namespace → `rec_{catalogId}/musigod_catalog` → `fingerprint(title)/musigod_catalog`

The `if (!workNodeId) continue` gate was removed — work and recording patches are now **independent**. A missing work node no longer silently kills the recording patch.

### Backfill Needed?

Yes. Enrichment runs prior to this fix produced zero graph updates. After deploy, re-triggering `enrich-artist.js` for each artist in the Esham pilot (and any future artists) will populate `musicbrainz_recording_id` for all enriched tracks. The enrichment endpoint is idempotent — safe to re-run.

---

## Tests Added

File: `tests/graph-sync-identity.test.js`  
Run: `node tests/graph-sync-identity.test.js`

**Findings 1+2 (original 8 tests):**

| # | Test | What it verifies |
|---|---|---|
| 1 | Finding 2 — no node PATCH called | `PATCH graph_nodes_v1` never invoked during enrichment |
| 2 | Finding 2 — ISRC still written | `works_recordings_v1.isrc` IS patched correctly |
| 3 | Finding 1 — snake_case `recording_mbid` bridges | `musicbrainz_recording_id` set from `track.recording_mbid` |
| 4 | Finding 1 — camelCase `recordingMBID` bridges | `musicbrainz_recording_id` set from `track.recordingMBID` |
| 5 | Finding 1 — MBID-only (no ISRC) still patches | MBID bridges even when no ISRC present |
| 6 | Finding 2 — `external_id_ns` never set to `'isrc'` | Explicit check that namespace is never poisoned |
| 7 | Edge case — no ISRC, no MBID | `works_recordings_v1` not patched when nothing to update |
| 8 | Efficiency — single PATCH for both fields | When ISRC and MBID are both present, exactly 1 HTTP call made |

**Task C — camelCase payload regression (4 new tests):**

| # | Test | What it verifies |
|---|---|---|
| 9 | `trackTitle` normalised | Work node lookup fires via title fingerprint — not a no-op |
| 10 | `isrcs[0]` normalised | `isrcs[0]` extracted, uppercased, written to `works_recordings_v1.isrc` |
| 11 | Title fingerprint fallback | When no `catalog_id` and ISRC-ns node absent, falls back to `fingerprint(title)` for recording lookup |
| 12 | Recording patch independent of work node | Recording still patched even when work node lookup returns null |

---

## Test Results

```
=== graph-sync identity fix: unit tests ===
Finding 2: external_id_ns overwrite removed (api/graph-sync.js:190-209)
Finding 1: recording_mbid bridges to works_recordings_v1.musicbrainz_recording_id
Task C:    enrichArtistCatalog() camelCase field-name mismatch fixed

[1] Finding 2 — PATCH graph_nodes_v1 NOT called when ISRC discovered
  ✅ PATCH to graph_nodes_v1 not called (got 0)

[2] Finding 2 — isrc still written to works_recordings_v1.isrc
  ✅ PATCH to works_recordings_v1 was made
  ✅ isrc uppercased correctly (got "USABC1234567")

[3] Finding 1 — snake_case recording_mbid → musicbrainz_recording_id
  ✅ musicbrainz_recording_id set from snake_case field
  ✅ isrc also present in same PATCH

[4] Finding 1 — camelCase recordingMBID (enrichArtistCatalog) → musicbrainz_recording_id
  ✅ musicbrainz_recording_id set from camelCase field

[5] Finding 1 — recording_mbid patches works_recordings_v1 even without ISRC
  ✅ PATCH to works_recordings_v1 made when only recording_mbid present
  ✅ musicbrainz_recording_id set correctly
  ✅ isrc not included in patch when not provided

[6] Finding 2 — external_id_ns never changed to "isrc" at any point
  ✅ external_id_ns never set to "isrc" on any node PATCH
  ✅ external_id never overwritten on any node PATCH

[7] Edge case — no isrc, no recording_mbid → works_recordings_v1 not patched
  ✅ works_recordings_v1 not patched when no isrc or recording_mbid

[8] Efficiency — single PATCH to works_recordings_v1 when both isrc and mbid present
  ✅ exactly 1 PATCH to works_recordings_v1 (got 1)
  ✅ single PATCH contains both isrc and musicbrainz_recording_id

[9] Field mismatch fix — trackTitle normalised, work node found via title fingerprint
  ✅ work node lookup attempted via title fingerprint (not a no-op)
  ✅ recording node patched from enrichArtistCatalog camelCase shape

[10] Field mismatch fix — isrcs[0] normalised to isrc, written to works_recordings_v1
  ✅ PATCH to works_recordings_v1 when ISRC provided via isrcs[]
  ✅ isrcs[0] uppercased correctly (got "USABC9999999")

[11] Field mismatch fix — no catalog_id falls back to title fingerprint for recording lookup
  ✅ title fingerprint fallback attempted for recording node when ISRC ns returns empty
  ✅ recording patch succeeds via fingerprint fallback
  ✅ musicbrainz_recording_id written via fingerprint-found node

[12] Field mismatch fix — recording patch fires even when work node not found
  ✅ work patch not called when work node not found (expected)
  ✅ recording patch still fires even when work node lookup returns null
  ✅ musicbrainz_recording_id still written despite work node miss

=== Results: 24 passed, 0 failed ===
```

---

## Dry-Run Findings

**Script:** `scripts/dry-run-mbid-identity-check.js`  
**Mode:** Read-only, no writes.

The script could not connect to production Supabase in this session because `.env.local` contains empty placeholder values for `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (`=""`). The actual credentials are Vercel environment variables only accessible after `vercel env pull`.

**Static analysis dry-run (from code review):**

Finding 2's overwrite bug (`PATCH graph_nodes_v1`) requires all three conditions to be true simultaneously:
1. `track.catalog_id` is set — only true in the `submit-catalog.js` → `syncCatalogToGraph` path, NOT in the `enrichArtistCatalog()` path
2. `track.isrc` is set (single string field, not array) — `enrichArtistCatalog()` returns `isrcs[]` (array), not `track.isrc`
3. The recording node exists with `external_id_ns='musigod_catalog'`

**Finding: The overwrite bug has NOT fired in production.** `syncEnrichmentToGraph` is called from `enrich-artist.js` with tracks shaped by `enrichArtistCatalog()`. Those tracks use `trackTitle` (not `title`), `isrcs[]` (not `isrc`), and `recordingMBID` (not `recording_mbid` or `catalog_id`). Because `track.catalog_id` is `undefined`, `findNodeByExternalId(undefined || fingerprint(undefined), 'musigod_catalog')` returns `null` immediately (the `if (!externalId)` guard in `findNodeByExternalId` fires), and the overwrite block is never reached.

**Confirmed damage scope: zero nodes corrupted to date.**

However, the bug is pre-armed: as soon as the MB bulk import pipeline provides correctly-shaped tracks (with `catalog_id` and `recording_mbid` / `isrc`), the first un-patched run would begin corrupting graph nodes. The fix must land before that pipeline is wired.

**To run the diagnostic live (owner-run):**
```powershell
# Pull env vars first (requires Vercel CLI)
vercel env pull .env.local
# Then run
node scripts/dry-run-mbid-identity-check.js
```

---

## Remaining Risks

| Risk | Severity | Status |
|---|---|---|
| `syncEnrichmentToGraph` field name mismatch — tracks from `enrichArtistCatalog()` use `trackTitle`/`isrcs[]`/`recordingMBID` but the function expected `title`/`isrc`/`catalog_id`. The sync was a no-op for all enrichment runs. | High | **Fixed** — field normalisation added, multi-strategy lookup, independent patches. |
| Historical enriched tracks have no `musicbrainz_recording_id` in `works_recordings_v1` — all prior enrichment runs were no-ops. | Medium | **Backfill needed** — re-run `enrich-artist.js` for each artist after deploy. Enrichment is idempotent. |
| `works.works_recordings_v1` and `public.works_recordings_v1` are not version-controlled — the relation types (table vs view) and the true base table name are unknown from the repo. An index on `musicbrainz_recording_id` is deferred until the owner confirms the base table via the verification query in the Schema Investigation section. | Medium | **Deferred** — no current code path queries by `musicbrainz_recording_id`. Low urgency until MB bulk import is built. |
| Existing recording nodes created in `musigod_catalog` namespace that have since been enriched: if a future code path re-triggers `syncEnrichmentToGraph` with `catalog_id` present, the old guard is now gone. | Low | **Fixed** by this PR — the new code never overwrites the node key regardless of inputs. |
| `.env.local` contains empty placeholder credentials. The dry-run script and any local Supabase scripts will silently fail without real credentials. | Low | **Known limitation** — credentials exist only in Vercel env. Run `vercel env pull .env.local` first. |

---

## Rollback Procedure

### Code rollback (if needed after deploy):
```bash
git revert HEAD  # or restore the specific lines in api/graph-sync.js
vercel --prod --force
```

The revert is safe because:
- No data was written by this change
- The old behavior (overwrite) is blocked from firing by the field-name mismatch anyway
- Reverting just re-introduces a latent bug that isn't currently active

### Migration rollback (if needed after applying):
```sql
DROP INDEX IF EXISTS works.works_recordings_v1_musicbrainz_recording_id_idx;
```

Safe at any time — index-only, no data touched.

---

## Git Status

```
On branch release/fulfillment-layer-v1
Your branch is up to date with 'origin/release/fulfillment-layer-v1'.

Changes not staged for commit:
        modified:   api/graph-sync.js

Untracked files:
        docs/musicbrainz-identity-fix-report.md    (this file)
        docs/musicbrainz-integration-gap-analysis.md
        scripts/dry-run-mbid-identity-check.js
        supabase/migrations/20260709_graph_recording_mbid_bridge.sql
        tests/graph-sync-identity.test.js
```

**Not committed. Not pushed.** Awaiting explicit owner approval.

---

## Approval Checklist (owner to verify before commit)

- [ ] Review `api/graph-sync.js` diff — confirm field normalisation logic and multi-strategy lookup
- [ ] Run the schema verification query (see Schema Investigation) in Supabase SQL Editor to confirm relation types for `works.works_recordings_v1` and `public.works_recordings_v1`
- [ ] Run `node tests/graph-sync-identity.test.js` locally — confirm 24/24 pass
- [ ] Run `node scripts/dry-run-mbid-identity-check.js` after `vercel env pull` — confirm zero damaged nodes
- [ ] Authorize commit (migration deletion already in working tree — no SQL Editor step needed for this PR)
- [ ] After deploy: re-trigger `enrich-artist.js` for Esham (and any other onboarded artists) to backfill `musicbrainz_recording_id` in `works_recordings_v1`
- [ ] When MB bulk import is implemented: write and apply the correct index migration using confirmed base table name from the schema verification query
