-- MusiGod Strategic Builds 1-5
-- Migration: 20260602_musigod_intelligence_layer_v1.sql
-- Idempotent. Safe to re-run.

-- ============================================================
-- BUILD 1: AUDIT NARRATIVES
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.audit_narratives_v1 (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_email        text NOT NULL,
  artist_id           uuid,
  audit_id            uuid,
  report_id           uuid REFERENCES registrations.audit_reports_v1(id) ON DELETE SET NULL,
  narrative_type      text NOT NULL DEFAULT 'EXECUTIVE_SUMMARY',
  narrative_text      text NOT NULL,
  ai_enhanced         boolean NOT NULL DEFAULT false,
  admin_overridden    boolean NOT NULL DEFAULT false,
  admin_override_text text,
  confidence_level    text NOT NULL DEFAULT 'HIGH',
  status              text NOT NULL DEFAULT 'ACTIVE',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_narratives_artist_email ON registrations.audit_narratives_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_narratives_audit_id     ON registrations.audit_narratives_v1 (audit_id);
CREATE INDEX IF NOT EXISTS idx_narratives_report_id    ON registrations.audit_narratives_v1 (report_id);
CREATE INDEX IF NOT EXISTS idx_narratives_type         ON registrations.audit_narratives_v1 (narrative_type);
CREATE INDEX IF NOT EXISTS idx_narratives_created_at   ON registrations.audit_narratives_v1 (created_at DESC);

-- ============================================================
-- BUILD 2: AUDIT SCORES
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.audit_scores_v1 (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_email               text NOT NULL,
  artist_id                  uuid,
  audit_id                   uuid,
  confidence_score           numeric(5,2) NOT NULL DEFAULT 0,
  financial_impact_score     numeric(5,2) NOT NULL DEFAULT 0,
  urgency_score              numeric(5,2) NOT NULL DEFAULT 0,
  recovery_probability       numeric(5,2) NOT NULL DEFAULT 0,
  operational_priority_score numeric(5,2) NOT NULL DEFAULT 0,
  composite_score            numeric(5,2) GENERATED ALWAYS AS (
    ROUND((confidence_score * 0.20 + financial_impact_score * 0.30 + urgency_score * 0.20 + recovery_probability * 0.20 + operational_priority_score * 0.10), 2)
  ) STORED,
  score_factors              jsonb NOT NULL DEFAULT '{}'::jsonb,
  score_version              integer NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scores_artist_email        ON registrations.audit_scores_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_scores_composite           ON registrations.audit_scores_v1 (composite_score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_financial_impact    ON registrations.audit_scores_v1 (financial_impact_score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_urgency             ON registrations.audit_scores_v1 (urgency_score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_recovery_probability ON registrations.audit_scores_v1 (recovery_probability DESC);
CREATE INDEX IF NOT EXISTS idx_scores_created_at          ON registrations.audit_scores_v1 (created_at DESC);

-- ============================================================
-- BUILD 3: ROYALTY LEAKAGE SCORES
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.royalty_leakage_scores_v1 (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_email          text NOT NULL,
  artist_id             uuid,
  audit_id              uuid,
  leakage_score         integer NOT NULL DEFAULT 0 CHECK (leakage_score BETWEEN 0 AND 100),
  leakage_label         text NOT NULL DEFAULT 'UNKNOWN',
  score_breakdown       jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_score        integer,
  score_delta           integer GENERATED ALWAYS AS (leakage_score - COALESCE(previous_score, leakage_score)) STORED,
  catalog_size_factor   numeric(4,2) NOT NULL DEFAULT 1.0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leakage_artist_email  ON registrations.royalty_leakage_scores_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_leakage_score         ON registrations.royalty_leakage_scores_v1 (leakage_score DESC);
CREATE INDEX IF NOT EXISTS idx_leakage_created_at    ON registrations.royalty_leakage_scores_v1 (created_at DESC);

-- ============================================================
-- BUILD 4: RECOVERY AUTOMATION
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.recovery_automation_rules_v1 (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name       text NOT NULL UNIQUE,
  finding_type    text NOT NULL,
  trigger_status  text NOT NULL DEFAULT 'OPEN',
  action_type     text NOT NULL,
  action_config   jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_enabled      boolean NOT NULL DEFAULT true,
  priority        integer NOT NULL DEFAULT 50,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registrations.recovery_automation_runs_v1 (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         uuid REFERENCES registrations.recovery_automation_rules_v1(id) ON DELETE SET NULL,
  rule_name       text,
  finding_id      uuid REFERENCES registrations.audit_findings_v1(id) ON DELETE SET NULL,
  artist_email    text NOT NULL,
  action_type     text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING',
  result          jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message   text,
  retry_count     integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_dedup
  ON registrations.recovery_automation_runs_v1 (rule_name, finding_id)
  WHERE status IN ('COMPLETED', 'PENDING');

CREATE INDEX IF NOT EXISTS idx_automation_runs_artist  ON registrations.recovery_automation_runs_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status  ON registrations.recovery_automation_runs_v1 (status);
CREATE INDEX IF NOT EXISTS idx_automation_runs_created ON registrations.recovery_automation_runs_v1 (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_rules_enabled ON registrations.recovery_automation_rules_v1 (is_enabled, priority);

-- ============================================================
-- VIEWS
-- ============================================================

CREATE OR REPLACE VIEW registrations.v_leakage_dashboard_v1 AS
SELECT
  ls.artist_email,
  ls.artist_id,
  ls.leakage_score,
  ls.leakage_label,
  ls.score_delta,
  ls.score_breakdown,
  rc.total_identified,
  rc.total_recovered,
  rc.open_cases,
  f.total_findings,
  f.critical_count,
  ls.updated_at
FROM registrations.royalty_leakage_scores_v1 ls
LEFT JOIN (
  SELECT artist_email,
    COALESCE(SUM(amount_identified),0) AS total_identified,
    COALESCE(SUM(amount_recovered),0)  AS total_recovered,
    COUNT(*) FILTER (WHERE status NOT IN ('RECOVERED','PAID_OUT','CLOSED_NO_RECOVERY','REJECTED')) AS open_cases
  FROM registrations.recovery_cases_v1
  GROUP BY artist_email
) rc ON rc.artist_email = ls.artist_email
LEFT JOIN (
  SELECT artist_email,
    COUNT(*) AS total_findings,
    COUNT(*) FILTER (WHERE severity = 'CRITICAL') AS critical_count
  FROM registrations.audit_findings_v1
  GROUP BY artist_email
) f ON f.artist_email = ls.artist_email
ORDER BY ls.leakage_score DESC;

CREATE OR REPLACE VIEW registrations.v_admin_intelligence_v1 AS
SELECT
  -- Recovery summary
  (SELECT COALESCE(SUM(amount_identified),0) FROM registrations.recovery_cases_v1) AS total_identified,
  (SELECT COALESCE(SUM(amount_recovered),0) FROM registrations.recovery_cases_v1)  AS total_recovered,
  (SELECT COALESCE(SUM(musigod_fee_amount),0) FROM registrations.recovery_cases_v1) AS total_fees_projected,
  -- Case counts
  (SELECT COUNT(*) FROM registrations.recovery_cases_v1 WHERE status NOT IN ('RECOVERED','PAID_OUT','CLOSED_NO_RECOVERY','REJECTED')) AS open_cases,
  (SELECT COUNT(*) FROM registrations.recovery_cases_v1 WHERE status IN ('RECOVERED','PAID_OUT')) AS recovered_cases,
  -- Findings
  (SELECT COUNT(*) FROM registrations.audit_findings_v1 WHERE status = 'OPEN') AS open_findings,
  (SELECT COUNT(*) FROM registrations.audit_findings_v1 WHERE severity = 'CRITICAL' AND status = 'OPEN') AS critical_open_findings,
  -- Queues
  (SELECT COUNT(*) FROM registrations.admin_queues_v1 WHERE status = 'OPEN') AS open_queue_tasks,
  (SELECT COUNT(*) FROM registrations.admin_queues_v1 WHERE status = 'BLOCKED') AS blocked_queue_tasks,
  (SELECT COUNT(*) FROM registrations.admin_queues_v1 WHERE priority = 'URGENT' AND status = 'OPEN') AS urgent_tasks,
  -- Documents
  (SELECT COUNT(*) FROM registrations.artist_documents_v1 WHERE status = 'UPLOADED') AS pending_doc_reviews,
  -- Reports
  (SELECT COUNT(*) FROM registrations.audit_reports_v1 WHERE status = 'READY') AS ready_reports,
  -- Leakage
  (SELECT ROUND(AVG(leakage_score),1) FROM registrations.royalty_leakage_scores_v1) AS avg_leakage_score,
  (SELECT COUNT(*) FROM registrations.royalty_leakage_scores_v1 WHERE leakage_score >= 70) AS high_leakage_artists,
  -- Automation
  (SELECT COUNT(*) FROM registrations.recovery_automation_runs_v1 WHERE status = 'FAILED') AS failed_automation_runs,
  now() AS generated_at;

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Build 1: Generate narrative from findings
CREATE OR REPLACE FUNCTION registrations.fn_generate_narrative_v1(
  p_artist_email  text,
  p_audit_id      uuid DEFAULT NULL,
  p_artist_id     uuid DEFAULT NULL,
  p_report_id     uuid DEFAULT NULL
)
RETURNS registrations.audit_narratives_v1
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_findings        RECORD;
  v_total_findings  integer := 0;
  v_critical_count  integer := 0;
  v_total_recovery  numeric(12,2) := 0;
  v_has_pro         boolean := false;
  v_has_mlc         boolean := false;
  v_has_sx          boolean := false;
  v_has_foreign     boolean := false;
  v_has_pub_admin   boolean := false;
  v_narrative       text;
  v_confidence      text := 'HIGH';
  v_row             registrations.audit_narratives_v1;
BEGIN
  -- Aggregate findings
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE severity = 'CRITICAL'),
    COALESCE(SUM(estimated_recovery_amount), 0),
    bool_or(finding_type = 'PRO_MISSING_REGISTRATION'),
    bool_or(finding_type = 'MLC_NOT_REGISTERED'),
    bool_or(finding_type = 'NEIGHBORING_RIGHTS_MISSING'),
    bool_or(finding_type = 'FOREIGN_COLLECTION_GAP'),
    bool_or(finding_type = 'PUBLISHING_ADMIN_CONFLICT')
  INTO
    v_total_findings, v_critical_count, v_total_recovery,
    v_has_pro, v_has_mlc, v_has_sx, v_has_foreign, v_has_pub_admin
  FROM registrations.audit_findings_v1
  WHERE artist_email = p_artist_email
    AND status != 'REJECTED'
    AND (p_audit_id IS NULL OR audit_id = p_audit_id);

  -- Determine confidence from finding count
  IF v_total_findings = 0 THEN
    v_confidence := 'LOW';
  ELSIF v_total_findings <= 2 THEN
    v_confidence := 'MEDIUM';
  ELSE
    v_confidence := 'HIGH';
  END IF;

  -- Build narrative
  v_narrative := 'MusiGod completed a rights audit for this artist. ';

  IF v_total_findings = 0 THEN
    v_narrative := v_narrative || 'No significant royalty leakage indicators were detected at this time. Continued monitoring is recommended as catalog activity evolves.';
  ELSE
    v_narrative := v_narrative || v_total_findings || ' potential royalty issue' ||
      CASE WHEN v_total_findings > 1 THEN 's were' ELSE ' was' END || ' identified, ' ||
      'representing an estimated $' || to_char(v_total_recovery, 'FM999,999,999') || ' in recoverable royalties. ';

    IF v_critical_count > 0 THEN
      v_narrative := v_narrative || v_critical_count || ' critical issue' ||
        CASE WHEN v_critical_count > 1 THEN 's require' ELSE ' requires' END || ' immediate attention. ';
    END IF;

    IF v_has_pub_admin THEN
      v_narrative := v_narrative || 'Publishing administration gaps represent the most significant revenue risk — sync, print, and international sub-publishing royalties are likely going uncollected. ';
    END IF;

    IF v_has_pro THEN
      v_narrative := v_narrative || 'PRO registration coverage appears incomplete, which may result in uncollected performance royalties. ';
    END IF;

    IF v_has_mlc THEN
      v_narrative := v_narrative || 'MLC registration has not been confirmed — digital mechanical royalties from streaming services may not be flowing to this artist. ';
    END IF;

    IF v_has_sx THEN
      v_narrative := v_narrative || 'SoundExchange registration gaps indicate probable neighboring rights royalty leakage from satellite and internet radio. ';
    END IF;

    IF v_has_foreign THEN
      v_narrative := v_narrative || 'International collection infrastructure is not established, limiting foreign performance and mechanical royalty recovery. ';
    END IF;

    v_narrative := v_narrative || 'MusiGod recommends immediate action on all identified issues. Artists retain full ownership throughout the recovery process.';
  END IF;

  -- Upsert narrative
  INSERT INTO registrations.audit_narratives_v1 (
    artist_email, artist_id, audit_id, report_id,
    narrative_type, narrative_text, confidence_level
  ) VALUES (
    p_artist_email, p_artist_id, p_audit_id, p_report_id,
    'EXECUTIVE_SUMMARY', v_narrative, v_confidence
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    -- Update existing
    UPDATE registrations.audit_narratives_v1
    SET narrative_text = v_narrative,
        confidence_level = v_confidence,
        updated_at = now()
    WHERE artist_email = p_artist_email
      AND narrative_type = 'EXECUTIVE_SUMMARY'
      AND (p_audit_id IS NULL OR audit_id = p_audit_id)
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

-- Build 2: Recalculate audit scores
CREATE OR REPLACE FUNCTION registrations.fn_recalculate_audit_scores_v1(
  p_artist_email text,
  p_audit_id     uuid DEFAULT NULL,
  p_artist_id    uuid DEFAULT NULL
)
RETURNS registrations.audit_scores_v1
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total_findings      integer := 0;
  v_critical_count      integer := 0;
  v_total_recovery      numeric(12,2) := 0;
  v_has_missing_reg     boolean := false;
  v_has_neighbor        boolean := false;
  v_has_conflict        boolean := false;
  v_open_cases          integer := 0;
  v_confidence          numeric(5,2);
  v_financial_impact    numeric(5,2);
  v_urgency             numeric(5,2);
  v_recovery_prob       numeric(5,2);
  v_op_priority         numeric(5,2);
  v_factors             jsonb;
  v_row                 registrations.audit_scores_v1;
BEGIN
  SELECT
    COUNT(*), COUNT(*) FILTER (WHERE severity = 'CRITICAL'),
    COALESCE(SUM(estimated_recovery_amount), 0),
    bool_or(finding_type IN ('PRO_MISSING_REGISTRATION','MLC_NOT_REGISTERED','NEIGHBORING_RIGHTS_MISSING')),
    bool_or(finding_type = 'NEIGHBORING_RIGHTS_MISSING'),
    bool_or(finding_type IN ('ISRC_MISMATCH','DUPLICATE_SPLIT','DISTRIBUTOR_METADATA_CONFLICT'))
  INTO v_total_findings, v_critical_count, v_total_recovery,
       v_has_missing_reg, v_has_neighbor, v_has_conflict
  FROM registrations.audit_findings_v1
  WHERE artist_email = p_artist_email AND status != 'REJECTED'
    AND (p_audit_id IS NULL OR audit_id = p_audit_id);

  SELECT COUNT(*) INTO v_open_cases
  FROM registrations.recovery_cases_v1
  WHERE artist_email = p_artist_email
    AND status NOT IN ('RECOVERED','PAID_OUT','CLOSED_NO_RECOVERY','REJECTED');

  -- Confidence: based on number of findings and their confirmation
  v_confidence := LEAST(100, GREATEST(0,
    CASE WHEN v_total_findings >= 3 THEN 85
         WHEN v_total_findings >= 1 THEN 65
         ELSE 30 END
  ));

  -- Financial impact: based on estimated recovery
  v_financial_impact := LEAST(100, GREATEST(0,
    CASE WHEN v_total_recovery >= 50000 THEN 95
         WHEN v_total_recovery >= 20000 THEN 80
         WHEN v_total_recovery >= 10000 THEN 65
         WHEN v_total_recovery >= 5000  THEN 50
         WHEN v_total_recovery > 0      THEN 30
         ELSE 10 END
  ));

  -- Urgency: missing registrations and critical findings drive this
  v_urgency := LEAST(100, GREATEST(0,
    (CASE WHEN v_has_missing_reg THEN 40 ELSE 0 END) +
    (CASE WHEN v_critical_count > 0 THEN 35 ELSE 0 END) +
    (CASE WHEN v_open_cases > 3 THEN 25 ELSE v_open_cases * 5 END)
  ));

  -- Recovery probability: neighboring rights and missing PRO are high probability
  v_recovery_prob := LEAST(100, GREATEST(0,
    (CASE WHEN v_has_neighbor THEN 30 ELSE 0 END) +
    (CASE WHEN v_has_missing_reg THEN 35 ELSE 0 END) +
    (CASE WHEN v_total_recovery > 0 THEN 20 ELSE 0 END) +
    (CASE WHEN v_open_cases > 0 THEN 15 ELSE 0 END)
  ));

  -- Operational priority: conflicts and open cases
  v_op_priority := LEAST(100, GREATEST(0,
    (CASE WHEN v_has_conflict THEN 30 ELSE 0 END) +
    (CASE WHEN v_critical_count > 0 THEN 40 ELSE 0 END) +
    (CASE WHEN v_open_cases > 0 THEN 30 ELSE 0 END)
  ));

  v_factors := jsonb_build_object(
    'total_findings', v_total_findings,
    'critical_count', v_critical_count,
    'total_estimated_recovery', v_total_recovery,
    'has_missing_registrations', v_has_missing_reg,
    'has_neighboring_rights_gap', v_has_neighbor,
    'has_metadata_conflicts', v_has_conflict,
    'open_recovery_cases', v_open_cases
  );

  INSERT INTO registrations.audit_scores_v1 (
    artist_email, artist_id, audit_id,
    confidence_score, financial_impact_score, urgency_score,
    recovery_probability, operational_priority_score, score_factors
  ) VALUES (
    p_artist_email, p_artist_id, p_audit_id,
    v_confidence, v_financial_impact, v_urgency,
    v_recovery_prob, v_op_priority, v_factors
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    UPDATE registrations.audit_scores_v1
    SET confidence_score = v_confidence,
        financial_impact_score = v_financial_impact,
        urgency_score = v_urgency,
        recovery_probability = v_recovery_prob,
        operational_priority_score = v_op_priority,
        score_factors = v_factors,
        score_version = score_version + 1,
        updated_at = now()
    WHERE artist_email = p_artist_email
      AND (p_audit_id IS NULL OR audit_id = p_audit_id)
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

-- Build 3: Calculate leakage score
CREATE OR REPLACE FUNCTION registrations.fn_calculate_leakage_score_v1(
  p_artist_email text,
  p_audit_id     uuid DEFAULT NULL,
  p_artist_id    uuid DEFAULT NULL
)
RETURNS registrations.royalty_leakage_scores_v1
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_score           integer := 0;
  v_prev_score      integer := NULL;
  v_breakdown       jsonb := '{}'::jsonb;
  v_label           text;
  v_has_pro         boolean := false;
  v_has_mlc         boolean := false;
  v_has_sx          boolean := false;
  v_has_foreign     boolean := false;
  v_has_pub_admin   boolean := false;
  v_has_isrc        boolean := false;
  v_has_split       boolean := false;
  v_has_metadata    boolean := false;
  v_row             registrations.royalty_leakage_scores_v1;
BEGIN
  -- Get existing score
  SELECT leakage_score INTO v_prev_score
  FROM registrations.royalty_leakage_scores_v1
  WHERE artist_email = p_artist_email
  ORDER BY created_at DESC LIMIT 1;

  -- Check findings
  SELECT
    bool_or(finding_type = 'PRO_MISSING_REGISTRATION'),
    bool_or(finding_type = 'MLC_NOT_REGISTERED'),
    bool_or(finding_type = 'NEIGHBORING_RIGHTS_MISSING'),
    bool_or(finding_type = 'FOREIGN_COLLECTION_GAP'),
    bool_or(finding_type = 'PUBLISHING_ADMIN_CONFLICT'),
    bool_or(finding_type = 'ISRC_MISMATCH'),
    bool_or(finding_type = 'DUPLICATE_SPLIT'),
    bool_or(finding_type IN ('DISTRIBUTOR_METADATA_CONFLICT','MISSING_WRITER_SHARE'))
  INTO v_has_pro, v_has_mlc, v_has_sx, v_has_foreign, v_has_pub_admin,
       v_has_isrc, v_has_split, v_has_metadata
  FROM registrations.audit_findings_v1
  WHERE artist_email = p_artist_email AND status != 'REJECTED';

  -- Score components (sum to 100)
  IF v_has_pub_admin THEN v_score := v_score + 25; END IF;
  IF v_has_mlc       THEN v_score := v_score + 20; END IF;
  IF v_has_pro       THEN v_score := v_score + 18; END IF;
  IF v_has_sx        THEN v_score := v_score + 15; END IF;
  IF v_has_foreign   THEN v_score := v_score + 10; END IF;
  IF v_has_isrc      THEN v_score := v_score + 5; END IF;
  IF v_has_split     THEN v_score := v_score + 4; END IF;
  IF v_has_metadata  THEN v_score := v_score + 3; END IF;

  v_score := LEAST(100, v_score);

  v_breakdown := jsonb_build_object(
    'publishing_admin_missing',  v_has_pub_admin,
    'mlc_not_registered',        v_has_mlc,
    'pro_missing',               v_has_pro,
    'soundexchange_missing',     v_has_sx,
    'foreign_collection_gap',    v_has_foreign,
    'isrc_issues',               v_has_isrc,
    'split_sheet_issues',        v_has_split,
    'metadata_conflicts',        v_has_metadata
  );

  v_label := CASE
    WHEN v_score >= 80 THEN 'CRITICAL'
    WHEN v_score >= 60 THEN 'HIGH'
    WHEN v_score >= 40 THEN 'MEDIUM'
    WHEN v_score >= 20 THEN 'LOW'
    ELSE 'MINIMAL'
  END;

  INSERT INTO registrations.royalty_leakage_scores_v1 (
    artist_email, artist_id, audit_id,
    leakage_score, leakage_label, score_breakdown, previous_score
  ) VALUES (
    p_artist_email, p_artist_id, p_audit_id,
    v_score, v_label, v_breakdown, v_prev_score
  )
  RETURNING * INTO v_row;

  -- Log significant changes
  IF v_prev_score IS NOT NULL AND ABS(v_score - v_prev_score) >= 10 THEN
    PERFORM registrations.fn_log_artist_activity_v1(
      p_artist_email := p_artist_email,
      p_event_type   := 'LEAKAGE_SCORE_CHANGED',
      p_event_title  := 'Royalty Leakage Score™ updated to ' || v_score || '/100',
      p_event_body   := 'Score changed from ' || v_prev_score || ' to ' || v_score || '. Label: ' || v_label,
      p_artist_id    := p_artist_id,
      p_audit_id     := p_audit_id,
      p_visibility   := 'BOTH',
      p_created_by   := 'scoring_engine'
    );
  END IF;

  RETURN v_row;
END;
$$;

-- Build 4: Process findings through automation rules
CREATE OR REPLACE FUNCTION registrations.fn_process_audit_findings_v1(
  p_artist_email text,
  p_audit_id     uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_finding       RECORD;
  v_rule          RECORD;
  v_runs_created  integer := 0;
  v_case_id       uuid;
BEGIN
  FOR v_finding IN
    SELECT * FROM registrations.audit_findings_v1
    WHERE artist_email = p_artist_email
      AND status = 'OPEN'
      AND (p_audit_id IS NULL OR audit_id = p_audit_id)
  LOOP
    FOR v_rule IN
      SELECT * FROM registrations.recovery_automation_rules_v1
      WHERE is_enabled = true
        AND finding_type = v_finding.finding_type
        AND trigger_status = v_finding.status
      ORDER BY priority ASC
    LOOP
      -- Idempotency check
      IF EXISTS (
        SELECT 1 FROM registrations.recovery_automation_runs_v1
        WHERE rule_name = v_rule.rule_name
          AND finding_id = v_finding.id
          AND status IN ('COMPLETED','PENDING')
      ) THEN
        CONTINUE;
      END IF;

      -- Execute action
      IF v_rule.action_type = 'CREATE_RECOVERY_CASE' THEN
        INSERT INTO registrations.recovery_cases_v1 (
          artist_email, artist_id, audit_id,
          case_type, royalty_source, work_title,
          amount_identified, status, priority
        )
        SELECT
          v_finding.artist_email,
          v_finding.artist_id,
          v_finding.audit_id,
          COALESCE((v_rule.action_config->>'case_type')::text, 'OTHER'),
          v_finding.finding_title,
          'Auto-created from finding: ' || v_finding.finding_type,
          v_finding.estimated_recovery_amount,
          'IDENTIFIED',
          CASE v_finding.severity
            WHEN 'CRITICAL' THEN 'URGENT'
            WHEN 'HIGH' THEN 'HIGH'
            ELSE 'NORMAL'
          END
        WHERE NOT EXISTS (
          SELECT 1 FROM registrations.recovery_cases_v1
          WHERE artist_email = v_finding.artist_email
            AND case_type = COALESCE((v_rule.action_config->>'case_type')::text, 'OTHER')
            AND status NOT IN ('CLOSED_NO_RECOVERY','REJECTED')
        )
        RETURNING id INTO v_case_id;

      ELSIF v_rule.action_type = 'CREATE_QUEUE_TASK' THEN
        PERFORM registrations.fn_create_admin_queue_task_v1(
          p_queue_name    := COALESCE((v_rule.action_config->>'queue_name')::text, 'RECOVERY_PENDING_QUEUE'),
          p_artist_email  := v_finding.artist_email,
          p_task_title    := 'Auto: ' || v_finding.finding_title,
          p_task_body     := v_finding.finding_body,
          p_artist_id     := v_finding.artist_id,
          p_audit_id      := v_finding.audit_id,
          p_priority      := CASE v_finding.severity WHEN 'CRITICAL' THEN 'URGENT' WHEN 'HIGH' THEN 'HIGH' ELSE 'NORMAL' END
        );
      END IF;

      -- Log run
      INSERT INTO registrations.recovery_automation_runs_v1 (
        rule_id, rule_name, finding_id, artist_email,
        action_type, status, result
      ) VALUES (
        v_rule.id, v_rule.rule_name, v_finding.id, v_finding.artist_email,
        v_rule.action_type, 'COMPLETED',
        jsonb_build_object('case_id', v_case_id, 'finding_type', v_finding.finding_type)
      );

      v_runs_created := v_runs_created + 1;
    END LOOP;
  END LOOP;

  RETURN v_runs_created;
END;
$$;

-- ============================================================
-- GRANTS
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.audit_narratives_v1          TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.audit_scores_v1              TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.royalty_leakage_scores_v1    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.recovery_automation_rules_v1 TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.recovery_automation_runs_v1  TO service_role;

GRANT SELECT ON registrations.v_leakage_dashboard_v1    TO service_role;
GRANT SELECT ON registrations.v_admin_intelligence_v1   TO service_role;

GRANT EXECUTE ON FUNCTION registrations.fn_generate_narrative_v1          TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_recalculate_audit_scores_v1    TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_calculate_leakage_score_v1     TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_process_audit_findings_v1      TO service_role;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE registrations.audit_narratives_v1          ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.audit_scores_v1              ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.royalty_leakage_scores_v1    ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.recovery_automation_rules_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.recovery_automation_runs_v1  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS srole_narratives ON registrations.audit_narratives_v1;
CREATE POLICY srole_narratives ON registrations.audit_narratives_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS srole_scores ON registrations.audit_scores_v1;
CREATE POLICY srole_scores ON registrations.audit_scores_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS srole_leakage ON registrations.royalty_leakage_scores_v1;
CREATE POLICY srole_leakage ON registrations.royalty_leakage_scores_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS srole_auto_rules ON registrations.recovery_automation_rules_v1;
CREATE POLICY srole_auto_rules ON registrations.recovery_automation_rules_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS srole_auto_runs ON registrations.recovery_automation_runs_v1;
CREATE POLICY srole_auto_runs ON registrations.recovery_automation_runs_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- SEED: Default automation rules
-- ============================================================

INSERT INTO registrations.recovery_automation_rules_v1
  (rule_name, finding_type, trigger_status, action_type, action_config, priority)
VALUES
  ('auto_pro_recovery_case',      'PRO_MISSING_REGISTRATION',   'OPEN', 'CREATE_RECOVERY_CASE', '{"case_type":"PRO"}',              10),
  ('auto_mlc_recovery_case',      'MLC_NOT_REGISTERED',         'OPEN', 'CREATE_RECOVERY_CASE', '{"case_type":"MLC"}',              10),
  ('auto_sx_recovery_case',       'NEIGHBORING_RIGHTS_MISSING', 'OPEN', 'CREATE_RECOVERY_CASE', '{"case_type":"SOUND_EXCHANGE"}',   10),
  ('auto_foreign_recovery_case',  'FOREIGN_COLLECTION_GAP',     'OPEN', 'CREATE_RECOVERY_CASE', '{"case_type":"FOREIGN_COLLECTION"}',10),
  ('auto_pub_admin_queue',        'PUBLISHING_ADMIN_CONFLICT',  'OPEN', 'CREATE_QUEUE_TASK',    '{"queue_name":"PRO_REGISTRATION_QUEUE"}', 20),
  ('auto_critical_escalation',    'PUBLISHING_ADMIN_CONFLICT',  'OPEN', 'CREATE_QUEUE_TASK',    '{"queue_name":"ESCALATION_QUEUE"}', 30)
ON CONFLICT (rule_name) DO NOTHING;

-- ============================================================
-- SEED: Run full intelligence pipeline for test artist
-- ============================================================

DO $$
DECLARE
  v_narrative registrations.audit_narratives_v1;
  v_score     registrations.audit_scores_v1;
  v_leakage   registrations.royalty_leakage_scores_v1;
  v_runs      integer;
BEGIN
  SELECT registrations.fn_generate_narrative_v1('swordfishlp44@proton.me', NULL, '3d4788b6-2a86-4ed5-8f27-ab95b3a230d3') INTO v_narrative;
  SELECT registrations.fn_recalculate_audit_scores_v1('swordfishlp44@proton.me', NULL, '3d4788b6-2a86-4ed5-8f27-ab95b3a230d3') INTO v_score;
  SELECT registrations.fn_calculate_leakage_score_v1('swordfishlp44@proton.me', NULL, '3d4788b6-2a86-4ed5-8f27-ab95b3a230d3') INTO v_leakage;
  SELECT registrations.fn_process_audit_findings_v1('swordfishlp44@proton.me', NULL) INTO v_runs;
  RAISE NOTICE 'Intelligence pipeline complete. Leakage score: %, Automation runs: %', v_leakage.leakage_score, v_runs;
END;
$$;
