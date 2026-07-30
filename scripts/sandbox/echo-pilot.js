'use strict';
// scripts/sandbox/echo-pilot.js
//
// Echo sandbox pilot — full INVITED → CLOSED in-memory walkthrough.
// Uses artist Echo: engagement_id pilot-001-echo-sandbox, pilot-echo catalog config.
// Synthetic documents only. Zero network calls. Zero DB writes.
// Run: node scripts/sandbox/echo-pilot.js  (or: npm run sandbox)

const crypto = require('crypto');

const { transition }         = require('../../lib/intake-state-machine');
const { computeCompleteness, markItemStatus, ITEM_STATUS } = require('../../lib/completeness-engine');
const { getProvider, DOC_TYPES } = require('../../lib/esign-adapter');
const { validateFileMetadata, buildVaultRecord, computeSha256 } = require('../../lib/document-vault');
const { createManifest, validateManifestReadiness } = require('../../lib/audit-handoff');
const { getPilotConfig, buildEngagementConfig } = require('../../lib/intake-config');

// ── Echo constants ─────────────────────────────────────────────────────────────

const ECHO = {
  engagement_id: 'pilot-001-echo-sandbox',
  artist_id:     '86c8df13-dbc6-4846-a8da-cdbaaf386cc7',
  artist_email:  'echo@musigod-test.local',
  artist_name:   'Echo (Sandbox)',
  pilot_id:      'pilot-echo',
  tier:          'individual',
};

// ── In-memory state ────────────────────────────────────────────────────────────

let currentState     = 'INVITED';
const transitions    = [];  // append-only log
let itemStatuses     = {};  // completeness item tracking
const documents      = [];  // vault records
const envelopeIds    = [];  // e-sign envelope IDs

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg)     { console.log(`  ${msg}`); }
function section(msg) { console.log(`\n─── ${msg} ───`); }

let corrSeq = 0;
function nextCorr() { return `echo-corr-${String(++corrSeq).padStart(3, '0')}`; }

function step(targetState, trigger, reason = '') {
  const result = transition(currentState, targetState, {
    actor: 'echo-sandbox-operator',
    trigger,
    correlationId: nextCorr(),
    reason,
  });
  if (!result.idempotent) transitions.push(result.record);
  currentState = result.state;
  log(`[${result.record?.prior_state || currentState} → ${currentState}] trigger=${trigger}`);
  return result;
}

function synthBuffer(label) {
  // Deterministic synthetic content — no real data
  return Buffer.from(`SYNTHETIC:${label}:echo-sandbox:${ECHO.engagement_id}`);
}

function synthDoc({ documentType, originalName, mimeType, documentCategory, reportingPeriod = null }) {
  const content  = synthBuffer(`${documentType}:${originalName}`);
  const hash     = computeSha256(content);
  const { valid, errors } = validateFileMetadata({
    originalName,
    mimeType,
    sizeBytes: content.length,
  });
  if (!valid) throw new Error(`Synthetic doc failed validation: ${errors.map(e => e.detail).join('; ')}`);

  const docId = crypto.randomUUID();
  const storagePath = `${ECHO.artist_email}/sandbox/${Date.now()}-${documentType}-${originalName}`;
  const record = buildVaultRecord({
    documentId: docId,
    artistId: ECHO.artist_id,
    artistEmail: ECHO.artist_email,
    engagementId: ECHO.engagement_id,
    documentType,
    originalName,
    mimeType,
    sizeBytes: content.length,
    sha256Hash: hash,
    storagePath,
    documentCategory,
    reportingPeriod,
  });
  documents.push(record);
  log(`  doc uploaded: ${documentType} (${hash.slice(0, 12)}…) id=${docId.slice(0, 8)}…`);
  return record;
}

function markItem(itemId, status, docIds = []) {
  itemStatuses = markItemStatus(itemStatuses, itemId, status, { documentIds: docIds });
}

// ── Pilot and engagement config ────────────────────────────────────────────────

section('0. Config');
const pilotCfg = getPilotConfig(ECHO.pilot_id);
if (!pilotCfg) throw new Error(`Unknown pilot: ${ECHO.pilot_id}`);
const engagementCfg = buildEngagementConfig({ pilotId: ECHO.pilot_id, tier: ECHO.tier });
log(`pilot_id:                 ${pilotCfg.pilot_id}`);
log(`catalog_total_tracks:     ${pilotCfg.catalog_total_tracks}`);
log(`billing_activation_blocked: ${engagementCfg.billing_activation_blocked}`);
log(`contingency_rate:         ${engagementCfg.commercial.contingency_rate}`);

// ── Phase 1: Identity ──────────────────────────────────────────────────────────

section('1. Identity (INVITED → IDENTITY_CONFIRMED)');

