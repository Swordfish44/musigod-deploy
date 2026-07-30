'use strict';
// tests/integration/echo-sandbox.test.js
//
// Integration test for the Echo sandbox pilot walkthrough.
// Imports the pilot script (which runs on require) and asserts the final
// in-memory state across every phase.
//
// All fixtures are synthetic. No real artist data, credentials, network calls,
// or DB writes. Safe to run in any environment.
//
// Run: node tests/integration/echo-sandbox.test.js  (or: npm run test:echo)

const {
  ECHO,
  finalState,
  transitions,
  itemStatuses,
  documents,
  envelopeIds,
  completeness,
  manifest,
  identityRecord,
  pilotCfg,
  engagementCfg,
} = require('../../scripts/sandbox/echo-pilot');

const { TERMINAL_STATES, STATES }   = require('../../lib/intake-state-machine');
const { MANDATORY_ITEMS, ITEM_STATUS } = require('../../lib/completeness-engine');

console.log('\n=== echo-sandbox.test.js ===\n');

let passed = 0;
let failed = 0;

function assert(label, got, expected) {
  const ok = got === expected;
  if (ok) { console.log(`  ✅ ${label}`); passed++; }
  else {
    console.error(`  ❌ ${label}`);
    console.error(`       expected: ${JSON.stringify(expected)}`);
    console.error(`       got:      ${JSON.stringify(got)}`);
    failed++;
  }
}

function assertTrue(label, val) {
  if (val) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}`); failed++; }
}

function assertFalse(label, val) {
  if (!val) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}: expected falsy, got ${JSON.stringify(val)}`); failed++; }
}

function assertGte(label, got, min) {
  if (typeof got === 'number' && got >= min) { console.log(`  ✅ ${label} (${got} ≥ ${min})`); passed++; }
  else { console.error(`  ❌ ${label}: expected ≥${min}, got ${got}`); failed++; }
}

// ── Section 1: Echo constants ──────────────────────────────────────────────────
console.log('── 1. Echo constants ──');
assert('engagement_id',  ECHO.engagement_id, 'pilot-001-echo-sandbox');
assert('artist_id',      ECHO.artist_id,     '86c8df13-dbc6-4846-a8da-cdbaaf386cc7');
assert('artist_email',   ECHO.artist_email,  'echo@musigod-test.local');
assert('pilot_id',       ECHO.pilot_id,      'pilot-echo');
assert('tier',           ECHO.tier,          'individual');

// ── Section 2: Pilot config ────────────────────────────────────────────────────
console.log('\n── 2. Pilot config ──');
assertTrue('pilotCfg exists',              Boolean(pilotCfg));
assert('pilot_id',                         pilotCfg.pilot_id,               'pilot-echo');
assert('catalog_total_tracks',             pilotCfg.catalog_total_tracks,   5);
assert('tracks_with_isrc',                 pilotCfg.tracks_with_isrc,       5);
assert('tracks_missing_isrc',              pilotCfg.tracks_missing_isrc,    0);
assert('tracks_missing_writers',           pilotCfg.tracks_missing_writers, 0);
assertTrue('sandbox flag',                 pilotCfg.sandbox === true);
assertTrue('require_featured_performer',   pilotCfg.require_featured_performer_confirmation);
assertTrue('require_master_ownership',     pilotCfg.require_master_ownership_evidence);
assert('no unverified ownership candidates',
  pilotCfg.unverified_ownership_candidates.length, 0);

// ── Section 3: Engagement config (billing gate) ────────────────────────────────
console.log('\n── 3. Engagement config ──');
assertTrue('billing_activation_blocked',   engagementCfg.billing_activation_blocked === true);
assertTrue('legal_review_required',        engagementCfg.legal_review_required === true);
assert('contingency_rate',                 engagementCfg.commercial.contingency_rate, 0.15);

