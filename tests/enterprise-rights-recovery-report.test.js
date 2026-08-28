'use strict';
const assert = require('assert');
const { buildReport, REPORT_VERSION } = require('../lib/enterprise-rights-recovery-report');

const report = buildReport({
  organization:{name:'HarbourView'}, workspace:{name:'Pilot'},
  assets:[{asset_type:'recording',isrc:'USABC1212345',artist:'Artist'},{asset_type:'composition',iswc:null}],
  asset_matches:[{classification:'exact'},{classification:'ambiguous'}],
  royalty_reconciliations:[{status:'underreported',reported_amount:10,expected_amount:20,variance:10,currency:'USD',amount_basis:'verified'}],
  ownership_conflicts:[{classification:'data_conflict',resolution_status:'open',legal_conclusion:null}],
  recovery_opportunities:[{opportunity_reference:'OP-1',priority:'high',score:72,amount:100,currency:'USD',amount_basis:'estimate',status:'review_required'}],
  findings:[{finding_type:'missing_identifier',summary:'ISWC missing',review_status:'open'}],
  uploads:[{filename:'authorized.csv',row_count:2,status:'imported'}],
  review_tasks:[{status:'open'}],
},{generated_at:'2026-08-28T00:00:00.000Z'});

assert.equal(report.report_version, REPORT_VERSION);
assert.equal(report.executive_summary.assets_reviewed, 2);
assert.equal(report.executive_summary.open_ownership_conflicts, 1);
assert.equal(report.identifier_gaps.missing_iswc, 2);
assert.deepEqual(report.value_summary.verified_payable, {});
assert.deepEqual(report.value_summary.potential_estimates, {USD:100});
assert(report.value_summary.warning.includes('not amounts owed'));
assert(report.required_actions.some(value => value.includes('legal review')));
assert(report.limitations.includes('No external submission is enabled by this report.'));
console.log('=== Enterprise Rights Recovery Report Tests ===\n  ✅ report is evidence-limited, client-readable, and fail-closed\n\n=== Results: 1 passed, 0 failed ===');
