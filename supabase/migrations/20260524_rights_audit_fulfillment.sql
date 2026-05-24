-- Adds idempotent fulfillment tracking for paid MusiGod Rights Audit unlocks.
-- Safe to run multiple times and preserves existing rows.

ALTER TABLE public.rights_audits_v1
  ADD COLUMN IF NOT EXISTS next_steps_email_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS rights_audits_v1_fulfilled_at_idx
  ON public.rights_audits_v1 (fulfilled_at DESC)
  WHERE fulfilled_at IS NOT NULL;

