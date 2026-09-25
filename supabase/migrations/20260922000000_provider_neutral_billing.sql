-- Provider-neutral subscription records. Existing Stripe columns and flows remain unchanged.

CREATE TABLE IF NOT EXISTS registrations.payment_accounts_v1 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'paypal', 'authorize_net', 'manual_ach')),
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  plan_code TEXT NOT NULL,
  status TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subscription_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_accounts_v1_primary_artist_idx
  ON registrations.payment_accounts_v1 (artist_id)
  WHERE is_primary;

CREATE INDEX IF NOT EXISTS payment_accounts_v1_artist_idx
  ON registrations.payment_accounts_v1 (artist_id, provider, status);

CREATE TABLE IF NOT EXISTS registrations.payment_event_receipts_v1 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  artist_id UUID,
  occurred_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (provider, provider_event_id)
);

ALTER TABLE registrations.payment_accounts_v1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations.payment_event_receipts_v1 ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON registrations.payment_accounts_v1 FROM anon, authenticated;
REVOKE ALL ON registrations.payment_event_receipts_v1 FROM anon, authenticated;
GRANT ALL ON registrations.payment_accounts_v1 TO service_role;
GRANT ALL ON registrations.payment_event_receipts_v1 TO service_role;

COMMENT ON TABLE registrations.payment_accounts_v1 IS
  'Provider-neutral subscription system of record; service-role only.';
COMMENT ON TABLE registrations.payment_event_receipts_v1 IS
  'Idempotency ledger for verified payment-provider webhooks; service-role only.';
