'use strict';

const RULE_VERSION = 'ownership-conflict-v1';
const clean = value => String(value || '').trim();
const party = value => clean(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const overlaps = (aStart,aEnd,bStart,bEnd) => (!aEnd || bStart <= aEnd) && (!bEnd || aStart <= bEnd);
const territoriesOverlap = (a,b) => a === 'WORLD' || b === 'WORLD' || a === b;

function detect(claims = []) {
  const conflicts = [];
  for (let i=0;i<claims.length;i++) for (let j=i+1;j<claims.length;j++) {
    const a=claims[i], b=claims[j];
    if (a.asset_reference !== b.asset_reference || a.rights_type !== b.rights_type) continue;
    if (!territoriesOverlap(clean(a.territory).toUpperCase(), clean(b.territory).toUpperCase())) continue;
    if (!overlaps(a.effective_from || '0001-01-01',a.effective_to,b.effective_from || '0001-01-01',b.effective_to)) continue;
    const reasons=[];
    if (party(a.claimant_name) !== party(b.claimant_name)) reasons.push('claimant_identity');
    if (Number(a.ownership_share) !== Number(b.ownership_share)) reasons.push('ownership_share');
    if (!reasons.length) reasons.push('duplicate_claim');
    conflicts.push({ claim_a_index:i, claim_b_index:j, asset_reference:a.asset_reference, reasons,
      classification:'data_conflict', legal_conclusion:null, legal_review_required:reasons.some(r=>r!=='duplicate_claim'),
      human_review_required:true, rule_version:RULE_VERSION, evidence:[a,b] });
  }
  return conflicts;
}

module.exports = { RULE_VERSION, detect, overlaps, territoriesOverlap };
