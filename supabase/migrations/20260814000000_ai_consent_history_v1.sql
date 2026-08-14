-- 20260814000000_ai_consent_history_v1.sql
--
-- Adds an append-only audit history table for ai_consent_v1 changes.
--
-- Every INSERT or UPDATE on ai_consent_v1 triggers a row here, capturing:
--   previous_status (NULL on first insert), new_status, and full provenance.
-- Rows may not be updated or deleted — enforced by BEFORE triggers.
--
-- This is the fix for the audit-history gap in the original consent ledger:
-- the upsert model overwrote prior state with no record of what changed.
--
-- Per CLAUDE.md: touches consent state → human PR review required before merge.

-- ─── History table ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_consent_history_v1 (
  id               UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_id       UUID                     NOT NULL,  -- ai_consent_v1.id at time of change
  work_id          UUID                     NOT NULL,
  consent_type     public.ai_consent_type   NOT NULL,
  previous_status  public.ai_consent_status,           -- NULL on first insert
  new_status       public.ai_consent_status NOT NULL,
  granted_by       UUID,
  granted_at       TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  provenance       JSONB NOT NULL DEFAULT '{}'::jsonb,
  changed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_consent_history_v1_work_id_idx
  ON public.ai_consent_history_v1 (work_id);

CREATE INDEX IF NOT EXISTS ai_consent_history_v1_consent_id_idx
  ON public.ai_consent_history_v1 (consent_id);

CREATE INDEX IF NOT EXISTS ai_consent_history_v1_changed_at_idx
  ON public.ai_consent_history_v1 (changed_at DESC);

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- Service role writes (via trigger). Authenticated role reads. No deletes.

ALTER TABLE public.ai_consent_history_v1 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_consent_history_v1_service_role_all ON public.ai_consent_history_v1;
CREATE POLICY ai_consent_history_v1_service_role_all
  ON public.ai_consent_history_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ai_consent_history_v1_authenticated_read ON public.ai_consent_history_v1;
CREATE POLICY ai_consent_history_v1_authenticated_read
  ON public.ai_consent_history_v1 FOR SELECT TO authenticated USING (true);

-- ─── Append-only guard ────────────────────────────────────────────────────────
-- Raise before any UPDATE or DELETE so no caller — including service_role — can
-- silently alter historical records. Corrections require a superuser override.

CREATE OR REPLACE FUNCTION public.fn_ai_consent_history_v1_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_consent_history_v1 is append-only: updates and deletes are not permitted';
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_consent_history_v1_no_update ON public.ai_consent_history_v1;
CREATE TRIGGER trg_ai_consent_history_v1_no_update
  BEFORE UPDATE ON public.ai_consent_history_v1
  FOR EACH ROW EXECUTE FUNCTION public.fn_ai_consent_history_v1_immutable();

DROP TRIGGER IF EXISTS trg_ai_consent_history_v1_no_delete ON public.ai_consent_history_v1;
CREATE TRIGGER trg_ai_consent_history_v1_no_delete
  BEFORE DELETE ON public.ai_consent_history_v1
  FOR EACH ROW EXECUTE FUNCTION public.fn_ai_consent_history_v1_immutable();

-- ─── Audit trigger on ai_consent_v1 ─────────────────────────────────────────
-- Fires AFTER every INSERT or UPDATE and writes one immutable history row.

CREATE OR REPLACE FUNCTION public.fn_ai_consent_v1_record_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.ai_consent_history_v1 (
    consent_id,
    work_id,
    consent_type,
    previous_status,
    new_status,
    granted_by,
    granted_at,
    expires_at,
    provenance,
    changed_at
  ) VALUES (
    NEW.id,
    NEW.work_id,
    NEW.consent_type,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END,
    NEW.status,
    NEW.granted_by,
    NEW.granted_at,
    NEW.expires_at,
    NEW.provenance,
    now()
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_consent_v1_record_history ON public.ai_consent_v1;
CREATE TRIGGER trg_ai_consent_v1_record_history
  AFTER INSERT OR UPDATE ON public.ai_consent_v1
  FOR EACH ROW EXECUTE FUNCTION public.fn_ai_consent_v1_record_history();

-- ─── Reload PostgREST ─────────────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';
