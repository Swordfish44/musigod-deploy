-- MusiGod Audit Intelligence Layer v1
-- Migration: 20260601_musigod_audit_intelligence_v1.sql
-- Idempotent. Safe to re-run.

-- ============================================================
-- PHASE 1: DOCUMENT ANALYSIS
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.document_analysis_v1 (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id          uuid REFERENCES registrations.artist_documents_v1(id) ON DELETE SET NULL,
  artist_email         text NOT NULL,
  artist_id            uuid,
  audit_id             uuid,
  recovery_case_id     uuid,
  analysis_type        text NOT NULL DEFAULT 'DOCUMENT_SCAN',
  extracted_text       text,
  extracted_entities   jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_issues      jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence_score     numeric(5,2) NOT NULL DEFAULT 0,
  ai_summary           text,
  status               text NOT NULL DEFAULT 'PENDING',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doc_analysis_document_id    ON registrations.document_analysis_v1 (document_id);
CREATE INDEX IF NOT EXISTS idx_doc_analysis_artist_email   ON registrations.document_analysis_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_doc_analysis_audit_id       ON registrations.document_analysis_v1 (audit_id);
CREATE INDEX IF NOT EXISTS idx_doc_analysis_status         ON registrations.document_analysis_v1 (status);
CREATE INDEX IF NOT EXISTS idx_doc_analysis_created_at     ON registrations.document_analysis_v1 (created_at DESC);

-- ============================================================
-- PHASE 2: AUDIT FINDINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.audit_findings_v1 (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_email              text NOT NULL,
  artist_id                 uuid,
  audit_id                  uuid,
  document_analysis_id      uuid REFERENCES registrations.document_analysis_v1(id) ON DELETE SET NULL,
  recovery_case_id          uuid REFERENCES registrations.recovery_cases_v1(id) ON DELETE SET NULL,
  finding_type              text NOT NULL,
  severity                  text NOT NULL DEFAULT 'MEDIUM',
  finding_title             text NOT NULL,
  finding_body              text,
  recommendation            text,
  estimated_recovery_amount numeric(12,2) NOT NULL DEFAULT 0,
  confidence_score          numeric(5,2) NOT NULL DEFAULT 0,
  status                    text NOT NULL DEFAULT 'OPEN',
  admin_notes               text,
  reviewed_by               text,
  reviewed_at               timestamptz,
  metadata                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_findings_artist_email       ON registrations.audit_findings_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_findings_artist_id          ON registrations.audit_findings_v1 (artist_id);
CREATE INDEX IF NOT EXISTS idx_findings_audit_id           ON registrations.audit_findings_v1 (audit_id);
CREATE INDEX IF NOT EXISTS idx_findings_finding_type       ON registrations.audit_findings_v1 (finding_type);
CREATE INDEX IF NOT EXISTS idx_findings_severity           ON registrations.audit_findings_v1 (severity);
CREATE INDEX IF NOT EXISTS idx_findings_status             ON registrations.audit_findings_v1 (status);
CREATE INDEX IF NOT EXISTS idx_findings_created_at         ON registrations.audit_findings_v1 (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_estimated_recovery ON registrations.audit_findings_v1 (estimated_recovery_amount DESC);

-- ============================================================
-- PHASE 3: AUDIT REPORTS
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.audit_reports_v1 (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id                 text NOT NULL UNIQUE DEFAULT 'RPT-' || upper(substring(gen_random_uuid()::text, 1, 8)),
  artist_email              text NOT NULL,
  artist_id                 uuid,
  audit_id                  uuid,
  status                    text NOT NULL DEFAULT 'DRAFT',
  report_version            integer NOT NULL DEFAULT 1,
  findings_count            integer NOT NULL DEFAULT 0,
  critical_findings_count   integer NOT NULL DEFAULT 0,
  total_estimated_recovery  numeric(12,2) NOT NULL DEFAULT 0,
  executive_summary         text,
  report_data               jsonb NOT NULL DEFAULT '{}'::jsonb,
  pdf_path                  text,
  pdf_generated_at          timestamptz,
  emailed_at                timestamptz,
  approved_by               text,
  approved_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reports_artist_email  ON registrations.audit_reports_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_reports_audit_id      ON registrations.audit_reports_v1 (audit_id);
CREATE INDEX IF NOT EXISTS idx_reports_status        ON registrations.audit_reports_v1 (status);
CREATE INDEX IF NOT EXISTS idx_reports_report_id     ON registrations.audit_reports_v1 (report_id);
CREATE INDEX IF NOT EXISTS idx_reports_created_at    ON registrations.audit_reports_v1 (created_at DESC);

-- ============================================================
-- VIEWS
-- ============================================================

CREATE OR REPLACE VIEW registrations.v_audit_findings_summary_v1 AS
SELECT
  artist_email,
  MAX(artist_id::text)::uuid                                          AS artist_id,
  audit_id,
  COUNT(*)                                                            AS total_findings,
  COUNT(*) FILTER (WHERE severity = 'CRITICAL')                      AS critical_count,
  COUNT(*) FILTER (WHERE severity = 'HIGH')                          AS high_count,
  COUNT(*) FILTER (WHERE severity = 'MEDIUM')                        AS medium_count,
  COUNT(*) FILTER (WHERE severity = 'LOW')                           AS low_count,
  COUNT(*) FILTER (WHERE status = 'OPEN')                            AS open_count,
  COUNT(*) FILTER (WHERE status = 'APPROVED')                        AS approved_count,
  COUNT(*) FILTER (WHERE status = 'REJECTED')                        AS rejected_count,
  COALESCE(SUM(estimated_recovery_amount), 0)                        AS total_estimated_recovery,
  COALESCE(SUM(estimated_recovery_amount) FILTER (WHERE status = 'APPROVED'), 0) AS approved_recovery,
  MAX(created_at)                                                     AS last_finding_at
FROM registrations.audit_findings_v1
GROUP BY artist_email, audit_id;

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Generate findings from deterministic rules
CREATE OR REPLACE FUNCTION registrations.fn_run_audit_rules_v1(
  p_artist_email  text,
  p_audit_id      uuid  DEFAULT NULL,
  p_artist_id     uuid  DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_findings_created integer := 0;
  v_case_id uuid;
BEGIN
  -- Rule 1: No recovery cases at all = PRO registration likely missing
  IF NOT EXISTS (
    SELECT 1 FROM registrations.recovery_cases_v1
    WHERE artist_email = p_artist_email AND case_type = 'PRO'
  ) THEN
    INSERT INTO registrations.audit_findings_v1 (
      artist_email, artist_id, audit_id, finding_type, severity,
      finding_title, finding_body, recommendation, estimated_recovery_amount, confidence_score
    ) VALUES (
      p_artist_email, p_artist_id, p_audit_id,
      'PRO_MISSING_REGISTRATION', 'HIGH',
      'PRO registration not verified',
      'No PRO (ASCAP, BMI, or SESAC) registration has been confirmed for this artist. Unregistered works cannot collect performance royalties.',
      'Register all works with a PRO immediately. MusiGod will initiate registration on your behalf.',
      5000.00, 80.00
    );
    v_findings_created := v_findings_created + 1;
  END IF;

  -- Rule 2: No MLC recovery case = MLC gap
  IF NOT EXISTS (
    SELECT 1 FROM registrations.recovery_cases_v1
    WHERE artist_email = p_artist_email AND case_type = 'MLC'
  ) THEN
    INSERT INTO registrations.audit_findings_v1 (
      artist_email, artist_id, audit_id, finding_type, severity,
      finding_title, finding_body, recommendation, estimated_recovery_amount, confidence_score
    ) VALUES (
      p_artist_email, p_artist_id, p_audit_id,
      'MLC_NOT_REGISTERED', 'HIGH',
      'MLC (Mechanical Licensing Collective) registration not detected',
      'Digital mechanical royalties from streaming services are collected by the MLC. Artists not registered with MLC are forfeiting streaming mechanical royalties.',
      'Register with the MLC at themlc.com. MusiGod will facilitate registration and claim filing.',
      8000.00, 85.00
    );
    v_findings_created := v_findings_created + 1;
  END IF;

  -- Rule 3: No SoundExchange case = neighboring rights gap
  IF NOT EXISTS (
    SELECT 1 FROM registrations.recovery_cases_v1
    WHERE artist_email = p_artist_email AND case_type = 'SOUND_EXCHANGE'
  ) THEN
    INSERT INTO registrations.audit_findings_v1 (
      artist_email, artist_id, audit_id, finding_type, severity,
      finding_title, finding_body, recommendation, estimated_recovery_amount, confidence_score
    ) VALUES (
      p_artist_email, p_artist_id, p_audit_id,
      'NEIGHBORING_RIGHTS_MISSING', 'HIGH',
      'SoundExchange neighboring rights not registered',
      'SoundExchange collects digital performance royalties for sound recording rights owners and featured artists from satellite radio, internet radio, and cable music services.',
      'Register with SoundExchange. MusiGod will initiate registration and back-royalty claims.',
      6500.00, 82.00
    );
    v_findings_created := v_findings_created + 1;
  END IF;

  -- Rule 4: No foreign collection case = international gap
  IF NOT EXISTS (
    SELECT 1 FROM registrations.recovery_cases_v1
    WHERE artist_email = p_artist_email AND case_type = 'FOREIGN_COLLECTION'
  ) THEN
    INSERT INTO registrations.audit_findings_v1 (
      artist_email, artist_id, audit_id, finding_type, severity,
      finding_title, finding_body, recommendation, estimated_recovery_amount, confidence_score
    ) VALUES (
      p_artist_email, p_artist_id, p_audit_id,
      'FOREIGN_COLLECTION_GAP', 'MEDIUM',
      'International royalty collection not established',
      'Without a publishing administrator filing with international collection societies, foreign performance and mechanical royalties are not being collected.',
      'MusiGod will establish sub-publishing relationships and file retroactive claims with international PROs and collection societies.',
      12000.00, 70.00
    );
    v_findings_created := v_findings_created + 1;
  END IF;

  -- Rule 5: No publishing admin case = publishing rights unmanaged
  IF NOT EXISTS (
    SELECT 1 FROM registrations.recovery_cases_v1
    WHERE artist_email = p_artist_email AND case_type = 'PUBLISHING_ADMIN'
  ) THEN
    INSERT INTO registrations.audit_findings_v1 (
      artist_email, artist_id, audit_id, finding_type, severity,
      finding_title, finding_body, recommendation, estimated_recovery_amount, confidence_score
    ) VALUES (
      p_artist_email, p_artist_id, p_audit_id,
      'PUBLISHING_ADMIN_CONFLICT', 'CRITICAL',
      'No publishing administrator identified',
      'Without active publishing administration, sync licensing, print rights, and international sub-publishing royalties are going uncollected. This is the most significant revenue leak for independent artists.',
      'MusiGod Publishing Administration will serve as your publishing admin — registering works, collecting all royalty streams, and recovering back royalties. Artists retain 100% ownership.',
      45000.00, 90.00
    );
    v_findings_created := v_findings_created + 1;
  END IF;

  -- Log timeline event summarizing findings run
  PERFORM registrations.fn_log_artist_activity_v1(
    p_artist_email     := p_artist_email,
    p_event_type       := 'AUDIT_RULES_RUN',
    p_event_title      := v_findings_created || ' audit findings generated',
    p_event_body       := 'Automated rights audit analysis completed. ' || v_findings_created || ' potential royalty leaks identified.',
    p_artist_id        := p_artist_id,
    p_audit_id         := p_audit_id,
    p_visibility       := 'BOTH',
    p_created_by       := 'audit_engine'
  );

  RETURN v_findings_created;
END;
$$;

-- Update finding status
CREATE OR REPLACE FUNCTION registrations.fn_update_finding_status_v1(
  p_finding_id   uuid,
  p_status       text,
  p_admin_notes  text  DEFAULT NULL,
  p_reviewed_by  text  DEFAULT 'admin'
)
RETURNS registrations.audit_findings_v1
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row registrations.audit_findings_v1;
BEGIN
  UPDATE registrations.audit_findings_v1
  SET
    status       = p_status,
    admin_notes  = COALESCE(p_admin_notes, admin_notes),
    reviewed_by  = p_reviewed_by,
    reviewed_at  = now(),
    updated_at   = now()
  WHERE id = p_finding_id
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Finding not found: %', p_finding_id;
  END IF;

  PERFORM registrations.fn_log_artist_activity_v1(
    p_artist_email := v_row.artist_email,
    p_event_type   := 'FINDING_' || p_status,
    p_event_title  := 'Audit finding ' || lower(p_status) || ': ' || v_row.finding_title,
    p_event_body   := p_admin_notes,
    p_artist_id    := v_row.artist_id,
    p_audit_id     := v_row.audit_id,
    p_visibility   := 'BOTH',
    p_created_by   := p_reviewed_by
  );

  RETURN v_row;
END;
$$;

-- Build report data structure
CREATE OR REPLACE FUNCTION registrations.fn_build_audit_report_v1(
  p_artist_email  text,
  p_audit_id      uuid  DEFAULT NULL,
  p_artist_id     uuid  DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_report_id     uuid;
  v_findings      jsonb;
  v_recovery_cases jsonb;
  v_total_recovery numeric(12,2);
  v_critical_count integer;
  v_findings_count integer;
  v_summary       text;
BEGIN
  -- Aggregate findings
  SELECT
    jsonb_agg(jsonb_build_object(
      'id', id,
      'finding_type', finding_type,
      'severity', severity,
      'finding_title', finding_title,
      'finding_body', finding_body,
      'recommendation', recommendation,
      'estimated_recovery_amount', estimated_recovery_amount,
      'confidence_score', confidence_score,
      'status', status
    ) ORDER BY
      CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
      estimated_recovery_amount DESC
    ),
    COALESCE(SUM(estimated_recovery_amount), 0),
    COUNT(*),
    COUNT(*) FILTER (WHERE severity = 'CRITICAL')
  INTO v_findings, v_total_recovery, v_findings_count, v_critical_count
  FROM registrations.audit_findings_v1
  WHERE artist_email = p_artist_email
    AND (p_audit_id IS NULL OR audit_id = p_audit_id)
    AND status != 'REJECTED';

  -- Aggregate recovery cases
  SELECT jsonb_agg(jsonb_build_object(
    'id', id,
    'case_type', case_type,
    'royalty_source', royalty_source,
    'work_title', work_title,
    'amount_identified', amount_identified,
    'amount_recovered', amount_recovered,
    'status', status,
    'priority', priority
  ))
  INTO v_recovery_cases
  FROM registrations.recovery_cases_v1
  WHERE artist_email = p_artist_email;

  -- Build executive summary
  v_summary := 'Rights audit completed for ' || p_artist_email || '. ' ||
    COALESCE(v_findings_count, 0) || ' findings identified with an estimated $' ||
    to_char(COALESCE(v_total_recovery, 0), 'FM999,999,999.00') ||
    ' in recoverable royalties. ' ||
    CASE WHEN COALESCE(v_critical_count, 0) > 0
      THEN v_critical_count || ' critical issues require immediate action.'
      ELSE 'No critical issues identified.'
    END;

  -- Upsert report
  INSERT INTO registrations.audit_reports_v1 (
    artist_email, artist_id, audit_id,
    status, findings_count, critical_findings_count,
    total_estimated_recovery, executive_summary,
    report_data
  ) VALUES (
    p_artist_email, p_artist_id, p_audit_id,
    'READY',
    COALESCE(v_findings_count, 0),
    COALESCE(v_critical_count, 0),
    COALESCE(v_total_recovery, 0),
    v_summary,
    jsonb_build_object(
      'artist_email',    p_artist_email,
      'audit_id',        p_audit_id,
      'generated_at',    now(),
      'findings',        COALESCE(v_findings, '[]'::jsonb),
      'recovery_cases',  COALESCE(v_recovery_cases, '[]'::jsonb),
      'totals', jsonb_build_object(
        'total_findings',         COALESCE(v_findings_count, 0),
        'critical_findings',      COALESCE(v_critical_count, 0),
        'total_estimated_recovery', COALESCE(v_total_recovery, 0)
      )
    )
  )
  ON CONFLICT (report_id) DO UPDATE
    SET status                  = 'READY',
        findings_count          = EXCLUDED.findings_count,
        critical_findings_count = EXCLUDED.critical_findings_count,
        total_estimated_recovery = EXCLUDED.total_estimated_recovery,
        executive_summary       = EXCLUDED.executive_summary,
        report_data             = EXCLUDED.report_data,
        updated_at              = now(),
        report_version          = audit_reports_v1.report_version + 1
  RETURNING id INTO v_report_id;

  -- Log timeline event
  PERFORM registrations.fn_log_artist_activity_v1(
    p_artist_email := p_artist_email,
    p_event_type   := 'REPORT_GENERATED',
    p_event_title  := 'Rights audit report ready',
    p_event_body   := v_summary,
    p_artist_id    := p_artist_id,
    p_audit_id     := p_audit_id,
    p_visibility   := 'BOTH',
    p_created_by   := 'audit_engine'
  );

  RETURN v_report_id;
END;
$$;

-- ============================================================
-- GRANTS
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.document_analysis_v1 TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.audit_findings_v1     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.audit_reports_v1      TO service_role;
GRANT SELECT ON registrations.v_audit_findings_summary_v1                   TO service_role;

GRANT EXECUTE ON FUNCTION registrations.fn_run_audit_rules_v1          TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_update_finding_status_v1    TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_build_audit_report_v1       TO service_role;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE registrations.document_analysis_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.audit_findings_v1     ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.audit_reports_v1      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_doc_analysis ON registrations.document_analysis_v1;
CREATE POLICY service_role_all_doc_analysis
  ON registrations.document_analysis_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all_findings ON registrations.audit_findings_v1;
CREATE POLICY service_role_all_findings
  ON registrations.audit_findings_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all_reports ON registrations.audit_reports_v1;
CREATE POLICY service_role_all_reports
  ON registrations.audit_reports_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- SEED: Run audit rules for test artist
-- ============================================================

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT registrations.fn_run_audit_rules_v1(
    'swordfishlp44@proton.me',
    NULL,
    '3d4788b6-2a86-4ed5-8f27-ab95b3a230d3'
  ) INTO v_count;

  RAISE NOTICE 'Seeded % audit findings for test artist', v_count;

  PERFORM registrations.fn_build_audit_report_v1(
    'swordfishlp44@proton.me',
    NULL,
    '3d4788b6-2a86-4ed5-8f27-ab95b3a230d3'
  );
END;
$$;
