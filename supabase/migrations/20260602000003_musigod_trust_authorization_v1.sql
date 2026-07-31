-- MusiGod Trust + Recovery Authorization Layer
-- Migration: 20260602_musigod_trust_authorization_v1.sql
-- Idempotent. Safe to re-run.

-- ============================================================
-- BUILD 1: FLAG EXPLANATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.flag_explanations_v1 (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_email      text NOT NULL,
  recovery_case_id  uuid REFERENCES registrations.recovery_cases_v1(id) ON DELETE SET NULL,
  finding_id        uuid REFERENCES registrations.audit_findings_v1(id) ON DELETE SET NULL,
  explanation_title text NOT NULL,
  explanation_body  text NOT NULL,
  evidence_source   text,
  confidence_level  text NOT NULL DEFAULT 'HIGH',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flag_exp_artist_email  ON registrations.flag_explanations_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_flag_exp_finding_id    ON registrations.flag_explanations_v1 (finding_id);
CREATE INDEX IF NOT EXISTS idx_flag_exp_created_at    ON registrations.flag_explanations_v1 (created_at DESC);

-- ============================================================
-- BUILD 2: RECOVERY TIMELINES
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.recovery_timelines_v1 (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_email        text NOT NULL,
  recovery_case_id    uuid REFERENCES registrations.recovery_cases_v1(id) ON DELETE SET NULL,
  finding_id          uuid REFERENCES registrations.audit_findings_v1(id) ON DELETE SET NULL,
  recovery_type       text NOT NULL,
  estimated_min_days  integer NOT NULL DEFAULT 30,
  estimated_max_days  integer NOT NULL DEFAULT 120,
  timeline_reason     text,
  dependency_status   text NOT NULL DEFAULT 'AWAITING_DOCUMENTS',
  operational_stage   text NOT NULL DEFAULT 'INTAKE',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_timelines_artist_email ON registrations.recovery_timelines_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_timelines_created_at   ON registrations.recovery_timelines_v1 (created_at DESC);

-- ============================================================
-- BUILD 3: RECOVERY CONFIDENCE
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.recovery_confidence_v1 (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_email                 text NOT NULL,
  recovery_case_id             uuid REFERENCES registrations.recovery_cases_v1(id) ON DELETE SET NULL,
  confidence_score             numeric(5,2) NOT NULL DEFAULT 0,
  confidence_level             text NOT NULL DEFAULT 'MEDIUM',
  confidence_reason            text,
  verification_status          text NOT NULL DEFAULT 'UNVERIFIED',
  supporting_documents_count   integer NOT NULL DEFAULT 0,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rec_conf_artist_email ON registrations.recovery_confidence_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_rec_conf_level        ON registrations.recovery_confidence_v1 (confidence_level);
CREATE INDEX IF NOT EXISTS idx_rec_conf_created_at   ON registrations.recovery_confidence_v1 (created_at DESC);

-- ============================================================
-- BUILD 4: REQUIRED DOCUMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.required_documents_v1 (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_email             text NOT NULL,
  recovery_case_id         uuid REFERENCES registrations.recovery_cases_v1(id) ON DELETE SET NULL,
  finding_id               uuid REFERENCES registrations.audit_findings_v1(id) ON DELETE SET NULL,
  document_type            text NOT NULL,
  requirement_reason       text NOT NULL,
  upload_status            text NOT NULL DEFAULT 'MISSING',
  required_for_processing  boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_req_docs_artist_email ON registrations.required_documents_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_req_docs_status       ON registrations.required_documents_v1 (upload_status);
CREATE INDEX IF NOT EXISTS idx_req_docs_created_at   ON registrations.required_documents_v1 (created_at DESC);

-- ============================================================
-- BUILD 5: RECOVERY AUTHORIZATIONS + AGREEMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.recovery_agreements_v1 (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_ref    text NOT NULL UNIQUE DEFAULT 'AGR-' || upper(substring(gen_random_uuid()::text, 1, 8)),
  agreement_version text NOT NULL DEFAULT 'v1.0',
  service_type     text NOT NULL,
  service_title    text NOT NULL,
  fee_rate         numeric(5,4) NOT NULL DEFAULT 0.1500,
  full_text        text NOT NULL,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registrations.recovery_authorizations_v1 (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_ref        text NOT NULL UNIQUE DEFAULT 'AUTH-' || upper(substring(gen_random_uuid()::text, 1, 8)),
  artist_email             text NOT NULL,
  artist_id                uuid,
  audit_id                 uuid,
  engagement_id            uuid REFERENCES registrations.recovery_engagements_v1(id) ON DELETE SET NULL,
  agreement_id             uuid REFERENCES registrations.recovery_agreements_v1(id) ON DELETE SET NULL,
  service_type             text NOT NULL,
  service_title            text NOT NULL,
  estimated_recovery_low   numeric(12,2) NOT NULL DEFAULT 0,
  estimated_recovery_high  numeric(12,2) NOT NULL DEFAULT 0,
  recovery_probability     numeric(5,2) NOT NULL DEFAULT 0,
  fee_rate                 numeric(5,4) NOT NULL DEFAULT 0.1500,
  status                   text NOT NULL DEFAULT 'AUTHORIZED',
  authorized_at            timestamptz NOT NULL DEFAULT now(),
  ip_address               text,
  user_agent               text,
  agreement_version        text NOT NULL DEFAULT 'v1.0',
  disclosure_acknowledged  boolean NOT NULL DEFAULT true,
  lifecycle_status         text NOT NULL DEFAULT 'AUTHORIZED',
  lifecycle_updated_at     timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_artist_email    ON registrations.recovery_authorizations_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_auth_engagement_id   ON registrations.recovery_authorizations_v1 (engagement_id);
CREATE INDEX IF NOT EXISTS idx_auth_lifecycle       ON registrations.recovery_authorizations_v1 (lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_auth_created_at      ON registrations.recovery_authorizations_v1 (created_at DESC);

-- ============================================================
-- VIEWS
-- ============================================================

CREATE OR REPLACE VIEW registrations.v_recovery_readiness_v1 AS
SELECT
  rd.artist_email,
  COUNT(*) FILTER (WHERE rd.upload_status = 'MISSING' AND rd.required_for_processing) AS missing_required_docs,
  COUNT(*) FILTER (WHERE rd.upload_status = 'UPLOADED') AS uploaded_docs,
  COUNT(*) AS total_required,
  ROUND(
    COUNT(*) FILTER (WHERE rd.upload_status = 'UPLOADED')::numeric /
    NULLIF(COUNT(*), 0) * 100, 1
  ) AS completion_pct,
  MAX(rd.updated_at) AS last_updated
FROM registrations.required_documents_v1 rd
GROUP BY rd.artist_email;

CREATE OR REPLACE VIEW registrations.v_authorization_audit_trail_v1 AS
SELECT
  a.authorization_ref,
  a.artist_email,
  a.service_type,
  a.service_title,
  a.estimated_recovery_low,
  a.estimated_recovery_high,
  a.recovery_probability,
  a.fee_rate,
  a.lifecycle_status,
  a.authorized_at,
  a.agreement_version,
  a.disclosure_acknowledged,
  a.ip_address,
  e.engagement_ref,
  e.status AS engagement_status
FROM registrations.recovery_authorizations_v1 a
LEFT JOIN registrations.recovery_engagements_v1 e ON e.id = a.engagement_id
ORDER BY a.authorized_at DESC;

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Generate flag explanations from findings
CREATE OR REPLACE FUNCTION registrations.fn_generate_flag_explanations_v1(
  p_artist_email text,
  p_audit_id     uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_finding RECORD;
  v_count   integer := 0;
  v_title   text;
  v_body    text;
  v_source  text;
BEGIN
  DELETE FROM registrations.flag_explanations_v1
  WHERE artist_email = p_artist_email;

  FOR v_finding IN
    SELECT * FROM registrations.audit_findings_v1
    WHERE artist_email = p_artist_email AND status != 'REJECTED'
      AND (p_audit_id IS NULL OR audit_id = p_audit_id)
  LOOP
    CASE v_finding.finding_type
      WHEN 'PRO_MISSING_REGISTRATION' THEN
        v_title  := 'No verified PRO registration detected';
        v_body   := 'MusiGod searched ASCAP, BMI, and SESAC public databases and could not confirm active registration for this artist. Without PRO registration, performance royalties from radio, streaming, and live venues cannot be collected. This is one of the most common sources of unclaimed royalties for independent artists.';
        v_source := 'PRO public registry cross-reference';
      WHEN 'MLC_NOT_REGISTERED' THEN
        v_title  := 'MLC (Mechanical Licensing Collective) registration not confirmed';
        v_body   := 'The MLC collects digital mechanical royalties on behalf of songwriters and publishers from streaming services including Spotify, Apple Music, and Amazon Music. MusiGod did not find a confirmed MLC registration for this artist. Unregistered works accumulate in an unclaimed royalty pool that grows each quarter.';
        v_source := 'MLC database cross-reference';
      WHEN 'NEIGHBORING_RIGHTS_MISSING' THEN
        v_title  := 'SoundExchange registration absent';
        v_body   := 'SoundExchange collects digital performance royalties for sound recording rights owners and featured artists from satellite radio (Sirius XM), internet radio (Pandora), and cable music services. MusiGod found no confirmed SoundExchange registration. These royalties are separate from PRO royalties and require independent registration.';
        v_source := 'SoundExchange registry analysis';
      WHEN 'FOREIGN_COLLECTION_GAP' THEN
        v_title  := 'International collection infrastructure not established';
        v_body   := 'Without sub-publishing relationships with international collection societies, foreign performance royalties (particularly from EU, UK, and Asia-Pacific markets) are not being collected. International royalties can represent 40–60% of total royalty income for artists with any international streaming presence.';
        v_source := 'International PRO and collection society gap analysis';
      WHEN 'PUBLISHING_ADMIN_CONFLICT' THEN
        v_title  := 'No active publishing administrator identified';
        v_body   := 'MusiGod detected no active publishing administration arrangement. Without a publishing administrator, sync licensing fees, print royalties, and international sub-publishing royalties go uncollected. Publishing administration does not require transferring ownership — MusiGod administers rights while the artist retains full ownership.';
        v_source := 'Publishing administration gap analysis';
      WHEN 'ISRC_MISMATCH' THEN
        v_title  := 'ISRC code inconsistency detected';
        v_body   := 'International Standard Recording Codes (ISRCs) are used by all collection societies and DSPs to identify recordings. MusiGod detected inconsistencies in ISRC data across distribution systems. Mismatched or missing ISRCs cause royalty payments to be unmatched and held in suspense accounts.';
        v_source := 'Metadata cross-reference analysis';
      WHEN 'DUPLICATE_SPLIT' THEN
        v_title  := 'Split sheet conflict detected';
        v_body   := 'MusiGod detected potential conflicts in writer share allocations. Ownership percentage conflicts can delay or prevent royalty distribution and may result in disputed payments being held by collection societies.';
        v_source := 'Split sheet and ownership analysis';
      ELSE
        v_title  := 'Royalty gap detected: ' || replace(v_finding.finding_type, '_', ' ');
        v_body   := COALESCE(v_finding.finding_body, 'MusiGod identified a potential royalty collection gap requiring review.');
        v_source := 'Automated rights analysis';
    END CASE;

    INSERT INTO registrations.flag_explanations_v1 (
      artist_email, finding_id,
      explanation_title, explanation_body,
      evidence_source, confidence_level
    ) VALUES (
      p_artist_email, v_finding.id,
      v_title, v_body, v_source,
      CASE v_finding.severity WHEN 'CRITICAL' THEN 'HIGH' WHEN 'HIGH' THEN 'HIGH' ELSE 'MEDIUM' END
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END; $$;

-- Generate recovery timelines
CREATE OR REPLACE FUNCTION registrations.fn_generate_recovery_timelines_v1(
  p_artist_email text,
  p_audit_id     uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_finding RECORD;
  v_count   integer := 0;
  v_min     integer;
  v_max     integer;
  v_reason  text;
  v_dep     text;
BEGIN
  DELETE FROM registrations.recovery_timelines_v1
  WHERE artist_email = p_artist_email;

  FOR v_finding IN
    SELECT * FROM registrations.audit_findings_v1
    WHERE artist_email = p_artist_email AND status != 'REJECTED'
      AND (p_audit_id IS NULL OR audit_id = p_audit_id)
  LOOP
    CASE v_finding.finding_type
      WHEN 'PRO_MISSING_REGISTRATION' THEN
        v_min := 30; v_max := 90;
        v_reason := 'PRO registration processing typically takes 30–90 days. Retroactive royalty claims may require additional time for society verification.';
        v_dep := 'Requires PRO statement upload and registration confirmation.';
      WHEN 'MLC_NOT_REGISTERED' THEN
        v_min := 45; v_max := 120;
        v_reason := 'MLC registration and retroactive claim processing typically takes 45–120 days. Unclaimed royalty pools are distributed quarterly.';
        v_dep := 'Requires distribution statement and work registration data.';
      WHEN 'NEIGHBORING_RIGHTS_MISSING' THEN
        v_min := 60; v_max := 180;
        v_reason := 'SoundExchange registration takes 30–60 days. Retroactive claims for prior periods can take an additional 3–6 months to process.';
        v_dep := 'Requires label or artist registration and sound recording data.';
      WHEN 'FOREIGN_COLLECTION_GAP' THEN
        v_min := 90; v_max := 365;
        v_reason := 'International collection society registrations and retroactive claims vary significantly by territory. EU societies typically respond within 90–180 days; some markets may take up to 12 months.';
        v_dep := 'Requires sub-publishing agreement execution and territory-specific registration.';
      WHEN 'PUBLISHING_ADMIN_CONFLICT' THEN
        v_min := 30; v_max := 90;
        v_reason := 'Publishing administration setup typically takes 30–60 days. Retroactive royalty identification and claim filing may extend the timeline to 90 days.';
        v_dep := 'Requires publishing administration agreement execution.';
      ELSE
        v_min := 30; v_max := 120;
        v_reason := 'Recovery timeline depends on society response times and document availability.';
        v_dep := 'Requires supporting documentation upload.';
    END CASE;

    INSERT INTO registrations.recovery_timelines_v1 (
      artist_email, finding_id, recovery_type,
      estimated_min_days, estimated_max_days,
      timeline_reason, dependency_status, operational_stage
    ) VALUES (
      p_artist_email, v_finding.id, v_finding.finding_type,
      v_min, v_max, v_reason, v_dep, 'INTAKE'
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END; $$;

-- Generate required documents from findings
CREATE OR REPLACE FUNCTION registrations.fn_generate_required_documents_v1(
  p_artist_email text,
  p_audit_id     uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_finding RECORD;
  v_count   integer := 0;
BEGIN
  DELETE FROM registrations.required_documents_v1
  WHERE artist_email = p_artist_email;

  FOR v_finding IN
    SELECT DISTINCT finding_type, id FROM registrations.audit_findings_v1
    WHERE artist_email = p_artist_email AND status != 'REJECTED'
      AND (p_audit_id IS NULL OR audit_id = p_audit_id)
  LOOP
    CASE v_finding.finding_type
      WHEN 'PRO_MISSING_REGISTRATION' THEN
        INSERT INTO registrations.required_documents_v1
          (artist_email, finding_id, document_type, requirement_reason, required_for_processing)
        VALUES
          (p_artist_email, v_finding.id, 'PRO_STATEMENT',
           'Required to verify current PRO registration status and identify unclaimed works.', true),
          (p_artist_email, v_finding.id, 'ISRC_UPC_METADATA',
           'ISRC/UPC data enables cross-referencing with PRO databases to identify unregistered works.', false);
        v_count := v_count + 2;

      WHEN 'MLC_NOT_REGISTERED' THEN
        INSERT INTO registrations.required_documents_v1
          (artist_email, finding_id, document_type, requirement_reason, required_for_processing)
        VALUES
          (p_artist_email, v_finding.id, 'DISTRIBUTOR_STATEMENT',
           'Distribution statements confirm streaming activity and support MLC retroactive claims.', true),
          (p_artist_email, v_finding.id, 'SPLIT_SHEET',
           'Writer share documentation is required for MLC registration of each composition.', true);
        v_count := v_count + 2;

      WHEN 'NEIGHBORING_RIGHTS_MISSING' THEN
        INSERT INTO registrations.required_documents_v1
          (artist_email, finding_id, document_type, requirement_reason, required_for_processing)
        VALUES
          (p_artist_email, v_finding.id, 'DISTRIBUTOR_STATEMENT',
           'Required to identify all sound recordings eligible for SoundExchange registration.', true);
        v_count := v_count + 1;

      WHEN 'PUBLISHING_ADMIN_CONFLICT' THEN
        INSERT INTO registrations.required_documents_v1
          (artist_email, finding_id, document_type, requirement_reason, required_for_processing)
        VALUES
          (p_artist_email, v_finding.id, 'PUBLISHING_AGREEMENT',
           'Any existing publishing agreements must be reviewed before administration setup.', true),
          (p_artist_email, v_finding.id, 'SPLIT_SHEET',
           'Writer/publisher splits required to establish correct publishing admin structure.', true),
          (p_artist_email, v_finding.id, 'ISRC_UPC_METADATA',
           'Full catalog metadata required for publishing administration registration.', false);
        v_count := v_count + 3;

      WHEN 'FOREIGN_COLLECTION_GAP' THEN
        INSERT INTO registrations.required_documents_v1
          (artist_email, finding_id, document_type, requirement_reason, required_for_processing)
        VALUES
          (p_artist_email, v_finding.id, 'PRO_STATEMENT',
           'PRO statements help identify which international territories have active collection.', false),
          (p_artist_email, v_finding.id, 'DISTRIBUTOR_STATEMENT',
           'International distribution statements confirm territory-level streaming activity.', true);
        v_count := v_count + 2;

      ELSE
        INSERT INTO registrations.required_documents_v1
          (artist_email, finding_id, document_type, requirement_reason, required_for_processing)
        VALUES
          (p_artist_email, v_finding.id, 'OTHER',
           'Supporting documentation required to process this recovery opportunity.', false);
        v_count := v_count + 1;
    END CASE;

    -- Mark as UPLOADED if matching document already exists
    UPDATE registrations.required_documents_v1 rd
    SET upload_status = 'UPLOADED', updated_at = now()
    WHERE rd.artist_email = p_artist_email
      AND rd.finding_id = v_finding.id
      AND EXISTS (
        SELECT 1 FROM registrations.artist_documents_v1 ad
        WHERE ad.artist_email = p_artist_email
          AND ad.document_type = rd.document_type
          AND ad.status IN ('UPLOADED','ACCEPTED')
      );
  END LOOP;

  RETURN v_count;
END; $$;

-- Create recovery authorization with full audit trail
CREATE OR REPLACE FUNCTION registrations.fn_create_recovery_authorization_v1(
  p_artist_email    text,
  p_service_type    text,
  p_service_title   text,
  p_engagement_id   uuid DEFAULT NULL,
  p_artist_id       uuid DEFAULT NULL,
  p_audit_id        uuid DEFAULT NULL,
  p_ip_address      text DEFAULT NULL,
  p_user_agent      text DEFAULT NULL
)
RETURNS registrations.recovery_authorizations_v1
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_est       registrations.recovery_estimates_v1;
  v_prob      registrations.recovery_probability_scores_v1;
  v_agr       registrations.recovery_agreements_v1;
  v_row       registrations.recovery_authorizations_v1;
BEGIN
  SELECT * INTO v_est  FROM registrations.recovery_estimates_v1
    WHERE artist_email = p_artist_email ORDER BY created_at DESC LIMIT 1;
  SELECT * INTO v_prob FROM registrations.recovery_probability_scores_v1
    WHERE artist_email = p_artist_email ORDER BY created_at DESC LIMIT 1;
  SELECT * INTO v_agr  FROM registrations.recovery_agreements_v1
    WHERE service_type = p_service_type AND is_active = true ORDER BY created_at DESC LIMIT 1;

  INSERT INTO registrations.recovery_authorizations_v1 (
    artist_email, artist_id, audit_id, engagement_id, agreement_id,
    service_type, service_title,
    estimated_recovery_low, estimated_recovery_high,
    recovery_probability, fee_rate,
    ip_address, user_agent,
    agreement_version, disclosure_acknowledged,
    lifecycle_status
  ) VALUES (
    p_artist_email, p_artist_id, p_audit_id, p_engagement_id, v_agr.id,
    p_service_type, p_service_title,
    COALESCE(v_est.estimate_low, 0), COALESCE(v_est.estimate_high, 0),
    COALESCE(v_prob.recovery_probability, 0), 0.1500,
    p_ip_address, p_user_agent,
    COALESCE(v_agr.agreement_version, 'v1.0'), true,
    'AUTHORIZED'
  ) RETURNING * INTO v_row;

  -- Log timeline
  PERFORM registrations.fn_log_artist_activity_v1(
    p_artist_email     := p_artist_email,
    p_event_type       := 'RECOVERY_AUTHORIZED',
    p_event_title      := 'Recovery service authorized: ' || p_service_title,
    p_event_body       := 'Authorization ref: ' || v_row.authorization_ref ||
                          '. Est. recovery: $' || to_char(v_row.estimated_recovery_low, 'FM999,999') ||
                          '–$' || to_char(v_row.estimated_recovery_high, 'FM999,999') ||
                          '. Fee: 15% of successful recovery only.',
    p_artist_id        := p_artist_id,
    p_audit_id         := p_audit_id,
    p_visibility       := 'BOTH',
    p_created_by       := 'artist'
  );

  RETURN v_row;
END; $$;

-- Update authorization lifecycle
CREATE OR REPLACE FUNCTION registrations.fn_update_authorization_lifecycle_v1(
  p_authorization_ref text,
  p_lifecycle_status  text,
  p_updated_by        text DEFAULT 'system'
)
RETURNS registrations.recovery_authorizations_v1
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_row registrations.recovery_authorizations_v1;
BEGIN
  UPDATE registrations.recovery_authorizations_v1
  SET lifecycle_status     = p_lifecycle_status,
      lifecycle_updated_at = now(),
      updated_at           = now()
  WHERE authorization_ref = p_authorization_ref
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Authorization not found: %', p_authorization_ref;
  END IF;

  PERFORM registrations.fn_log_artist_activity_v1(
    p_artist_email := v_row.artist_email,
    p_event_type   := 'AUTHORIZATION_LIFECYCLE_UPDATED',
    p_event_title  := 'Recovery status updated: ' || p_lifecycle_status,
    p_event_body   := 'Authorization ' || p_authorization_ref || ' moved to ' || p_lifecycle_status,
    p_artist_id    := v_row.artist_id,
    p_visibility   := 'BOTH',
    p_created_by   := p_updated_by
  );

  RETURN v_row;
END; $$;

-- ============================================================
-- SEED: Standard agreement templates
-- ============================================================

INSERT INTO registrations.recovery_agreements_v1
  (service_type, service_title, fee_rate, full_text)
VALUES
  ('PUBLISHING_ADMIN',
   'MusiGod Publishing Administration Agreement',
   0.1500,
   'MusiGod Publishing Administration Agreement v1.0

This agreement authorizes MusiGod to act as Publishing Administrator for the artist''s catalog.

TERMS:
1. The artist retains 100% ownership of all copyrights and master recordings.
2. MusiGod will register works with PROs, the MLC, and international collection societies.
3. MusiGod''s fee is 15% of royalties successfully recovered through MusiGod administration.
4. Recovery estimates are probabilistic and not guaranteed.
5. This agreement may be terminated by either party with 30 days written notice.
6. MusiGod earns only from successful recovery — no upfront fees.

By authorizing this service, the artist acknowledges: Artists retain 100% ownership. MusiGod earns only from successful recovery. Standard recovery fee: 15%. Recovery estimates are probabilistic and not guaranteed.'
  ),
  ('MLC_REGISTRATION',
   'MusiGod MLC Registration & Claims Service',
   0.1500,
   'MusiGod MLC Registration & Claims Service Agreement v1.0

TERMS:
1. MusiGod will register artist works with the Mechanical Licensing Collective.
2. MusiGod will file retroactive mechanical royalty claims on the artist''s behalf.
3. MusiGod''s fee is 15% of royalties recovered through this service.
4. Artist retains full ownership of all compositions.
5. Recovery estimates are probabilistic and not guaranteed.'
  ),
  ('NEIGHBORING_RIGHTS',
   'MusiGod Neighboring Rights Registration Service',
   0.1500,
   'MusiGod Neighboring Rights Registration Service Agreement v1.0

TERMS:
1. MusiGod will register sound recordings with SoundExchange and applicable international neighboring rights societies.
2. MusiGod will file retroactive claims for prior periods.
3. MusiGod''s fee is 15% of royalties recovered through this service.
4. Artist/label retains full ownership of sound recordings.
5. Recovery estimates are probabilistic and not guaranteed.'
  ),
  ('PRO_VERIFICATION',
   'MusiGod PRO Verification & Correction Service',
   0.1500,
   'MusiGod PRO Registration Verification & Correction Service Agreement v1.0

TERMS:
1. MusiGod will audit and verify PRO registrations across ASCAP, BMI, and SESAC.
2. MusiGod will file corrections and retroactive claims where applicable.
3. MusiGod''s fee is 15% of royalties recovered through this service.
4. Artist retains full ownership and PRO membership.
5. Recovery estimates are probabilistic and not guaranteed.'
  ),
  ('FOREIGN_COLLECTION',
   'MusiGod International Collection Service',
   0.1500,
   'MusiGod International Collection Service Agreement v1.0

TERMS:
1. MusiGod will establish sub-publishing relationships with international collection societies.
2. MusiGod will file claims with international PROs and mechanical societies.
3. MusiGod''s fee is 15% of royalties recovered through this service.
4. Artist retains full ownership of all works in all territories.
5. Recovery estimates are probabilistic and not guaranteed. International timelines vary by territory.'
  )
ON CONFLICT DO NOTHING;

-- ============================================================
-- GRANTS + RLS
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.flag_explanations_v1       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.recovery_timelines_v1      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.recovery_confidence_v1     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.required_documents_v1      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.recovery_agreements_v1     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.recovery_authorizations_v1 TO service_role;
GRANT SELECT ON registrations.v_recovery_readiness_v1         TO service_role;
GRANT SELECT ON registrations.v_authorization_audit_trail_v1  TO service_role;

GRANT EXECUTE ON FUNCTION registrations.fn_generate_flag_explanations_v1    TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_generate_recovery_timelines_v1   TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_generate_required_documents_v1   TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_create_recovery_authorization_v1 TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_update_authorization_lifecycle_v1 TO service_role;

ALTER TABLE registrations.flag_explanations_v1       ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.recovery_timelines_v1      ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.recovery_confidence_v1     ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.required_documents_v1      ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.recovery_agreements_v1     ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.recovery_authorizations_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS srole_flag_exp   ON registrations.flag_explanations_v1;
CREATE POLICY srole_flag_exp   ON registrations.flag_explanations_v1       FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_timelines  ON registrations.recovery_timelines_v1;
CREATE POLICY srole_timelines  ON registrations.recovery_timelines_v1      FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_rec_conf   ON registrations.recovery_confidence_v1;
CREATE POLICY srole_rec_conf   ON registrations.recovery_confidence_v1     FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_req_docs   ON registrations.required_documents_v1;
CREATE POLICY srole_req_docs   ON registrations.required_documents_v1      FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_agreements ON registrations.recovery_agreements_v1;
CREATE POLICY srole_agreements ON registrations.recovery_agreements_v1     FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_auth       ON registrations.recovery_authorizations_v1;
CREATE POLICY srole_auth       ON registrations.recovery_authorizations_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- SEED: Run trust pipeline for test artist
-- ============================================================

DO $$
DECLARE v_count integer;
BEGIN
  SELECT registrations.fn_generate_flag_explanations_v1('swordfishlp44@proton.me', NULL) INTO v_count;
  RAISE NOTICE 'Flag explanations: %', v_count;

  SELECT registrations.fn_generate_recovery_timelines_v1('swordfishlp44@proton.me', NULL) INTO v_count;
  RAISE NOTICE 'Recovery timelines: %', v_count;

  SELECT registrations.fn_generate_required_documents_v1('swordfishlp44@proton.me', NULL) INTO v_count;
  RAISE NOTICE 'Required documents: %', v_count;
END;
$$;
