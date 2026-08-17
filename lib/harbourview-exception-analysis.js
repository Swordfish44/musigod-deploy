'use strict';

const crypto = require('crypto');
const SUPPORTED_ASSET_TYPES = new Set(['recording', 'composition']);
const clean = value => String(value || '').trim();
const issue = (finding_type, summary) => ({ finding_type, summary, confidence: 1, legal_effect: false, review_status: 'open', source_document_ids: [] });

function recordReference(record, index) {
  return clean(record.source_record_id) || `ROW-${index + 1}-${crypto.createHash('sha256').update(JSON.stringify(record.normalized_payload || {})).digest('hex').slice(0, 12).toUpperCase()}`;
}

function analyzeRecords(records = [], context = {}) {
  const assets = [], findings = [], identifiers = new Map();
  records.forEach((record, index) => {
    if (!SUPPORTED_ASSET_TYPES.has(record.record_type)) return;
    const payload = record.normalized_payload || {}, asset_reference = recordReference(record, index);
    const title = clean(payload.title);
    const identifierName = record.record_type === 'recording' ? 'ISRC' : 'ISWC';
    const identifier = clean(payload[identifierName.toLowerCase()]).toUpperCase();
    const issues = [];
    if (!title) issues.push(issue('missing_evidence', 'Title is missing from the authorized source row.'));
    if (!identifier) issues.push(issue('missing_evidence', `${identifierName} is missing from the authorized source row.`));
    if (record.record_type === 'recording' && !clean(payload.artist)) issues.push(issue('missing_evidence', 'Recording artist identity is missing from the authorized source row.'));
    if (!clean(payload.territory)) issues.push(issue('missing_evidence', 'Territory is missing from the authorized source row.'));
    if (identifier) {
      const key = `${record.record_type}:${identifier}`;
      if (identifiers.has(key)) {
        issues.push(issue('data_conflict', `${identifier} appears on more than one row in this import.`));
        findings.push({ ...issue('data_conflict', `${identifier} appears on more than one row in this import.`), asset_reference: identifiers.get(key) });
      } else identifiers.set(key, asset_reference);
    }
    assets.push({ organization_id: context.organization_id, workspace_id: context.workspace_id, catalog_id: context.catalog_id,
      asset_reference, asset_type: record.record_type, title: title || `[Untitled source row ${index + 1}]`,
      isrc: record.record_type === 'recording' && identifier ? identifier : null,
      iswc: record.record_type === 'composition' && identifier ? identifier : null,
      review_status: issues.length ? 'review_required' : 'unreviewed',
      provenance: { ...record.provenance, batch_id: context.batch_id, row_number: index + 1 } });
    findings.push(...issues.map(value => ({ ...value, asset_reference })));
  });
  return { assets, findings, analyzed_count: assets.length, exception_count: findings.length };
}

function validateFindingResolution(input = {}, finding, reviewer) {
  if (!finding || !['open', 'human_validated'].includes(finding.review_status)) throw new Error('an open finding is required');
  if (!reviewer || !reviewer.active || !['reviewer', 'administrator', 'legal'].includes(reviewer.role)) throw new Error('an active qualified reviewer is required');
  if (!['human_validated', 'rejected', 'resolved'].includes(input.decision)) throw new Error('finding decision is unsupported');
  const resolution_notes = clean(input.resolution_notes);
  if (resolution_notes.length < 12) throw new Error('resolution notes must contain at least 12 characters');
  return { decision: input.decision, resolution_notes };
}

module.exports = { SUPPORTED_ASSET_TYPES, analyzeRecords, validateFindingResolution };
