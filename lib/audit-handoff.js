'use strict';
// lib/audit-handoff.js
// Immutable intake manifest generator for handoff to the neighboring-rights audit pipeline.
// Documents are referenced by ID and hash — never duplicated in the manifest.
// Private statement data stays on the CSV import path (neighboring-rights-audit.js),
// separate from the SoundExchange repertoire-search adapter.
// createManifest() requires dryRun: true — production handoff requires human approval.

function createManifest({
  engagementId,
  artistId,
  artistEmail,
  intakeState,
  documentsReceived,
  completenessReport,
  identityRecord,
  envelopeIds,
  catalogBaseline,
  dryRun,
}) {
  if (dryRun !== true) {
    throw new Error(
      'createManifest() requires dryRun: true — production handoff requires explicit human approval. ' +
      'Do not pass dryRun: false without a separate authorized action.'
    );
  }

  if (intakeState !== 'AUDIT_READY') {
    throw new Error(
      `Cannot create audit manifest: intake state is "${intakeState}", expected "AUDIT_READY". ` +
      `Resolve all completeness blockers before handoff.`
    );
  }

  const frozenAt = new Date().toISOString();
  const manifestId = `manifest-${engagementId}-${Date.now()}`;

  // Document summary — references only. Never include document content or signed URLs.
  const documentSummary = (documentsReceived || []).map(doc => ({
    document_id: doc.document_id,
    document_type: doc.document_type,
    sha256_hash: doc.sha256_hash,
    document_category: doc.document_category,
    reporting_period: doc.reporting_period || null,
    quarantined: Boolean(doc.quarantined),
    uploaded_at: doc.uploaded_at,
    // storage_path excluded — no path hints in manifest
  }));

  // Completeness summary — exclude dynamic computed_at, keep structural fields
  const safeCompleteness = {
    audit_ready: completenessReport.audit_ready,
    mandatory_passed: completenessReport.mandatory_passed,
    mandatory_total: completenessReport.mandatory_total,
    progress_percent: completenessReport.progress_percent,
    blockers: completenessReport.blockers,
    engine_version: completenessReport.engine_version,
  };

  // Catalog baseline — structural counts only, no track names or artist identifiers
  const safeCatalogBaseline = catalogBaseline ? {
    total_tracks: catalogBaseline.total_tracks,
    tracks_with_isrc: catalogBaseline.tracks_with_isrc,
    tracks_missing_isrc: catalogBaseline.tracks_missing_isrc,
    tracks_missing_writers: catalogBaseline.tracks_missing_writers,
  } : null;

  return {
    manifest_id: manifestId,
    engagement_id: engagementId,
    artist_id: artistId,
    artist_email_hash: _hashEmail(artistEmail), // hash only — plain email excluded from manifest
    intake_state_at_handoff: intakeState,
    frozen_at: frozenAt,
    dry_run: true,
    document_count: documentSummary.length,
    documents: documentSummary,
    envelope_ids: envelopeIds || [],
    completeness: safeCompleteness,
    identity_confirmed: Boolean(identityRecord),
    catalog_baseline: safeCatalogBaseline,
    audit_pipeline: 'lib/neighboring-rights-audit.js',
    statement_data_path: 'CSV import only — private statement data never routes through SoundExchange adapter API',
    manifest_version: 'audit-handoff-v1',
    immutable: true,
  };
}

function _hashEmail(email) {
  if (!email) return null;
  try {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
  } catch {
    return null;
  }
}

function validateManifestReadiness(completenessReport) {
  if (!completenessReport) {
    return { ready: false, blockers: [{ type: 'NO_COMPLETENESS_REPORT', label: 'Completeness report not available' }], message: 'No completeness report provided.' };
  }
  if (!completenessReport.audit_ready) {
    return {
      ready: false,
      blockers: completenessReport.blockers || [],
      message: `Intake not AUDIT_READY. ${(completenessReport.blockers || []).length} blocker(s) remain.`,
    };
  }
  return { ready: true, blockers: [], message: 'Audit handoff authorized — all mandatory items VALID.' };
}

module.exports = {
  createManifest,
  validateManifestReadiness,
};
