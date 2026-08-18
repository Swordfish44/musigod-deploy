'use strict';

const matching = require('./portfolio-asset-matching');
const RULE_VERSION = 'royalty-reconciliation-v1';
const clean = value => String(value || '').trim();
const number = (value, field) => { const n = Number(value); if (!Number.isFinite(n)) throw new Error(`${field} must be numeric`); return n; };

function normalizeLine(line = {}, context = {}) {
  const currency = clean(line.currency || context.currency).toUpperCase();
  const territory = clean(line.territory || context.territory).toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new Error('three-letter currency is required');
  if (!territory) throw new Error('territory is required');
  const usage_count = number(line.usage_count ?? line.units ?? 0, 'usage_count');
  const royalty_amount = number(line.royalty_amount ?? line.amount, 'royalty_amount');
  const normalized = { ...line, usage_count, royalty_amount, currency, territory,
    period_start: line.period_start || context.period_start || null, period_end: line.period_end || context.period_end || null };
  return { source_values: JSON.parse(JSON.stringify(line)), normalized_values: normalized,
    transformation: { rule_version: RULE_VERSION, base_currency: null, exchange_rate: null } };
}

function reconcile(lines = [], assets = [], options = {}) {
  const seen = new Map();
  return lines.map((line, index) => {
    const normalized = normalizeLine(line, options);
    const n = normalized.normalized_values;
    const fingerprint = [n.source_line_id || '', n.isrc || '', n.iswc || '', n.territory, n.period_start || '', n.period_end || '', n.usage_count, n.royalty_amount, n.currency].join('|');
    const duplicateOf = seen.get(fingerprint); if (!duplicateOf) seen.set(fingerprint, index + 1);
    const ranked = matching.rankCandidates({ ...n, asset_type: n.asset_type || (n.iswc ? 'composition' : 'recording') }, assets);
    const best = ranked[0];
    let status = !best || best.result.classification === 'rejected' ? 'unmatched' : best.result.classification === 'ambiguous' ? 'ambiguous' : 'matched';
    if (duplicateOf) status = 'duplicated';
    const expected = options.expectedAmounts?.[n.source_line_id];
    let variance = null, amount_basis = 'reported';
    if (expected && expected.evidence_status === 'verified') {
      variance = Number(expected.amount) - n.royalty_amount;
      amount_basis = 'verified';
      if (variance > Number(options.variance_tolerance || 0)) status = 'underreported';
      else if (variance < -Number(options.variance_tolerance || 0)) status = 'conflicting';
    }
    return { row_number: index + 1, status, duplicate_of_row: duplicateOf || null, matched_asset: best?.candidate || null,
      match: best?.result || null, reported_amount: n.royalty_amount, currency: n.currency, expected_amount: expected?.amount ?? null,
      variance, amount_basis, human_review_required: status !== 'matched', rule_version: RULE_VERSION, normalized };
  });
}

module.exports = { RULE_VERSION, normalizeLine, reconcile };
