# Incident Closed — Recording Identity Graph Sync (2026-07-23)

## Status
RESOLVED. Production verification passed 2026-07-23.
Job `2a62edd9-43ec-453a-b333-f2c5cee3535d`: graphSynced=22, graphSyncFailed=0, tracksPersisted=22.

---

## Root Cause

`syncEnrichmentToGraph` in `api/graph-sync.js` performed a duplicate-row guard by
calling `findNodeByExternalId()` from JavaScript before creating each recording node.
That function issues `GET /rest/v1/nodes` with `Accept-Profile: graph`.

PostgREST only exposes schemas listed in `db-schemas`. The `graph` schema is
intentionally excluded from that list (direct table access is locked to
`service_role` via RLS). PostgREST returned **HTTP 406 Not Acceptable** for every
call that carried `Accept-Profile: graph`.

**Why 10/22 passed initially, then 0/22:** Tracks without ISRCs bypassed the guard
(took the MBID-only code path, which did not call `findNodeByExternalId`). As
subsequent enrichment runs added ISRCs to all 22 tracks, every track entered the
ISRC branch, hit the guard, and failed. Final production failure was 0/22.

**Why Preview passed:** Preview was deployed from commit `82742240` (the fix).
Production was still at `d13c01f` (July 19). The merge to master triggered a Vercel
**Preview** deployment only. Per project convention, production requires
`vercel --prod --force`.

---

## Deployed Fix

**Commit:** `82742240`  
**Branch merged:** `security/graph-rls-sync-rpc` → `master` (PR #9)  
**Deployed to production:** 2026-07-22 via `vercel --prod --force`

### What changed

`api/graph-sync.js` — `syncEnrichmentToGraph`:
- Removed all direct `findNodeByExternalId` calls for recording identity lookup.
- Replaced with a single call to `upsertRecordingEnrichment()`, which calls
  `public.rpc_upsert_recording_enrichment` (schema=`public`, no `graph` routing).

`api/graph-sync.js` — `upsertRecordingEnrichment` (new):
- Sends 6 params: `p_label`, `p_isrc`, `p_recording_mbid`, `p_catalog_track_id`,
  `p_node_properties`, `p_composition_node_id`.
- Schema set to `public` — PostgREST routes this without a header conflict.

---

## Migration Applied

**File:** `supabase/migrations/20260722_rpc_recording_enrichment_v2.sql`  
**Applied to:** project `uykzkrnoetcldeuxzqyy` (production), 2026-07-22

### What the migration does

Replaces the 7-param `public.rpc_upsert_recording_enrichment(TEXT,TEXT,TEXT,JSONB,JSONB,UUID,UUID)`
with a new 6-param signature `(TEXT,TEXT,TEXT,TEXT,JSONB,UUID)`.

The new function:
1. Accepts `p_label`, `p_isrc`, `p_recording_mbid`, `p_catalog_track_id`,
   `p_node_properties`, `p_composition_node_id`.
2. Resolves identity priority internally: normalized ISRC → recording_mbid →
   catalog_track_id. Queries `graph.nodes` directly via **SECURITY DEFINER** —
   no PostgREST schema routing header needed.
3. Upserts `graph.nodes` and `works.recordings` atomically. COALESCE on all
   mutable columns ensures a later enrichment run never clobbers prior data.
4. Returns `{"node_id": "<uuid>"}` on success; `{"error": "no_identity", ...}`
   if no identity key is provided.

The old 7-param function is DROPped after the new one is created (no gap window).

---

## Security Model

```
SECURITY DEFINER
SET search_path = pg_catalog, graph, works
REVOKE EXECUTE ... FROM PUBLIC
REVOKE EXECUTE ... FROM anon
REVOKE EXECUTE ... FROM authenticated
GRANT  EXECUTE ... TO service_role
```

- Only `service_role` (and the function owner `postgres`) can execute.
- `graph.nodes` and `works.recordings` are not exposed via PostgREST.
- Callers must supply a service role key; anon/authenticated keys return 403.

---

## Test Evidence

| Suite | Tests | Assertions | Result |
|-------|-------|------------|--------|
| `tests/graph-rls.test.js` | 10 | 34 | PASS |
| `tests/graph-sync-identity.test.js` | 18 | 56 | PASS |
| `tests/graph-sync-enrichment-upsert.test.js` | 16 | 70 | PASS |

Key test cases:
- **AUTH-4**: verifies zero `GET /rest/v1/nodes` calls from JS; RPC receives
  both `p_isrc` and `p_recording_mbid`.
- **IDEM-1–IDEM-6**: repeated calls, all three identity tiers, conflicting
  identifiers, unauthorized execution — all green.

**Preview smoke test** (pre-merge, two consecutive runs):  
Run 1: graphSynced=22, graphSyncFailed=0  
Run 2: graphSynced=22, graphSyncFailed=0, works.recordings stable at 22 rows

**Production verification** (post-deploy):  
Job `2a62edd9`: graphSynced=22, graphSyncFailed=0, tracksPersisted=22

---

## Post-check Queries (Supabase SQL Editor)

```sql
-- Confirm new 6-param overload; old 7-param must be absent
SELECT proname, pronargs, pg_get_function_arguments(oid) AS args
FROM pg_proc
WHERE proname = 'rpc_upsert_recording_enrichment'
  AND pronamespace = 'public'::regnamespace;
-- EXPECT: 1 row, pronargs=6

-- Confirm grants: service_role only
SELECT pg_get_userbyid(a.grantee) AS role, a.privilege_type
FROM pg_proc p,
     LATERAL aclexplode(COALESCE(p.proacl, acldefault('f'::"char", p.proowner))) a
WHERE p.proname = 'rpc_upsert_recording_enrichment'
  AND p.pronamespace = 'public'::regnamespace;
-- EXPECT: postgres|EXECUTE, service_role|EXECUTE (no anon, no authenticated)
```

---

## Rollback

```sql
-- Step 1: remove new 6-param function
DROP FUNCTION IF EXISTS public.rpc_upsert_recording_enrichment(TEXT,TEXT,TEXT,TEXT,JSONB,UUID);
NOTIFY pgrst, 'reload schema';
-- Step 2: re-apply supabase/migrations/20260721_graph_rls_lockdown.sql
--         to restore original 7-param function
```

Application rollback: redeploy commit `d13c01f` via `vercel --prod --force`.
Note: with old JS + old function, graphSyncFailed will return to ~12/22 (ISRC-bearing
tracks) or 0/22 (no-ISRC tracks) depending on enrichment state.
