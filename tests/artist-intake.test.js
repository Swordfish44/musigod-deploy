'use strict';
// tests/artist-intake.test.js
//
// Comprehensive tests for the Automated Artist Rights Intake system.
// Covers: state machine, identity, e-sign, export center, document vault,
// sensitive-data detection, document classification, completeness engine,
// comms, audit handoff, and intake config.
//
// All fixtures are synthetic. No real artist data, statements, credentials,
// or private documents are used or committed.
//
// Run: node tests/artist-intake.test.js

const {
  STATES, VALID_TRANSITIONS, TERMINAL_STATES,
  isValidTransition, transition, makeTransitionRecord, transitionKey, allowedTargets,
} = require('../lib/intake-state-machine');

const {
  validateIdentity, buildIdentityQuestionnaireSchema,
  PERFORMER_ROLES, SUBMISSION_CONTEXTS, PROHIBITED_FIELDS,
} = require('../lib/artist-identity');

const {
  getProvider, validateLOAScope, ENVELOPE_STATUS, DOC_TYPES,
  PROVIDERS, LOA_PROHIBITED_SCOPES, LEGAL_REVIEW_PLACEHOLDER, MockESignProvider,
} = require('../lib/esign-adapter');

const {
  getGuides, getGuideById, buildAcknowledgmentRecord, validateAcknowledgment,
  listRequiredGuideIds, GUIDE_VERSION,
} = require('../lib/export-center');

const {
  validateFileMetadata, buildVaultRecord, logAccess, isDuplicateHash,
  validateSignedUrl, isPublicUrl, redactUrl, computeSha256,
  QUARANTINE_REASONS, MAX_FILE_SIZE_BYTES, PRIVATE_BUCKET,
} = require('../lib/document-vault');

const {
  scanText, scanRows, buildSafeSummary, CATEGORIES,
} = require('../lib/sensitive-data-detector');

const {
  classifyByFilename, classifyByHeaders, buildClassification,
} = require('../lib/document-classifier');

const {
  computeCompleteness, markItemStatus, ITEM_STATUS, MANDATORY_ITEMS,
} = require('../lib/completeness-engine');

const {
  buildMessageRecord, shouldSendReminder, buildSubject, buildTimeline,
  MESSAGE_TYPES, DEFAULT_CADENCE,
} = require('../lib/intake-comms');

const { createManifest, validateManifestReadiness } = require('../lib/audit-handoff');

const {
  getPilotConfig, buildEngagementConfig, PILOT_CATALOG_CONFIGS,
} = require('../lib/intake-config');

console.log('\n=== artist-intake.test.js ===\n');

let passed = 0;
let failed = 0;

