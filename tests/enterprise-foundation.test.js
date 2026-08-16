'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ingestion = require('../lib/enterprise-ingestion');
const rules = require('../lib/royalty-rules-registry');
const corrections = require('../lib/enterprise-correction-package');
const title = require('../lib/chain-of-title');

let passed = 0;
let failed = 0;
function assert(value, label) { if (value) { console.log(`  ✅ ${label}`); passed++; } else { console.error(`  ❌ ${label}`); failed++; } }

console.log('=== MusiGod Enterprise Foundation Tests ===');

const content = 'portfolio data';
const manifest = {
  organization_id: '11111111-1111-1111-1111-111111111111',
  source_name: 'HarbourView authorized export',
  transport: 'csv',
  content_sha256: crypto.createHash('sha256').update(content).digest('hex'),
  period_start: '2025-01-01', period_end: '2025-12-31',
};
assert(ingestion.validateImportManifest(manifest).valid, 'authorized CSV manifest validates');
assert(!ingestion.validateImportManifest({ ...manifest, transport: 'scrape' }).valid, 'unauthorized transport is rejected');

const normalized = ingestion.normalizeEnterpriseRecord('recording', { title: '  Buy U a Drank  ', isrc: 'us-z9x-07-00001' }, { source_name: 'pilot' });
assert(normalized.normalized_payload.title === 'Buy U a Drank', 'title is normalized');
assert(normalized.normalized_payload.isrc === 'USZ9X0700001', 'ISRC punctuation is normalized');
assert(/^[a-f0-9]{64}$/.test(normalized.provenance.input_sha256), 'record carries immutable input hash');
assert(ingestion.sha256({ b: 2, a: 1 }) === ingestion.sha256({ a: 1, b: 2 }), 'canonical hashing is key-order independent');

const rule = {
  rule_code: 'US-SR-DIGITAL-001', version: 1, territory: 'US', rights_type: 'featured_performer', usage_type: 'digital_performance',
  effective_from: '2025-01-01', authority_sources: [{ url: 'https://authority.example/rule', accessed_at: '2026-08-16' }],
  review_status: 'human_reviewed', reviewed_by: '22222222-2222-2222-2222-222222222222', reviewed_at: '2026-08-16T00:00:00Z',
};
assert(rules.validateRoyaltyRule(rule).valid, 'sourced and reviewed royalty rule validates');
assert(rules.ruleApplies(rule, { territory: 'US', rights_type: 'featured_performer', usage_type: 'digital_performance', usage_date: '2026-01-01' }), 'reviewed rule matches applicable event');
assert(!rules.ruleApplies({ ...rule, review_status: 'draft', reviewed_by: null, reviewed_at: null }, { territory: 'US', rights_type: 'featured_performer', usage_type: 'digital_performance', usage_date: '2026-01-01' }), 'draft rule cannot drive automation');

const spec = { destination: 'SOUNDEXCHANGE', submission_type: 'repertoire_correction', version: 'pilot-1', status: 'verified', required_fields: ['isrc', 'title', 'rightsholder'], evidence_requirements: ['ownership'], accepted_format: 'csv' };
const pkg = corrections.buildCorrectionPackage(spec, [{ isrc: 'USZ9X0700001', title: 'Buy U a Drank', rightsholder: 'Example LLC' }], [{ type: 'ownership', reference: 'doc-1' }]);
assert(pkg.status === 'ready_for_review', 'valid correction package reaches human-review queue');
assert(pkg.requires_human_approval === true, 'correction package cannot bypass human approval');
assert(() => { try { corrections.approveCorrectionPackage(pkg, {}); return false; } catch { return true; } }, 'anonymous correction approval is rejected');

const titleResult = title.analyzeTitleDocuments([{ id: '33333333-3333-3333-3333-333333333333', document_reference: 'Schedule A', document_type: 'schedule', effective_date: null, parties: [], rights_summary: {}, extraction_status: 'unreviewed' }]);
assert(titleResult.final_ownership_determination === null, 'system does not invent final ownership');
assert(titleResult.requires_legal_review, 'missing assignment requires legal review');
assert(titleResult.findings.some(f => f.finding_type === 'legal_determination_required'), 'legal-review finding is explicit');
assert(() => { try { title.validateLegalDetermination(titleResult, { user_id: 'x', role: 'analyst', determination: 'owned' }); return false; } catch { return true; } }, 'non-legal reviewer cannot determine title');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260816000000_enterprise_foundation_v1.sql'), 'utf8');
assert(!migration.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES'), 'migration does not grant access to unrelated public tables');
assert(migration.includes('fn_enterprise_has_org_access(organization_id)'), 'organization-scoped RLS predicate is installed');
assert(migration.includes('enterprise security evidence is append-only'), 'security evidence immutability trigger is installed');
assert((migration.match(/'MESA-\d{2}'/g) || []).length === 12, 'all twelve MESA-1 controls are seeded');

const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));
const securityHeaders = new Map(vercel.headers[0].headers.map(header => [header.key, header.value]));
for (const name of ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']) {
  assert(securityHeaders.has(name), `${name} is enforced at the edge`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
