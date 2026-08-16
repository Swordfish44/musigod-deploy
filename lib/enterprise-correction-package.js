'use strict';

const { canonicalJson, sha256 } = require('./enterprise-ingestion');

function validateCorrectionPayload(spec, records, evidence = []) {
  const errors = [];
  const warnings = [];
  if (!spec || spec.status !== 'verified') errors.push('a verified destination specification is required');
  if (!Array.isArray(records) || records.length === 0) errors.push('at least one correction record is required');
  const required = Array.isArray(spec?.required_fields) ? spec.required_fields : [];
  (records || []).forEach((record, index) => {
    required.forEach(field => {
      if (record?.[field] === null || record?.[field] === undefined || record?.[field] === '') errors.push(`row ${index + 1}: ${field} is required`);
    });
  });
  const requiredEvidence = Array.isArray(spec?.evidence_requirements) ? spec.evidence_requirements : [];
  requiredEvidence.forEach(type => {
    if (!evidence.some(item => item?.type === type)) warnings.push(`evidence missing: ${type}`);
  });
  return { valid: errors.length === 0, errors, warnings };
}

function buildCorrectionPackage(spec, records, evidence = [], metadata = {}) {
  const validation = validateCorrectionPayload(spec, records, evidence);
  const payload = {
    schema: 'musigod-enterprise-correction-v1',
    destination: spec?.destination || null,
    submission_type: spec?.submission_type || null,
    specification_version: spec?.version || null,
    records: records || [],
    metadata,
  };
  return {
    status: validation.valid ? 'ready_for_review' : 'validation_failed',
    payload,
    payload_sha256: sha256(canonicalJson(payload)),
    evidence_manifest: evidence,
    validation_results: [...validation.errors.map(message => ({ severity: 'error', message })), ...validation.warnings.map(message => ({ severity: 'warning', message }))],
    requires_human_approval: true,
  };
}

function approveCorrectionPackage(pkg, reviewer) {
  if (pkg?.status !== 'ready_for_review') throw new Error('package must pass validation before approval');
  if (!reviewer?.user_id) throw new Error('reviewer user_id is required');
  return { ...pkg, status: 'approved', approved_by: reviewer.user_id, approved_at: reviewer.reviewed_at || new Date().toISOString() };
}

module.exports = { validateCorrectionPayload, buildCorrectionPackage, approveCorrectionPackage };
