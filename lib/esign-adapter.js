'use strict';
// lib/esign-adapter.js
// Provider-neutral e-signature adapter.
// Default and only active provider: MOCK. No paid vendor activated without approval.
// All engagement and authorization language is DRAFT — requires attorney review
// before production activation. Production is blocked until legal approval is recorded.

const PROVIDERS = {
  MOCK: 'MOCK',
  // Future: DOCUSIGN, HELLOSIGN, PANDADOC — add only after vendor approval
};

const ENVELOPE_STATUS = {
  CREATED: 'CREATED',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  SIGNED: 'SIGNED',
  COMPLETED: 'COMPLETED',
  DECLINED: 'DECLINED',
  VOIDED: 'VOIDED',
  EXPIRED: 'EXPIRED',
};

const DOC_TYPES = {
  ENGAGEMENT_AGREEMENT: 'ENGAGEMENT_AGREEMENT',
  LOA: 'LOA',
};

const LEGAL_REVIEW_PLACEHOLDER =
  '[DRAFT — ATTORNEY REVIEW REQUIRED BEFORE PRODUCTION ACTIVATION]';

// Scope values that LOA must never silently authorize
const LOA_PROHIBITED_SCOPES = [
  'rights_assignment',
  'copyright_transfer',
  'payment_diversion',
  'banking_change',
  'tax_election',
  'broad_power_of_attorney',
  'dispute_settlement',
];

const WEBHOOK_EVENTS = [
  'envelope.created',
  'envelope.sent',
  'envelope.delivered',
  'envelope.completed',
  'envelope.declined',
  'envelope.voided',
  'envelope.expired',
  'recipient.signed',
  'recipient.declined',
  'recipient.authentication_failed',
];

// In-memory store for mock envelopes — no persistence across process restarts
const _mockStore = new Map();

