-- Adds paid unlock tracking for MusiGod Rights Audit purchases.
-- Safe to run multiple times.

ALTER TABLE public.rights_audits_v1
  ADD COLUMN IF NOT EXISTS paid_status TEXT NOT NULL DEFAULT 'UNPAID'
    CHECK (paid_status IN ('UNPAID','PAID','REFUNDED')),
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_session_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_customer_email TEXT;

CREATE INDEX IF NOT EXISTS rights_audits_v1_paid_status_idx
  ON public.rights_audits_v1 (paid_status, paid_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS rights_audits_v1_stripe_session_id_idx
  ON public.rights_audits_v1 (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;
