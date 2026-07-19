# MusiGod Graph Persistence Repair — Deployment Checklist

**Project:** uykzkrnoetcldeuxzqyy  
**Branch:** release/fulfillment-layer-v1  
**Date:** ___________  
**Engineer:** ___________

Mark each item complete in order. Do not proceed past a STOP unless the condition is met.

---

## Pre-deployment

- [ ] Read `00_READ_ME_FIRST.md` in full
- [ ] Confirm no active enrichment jobs (`SELECT status, count(*) FROM public.catalog_enrichments_v1 GROUP BY status` — no RUNNING rows)
- [ ] Confirm `graph` and `works` are in PostgREST exposed schemas (Supabase Dashboard → API settings)
- [ ] Save a copy of the live `fn_sync_track_to_graph` body locally (run PF-04 from `01_Preflight_Verification.sql`)

---

## Step 1 — Preflight verification

- [ ] Run `01_Preflight_Verification.sql` completely
- [ ] **PF-09 PASS** — unique constraint on `graph.nodes(external_id, external_id_ns)` confirmed
- [ ] **PF-10 PASS** — unique constraint on `graph.edges(from_node_id, to_node_id, edge_type, status)` confirmed
- [ ] **PF-06 PASS** — enum does NOT contain `recorded_as` or `performed_by`
- [ ] **PF-07 PASS** — enum contains `has_recording` and `performed`
- [ ] **PF-11 PASS** — `service_role` has USAGE on `graph` schema
- [ ] **PF-12 PASS** — `service_role` has USAGE on `works` schema
- [ ] **PF-15 summary row** — all six checks show PASS

**⛔ STOP** — Do not proceed unless all six PF-15 checks are PASS.

---

## Step 2 — Backup live function (before any changes)

- [ ] Confirm `fn_sync_track_to_graph` exists (PF-02 = 1 row)
- [ ] Save STEP 0 output from `03_Replace_fn_sync_track_to_graph.sql` to a local file
- [ ] Compare the saved body to the corrected body in STEP 2 of `03_Replace_fn_sync_track_to_graph.sql`
- [ ] Confirm the ONLY differences in the diff are the three annotated FIX lines
  - FIX 1: `'recorded_as'` → `'has_recording'`
  - FIX 2: `'performed_by'` → `'performed'`
  - FIX 3: performed edge direction reversed (`artist → recording`)
- [ ] If diff has additional changes: merge live logic into the corrected body and update the file before proceeding

**⛔ STOP** — Do not apply 03 until the diff is reviewed and any extra logic is merged.

---

## Step 3 — Install RPCs

- [ ] Run `02_Install_RPCs.sql` completely
- [ ] Confirm inline result shows 2 rows: `graph_upsert_edge` and `graph_upsert_node`
- [ ] **PostgREST schema reloaded** (NOTIFY ran without error)

---

## Step 4 — Verify RPC (quick probe)

- [ ] From `04_Post_Install_Verification.sql` run PI-02: `node_rpc_execute_ok = t`, `edge_rpc_execute_ok = t`
- [ ] From `04_Post_Install_Verification.sql` run PI-01: 2 rows returned

---

## Step 5 — Replace function

- [ ] Confirm backup table was created: STEP 1 of `03_Replace_fn_sync_track_to_graph.sql` returns 1 row with positive `body_length_chars`
- [ ] Run STEP 2 of `03_Replace_fn_sync_track_to_graph.sql`
- [ ] Confirm inline result:
  - `body_has_has_recording = t`
  - `body_still_has_recorded_as = f`
  - `body_has_performed = t`
  - `body_still_has_performed_by = f`

---

## Step 6 — Post-install verification

- [ ] Run `04_Post_Install_Verification.sql` completely
- [ ] **PI-09 summary row** — all five checks show PASS

**⛔ STOP** — Do not run smoke test unless PI-09 summary = all PASS.

---

## Step 7 — Run one-track test

- [ ] Run PARTS A and B of `05_Smoke_Test.sql`
- [ ] **Part A** — All five RAISE NOTICE lines show PASS (A1 through A5)
- [ ] **Part B (B3)** — `fn_sync_track_to_graph` completed without `invalid input value for enum edge_type` error
- [ ] **Part B (B3)** — second run is idempotent (PASS message appears)

---

## Step 8 — Verify graph

- [ ] Part E of `05_Smoke_Test.sql`: `nodes_after >= nodes_before` and `edges_after >= edges_before`
- [ ] No error messages in SQL Editor output for smoke test

---

## Step 9 — Run five-track test

- [ ] Run PART C of `05_Smoke_Test.sql`
- [ ] **PART C PASS** — all tracks processed without enum error (0 FAIL lines)
- [ ] Positive edge delta confirms new has_recording and performed edges created

---

## Step 10 — Cleanup and verify application

- [ ] Run PART D of `05_Smoke_Test.sql`: `smoke_test_nodes_remaining = 0`
- [ ] Deploy application code via `vercel --prod --force` (separate action — not in this SQL package)
- [ ] Trigger a test enrichment run for Echo artist (`artist_id: 86c8df13-dbc6-4846-a8da-cdbaaf386cc7`)
- [ ] After enrichment completes, verify:
  ```sql
  SELECT count(*) FROM works.recordings;
  ```
  Expected: `> 0`
- [ ] Verify enrichment DONE result includes `graphSynced` and `graphSyncFailed` fields (new in `api/enrich-artist.js`)
- [ ] Confirm `graphSyncFailed = 0` for the test run

---

## ⛔ STOP — Final gate

- [ ] All smoke test checks passed
- [ ] `works.recordings` count increased after test enrichment
- [ ] No unexpected errors in Vercel function logs
- [ ] `Incident_Report.md` and `FINAL_DECISION.md` filed
- [ ] This checklist is complete and signed off

**Engineer sign-off:** ___________________________ **Date:** ___________

---

## If rollback is needed

Run `06_Rollback.sql`. It will:
1. Drop `graph_upsert_node` and `graph_upsert_edge`
2. Restore `fn_sync_track_to_graph` from the backup table
3. Reload PostgREST schema

Application returns to pre-deployment state. No data is deleted.
