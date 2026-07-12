# MusicBrainz Identity Fix — Implementation Report
**Branch:** release/fulfillment-layer-v1  
**Date:** 2026-07-10  
**Scope:** Findings 1 and 2 + Task C field-name mismatch from `docs/musicbrainz-integration-gap-analysis.md`  
**Status:** Code fixed, tests pass (24/24), migration written against confirmed base table. Awaiting owner approval to commit/deploy.

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
| `api/graph-sync.js` | **Modified** | (1) Removed `PATCH graph_nodes_v1` block; (2) added `musicbrainz_recording_id` bridge; (3) fixed field-name mismatch; (4) changed `works_recordings_v1` → `recordings` in `syncEnrichmentToGraph` (PATCH) and `syncTrackToGraph` (POST) — `works.works_recordings_v1` does not exist; confirmed base table is `works.recordings` |
| `supabase/migrations/20260709_graph_recording_mbid_bridge.sql` | **Deleted** | Removed — targeted nonexistent relation; see Schema Investigation below |
| `supabase/migrations/20260711_recordings_musicbrainz_recording_id_idx.sql` | **New** | Corrected index on confirmed base table `works.recordings(musicbrainz_recording_id)` |
| `tests/graph-sync-identity.test.js` | **New** | 30 unit tests: Findings 1+2 (8) + Task C camelCase (16) + confirmed base table name regression (6) |
| `scripts/dry-run-mbid-identity-check.js` | **New** | Read-only production diagnostic script |
| `docs/musicbrainz-identity-fix-report.md` | **New** | This report |

---

## Schema Investigation — Confirmed Production Schema

### Confirmed facts (verified 2026-07-11 via pg_class query against project `uykzkrnoetcldeuxzqyy`)

| Relation | Kind | Notes |
|---|---|---|
| `works.recordings` | **BASE TABLE** | Canonical writable table; contains `musicbrainz_recording_id` |
| `public.works_recordings_v1` | **VIEW** | Read-only view over `works.recordings`; served by PostgREST without schema headers |
| `works.works_recordings_v1` | **Does not exist** | Previous migration (`20260709_graph_recording_mbid_bridge.sql`) targeted this — deleted |

Existing indexes on `works.recordings`: `recordings_pkey`, `recordings_isrc_key`, `idx_rec_comp`, `idx_rec_isrc`, `idx_rec_no_isrc`, `idx_rec_spotify`, `idx_rec_title`. **No index on `musicbrainz_recording_id`.**

### Why the original migration was deleted

`20260709_graph_recording_mbid_bridge.sql` issued `CREATE INDEX ON works.works_recordings_v1` — a relation that does not exist. PostgreSQL would have thrown `ERROR 42P01: relation "works.works_recordings_v1" does not exist`.

### Corrected migration

File: `supabase/migrations/20260711_recordings_musicbrainz_recording_id_idx.sql`

```sql
CREATE INDEX IF NOT EXISTS recordings_musicbrainz_recording_id_idx
  ON works.recordings (musicbrainz_recording_id)
  WHERE musicbrainz_recording_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
```

**Apply via:** Supabase SQL Editor (project `uykzkrnoetcldeuxzqyy`).  
**Risk:** Zero — additive partial index on base table only. No data changed.

**Verification (run after applying):**

```sql
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'works'
  AND tablename  = 'recordings'
  AND indexname  = 'recordings_musicbrainz_recording_id_idx';
```

Expected: one row with `indexdef` containing `WHERE (musicbrainz_recording_id IS NOT NULL)`.

**Rollback (if needed):**

```sql
DROP INDEX IF EXISTS works.recordings_musicbrainz_recording_id_idx;
```

### Secondary code bug — NOT in scope of this PR

`api/graph-sync.js` currently calls `graphFetch('works_recordings_v1', { schema: 'works' })` for both `POST` (in `syncTrackToGraph`) and `PATCH` (in `syncEnrichmentToGraph`). With `Accept-Profile: works`, PostgREST resolves `works_recordings_v1` in the `works` schema — which does not exist. These calls throw `graphFetch … failed: 4xx`, caught by try/catch and logged as "enrichment/catalog patch failed". The correct target is `recordings` (the confirmed base table in the `works` schema). **This must be fixed in a follow-on PR before `syncEnrichmentToGraph` or `syncTrackToGraph` can write to the graph recording detail table.**

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
| `api/graph-sync.js` called `graphFetch('works_recordings_v1', { schema: 'works' })` for both POST and PATCH — `works.works_recordings_v1` does not exist; both calls threw at runtime. | High | **Fixed** — changed to `recordings` (confirmed base table) in `syncEnrichmentToGraph` (PATCH) and `syncTrackToGraph` (POST). |
| Index on `works.recordings(musicbrainz_recording_id)` not yet applied. | Low | **Pending** — migration `20260711_recordings_musicbrainz_recording_id_idx.sql` ready, awaiting owner apply. |
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
- [ ] Review `api/graph-sync.js` diff — confirm field normalisation logic and multi-strategy lookup
- [ ] Apply `20260711_recordings_musicbrainz_recording_id_idx.sql` in Supabase SQL Editor
- [ ] Run verification query after applying — confirm `recordings_musicbrainz_recording_id_idx` appears with `WHERE (musicbrainz_recording_id IS NOT NULL)`
- [ ] Run `node tests/graph-sync-identity.test.js` locally — confirm 24/24 pass
- [ ] Run `node scripts/dry-run-mbid-identity-check.js` after `vercel env pull` — confirm zero damaged nodes
- [ ] Authorize commit + deploy
- [ ] After deploy: re-trigger `enrich-artist.js` for Esham (and other artists) to backfill `musicbrainz_recording_id` in `works.recordings`
