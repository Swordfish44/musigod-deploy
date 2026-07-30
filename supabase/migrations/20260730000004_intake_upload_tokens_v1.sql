-- supabase/migrations/20260730000004_intake_upload_tokens_v1.sql
--
-- Single-use, short-lived, hashed, artist-scoped, revocable intake tokens.
-- Used by: /api/upload-artist-document (document_upload tokens)
--          /api/sign-agreement          (agreement_sign tokens)
-- Issued by: /api/issue-intake-token (admin auth required)
--
-- Security properties enforced by this table:
--   - token_hash: raw token never stored; SHA-256(rawToken) stored instead
--   - used_at NOT NULL when consumed: single-use enforcement at DB level
--   - expires_at: short-lived (24h uploads, 72h signing)
--   - artist_email / engagement_id: scope enforcement
--   - revoked_at: revocable before use by operator
--   - RLS: service_role only; no artist-facing reads
--
-- After applying: NOTIFY pgrst, 'reload schema'; is included below.

CREATE TABLE registrations.intake_upload_tokens_v1 (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Hashed token. Raw token is returned once to the issuer and never persisted.
  token_hash          TEXT        UNIQUE NOT NULL,

  token_type          TEXT        NOT NULL
                        CHECK (token_type IN ('document_upload', 'agreement_sign')),

  -- Scope: artist identity
  artist_email        TEXT        NOT NULL,
  artist_id           UUID        REFERENCES registrations.artists_v1(id) ON DELETE SET NULL,

  -- Scope: specific intake engagement (optional; NULL = any engagement for this artist)
  engagement_id       TEXT,

  -- Lifecycle timestamps
  expires_at          TIMESTAMPTZ NOT NULL,
  used_at             TIMESTAMPTZ,           -- NULL = not yet used
  consumed_by         TEXT,                  -- which API route consumed the token
  revoked_at          TIMESTAMPTZ,           -- NULL = active
  revoked_by          TEXT,
  revocation_reason   TEXT,

  -- Audit provenance
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          TEXT        NOT NULL,  -- operator ID or 'system'
  audit_note          TEXT        NOT NULL DEFAULT ''
);

-- Fast lookup by hash (used on every token verification)
CREATE UNIQUE INDEX intake_upload_tokens_hash_idx
  ON registrations.intake_upload_tokens_v1 (token_hash);

-- Partial index: active tokens per artist (for duplicate-issuance checks)
CREATE INDEX intake_upload_tokens_active_artist_idx
  ON registrations.intake_upload_tokens_v1 (artist_email, token_type, expires_at)
  WHERE revoked_at IS NULL AND used_at IS NULL;

COMMENT ON TABLE registrations.intake_upload_tokens_v1 IS
  'Single-use short-lived intake tokens for document upload and agreement signing. '
  'Raw tokens are never stored — only their SHA-256 hash. '
  'All issuance and consumption are recorded here as the audit trail.';

COMMENT ON COLUMN registrations.intake_upload_tokens_v1.token_hash IS
  'SHA-256(rawToken) in lowercase hex. The raw token is returned to the issuer once and never stored.';

COMMENT ON COLUMN registrations.intake_upload_tokens_v1.used_at IS
  'Set by the consuming API route the first time a valid token is presented. '
  'Any subsequent presentation is rejected (single-use enforcement).';

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Deny by default; service_role has full access; no artist-facing read policy.

ALTER TABLE registrations.intake_upload_tokens_v1 ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all"
  ON registrations.intake_upload_tokens_v1
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── Schema cache reload ───────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
