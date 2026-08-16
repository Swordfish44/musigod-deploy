'use strict';

const RIGHTS_TYPES = new Set(['composition', 'master', 'featured_performer', 'nonfeatured_performer', 'neighboring_right', 'other']);
const APPROVED_STATES = new Set(['human_reviewed', 'legal_reviewed', 'approved']);

function validateRoyaltyRule(rule) {
  const errors = [];
  if (!rule?.rule_code) errors.push('rule_code is required');
  if (!rule?.territory) errors.push('territory is required');
  if (!RIGHTS_TYPES.has(rule?.rights_type)) errors.push('rights_type is invalid');
  if (!rule?.usage_type) errors.push('usage_type is required');
  if (!rule?.effective_from) errors.push('effective_from is required');
  if (!Array.isArray(rule?.authority_sources) || rule.authority_sources.length === 0) errors.push('at least one authority source is required');
  if (rule?.effective_to && rule.effective_to < rule.effective_from) errors.push('effective_to precedes effective_from');
  if (rule?.review_status !== 'draft' && (!rule?.reviewed_by || !rule?.reviewed_at)) errors.push('review identity and timestamp are required');
  return { valid: errors.length === 0, errors };
}

function ruleApplies(rule, event) {
  const validation = validateRoyaltyRule(rule);
  if (!validation.valid || !APPROVED_STATES.has(rule.review_status)) return false;
  if (String(rule.territory).toUpperCase() !== String(event.territory || '').toUpperCase()) return false;
  if (rule.rights_type !== event.rights_type || rule.usage_type !== event.usage_type) return false;
  const date = String(event.usage_date || '');
  return date >= rule.effective_from && (!rule.effective_to || date <= rule.effective_to);
}

function selectApplicableRules(rules, event) {
  return (Array.isArray(rules) ? rules : []).filter(rule => ruleApplies(rule, event))
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0));
}

module.exports = { RIGHTS_TYPES, APPROVED_STATES, validateRoyaltyRule, ruleApplies, selectApplicableRules };
