-- 20260724_registration_readiness_v1.sql
--
-- Registration Readiness Gate — Persistence Layer
--
-- Two tables:
--   registration_readiness_v1         — one current row per (track, destination)
--   registration_readiness_history_v1 — append-only audit of every evaluation
--
-- Evaluation engine lives in lib/registration-readiness.js (pure JS, no DB).
-- Writes go through rpc_upsert_readiness_decision (SECURITY DEFINER).
-- Reads are safe via the public schema REST API with service_role key.
--
-- ADDITIVE ONLY. No existing tables modified.

-- ─── Destinations ────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE public.readiness_destination AS ENUM (
    'ASCAP', 'BMI', 'MLC', 'SOUNDEXCHANGE', 'NEIGHBORING_RIGHTS'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.readiness_decision AS ENUM (
    'READY', 'BLOCKED', 'NEEDS_REVIEW', 'NOT_APPLICABLE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── registration_readiness_v1 ────────────────────────────────────────────────
-- One current evaluation per (catalog_track_id, destination).
-- UPSERTED on each evaluation run — previous values are overwritten.
-- Full history is preserved in registration_readiness_history_v1.

CREATE TABLE IF NOT EXISTS public.registration_readiness_v1 (
  id                  UUID                        PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_track_id    UUID                        NOT NULL
                        REFERENCES public.catalog_enriched_tracks_v1(id) ON DELETE CASCADE,
  destination         public.readiness_destination NOT NULL,
  decision            public.readiness_decision    NOT NULL,
  evaluated_at        TIMESTAMPTZ                 NOT NULL DEFAULT now(),
  ruleset_version     TEXT                        NOT NULL DEFAULT 'registration-readiness-v1',
  blockers            JSONB                       NOT NULL DEFAULT '[]'::jsonb,
  warnings            JSONB                       NOT NULL DEFAULT '[]'::jsonb,
  evidence_summary    JSONB                       NOT NULL DEFAULT '{}'::jsonb,
  -- Untyped UUID — avoids FK to rights_registrations_v1 which may be in rights schema
  existing_registration UUID,
  created_at          TIMESTAMPTZ                 NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ                 NOT NULL DEFAULT now(),

  CONSTRAINT registration_readiness_v1_track_dest_unique
    UNIQUE (catalog_track_id, destination)
);

CREATE INDEX IF NOT EXISTS registration_readiness_v1_track_idx
  ON public.registration_readiness_v1 (catalog_track_id);

CREATE INDEX IF NOT EXISTS registration_readiness_v1_destination_idx
  ON public.registration_readiness_v1 (destination);

CREATE INDEX IF NOT EXISTS registration_readiness_v1_decision_idx
  ON public.registration_readiness_v1 (decision);

CREATE INDEX IF NOT EXISTS registration_readiness_v1_evaluated_at_idx
  ON public.registration_readiness_v1 (evaluated_at DESC);

-- ─── registration_readiness_history_v1 ───────────────────────────────────────
-- Append-only. One row per evaluation. Never deleted. Never updated.
-- Written by trigger on registration_readiness_v1 INSERT and UPDATE.

CREATE TABLE IF NOT EXISTS public.registration_readiness_history_v1 (
  id                  UUID                        PRIMARY KEY DEFAULT gen_random_uuid(),
  readiness_id        UUID                        NOT NULL,   -- ID from registration_readiness_v1
  catalog_track_id    UUID                        NOT NULL,
  destination         public.readiness_destination NOT NULL,
  decision            public.readiness_decision    NOT NULL,
  evaluated_at        TIMESTAMPTZ                 NOT NULL,
  ruleset_version     TEXT                        NOT NULL,
  blockers            JSONB                       NOT NULL DEFAULT '[]'::jsonb,
  warnings            JSONB                       NOT NULL DEFAULT '[]'::jsonb,
  evidence_summary    JSONB                       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ                 NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registration_readiness_history_v1_track_idx
  ON public.registration_readiness_history_v1 (catalog_track_id);

CREATE INDEX IF NOT EXISTS registration_readiness_history_v1_readiness_id_idx
  ON public.registration_readiness_history_v1 (readiness_id);

CREATE INDEX IF NOT EXISTS registration_readiness_history_v1_dest_idx
  ON public.registration_readiness_history_v1 (destination, evaluated_at DESC);

-- ─── Trigger: log every evaluation to history ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_log_readiness_to_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.registration_readiness_history_v1 (
    readiness_id, catalog_track_id, destination, decision,
    evaluated_at, ruleset_version, blockers, warnings, evidence_summary
  ) VALUES (
    NEW.id, NEW.catalog_track_id, NEW.destination, NEW.decision,
    NEW.evaluated_at, NEW.ruleset_version, NEW.blockers, NEW.warnings, NEW.evidence_summary
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_readiness_to_history ON public.registration_readiness_v1;
CREATE TRIGGER trg_log_readiness_to_history
  AFTER INSERT OR UPDATE ON public.registration_readiness_v1
  FOR EACH ROW EXECUTE FUNCTION public.fn_log_readiness_to_history();

-- ─── updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_touch_registration_readiness_v1_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_touch_registration_readiness_v1_updated_at ON public.registration_readiness_v1;
CREATE TRIGGER trg_touch_registration_readiness_v1_updated_at
  BEFORE UPDATE ON public.registration_readiness_v1
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_registration_readiness_v1_updated_at();

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.registration_readiness_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS registration_readiness_v1_service_role_all ON public.registration_readiness_v1;
CREATE POLICY registration_readiness_v1_service_role_all
  ON public.registration_readiness_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.registration_readiness_history_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS registration_readiness_history_v1_service_role_all ON public.registration_readiness_history_v1;
CREATE POLICY registration_readiness_history_v1_service_role_all
  ON public.registration_readiness_history_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── Upsert RPC ──────────────────────────────────────────────────────────────
-- Called by api/evaluate-readiness.js with service_role key.
-- SECURITY DEFINER so the history trigger fires with correct privileges.

CREATE OR REPLACE FUNCTION public.rpc_upsert_readiness_decision(
  p_catalog_track_id  UUID,
  p_destination       TEXT,
  p_decision          TEXT,
  p_ruleset_version   TEXT,
  p_blockers          JSONB,
  p_warnings          JSONB,
  p_evidence_summary  JSONB
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_dest      public.readiness_destination;
  v_dec       public.readiness_decision;
  v_id        UUID;
BEGIN
  BEGIN
    v_dest := p_destination::public.readiness_destination;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('error', 'invalid destination: ' || p_destination);
  END;

  BEGIN
    v_dec := p_decision::public.readiness_decision;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('error', 'invalid decision: ' || p_decision);
  END;

  INSERT INTO public.registration_readiness_v1 (
    catalog_track_id, destination, decision, ruleset_version,
    blockers, warnings, evidence_summary, evaluated_at
  ) VALUES (
    p_catalog_track_id, v_dest, v_dec, p_ruleset_version,
    COALESCE(p_blockers, '[]'::jsonb),
    COALESCE(p_warnings, '[]'::jsonb),
    COALESCE(p_evidence_summary, '{}'::jsonb),
    now()
  )
  ON CONFLICT (catalog_track_id, destination) DO UPDATE SET
    decision         = EXCLUDED.decision,
    ruleset_version  = EXCLUDED.ruleset_version,
    blockers         = EXCLUDED.blockers,
    warnings         = EXCLUDED.warnings,
    evidence_summary = EXCLUDED.evidence_summary,
    evaluated_at     = EXCLUDED.evaluated_at,
    updated_at       = now()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'id',               v_id,
    'catalog_track_id', p_catalog_track_id,
    'destination',      p_destination,
    'decision',         p_decision
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_upsert_readiness_decision(UUID, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB)
  TO service_role;

-- ─── Summary RPC ─────────────────────────────────────────────────────────────
-- Returns readiness counts grouped by decision and destination for an artist.

CREATE OR REPLACE FUNCTION public.rpc_get_readiness_summary(
  p_artist_name TEXT  DEFAULT NULL,
  p_track_ids   UUID[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH tracks AS (
    SELECT id FROM public.catalog_enriched_tracks_v1
    WHERE (p_artist_name IS NULL OR artist_name ILIKE p_artist_name)
      AND (p_track_ids IS NULL OR id = ANY(p_track_ids))
  ),
  decisions AS (
    SELECT r.destination, r.decision, COUNT(*) AS cnt
    FROM public.registration_readiness_v1 r
    WHERE r.catalog_track_id IN (SELECT id FROM tracks)
    GROUP BY r.destination, r.decision
  ),
  not_evaluated AS (
    SELECT COUNT(*) AS cnt
    FROM tracks t
    WHERE NOT EXISTS (
      SELECT 1 FROM public.registration_readiness_v1 r
      WHERE r.catalog_track_id = t.id
    )
  ),
  by_destination AS (
    SELECT destination, jsonb_object_agg(decision, cnt) AS counts
    FROM decisions
    GROUP BY destination
  )
  SELECT jsonb_build_object(
    'by_destination', COALESCE((SELECT jsonb_object_agg(destination, counts) FROM by_destination), '{}'::jsonb),
    'not_evaluated',  (SELECT cnt FROM not_evaluated),
    'total_tracks',   (SELECT COUNT(*) FROM tracks)
  );
$$;

GRANT EXECUTE ON FUNCTION public.rpc_get_readiness_summary(TEXT, UUID[])
  TO service_role;

-- ─── Reload PostgREST ─────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
