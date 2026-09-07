'use strict';
const fs = require('fs');
const path = require('path');
const orchestrator = require('../../lib/portfolio-analysis-orchestrator');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'fixtures/enterprise/paid-diagnostic-demo.json'), 'utf8'));
  if (fixture.authorization?.status !== 'approved') return res.status(500).json({ error: 'Synthetic sample authorization is not approved' });
  const context = { organization_id: 'demo-org', workspace_id: 'demo-workspace', catalog_id: 'demo-catalog' };
  const plan = orchestrator.buildPlan({ records: fixture.records, assets: fixture.assets, existingSourceRecords: fixture.existing_source_records, existingClaims: fixture.existing_claims, reviewers: fixture.reviewers, context });
  return res.status(200).json({
    sample: true,
    sample_notice: 'Synthetic demonstration only. This is not HarbourView or other customer data and does not state that any royalties are owed.',
    organization: { ...fixture.organization, name: 'MusiGod Demonstration Portfolio' },
    workspace: { ...fixture.workspace, name: 'Synthetic Portfolio Rights Integrity Diagnostic' },
    assets: fixture.assets, uploads: fixture.uploads,
    findings: [
      { finding_type: 'missing_identifier', summary: 'ISWC, IPI and publisher data missing for recording HV-DEMO-001', review_status: 'open' },
      { finding_type: 'missing_identifier', summary: 'ISRC and recording-party identity missing for HV-DEMO-002', review_status: 'open' },
    ],
    asset_matches: plan.matches.map((item, index) => ({ id: `match-${index + 1}`, ...item.result })),
    royalty_reconciliations: plan.reconciliations.map((item, index) => ({ id: `reconciliation-${index + 1}`, ...item.result })),
    ownership_conflicts: plan.ownership_conflicts.map((item, index) => ({ id: `conflict-${index + 1}`, classification: item.classification, reasons: item.reasons, resolution_status: 'open', legal_conclusion: null, rule_version: item.rule_version })),
    recovery_opportunities: plan.recovery_opportunities.map((item, index) => ({ id: `opportunity-${index + 1}`, opportunity_reference: item.opportunity_reference, status: 'review_required', score: item.scored.score, priority: item.scored.priority, amount: item.scored.amount, amount_basis: item.scored.amount_basis, currency: item.currency, assumptions: item.scored.assumptions, evidence: item.scored.evidence })),
    review_tasks: plan.tasks.map((item, index) => ({ id: `task-${index + 1}`, ...item })),
    gates: { source_authorization_approved: true, external_submission_enabled: false, chain_of_title_legal_review_required: true },
  });
};
