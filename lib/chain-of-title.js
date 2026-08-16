'use strict';

function dateValue(value) { return value ? new Date(value).getTime() : Number.MAX_SAFE_INTEGER; }

function assembleTitleTimeline(documents) {
  return (Array.isArray(documents) ? documents : []).map(doc => ({
    document_id: doc.id || null,
    document_reference: doc.document_reference,
    document_type: doc.document_type,
    effective_date: doc.effective_date || null,
    parties: doc.parties || [],
    rights_summary: doc.rights_summary || {},
    territories: doc.territories || [],
    extraction_status: doc.extraction_status || 'unreviewed',
  })).sort((a, b) => dateValue(a.effective_date) - dateValue(b.effective_date));
}

function analyzeTitleDocuments(documents) {
  const timeline = assembleTitleTimeline(documents);
  const findings = [];
  timeline.forEach(doc => {
    if (!doc.effective_date) findings.push(finding('missing_evidence', `Effective date missing for ${doc.document_reference}`, [doc.document_id], 1));
    if (!Array.isArray(doc.parties) || doc.parties.length < 2) findings.push(finding('missing_evidence', `Complete party information missing for ${doc.document_reference}`, [doc.document_id], 1));
    if (doc.extraction_status !== 'human_verified') findings.push(finding('system_inference', `Extracted terms require human verification for ${doc.document_reference}`, [doc.document_id], 0.5));
    const share = Number(doc.rights_summary?.share_percent);
    if (Number.isFinite(share) && (share < 0 || share > 100)) findings.push(finding('data_conflict', `Invalid conveyed share in ${doc.document_reference}`, [doc.document_id], 1));
  });
  if (!timeline.some(doc => ['acquisition_agreement', 'assignment'].includes(doc.document_type))) {
    findings.push(finding('legal_determination_required', 'No acquisition agreement or assignment establishes the ownership transfer', timeline.map(d => d.document_id), 1));
  }
  return { timeline, findings, final_ownership_determination: null, requires_legal_review: findings.some(f => ['data_conflict', 'legal_determination_required'].includes(f.finding_type)) };
}

function finding(finding_type, summary, source_document_ids, confidence) {
  return { finding_type, summary, source_document_ids: source_document_ids.filter(Boolean), confidence, legal_effect: false, review_status: 'open' };
}

function validateLegalDetermination(result, reviewer) {
  if (!reviewer?.user_id || reviewer.role !== 'legal_reviewer') throw new Error('authorized legal reviewer is required');
  if (!reviewer.determination) throw new Error('legal determination is required');
  return { ...result, final_ownership_determination: reviewer.determination, legal_review: { reviewed_by: reviewer.user_id, reviewed_at: reviewer.reviewed_at || new Date().toISOString() } };
}

module.exports = { assembleTitleTimeline, analyzeTitleDocuments, validateLegalDetermination };
