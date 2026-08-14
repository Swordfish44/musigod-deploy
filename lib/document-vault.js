'use strict';
// lib/document-vault.js
// Secure document vault layer.
// Wraps Supabase Storage with SHA-256 hashing, duplicate detection, quarantine,
// signed URL validation, and access audit trail helpers.
// Documents must never be accessible from predictable public URLs.
// Network calls are isolated in methods prefixed with _ — tests mock those.

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
  'image/png',
  'image/jpeg',
]);

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.csv', '.xlsx', '.xls', '.png', '.jpg', '.jpeg']);

const BLOCKED_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'application/javascript',
  'text/javascript',
  'application/x-msdownload',
  'application/x-sh',
  'application/x-bat',
  'application/x-executable',
]);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB — matches existing upload limit

const QUARANTINE_REASONS = {
  BLOCKED_MIME: 'BLOCKED_MIME_TYPE',
  DISALLOWED_EXTENSION: 'DISALLOWED_EXTENSION',
  MIME_EXTENSION_MISMATCH: 'MIME_EXTENSION_MISMATCH',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  DUPLICATE_HASH: 'DUPLICATE_HASH',
  SENSITIVE_DATA_DETECTED: 'SENSITIVE_DATA_DETECTED',
  MALFORMED_OR_CORRUPT: 'MALFORMED_OR_CORRUPT',
  ENCRYPTED_UNREADABLE: 'ENCRYPTED_UNREADABLE',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
};

const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes — short-lived per phase 6 requirements

const PRIVATE_BUCKET = 'artist-documents'; // existing bucket — must be private

// MIME type → valid extensions
const MIME_TO_EXT = {
  'application/pdf': ['.pdf'],
  'text/csv': ['.csv'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-excel': ['.xls', '.xlsx'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
};

function computeSha256(buffer) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function getExtension(filename) {
  if (!filename) return null;
  const parts = filename.split('.');
  if (parts.length < 2) return null;
  return '.' + parts.pop().toLowerCase();
}

function validateFileMetadata({ originalName, mimeType, sizeBytes }) {
  const errors = [];

  if (typeof sizeBytes === 'number' && sizeBytes > MAX_FILE_SIZE_BYTES) {
    errors.push({
      code: QUARANTINE_REASONS.FILE_TOO_LARGE,
      detail: `File size ${sizeBytes} bytes exceeds limit of ${MAX_FILE_SIZE_BYTES} bytes`,
    });
  }

  if (mimeType) {
    if (BLOCKED_MIME_TYPES.has(mimeType)) {
      errors.push({ code: QUARANTINE_REASONS.BLOCKED_MIME, detail: `MIME type "${mimeType}" is blocked` });
    } else if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      errors.push({ code: QUARANTINE_REASONS.UNSUPPORTED_FORMAT, detail: `MIME type "${mimeType}" is not in the allowed list` });
    }
  }

  const ext = getExtension(originalName);
  if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
    errors.push({ code: QUARANTINE_REASONS.DISALLOWED_EXTENSION, detail: `Extension "${ext}" is not permitted` });
  }

  // MIME / extension consistency check
  if (mimeType && ext) {
    const validExts = MIME_TO_EXT[mimeType];
    if (validExts && !validExts.includes(ext)) {
      errors.push({
        code: QUARANTINE_REASONS.MIME_EXTENSION_MISMATCH,
        detail: `MIME "${mimeType}" does not match extension "${ext}"`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

function buildStoragePath(artistEmail, documentType, filename) {
  const normalizedEmail = artistEmail.toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
  const date = new Date().toISOString().split('T')[0];
  const ts = Date.now();
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return `${normalizedEmail}/${date}/${ts}-${documentType}-${safeFilename}`;
}

function buildVaultRecord({
  documentId,
  artistId,
  artistEmail,
  engagementId,
  documentType,
  originalName,
  mimeType,
  sizeBytes,
  sha256Hash,
  storagePath,
  bucket = PRIVATE_BUCKET,
  documentCategory,
  reportingPeriod = null,
  quarantined = false,
  quarantineReason = null,
}) {
  return {
    document_id: documentId,
    artist_id: artistId,
    artist_email: artistEmail,
    engagement_id: engagementId,
    document_type: documentType,
    original_name: originalName,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    sha256_hash: sha256Hash,
    storage_path: storagePath,
    bucket,
    document_category: documentCategory,
    reporting_period: reportingPeriod,
    quarantined,
    quarantine_reason: quarantineReason,
    retention_status: 'ACTIVE',
    legal_hold: false,
    uploaded_at: new Date().toISOString(),
    access_log: [],
  };
}

function logAccess(record, { actor, action, timestamp = null }) {
  const entry = { actor, action, timestamp: timestamp || new Date().toISOString() };
  return { ...record, access_log: [...(record.access_log || []), entry] };
}

function isDuplicateHash(sha256Hash, existingHashes) {
  return Array.isArray(existingHashes) && existingHashes.includes(sha256Hash);
}

function validateSignedUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, reason: 'No URL provided' };
  }
  if (!url.includes('token=') && !url.includes('expires=')) {
    return { valid: false, reason: 'No expiry token found — this may be a public URL, which is not permitted for private documents' };
  }
  return { valid: true };
}

function isPublicUrl(url) {
  if (!url) return false;
  return url.includes('/storage/v1/object/public/');
}

// Redact signed URLs and tokens from any string before logging
function redactUrl(url) {
  if (!url) return null;
  return url.replace(/token=[^&]+/g, 'token=[REDACTED]').replace(/expires=[^&]+/g, 'expires=[REDACTED]');
}

module.exports = {
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  BLOCKED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  QUARANTINE_REASONS,
  SIGNED_URL_TTL_SECONDS,
  PRIVATE_BUCKET,
  computeSha256,
  getExtension,
  validateFileMetadata,
  buildStoragePath,
  buildVaultRecord,
  logAccess,
  isDuplicateHash,
  validateSignedUrl,
  isPublicUrl,
  redactUrl,
};
