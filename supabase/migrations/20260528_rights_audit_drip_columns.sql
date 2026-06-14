-- Migration: add drip email tracking columns to rights_audits_v1
-- Idempotent — safe to run multiple times

ALTER TABLE public.rights_audits_v1
  ADD COLUMN IF NOT EXISTS day2_email_sent_at  TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS day4_email_sent_at  TIMESTAMPTZ DEFAULT NULL;

-- Index for efficient cron query
CREATE INDEX IF NOT EXISTS idx_rights_audits_drip
  ON public.rights_audits_v1 (paid_status, paid_at)
  WHERE paid_status = 'PAID';

COMMENT ON COLUMN public.rights_audits_v1.day2_email_sent_at IS 'Timestamp when Day 2 in-progress drip email was sent';
COMMENT ON COLUMN public.rights_audits_v1.day4_email_sent_at IS 'Timestamp when Day 4 findings-almost-ready drip email was sent';
