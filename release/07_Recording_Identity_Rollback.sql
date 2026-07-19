-- ============================================================
-- 07_Recording_Identity_Rollback.sql
-- MusiGod Graph — Recording Identity Fix Rollback
--
-- Restores fn_sync_track_to_graph from the backup saved by
-- 03_Replace_fn_sync_track_to_graph.sql STEP 1.
--
-- Also drops graph.recording_identity_conflicts IF it is empty.
-- If it contains rows (conflicts were detected), the table is left
-- in place for investigation. Drop it manually only after reviewing
-- its contents.
--
-- ⚠ This rollback restores the PRE-07 function body. If 03_Replace
--   was already applied, the restored body has the enum/direction
--   fixes from that migration. If 03_Replace was NOT applied, the
--   restored body is the original broken function.
--
-- Project: uykzkrnoetcldeuxzqyy
-- Run in:  Supabase SQL Editor
-- ============================================================


-- ── R-01: Confirm backup exists ──────────────────────────────────────────────

SELECT fn_name, backed_up_at, length(body) AS body_length_chars
FROM   public._musigod_fn_backup_20260717
WHERE  fn_name = 'fn_sync_track_to_graph';

-- Expected: 1 row with body_length_chars > 0
-- If 0 rows: backup was never created — DO NOT PROCEED.
--   The live function cannot be automatically restored.
--   Retrieve the function body from git history or Supabase point-in-time restore.


-- ── R-02: Restore function from backup ───────────────────────────────────────
-- Executes the stored pg_get_functiondef output as a statement.

DO $$
DECLARE
  v_body TEXT;
BEGIN
  SELECT body INTO v_body
  FROM   public._musigod_fn_backup_20260717
  WHERE  fn_name = 'fn_sync_track_to_graph'
  LIMIT 1;

  IF v_body IS NULL THEN
    RAISE EXCEPTION 'Backup body is NULL — cannot restore. Check _musigod_fn_backup_20260717.';
  END IF;

  EXECUTE v_body;

  RAISE NOTICE 'fn_sync_track_to_graph restored from backup (% chars)', length(v_body);
END;
$$;


-- ── R-03: Confirm restore succeeded ──────────────────────────────────────────

SELECT
  (pg_get_functiondef(oid) ILIKE '%musigod_catalog_track%')        AS still_has_fallback_ns,
  (pg_get_functiondef(oid) ILIKE '%REGEXP_REPLACE%isrc%')          AS still_has_normalization,
  (pg_get_functiondef(oid) ILIKE '%recording_identity_conflicts%') AS still_has_conflict_insert
FROM pg_proc
WHERE proname      = 'fn_sync_track_to_graph'
  AND pronamespace = 'public'::regnamespace;

-- Expected after rollback (function restored to pre-07 state):
--  still_has_fallback_ns | still_has_normalization | still_has_conflict_insert
-- -----------------------+-------------------------+---------------------------
--  f                     | f                       | f
-- (1 row)
--
-- If any value is still 't': the backup body itself contained the 07 changes
-- (i.e., the backup was taken AFTER 07 was applied). In that case, the
-- function cannot be rolled back via this script — use Supabase PITR.


-- ── R-04: Drop conflict table (only if empty) ─────────────────────────────────

DO $$
DECLARE
  v_count BIGINT;
BEGIN
  SELECT count(*) INTO v_count FROM graph.recording_identity_conflicts;
  IF v_count = 0 THEN
    DROP TABLE IF EXISTS graph.recording_identity_conflicts;
    RAISE NOTICE 'graph.recording_identity_conflicts dropped (was empty)';
  ELSE
    RAISE NOTICE 'graph.recording_identity_conflicts NOT dropped — contains % row(s). Review before manual drop.', v_count;
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'graph.recording_identity_conflicts does not exist — nothing to drop';
END;
$$;


-- ── R-05: Reload PostgREST schema cache ──────────────────────────────────────

NOTIFY pgrst, 'reload schema';