// ── Section 4: Final state ─────────────────────────────────────────────────────
console.log('\n── 4. Final state ──');
assert('finalState is CLOSED',             finalState, 'CLOSED');
assertTrue('CLOSED is terminal',           TERMINAL_STATES.has(finalState));
assertTrue('finalState is a known state',  STATES.includes(finalState));

// ── Section 5: Transition log ──────────────────────────────────────────────────
console.log('\n── 5. Transition log ──');
assertGte('at least 15 transitions logged',  transitions.length, 15);
assertFalse('no null records in log',        transitions.some(t => t === null));

const allHaveActor = transitions.every(t => typeof t.actor === 'string' && t.actor.length > 0);
assertTrue('every transition has actor',     allHaveActor);

const allHaveCorr = transitions.every(t => typeof t.correlation_id === 'string' && t.correlation_id.startsWith('echo-corr-'));
assertTrue('every transition has correlation_id', allHaveCorr);

const allHaveTimestamp = transitions.every(t => typeof t.timestamp === 'string');
assertTrue('every transition has timestamp', allHaveTimestamp);

// Verify key transitions present
const transitionKeys = transitions.map(t => `${t.prior_state}→${t.new_state}`);
const requiredTransitions = [
  'INVITED→IDENTITY_PENDING',
  'IDENTITY_PENDING→IDENTITY_CONFIRMED',
  'IDENTITY_CONFIRMED→ENGAGEMENT_PENDING',
  'ENGAGEMENT_PENDING→ENGAGEMENT_SENT',
  'ENGAGEMENT_SENT→ENGAGEMENT_SIGNED',
  'ENGAGEMENT_SIGNED→LOA_PENDING',
  'LOA_PENDING→LOA_SENT',
  'LOA_SENT→LOA_SIGNED',
  'LOA_SIGNED→EXPORT_GUIDANCE_PENDING',
  'EXPORT_GUIDANCE_PENDING→DOCUMENTS_PARTIAL',
  'DOCUMENTS_PARTIAL→DOCUMENTS_COMPLETE',
  'DOCUMENTS_COMPLETE→DOCUMENTS_VALIDATING',
  'DOCUMENTS_VALIDATING→AUDIT_READY',
  'AUDIT_READY→AUDIT_IN_PROGRESS',
  'AUDIT_IN_PROGRESS→CLOSED',
];
for (const key of requiredTransitions) {
  assertTrue(`transition present: ${key}`, transitionKeys.includes(key));
}

// ── Section 6: Identity record ─────────────────────────────────────────────────
console.log('\n── 6. Identity record ──');
assertTrue('identityRecord exists',         Boolean(identityRecord));
assert('submission_context',                identityRecord.submission_context, 'artist_self');
assertTrue('capacity_confirmed',            identityRecord.capacity_confirmed === true);
assertTrue('has verified_at',              typeof identityRecord.verified_at === 'string');
assertTrue('performer_roles non-empty',     Array.isArray(identityRecord.performer_roles) && identityRecord.performer_roles.length > 0);

// ── Section 7: Item statuses ───────────────────────────────────────────────────
console.log('\n── 7. Item statuses (completeness) ──');
for (const item of MANDATORY_ITEMS) {
  const s = itemStatuses[item.id];
  assert(`${item.id} = VALID`,  s?.status, ITEM_STATUS.VALID);
}

// ── Section 8: Completeness report ────────────────────────────────────────────
console.log('\n── 8. Completeness report ──');
assertTrue('audit_ready = true',            completeness.audit_ready === true);
assert('mandatory_passed',                  completeness.mandatory_passed, 7);
assert('mandatory_total',                   completeness.mandatory_total,  7);
assert('mandatory_missing',                 completeness.mandatory_missing, 0);
assert('mandatory_rejected',                completeness.mandatory_rejected, 0);
assert('mandatory_awaiting_review',         completeness.mandatory_awaiting_review, 0);
assert('progress_percent',                  completeness.progress_percent, 100);
assert('blockers count',                    completeness.blockers.length, 0);
assertTrue('engine_version present',        typeof completeness.engine_version === 'string');
assertTrue('computed_at present',           typeof completeness.computed_at === 'string');

