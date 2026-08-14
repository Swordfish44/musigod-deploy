-- Fix fn_build_audit_report_v1: pull total_estimated_recovery from recovery_cases_v1
-- (amount_identified) instead of audit_findings_v1 (estimated_recovery_amount).
-- Also scopes recovery_cases aggregation to the audit_id when provided.

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
  v_report_id          uuid;
  v_findings           jsonb;
  v_recovery_cases     jsonb;
  v_total_recovery     numeric(12,2);  -- sum of findings (for findings section only)
  v_case_total         numeric(12,2);  -- sum of recovery_cases.amount_identified (source of truth)
  v_case_count         integer;
  v_critical_count     integer;
  v_findings_count     integer;
  v_summary            text;
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

  -- Aggregate recovery cases (scoped to audit; sum amount_identified as the dollar figure)
  SELECT
    jsonb_agg(jsonb_build_object(
      'id', id,
      'case_type', case_type,
      'royalty_source', royalty_source,
      'work_title', work_title,
      'amount_identified', amount_identified,
      'amount_recovered', amount_recovered,
      'status', status,
      'priority', priority
    )),
    COALESCE(SUM(amount_identified), 0),
    COUNT(*)
  INTO v_recovery_cases, v_case_total, v_case_count
  FROM registrations.recovery_cases_v1
  WHERE artist_email = p_artist_email
    AND (p_audit_id IS NULL OR audit_id = p_audit_id);

  -- Build executive summary using recovery case totals
  v_summary := 'Rights audit completed for ' || p_artist_email || '. ' ||
    COALESCE(v_findings_count, 0) || ' findings identified across ' ||
    COALESCE(v_case_count, 0) || ' recovery cases with $' ||
    to_char(COALESCE(v_case_total, 0), 'FM999,999,999.00') ||
    ' in recoverable royalties. ' ||
    CASE WHEN COALESCE(v_critical_count, 0) > 0
      THEN v_critical_count || ' critical issue(s) require immediate action.'
      ELSE 'No critical issues identified.'
    END;

  -- Upsert report — total_estimated_recovery now comes from recovery_cases
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
    COALESCE(v_case_total, 0),
    v_summary,
    jsonb_build_object(
      'artist_email',    p_artist_email,
      'audit_id',        p_audit_id,
      'generated_at',    now(),
      'findings',        COALESCE(v_findings, '[]'::jsonb),
      'recovery_cases',  COALESCE(v_recovery_cases, '[]'::jsonb),
      'totals', jsonb_build_object(
        'total_findings',           COALESCE(v_findings_count, 0),
        'critical_findings',        COALESCE(v_critical_count, 0),
        'total_estimated_recovery', COALESCE(v_case_total, 0),
        'recovery_cases_count',     COALESCE(v_case_count, 0)
      )
    )
  )
  ON CONFLICT (report_id) DO UPDATE
    SET status                   = 'READY',
        findings_count           = EXCLUDED.findings_count,
        critical_findings_count  = EXCLUDED.critical_findings_count,
        total_estimated_recovery = EXCLUDED.total_estimated_recovery,
        executive_summary        = EXCLUDED.executive_summary,
        report_data              = EXCLUDED.report_data,
        updated_at               = now(),
        report_version           = audit_reports_v1.report_version + 1
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

GRANT EXECUTE ON FUNCTION registrations.fn_build_audit_report_v1 TO service_role;
