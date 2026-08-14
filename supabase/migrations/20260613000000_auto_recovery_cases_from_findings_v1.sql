-- Auto-create recovery_cases_v1 from audit findings.
-- Adds fn_create_recovery_cases_from_findings_v1 and wires it into
-- fn_run_audit_rules_v1 so the pipeline is fully automatic:
--   fn_run_audit_rules_v1 → findings + recovery cases
--   fn_build_audit_report_v1 → report (already reads both tables)

-- ── 1. fn_create_recovery_cases_from_findings_v1 ────────────────────────────
-- Reads non-rejected findings for the given artist/audit, maps each
-- finding_type to a recovery case, and inserts with a dedup guard on
-- (artist_email, case_type) — one case per type per artist.
-- Returns the number of new cases created.

CREATE OR REPLACE FUNCTION registrations.fn_create_recovery_cases_from_findings_v1(
  p_artist_email  text,
  p_audit_id      uuid  DEFAULT NULL,
  p_artist_id     uuid  DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_finding        RECORD;
  v_artist_name    text;
  v_case_type      text;
  v_royalty_source text;
  v_priority       text;
  v_cases_created  integer := 0;
BEGIN
  -- Look up artist name from the audit record
  SELECT artist_name INTO v_artist_name
  FROM public.rights_audits_v1
  WHERE email = p_artist_email
    AND (p_audit_id IS NULL OR audit_id = p_audit_id)
  LIMIT 1;

  FOR v_finding IN
    SELECT *
    FROM registrations.audit_findings_v1
    WHERE artist_email = p_artist_email
      AND (p_audit_id IS NULL OR audit_id = p_audit_id OR audit_id IS NULL)
      AND status != 'REJECTED'
      AND finding_type IN (
        'PRO_MISSING_REGISTRATION',
        'MLC_NOT_REGISTERED',
        'NEIGHBORING_RIGHTS_MISSING',
        'FOREIGN_COLLECTION_GAP',
        'PUBLISHING_ADMIN_CONFLICT'
      )
  LOOP
    -- Map finding_type → case_type + royalty_source
    CASE v_finding.finding_type
      WHEN 'PRO_MISSING_REGISTRATION'   THEN
        v_case_type      := 'PRO';
        v_royalty_source := 'ASCAP/BMI/SESAC Verification';
      WHEN 'MLC_NOT_REGISTERED'         THEN
        v_case_type      := 'MLC';
        v_royalty_source := 'The MLC (Mechanical Licensing Collective)';
      WHEN 'NEIGHBORING_RIGHTS_MISSING' THEN
        v_case_type      := 'SOUND_EXCHANGE';
        v_royalty_source := 'SoundExchange';
      WHEN 'FOREIGN_COLLECTION_GAP'     THEN
        v_case_type      := 'FOREIGN_COLLECTION';
        v_royalty_source := 'International Collection Societies';
      WHEN 'PUBLISHING_ADMIN_CONFLICT'  THEN
        v_case_type      := 'PUBLISHING_ADMIN';
        v_royalty_source := 'Publishing Administration';
      ELSE
        CONTINUE;
    END CASE;

    -- Map severity → queue priority
    v_priority := CASE v_finding.severity
      WHEN 'CRITICAL' THEN 'URGENT'
      WHEN 'HIGH'     THEN 'HIGH'
      WHEN 'MEDIUM'   THEN 'NORMAL'
      ELSE                 'LOW'
    END;

    -- Dedup guard: one case per type per artist (across all audits)
    IF EXISTS (
      SELECT 1 FROM registrations.recovery_cases_v1
      WHERE artist_email = p_artist_email
        AND case_type    = v_case_type
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO registrations.recovery_cases_v1 (
      artist_id, artist_email, artist_name, audit_id,
      case_type, royalty_source, work_title,
      amount_identified, amount_recovered,
      status, priority, recovery_confidence_score
    ) VALUES (
      p_artist_id,
      p_artist_email,
      v_artist_name,
      p_audit_id,
      v_case_type,
      v_royalty_source,
      v_finding.finding_title,
      v_finding.estimated_recovery_amount,
      0,
      'IDENTIFIED',
      v_priority,
      v_finding.confidence_score
    );

    v_cases_created := v_cases_created + 1;
  END LOOP;

  RETURN v_cases_created;
END;
$$;

GRANT EXECUTE ON FUNCTION registrations.fn_create_recovery_cases_from_findings_v1 TO service_role;

-- ── 2. fn_run_audit_rules_v1 — add recovery case creation at end ─────────────
-- Identical logic to the original; only the final block is new.

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
BEGIN
  -- Rule 1: No PRO recovery case = PRO registration likely missing
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

  -- Log timeline event
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

  -- Auto-create recovery cases from all findings just generated
  PERFORM registrations.fn_create_recovery_cases_from_findings_v1(
    p_artist_email := p_artist_email,
    p_audit_id     := p_audit_id,
    p_artist_id    := p_artist_id
  );

  RETURN v_findings_created;
END;
$$;

GRANT EXECUTE ON FUNCTION registrations.fn_run_audit_rules_v1 TO service_role;