step('IDENTITY_PENDING', 'identity_form_submitted');

// Synthetic identity record
const identityRecord = {
  questionnaire_version: 'v1',
  legal_name:            '[SYNTHETIC] Echo Artist',
  performing_name:       'Echo (Sandbox)',
  submission_context:    'artist_self',
  performer_roles:       ['featured_performer'],
  capacity_confirmed:    true,
  verified_at:           new Date().toISOString(),
  verified_by:           'echo-sandbox-operator',
};
log(`  identity record built: context=${identityRecord.submission_context}`);

step('IDENTITY_CONFIRMED', 'identity_verified', 'Questionnaire reviewed — synthetic data only');
markItem('identity_confirmed', ITEM_STATUS.VALID);

// ── Phase 2: Engagement agreement ─────────────────────────────────────────────

section('2. Engagement agreement (IDENTITY_CONFIRMED → ENGAGEMENT_SIGNED)');

step('ENGAGEMENT_PENDING', 'engagement_prep_started');

const esign = getProvider({ mock: true });

const engEnvelope = esign.createEnvelope({
  documentType:    DOC_TYPES.ENGAGEMENT_AGREEMENT,
  documentVersion: 'v1',
  artistId:        ECHO.artist_id,
  signerEmail:     ECHO.artist_email,
  signerName:      ECHO.artist_name,
  correlationId:   nextCorr(),
});
log(`  engagement envelope created: ${engEnvelope.envelope_id}`);
log(`  production_blocked: ${engEnvelope.production_blocked}`);

esign.sendEnvelope(engEnvelope.envelope_id);
step('ENGAGEMENT_SENT', 'engagement_envelope_sent');

// Simulate Echo signing
esign._simulateSigning(engEnvelope.envelope_id, {
  signerEmail: ECHO.artist_email,
  signerName:  ECHO.artist_name,
});
envelopeIds.push(engEnvelope.envelope_id);
log(`  engagement signed ✓ envelope_id=${engEnvelope.envelope_id.slice(0, 24)}…`);

step('ENGAGEMENT_SIGNED', 'engagement_signed',
  `envelope_id=${engEnvelope.envelope_id}`);
markItem('engagement_signed', ITEM_STATUS.VALID);

// ── Phase 3: LOA ───────────────────────────────────────────────────────────────

section('3. Limited LOA (ENGAGEMENT_SIGNED → LOA_SIGNED)');

step('LOA_PENDING', 'loa_prep_started');

const loaEnvelope = esign.createEnvelope({
  documentType:    DOC_TYPES.LOA,
  documentVersion: 'v1',
  artistId:        ECHO.artist_id,
  signerEmail:     ECHO.artist_email,
  signerName:      ECHO.artist_name,
  correlationId:   nextCorr(),
});
log(`  LOA envelope created: ${loaEnvelope.envelope_id}`);
log(`  production_blocked: ${loaEnvelope.production_blocked}`);

esign.sendEnvelope(loaEnvelope.envelope_id);
step('LOA_SENT', 'loa_envelope_sent');

esign._simulateSigning(loaEnvelope.envelope_id, {
  signerEmail: ECHO.artist_email,
  signerName:  ECHO.artist_name,
});
envelopeIds.push(loaEnvelope.envelope_id);
log(`  LOA signed ✓ envelope_id=${loaEnvelope.envelope_id.slice(0, 24)}…`);

step('LOA_SIGNED', 'loa_signed', `envelope_id=${loaEnvelope.envelope_id}`);
markItem('loa_signed', ITEM_STATUS.VALID);

// ── Phase 4: Export guidance ───────────────────────────────────────────────────

section('4. Export guidance (LOA_SIGNED → DOCUMENTS_PARTIAL)');

step('EXPORT_GUIDANCE_PENDING', 'export_guidance_sent');
step('DOCUMENTS_PARTIAL', 'first_document_uploaded', 'Export guidance acknowledged');

// ── Phase 5: Document uploads ─────────────────────────────────────────────────

section('5. Document uploads (7 mandatory items)');

// SoundExchange catalog export
const catalogDoc = synthDoc({
  documentType:     'soundexchange_catalog',
  originalName:     'echo-sx-catalog-export.csv',
  mimeType:         'text/csv',
  documentCategory: 'soundexchange',
});
markItem('soundexchange_catalog', ITEM_STATUS.VALID, [catalogDoc.document_id]);
step('DOCUMENTS_PARTIAL', 'additional_document_uploaded', 'SoundExchange catalog uploaded');

// SoundExchange payment statements
const paymentsDoc = synthDoc({
  documentType:     'soundexchange_payments',
  originalName:     'echo-sx-payments-2022-2024.csv',
  mimeType:         'text/csv',
  documentCategory: 'soundexchange',
  reportingPeriod:  '2022–2024',
});
markItem('soundexchange_payments', ITEM_STATUS.VALID, [paymentsDoc.document_id]);
step('DOCUMENTS_PARTIAL', 'additional_document_uploaded', 'SoundExchange payments uploaded');