function _generateEnvelopeId() {
  return `mock-env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function _computeDocumentHash(documentType, documentVersion, artistId) {
  try {
    const crypto = require('crypto');
    return crypto.createHash('sha256')
      .update(`${documentType}:${documentVersion}:${artistId}`)
      .digest('hex');
  } catch {
    // fallback stub for environments without crypto
    const s = `${documentType}:${documentVersion}:${artistId}`;
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
    return `sha256-stub-${Math.abs(h).toString(16).padStart(8, '0')}`;
  }
}

class MockESignProvider {
  createEnvelope({ documentType, documentVersion, artistId, signerEmail, signerName, correlationId }) {
    if (!DOC_TYPES[documentType]) throw new Error(`Unknown documentType: ${documentType}`);
    if (!artistId) throw new Error('artistId required');
    if (!signerEmail) throw new Error('signerEmail required');
    if (!correlationId) throw new Error('correlationId required');

    const envelopeId = _generateEnvelopeId();
    const now = new Date().toISOString();

    const envelope = {
      envelope_id: envelopeId,
      provider: PROVIDERS.MOCK,
      document_type: documentType,
      document_version: documentVersion || 'v1',
      document_hash: _computeDocumentHash(documentType, documentVersion || 'v1', artistId),
      artist_id: artistId,
      signer_email: signerEmail,
      signer_name: signerName || '',
      status: ENVELOPE_STATUS.CREATED,
      correlation_id: correlationId,
      created_at: now,
      updated_at: now,
      signed_at: null,
      expiry_at: null,
      completion_certificate: null,
      legal_review_required: true,
      legal_review_note: LEGAL_REVIEW_PLACEHOLDER,
      production_blocked: true,
    };

    _mockStore.set(envelopeId, envelope);
    return { ...envelope };
  }

  sendEnvelope(envelopeId) {
    const env = _mockStore.get(envelopeId);
    if (!env) throw new Error(`Envelope not found: ${envelopeId}`);
    if (env.status !== ENVELOPE_STATUS.CREATED) {
      throw new Error(`Cannot send envelope in status ${env.status}`);
    }
    env.status = ENVELOPE_STATUS.SENT;
    env.updated_at = new Date().toISOString();
    return { ...env };
  }

  getEnvelope(envelopeId) {
    const env = _mockStore.get(envelopeId);
    if (!env) return null;
    return { ...env };
  }

  voidEnvelope(envelopeId, reason) {
    const env = _mockStore.get(envelopeId);
    if (!env) throw new Error(`Envelope not found: ${envelopeId}`);
    if (env.status === ENVELOPE_STATUS.COMPLETED || env.status === ENVELOPE_STATUS.VOIDED) {
      throw new Error(`Cannot void envelope in terminal status ${env.status}`);
    }
    env.status = ENVELOPE_STATUS.VOIDED;
    env.void_reason = reason || 'voided by operator';
    env.updated_at = new Date().toISOString();
    return { ...env };
  }

  expireEnvelope(envelopeId) {
    const env = _mockStore.get(envelopeId);
    if (!env) throw new Error(`Envelope not found: ${envelopeId}`);
    if (env.status === ENVELOPE_STATUS.COMPLETED) {
      throw new Error('Cannot expire a completed envelope');
    }
    env.status = ENVELOPE_STATUS.EXPIRED;
    env.expiry_at = new Date().toISOString();
    env.updated_at = new Date().toISOString();
    return { ...env };
  }

  // Simulate signing — only for mock/test use. Not callable in production.
  _simulateSigning(envelopeId, { signerEmail, signerName }) {
    const env = _mockStore.get(envelopeId);
    if (!env) throw new Error(`Envelope not found: ${envelopeId}`);
    if (env.status === ENVELOPE_STATUS.EXPIRED) {
      throw new Error(`Cannot sign an expired envelope (${envelopeId})`);
    }
    if (env.status !== ENVELOPE_STATUS.SENT && env.status !== ENVELOPE_STATUS.DELIVERED) {
      throw new Error(`Cannot sign envelope in status ${env.status}`);
    }
    if (env.signer_email.toLowerCase() !== signerEmail.toLowerCase()) {
      throw new Error(`Wrong signer: envelope is addressed to ${env.signer_email}, got ${signerEmail}`);
    }
    const now = new Date().toISOString();
    env.status = ENVELOPE_STATUS.COMPLETED;
    env.signed_at = now;
    env.updated_at = now;
    env.completion_certificate = {
      certificate_id: `cert-${envelopeId}`,
      signer_email: signerEmail,
      signer_name: signerName || env.signer_name,
      document_hash: env.document_hash,
      signed_at: now,
      provider: PROVIDERS.MOCK,
    };
    return { ...env };
  }

  processWebhook(payload, { signature = null, secret = null, seenIds = new Set() } = {}) {
    const { envelope_id, event_type } = payload || {};

    if (!envelope_id || !event_type) {
      return { accepted: false, reason: 'Missing envelope_id or event_type' };
    }
    if (!WEBHOOK_EVENTS.includes(event_type)) {
      return { accepted: false, reason: `Unknown event type: ${event_type}` };
    }

    // Idempotency: reject duplicate delivery
    const deliveryKey = `${envelope_id}:${event_type}`;
    if (seenIds.has(deliveryKey)) {
      return { accepted: true, idempotent: true, reason: 'Duplicate webhook delivery — ignored' };
    }

    const env = _mockStore.get(envelope_id);
    if (!env) {
      return { accepted: false, reason: `Envelope not found: ${envelope_id}` };
    }

    // Mark seen
    seenIds.add(deliveryKey);

    return { accepted: true, idempotent: false, envelope: { ...env }, event_type };
  }

  _clearStore() {
    _mockStore.clear();
  }
}

const _mockProvider = new MockESignProvider();

function getProvider(options = {}) {
  const env = options.env || process.env;
  const explicitProvider = options.mock ? PROVIDERS.MOCK : (env.ESIGN_PROVIDER || PROVIDERS.MOCK);
  if (!PROVIDERS[explicitProvider]) {
    throw new Error(`ESIGN_PROVIDER "${explicitProvider}" is not implemented. Use MOCK or obtain vendor approval first.`);
  }
  return _mockProvider;
}

function validateLOAScope(scopeArray) {
  if (!Array.isArray(scopeArray)) throw new Error('LOA scope must be an array');
  const errors = [];
  for (const scope of scopeArray) {
    if (LOA_PROHIBITED_SCOPES.includes(scope)) {
      errors.push(
        `Prohibited LOA scope: "${scope}". This scope requires attorney approval and explicit client authorization — it cannot be included in a standard limited LOA.`
      );
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  PROVIDERS,
  ENVELOPE_STATUS,
  DOC_TYPES,
  WEBHOOK_EVENTS,
  LOA_PROHIBITED_SCOPES,
  LEGAL_REVIEW_PLACEHOLDER,
  getProvider,
  validateLOAScope,
  MockESignProvider,
};
