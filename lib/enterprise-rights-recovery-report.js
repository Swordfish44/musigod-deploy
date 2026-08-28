'use strict';

const REPORT_VERSION = 'enterprise-rights-recovery-v1';

function buildReport(snapshot = {}, options = {}) {
  const assets = snapshot.assets || [];
  const matches = snapshot.asset_matches || [];
  const reconciliations = snapshot.royalty_reconciliations || [];
  const conflicts = snapshot.ownership_conflicts || [];
  const opportunities = snapshot.recovery_opportunities || [];
  const findings = snapshot.findings || [];
  const uploads = snapshot.uploads || [];
  const tasks = snapshot.review_tasks || [];
  const countMissing = key => assets.filter(row => !row[key]).length;
  const verified = opportunities.filter(row => row.amount_basis === 'verified' && row.amount != null);
  const estimated = opportunities.filter(row => row.amount_basis === 'estimate' && row.amount != null);
  const currencies = rows => rows.reduce((totals, row) => {
    const currency = row.currency || 'USD';
    totals[currency] = Number(((totals[currency] || 0) + Number(row.amount || 0)).toFixed(2));
    return totals;
  }, {});
  const unresolved = value => !['resolved','rejected','approved','closed','legal_reviewed'].includes(value);

  return {
    report_version: REPORT_VERSION,
    report_reference: options.report_reference || `HV-RR-${new Date(options.generated_at || Date.now()).toISOString().slice(0,10).replaceAll('-','')}`,
    generated_at: options.generated_at || new Date().toISOString(),
    client_name: snapshot.organization?.name || 'HarbourView',
    workspace_name: snapshot.workspace?.name || snapshot.workspace?.workspace_code || 'Portfolio Rights Integrity Pilot',
    executive_summary: {
      assets_reviewed: assets.length,
      sources_analyzed: uploads.length,
      exact_or_probable_matches: matches.filter(row => ['exact','probable'].includes(row.classification)).length,
      unmatched_or_ambiguous: matches.filter(row => ['unmatched','ambiguous','rejected'].includes(row.classification)).length,
      open_ownership_conflicts: conflicts.filter(row => unresolved(row.resolution_status)).length,
      reconciliation_exceptions: reconciliations.filter(row => row.status !== 'matched').length,
      prioritized_opportunities: opportunities.filter(row => row.status !== 'rejected').length,
      open_review_tasks: tasks.filter(row => ['open','in_progress','blocked'].includes(row.status)).length,
    },
    identifier_gaps: {
      missing_isrc: countMissing('isrc'),
      missing_iswc: countMissing('iswc'),
      missing_ipi: countMissing('ipi'),
      missing_publisher: countMissing('publisher'),
      missing_recording_party: assets.filter(row => row.asset_type === 'recording' && !(row.artist || row.recording_artist)).length,
    },
    value_summary: {
      verified_payable: currencies(verified),
      potential_estimates: currencies(estimated),
      unknown_value_count: opportunities.filter(row => row.amount == null || row.amount_basis === 'unknown').length,
      warning: 'Verified amounts require source evidence and counterparty confirmation. Estimates are potential opportunities, not amounts owed or guaranteed recoveries.',
    },
    sources: uploads.map(row => ({ filename: row.filename, rows: row.row_count, status: row.status, uploaded_at: row.uploaded_at })),
    findings: findings.map(row => ({ type: row.finding_type, summary: row.summary, status: row.review_status, evidence: row.evidence || {} })),
    reconciliations: reconciliations.map(row => ({ status: row.status, reported_amount: row.reported_amount, expected_amount: row.expected_amount, variance: row.variance, currency: row.currency, basis: row.amount_basis, evidence: row.evidence || {} })),
    ownership_conflicts: conflicts.map(row => ({ classification: row.classification, reasons: row.reasons || [], status: row.resolution_status, legal_conclusion: row.legal_conclusion || null, legal_review_required: !row.legal_conclusion })),
    recovery_opportunities: opportunities.map(row => ({ reference: row.opportunity_reference, priority: row.priority, score: row.score, amount: row.amount, currency: row.currency, basis: row.amount_basis, status: row.status, evidence: row.evidence || [], assumptions: row.assumptions || [] })),
    required_actions: [
      ...(conflicts.some(row => unresolved(row.resolution_status)) ? ['Complete named legal review of unresolved ownership conflicts.'] : []),
      ...(reconciliations.some(row => row.status !== 'matched') ? ['Validate reconciliation exceptions against complete statements and governing rate evidence.'] : []),
      ...(findings.some(row => unresolved(row.review_status)) ? ['Resolve open metadata and identifier findings with named reviewer notes.'] : []),
      ...(opportunities.some(row => row.status === 'review_required') ? ['Approve or reject each recovery opportunity before preparing any correction package.'] : []),
      'Obtain written client authorization before any external correction, registration, claim, or submission.',
    ],
    limitations: [
      'Analysis is limited to customer-authorized sources loaded into this workspace.',
      'A system finding is not a final legal ownership determination.',
      'Missing data may indicate an incomplete source rather than a missing registration or payment.',
      'No external submission is enabled by this report.',
    ],
  };
}

module.exports = { REPORT_VERSION, buildReport };
