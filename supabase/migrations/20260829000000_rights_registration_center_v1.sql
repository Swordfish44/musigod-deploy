BEGIN;
CREATE SCHEMA IF NOT EXISTS registrations;

CREATE TABLE IF NOT EXISTS registrations.rights_registration_profiles_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auth_user_id uuid UNIQUE, artist_id uuid REFERENCES registrations.artists_v1(id), legal_name text NOT NULL, artist_name text,
 intake_answers jsonb NOT NULL DEFAULT '{}', pilot_code text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS registrations.rights_registration_items_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 pipeline_key text NOT NULL, organization text NOT NULL, rights_category text NOT NULL, responsible_party text NOT NULL CHECK(responsible_party IN('ARTIST','MUSIGOD','ARTIST_OR_MUSIGOD','ARTIST_OR_COUNSEL','ARTIST_OR_DISTRIBUTOR')),
 why_needed text NOT NULL, official_url text NOT NULL CHECK(official_url ~ '^https://'), status text NOT NULL DEFAULT 'NOT_STARTED' CHECK(status IN('NOT_APPLICABLE','NOT_STARTED','IN_PROGRESS','SUBMITTED','PENDING_VERIFICATION','ACTIVE','NEEDS_ATTENTION','DEFERRED')),
 applicability jsonb NOT NULL DEFAULT '{}', required_documents jsonb NOT NULL DEFAULT '[]', instructions jsonb NOT NULL DEFAULT '[]', member_number text,
 submitted_at timestamptz, verified_at timestamptz, expires_at timestamptz, rejected_at timestamptz, attention_reason text, sort_order integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(profile_id,pipeline_key)
);
CREATE TABLE IF NOT EXISTS registrations.rights_identifiers_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 registration_item_id uuid REFERENCES registrations.rights_registration_items_v1(id) ON DELETE SET NULL, identifier_type text NOT NULL CHECK(identifier_type IN('WRITER_IPI','PUBLISHER_IPI','ISRC','ISWC','SOUNDEXCHANGE_ID','DPID','ISNI','MEMBER_ID')),
 identifier_value text NOT NULL, verification_status text NOT NULL DEFAULT 'UNVERIFIED' CHECK(verification_status IN('UNVERIFIED','PENDING','VERIFIED','REJECTED')),
 source text NOT NULL, verified_by uuid, verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(profile_id,identifier_type,identifier_value)
);
CREATE TABLE IF NOT EXISTS registrations.rights_authorizations_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 scope text NOT NULL, scope_details jsonb NOT NULL DEFAULT '{}', terms_version text NOT NULL, status text NOT NULL CHECK(status IN('PENDING_SIGNATURE','EXECUTED','REVOKED','EXPIRED','REJECTED')),
 requested_by text NOT NULL, executed_at timestamptz, revoked_at timestamptz, expires_at timestamptz, evidence_document_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status<>'EXECUTED' OR executed_at IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS registrations.rights_registration_evidence_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 registration_item_id uuid REFERENCES registrations.rights_registration_items_v1(id) ON DELETE SET NULL, storage_bucket text NOT NULL DEFAULT 'artist-documents', object_path text NOT NULL UNIQUE,
 file_name text NOT NULL, mime_type text NOT NULL, file_size_bytes bigint NOT NULL CHECK(file_size_bytes BETWEEN 1 AND 10485760), sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
 evidence_type text NOT NULL, review_status text NOT NULL DEFAULT 'PENDING' CHECK(review_status IN('PENDING','VERIFIED','REJECTED')), uploaded_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS registrations.rights_registration_reviews_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 registration_item_id uuid REFERENCES registrations.rights_registration_items_v1(id) ON DELETE SET NULL, review_type text NOT NULL, status text NOT NULL DEFAULT 'OPEN' CHECK(status IN('OPEN','IN_REVIEW','APPROVED','REJECTED','CLOSED')),
 summary text NOT NULL, assigned_reviewer uuid, resolution_notes text, resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), CHECK(status IN('OPEN','IN_REVIEW') OR (assigned_reviewer IS NOT NULL AND length(trim(resolution_notes))>=12))
);
CREATE TABLE IF NOT EXISTS registrations.rights_registration_reminders_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
 registration_item_id uuid REFERENCES registrations.rights_registration_items_v1(id) ON DELETE CASCADE, reminder_type text NOT NULL, due_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'SCHEDULED' CHECK(status IN('SCHEDULED','SENT','CANCELLED','FAILED')), attempt_count integer NOT NULL DEFAULT 0, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS registrations.rights_registration_audit_events_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE RESTRICT,
 event_type text NOT NULL, actor_type text NOT NULL CHECK(actor_type IN('CLIENT','ADMIN','SYSTEM')), actor_subject text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', payload_hash text NOT NULL CHECK(payload_hash~'^[0-9a-f]{64}$'), created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION registrations.fn_rights_registration_audit_immutable_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rights registration audit events are append-only'; END $$;
DROP TRIGGER IF EXISTS trg_rights_registration_audit_immutable_v1 ON registrations.rights_registration_audit_events_v1;
CREATE TRIGGER trg_rights_registration_audit_immutable_v1 BEFORE UPDATE OR DELETE ON registrations.rights_registration_audit_events_v1 FOR EACH ROW EXECUTE FUNCTION registrations.fn_rights_registration_audit_immutable_v1();

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['rights_registration_profiles_v1','rights_registration_items_v1','rights_identifiers_v1','rights_authorizations_v1','rights_registration_evidence_v1','rights_registration_reviews_v1','rights_registration_reminders_v1','rights_registration_audit_events_v1'] LOOP
 EXECUTE format('ALTER TABLE registrations.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('DROP POLICY IF EXISTS %I ON registrations.%I',t||'_service_role_all',t);
 EXECUTE format('CREATE POLICY %I ON registrations.%I FOR ALL TO service_role USING(true) WITH CHECK(true)',t||'_service_role_all',t);
 EXECUTE format('REVOKE ALL ON registrations.%I FROM anon,authenticated',t); EXECUTE format('GRANT ALL ON registrations.%I TO service_role',t);
END LOOP; END $$;
CREATE INDEX IF NOT EXISTS rights_registration_items_status_idx ON registrations.rights_registration_items_v1(profile_id,status);
CREATE INDEX IF NOT EXISTS rights_registration_review_queue_idx ON registrations.rights_registration_reviews_v1(status,created_at);
CREATE INDEX IF NOT EXISTS rights_registration_reminder_due_idx ON registrations.rights_registration_reminders_v1(status,due_at);

-- Pilot records are deliberately excluded from this public migration. They are inserted
-- server-side with scripts/seed-rights-registration-pilot.js so personal identifiers never
-- enter source control. The profile remains unreadable until explicitly linked to auth.users.
NOTIFY pgrst,'reload schema';
COMMIT;
