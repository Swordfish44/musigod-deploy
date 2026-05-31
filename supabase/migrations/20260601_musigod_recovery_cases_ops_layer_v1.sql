-- MusiGod Recovery Cases Operations Layer v1
-- Migration: 20260601_musigod_recovery_cases_ops_layer_v1.sql
-- Idempotent. Safe to re-run.

-- ============================================================
-- TABLES
-- ============================================================

-- 1. recovery_cases_v1
CREATE TABLE IF NOT EXISTS registrations.recovery_cases_v1 (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id                 uuid,
  artist_email              text NOT NULL,
  artist_name               text,
  audit_id                  uuid,
  case_type                 text NOT NULL,
  royalty_source            text,
  work_title                text,
  isrc                      text,
  iswc                      text,
  upc                       text,
  territory                 text NOT NULL DEFAULT 'US',
  amount_identified         numeric(12,2) NOT NULL DEFAULT 0,
  amount_recovered          numeric(12,2) NOT NULL DEFAULT 0,
  musigod_fee_rate          numeric(5,4) NOT NULL DEFAULT 0.1500,
  musigod_fee_amount        numeric(12,2) GENERATED ALWAYS AS (ROUND(amount_recovered * musigod_fee_rate, 2)) STORED,
  recovery_confidence_score numeric(5,2) NOT NULL DEFAULT 0,
  status                    text NOT NULL DEFAULT 'IDENTIFIED',
  priority                  text NOT NULL DEFAULT 'NORMAL',
  assigned_to               text,
  external_reference        text,
  notes                     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  submitted_at              timestamptz,
  recovered_at              timestamptz,
  paid_out_at               timestamptz
);

