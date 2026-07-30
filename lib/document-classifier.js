'use strict';
// lib/document-classifier.js
// Source-neutral document classification pipeline.
// Deterministic parsers where possible.
// AI extraction proposals are advisory — must include model_version, prompt_version,
// and confidence. Low-confidence AI proposals route to human review.
// Pure functions — no DB access, no network calls.

const PROVIDERS = [
  'SOUNDEXCHANGE', 'PPL', 'GVL', 'ASCAP', 'BMI', 'SESAC',
  'DISTRIBUTOR_DISTROKID', 'DISTRIBUTOR_CDBABY', 'DISTRIBUTOR_TUNECORE', 'DISTRIBUTOR_AWAL',
  'DISTRIBUTOR_OTHER', 'LABEL', 'SELF', 'UNKNOWN',
];

const DOCUMENT_TYPES = [
  'CATALOG_EXPORT',
  'PAYMENT_STATEMENT',
  'ADJUSTMENT_REVERSAL',
  'UNCLAIMED_ROYALTIES',
  'OWNERSHIP_DECLARATION',
  'EXCLUSIVE_LICENSE',
  'LABEL_AGREEMENT',
  'DISTRIBUTOR_AGREEMENT',
  'SPLIT_SHEET',
  'MANDATE',
  'COPYRIGHT_REGISTRATION',
  'FEATURED_PERFORMER_DECLARATION',
  'UNKNOWN',
];

const CLASSIFIER_VERSION = 'document-classifier-v1';

// Filename keyword signals — heuristic, not authoritative
const FILENAME_SIGNALS = [
  { pattern: /soundexchange/i, provider: 'SOUNDEXCHANGE' },
  { pattern: /(?:^|[^a-z])ppl(?:[^a-z]|$)/i, provider: 'PPL' },
  { pattern: /(?:^|[^a-z])gvl(?:[^a-z]|$)/i, provider: 'GVL' },
  { pattern: /distrokid/i, provider: 'DISTRIBUTOR_DISTROKID' },
  { pattern: /cd.?baby/i, provider: 'DISTRIBUTOR_CDBABY' },
  { pattern: /tunecore/i, provider: 'DISTRIBUTOR_TUNECORE' },
  { pattern: /\bawal\b/i, provider: 'DISTRIBUTOR_AWAL' },
  { pattern: /(statement|royalt)/i, docType: 'PAYMENT_STATEMENT' },
  { pattern: /(catalog|catalogue|recordings|catalog_export)/i, docType: 'CATALOG_EXPORT' },
  { pattern: /(adjustment|reversal)/i, docType: 'ADJUSTMENT_REVERSAL' },
  { pattern: /(unclaimed|search.and.claim)/i, docType: 'UNCLAIMED_ROYALTIES' },
  { pattern: /mandate/i, docType: 'MANDATE' },
  { pattern: /split.sheet/i, docType: 'SPLIT_SHEET' },
  { pattern: /(exclusive.licen)/i, docType: 'EXCLUSIVE_LICENSE' },
  { pattern: /ownership/i, docType: 'OWNERSHIP_DECLARATION' },
];

function classifyByFilename(filename) {
  if (!filename) return { provider: 'UNKNOWN', docType: 'UNKNOWN', confidence: 0, method: 'filename_heuristic' };

  let provider = 'UNKNOWN';
  let docType = 'UNKNOWN';
  const matchedSignals = [];

  for (const sig of FILENAME_SIGNALS) {
    if (sig.pattern.test(filename)) {
      if (sig.provider) provider = sig.provider;
      if (sig.docType) docType = sig.docType;
      matchedSignals.push(sig.pattern.toString());
    }
  }

  const hasSignal = provider !== 'UNKNOWN' || docType !== 'UNKNOWN';
  return {
    provider,
    docType,
    confidence: hasSignal ? 0.4 : 0,
    matched_signals: matchedSignals,
    method: 'filename_heuristic',
  };
}

