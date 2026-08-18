'use strict';

const RULE_VERSION = 'recovery-priority-v1';
const WEIGHTS = Object.freeze({ evidence_quality:30, potential_value:25, filing_deadline:20, match_confidence:15, recovery_complexity:10 });
const clamp = value => Math.max(0,Math.min(1,Number(value)));

function scoreOpportunity(input = {}) {
  const factors = {};
  for (const key of Object.keys(WEIGHTS)) {
    if (input[key] == null) throw new Error(`${key} is required`);
    factors[key] = { input:clamp(input[key]), weight:WEIGHTS[key], points:Number((clamp(input[key])*WEIGHTS[key]).toFixed(2)) };
  }
  const score = Number(Object.values(factors).reduce((sum,f)=>sum+f.points,0).toFixed(2));
  const amount_basis = input.verified_amount != null ? 'verified' : input.estimated_amount != null ? 'estimate' : 'unknown';
  return { score, priority:score>=80?'critical':score>=60?'high':score>=35?'medium':'low', factors, rule_version:RULE_VERSION,
    amount_basis, amount:input.verified_amount ?? input.estimated_amount ?? null, assumptions:input.assumptions || [],
    evidence:input.evidence || [], correction_package_allowed:false, human_approval_required:true, external_submission_enabled:false };
}

function approveCorrection(opportunity, reviewer, notes) {
  if (!opportunity || opportunity.human_approval_required !== true) throw new Error('controlled recovery opportunity is required');
  if (!reviewer?.id || !reviewer.active || !['reviewer','administrator','legal'].includes(reviewer.role)) throw new Error('named qualified reviewer is required');
  if (String(notes||'').trim().length<12) throw new Error('approval notes must contain at least 12 characters');
  return { ...opportunity, correction_package_allowed:true, human_approval_required:false, approved_by_reviewer_id:reviewer.id,
    approval_notes:String(notes).trim(), external_submission_enabled:false };
}

module.exports = { RULE_VERSION, WEIGHTS, scoreOpportunity, approveCorrection };
