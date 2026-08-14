'use strict';
// lib/intake-tokens.js
// DB-stored, single-use, hashed, artist-scoped, revocable intake tokens.
// Zero DB calls — pure crypto and record-building functions only.
// Callers (API routes) are responsible for all Supabase reads/writes.
//
// Lifecycle:
//   1. Operator calls /api/issue-intake-token (admin auth required).
//   2. Raw token is returned ONCE to the operator and embedded in a secure portal URL.
//      It is never stored anywhere — only its SHA-256 hash is written to the DB.
//   3. Artist presents the raw token in the x-intake-token header when uploading
//      a document or signing an agreement.
//   4. API route: hash the raw token, query DB by hash, call verifyToken().
//   5. API route: if valid, call buildConsumptionUpdate() and PATCH the DB row
//      (marks used_at — single-use enforcement).
//   6. All issuance and consumption are logged in the audit trail via the DB record.
//
// DB table: registrations.intake_upload_tokens_v1
// See: supabase/migrations/20260730000004_intake_upload_tokens_v1.sql

const crypto = require('crypto');

const TOKEN_TYPES = {
  DOCUMENT_UPLOAD: 'document_upload',
  AGREEMENT_SIGN:  'agreement_sign',
};

// TTL in seconds for each token type
const TOKEN_TTL = {
  document_upload: 24 * 60 * 60,   // 24 hours
  agreement_sign:  72 * 60 * 60,   // 72 hours
};

// Generate a cryptographically random raw token.
// 32 random bytes → base64url (43 characters, no padding).
// Raw token is returned to caller ONCE and must never be stored by the caller.
function generateRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Hash a raw token for DB storage. SHA-256, lowercase hex.
// This is the only representation stored in the DB.
function hashToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new Error('hashToken: rawToken must be a non-empty string');
  }
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Build the DB record to INSERT when issuing a new token.
// Returns a plain object — caller writes it to intake_upload_tokens_v1.
function buildTokenRecord({
  rawToken,
  tokenType,
  artistEmail,
  artistId = null,
  engagementId = null,
  createdBy,
  auditNote = '',
}) {
  const validTypes = Object.values(TOKEN_TYPES);
  const normalizedType = validTypes.includes(tokenType) ? tokenType : null;
  if (!normalizedType) {
    throw new Error(`buildTokenRecord: unknown tokenType "${tokenType}". Valid: ${validTypes.join(', ')}`);
  }
  if (!rawToken) throw new Error('buildTokenRecord: rawToken is required');
  if (!artistEmail) throw new Error('buildTokenRecord: artistEmail is required');
  if (!createdBy) throw new Error('buildTokenRecord: createdBy is required');

  const ttl = TOKEN_TTL[normalizedType];
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  return {
    token_hash:    hashToken(rawToken),
    token_type:    normalizedType,
    artist_email:  artistEmail.toLowerCase().trim(),
    artist_id:     artistId || null,
    engagement_id: engagementId || null,
    expires_at:    expiresAt,
    used_at:       null,
    consumed_by:   null,
    revoked_at:    null,
    revoked_by:    null,
    revocation_reason: null,
    created_at:    new Date().toISOString(),
    created_by:    String(createdBy),
    audit_note:    String(auditNote),
  };
}

// Verify a raw token against a DB record fetched by hash.
// Pure logic — does not query the DB.
//
// options:
//   artistEmail   — must match token's artist_email (case-insensitive)
//   tokenType     — must match token's token_type
//   engagementId  — if provided and token is scoped, must match
//
// Returns { valid: boolean, reason: string }
function verifyToken(rawToken, record, { artistEmail, tokenType, engagementId = null } = {}) {
  if (!rawToken) return { valid: false, reason: 'No token provided' };
  if (!record)   return { valid: false, reason: 'Token not found' };

  // Re-hash to confirm the DB record matches (defends against hash collision tricks)
  let computedHash;
  try { computedHash = hashToken(rawToken); } catch { return { valid: false, reason: 'Token format invalid' }; }
  if (computedHash !== record.token_hash) {
    return { valid: false, reason: 'Token hash mismatch' };
  }

  if (record.revoked_at) return { valid: false, reason: 'Token has been revoked' };
  if (record.used_at)    return { valid: false, reason: 'Token has already been used' };

  if (new Date() > new Date(record.expires_at)) {
    return { valid: false, reason: 'Token has expired' };
  }

  if (tokenType && record.token_type !== tokenType) {
    return { valid: false, reason: `Token type mismatch: expected "${tokenType}", got "${record.token_type}"` };
  }

  if (artistEmail && record.artist_email !== artistEmail.toLowerCase().trim()) {
    return { valid: false, reason: 'Token is not scoped to this artist' };
  }

  if (engagementId && record.engagement_id && record.engagement_id !== engagementId) {
    return { valid: false, reason: 'Token is not scoped to this engagement' };
  }

  return { valid: true, reason: 'OK' };
}

// Build the PATCH body to mark a token consumed (single-use enforcement).
// Caller applies this to the DB row immediately after verifyToken() returns valid.
function buildConsumptionUpdate(consumedBy) {
  return {
    used_at:     new Date().toISOString(),
    consumed_by: String(consumedBy || 'api'),
  };
}

// Build the PATCH body to revoke a token before use.
// Caller: operator route or revocation flow.
function buildRevocationUpdate(revokedBy, reason = '') {
  if (!revokedBy) throw new Error('buildRevocationUpdate: revokedBy is required');
  return {
    revoked_at:         new Date().toISOString(),
    revoked_by:         String(revokedBy),
    revocation_reason:  String(reason),
  };
}

module.exports = {
  TOKEN_TYPES,
  TOKEN_TTL,
  generateRawToken,
  hashToken,
  buildTokenRecord,
  verifyToken,
  buildConsumptionUpdate,
  buildRevocationUpdate,
};
