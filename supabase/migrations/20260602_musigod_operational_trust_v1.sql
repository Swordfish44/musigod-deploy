-- MusiGod Operational Trust + E-Sign Infrastructure Layer
-- Migration: 20260602_musigod_operational_trust_v1.sql
-- Idempotent. Safe to re-run.

-- ============================================================
-- BUILD 1: OPERATIONAL STAGES
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.operational_stages_v1 (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_engagement_id uuid REFERENCES registrations.recovery_engagements_v1(id) ON DELETE SET NULL,
  recovery_case_id      uuid REFERENCES registrations.recovery_cases_v1(id) ON DELETE SET NULL,
  artist_email          text NOT NULL,
  current_stage         text NOT NULL DEFAULT 'INTAKE_RECEIVED',
  stage_label           text NOT NULL DEFAULT 'Intake Received',
  stage_description     text,
  stage_status          text NOT NULL DEFAULT 'ACTIVE',
  blocking_dependency   text,
  assigned_team         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opstage_artist_email    ON registrations.operational_stages_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_opstage_engagement_id  ON registrations.operational_stages_v1 (recovery_engagement_id);
CREATE INDEX IF NOT EXISTS idx_opstage_current_stage  ON registrations.operational_stages_v1 (current_stage);
CREATE INDEX IF NOT EXISTS idx_opstage_created_at     ON registrations.operational_stages_v1 (created_at DESC);

-- ============================================================
-- BUILD 2: OPERATIONAL UPDATES (ACTIVITY FRESHNESS)
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.operational_updates_v1 (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_case_id      uuid REFERENCES registrations.recovery_cases_v1(id) ON DELETE SET NULL,
  recovery_engagement_id uuid REFERENCES registrations.recovery_engagements_v1(id) ON DELETE SET NULL,
  artist_email          text NOT NULL,
  update_type           text NOT NULL,
  update_summary        text NOT NULL,
  updated_by            text NOT NULL DEFAULT 'system',
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opupdate_artist_email   ON registrations.operational_updates_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_opupdate_engagement_id  ON registrations.operational_updates_v1 (recovery_engagement_id);
CREATE INDEX IF NOT EXISTS idx_opupdate_created_at     ON registrations.operational_updates_v1 (created_at DESC);

-- ============================================================
-- BUILD 3: RECOVERY TEAMS + ASSIGNMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.recovery_teams_v1 (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_name    text NOT NULL UNIQUE,
  team_label   text NOT NULL,
  team_type    text NOT NULL,
  description  text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registrations.recovery_assignments_v1 (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_case_id      uuid REFERENCES registrations.recovery_cases_v1(id) ON DELETE SET NULL,
  recovery_engagement_id uuid REFERENCES registrations.recovery_engagements_v1(id) ON DELETE SET NULL,
  artist_email          text NOT NULL,
  assigned_team         text NOT NULL,
  assigned_operator     text,
  assignment_status     text NOT NULL DEFAULT 'ACTIVE',
  assigned_at           timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assignment_artist_email   ON registrations.recovery_assignments_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_assignment_engagement_id  ON registrations.recovery_assignments_v1 (recovery_engagement_id);
CREATE INDEX IF NOT EXISTS idx_assignment_team           ON registrations.recovery_assignments_v1 (assigned_team);
CREATE INDEX IF NOT EXISTS idx_assignment_created_at     ON registrations.recovery_assignments_v1 (assigned_at DESC);

-- ============================================================
-- BUILD 4: RECOVERY READINESS
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.recovery_readiness_v1 (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_email             text NOT NULL,
  recovery_case_id         uuid REFERENCES registrations.recovery_cases_v1(id) ON DELETE SET NULL,
  readiness_score          integer NOT NULL DEFAULT 0 CHECK (readiness_score BETWEEN 0 AND 100),
  readiness_level          text NOT NULL DEFAULT 'NOT_READY',
  missing_requirements     jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_requirements   jsonb NOT NULL DEFAULT '[]'::jsonb,
  readiness_reasoning      text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_readiness_artist_email ON registrations.recovery_readiness_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_readiness_score        ON registrations.recovery_readiness_v1 (readiness_score DESC);
CREATE INDEX IF NOT EXISTS idx_readiness_created_at   ON registrations.recovery_readiness_v1 (created_at DESC);

-- ============================================================
-- BUILD 5: E-SIGN INFRASTRUCTURE
-- ============================================================

CREATE TABLE IF NOT EXISTS registrations.agreement_versions_v1 (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type     text NOT NULL,
  version          text NOT NULL DEFAULT 'v1.0',
  title            text NOT NULL,
  body_text        text NOT NULL,
  is_current       boolean NOT NULL DEFAULT true,
  effective_date   date NOT NULL DEFAULT CURRENT_DATE,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_ver_service_ver
  ON registrations.agreement_versions_v1 (service_type, version);

CREATE TABLE IF NOT EXISTS registrations.signed_agreements_v1 (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_ref       text NOT NULL UNIQUE DEFAULT 'SA-' || upper(substring(gen_random_uuid()::text, 1, 10)),
  artist_email        text NOT NULL,
  artist_id           uuid,
  engagement_id       uuid REFERENCES registrations.recovery_engagements_v1(id) ON DELETE SET NULL,
  agreement_version_id uuid REFERENCES registrations.agreement_versions_v1(id) ON DELETE SET NULL,
  service_type        text NOT NULL,
  version             text NOT NULL DEFAULT 'v1.0',
  full_agreement_text text NOT NULL,
  status              text NOT NULL DEFAULT 'SIGNED',
  ip_address          text,
  user_agent          text,
  signed_at           timestamptz NOT NULL DEFAULT now(),
  countersigned_at    timestamptz,
  countersigned_by    text,
  storage_path        text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signed_artist_email  ON registrations.signed_agreements_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_signed_engagement_id ON registrations.signed_agreements_v1 (engagement_id);
CREATE INDEX IF NOT EXISTS idx_signed_service_type  ON registrations.signed_agreements_v1 (service_type);
CREATE INDEX IF NOT EXISTS idx_signed_created_at    ON registrations.signed_agreements_v1 (created_at DESC);

CREATE TABLE IF NOT EXISTS registrations.signature_events_v1 (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id    uuid REFERENCES registrations.signed_agreements_v1(id) ON DELETE CASCADE,
  artist_email    text NOT NULL,
  event_type      text NOT NULL,
  event_detail    text,
  ip_address      text,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sig_events_agreement_id ON registrations.signature_events_v1 (agreement_id);
CREATE INDEX IF NOT EXISTS idx_sig_events_artist_email ON registrations.signature_events_v1 (artist_email);
CREATE INDEX IF NOT EXISTS idx_sig_events_created_at   ON registrations.signature_events_v1 (created_at DESC);

-- ============================================================
-- VIEWS
-- ============================================================

CREATE OR REPLACE VIEW registrations.v_operational_status_summary_v1 AS
SELECT
  e.artist_email,
  e.engagement_ref,
  e.service_type,
  e.service_title,
  e.status AS engagement_status,
  os.current_stage,
  os.stage_label,
  os.stage_description,
  os.blocking_dependency,
  os.assigned_team,
  ra.assigned_operator,
  rr.readiness_score,
  rr.readiness_level,
  rr.missing_requirements,
  ou.update_summary AS last_update_summary,
  ou.created_at AS last_updated_at,
  e.created_at AS engagement_created_at
FROM registrations.recovery_engagements_v1 e
LEFT JOIN LATERAL (
  SELECT * FROM registrations.operational_stages_v1
  WHERE recovery_engagement_id = e.id ORDER BY created_at DESC LIMIT 1
) os ON true
LEFT JOIN LATERAL (
  SELECT * FROM registrations.recovery_assignments_v1
  WHERE recovery_engagement_id = e.id AND assignment_status = 'ACTIVE' ORDER BY assigned_at DESC LIMIT 1
) ra ON true
LEFT JOIN LATERAL (
  SELECT * FROM registrations.recovery_readiness_v1
  WHERE artist_email = e.artist_email ORDER BY created_at DESC LIMIT 1
) rr ON true
LEFT JOIN LATERAL (
  SELECT * FROM registrations.operational_updates_v1
  WHERE recovery_engagement_id = e.id ORDER BY created_at DESC LIMIT 1
) ou ON true;

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Advance operational stage
CREATE OR REPLACE FUNCTION registrations.fn_advance_operational_stage_v1(
  p_engagement_id   uuid,
  p_new_stage       text,
  p_stage_label     text,
  p_stage_desc      text DEFAULT NULL,
  p_blocking_dep    text DEFAULT NULL,
  p_assigned_team   text DEFAULT NULL,
  p_updated_by      text DEFAULT 'system'
)
RETURNS registrations.operational_stages_v1
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_engagement registrations.recovery_engagements_v1;
  v_row        registrations.operational_stages_v1;
BEGIN
  SELECT * INTO v_engagement FROM registrations.recovery_engagements_v1 WHERE id = p_engagement_id;
  IF v_engagement.id IS NULL THEN RAISE EXCEPTION 'Engagement not found: %', p_engagement_id; END IF;

  -- Close previous stage
  UPDATE registrations.operational_stages_v1
  SET stage_status = 'COMPLETED', updated_at = now()
  WHERE recovery_engagement_id = p_engagement_id AND stage_status = 'ACTIVE';

  -- Insert new stage
  INSERT INTO registrations.operational_stages_v1 (
    recovery_engagement_id, artist_email, current_stage, stage_label,
    stage_description, stage_status, blocking_dependency, assigned_team
  ) VALUES (
    p_engagement_id, v_engagement.artist_email, p_new_stage, p_stage_label,
    p_stage_desc, 'ACTIVE', p_blocking_dep, p_assigned_team
  ) RETURNING * INTO v_row;

  -- Log operational update
  INSERT INTO registrations.operational_updates_v1 (
    recovery_engagement_id, artist_email, update_type, update_summary, updated_by
  ) VALUES (
    p_engagement_id, v_engagement.artist_email, 'STAGE_ADVANCE',
    'Recovery stage advanced to: ' || p_stage_label ||
      CASE WHEN p_blocking_dep IS NOT NULL THEN ' — Awaiting: ' || p_blocking_dep ELSE '' END,
    p_updated_by
  );

  -- Log timeline
  PERFORM registrations.fn_log_artist_activity_v1(
    p_artist_email := v_engagement.artist_email,
    p_event_type   := 'OPERATIONAL_STAGE_ADVANCED',
    p_event_title  := p_stage_label,
    p_event_body   := COALESCE(p_stage_desc, p_blocking_dep),
    p_visibility   := 'BOTH',
    p_created_by   := p_updated_by
  );

  RETURN v_row;
END; $$;

-- Auto-assign recovery team based on service type
CREATE OR REPLACE FUNCTION registrations.fn_assign_recovery_team_v1(
  p_engagement_id uuid,
  p_service_type  text DEFAULT NULL
)
RETURNS registrations.recovery_assignments_v1
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_engagement registrations.recovery_engagements_v1;
  v_team       text;
  v_team_label text;
  v_row        registrations.recovery_assignments_v1;
BEGIN
  SELECT * INTO v_engagement FROM registrations.recovery_engagements_v1 WHERE id = p_engagement_id;
  IF v_engagement.id IS NULL THEN RAISE EXCEPTION 'Engagement not found: %', p_engagement_id; END IF;

  v_team := CASE COALESCE(p_service_type, v_engagement.service_type)
    WHEN 'PUBLISHING_ADMIN'    THEN 'publishing_admin_ops'
    WHEN 'MLC_REGISTRATION'    THEN 'mechanical_rights_ops'
    WHEN 'NEIGHBORING_RIGHTS'  THEN 'neighboring_rights_ops'
    WHEN 'FOREIGN_COLLECTION'  THEN 'international_collection_ops'
    WHEN 'PRO_VERIFICATION'    THEN 'rights_verification_ops'
    ELSE 'recovery_operations'
  END;

  -- Deactivate existing assignment
  UPDATE registrations.recovery_assignments_v1
  SET assignment_status = 'REASSIGNED', updated_at = now()
  WHERE recovery_engagement_id = p_engagement_id AND assignment_status = 'ACTIVE';

  INSERT INTO registrations.recovery_assignments_v1 (
    recovery_engagement_id, artist_email, assigned_team, assignment_status
  ) VALUES (
    p_engagement_id, v_engagement.artist_email, v_team, 'ACTIVE'
  ) RETURNING * INTO v_row;

  -- Log update
  INSERT INTO registrations.operational_updates_v1 (
    recovery_engagement_id, artist_email, update_type, update_summary, updated_by
  ) VALUES (
    p_engagement_id, v_engagement.artist_email, 'TEAM_ASSIGNED',
    'Assigned to: ' || v_team, 'system'
  );

  RETURN v_row;
END; $$;

-- Calculate recovery readiness score
CREATE OR REPLACE FUNCTION registrations.fn_calculate_recovery_readiness_v1(
  p_artist_email text,
  p_case_id      uuid DEFAULT NULL
)
RETURNS registrations.recovery_readiness_v1
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_score       integer := 0;
  v_level       text;
  v_reasoning   text;
  v_missing     jsonb := '[]'::jsonb;
  v_completed   jsonb := '[]'::jsonb;
  v_doc_count   integer := 0;
  v_auth_count  integer := 0;
  v_finding_count integer := 0;
  v_row         registrations.recovery_readiness_v1;
BEGIN
  SELECT COUNT(*) INTO v_doc_count FROM registrations.artist_documents_v1
  WHERE artist_email = p_artist_email AND status IN ('UPLOADED','ACCEPTED');

  SELECT COUNT(*) INTO v_auth_count FROM registrations.recovery_authorizations_v1
  WHERE artist_email = p_artist_email AND lifecycle_status = 'AUTHORIZED';

  SELECT COUNT(*) INTO v_finding_count FROM registrations.audit_findings_v1
  WHERE artist_email = p_artist_email AND status = 'APPROVED';

  -- Scoring
  IF v_auth_count > 0    THEN v_score := v_score + 30; v_completed := v_completed || '["Recovery service authorized"]'::jsonb; ELSE v_missing := v_missing || '["Authorize at least one recovery service"]'::jsonb; END IF;
  IF v_doc_count >= 3    THEN v_score := v_score + 35; v_completed := v_completed || '["Supporting documents uploaded"]'::jsonb;
  ELSIF v_doc_count >= 1 THEN v_score := v_score + 15; v_missing := v_missing || '["Upload additional supporting documents (statements, splits)"]'::jsonb;
  ELSE v_missing := v_missing || '["Upload PRO statement, distributor statement, or split sheets"]'::jsonb; END IF;
  IF v_finding_count > 0 THEN v_score := v_score + 20; v_completed := v_completed || '["Audit findings reviewed"]'::jsonb; ELSE v_missing := v_missing || '["Complete audit finding review with MusiGod team"]'::jsonb; END IF;

  -- Check required docs
  IF EXISTS (SELECT 1 FROM registrations.required_documents_v1 WHERE artist_email = p_artist_email AND upload_status = 'MISSING' AND required_for_processing = true) THEN
    v_missing := v_missing || '["Required documents still missing — upload to proceed"]'::jsonb;
  ELSE
    v_score := v_score + 15;
    v_completed := v_completed || '["All required documents submitted"]'::jsonb;
  END IF;

  v_score := LEAST(100, v_score);
  v_level := CASE WHEN v_score >= 80 THEN 'READY' WHEN v_score >= 50 THEN 'PARTIAL' WHEN v_score >= 25 THEN 'INITIATED' ELSE 'NOT_READY' END;

  v_reasoning := 'Readiness ' || v_score || '/100 (' || v_level || '). ' ||
    v_auth_count || ' service' || CASE WHEN v_auth_count != 1 THEN 's' ELSE '' END || ' authorized. ' ||
    v_doc_count || ' document' || CASE WHEN v_doc_count != 1 THEN 's' ELSE '' END || ' uploaded. ' ||
    CASE WHEN v_level = 'READY' THEN 'MusiGod can begin operational work immediately.'
         WHEN v_level = 'PARTIAL' THEN 'Upload remaining documents to accelerate recovery.'
         ELSE 'Complete authorization and document upload to initiate recovery.' END;

  DELETE FROM registrations.recovery_readiness_v1
  WHERE artist_email = p_artist_email AND (p_case_id IS NULL OR recovery_case_id = p_case_id);

  INSERT INTO registrations.recovery_readiness_v1 (
    artist_email, recovery_case_id, readiness_score, readiness_level,
    missing_requirements, completed_requirements, readiness_reasoning
  ) VALUES (
    p_artist_email, p_case_id, v_score, v_level,
    v_missing, v_completed, v_reasoning
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

-- Create signed agreement record
CREATE OR REPLACE FUNCTION registrations.fn_sign_agreement_v1(
  p_artist_email  text,
  p_service_type  text,
  p_engagement_id uuid DEFAULT NULL,
  p_artist_id     uuid DEFAULT NULL,
  p_ip_address    text DEFAULT NULL,
  p_user_agent    text DEFAULT NULL
)
RETURNS registrations.signed_agreements_v1
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_agr_ver  registrations.agreement_versions_v1;
  v_row      registrations.signed_agreements_v1;
BEGIN
  SELECT * INTO v_agr_ver FROM registrations.agreement_versions_v1
  WHERE service_type = p_service_type AND is_current = true ORDER BY created_at DESC LIMIT 1;

  INSERT INTO registrations.signed_agreements_v1 (
    artist_email, artist_id, engagement_id, agreement_version_id,
    service_type, version, full_agreement_text,
    status, ip_address, user_agent, signed_at
  ) VALUES (
    p_artist_email, p_artist_id, p_engagement_id,
    v_agr_ver.id,
    p_service_type,
    COALESCE(v_agr_ver.version, 'v1.0'),
    COALESCE(v_agr_ver.body_text, 'Standard MusiGod recovery service agreement. Artists retain 100% ownership. Fee: 15% of successful recovery only.'),
    'SIGNED', p_ip_address, p_user_agent, now()
  ) RETURNING * INTO v_row;

  -- Log signature event
  INSERT INTO registrations.signature_events_v1 (
    agreement_id, artist_email, event_type, event_detail, ip_address, user_agent
  ) VALUES (
    v_row.id, p_artist_email, 'SIGNED',
    'Artist digitally signed agreement ref: ' || v_row.agreement_ref,
    p_ip_address, p_user_agent
  );

  -- Log timeline
  PERFORM registrations.fn_log_artist_activity_v1(
    p_artist_email := p_artist_email,
    p_event_type   := 'AGREEMENT_SIGNED',
    p_event_title  := 'Recovery agreement signed: ' || COALESCE(v_agr_ver.title, p_service_type),
    p_event_body   := 'Agreement ref: ' || v_row.agreement_ref || ' · Version: ' || v_row.version || ' · Signed at: ' || to_char(now(), 'YYYY-MM-DD HH24:MI TZ'),
    p_visibility   := 'BOTH',
    p_created_by   := 'artist'
  );

  RETURN v_row;
END; $$;

-- Full onboarding pipeline: sign + stage + assign + readiness
CREATE OR REPLACE FUNCTION registrations.fn_complete_authorization_onboarding_v1(
  p_artist_email  text,
  p_service_type  text,
  p_engagement_id uuid DEFAULT NULL,
  p_artist_id     uuid DEFAULT NULL,
  p_ip_address    text DEFAULT NULL,
  p_user_agent    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_signed      registrations.signed_agreements_v1;
  v_stage       registrations.operational_stages_v1;
  v_assignment  registrations.recovery_assignments_v1;
  v_readiness   registrations.recovery_readiness_v1;
  v_stage_label text;
  v_stage_desc  text;
  v_blocking    text;
BEGIN
  -- Sign agreement
  PERFORM registrations.fn_sign_agreement_v1(p_artist_email, p_service_type, p_engagement_id, p_artist_id, p_ip_address, p_user_agent);
  SELECT * INTO v_signed FROM registrations.signed_agreements_v1
  WHERE artist_email = p_artist_email AND service_type = p_service_type ORDER BY signed_at DESC LIMIT 1;

  -- Set initial operational stage
  v_stage_label := CASE p_service_type
    WHEN 'PUBLISHING_ADMIN'   THEN 'Publishing Administration Setup'
    WHEN 'MLC_REGISTRATION'   THEN 'MLC Registration Filing'
    WHEN 'NEIGHBORING_RIGHTS' THEN 'SoundExchange Registration'
    WHEN 'FOREIGN_COLLECTION' THEN 'International Collection Onboarding'
    WHEN 'PRO_VERIFICATION'   THEN 'PRO Registration Verification'
    ELSE 'Recovery Operations Initiated'
  END;
  v_stage_desc := CASE p_service_type
    WHEN 'PUBLISHING_ADMIN'   THEN 'MusiGod is initiating publishing administration setup. Awaiting required documents to proceed with work registration and royalty collection setup.'
    WHEN 'MLC_REGISTRATION'   THEN 'MusiGod is preparing MLC registration filing. Distributor statements and split sheets required to complete registration.'
    WHEN 'NEIGHBORING_RIGHTS' THEN 'MusiGod is initiating SoundExchange registration. Sound recording metadata required to complete filing.'
    WHEN 'FOREIGN_COLLECTION' THEN 'MusiGod is initiating international collection society onboarding. PRO membership confirmation and catalog metadata required.'
    WHEN 'PRO_VERIFICATION'   THEN 'MusiGod is auditing PRO registration status. Existing PRO statements requested for cross-reference.'
    ELSE 'Recovery operations initiated. Document collection underway.'
  END;
  v_blocking := 'Awaiting supporting document uploads from artist.';

  IF p_engagement_id IS NOT NULL THEN
    PERFORM registrations.fn_advance_operational_stage_v1(p_engagement_id, 'DOCUMENTS_PENDING', v_stage_label, v_stage_desc, v_blocking, NULL, 'system');
    SELECT * INTO v_stage FROM registrations.operational_stages_v1 WHERE recovery_engagement_id = p_engagement_id ORDER BY created_at DESC LIMIT 1;
    PERFORM registrations.fn_assign_recovery_team_v1(p_engagement_id, p_service_type);
    SELECT * INTO v_assignment FROM registrations.recovery_assignments_v1 WHERE recovery_engagement_id = p_engagement_id ORDER BY assigned_at DESC LIMIT 1;
  END IF;

  PERFORM registrations.fn_calculate_recovery_readiness_v1(p_artist_email, NULL);
  SELECT * INTO v_readiness FROM registrations.recovery_readiness_v1 WHERE artist_email = p_artist_email ORDER BY created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'agreement_ref',    v_signed.agreement_ref,
    'signed_at',        v_signed.signed_at,
    'stage_label',      v_stage_label,
    'assigned_team',    v_assignment.assigned_team,
    'readiness_score',  v_readiness.readiness_score,
    'readiness_level',  v_readiness.readiness_level
  );
END; $$;

-- ============================================================
-- SEED: Default teams + agreement versions
-- ============================================================

INSERT INTO registrations.recovery_teams_v1 (team_name, team_label, team_type, description)
VALUES
  ('publishing_admin_ops',       'Publishing Administration Operations', 'OPERATIONS', 'Handles publishing admin setup, work registration, and royalty collection'),
  ('mechanical_rights_ops',      'Mechanical Rights Operations',         'OPERATIONS', 'MLC registration, digital mechanical royalty claims'),
  ('neighboring_rights_ops',     'Neighboring Rights Operations',        'OPERATIONS', 'SoundExchange registration, neighboring rights claims'),
  ('international_collection_ops','International Collection Operations', 'OPERATIONS', 'Foreign PRO sub-publishing, international collection setup'),
  ('rights_verification_ops',    'Rights Verification Operations',       'OPERATIONS', 'PRO audit, ownership verification, metadata reconciliation'),
  ('recovery_operations',        'Recovery Operations',                  'OPERATIONS', 'General recovery case management'),
  ('escalation_desk',            'Recovery Escalation Desk',             'ESCALATION', 'High-value and complex case escalation')
ON CONFLICT (team_name) DO NOTHING;

INSERT INTO registrations.agreement_versions_v1 (service_type, version, title, body_text, is_current)
VALUES
  ('PUBLISHING_ADMIN', 'v1.0', 'MusiGod Publishing Administration Agreement',
'MUSIGOD PUBLISHING ADMINISTRATION AGREEMENT
Version 1.0 | Effective June 1, 2026

This Publishing Administration Agreement ("Agreement") is entered into between the Artist and MusiGod Publishing Administration ("MusiGod").

1. SCOPE OF SERVICES
MusiGod will act as Publishing Administrator for the Artist''s catalog, including:
- Registration of all works with PROs (ASCAP, BMI, SESAC)
- Registration with the Mechanical Licensing Collective (MLC)
- International sub-publishing relationships
- Sync licensing administration
- Retroactive royalty claims and recovery

2. OWNERSHIP
The Artist retains 100% ownership of all copyrights and master recordings. MusiGod does not acquire any ownership interest in any works.

3. COMPENSATION
MusiGod''s fee is 15% of royalties successfully recovered through MusiGod administration. No upfront fees. No recovery = no fee.

4. RECOVERY ESTIMATES
Recovery estimates provided by MusiGod are probabilistic and not guaranteed. Actual recovery depends on catalog history, society processing, and documentation quality.

5. RECOVERY TIMELINES
Recovery timelines depend on third-party processing by collection societies and are outside MusiGod''s direct control.

6. TERMINATION
Either party may terminate with 30 days written notice. Fees apply only to royalties recovered during the active term.

7. GOVERNING LAW
This Agreement is governed by the laws of Michigan. Disputes subject to AAA arbitration in Detroit, Michigan.

By signing, the Artist confirms: Artists retain 100% ownership. MusiGod earns only from successful recovery. Standard recovery fee: 15%. Recovery estimates are probabilistic and not guaranteed.',
  true),
  ('MLC_REGISTRATION', 'v1.0', 'MusiGod MLC Registration & Claims Service Agreement',
'MUSIGOD MLC REGISTRATION & CLAIMS SERVICE AGREEMENT
Version 1.0 | Effective June 1, 2026

MusiGod will register Artist works with the Mechanical Licensing Collective and file retroactive mechanical royalty claims.

COMPENSATION: 15% of royalties successfully recovered. No upfront fees.
OWNERSHIP: Artist retains full ownership of all compositions.
ESTIMATES: Recovery estimates are probabilistic and not guaranteed.
TIMELINES: MLC processing typically takes 45-120 days.',
  true),
  ('NEIGHBORING_RIGHTS', 'v1.0', 'MusiGod Neighboring Rights Registration Service Agreement',
'MUSIGOD NEIGHBORING RIGHTS REGISTRATION SERVICE AGREEMENT
Version 1.0 | Effective June 1, 2026

MusiGod will register Artist sound recordings with SoundExchange and applicable international neighboring rights societies.

COMPENSATION: 15% of royalties successfully recovered. No upfront fees.
OWNERSHIP: Artist/label retains full ownership of all sound recordings.
ESTIMATES: Recovery estimates are probabilistic and not guaranteed.
TIMELINES: SoundExchange registration takes 30-60 days; retroactive claims may take 3-6 months.',
  true),
  ('FOREIGN_COLLECTION', 'v1.0', 'MusiGod International Collection Service Agreement',
'MUSIGOD INTERNATIONAL COLLECTION SERVICE AGREEMENT
Version 1.0 | Effective June 1, 2026

MusiGod will establish sub-publishing relationships with international collection societies for foreign royalty recovery.

COMPENSATION: 15% of royalties successfully recovered. No upfront fees.
OWNERSHIP: Artist retains full ownership in all territories.
ESTIMATES: Recovery estimates are probabilistic and not guaranteed.
TIMELINES: International timelines vary by territory; 90-365 days typical.',
  true),
  ('PRO_VERIFICATION', 'v1.0', 'MusiGod PRO Verification & Correction Service Agreement',
'MUSIGOD PRO VERIFICATION & CORRECTION SERVICE AGREEMENT
Version 1.0 | Effective June 1, 2026

MusiGod will audit and verify PRO registrations across ASCAP, BMI, and SESAC, and file corrections and retroactive claims.

COMPENSATION: 15% of royalties successfully recovered. No upfront fees.
OWNERSHIP: Artist retains full PRO membership and ownership.
ESTIMATES: Recovery estimates are probabilistic and not guaranteed.',
  true)
ON CONFLICT (service_type, version) DO NOTHING;

-- ============================================================
-- GRANTS + RLS
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.operational_stages_v1    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.operational_updates_v1   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.recovery_teams_v1        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.recovery_assignments_v1  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.recovery_readiness_v1    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.agreement_versions_v1    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.signed_agreements_v1     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON registrations.signature_events_v1      TO service_role;
GRANT SELECT ON registrations.v_operational_status_summary_v1                  TO service_role;

GRANT EXECUTE ON FUNCTION registrations.fn_advance_operational_stage_v1          TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_assign_recovery_team_v1               TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_calculate_recovery_readiness_v1       TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_sign_agreement_v1                     TO service_role;
GRANT EXECUTE ON FUNCTION registrations.fn_complete_authorization_onboarding_v1  TO service_role;

ALTER TABLE registrations.operational_stages_v1    ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.operational_updates_v1   ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.recovery_teams_v1        ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.recovery_assignments_v1  ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.recovery_readiness_v1    ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.agreement_versions_v1    ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.signed_agreements_v1     ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.signature_events_v1      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS srole_opstages   ON registrations.operational_stages_v1;    CREATE POLICY srole_opstages   ON registrations.operational_stages_v1    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_opupdates  ON registrations.operational_updates_v1;   CREATE POLICY srole_opupdates  ON registrations.operational_updates_v1   FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_teams      ON registrations.recovery_teams_v1;        CREATE POLICY srole_teams      ON registrations.recovery_teams_v1        FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_assign     ON registrations.recovery_assignments_v1;  CREATE POLICY srole_assign     ON registrations.recovery_assignments_v1  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_readiness  ON registrations.recovery_readiness_v1;    CREATE POLICY srole_readiness  ON registrations.recovery_readiness_v1    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_agr_ver    ON registrations.agreement_versions_v1;    CREATE POLICY srole_agr_ver    ON registrations.agreement_versions_v1    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_signed     ON registrations.signed_agreements_v1;     CREATE POLICY srole_signed     ON registrations.signed_agreements_v1     FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS srole_sig_events ON registrations.signature_events_v1;      CREATE POLICY srole_sig_events ON registrations.signature_events_v1      FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- SEED: Run onboarding pipeline for existing test engagement
-- ============================================================

DO $$
DECLARE
  v_eng_id uuid;
  v_result jsonb;
BEGIN
  SELECT id INTO v_eng_id FROM registrations.recovery_engagements_v1
  WHERE artist_email = 'swordfishlp44@proton.me'
  AND service_type = 'PUBLISHING_ADMIN'
  ORDER BY created_at DESC LIMIT 1;

  IF v_eng_id IS NOT NULL THEN
    SELECT registrations.fn_complete_authorization_onboarding_v1(
      'swordfishlp44@proton.me', 'PUBLISHING_ADMIN', v_eng_id,
      '3d4788b6-2a86-4ed5-8f27-ab95b3a230d3'::uuid,
      '127.0.0.1', 'MusiGod/seed'
    ) INTO v_result;
    RAISE NOTICE 'Onboarding complete: %', v_result;
  ELSE
    RAISE NOTICE 'No existing engagement found for test artist — skipping seed';
  END IF;

  -- Calculate readiness regardless
  PERFORM registrations.fn_calculate_recovery_readiness_v1('swordfishlp44@proton.me', NULL);
END;
$$;
