-- ============================================================
-- 07_Recording_Identity_Rollback_FINAL.sql
-- MusiGod Graph — Rollback for 07_Recording_Identity_Fix_FINAL.sql
--
-- Restores fn_sync_track_to_graph from the backup created in
-- 07_Recording_Identity_Fix_FINAL.sql STEP 0C.
-- Backup table: public._musigod_fn_backup_20260718
--
-- The restored function:
--   • Returns JSONB (the live function returned JSONB before the fix)
--   • Contains the has_recording / performed edge fixes (applied 2026-07-17)
--   • Does NOT contain the three-tier recording-identity block
--   • Does NOT contain conflict logging
--
-- Also drops graph.recording_identity_conflicts IF it is empty.
-- If it contains conflict rows, the table is preserved for investigation.
-- Drop it manually only after reviewing its contents.
--
-- Project: uykzkrnoetcldeuxzqyy
-- Run in:  Supabase SQL Editor
-- ============================================================


-- ── R-01  Confirm backup exists and body length matches ───────────────────

SELECT fn_name, backed_up_at, length(body) AS body_length_chars
FROM   public._musigod_fn_backup_20260718
WHERE  fn_name = 'fn_sync_track_to_graph';

-- PASS    : 1 row, body_length_chars ≈ 15,708
-- STOP if 0 rows — backup was never created; cannot auto-restore.
--   Fallback option: restore from public._musigod_fn_backup_20260717
--   (the earlier July-17 backup) or use Supabase point-in-time restore.


-- ── R-02  Restore function from backup ───────────────────────────────────

DO $$
DECLARE
  v_body TEXT;
BEGIN
  SELECT body INTO v_body
  FROM   public._musigod_fn_backup_20260718
  WHERE  fn_name = 'fn_sync_track_to_graph'
  LIMIT  1;

  IF v_body IS NULL THEN
    RAISE EXCEPTION
      'Backup body is NULL — cannot restore. '
      'Check public._musigod_fn_backup_20260718 for the fn_sync_track_to_graph row.';
  END IF;

  EXECUTE v_body;

  RAISE NOTICE 'fn_sync_track_to_graph restored from _musigod_fn_backup_20260718 (% chars)',
    length(v_body);
END;
$$;


-- ── R-03  Verify rollback succeeded ──────────────────────────────────────

SELECT
  pg_get_function_result(oid)                                           AS return_type,
  (pg_get_function_result(oid) = 'jsonb')                               AS return_is_jsonb,
  length(pg_get_functiondef(oid))                                       AS body_length_chars,
  -- These must be ABSENT after rollback (three-tier fix was reverted):
  (pg_get_functiondef(oid) ILIKE '%musigod_catalog_track%')             AS has_fallback_ns,
  (pg_get_functiondef(oid) ILIKE '%recording_identity_conflicts%')      AS has_conflict_log,
  (pg_get_functiondef(oid) ILIKE '%v_rec_node_isrc%')                   AS has_tier_vars,
  -- These must remain PRESENT (edge fixes from 2026-07-17 must survive):
  (pg_get_functiondef(oid) ILIKE '%has_recording%')                     AS has_edge_has_recording,
  (pg_get_functiondef(oid) ILIKE '%performed%')                         AS has_edge_performed,
  (pg_get_functiondef(oid) ILIKE '%recorded_as%')                       AS stale_recorded_as,
  (pg_get_functiondef(oid) ILIKE '%performed_by%')                      AS stale_performed_by
FROM pg_proc
WHERE proname = 'fn_sync_track_to_graph' AND pronamespace = 'public'::regnamespace;

-- Expected after successful rollback:
--   return_is_jsonb       = t   ← JSONB contract preserved in backup
--   body_length_chars     ≈ 15,708
--   has_fallback_ns       = f   ← three-tier fix absent (correct)
--   has_conflict_log      = f   ← conflict logging absent (correct)
--   has_tier_vars         = f   ← tier vars absent (correct)
--   has_edge_has_recording= t   ← 2026-07-17 fix preserved in backup
--   has_edge_performed    = t   ← 2026-07-17 fix preserved in backup
--   stale_recorded_as     = f   ← confirmed absent
--   stale_performed_by    = f   ← confirmed absent
--
-- If return_is_jsonb = f:
--   The backup itself contains a VOID function — it was taken from a prior
--   reconstruction, not from the live body. Use Supabase PITR to restore.
--
-- If has_fallback_ns = t:
--   The backup already contained the three-tier fix — it was taken after
--   the fix was applied. The rollback cannot undo the fix. Use Supabase PITR.


-- ── R-04  Drop conflict table (only if empty) ─────────────────────────────

DO $$
DECLARE
  v_count BIGINT;
BEGIN
  SELECT count(*) INTO v_count FROM graph.recording_identity_conflicts;

  IF v_count = 0 THEN
    DROP TABLE graph.recording_identity_conflicts;
    RAISE NOTICE 'graph.recording_identity_conflicts dropped (was empty)';
  ELSE
    RAISE NOTICE
      'graph.recording_identity_conflicts NOT dropped — contains % row(s). '
      'Review conflict rows before manually dropping.',
      v_count;
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'graph.recording_identity_conflicts does not exist — nothing to drop';
END;
$$;


-- ── R-05  Reload PostgREST schema cache ───────────────────────────────────

NOTIFY pgrst, 'reload schema';
