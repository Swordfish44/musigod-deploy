'use strict';
// lib/intake-config.js
// Intake workflow configuration — pilot configurations and commercial terms.
// Config-driven: add new pilots or tiers without code changes.
// Billing and legal terms are NOT activated until approved engagement language is present.

// Pilot catalog configs — keyed by pilot ID, not artist name
const PILOT_CATALOG_CONFIGS = {
  // pilot-echo: synthetic test pilot for Echo sandbox walkthroughs.
  // Small catalog, no real artist data, safe to run without production access.
  'pilot-echo': {
    pilot_id: 'pilot-echo',
    catalog_total_tracks: 5,
    tracks_with_isrc: 5,
    tracks_missing_isrc: 0,
    tracks_missing_writers: 0,
    baseline_document: 'ECHO_SANDBOX_BASELINE.md',
    require_featured_performer_confirmation: true,
    require_master_ownership_evidence: true,
    unverified_ownership_candidates: [],
    do_not_block_on_writerless: false,
    isrc_gap_notes: [],
    neighboring_rights_specific: [
      'Synthetic test catalog — no real recordings',
      'All 5 tracks have ISRCs and writer credits assigned',
    ],
    sandbox: true,
  },
  'pilot-001': {
    pilot_id: 'pilot-001',
    catalog_total_tracks: 196,
    tracks_with_isrc: 152,
    tracks_missing_isrc: 44,
    tracks_missing_writers: 8,
    baseline_document: 'ESHAM_NEIGHBORING_RIGHTS_BASELINE.md',
    require_featured_performer_confirmation: true,
    require_master_ownership_evidence: true,
    unverified_ownership_candidates: ['Reel Life Productions'],
    do_not_block_on_writerless: true,
    isrc_gap_notes: [
      '44 recordings lack ISRCs — concentrated in Judgement Day Vol. 3 (2006) and Esham\'s Erotic Poetry',
      'All 196 recordings have MusicBrainz MBIDs available for matching',
    ],
    neighboring_rights_specific: [
      '8 writerless tracks do not block neighboring rights intake — writer data is irrelevant to sound recording performance royalties',
      'Reel Life Productions is an unverified ownership candidate pending documentation',
      'SoundExchange payment and adjustment statements requested for all available years',
    ],
  },
};

// Commercial terms template — NOT activated until attorney approves engagement language
const COMMERCIAL_TERMS_TEMPLATE = {
  version: 'commercial-v1',
  legal_review_required: true,
  billing_activation_blocked: true,
  billing_activation_reason:
    'Engagement language must receive attorney approval before billing activation. ' +
    'See ARTIST_INTAKE_LEGAL_REVIEW_CHECKLIST.md.',
  tiers: {
    individual: {
      label: 'Individual Artist',
      description: 'Standard tier for solo artists and small catalogs.',
      fixed_audit_fee_usd: null,             // set per engagement
      credit_audit_fee_against_recovery: false,
      contingency_rate: 0.15,               // 15% of money actually recovered
      contingency_applies_to:
        'Money actually recovered through documented MusiGod work only. ' +
        'Excludes royalties already being paid correctly before the MusiGod engagement.',
      contingency_excludes:
        'Royalties already being paid correctly. Pre-existing distributions. Amounts recoverable without MusiGod involvement.',
      per_recording_remediation_fee_usd: null,
      enterprise_portfolio_pricing: false,
    },
    enterprise: {
      label: 'Enterprise / Portfolio',
      description: 'Negotiated terms for large catalogs, labels, or administrators.',
      fixed_audit_fee_usd: null,
      credit_audit_fee_against_recovery: true,
      contingency_rate: null,               // negotiated per engagement
      contingency_applies_to: 'Negotiated per engagement',
      contingency_excludes: 'Negotiated per engagement',
      per_recording_remediation_fee_usd: null,
      enterprise_portfolio_pricing: true,
    },
  },
};

function getPilotConfig(pilotId) {
  return PILOT_CATALOG_CONFIGS[pilotId] || null;
}

function getCommercialTermsTemplate() {
  return JSON.parse(JSON.stringify(COMMERCIAL_TERMS_TEMPLATE));
}

function buildEngagementConfig({
  pilotId = null,
  tier = 'individual',
  fixedAuditFeeUsd = null,
  creditFeeAgainstRecovery = false,
  contingencyRate = 0.15,
  perRecordingFeeUsd = null,
} = {}) {
  const pilot = pilotId ? getPilotConfig(pilotId) : null;
  const terms = getCommercialTermsTemplate();
  const tierConfig = terms.tiers[tier] || terms.tiers.individual;

  return {
    pilot: pilot ? { ...pilot } : null,
    commercial: {
      ...tierConfig,
      fixed_audit_fee_usd: fixedAuditFeeUsd !== null ? fixedAuditFeeUsd : tierConfig.fixed_audit_fee_usd,
      credit_audit_fee_against_recovery: creditFeeAgainstRecovery || tierConfig.credit_audit_fee_against_recovery,
      contingency_rate: contingencyRate !== null ? contingencyRate : tierConfig.contingency_rate,
      per_recording_remediation_fee_usd: perRecordingFeeUsd !== null ? perRecordingFeeUsd : tierConfig.per_recording_remediation_fee_usd,
    },
    legal_review_required: true,
    billing_activation_blocked: true,
  };
}

module.exports = {
  PILOT_CATALOG_CONFIGS,
  COMMERCIAL_TERMS_TEMPLATE,
  getPilotConfig,
  getCommercialTermsTemplate,
  buildEngagementConfig,
};
