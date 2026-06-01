-- MusiGod Recovery Conversion + Trust Surface Layer
-- Migration: 20260602_musigod_recovery_conversion_v1.sql
-- Idempotent. Safe to re-run.

-- ============================================================
-- BUILD 1: RECOVERY ESTIMATES
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.recovery_estimates_v1 (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_email          text NOT NULL,
  artist_id             uuid,
  audit_id              uuid,
  recovery_case_id      uuid REFERENCES registrations.recovery_cases_v1(id) ON DELETE SET NULL,
  estimate_low          numeric(12,2) NOT NULL DEFAULT 0,
  estimate_high         numeric(12,2) NOT NULL DEFAULT 0,
  estimate_confidence   text NOT NULL DEFAULT 'MEDIUM',
  estimate_reasoning    text,
  methodology_version   text NOT NULL DEFAULT 'v1',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_est_artist_email  ON registrations.recovery_estimates_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_est_audit_id      ON registrations.recovery_estimates_v1 (audit_id);
CREATE INDEX IF NOT EXISTS idx_est_high          ON registrations.recovery_estimates_v1 (estimate_high DESC);
CREATE INDEX IF NOT EXISTS idx_est_created_at    ON registrations.recovery_estimates_v1 (created_at DESC);

-- ============================================================
-- BUILD 2: RECOVERY PROBABILITY SCORES
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.recovery_probability_scores_v1 (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_email            text NOT NULL,
  artist_id               uuid,
  audit_id                uuid,
  recovery_probability    numeric(5,2) NOT NULL DEFAULT 0,
  operational_confidence  numeric(5,2) NOT NULL DEFAULT 0,
  confidence_reason       text,
  verification_status     text NOT NULL DEFAULT 'UNVERIFIED',
  score_factors           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prob_artist_email   ON registrations.recovery_probability_scores_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_prob_probability    ON registrations.recovery_probability_scores_v1 (recovery_probability DESC);
CREATE INDEX IF NOT EXISTS idx_prob_created_at     ON registrations.recovery_probability_scores_v1 (created_at DESC);

-- ============================================================
-- BUILD 3: RECOMMENDED ACTIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.recommended_actions_v1 (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_email             text NOT NULL,
  artist_id                uuid,
  audit_id                 uuid,
  recovery_case_id         uuid REFERENCES registrations.recovery_cases_v1(id) ON DELETE SET NULL,
  finding_id               uuid REFERENCES registrations.audit_findings_v1(id) ON DELETE SET NULL,
  action_type              text NOT NULL,
  action_title             text NOT NULL,
  action_body              text,
  urgency                  text NOT NULL DEFAULT 'NORMAL',
  assigned_to              text,
  estimated_impact         text,
  estimated_recovery_value numeric(12,2) NOT NULL DEFAULT 0,
  status                   text NOT NULL DEFAULT 'PENDING',
  completed_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_actions_artist_email ON registrations.recommended_actions_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_actions_urgency       ON registrations.recommended_actions_v1 (urgency);
CREATE INDEX IF NOT EXISTS idx_actions_status        ON registrations.recommended_actions_v1 (status);
CREATE INDEX IF NOT EXISTS idx_actions_created_at    ON registrations.recommended_actions_v1 (created_at DESC);

-- ============================================================
-- BUILD 4: OPERATIONAL STATUS
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.operational_status_v1 (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_email             text NOT NULL,
  artist_id                uuid,
  audit_id                 uuid,
  recovery_case_id         uuid REFERENCES registrations.recovery_cases_v1(id) ON DELETE SET NULL,
  current_state            text NOT NULL DEFAULT 'INTAKE_RECEIVED',
  state_label              text NOT NULL DEFAULT 'Intake Received',
  state_description        text,
  assigned_operator        text,
  escalation_level         integer NOT NULL DEFAULT 0,
  blocking_dependencies    jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_milestone           text,
  next_milestone_due_at    timestamptz,
  status_history           jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_stalled               boolean NOT NULL DEFAULT false,
  stalled_since            timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opstatus_artist_email   ON registrations.operational_status_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_opstatus_current_state  ON registrations.operational_status_v1 (current_state);
CREATE INDEX IF NOT EXISTS idx_opstatus_is_stalled     ON registrations.operational_status_v1 (is_stalled);
CREATE INDEX IF NOT EXISTS idx_opstatus_created_at     ON registrations.operational_status_v1 (created_at DESC);

-- ============================================================
-- BUILD 5: AUDIT CONFIDENCE
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.audit_confidence_v1 (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_email                text NOT NULL,
  artist_id                   uuid,
  audit_id                    uuid,
  audit_confidence_level      text NOT NULL DEFAULT 'MEDIUM',
  confidence_explanation      text,
  metadata_quality_score      numeric(5,2) NOT NULL DEFAULT 0,
  document_quality_score      numeric(5,2) NOT NULL DEFAULT 0,
  verification_coverage_score numeric(5,2) NOT NULL DEFAULT 0,
  composite_confidence        numeric(5,2) GENERATED ALWAYS AS (
    ROUND((metadata_quality_score * 0.35 + document_quality_score * 0.35 + verification_coverage_score * 0.30), 2)
  ) STORED,
  warnings                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_confidence_artist_email ON registrations.audit_confidence_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_confidence_level        ON registrations.audit_confidence_v1 (audit_confidence_level);
CREATE INDEX IF NOT EXISTS idx_confidence_created_at   ON registrations.audit_confidence_v1 (created_at DESC);

-- ============================================================
-- RECOVERY CONVERSION: ENGAGEMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.recovery_engagements_v1 (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_ref           text NOT NULL UNIQUE DEFAULT 'ENG-' || upper(substring(gen_random_uuid()::text, 1, 8)),
  artist_email             text NOT NULL,
  artist_id                uuid,
  audit_id                 uuid,
  recovery_case_id         uuid REFERENCES registrations.recovery_cases_v1(id) ON DELETE SET NULL,
  service_type             text NOT NULL,
  service_title            text NOT NULL,
  service_description      text,
  estimated_recovery_low   numeric(12,2) NOT NULL DEFAULT 0,
  estimated_recovery_high  numeric(12,2) NOT NULL DEFAULT 0,
  recovery_probability     numeric(5,2) NOT NULL DEFAULT 0,
  musigod_fee_rate         numeric(5,4) NOT NULL DEFAULT 0.1500,
  status                   text NOT NULL DEFAULT 'PROPOSED',
  authorized_at            timestamptz,
  authorized_by            text,
  assigned_operator        text,
  completion_notes         text,
  completed_at             timestamptz,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_engagements_artist_email ON registrations.recovery_engagements_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_engagements_status       ON registrations.recovery_engagements_v1 (status);
CREATE INDEX IF NOT EXISTS idx_engagements_service_type ON registrations.recovery_engagements_v1 (service_type);
CREATE INDEX IF NOT EXISTS idx_engagements_created_at   ON registrations.recovery_engagements_v1 (created_at DESC);

-- ============================================================
-- VIEWS
-- ============================================================

CREATE OR REPLACE VIEW registrations.v_artist_trust_surface_v1 AS
SELECT
  ac.artist_email,
  ac.artist_id,
  ac.audit_id,
  ac.audit_confidence_level,
  ac.composite_confidence,
  ac.metadata_quality_score,
  ac.document_quality_score,
  ac.verification_coverage_score,
  ac.warnings,
  re.estimate_low,
  re.estimate_high,
  re.estimate_confidence,
  rp.recovery_probability,
  rp.confidence_reason,
  ls.leakage_score,
  ls.leakage_label,
  os.current_state,
  os.state_label,
  os.next_milestone,
  os.is_stalled
FROM registrations.audit_confidence_v1 ac
LEFT JOIN registrations.recovery_estimates_v1 re
  ON re.artist_email = ac.artist_email
  AND (ac.audit_id IS NULL OR re.audit_id = ac.audit_id)
LEFT JOIN registrations.recovery_probability_scores_v1 rp
  ON rp.artist_email = ac.artist_email
  AND (ac.audit_id IS NULL OR rp.audit_id = ac.audit_id)
LEFT JOIN LATERAL (
  SELECT leakage_score, leakage_label
  FROM registrations.royalty_leakage_scores_v1
  WHERE artist_email = ac.artist_email
  ORDER BY created_at DESC LIMIT 1
) ls ON true
LEFT JOIN LATERAL (
  SELECT current_state, state_label, next_milestone, is_stalled
  FROM registrations.operational_status_v1
  WHERE artist_email = ac.artist_email
  ORDER BY created_at DESC LIMIT 1
) os ON true;

CREATE OR REPLACE VIEW registrations.v_recovery_conversion_pipeline_v1 AS
SELECT
  e.artist_email,
  e.service_type,
  e.service_title,
  e.estimated_recovery_low,
  e.estimated_recovery_high,
  e.recovery_probability,
  e.status,
  e.authorized_at,
  e.engagement_ref,
  e.created_at,
  ROUND(e.estimated_recovery_high * e.musigod_fee_rate, 2) AS projected_fee,
  rp.recovery_probability AS latest_prob_score,
  ls.leakage_score
FROM registrations.recovery_engagements_v1 e
LEFT JOIN LATERAL (
  SELECT recovery_probability
  FROM registrations.recovery_probability_scores_v1
  WHERE artist_email = e.artist_email
  ORDER BY created_at DESC LIMIT 1
) rp ON true
LEFT JOIN LATERAL (
  SELECT leakage_score
  FROM registrations.royalty_leakage_scores_v1
  WHERE artist_email = e.artist_email
  ORDER BY created_at DESC LIMIT 1
) ls ON true
ORDER BY e.estimated_recovery_high DESC;

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Generate recovery estimate from findings
CREATE OR REPLACE FUNCTION registrations.fn_generate_recovery_estimate_v1(
  p_artist_email text,
  p_audit_id     uuid DEFAULT NULL,
  p_artist_id    uuid DEFAULT NULL
)
RETURNS registrations.recovery_estimates_v1
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_total_low       numeric(12,2) := 0;
  v_total_high      numeric(12,2) := 0;
  v_confidence      text := 'MEDIUM';
  v_reasoning       text;
  v_finding_count   integer := 0;
  v_has_pro         boolean := false;
  v_has_mlc         boolean := false;
  v_has_sx          boolean := false;
  v_has_foreign     boolean := false;
  v_has_pub_admin   boolean := false;
  v_row             registrations.recovery_estimates_v1;
BEGIN
  SELECT COUNT(*),
    bool_or(finding_type = 'PRO_MISSING_REGISTRATION'),
    bool_or(finding_type = 'MLC_NOT_REGISTERED'),
    bool_or(finding_type = 'NEIGHBORING_RIGHTS_MISSING'),
    bool_or(finding_type = 'FOREIGN_COLLECTION_GAP'),
    bool_or(finding_type = 'PUBLISHING_ADMIN_CONFLICT')
  INTO v_finding_count, v_has_pro, v_has_mlc, v_has_sx, v_has_foreign, v_has_pub_admin
  FROM registrations.audit_findings_v1
  WHERE artist_email = p_artist_email AND status != 'REJECTED'
    AND (p_audit_id IS NULL OR audit_id = p_audit_id);

  -- Build low/high estimate ranges per finding type
  IF v_has_pub_admin THEN v_total_low := v_total_low + 25000; v_total_high := v_total_high + 65000; END IF;
  IF v_has_mlc       THEN v_total_low := v_total_low + 5000;  v_total_high := v_total_high + 15000; END IF;
  IF v_has_pro       THEN v_total_low := v_total_low + 3000;  v_total_high := v_total_high + 9000;  END IF;
  IF v_has_sx        THEN v_total_low := v_total_low + 4000;  v_total_high := v_total_high + 11000; END IF;
  IF v_has_foreign   THEN v_total_low := v_total_low + 6000;  v_total_high := v_total_high + 18000; END IF;

  IF v_finding_count >= 4     THEN v_confidence := 'HIGH';
  ELSIF v_finding_count >= 2  THEN v_confidence := 'MEDIUM';
  ELSE                             v_confidence := 'LOW';
  END IF;

  v_reasoning := 'Estimate based on ' || v_finding_count || ' identified findings. ' ||
    CASE WHEN v_has_pub_admin THEN 'Publishing administration gaps contribute the largest potential recovery ($25K–$65K range). ' ELSE '' END ||
    CASE WHEN v_has_mlc       THEN 'MLC registration gap estimated at $5K–$15K in uncollected mechanicals. ' ELSE '' END ||
    CASE WHEN v_has_pro       THEN 'PRO performance royalties estimated at $3K–$9K recoverable. ' ELSE '' END ||
    CASE WHEN v_has_sx        THEN 'SoundExchange neighboring rights estimated at $4K–$11K. ' ELSE '' END ||
    CASE WHEN v_has_foreign   THEN 'International collection gap estimated at $6K–$18K. ' ELSE '' END ||
    'Ranges reflect typical recovery outcomes for independent artists. Actual recovery depends on catalog size, release history, and distribution coverage.';

  DELETE FROM registrations.recovery_estimates_v1
  WHERE artist_email = p_artist_email AND (p_audit_id IS NULL OR audit_id = p_audit_id);

  INSERT INTO registrations.recovery_estimates_v1 (
    artist_email, artist_id, audit_id,
    estimate_low, estimate_high, estimate_confidence, estimate_reasoning
  ) VALUES (
    p_artist_email, p_artist_id, p_audit_id,
    v_total_low, v_total_high, v_confidence, v_reasoning
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

-- Generate recovery probability score
CREATE OR REPLACE FUNCTION registrations.fn_generate_recovery_probability_v1(
  p_artist_email text,
  p_audit_id     uuid DEFAULT NULL,
  p_artist_id    uuid DEFAULT NULL
)
RETURNS registrations.recovery_probability_scores_v1
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_prob            numeric(5,2) := 0;
  v_op_conf         numeric(5,2) := 0;
  v_reason          text;
  v_factors         jsonb;
  v_finding_count   integer := 0;
  v_doc_count       integer := 0;
  v_has_pro         boolean := false;
  v_has_mlc         boolean := false;
  v_has_neighbor    boolean := false;
  v_has_foreign     boolean := false;
  v_row             registrations.recovery_probability_scores_v1;
BEGIN
  SELECT COUNT(*),
    bool_or(finding_type = 'PRO_MISSING_REGISTRATION'),
    bool_or(finding_type = 'MLC_NOT_REGISTERED'),
    bool_or(finding_type = 'NEIGHBORING_RIGHTS_MISSING'),
    bool_or(finding_type = 'FOREIGN_COLLECTION_GAP')
  INTO v_finding_count, v_has_pro, v_has_mlc, v_has_neighbor, v_has_foreign
  FROM registrations.audit_findings_v1
  WHERE artist_email = p_artist_email AND status != 'REJECTED'
    AND (p_audit_id IS NULL OR audit_id = p_audit_id);

  SELECT COUNT(*) INTO v_doc_count
  FROM registrations.artist_documents_v1
  WHERE artist_email = p_artist_email AND status IN ('ACCEPTED','UPLOADED');

  -- Base probability from finding types
  IF v_has_neighbor  THEN v_prob := v_prob + 25; END IF;
  IF v_has_mlc       THEN v_prob := v_prob + 22; END IF;
  IF v_has_pro       THEN v_prob := v_prob + 20; END IF;
  IF v_has_foreign   THEN v_prob := v_prob + 15; END IF;
  IF v_finding_count >= 3 THEN v_prob := v_prob + 10; END IF;
  IF v_doc_count > 0 THEN v_prob := v_prob + 8; END IF;

  v_prob    := LEAST(97, v_prob);
  v_op_conf := LEAST(95, CASE WHEN v_doc_count > 2 THEN 85 WHEN v_doc_count > 0 THEN 70 ELSE 55 END);

  v_factors := jsonb_build_object(
    'finding_count', v_finding_count,
    'document_count', v_doc_count,
    'has_pro_gap', v_has_pro,
    'has_mlc_gap', v_has_mlc,
    'has_neighboring_rights_gap', v_has_neighbor,
    'has_foreign_gap', v_has_foreign
  );

  v_reason := CASE
    WHEN v_prob >= 80 THEN 'High probability based on confirmed registration gaps and established recovery pathways for these royalty types.'
    WHEN v_prob >= 60 THEN 'Moderate-to-high probability. Missing registrations detected across multiple royalty collection systems.'
    WHEN v_prob >= 40 THEN 'Moderate probability. Some registration gaps identified; additional documentation would increase confidence.'
    ELSE 'Lower probability at this stage. Additional document uploads recommended to improve assessment accuracy.'
  END;

  DELETE FROM registrations.recovery_probability_scores_v1
  WHERE artist_email = p_artist_email AND (p_audit_id IS NULL OR audit_id = p_audit_id);

  INSERT INTO registrations.recovery_probability_scores_v1 (
    artist_email, artist_id, audit_id,
    recovery_probability, operational_confidence,
    confidence_reason, verification_status, score_factors
  ) VALUES (
    p_artist_email, p_artist_id, p_audit_id,
    v_prob, v_op_conf, v_reason,
    CASE WHEN v_doc_count > 0 THEN 'PARTIAL' ELSE 'UNVERIFIED' END,
    v_factors
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

-- Generate recommended actions
CREATE OR REPLACE FUNCTION registrations.fn_generate_recommended_actions_v1(
  p_artist_email text,
  p_audit_id     uuid DEFAULT NULL,
  p_artist_id    uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_finding RECORD;
  v_count   integer := 0;
  v_action_type text;
  v_action_title text;
  v_action_body text;
  v_urgency text;
  v_impact  text;
  v_value   numeric(12,2);
BEGIN
  -- Clear existing pending actions for this artist
  DELETE FROM registrations.recommended_actions_v1
  WHERE artist_email = p_artist_email
    AND status = 'PENDING'
    AND (p_audit_id IS NULL OR audit_id = p_audit_id);

  FOR v_finding IN
    SELECT * FROM registrations.audit_findings_v1
    WHERE artist_email = p_artist_email
      AND status NOT IN ('REJECTED','APPROVED')
      AND (p_audit_id IS NULL OR audit_id = p_audit_id)
    ORDER BY
      CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
      estimated_recovery_amount DESC
  LOOP
    v_action_type  := v_finding.finding_type;
    v_urgency      := CASE v_finding.severity WHEN 'CRITICAL' THEN 'IMMEDIATE' WHEN 'HIGH' THEN 'HIGH' WHEN 'MEDIUM' THEN 'NORMAL' ELSE 'LOW' END;
    v_value        := v_finding.estimated_recovery_amount;

    CASE v_finding.finding_type
      WHEN 'PUBLISHING_ADMIN_CONFLICT' THEN
        v_action_title := 'Authorize MusiGod as Publishing Administrator';
        v_action_body  := 'Execute a Publishing Administration agreement to enable MusiGod to register works, collect all royalty streams, and recover back royalties. This is the highest-impact action available.';
        v_impact       := 'Unlocks sync licensing, print rights, and international sub-publishing royalty collection.';
      WHEN 'MLC_NOT_REGISTERED' THEN
        v_action_title := 'Submit MLC registration';
        v_action_body  := 'Register with the Mechanical Licensing Collective to collect digital mechanical royalties from streaming services. MusiGod will file registration and retroactive claims on your behalf.';
        v_impact       := 'Unlocks streaming mechanical royalties from Spotify, Apple Music, Amazon Music, and others.';
      WHEN 'PRO_MISSING_REGISTRATION' THEN
        v_action_title := 'Verify PRO registration and ownership percentages';
        v_action_body  := 'Confirm ASCAP, BMI, or SESAC registration status and ensure all works are properly catalogued. MusiGod will audit registration completeness and file corrections.';
        v_impact       := 'Ensures performance royalties flow correctly from radio, streaming, live performance, and sync placements.';
      WHEN 'NEIGHBORING_RIGHTS_MISSING' THEN
        v_action_title := 'Register neighboring rights with SoundExchange';
        v_action_body  := 'Register with SoundExchange to collect digital performance royalties for sound recordings from satellite radio, internet radio, and cable music services.';
        v_impact       := 'Recovers uncollected royalties from Sirius XM, Pandora, and digital radio services.';
      WHEN 'FOREIGN_COLLECTION_GAP' THEN
        v_action_title := 'Establish international collection infrastructure';
        v_action_body  := 'Set up sub-publishing relationships with international collection societies to collect foreign performance and mechanical royalties. MusiGod will manage international filing.';
        v_impact       := 'Unlocks royalty collection from international PROs, particularly in EU, UK, and Asia-Pacific markets.';
      ELSE
        v_action_title := 'Review: ' || replace(v_finding.finding_type, '_', ' ');
        v_action_body  := v_finding.recommendation;
        v_impact       := 'Potential recovery of $' || to_char(v_value, 'FM999,999') || ' in uncollected royalties.';
    END CASE;

    INSERT INTO registrations.recommended_actions_v1 (
      artist_email, artist_id, audit_id, finding_id,
      action_type, action_title, action_body,
      urgency, estimated_impact, estimated_recovery_value
    ) VALUES (
      p_artist_email, p_artist_id, p_audit_id, v_finding.id,
      v_action_type, v_action_title, v_action_body,
      v_urgency, v_impact, v_value
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END; $$;

-- Build audit confidence score
CREATE OR REPLACE FUNCTION registrations.fn_build_audit_confidence_v1(
  p_artist_email text,
  p_audit_id     uuid DEFAULT NULL,
  p_artist_id    uuid DEFAULT NULL
)
RETURNS registrations.audit_confidence_v1
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_doc_count       integer := 0;
  v_finding_count   integer := 0;
  v_accepted_docs   integer := 0;
  v_meta_quality    numeric(5,2);
  v_doc_quality     numeric(5,2);
  v_verify_coverage numeric(5,2);
  v_level           text;
  v_explanation     text;
  v_warnings        jsonb := '[]'::jsonb;
  v_row             registrations.audit_confidence_v1;
BEGIN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'ACCEPTED')
  INTO v_doc_count, v_accepted_docs
  FROM registrations.artist_documents_v1
  WHERE artist_email = p_artist_email;

  SELECT COUNT(*) INTO v_finding_count
  FROM registrations.audit_findings_v1
  WHERE artist_email = p_artist_email AND status != 'REJECTED'
    AND (p_audit_id IS NULL OR audit_id = p_audit_id);

  -- Metadata quality: based on findings completeness
  v_meta_quality := CASE
    WHEN v_finding_count = 0 THEN 60
    WHEN v_finding_count <= 2 THEN 55
    ELSE 45
  END;

  -- Document quality: based on uploaded docs
  v_doc_quality := CASE
    WHEN v_accepted_docs >= 3 THEN 90
    WHEN v_doc_count >= 2 THEN 70
    WHEN v_doc_count >= 1 THEN 55
    ELSE 30
  END;

  -- Verification coverage: combination of both
  v_verify_coverage := LEAST(95, (v_meta_quality + v_doc_quality) / 2);

  -- Build warnings
  IF v_doc_count = 0 THEN
    v_warnings := v_warnings || '["No documents uploaded — confidence limited to metadata analysis"]'::jsonb;
  END IF;
  IF v_finding_count > 4 THEN
    v_warnings := v_warnings || '["Multiple registration gaps detected — audit confidence partially reduced"]'::jsonb;
  END IF;

  -- Overall level
  v_level := CASE
    WHEN v_verify_coverage >= 75 THEN 'HIGH'
    WHEN v_verify_coverage >= 50 THEN 'MEDIUM'
    ELSE 'LOW'
  END;

  v_explanation := 'Audit confidence is ' || v_level || '. ' ||
    'Based on ' || v_doc_count || ' document' || CASE WHEN v_doc_count != 1 THEN 's' ELSE '' END || ' uploaded and ' ||
    v_finding_count || ' finding' || CASE WHEN v_finding_count != 1 THEN 's' ELSE '' END || ' identified. ' ||
    CASE WHEN v_doc_count = 0 THEN 'Upload PRO statements, distributor reports, or split sheets to increase confidence accuracy.' ELSE 'Document review in progress.' END;

  DELETE FROM registrations.audit_confidence_v1
  WHERE artist_email = p_artist_email AND (p_audit_id IS NULL OR audit_id = p_audit_id);

  INSERT INTO registrations.audit_confidence_v1 (
    artist_email, artist_id, audit_id,
    audit_confidence_level, confidence_explanation,
    metadata_quality_score, document_quality_score, verification_coverage_score,
    warnings
  ) VALUES (
    p_artist_email, p_artist_id, p_audit_id,
    v_level, v_explanation,
    v_meta_quality, v_doc_quality, v_verify_coverage,
    v_warnings
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

-- Create recovery engagement (one-click authorization)
CREATE OR REPLACE FUNCTION registrations.fn_create_recovery_engagement_v1(
  p_artist_email      text,
  p_service_type      text,
  p_service_title     text,
  p_service_desc      text DEFAULT NULL,
  p_artist_id         uuid DEFAULT NULL,
  p_audit_id          uuid DEFAULT NULL,
  p_recovery_case_id  uuid DEFAULT NULL
)
RETURNS registrations.recovery_engagements_v1
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_est   registrations.recovery_estimates_v1;
  v_prob  registrations.recovery_probability_scores_v1;
  v_row   registrations.recovery_engagements_v1;
BEGIN
  SELECT * INTO v_est
  FROM registrations.recovery_estimates_v1
  WHERE artist_email = p_artist_email ORDER BY created_at DESC LIMIT 1;

  SELECT * INTO v_prob
  FROM registrations.recovery_probability_scores_v1
  WHERE artist_email = p_artist_email ORDER BY created_at DESC LIMIT 1;

  INSERT INTO registrations.recovery_engagements_v1 (
    artist_email, artist_id, audit_id, recovery_case_id,
    service_type, service_title, service_description,
    estimated_recovery_low, estimated_recovery_high,
    recovery_probability, status
  ) VALUES (
    p_artist_email, p_artist_id, p_audit_id, p_recovery_case_id,
    p_service_type, p_service_title, p_service_desc,
    COALESCE(v_est.estimate_low, 0),
    COALESCE(v_est.estimate_high, 0),
    COALESCE(v_prob.recovery_probability, 0),
    'PROPOSED'
  ) RETURNING * INTO v_row;

  -- Log timeline
  PERFORM registrations.fn_log_artist_activity_v1(
    p_artist_email     := p_artist_email,
    p_event_type       := 'ENGAGEMENT_PROPOSED',
    p_event_title      := 'Recovery service proposed: ' || p_service_title,
    p_event_body       := p_service_desc,
    p_artist_id        := p_artist_id,
    p_audit_id         := p_audit_id,
    p_recovery_case_id := p_recovery_case_id,
    p_visibility       := 'BOTH',
    p_created_by       := 'system'
  );

  -- Create admin queue task
  PERFORM registrations.fn_create_admin_queue_task_v1(
    p_queue_name       := 'RECOVERY_PENDING_QUEUE',
    p_artist_email     := p_artist_email,
    p_task_title       := 'New recovery engagement proposed: ' || p_service_title,
    p_task_body        := 'Engagement ref: ' || v_row.engagement_ref || '. Est. recovery: $' ||
                          to_char(v_row.estimated_recovery_low, 'FM999,999') || '–$' ||
                          to_char(v_row.estimated_recovery_high, 'FM999,999'),
    p_artist_id        := p_artist_id,
    p_audit_id         := p_audit_id,
    p_recovery_case_id := p_recovery_case_id,
    p_priority         := 'HIGH'
  );

  RETURN v_row;
END; $$;

-- Run full conversion pipeline for an artist
CREATE OR REPLACE FUNCTION registrations.fn_run_conversion_pipeline_v1(
  p_artist_email text,
  p_audit_id     uuid DEFAULT NULL,
  p_artist_id    uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_est      registrations.recovery_estimates_v1;
  v_prob     registrations.recovery_probability_scores_v1;
  v_conf     registrations.audit_confidence_v1;
  v_actions  integer;
BEGIN
  SELECT registrations.fn_generate_recovery_estimate_v1(p_artist_email, p_audit_id, p_artist_id) INTO v_est;
  SELECT registrations.fn_generate_recovery_probability_v1(p_artist_email, p_audit_id, p_artist_id) INTO v_prob;
  SELECT registrations.fn_build_audit_confidence_v1(p_artist_email, p_audit_id, p_artist_id) INTO v_conf;
  SELECT registrations.fn_generate_recommended_actions_v1(p_artist_email, p_audit_id, p_artist_id) INTO v_actions;

  RETURN jsonb_build_object(
    'estimate_low',          v_est.estimate_low,
    'estimate_high',         v_est.estimate_high,
    'estimate_confidence',   v_est.estimate_confidence,
    'recovery_probability',  v_prob.recovery_probability,
    'audit_confidence_level',v_conf.audit_confidence_level,
    'composite_confidence',  v_conf.composite_confidence,
    'recommended_actions',   v_actions
  );
END; $$;

-- ============================================================
-- GRANTS
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.recovery_estimates_v1          TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.recovery_probability_scores_v1 TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.recommended_actions_v1         TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.operational_status_v1          TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.audit_confidence_v1            TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.recovery_engagements_v1        TO service_role;
GRANT SELECT ON registrations.v_artist_trust_surface_v1                              TO service_role;
GRANT SELECT ON registrations.v_recovery_conversion_pipeline_v1                      TO service_role;

GRANT EXECUTE ON FUNCTION registrations.fn_generate_recovery_estimate_v1    TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_generate_recovery_probability_v1 TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_generate_recommended_actions_v1  TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_build_audit_confidence_v1        TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_create_recovery_engagement_v1    TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_run_conversion_pipeline_v1       TO service_role;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE registrations.recovery_estimates_v1          ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.recovery_probability_scores_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.recommended_actions_v1         ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.operational_status_v1          ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.audit_confidence_v1            ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.recovery_engagements_v1        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS srole_estimates   ON registrations.recovery_estimates_v1;
CREATE POLICY srole_estimates   ON registrations.recovery_estimates_v1          FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_prob        ON registrations.recovery_probability_scores_v1;
CREATE POLICY srole_prob        ON registrations.recovery_probability_scores_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_actions     ON registrations.recommended_actions_v1;
CREATE POLICY srole_actions     ON registrations.recommended_actions_v1         FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_opstatus    ON registrations.operational_status_v1;
CREATE POLICY srole_opstatus    ON registrations.operational_status_v1          FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_confidence  ON registrations.audit_confidence_v1;
CREATE POLICY srole_confidence  ON registrations.audit_confidence_v1            FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_engagements ON registrations.recovery_engagements_v1;
CREATE POLICY srole_engagements ON registrations.recovery_engagements_v1        FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- SEED: Run full conversion pipeline for test artist
-- ============================================================

DO $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT registrations.fn_run_conversion_pipeline_v1(
    'swordfishlp44@proton.me',
    NULL,
    '3d4788b6-2a86-4ed5-8f27-ab95b3a230d3'::uuid
  ) INTO v_result;

  RAISE NOTICE 'Conversion pipeline: %', v_result;

  -- Seed a proposed engagement
  PERFORM registrations.fn_create_recovery_engagement_v1(
    'swordfishlp44@proton.me',
    'PUBLISHING_ADMIN',
    'MusiGod Publishing Administration',
    'MusiGod will serve as your publishing administrator — registering all works, collecting all royalty streams, and recovering back royalties. You retain 100% ownership.',
    '3d4788b6-2a86-4ed5-8f27-ab95b3a230d3'::uuid,
    NULL,
    NULL
  );
END;
$$;