// Featured performer declaration
const performerDoc = synthDoc({
  documentType:     'featured_performer_declaration',
  originalName:     'echo-performer-declaration.pdf',
  mimeType:         'application/pdf',
  documentCategory: 'identity',
});
markItem('featured_performer_declaration', ITEM_STATUS.VALID, [performerDoc.document_id]);
step('DOCUMENTS_PARTIAL', 'additional_document_uploaded', 'Featured performer declaration uploaded');

// Master ownership declaration
const ownershipDoc = synthDoc({
  documentType:     'master_ownership',
  originalName:     'echo-master-ownership-declaration.pdf',
  mimeType:         'application/pdf',
  documentCategory: 'ownership',
});
markItem('master_ownership', ITEM_STATUS.VALID, [ownershipDoc.document_id]);

// ── Phase 6: Completeness check and validation ─────────────────────────────────

section('6. Completeness check');

let completeness = computeCompleteness(itemStatuses);
log(`mandatory_passed: ${completeness.mandatory_passed}/${completeness.mandatory_total}`);
log(`progress_percent: ${completeness.progress_percent}%`);
log(`blockers: ${completeness.blockers.length}`);
if (completeness.blockers.length) {
  for (const b of completeness.blockers) log(`  blocker: ${b.type} — ${b.item_id}`);
}
log(`audit_ready: ${completeness.audit_ready}`);

if (!completeness.audit_ready) {
  // Should not happen — all 7 items marked VALID above
  throw new Error(`Completeness check failed unexpectedly: ${JSON.stringify(completeness.blockers)}`);
}

// ── Phase 7: Validation and AUDIT_READY ───────────────────────────────────────

section('7. Validation → AUDIT_READY');

step('DOCUMENTS_COMPLETE', 'all_documents_received');
step('DOCUMENTS_VALIDATING', 'validation_started');
step('AUDIT_READY', 'validation_passed', 'All 7 mandatory items VALID');

// ── Phase 8: Audit handoff manifest ───────────────────────────────────────────

section('8. Audit handoff manifest (dryRun: true)');

const readiness = validateManifestReadiness(completeness);
log(`ready: ${readiness.ready}`);
log(`message: ${readiness.message}`);

const manifest = createManifest({
  engagementId:       ECHO.engagement_id,
  artistId:           ECHO.artist_id,
  artistEmail:        ECHO.artist_email,
  intakeState:        currentState,
  documentsReceived:  documents,
  completenessReport: completeness,
  identityRecord,
  envelopeIds,
  catalogBaseline: {
    total_tracks:          pilotCfg.catalog_total_tracks,
    tracks_with_isrc:      pilotCfg.tracks_with_isrc,
    tracks_missing_isrc:   pilotCfg.tracks_missing_isrc,
    tracks_missing_writers: pilotCfg.tracks_missing_writers,
  },
  dryRun: true,
});

log(`manifest_id:    ${manifest.manifest_id}`);
log(`dry_run:        ${manifest.dry_run}`);
log(`document_count: ${manifest.document_count}`);
log(`envelope_count: ${manifest.envelope_ids.length}`);
log(`identity_confirmed: ${manifest.identity_confirmed}`);
log(`artist_email in manifest: ${manifest.artist_email !== undefined ? 'PRESENT (ERROR)' : 'absent ✓'}`);
log(`artist_email_hash present: ${Boolean(manifest.artist_email_hash)}`);
log(`storage_path in any doc: ${manifest.documents.some(d => d.storage_path) ? 'PRESENT (ERROR)' : 'absent ✓'}`);

// ── Phase 9: Audit and CLOSED ──────────────────────────────────────────────────

section('9. Audit → CLOSED');

step('AUDIT_IN_PROGRESS', 'audit_started');
step('CLOSED', 'audit_completed', 'Echo sandbox pilot complete');

// ── Summary ────────────────────────────────────────────────────────────────────

section('Summary');
log(`final state:       ${currentState}`);
log(`transitions logged: ${transitions.length}`);
log(`documents vaulted:  ${documents.length}`);
log(`envelopes signed:   ${envelopeIds.length}`);
log(`manifest_id:        ${manifest.manifest_id}`);
log(`dry_run:            ${manifest.dry_run}`);

console.log('\n✅ Echo sandbox pilot complete — all phases passed.\n');

module.exports = {
  ECHO,
  finalState:   currentState,
  transitions,
  itemStatuses,
  documents,
  envelopeIds,
  completeness,
  manifest,
  identityRecord,
  pilotCfg,
  engagementCfg,
};