// ── Section 9: Documents ───────────────────────────────────────────────────────
console.log('\n── 9. Documents ──');
assertGte('at least 4 documents vaulted',   documents.length, 4);

const docTypes = documents.map(d => d.document_type);
assertTrue('soundexchange_catalog present',          docTypes.includes('soundexchange_catalog'));
assertTrue('soundexchange_payments present',         docTypes.includes('soundexchange_payments'));
assertTrue('featured_performer_declaration present', docTypes.includes('featured_performer_declaration'));
assertTrue('master_ownership present',               docTypes.includes('master_ownership'));

const allHaveHash = documents.every(d => typeof d.sha256_hash === 'string' && d.sha256_hash.length === 64);
assertTrue('all documents have 64-char sha256_hash', allHaveHash);

const allHaveId = documents.every(d => typeof d.document_id === 'string' && d.document_id.length > 0);
assertTrue('all documents have document_id',         allHaveId);

const noPublicPaths = documents.every(d => !d.storage_path?.includes('/public/'));
assertTrue('no document has a public storage path',  noPublicPaths);

const allActive = documents.every(d => d.retention_status === 'ACTIVE');
assertTrue('all documents have retention_status ACTIVE', allActive);

const noneQuarantined = documents.every(d => d.quarantined === false);
assertTrue('no documents quarantined',               noneQuarantined);

// ── Section 10: Envelopes ──────────────────────────────────────────────────────
console.log('\n── 10. Envelopes ──');
assert('2 envelopes signed',                envelopeIds.length, 2);
assertTrue('all envelope IDs are strings',  envelopeIds.every(id => typeof id === 'string' && id.startsWith('mock-env-')));

// ── Section 11: Manifest ───────────────────────────────────────────────────────
console.log('\n── 11. Manifest ──');
assertTrue('manifest exists',                        Boolean(manifest));
assert('dry_run is true',                            manifest.dry_run,           true);
assert('immutable flag',                             manifest.immutable,         true);
assert('intake_state_at_handoff',                    manifest.intake_state_at_handoff, 'AUDIT_READY');
assert('engagement_id',                              manifest.engagement_id,     ECHO.engagement_id);
assert('artist_id',                                  manifest.artist_id,         ECHO.artist_id);
assert('document_count',                             manifest.document_count,    documents.length);
assert('envelope count in manifest',                 manifest.envelope_ids.length, 2);

// Privacy: plain email must not appear; hash must
assertFalse('artist_email absent from manifest',     'artist_email' in manifest);
assertTrue('artist_email_hash present',              typeof manifest.artist_email_hash === 'string' && manifest.artist_email_hash.length === 64);

// Security: storage_path excluded from manifest documents
const manifestHasStoragePath = manifest.documents.some(d => 'storage_path' in d);
assertFalse('storage_path excluded from manifest documents', manifestHasStoragePath);

// Manifest document integrity
assert('manifest document count matches vaulted docs', manifest.documents.length, documents.length);
const allManifestDocsHaveHash = manifest.documents.every(d => typeof d.sha256_hash === 'string' && d.sha256_hash.length === 64);
assertTrue('all manifest docs have sha256_hash',     allManifestDocsHaveHash);

assertTrue('manifest_id starts with manifest-',      manifest.manifest_id.startsWith('manifest-'));
assertTrue('manifest_version set',                   manifest.manifest_version === 'audit-handoff-v1');
assertTrue('frozen_at is ISO string',                typeof manifest.frozen_at === 'string');
assertTrue('completeness.audit_ready in manifest',   manifest.completeness.audit_ready === true);
assertTrue('catalog_baseline present',               Boolean(manifest.catalog_baseline));
assert('catalog total_tracks',                       manifest.catalog_baseline.total_tracks, 5);
assertTrue('identity_confirmed in manifest',         manifest.identity_confirmed === true);

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n══ Results: ${passed} passed, ${failed} failed ══\n`);
if (failed > 0) process.exit(1);
