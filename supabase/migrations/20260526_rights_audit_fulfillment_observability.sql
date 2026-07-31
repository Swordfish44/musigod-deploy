-- Adds production fulfillment diagnostics for paid MusiGod Rights Audit unlocks.
-- Safe to run multiple times and preserves existing rows.

ALTER TABLE public.rights_audits_v1
  ADD COLUMN IF NOT EXISTS next_steps_email_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fulfillment_status TEXT,
  ADD COLUMN IF NOT EXISTS fulfillment_error TEXT,
  ADD COLUMN IF NOT EXISTS n8n_fulfillment_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS n8n_fulfillment_status TEXT;

CREATE INDEX IF NOT EXISTS rights_audits_v1_fulfilled_at_idx
  ON public.rights_audits_v1 (fulfilled_at DESC)
  WHERE fulfilled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS rights_audits_v1_fulfillment_status_idx
  ON public.rights_audits_v1 (fulfillment_status, paid_at DESC);
