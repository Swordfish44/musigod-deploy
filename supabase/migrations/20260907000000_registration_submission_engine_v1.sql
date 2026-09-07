BEGIN;
CREATE TABLE IF NOT EXISTS registrations.registration_submission_connectors_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), destination text NOT NULL, channel text NOT NULL,
  format text NOT NULL, status text NOT NULL DEFAULT 'UNVERIFIED' CHECK(status IN('UNVERIFIED','TESTED','VERIFIED','SUSPENDED','RETIRED')),
  authority_source text, verified_by uuid REFERENCES auth.users(id), verified_at timestamptz,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(destination,channel,format), CHECK(status NOT IN('VERIFIED') OR (authority_source IS NOT NULL AND verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS registrations.registration_submission_packages_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES registrations.rights_registration_profiles_v1(id) ON DELETE CASCADE,
  registration_item_id uuid REFERENCES registrations.rights_registration_items_v1(id) ON DELETE SET NULL, destination text NOT NULL,
  channel text NOT NULL, format text NOT NULL, engine_version text NOT NULL, payload jsonb NOT NULL,
  payload_sha256 text NOT NULL CHECK(payload_sha256~'^[a-f0-9]{64}$'), authorization_reference text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','VALIDATING','BLOCKED','READY_FOR_REVIEW','APPROVED','DISPATCHING','FAILED','SUBMITTED','PARTIALLY_ACCEPTED','ACCEPTED','REJECTED','REJECTED_BY_DESTINATION','CANCELLED','CLOSED')),
  approved_by uuid REFERENCES auth.users(id), approved_at timestamptz, approval_notes text, attempt_count integer NOT NULL DEFAULT 0,
  last_error_safe text, external_reference text, external_response_sha256 text, submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(status NOT IN('APPROVED','DISPATCHING','SUBMITTED','PARTIALLY_ACCEPTED','ACCEPTED','REJECTED_BY_DESTINATION','CLOSED') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS registrations.registration_submission_events_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), package_id uuid NOT NULL REFERENCES registrations.registration_submission_packages_v1(id) ON DELETE CASCADE,
  event_type text NOT NULL, from_status text, to_status text, actor_id uuid REFERENCES auth.users(id),
  notes text, evidence jsonb NOT NULL DEFAULT '{}'::jsonb, occurred_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE registrations.registration_submission_connectors_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.registration_submission_packages_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.registration_submission_events_v1 ENABLE ROW LEVEL SECURITY;
CREATE POLICY registration_submission_connectors_service_v1 ON registrations.registration_submission_connectors_v1 FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE POLICY registration_submission_packages_service_v1 ON registrations.registration_submission_packages_v1 FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE POLICY registration_submission_events_service_v1 ON registrations.registration_submission_events_v1 FOR ALL TO service_role USING(true) WITH CHECK(true);
REVOKE ALL ON registrations.registration_submission_connectors_v1, registrations.registration_submission_packages_v1, registrations.registration_submission_events_v1 FROM anon,authenticated;
GRANT ALL ON registrations.registration_submission_connectors_v1, registrations.registration_submission_packages_v1, registrations.registration_submission_events_v1 TO service_role;
CREATE OR REPLACE FUNCTION registrations.fn_registration_submission_events_immutable_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'registration submission events are append-only'; END $$;
CREATE TRIGGER trg_registration_submission_events_immutable_v1 BEFORE UPDATE OR DELETE ON registrations.registration_submission_events_v1 FOR EACH ROW EXECUTE FUNCTION registrations.fn_registration_submission_events_immutable_v1();
CREATE INDEX IF NOT EXISTS registration_submission_packages_profile_status_idx ON registrations.registration_submission_packages_v1(profile_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS registration_submission_events_package_idx ON registrations.registration_submission_events_v1(package_id,occurred_at);
NOTIFY pgrst,'reload schema';
COMMIT;