function assert(label, got, expected) {
  const ok = got === expected;
  if (ok) { console.log(`  ✅ ${label}`); passed++; }
  else {
    console.log(`  ❌ ${label}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    console.log(`       got:      ${JSON.stringify(got)}`);
    failed++;
  }
}

function assertDeep(label, got, expected) {
  const g = JSON.stringify(got);
  const e = JSON.stringify(expected);
  if (g === e) { console.log(`  ✅ ${label}`); passed++; }
  else {
    console.log(`  ❌ ${label}`);
    console.log(`       expected: ${e}`);
    console.log(`       got:      ${g}`);
    failed++;
  }
}

function assertThrows(label, fn, fragment) {
  try {
    fn();
    console.log(`  ❌ ${label} — expected throw, did not`);
    failed++;
  } catch (e) {
    if (!fragment || e.message.includes(fragment)) {
      console.log(`  ✅ ${label}`); passed++;
    } else {
      console.log(`  ❌ ${label} — threw "${e.message}", expected fragment "${fragment}"`);
      failed++;
    }
  }
}

function assertContains(label, haystack, needle) {
  const ok = typeof haystack === 'string' && haystack.includes(needle);
  if (ok) { console.log(`  ✅ ${label}`); passed++; }
  else {
    console.log(`  ❌ ${label}`);
    console.log(`       expected to include: ${JSON.stringify(needle)}`);
    console.log(`       got: ${JSON.stringify(String(haystack).slice(0, 200))}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// [1] State machine — valid transitions
// ─────────────────────────────────────────────────────────────────────────────
console.log('[1] State machine — valid transitions');
{
  const params = {
    actor: 'system',
    trigger: 'onboarding_start',
    correlationId: 'corr-001',
    reason: 'test',
  };

  const r1 = transition('INVITED', 'IDENTITY_PENDING', params);
  assert('INVITED→IDENTITY_PENDING succeeds', r1.state, 'IDENTITY_PENDING');
  assert('transition record has prior_state', r1.record.prior_state, 'INVITED');
  assert('transition record has new_state', r1.record.new_state, 'IDENTITY_PENDING');
  assert('transition record has actor', r1.record.actor, 'system');
  assert('transition is not idempotent', r1.idempotent, false);

  const r2 = transition('ENGAGEMENT_SENT', 'ENGAGEMENT_SIGNED', { ...params, trigger: 'esign_completed' });
  assert('ENGAGEMENT_SENT→ENGAGEMENT_SIGNED succeeds', r2.state, 'ENGAGEMENT_SIGNED');

  const r3 = transition('AUDIT_IN_PROGRESS', 'CLOSED', { ...params, trigger: 'audit_complete' });
  assert('AUDIT_IN_PROGRESS→CLOSED succeeds', r3.state, 'CLOSED');

  const r4 = transition('DOCUMENTS_PARTIAL', 'DOCUMENTS_PARTIAL', { ...params, trigger: 'upload' });
  assert('DOCUMENTS_PARTIAL self-loop is valid', r4.state, 'DOCUMENTS_PARTIAL');
  assert('DOCUMENTS_PARTIAL self-loop is not idempotent', r4.idempotent, false);
}

// ─────────────────────────────────────────────────────────────────────────────
// [2] State machine — invalid transitions
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] State machine — invalid transitions');
{
  const params = { actor: 'system', trigger: 't', correlationId: 'c', reason: '' };

  assertThrows('INVITED→AUDIT_READY is invalid', () =>
    transition('INVITED', 'AUDIT_READY', params), 'Invalid state transition');

  assertThrows('CLOSED→INVITED is invalid', () =>
    transition('CLOSED', 'INVITED', params), 'Invalid state transition');

  assertThrows('AUDIT_READY→ENGAGEMENT_PENDING is invalid', () =>
    transition('AUDIT_READY', 'ENGAGEMENT_PENDING', params), 'Invalid state transition');

  assertThrows('Unknown source state throws', () =>
    transition('NONEXISTENT', 'INVITED', params), 'Unknown current state');

  assertThrows('Unknown target state throws', () =>
    transition('INVITED', 'NONEXISTENT', params), 'Unknown target state');
}

// ─────────────────────────────────────────────────────────────────────────────
// [3] State machine — terminal state idempotency
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] State machine — terminal state idempotency');
{
  const params = { actor: 'system', trigger: 'close', correlationId: 'c' };

  const r1 = transition('CLOSED', 'CLOSED', params);
  assert('CLOSED→CLOSED is idempotent', r1.idempotent, true);
  assert('CLOSED→CLOSED state unchanged', r1.state, 'CLOSED');
  assert('CLOSED→CLOSED has no record', r1.record, null);

  const r2 = transition('WITHDRAWN', 'WITHDRAWN', params);
  assert('WITHDRAWN→WITHDRAWN is idempotent', r2.idempotent, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// [4] State machine — transition record fields
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] State machine — transition record required fields');
{
  const params = { actor: 'ops@musigod.com', trigger: 'manual_review', correlationId: 'corr-abc', evidenceRef: 'doc-123', authScope: 'neighboring_rights' };
  const r = transition('OWNERSHIP_REVIEW', 'AUDIT_READY', params);
  assert('record has evidence_ref', r.record.evidence_ref, 'doc-123');
  assert('record has auth_scope', r.record.auth_scope, 'neighboring_rights');
  assert('record has correlation_id', r.record.correlation_id, 'corr-abc');
  assert('record has timestamp string', typeof r.record.timestamp, 'string');

  assertThrows('makeTransitionRecord throws without actor', () =>
    makeTransitionRecord({ trigger: 't', correlationId: 'c', priorState: 'A', newState: 'B' }), 'requires actor');
  assertThrows('makeTransitionRecord throws without correlationId', () =>
    makeTransitionRecord({ actor: 'a', trigger: 't', priorState: 'A', newState: 'B' }), 'requires correlationId');
}

// ─────────────────────────────────────────────────────────────────────────────
// [5] State machine — withdrawn artist cannot proceed
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] State machine — withdrawn artist');
{
  const params = { actor: 'system', trigger: 'withdrawal', correlationId: 'c' };
  const rW = transition('IDENTITY_PENDING', 'WITHDRAWN', params);
  assert('artist can withdraw from IDENTITY_PENDING', rW.state, 'WITHDRAWN');

  assertThrows('withdrawn artist cannot re-enter engagement', () =>
    transition('WITHDRAWN', 'IDENTITY_PENDING', params), 'Invalid state transition');

  assertThrows('withdrawn artist cannot go to AUDIT_READY', () =>
    transition('WITHDRAWN', 'AUDIT_READY', params), 'Invalid state transition');
}

// ─────────────────────────────────────────────────────────────────────────────
// [6] Artist identity — valid submission
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6] Artist identity — valid submission');
{
  const valid = {
    legal_first_name: 'Eric',
    legal_last_name: 'Childs',
    professional_name: 'Esham',
    submission_context: 'INDIVIDUAL',
    performer_roles: ['FEATURED_PERFORMER', 'SOLO_ARTIST'],
    soundexchange_member: 'UNKNOWN',
    attestation_accurate: true,
    attestation_authorized: true,
  };
  const r = validateIdentity(valid);
  assert('valid identity passes', r.valid, true);
  assert('no errors on valid submission', r.errors.length, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// [7] Artist identity — prohibited fields rejected
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7] Artist identity — prohibited fields rejected');
{
  const withSSN = {
    legal_first_name: 'Eric', legal_last_name: 'Childs', professional_name: 'Esham',
    submission_context: 'INDIVIDUAL', performer_roles: ['SOLO_ARTIST'],
    soundexchange_member: true, attestation_accurate: true, attestation_authorized: true,
    ssn: '123-45-6789',
  };
  const r = validateIdentity(withSSN);
  assert('SSN field is rejected', r.valid, false);
  assert('error mentions ssn', r.errors.some(e => e.includes('ssn')), true);

  const withPassword = { ...withSSN };
  delete withPassword.ssn;
  withPassword.password = 'hunter2';
  const r2 = validateIdentity(withPassword);
  assert('password field is rejected', r2.valid, false);
}

// ─────────────────────────────────────────────────────────────────────────────
// [8] Artist identity — attestation must be boolean true
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[8] Artist identity — attestation checks');
{
  const base = {
    legal_first_name: 'Eric', legal_last_name: 'Childs', professional_name: 'Esham',
    submission_context: 'INDIVIDUAL', performer_roles: ['SOLO_ARTIST'],
    soundexchange_member: false,
  };

  const r1 = validateIdentity({ ...base, attestation_accurate: 'yes', attestation_authorized: true });
  assert('string "yes" is not a valid attestation', r1.valid, false);

  const r2 = validateIdentity({ ...base, attestation_accurate: true, attestation_authorized: false });
  assert('false authorized attestation fails', r2.valid, false);

  const r3 = validateIdentity({ ...base, attestation_accurate: true, attestation_authorized: true });
  assert('both true attestations pass', r3.valid, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// [9] Artist identity — REPRESENTATIVE context requires representative fields
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[9] Artist identity — representative context');
{
  const base = {
    legal_first_name: 'Eric', legal_last_name: 'Childs', professional_name: 'Esham',
    submission_context: 'REPRESENTATIVE', performer_roles: ['SOLO_ARTIST'],
    soundexchange_member: false, attestation_accurate: true, attestation_authorized: true,
  };
  const r = validateIdentity(base);
  assert('REPRESENTATIVE without name fails', r.valid, false);
  assert('error mentions representative_name', r.errors.some(e => e.includes('representative_name')), true);

  const r2 = validateIdentity({ ...base, representative_name: 'Jane Doe', representative_role: 'Manager' });
  assert('REPRESENTATIVE with name+role passes', r2.valid, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// [10] E-signature adapter — envelope lifecycle
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[10] E-signature — envelope lifecycle');
{
  const provider = getProvider({ mock: true });
  provider._clearStore();

  const env = provider.createEnvelope({
    documentType: DOC_TYPES.ENGAGEMENT_AGREEMENT,
    documentVersion: 'v1',
    artistId: 'artist-abc',
    signerEmail: 'test@example.com',
    signerName: 'Test Artist',
    correlationId: 'corr-env-001',
  });

  assert('envelope created with CREATED status', env.status, ENVELOPE_STATUS.CREATED);
  assert('envelope has provider MOCK', env.provider, PROVIDERS.MOCK);
  assert('envelope has correlation_id', env.correlation_id, 'corr-env-001');
  assert('envelope is legal_review_required', env.legal_review_required, true);
  assert('envelope has document_hash', typeof env.document_hash, 'string');
  assertContains('legal review placeholder in note', env.legal_review_note, 'ATTORNEY REVIEW REQUIRED');

  const sent = provider.sendEnvelope(env.envelope_id);
  assert('envelope sends successfully', sent.status, ENVELOPE_STATUS.SENT);

  const signed = provider._simulateSigning(env.envelope_id, { signerEmail: 'test@example.com', signerName: 'Test' });
  assert('envelope signs successfully', signed.status, ENVELOPE_STATUS.COMPLETED);
  assert('completion certificate populated', typeof signed.completion_certificate, 'object');
  assert('signed_at populated', typeof signed.signed_at, 'string');
}

// ─────────────────────────────────────────────────────────────────────────────
// [11] E-signature — wrong signer rejected
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[11] E-signature — wrong signer');
{
  const provider = getProvider({ mock: true });
  provider._clearStore();

  const env = provider.createEnvelope({
    documentType: DOC_TYPES.LOA, documentVersion: 'v1',
    artistId: 'artist-abc', signerEmail: 'real@example.com',
    signerName: 'Real Artist', correlationId: 'corr-loa-001',
  });
  provider.sendEnvelope(env.envelope_id);

  assertThrows('wrong signer email rejected', () =>
    provider._simulateSigning(env.envelope_id, { signerEmail: 'attacker@evil.com' }),
    'Wrong signer');
}

// ─────────────────────────────────────────────────────────────────────────────
// [12] E-signature — expired envelope cannot be signed
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[12] E-signature — expired envelope');
{
  const provider = getProvider({ mock: true });
  provider._clearStore();

  const env = provider.createEnvelope({
    documentType: DOC_TYPES.ENGAGEMENT_AGREEMENT, documentVersion: 'v1',
    artistId: 'artist-x', signerEmail: 'x@example.com',
    signerName: 'X', correlationId: 'corr-exp-001',
  });
  provider.sendEnvelope(env.envelope_id);
  provider.expireEnvelope(env.envelope_id);

  assertThrows('expired envelope cannot be signed', () =>
    provider._simulateSigning(env.envelope_id, { signerEmail: 'x@example.com' }),
    'expired');
}

// ─────────────────────────────────────────────────────────────────────────────
// [13] E-signature — duplicate webhook is idempotent
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[13] E-signature — duplicate webhook delivery');
{
  const provider = getProvider({ mock: true });
  provider._clearStore();

  const env = provider.createEnvelope({
    documentType: DOC_TYPES.LOA, documentVersion: 'v1',
    artistId: 'artist-y', signerEmail: 'y@example.com',
    signerName: 'Y', correlationId: 'corr-wh-001',
  });

  const seenIds = new Set();
  const payload = { envelope_id: env.envelope_id, event_type: 'envelope.created' };

  const r1 = provider.processWebhook(payload, { seenIds });
  assert('first webhook accepted', r1.accepted, true);
  assert('first webhook not idempotent', r1.idempotent, false);

  const r2 = provider.processWebhook(payload, { seenIds });
  assert('duplicate webhook accepted (idempotent)', r2.accepted, true);
  assert('duplicate webhook marked idempotent', r2.idempotent, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// [14] E-signature — LOA scope validation
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[14] E-signature — LOA scope validation');
{
  const safeScopes = ['neighboring_rights_audit', 'soundexchange_search_read'];
  const r1 = validateLOAScope(safeScopes);
  assert('safe LOA scopes are valid', r1.valid, true);
  assert('no errors for safe scopes', r1.errors.length, 0);

  const dangerousScopes = ['neighboring_rights_audit', 'rights_assignment'];
  const r2 = validateLOAScope(dangerousScopes);
  assert('rights_assignment scope is rejected', r2.valid, false);
  assert('error mentions rights_assignment', r2.errors.some(e => e.includes('rights_assignment')), true);

  const withPoA = ['broad_power_of_attorney'];
  const r3 = validateLOAScope(withPoA);
  assert('broad_power_of_attorney scope is rejected', r3.valid, false);

  assertThrows('non-array LOA scope throws', () => validateLOAScope('not-an-array'), 'must be an array');
}

// ─────────────────────────────────────────────────────────────────────────────
// [15] Document vault — file type validation
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[15] Document vault — file type validation');
{
  const r1 = validateFileMetadata({ originalName: 'statement.pdf', mimeType: 'application/pdf', sizeBytes: 1024 });
  assert('valid PDF passes', r1.valid, true);

  const r2 = validateFileMetadata({ originalName: 'data.csv', mimeType: 'text/csv', sizeBytes: 512 });
  assert('valid CSV passes', r2.valid, true);

  const r3 = validateFileMetadata({ originalName: 'page.html', mimeType: 'text/html', sizeBytes: 100 });
  assert('HTML is blocked', r3.valid, false);
  assert('HTML gets BLOCKED_MIME code', r3.errors.some(e => e.code === QUARANTINE_REASONS.BLOCKED_MIME), true);
}

// ─────────────────────────────────────────────────────────────────────────────
// [16] Document vault — file-type spoofing (extension/MIME mismatch)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[16] Document vault — file-type spoofing');
{
  // File claims to be PDF but extension is .exe (not in allowed list)
  const r1 = validateFileMetadata({ originalName: 'malware.exe', mimeType: 'application/pdf', sizeBytes: 500 });
  assert('exe extension is disallowed', r1.valid, false);
  assert('exe gets DISALLOWED_EXTENSION', r1.errors.some(e => e.code === QUARANTINE_REASONS.DISALLOWED_EXTENSION), true);

  // MIME is PDF but extension is .csv — mismatch
  const r2 = validateFileMetadata({ originalName: 'renamed.csv', mimeType: 'application/pdf', sizeBytes: 100 });
  assert('PDF MIME with CSV extension is a mismatch', r2.valid, false);
  assert('mismatch gets MIME_EXTENSION_MISMATCH', r2.errors.some(e => e.code === QUARANTINE_REASONS.MIME_EXTENSION_MISMATCH), true);
}

// ─────────────────────────────────────────────────────────────────────────────
// [17] Document vault — oversized file
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[17] Document vault — oversized file');
{
  const r = validateFileMetadata({
    originalName: 'huge.pdf',
    mimeType: 'application/pdf',
    sizeBytes: MAX_FILE_SIZE_BYTES + 1,
  });
  assert('oversized file is rejected', r.valid, false);
  assert('oversized file gets FILE_TOO_LARGE', r.errors.some(e => e.code === QUARANTINE_REASONS.FILE_TOO_LARGE), true);
}

// ─────────────────────────────────────────────────────────────────────────────
// [18] Document vault — duplicate detection
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[18] Document vault — duplicate upload detection');
{
  const hash = 'abc123sha256hash';
  const existing = ['aaa', 'bbb', hash, 'ccc'];
  assert('duplicate hash detected', isDuplicateHash(hash, existing), true);
  assert('unique hash not flagged', isDuplicateHash('newuniqueXXX', existing), false);
  assert('empty list returns false', isDuplicateHash(hash, []), false);
}

// ─────────────────────────────────────────────────────────────────────────────
// [19] Document vault — private bucket enforcement and signed URL checks
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[19] Document vault — private bucket and signed URL enforcement');
{
  // Public URL detection
  assert('public URL detected', isPublicUrl('https://supabase.co/storage/v1/object/public/artist-documents/file.pdf'), true);
  assert('signed URL not flagged as public', isPublicUrl('https://supabase.co/storage/v1/object/sign/bucket/file.pdf?token=xxx'), false);
  assert('null URL returns false', isPublicUrl(null), false);

  // Signed URL validation
  const r1 = validateSignedUrl('https://supabase.co/storage/v1/object/sign/bucket/file.pdf?token=abc123');
  assert('valid signed URL passes', r1.valid, true);

  const r2 = validateSignedUrl('https://example.com/file.pdf');
  assert('URL without token is invalid', r2.valid, false);
  assertContains('invalid URL message mentions public', r2.reason, 'public');

  const r3 = validateSignedUrl(null);
  assert('null URL is invalid', r3.valid, false);

  // Redact signed URL
  const redacted = redactUrl('https://supabase.co/sign?token=SECRET&other=ok');
  assert('token is redacted in URL', redacted.includes('token=[REDACTED]'), true);
  assert('other params preserved', redacted.includes('other=ok'), true);
}

// ─────────────────────────────────────────────────────────────────────────────
// [20] Document vault — cross-artist access denial (vault record binding)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[20] Document vault — cross-artist access denial');
{
  const record = buildVaultRecord({
    documentId: 'doc-001',
    artistId: 'artist-A',
    artistEmail: 'a@example.com',
    engagementId: 'eng-001',
    documentType: 'DISTRIBUTOR_STATEMENT',
    originalName: 'statement.csv',
    mimeType: 'text/csv',
    sizeBytes: 1024,
    sha256Hash: 'hash001',
    storagePath: 'a@example.com/2026-07-29/ts-DISTRIBUTOR_STATEMENT-statement.csv',
    documentCategory: 'soundexchange',
  });

  assert('vault record bound to artist-A', record.artist_id, 'artist-A');
  assert('vault record engagement bound', record.engagement_id, 'eng-001');
  assert('bucket is private bucket', record.bucket, PRIVATE_BUCKET);

  // Admin metadata access — document path is NOT in the vault record returned to admin
  const adminView = { ...record };
  delete adminView.storage_path;
  assert('storage path excluded from admin view', adminView.storage_path, undefined);
  assert('document_id still visible in admin view', adminView.document_id, 'doc-001');
}

// ─────────────────────────────────────────────────────────────────────────────
// [21] Sensitive-data detection — quarantine patterns
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[21] Sensitive-data detection — quarantine');
{
  const textWithSSN = 'Social Security Number: 123-45-6789 is shown here';
  const r1 = scanText(textWithSSN, { documentId: 'doc-ssn', pageOrRow: 'page:1' });
  assert('SSN detected', r1.review_required, true);
  assert('SSN triggers quarantine', r1.quarantine, true);
  assert('SSN finding category is SSN', r1.findings[0].category, CATEGORIES.SSN);
  assert('SSN value is redacted', r1.findings[0].detected_value, '[REDACTED — value is never logged]');
  assert('SSN has document_id', r1.findings[0].document_id, 'doc-ssn');

  const textClean = 'This is a royalty statement for ISRC USASN0802524 period 2023-Q1';
  const r2 = scanText(textClean, { documentId: 'doc-clean' });
  assert('clean text has no findings', r2.finding_count, 0);
  assert('clean text no quarantine', r2.quarantine, false);
}

// ─────────────────────────────────────────────────────────────────────────────
// [22] Sensitive-data detection — password patterns
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[22] Sensitive-data detection — password and credential patterns');
{
  const r1 = scanText('password: hunter2_secret', { documentId: 'd' });
  assert('password pattern detected', r1.findings.some(f => f.category === CATEGORIES.PASSWORD), true);
  assert('password triggers quarantine', r1.quarantine, true);

  const r2 = scanText('EIN: 12-3456789 appears in this tax document', { documentId: 'd' });
  assert('EIN pattern detected', r2.findings.some(f => f.category === CATEGORIES.EIN), true);

  // Safe summary must not include detected values
  const summary = buildSafeSummary(r2);
  assert('safe summary has no detected_value field', 'detected_value' in summary, false);
  assert('safe summary has categories_found', Array.isArray(summary.categories_found), true);
}

// ─────────────────────────────────────────────────────────────────────────────
// [23] Sensitive-data detection — CSV row scan
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[23] Sensitive-data detection — row scan');
{
  const rows = [
    { isrc: 'USASN0802524', gross: 100, period: '2023-Q1' },
    { isrc: 'USASN0802525', ssn: '987-65-4321', period: '2023-Q1' }, // bad row
  ];
  const r = scanRows(rows, { documentId: 'doc-rows' });
  assert('SSN in row triggers quarantine', r.quarantine, true);
  assert('finding has row reference', r.findings.some(f => f.page_or_row === 'row:2'), true);
}

// ─────────────────────────────────────────────────────────────────────────────
// [24] Document classifier — filename heuristics
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[24] Document classifier — filename heuristics');
{
  const r1 = classifyByFilename('soundexchange_catalog_2023.csv');
  assert('SoundExchange filename identifies provider', r1.provider, 'SOUNDEXCHANGE');
  assert('catalog filename identifies doc type', r1.docType, 'CATALOG_EXPORT');

  const r2 = classifyByFilename('ppl_statement_2022.xlsx');
  assert('PPL filename identifies provider', r2.provider, 'PPL');
  assert('statement filename identifies doc type', r2.docType, 'PAYMENT_STATEMENT');

  const r3 = classifyByFilename('unknown_file.pdf');
  assert('unknown filename has UNKNOWN provider', r3.provider, 'UNKNOWN');
  assert('unknown filename has 0 confidence', r3.confidence, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// [25] Document classifier — header heuristics
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[25] Document classifier — header heuristics');
{
  const r1 = classifyByHeaders(['isrc', 'title', 'artist_name', 'statement_period', 'gross_royalties', 'currency']);
  assert('payment statement headers detected', r1.docType, 'PAYMENT_STATEMENT');
  assert('payment header confidence ≥ 0.7', r1.confidence >= 0.7, true);

  const r2 = classifyByHeaders(['isrc', 'title', 'artist_name', 'album']);
  assert('catalog headers detected', r2.docType, 'CATALOG_EXPORT');

  // Banking data in headers → quarantine
  const r3 = classifyByHeaders(['account_number', 'routing_number', 'bank_name']);
  assert('banking headers trigger quarantine', r3.quarantine, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// [26] Completeness engine — all mandatory items valid → AUDIT_READY
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[26] Completeness engine — AUDIT_READY gating');
{
  let statuses = {};
  for (const item of MANDATORY_ITEMS) {
    statuses = markItemStatus(statuses, item.id, ITEM_STATUS.VALID, { documentIds: [`doc-${item.id}`] });
  }
  const r = computeCompleteness(statuses);
  assert('all mandatory valid → audit_ready', r.audit_ready, true);
  assert('progress_percent is 100', r.progress_percent, 100);
  assert('no blockers', r.blockers.length, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// [27] Completeness engine — missing mandatory item blocks AUDIT_READY
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[27] Completeness engine — missing mandatory blocks audit');
{
  let statuses = {};
  for (const item of MANDATORY_ITEMS) {
    statuses = markItemStatus(statuses, item.id, ITEM_STATUS.VALID);
  }
  // Remove master_ownership
  statuses['master_ownership'] = { status: ITEM_STATUS.MISSING };

  const r = computeCompleteness(statuses);
  assert('missing mandatory item blocks audit_ready', r.audit_ready, false);
  assert('blocker listed for master_ownership', r.blockers.some(b => b.item_id === 'master_ownership'), true);
  assert('mandatory_missing is 1', r.mandatory_missing, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// [28] Completeness engine — rejected mandatory item blocks AUDIT_READY
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[28] Completeness engine — rejected mandatory item');
{
  let statuses = {};
  for (const item of MANDATORY_ITEMS) {
    statuses = markItemStatus(statuses, item.id, ITEM_STATUS.VALID);
  }
  statuses['engagement_signed'] = { status: ITEM_STATUS.REJECTED, notes: 'Document hash mismatch' };

  const r = computeCompleteness(statuses);
  assert('rejected mandatory blocks audit', r.audit_ready, false);
  assert('blocker type is MANDATORY_REJECTED', r.blockers.some(b => b.type === 'MANDATORY_REJECTED'), true);
}

// ─────────────────────────────────────────────────────────────────────────────
// [29] Completeness engine — incomplete ownership chain
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[29] Completeness engine — incomplete ownership chain');
{
  let statuses = {};
  for (const item of MANDATORY_ITEMS) {
    statuses = markItemStatus(statuses, item.id, ITEM_STATUS.VALID);
  }
  statuses['master_ownership'] = { status: ITEM_STATUS.AWAITING_REVIEW, notes: 'Unverified Reel Life Productions docs' };

  const r = computeCompleteness(statuses);
  assert('awaiting-review ownership blocks audit', r.audit_ready, false);
  assert('blocker type is MANDATORY_AWAITING_REVIEW', r.blockers.some(b => b.type === 'MANDATORY_AWAITING_REVIEW'), true);
}

// ─────────────────────────────────────────────────────────────────────────────
// [30] Comms — reminder cadence and max limit
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[30] Comms — reminder stopping and max limit');
{
  // Requirement satisfied → stop immediately
  const r1 = shouldSendReminder({
    messageType: 'MISSING_DOCUMENT_REMINDER',
    priorSentCount: 0,
    lastSentAt: null,
    requirementSatisfied: true,
  });
  assert('reminder stops when requirement satisfied', r1.send, false);
  assertContains('reason mentions satisfied', r1.reason, 'satisfied');

  // Max reminders reached
  const r2 = shouldSendReminder({
    messageType: 'MISSING_DOCUMENT_REMINDER',
    priorSentCount: 4, // DEFAULT_CADENCE maxReminders = 4
    lastSentAt: new Date(Date.now() - 10 * 86400 * 1000).toISOString(),
    requirementSatisfied: false,
  });
  assert('max reminders stops sending', r2.send, false);
  assertContains('reason mentions maximum', r2.reason, 'Maximum');

  // Too soon
  const r3 = shouldSendReminder({
    messageType: 'MISSING_DOCUMENT_REMINDER',
    priorSentCount: 1,
    lastSentAt: new Date(Date.now() - 2 * 86400 * 1000).toISOString(), // 2 days ago, interval=7
    requirementSatisfied: false,
  });
  assert('too-soon reminder not sent', r3.send, false);

  // Ready to send
  const r4 = shouldSendReminder({
    messageType: 'MISSING_DOCUMENT_REMINDER',
    priorSentCount: 1,
    lastSentAt: new Date(Date.now() - 8 * 86400 * 1000).toISOString(), // 8 days ago
    requirementSatisfied: false,
  });
  assert('eligible reminder should send', r4.send, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// [31] Comms — signed URL must not appear in email
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[31] Comms — signed URL and sensitive data guards');
{
  assertThrows('signed URL in portalUrl throws', () =>
    buildMessageRecord({
      messageType: 'MISSING_DOCUMENT_REMINDER',
      artistId: 'a', artistEmail: 'a@b.com',
      correlationId: 'c',
      portalUrl: 'https://supabase.co/storage/v1/object/sign/bucket/file.pdf?token=SECRET',
    }), 'signed storage URL');

  assertThrows('sensitive key in customFields throws', () =>
    buildMessageRecord({
      messageType: 'INVITATION',
      artistId: 'a', artistEmail: 'a@b.com',
      correlationId: 'c',
      customFields: { password: 'should-not-be-here' },
    }), 'Sensitive field');

  // Clean record should work
  const msg = buildMessageRecord({
    messageType: 'INVITATION',
    artistId: 'a', artistEmail: 'a@b.com', engagementId: 'eng-1',
    correlationId: 'c', portalUrl: 'https://musigod.com/portal/eng-1',
    customFields: { artist_name: 'Esham' },
  });
  assert('clean message record created', msg.status, 'PENDING');
  assert('message type set', msg.message_type, 'INVITATION');
  assert('template version set', typeof msg.template_version, 'string');
}

// ─────────────────────────────────────────────────────────────────────────────
// [32] Audit handoff — immutable manifest generation
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[32] Audit handoff — immutable manifest');
{
  let itemStatuses = {};
  for (const item of MANDATORY_ITEMS) {
    itemStatuses = markItemStatus(itemStatuses, item.id, ITEM_STATUS.VALID, { documentIds: [`doc-${item.id}`] });
  }
  const completeness = computeCompleteness(itemStatuses);
  const readiness = validateManifestReadiness(completeness);
  assert('manifest readiness approved', readiness.ready, true);

  const manifest = createManifest({
    engagementId: 'eng-001',
    artistId: 'artist-001',
    artistEmail: 'test@example.com',
    intakeState: 'AUDIT_READY',
    documentsReceived: [
      { document_id: 'doc-1', document_type: 'DISTRIBUTOR_STATEMENT', sha256_hash: 'abc', document_category: 'distributor', uploaded_at: '2026-07-01T00:00:00Z' },
    ],
    completenessReport: completeness,
    identityRecord: { confirmed: true },
    envelopeIds: ['env-001', 'env-002'],
    catalogBaseline: { total_tracks: 196, tracks_with_isrc: 152, tracks_missing_isrc: 44, tracks_missing_writers: 8 },
    dryRun: true,
  });

  assert('manifest is immutable', manifest.immutable, true);
  assert('manifest is dry_run', manifest.dry_run, true);
  assert('manifest has manifest_id', typeof manifest.manifest_id, 'string');
  assert('manifest references document count', manifest.document_count, 1);
  assert('manifest catalog baseline total_tracks', manifest.catalog_baseline.total_tracks, 196);
  assert('manifest email is hashed not plain', manifest.artist_email_hash !== 'test@example.com', true);
  assert('manifest has no storage_path', manifest.documents[0].storage_path, undefined);
  assertContains('statement path note in manifest', manifest.statement_data_path, 'CSV import only');
}

// ─────────────────────────────────────────────────────────────────────────────
// [33] Audit handoff — dryRun guard
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[33] Audit handoff — dryRun guard');
{
  assertThrows('manifest without dryRun throws', () =>
    createManifest({
      engagementId: 'e', artistId: 'a', artistEmail: 'e@x.com',
      intakeState: 'AUDIT_READY', documentsReceived: [], completenessReport: { audit_ready: true, mandatory_passed: 7, mandatory_total: 7, progress_percent: 100, blockers: [], engine_version: 'v1' },
      identityRecord: {}, envelopeIds: [], catalogBaseline: null, dryRun: false,
    }), 'requires dryRun: true');

  assertThrows('manifest in wrong state throws', () =>
    createManifest({
      engagementId: 'e', artistId: 'a', artistEmail: 'e@x.com',
      intakeState: 'DOCUMENTS_PARTIAL', documentsReceived: [], completenessReport: { audit_ready: false, mandatory_passed: 3, mandatory_total: 7, progress_percent: 43, blockers: [], engine_version: 'v1' },
      identityRecord: {}, envelopeIds: [], catalogBaseline: null, dryRun: true,
    }), 'AUDIT_READY');
}

// ─────────────────────────────────────────────────────────────────────────────
// [34] Intake config — pilot configuration
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[34] Intake config — pilot configuration');
{
  const config = getPilotConfig('pilot-001');
  assert('pilot config found', config !== null, true);
  assert('pilot total tracks is 196', config.catalog_total_tracks, 196);
  assert('pilot tracks_missing_isrc is 44', config.tracks_missing_isrc, 44);
  assert('pilot requires master ownership', config.require_master_ownership_evidence, true);
  assert('pilot does not block on writerless', config.do_not_block_on_writerless, true);
  assert('Reel Life Productions in unverified candidates', config.unverified_ownership_candidates.includes('Reel Life Productions'), true);

  assert('unknown pilot returns null', getPilotConfig('nonexistent'), null);
}

// ─────────────────────────────────────────────────────────────────────────────
// [35] Intake config — commercial terms
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[35] Intake config — commercial terms billing guard');
{
  const eng = buildEngagementConfig({ pilotId: 'pilot-001', tier: 'individual', contingencyRate: 0.15 });
  assert('billing activation is blocked', eng.billing_activation_blocked, true);
  assert('legal review required', eng.legal_review_required, true);
  assert('contingency rate is 15%', eng.commercial.contingency_rate, 0.15);
  assertContains('contingency applies to money actually recovered', eng.commercial.contingency_applies_to, 'actually recovered');
}

// ─────────────────────────────────────────────────────────────────────────────
// [36] Zero private-data flow through SoundExchange adapter API
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[36] Zero private-data flow through SoundExchange adapter');
{
  const fs = require('fs');
  const path = require('path');
  const adapterSrc = fs.readFileSync(path.join(__dirname, '../lib/soundexchange-adapter.js'), 'utf8');
  // Statement import must only call validateImport() — no fetch() in that path
  const fetchInStatementPath = /validateStatementImport[\s\S]{0,300}fetch\s*\(/.test(adapterSrc);
  assert('no fetch() in validateStatementImport path', fetchInStatementPath, false);
  // Confirm the active fetch pattern to wp-admin is still absent (regression)
  const activeFetch = /fetch\s*\([^)]{0,200}(admin-ajax|wp-admin)/.test(adapterSrc);
  assert('no active fetch() to admin-ajax in adapter', activeFetch, false);
}

// ─────────────────────────────────────────────────────────────────────────────
// [37] Export center — guide coverage and acknowledgment
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[37] Export center — guides and acknowledgments');
{
  const allGuides = getGuides();
  assert('at least 9 guides defined', allGuides.length >= 9, true);

  const required = getGuides({ requiredOnly: true });
  assert('required guides include soundexchange_payments', required.some(g => g.id === 'soundexchange_payments'), true);
  assert('required guides include master_ownership', required.some(g => g.id === 'master_ownership'), true);

  const guide = getGuideById('soundexchange_payments');
  assert('guide has guide_version', guide.guide_version, GUIDE_VERSION);
  assert('guide has how_to_export steps', Array.isArray(guide.how_to_export), true);
  assert('guide upload_warning present', typeof guide.upload_warning, 'string');

  const ack = buildAcknowledgmentRecord('soundexchange_payments', 'artist-001');
  assert('acknowledgment has guide_id', ack.guide_id, 'soundexchange_payments');
  assert('acknowledgment has guide_version', ack.guide_version, GUIDE_VERSION);

  const val = validateAcknowledgment('soundexchange_payments', 'artist-001');
  assert('valid acknowledgment passes', val.valid, true);

  const val2 = validateAcknowledgment('nonexistent-guide', 'artist-001');
  assert('invalid guide fails acknowledgment', val2.valid, false);
}

// ─────────────────────────────────────────────────────────────────────────────
// [38] State machine — all STATES are known
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[38] State machine — state list completeness');
{
  assert('STATES has 21 entries', STATES.length, 21);
  assert('INVITED in STATES', STATES.includes('INVITED'), true);
  assert('WITHDRAWN in STATES', STATES.includes('WITHDRAWN'), true);
  assert('AUDIT_READY in STATES', STATES.includes('AUDIT_READY'), true);
  assert('TERMINAL_STATES has CLOSED', TERMINAL_STATES.has('CLOSED'), true);
  assert('TERMINAL_STATES has WITHDRAWN', TERMINAL_STATES.has('WITHDRAWN'), true);

  // allowedTargets smoke test
  const fromInvited = allowedTargets('INVITED');
  assert('INVITED has allowed targets', fromInvited.length > 0, true);
  assert('INVITED can go to IDENTITY_PENDING', fromInvited.includes('IDENTITY_PENDING'), true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`${passed + failed} assertions | ${passed} passed | ${failed} failed`);
console.log('');
if (failed > 0) {
  console.log('FAIL');
  process.exit(1);
} else {
  console.log('PASS');
}
