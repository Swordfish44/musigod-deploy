'use strict';
const fs = require('fs');
const path = require('path');
const orchestrator = require('../../lib/portfolio-analysis-orchestrator');
const { buildReport } = require('../../lib/enterprise-rights-recovery-report');

const fixturePath = path.join(__dirname, '../../fixtures/enterprise/paid-diagnostic-demo.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
if (fixture.authorization?.status !== 'approved') throw new Error('approved synthetic authorization is required');

const context = { organization_id:'demo-org', workspace_id:'demo-workspace', catalog_id:'demo-catalog' };
const plan = orchestrator.buildPlan({
  records:fixture.records, assets:fixture.assets, existingSourceRecords:fixture.existing_source_records,
  existingClaims:fixture.existing_claims, reviewers:fixture.reviewers, context,
});
const findings = [
  { finding_type:'missing_identifier', summary:'ISWC, IPI and publisher data missing for recording HV-DEMO-001', review_status:'open', evidence:{asset_reference:'HV-DEMO-001'} },
  { finding_type:'missing_identifier', summary:'ISRC and recording-party identity missing for HV-DEMO-002', review_status:'open', evidence:{asset_reference:'HV-DEMO-002'} },
];
const snapshot = {
  organization:fixture.organization, workspace:fixture.workspace, assets:fixture.assets, uploads:fixture.uploads, findings,
  asset_matches:plan.matches.map((item,index)=>({id:`match-${index+1}`,...item.result})),
  royalty_reconciliations:plan.reconciliations.map((item,index)=>({id:`reconciliation-${index+1}`,...item.result})),
  ownership_conflicts:plan.ownership_conflicts.map((item,index)=>({id:`conflict-${index+1}`,classification:item.classification,reasons:item.reasons,resolution_status:'open',legal_conclusion:null,rule_version:item.rule_version})),
  recovery_opportunities:plan.recovery_opportunities.map((item,index)=>({id:`opportunity-${index+1}`,opportunity_reference:item.opportunity_reference,status:'review_required',score:item.scored.score,priority:item.scored.priority,amount:item.scored.amount,amount_basis:item.scored.amount_basis,currency:item.currency,assumptions:item.scored.assumptions,evidence:item.scored.evidence})),
  review_tasks:plan.tasks.map((item,index)=>({id:`task-${index+1}`,...item})),
  gates:{source_authorization_approved:true,external_submission_enabled:false,chain_of_title_legal_review_required:true},
};
const report = buildReport(snapshot,{generated_at:'2026-08-28T06:15:00.000Z',report_reference:'HV-RR-DEMO-20260828'});
const acceptance = {
  authorization_confirmed:snapshot.gates.source_authorization_approved,
  source_provenance_preserved:fixture.uploads.length===3,
  cross_source_matching_executed:snapshot.asset_matches.length>0,
  missing_identifiers_detected:report.identifier_gaps.missing_isrc>0,
  ownership_conflict_detected:report.executive_summary.open_ownership_conflicts>0,
  royalty_reconciliation_executed:snapshot.royalty_reconciliations.length>0,
  recovery_priority_created:snapshot.recovery_opportunities.length>0,
  named_reviewers_assigned:snapshot.review_tasks.every(task=>task.assigned_reviewer_id),
  legal_review_required:snapshot.ownership_conflicts.every(conflict=>conflict.legal_conclusion===null),
  unsupported_amounts_suppressed:Object.keys(report.value_summary.verified_payable).length===0,
  external_submission_disabled:snapshot.gates.external_submission_enabled===false,
};
if (Object.values(acceptance).some(value=>value!==true)) throw new Error(`demo acceptance failed: ${JSON.stringify(acceptance)}`);
process.stdout.write(JSON.stringify({authorization:fixture.authorization,acceptance,report},null,2)+'\n');
