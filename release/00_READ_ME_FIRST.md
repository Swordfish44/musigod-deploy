# MusiGod Graph Persistence Repair — Release Package

**Project:** uykzkrnoetcldeuxzqyy (Supabase)  
**Branch:** release/fulfillment-layer-v1  
**Package prepared:** 2026-07-17  
**Estimated execution time:** 30–45 minutes  
**Executor role required:** Supabase SQL Editor access with service_role key

---

## What is broken

Three independent defects are blocking all graph persistence. Every call to
`syncArtistToGraph`, `syncCatalogToGraph`, and `syncEnrichmentToGraph` fails
silently. `works.recordings` and `works.compositions` have zero rows despite
161 Esham tracks being enriched.

| Defect | Symptom |
|--------|---------|
| **D1** — `graph.graph_upsert_node` RPC does not exist in production | Every graph node write returns PostgREST 404. The per-track try/catch absorbs the error; job status shows DONE with 0 graph rows written. |
| **D2** — `graph.graph_upsert_edge` RPC does not exist in production | Every graph edge write returns PostgREST 404. Same silent failure. |
| **D3** — `fn_sync_track_to_graph` uses invalid enum values | The function inserts edge_type `'recorded_as'` (valid: `'has_recording'`) and `'performed_by'` (valid: `'performed'`). Every DB-side backfill call raises `ERROR: invalid input value for enum edge_type`. The performed edge direction is also wrong (`recording → artist`; correct: `artist → recording`). |

---

## What is being fixed

| Patch | File | Action |
|-------|------|--------|
| A | `02_Install_RPCs.sql` | Creates `graph.graph_upsert_node` and `graph.graph_upsert_edge` in production |
| B | *(included in 02)* | Grants EXECUTE to `service_role` on both RPCs; reloads PostgREST schema |
| C | `03_Replace_fn_sync_track_to_graph.sql` | Saves a backup of the original function, then applies corrected version |

Application code change (`api/enrich-artist.js`) is in the branch. It is
deployed separately via `vercel --prod --force` and is not part of this SQL
package.

---

## Expected outcome

After all patches are applied and verified:

- `graph.graph_upsert_node` and `graph.graph_upsert_edge` exist in the `graph` schema
- `service_role` can execute both RPCs
- `fn_sync_track_to_graph` inserts `has_recording` and `performed` (not the invalid values)
- A test enrichment for the Echo artist creates rows in `works.recordings`
- `works.recordings` row count increases from 0
- `works.compositions` row count increases from 0
- `graph.graph_nodes_v1` count increases from 239
- `graph.graph_edges_v1` count increases from 362

---

## Estimated execution time

| Step | Time |
|------|------|
| 01 Preflight (read-only) | 5 min |
| 02 Install RPCs | 3 min |
| 03 Replace function (includes backup) | 10 min (human diff review required) |
| 04 Post-install verification | 5 min |
| 05 Smoke test | 10 min |
| Total | ~33 min |

---

## Rollback strategy

If anything goes wrong after step 03, run `06_Rollback.sql` in the SQL Editor.
It will:
1. Drop the newly installed RPCs (`graph.graph_upsert_node`, `graph.graph_upsert_edge`)
2. Restore `fn_sync_track_to_graph` from the backup table created in step 03
3. Reload the PostgREST schema

The application will return to its pre-patch state (graph writes fail with 404,
backfill function raises enum error). No graph data is deleted by the rollback.

---

## Prerequisites

Before running any SQL file:

- [ ] You have the Supabase SQL Editor open on project `uykzkrnoetcldeuxzqyy`
- [ ] You are using or impersonating `service_role` (default in SQL Editor)
- [ ] You have read `01_Preflight_Verification.sql` and understand the pass/fail conditions
- [ ] `graph` and `works` are listed in PostgREST's `db_schema` setting (check Supabase Dashboard → Project Settings → API → Exposed schemas)
- [ ] No active enrichment jobs are running (check `SELECT status, count(*) FROM public.catalog_enrichments_v1 GROUP BY status`)

---

## Execution order

```
01_Preflight_Verification.sql   ← read only, no changes
02_Install_RPCs.sql             ← installs RPCs + grants + schema reload
03_Replace_fn_sync_track_to_graph.sql  ← back up + replace function
04_Post_Install_Verification.sql       ← confirm everything is live
05_Smoke_Test.sql               ← live data test
06_Rollback.sql                 ← ONLY if rolling back
```

Follow `Deployment_Checklist.md` in parallel.
