'use strict';

const crypto = require('crypto');

const TRANSPORTS = new Set(['api', 'sftp', 'ddex', 'cwr', 'csv', 'xlsx', 'pdf', 'manual']);
const RECORD_TYPES = new Set(['recording', 'composition', 'party', 'right', 'usage', 'royalty', 'payment', 'registration', 'agreement']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : canonicalJson(value));
  return crypto.createHash('sha256').update(body).digest('hex');
}

function cleanIdentifier(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
}

function normalizeEnterpriseRecord(recordType, row, context = {}) {
  if (!RECORD_TYPES.has(recordType)) throw new Error(`Unsupported record_type: ${recordType}`);
  const input = row && typeof row === 'object' ? row : {};
  const normalized = { ...input };
  if ('isrc' in normalized) normalized.isrc = cleanIdentifier(normalized.isrc);
  if ('iswc' in normalized) normalized.iswc = cleanIdentifier(normalized.iswc);
  if ('title' in normalized) normalized.title = String(normalized.title || '').trim() || null;
  if ('territory' in normalized) normalized.territory = String(normalized.territory || '').trim().toUpperCase() || null;
  return {
    record_type: recordType,
    normalized_payload: normalized,
    provenance: {
      source_name: context.source_name || null,
      source_record_id: context.source_record_id || null,
      imported_at: context.imported_at || new Date().toISOString(),
      input_sha256: sha256(input),
      transform_version: 'enterprise-ingestion-v1',
    },
  };
}

function validateImportManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return { valid: false, errors: ['manifest is required'] };
  if (!manifest.organization_id) errors.push('organization_id is required');
  if (!manifest.source_name) errors.push('source_name is required');
  if (!TRANSPORTS.has(manifest.transport)) errors.push('transport is unsupported');
  if (!manifest.content_sha256 || !/^[a-f0-9]{64}$/.test(manifest.content_sha256)) errors.push('content_sha256 must be lowercase SHA-256');
  if (manifest.period_start && manifest.period_end && manifest.period_end < manifest.period_start) errors.push('period_end precedes period_start');
  return { valid: errors.length === 0, errors };
}

module.exports = { TRANSPORTS, RECORD_TYPES, canonicalJson, sha256, cleanIdentifier, normalizeEnterpriseRecord, validateImportManifest };
