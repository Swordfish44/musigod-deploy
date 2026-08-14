-- Fix dedup bug in fn_create_admin_queue_task_v1
-- Root cause: function does a plain INSERT with no existence check,
-- so callers that fire per-finding-rule produce one row per rule match
-- for the same (queue_name, artist_email, task_title).
--
-- Fix:
--   1. Purge existing duplicate OPEN rows (keep oldest per unique triple).
--   2. Replace function with one that skips INSERT when an identical OPEN
--      task already exists and returns the existing row instead.

-- ── 1. Purge duplicates (keep the oldest row per unique key) ──────────────────
DELETE FROM registrations.admin_queues_v1
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY queue_name, artist_email, task_title, status
        ORDER BY created_at ASC
      ) AS rn
    FROM registrations.admin_queues_v1
    WHERE status = 'OPEN'
  ) ranked
  WHERE rn > 1
);

-- ── 2. Replace function with dedup guard ──────────────────────────────────────
CREATE OR REPLACE FUNCTION registrations.fn_create_admin_queue_task_v1(
  p_queue_name        text,
  p_artist_email      text,
  p_task_title        text,
  p_task_body         text        DEFAULT NULL,
  p_artist_id         uuid        DEFAULT NULL,
  p_audit_id          uuid        DEFAULT NULL,
  p_recovery_case_id  uuid        DEFAULT NULL,
  p_priority          text        DEFAULT 'NORMAL',
  p_assigned_to       text        DEFAULT NULL,
  p_due_at            timestamptz DEFAULT NULL,
  p_metadata          jsonb       DEFAULT '{}'::jsonb
)
RETURNS registrations.admin_queues_v1
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row registrations.admin_queues_v1;
BEGIN
  -- Return existing OPEN task if one already exists for this triple.
  SELECT * INTO v_row
  FROM registrations.admin_queues_v1
  WHERE queue_name   = p_queue_name
    AND artist_email = p_artist_email
    AND task_title   = p_task_title
    AND status       = 'OPEN'
  LIMIT 1;

  IF v_row.id IS NOT NULL THEN
    RETURN v_row;
  END IF;

  INSERT INTO registrations.admin_queues_v1 (
    queue_name, artist_email, task_title, task_body,
    artist_id, audit_id, recovery_case_id,
    priority, assigned_to, due_at, metadata
  ) VALUES (
    p_queue_name, p_artist_email, p_task_title, p_task_body,
    p_artist_id, p_audit_id, p_recovery_case_id,
    p_priority, p_assigned_to, p_due_at, p_metadata
  )
  RETURNING * INTO v_row;

  PERFORM registrations.fn_log_artist_activity_v1(
    p_artist_email     := p_artist_email,
    p_event_type       := 'QUEUE_TASK_CREATED',
    p_event_title      := p_task_title,
    p_event_body       := p_task_body,
    p_artist_id        := p_artist_id,
    p_audit_id         := p_audit_id,
    p_recovery_case_id := p_recovery_case_id,
    p_visibility       := 'ADMIN_ONLY',
    p_created_by       := 'system'
  );

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION registrations.fn_create_admin_queue_task_v1 TO service_role;