CREATE INDEX IF NOT EXISTS idx_recovery_cases_artist_email   ON registrations.recovery_cases_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_recovery_cases_artist_id      ON registrations.recovery_cases_v1 (artist_id);
CREATE INDEX IF NOT EXISTS idx_recovery_cases_audit_id       ON registrations.recovery_cases_v1 (audit_id);
CREATE INDEX IF NOT EXISTS idx_recovery_cases_status         ON registrations.recovery_cases_v1 (status);
CREATE INDEX IF NOT EXISTS idx_recovery_cases_priority       ON registrations.recovery_cases_v1 (priority);
CREATE INDEX IF NOT EXISTS idx_recovery_cases_created_at     ON registrations.recovery_cases_v1 (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recovery_cases_case_type      ON registrations.recovery_cases_v1 (case_type);
CREATE INDEX IF NOT EXISTS idx_recovery_cases_amount_rec     ON registrations.recovery_cases_v1 (amount_recovered DESC);

-- 2. artist_documents_v1
CREATE TABLE IF NOT EXISTS registrations.artist_documents_v1 (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id          uuid,
  artist_email       text NOT NULL,
  audit_id           uuid,
  recovery_case_id   uuid REFERENCES registrations.recovery_cases_v1(id) ON DELETE SET NULL,
  document_type      text NOT NULL,
  file_name          text NOT NULL,
  file_path          text NOT NULL,
  storage_bucket     text NOT NULL DEFAULT 'artist-documents',
  mime_type          text,
  file_size_bytes    bigint,
  status             text NOT NULL DEFAULT 'UPLOADED',
  admin_notes        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_artist_docs_artist_email      ON registrations.artist_documents_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_artist_docs_artist_id         ON registrations.artist_documents_v1 (artist_id);
CREATE INDEX IF NOT EXISTS idx_artist_docs_audit_id          ON registrations.artist_documents_v1 (audit_id);
CREATE INDEX IF NOT EXISTS idx_artist_docs_recovery_case_id  ON registrations.artist_documents_v1 (recovery_case_id);
CREATE INDEX IF NOT EXISTS idx_artist_docs_document_type     ON registrations.artist_documents_v1 (document_type);
CREATE INDEX IF NOT EXISTS idx_artist_docs_status            ON registrations.artist_documents_v1 (status);
CREATE INDEX IF NOT EXISTS idx_artist_docs_created_at        ON registrations.artist_documents_v1 (created_at DESC);

-- 3. artist_activity_timeline_v1
CREATE TABLE IF NOT EXISTS registrations.artist_activity_timeline_v1 (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id          uuid,
  artist_email       text NOT NULL,
  audit_id           uuid,
  recovery_case_id   uuid,
  event_type         text NOT NULL,
  event_title        text NOT NULL,
  event_body         text,
  visibility         text NOT NULL DEFAULT 'ARTIST',
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by         text NOT NULL DEFAULT 'system',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_timeline_artist_email         ON registrations.artist_activity_timeline_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_timeline_artist_id            ON registrations.artist_activity_timeline_v1 (artist_id);
CREATE INDEX IF NOT EXISTS idx_timeline_audit_id             ON registrations.artist_activity_timeline_v1 (audit_id);
CREATE INDEX IF NOT EXISTS idx_timeline_recovery_case_id     ON registrations.artist_activity_timeline_v1 (recovery_case_id);
CREATE INDEX IF NOT EXISTS idx_timeline_event_type           ON registrations.artist_activity_timeline_v1 (event_type);
CREATE INDEX IF NOT EXISTS idx_timeline_visibility           ON registrations.artist_activity_timeline_v1 (visibility);
CREATE INDEX IF NOT EXISTS idx_timeline_created_at           ON registrations.artist_activity_timeline_v1 (created_at DESC);

-- 4. admin_queues_v1
CREATE TABLE IF NOT EXISTS registrations.admin_queues_v1 (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name         text NOT NULL,
  artist_id          uuid,
  artist_email       text NOT NULL,
  audit_id           uuid,
  recovery_case_id   uuid REFERENCES registrations.recovery_cases_v1(id) ON DELETE SET NULL,
  task_title         text NOT NULL,
  task_body          text,
  status             text NOT NULL DEFAULT 'OPEN',
  priority           text NOT NULL DEFAULT 'NORMAL',
  assigned_to        text,
  due_at             timestamptz,
  completed_at       timestamptz,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_queues_queue_name       ON registrations.admin_queues_v1 (queue_name);
CREATE INDEX IF NOT EXISTS idx_admin_queues_artist_email     ON registrations.admin_queues_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_admin_queues_artist_id        ON registrations.admin_queues_v1 (artist_id);
CREATE INDEX IF NOT EXISTS idx_admin_queues_audit_id         ON registrations.admin_queues_v1 (audit_id);
CREATE INDEX IF NOT EXISTS idx_admin_queues_recovery_case_id ON registrations.admin_queues_v1 (recovery_case_id);
CREATE INDEX IF NOT EXISTS idx_admin_queues_status           ON registrations.admin_queues_v1 (status);
CREATE INDEX IF NOT EXISTS idx_admin_queues_priority         ON registrations.admin_queues_v1 (priority);
CREATE INDEX IF NOT EXISTS idx_admin_queues_due_at           ON registrations.admin_queues_v1 (due_at);
CREATE INDEX IF NOT EXISTS idx_admin_queues_created_at       ON registrations.admin_queues_v1 (created_at DESC);

-- ============================================================
-- VIEWS
-- ============================================================

CREATE OR REPLACE VIEW registrations.v_recovered_money_dashboard_v1 AS
SELECT
  COALESCE(SUM(amount_identified), 0)                                      AS total_amount_identified,
  COALESCE(SUM(amount_recovered), 0)                                       AS total_amount_recovered,
  COALESCE(SUM(musigod_fee_amount), 0)                                     AS total_musigod_fees,
  COUNT(*) FILTER (WHERE status NOT IN ('RECOVERED','PAID_OUT','CLOSED_NO_RECOVERY','REJECTED')) AS open_cases,
  COUNT(*) FILTER (WHERE status IN ('RECOVERED','PAID_OUT'))               AS recovered_cases,
  COUNT(*) FILTER (WHERE status = 'PAID_OUT')                              AS paid_out_cases,
  ROUND(AVG(recovery_confidence_score), 2)                                 AS avg_recovery_confidence,
  jsonb_agg(DISTINCT jsonb_build_object(
    'case_type', case_type,
    'count', ct.cnt,
    'total_identified', ct.total_identified,
    'total_recovered', ct.total_recovered
  )) FILTER (WHERE case_type IS NOT NULL)                                  AS by_case_type
FROM registrations.recovery_cases_v1
CROSS JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE rc2.case_type = recovery_cases_v1.case_type) AS cnt,
    SUM(rc2.amount_identified) FILTER (WHERE rc2.case_type = recovery_cases_v1.case_type) AS total_identified,
    SUM(rc2.amount_recovered) FILTER (WHERE rc2.case_type = recovery_cases_v1.case_type) AS total_recovered
  FROM registrations.recovery_cases_v1 rc2
) ct;

-- Simpler, more reliable version
DROP VIEW IF EXISTS registrations.v_recovered_money_dashboard_v1;
CREATE VIEW registrations.v_recovered_money_dashboard_v1 AS
SELECT
  COALESCE(SUM(amount_identified), 0)                                                        AS total_amount_identified,
  COALESCE(SUM(amount_recovered), 0)                                                         AS total_amount_recovered,
  COALESCE(SUM(musigod_fee_amount), 0)                                                       AS total_musigod_fees,
  COUNT(*) FILTER (WHERE status NOT IN ('RECOVERED','PAID_OUT','CLOSED_NO_RECOVERY','REJECTED')) AS open_cases,
  COUNT(*) FILTER (WHERE status IN ('RECOVERED','PAID_OUT'))                                 AS recovered_cases,
  COUNT(*) FILTER (WHERE status = 'PAID_OUT')                                                AS paid_out_cases,
  ROUND(AVG(recovery_confidence_score), 2)                                                   AS avg_recovery_confidence
FROM registrations.recovery_cases_v1;

CREATE OR REPLACE VIEW registrations.v_case_type_breakdown_v1 AS
SELECT
  case_type,
  COUNT(*)                         AS case_count,
  COALESCE(SUM(amount_identified), 0) AS total_identified,
  COALESCE(SUM(amount_recovered), 0)  AS total_recovered,
  COALESCE(SUM(musigod_fee_amount), 0) AS total_fees
FROM registrations.recovery_cases_v1
GROUP BY case_type
ORDER BY total_identified DESC;

CREATE OR REPLACE VIEW registrations.v_admin_queue_summary_v1 AS
SELECT
  queue_name,
  status,
  priority,
  COUNT(*)          AS task_count,
  MIN(created_at)   AS oldest_task_at,
  MIN(due_at)       AS next_due_at
FROM registrations.admin_queues_v1
GROUP BY queue_name, status, priority
ORDER BY queue_name, status, priority;

CREATE OR REPLACE VIEW registrations.v_artist_recovery_summary_v1 AS
SELECT
  artist_email,
  MAX(artist_name)                                                           AS artist_name,
  MAX(artist_id::text)::uuid                                                 AS artist_id,
  COUNT(*)                                                                   AS total_cases,
  COALESCE(SUM(amount_identified), 0)                                        AS total_identified,
  COALESCE(SUM(amount_recovered), 0)                                         AS total_recovered,
  COALESCE(SUM(musigod_fee_amount), 0)                                       AS total_musigod_fee,
  COUNT(*) FILTER (WHERE status NOT IN ('RECOVERED','PAID_OUT','CLOSED_NO_RECOVERY','REJECTED')) AS open_cases,
  COUNT(*) FILTER (WHERE status IN ('RECOVERED','PAID_OUT'))                 AS recovered_cases,
  MAX(updated_at)                                                            AS last_activity_at
FROM registrations.recovery_cases_v1
GROUP BY artist_email
ORDER BY total_identified DESC;

-- ============================================================
-- FUNCTIONS
-- ============================================================

CREATE OR REPLACE FUNCTION registrations.fn_log_artist_activity_v1(
  p_artist_email      text,
  p_event_type        text,
  p_event_title       text,
  p_event_body        text    DEFAULT NULL,
  p_artist_id         uuid    DEFAULT NULL,
  p_audit_id          uuid    DEFAULT NULL,
  p_recovery_case_id  uuid    DEFAULT NULL,
  p_visibility        text    DEFAULT 'ARTIST',
  p_metadata          jsonb   DEFAULT '{}'::jsonb,
  p_created_by        text    DEFAULT 'system'
)
RETURNS registrations.artist_activity_timeline_v1
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row registrations.artist_activity_timeline_v1;
BEGIN
  INSERT INTO registrations.artist_activity_timeline_v1 (
    artist_email, event_type, event_title, event_body,
    artist_id, audit_id, recovery_case_id,
    visibility, metadata, created_by
  ) VALUES (
    p_artist_email, p_event_type, p_event_title, p_event_body,
    p_artist_id, p_audit_id, p_recovery_case_id,
    p_visibility, p_metadata, p_created_by
  )
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION registrations.fn_create_admin_queue_task_v1(
  p_queue_name        text,
  p_artist_email      text,
  p_task_title        text,
  p_task_body         text    DEFAULT NULL,
  p_artist_id         uuid    DEFAULT NULL,
  p_audit_id          uuid    DEFAULT NULL,
  p_recovery_case_id  uuid    DEFAULT NULL,
  p_priority          text    DEFAULT 'NORMAL',
  p_assigned_to       text    DEFAULT NULL,
  p_due_at            timestamptz DEFAULT NULL,
  p_metadata          jsonb   DEFAULT '{}'::jsonb
)
RETURNS registrations.admin_queues_v1
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row registrations.admin_queues_v1;
BEGIN
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

  -- Auto-log timeline event
  PERFORM registrations.fn_log_artist_activity_v1(
    p_artist_email  := p_artist_email,
    p_event_type    := 'QUEUE_TASK_CREATED',
    p_event_title   := p_task_title,
    p_event_body    := p_task_body,
    p_artist_id     := p_artist_id,
    p_audit_id      := p_audit_id,
    p_recovery_case_id := p_recovery_case_id,
    p_visibility    := 'ADMIN_ONLY',
    p_created_by    := 'system'
  );

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION registrations.fn_update_recovery_case_status_v1(
  p_case_id    uuid,
  p_new_status text,
  p_notes      text DEFAULT NULL,
  p_updated_by text DEFAULT 'system'
)
RETURNS registrations.recovery_cases_v1
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row   registrations.recovery_cases_v1;
  v_now   timestamptz := now();
BEGIN
  UPDATE registrations.recovery_cases_v1
  SET
    status       = p_new_status,
    updated_at   = v_now,
    notes        = COALESCE(p_notes, notes),
    submitted_at  = CASE WHEN p_new_status = 'SUBMITTED'  AND submitted_at  IS NULL THEN v_now ELSE submitted_at  END,
    recovered_at  = CASE WHEN p_new_status = 'RECOVERED'  AND recovered_at  IS NULL THEN v_now ELSE recovered_at  END,
    paid_out_at   = CASE WHEN p_new_status = 'PAID_OUT'   AND paid_out_at   IS NULL THEN v_now ELSE paid_out_at   END
  WHERE id = p_case_id
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Recovery case not found: %', p_case_id;
  END IF;

  -- Log timeline
  PERFORM registrations.fn_log_artist_activity_v1(
    p_artist_email     := v_row.artist_email,
    p_event_type       := 'CASE_STATUS_UPDATED',
    p_event_title      := 'Recovery case status updated to ' || p_new_status,
    p_event_body       := p_notes,
    p_artist_id        := v_row.artist_id,
    p_recovery_case_id := v_row.id,
    p_visibility       := 'BOTH',
    p_created_by       := p_updated_by
  );

  RETURN v_row;
END;
$$;

-- ============================================================
-- STORAGE BUCKET
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'artist-documents',
  'artist-documents',
  false,
  10485760,
  ARRAY['application/pdf','image/png','image/jpeg','image/jpg','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE registrations.recovery_cases_v1         ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.artist_documents_v1        ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.artist_activity_timeline_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.admin_queues_v1            ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS — all writes go through API routes using service key.
-- No public write policies. Read policies via service role only.

-- ============================================================
-- SEED DATA
-- ============================================================

DO $$
DECLARE
  v_case_id uuid;
BEGIN
  -- Seed recovery case
  INSERT INTO registrations.recovery_cases_v1 (
    artist_id, artist_email, artist_name, case_type,
    royalty_source, work_title, amount_identified,
    amount_recovered, status, priority, recovery_confidence_score
  )
  VALUES (
    '3d4788b6-2a86-4ed5-8f27-ab95b3a230d3',
    'swordfishlp44@proton.me',
    'NAIM',
    'PRO',
    'ASCAP/BMI/SESAC Verification',
    'Test Recovery Case',
    195000.00,
    0.00,
    'IDENTIFIED',
    'HIGH',
    85.00
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_case_id;

  IF v_case_id IS NULL THEN
    SELECT id INTO v_case_id
    FROM registrations.recovery_cases_v1
    WHERE artist_email = 'swordfishlp44@proton.me'
    AND work_title = 'Test Recovery Case'
    LIMIT 1;
  END IF;

  -- Seed timeline event
  INSERT INTO registrations.artist_activity_timeline_v1 (
    artist_id, artist_email, recovery_case_id,
    event_type, event_title, event_body, visibility, created_by
  )
  VALUES (
    '3d4788b6-2a86-4ed5-8f27-ab95b3a230d3',
    'swordfishlp44@proton.me',
    v_case_id,
    'CASE_OPENED',
    'MusiGod identified $195,000 in potential royalties',
    'PRO registration gaps and unclaimed royalties identified across ASCAP/BMI/SESAC. Recovery case opened.',
    'BOTH',
    'system'
  );

  -- Seed admin queue task
  INSERT INTO registrations.admin_queues_v1 (
    queue_name, artist_email, artist_id, recovery_case_id,
    task_title, task_body, status, priority
  )
  VALUES (
    'PRO_REGISTRATION_QUEUE',
    'swordfishlp44@proton.me',
    '3d4788b6-2a86-4ed5-8f27-ab95b3a230d3',
    v_case_id,
    'Verify PRO registrations for NAIM',
    'Check ASCAP/BMI/SESAC registration status. $195,000 identified. High priority.',
    'OPEN',
    'HIGH'
  );
END;
$$;