function classifyByHeaders(headers) {
  if (!Array.isArray(headers) || headers.length === 0) {
    return { provider: 'UNKNOWN', docType: 'UNKNOWN', confidence: 0, method: 'header_heuristic' };
  }

  const joined = headers.map(h => String(h).toLowerCase()).join(' ');

  // Quarantine: banking data in headers
  if (/routing_number|account_number/.test(joined)) {
    return {
      provider: 'UNKNOWN',
      docType: 'UNKNOWN',
      confidence: 0,
      quarantine: true,
      quarantineReason: 'Banking data detected in column headers',
      method: 'header_heuristic',
    };
  }

  let docType = 'UNKNOWN';
  let confidence = 0.1;

  if (/isrc/.test(joined) && /statement_period|period|quarter/.test(joined) && /royalt|gross/.test(joined)) {
    docType = 'PAYMENT_STATEMENT';
    confidence = 0.75;
  } else if (/isrc/.test(joined) && /title/.test(joined) && !/gross_royalt/.test(joined)) {
    docType = 'CATALOG_EXPORT';
    confidence = 0.65;
  } else if (/isrc/.test(joined) && /unclaimed/.test(joined)) {
    docType = 'UNCLAIMED_ROYALTIES';
    confidence = 0.7;
  } else if (/adjustment|reversal/.test(joined)) {
    docType = 'ADJUSTMENT_REVERSAL';
    confidence = 0.65;
  }

  return { provider: 'UNKNOWN', docType, confidence, method: 'header_heuristic' };
}

function buildClassification({ filename, mimeType, headers = [], manualOverride = {}, aiProposal = null }) {
  const fileClass = classifyByFilename(filename || '');
  const headerClass = headers.length > 0 ? classifyByHeaders(headers) : null;

  if (headerClass && headerClass.quarantine) {
    return {
      provider: 'UNKNOWN',
      doc_type: 'UNKNOWN',
      confidence: 0,
      mime_type: mimeType || null,
      quarantine: true,
      quarantine_reason: headerClass.quarantineReason,
      needs_review: true,
      signals: { filename: fileClass, headers: headerClass, manual_override: null },
      classified_at: new Date().toISOString(),
      classifier_version: CLASSIFIER_VERSION,
    };
  }

  const provider = manualOverride.provider ||
    (headerClass && headerClass.provider !== 'UNKNOWN' ? headerClass.provider : null) ||
    (fileClass.provider !== 'UNKNOWN' ? fileClass.provider : 'UNKNOWN');

  const docType = manualOverride.docType ||
    (headerClass && headerClass.docType !== 'UNKNOWN' ? headerClass.docType : null) ||
    (fileClass.docType !== 'UNKNOWN' ? fileClass.docType : 'UNKNOWN');

  const confidence = manualOverride.provider
    ? 1.0
    : (headerClass && headerClass.docType !== 'UNKNOWN' ? headerClass.confidence : fileClass.confidence);

  const result = {
    provider,
    doc_type: docType,
    confidence,
    mime_type: mimeType || null,
    quarantine: false,
    quarantine_reason: null,
    needs_review: confidence < 0.7 || provider === 'UNKNOWN' || docType === 'UNKNOWN',
    signals: {
      filename: fileClass,
      headers: headerClass,
      manual_override: Object.keys(manualOverride).length > 0 ? manualOverride : null,
    },
    classified_at: new Date().toISOString(),
    classifier_version: CLASSIFIER_VERSION,
  };

  if (aiProposal) {
    if (!aiProposal.model_version || !aiProposal.prompt_version || typeof aiProposal.confidence !== 'number') {
      result.ai_proposal_rejected = true;
      result.ai_proposal_rejection_reason =
        'AI proposal missing required fields: model_version, prompt_version, and/or confidence';
    } else if (aiProposal.confidence < 0.85) {
      result.ai_proposal = { ...aiProposal };
      result.ai_proposal_note = 'Low-confidence AI proposal — requires human review before use';
      result.needs_review = true;
    } else {
      result.ai_proposal = { ...aiProposal };
    }
  }

  return result;
}

module.exports = {
  PROVIDERS,
  DOCUMENT_TYPES,
  CLASSIFIER_VERSION,
  FILENAME_SIGNALS,
  classifyByFilename,
  classifyByHeaders,
  buildClassification,
};
